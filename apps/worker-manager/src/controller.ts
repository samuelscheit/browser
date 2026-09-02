import type { Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { WorkerManager } from "./index";
import { DockerMediaServiceExecutor, DockerServiceExecutor } from "./docker-executor";
import { workerPrincipal } from "./protocol";

export interface ManagedWorkerControllerOptions {
  scheduler: BrowserScheduler;
  browserExecutor: DockerServiceExecutor;
  mediaExecutor?: DockerMediaServiceExecutor;
  pollIntervalMs?: number;
  maxWorkersPerTick?: number;
}

interface ActiveProcess { workerId: Worker["id"]; identity: string; processId: string; media: boolean; leaseId?: string; }

/**
 * Controller-side loop for managed fabric-host workers. It is the only component with Docker access;
 * browser worker containers themselves have no socket. Each assignment is claimed before service
 * creation, and services are removed as soon as the durable lease/job disappears.
 */
export class ManagedWorkerController {
  readonly #scheduler: BrowserScheduler;
  readonly #manager: WorkerManager;
  readonly #mediaExecutor?: DockerMediaServiceExecutor;
  readonly #pollIntervalMs: number;
  readonly #maxWorkersPerTick: number;
  readonly #active = new Map<string, ActiveProcess>();
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #stopping = false;

  public constructor(options: ManagedWorkerControllerOptions) {
    this.#scheduler = options.scheduler;
    this.#mediaExecutor = options.mediaExecutor;
    this.#manager = new WorkerManager(options.scheduler, options.browserExecutor, options.mediaExecutor);
    this.#pollIntervalMs = Math.max(250, Math.min(30_000, options.pollIntervalMs ?? 1_000));
    this.#maxWorkersPerTick = Math.max(1, Math.min(32, options.maxWorkersPerTick ?? 8));
  }

  public start(): void {
    this.#stopping = false;
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    void this.tick();
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#active.values()].map((process) => this.#stopProcess(process)));
    this.#active.clear();
  }

  public async tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      const workers = (await this.#scheduler.listWorkers()).filter((worker) => !worker.isLocal && worker.health === "healthy").slice(0, this.#maxWorkersPerTick);
      const liveIdentities = new Set<string>();
      for (const worker of workers) {
        const workerPrincipalIdentity = workerPrincipal(worker);
        for (const process of this.#active.values()) {
          if (process.workerId !== worker.id || process.media || !process.leaseId) continue;
          await this.#scheduler.heartbeatLease(process.leaseId as never, worker.id, workerPrincipalIdentity).catch(() => undefined);
        }
        const assignments = await this.#scheduler.assignmentsForWorker(worker.id, worker.capacity + (worker.mediaCapacity ?? 0));
        for (const assignment of assignments) {
          const identity = assignment.lease?.id ?? assignment.job?.id;
          if (!identity) continue;
          liveIdentities.add(identity);
          if (this.#active.has(identity)) continue;
          await this.#startAssignment(worker, assignment);
        }
        const activeAssignments = await this.#scheduler.activeAssignmentsForWorker(worker.id, 128);
        for (const assignment of activeAssignments) {
          const identity = assignment.lease?.id ?? assignment.job?.id;
          if (identity) liveIdentities.add(identity);
        }
      }
      for (const [identity, process] of this.#active) {
        if (liveIdentities.has(identity)) continue;
        await this.#stopProcess(process);
        this.#active.delete(identity);
      }
      await this.#scheduler.recover();
    } finally {
      this.#ticking = false;
    }
  }

  public activeProcesses(): readonly ActiveProcess[] { return [...this.#active.values()].map((process) => ({ ...process })); }

  async #startAssignment(worker: Worker, assignment: WorkerAssignment): Promise<void> {
    const identity = assignment.lease?.id ?? assignment.job?.id;
    if (!identity) return;
    const actor: Principal = workerPrincipal(worker);
    try {
      const started = await this.#manager.execute(worker, assignment, actor);
      this.#active.set(identity, { workerId: worker.id, identity, processId: started.processId, media: assignment.recipe.runtime === "media-relay", ...(assignment.lease ? { leaseId: assignment.lease.id } : {}) });
    } catch (error) {
      if (assignment.job) {
        const message = error instanceof Error ? error.message : "managed worker failed to start";
        await this.#scheduler.failJob(assignment.job.id, "failed", message, actor).catch(() => undefined);
      } else if (assignment.session) {
        // This is a controller-internal cleanup path. The worker principal is not a project
        // principal, so pass no project actor after the failed worker claim; the control-plane
        // transaction itself remains serialized and audited as a system cleanup.
        await this.#scheduler.cancelBrowserSession(assignment.session.id).catch(() => undefined);
      }
    }
  }

  async #stopProcess(process: ActiveProcess): Promise<void> {
    if (process.media && this.#mediaExecutor) await this.#mediaExecutor.stop(process.processId).catch(() => undefined);
    else await this.#manager.executor.stop(process.processId).catch(() => undefined);
  }
}
