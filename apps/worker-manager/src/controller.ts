import type { Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { WorkerManager, type Executor } from "./index";
import { workerPrincipal } from "./protocol";

export interface ManagedWorkerControllerOptions {
  scheduler: BrowserScheduler;
  /** The production implementation is DockerContainerExecutor; the controller itself only needs
   * the narrow executor contract, which keeps liveness/recovery independently testable. */
  browserExecutor: Executor;
  pollIntervalMs?: number;
  /** Independent browser-lease liveness cadence; must not depend on reconciliation completing. */
  leaseHeartbeatIntervalMs?: number;
  maxWorkersPerTick?: number;
}

interface ActiveProcess {
  workerId: Worker["id"];
  identity: string;
  processId: string;
  leaseId: string;
  actor: Principal;
}

const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Controller-side loop for managed (non-local) workers. It is the only component with Docker
 * access; browser containers themselves have no socket. Each lease is claimed before container
 * creation, and containers are removed as soon as the durable lease disappears.
 */
export class ManagedWorkerController {
  readonly #scheduler: BrowserScheduler;
  readonly #manager: WorkerManager;
  readonly #pollIntervalMs: number;
  readonly #leaseHeartbeatIntervalMs: number;
  readonly #maxWorkersPerTick: number;
  readonly #active = new Map<string, ActiveProcess>();
  #timer?: ReturnType<typeof setInterval>;
  #leaseHeartbeatTimer?: ReturnType<typeof setInterval>;
  #leaseHeartbeatInFlight = false;
  #ticking = false;
  #stopping = false;

  public constructor(options: ManagedWorkerControllerOptions) {
    this.#scheduler = options.scheduler;
    this.#manager = new WorkerManager(options.scheduler, options.browserExecutor);
    this.#pollIntervalMs = Math.max(250, Math.min(30_000, options.pollIntervalMs ?? 1_000));
    this.#leaseHeartbeatIntervalMs = Math.max(1_000, Math.min(15_000, options.leaseHeartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS));
    this.#maxWorkersPerTick = Math.max(1, Math.min(32, options.maxWorkersPerTick ?? 8));
  }

  public start(): void {
    this.#stopping = false;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#leaseHeartbeatTimer) clearInterval(this.#leaseHeartbeatTimer);
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    this.#leaseHeartbeatTimer = setInterval(() => void this.heartbeatActiveLeases(), this.#leaseHeartbeatIntervalMs);
    void this.tick();
    void this.heartbeatActiveLeases();
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#leaseHeartbeatTimer) clearInterval(this.#leaseHeartbeatTimer);
    this.#timer = undefined;
    this.#leaseHeartbeatTimer = undefined;
    await Promise.all([...this.#active.values()].map((process) => this.#stopProcess(process)));
    this.#active.clear();
  }

  /** Keep active browser leases alive independently of reconciliation and Docker inspection. */
  public async heartbeatActiveLeases(): Promise<void> {
    if (this.#stopping || this.#leaseHeartbeatInFlight) return;
    this.#leaseHeartbeatInFlight = true;
    try {
      await Promise.all([...this.#active.values()]
        .map((process) => this.#scheduler.heartbeatLease(process.leaseId as never, process.workerId, process.actor).catch(() => undefined)));
    } finally {
      this.#leaseHeartbeatInFlight = false;
    }
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
          if (process.workerId !== worker.id) continue;
          if (this.#manager.executor.isRunning) {
            const running = await Promise.resolve(this.#manager.executor.isRunning(process.processId)).catch(() => false);
            if (!running) {
              await this.#scheduler.failLease(process.leaseId as never, worker.id, "managed browser process exited", workerPrincipalIdentity).catch(() => undefined);
              await this.#stopProcess(process);
              this.#active.delete(process.identity);
              continue;
            }
          }
        }
        const assignments = await this.#scheduler.assignmentsForWorker(worker.id, Math.max(1, worker.capacity));
        for (const assignment of assignments) {
          liveIdentities.add(assignment.lease.id);
          if (this.#active.has(assignment.lease.id)) continue;
          await this.#startAssignment(worker, assignment);
        }
        const activeAssignments = await this.#scheduler.activeAssignmentsForWorker(worker.id, 128);
        for (const assignment of activeAssignments) liveIdentities.add(assignment.lease.id);
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

  /**
   * Called only after DockerContainerExecutor removes browser containers from an earlier manager
   * process. A fresh controller has no guardian/liveness ownership for those leases, so release
   * them promptly instead of waiting for the heartbeat timeout.
   */
  public async failUntrackedBrowserLeases(): Promise<number> {
    let released = 0;
    const workers = await this.#scheduler.listWorkers();
    for (const worker of workers) {
      if (worker.isLocal) continue;
      const actor = workerPrincipal(worker);
      const assignments = await this.#scheduler.activeAssignmentsForWorker(worker.id, 128, actor);
      for (const assignment of assignments) {
        const lease = assignment.lease;
        if (!lease.assignmentClaimedAt || this.#active.has(lease.id)) continue;
        const releasedLease = await this.#scheduler
          .failLease(lease.id, worker.id, "manager restarted; stopped an untracked browser to preserve CAPTCHA guardian ownership", actor)
          .then(() => true)
          .catch(() => false);
        if (releasedLease) released += 1;
      }
    }
    return released;
  }

  async #startAssignment(worker: Worker, assignment: WorkerAssignment): Promise<void> {
    const identity = assignment.lease.id;
    const actor: Principal = workerPrincipal(worker);
    let processId: string | undefined;
    try {
      const claimed = await this.#manager.claim(worker, assignment, actor);
      const started = await this.#manager.startClaimed(worker, claimed);
      processId = started.processId;
      if (!claimed.lease.startedAt) await this.#scheduler.markLeaseStarted(claimed.lease.id, worker.id, actor);
      this.#active.set(identity, { workerId: worker.id, identity, processId: started.processId, leaseId: claimed.lease.id, actor });
    } catch (error) {
      console.error("[fabric] managed assignment failed", {
        workerId: worker.id,
        identity,
        runtime: assignment.recipe.runtime,
        error: error instanceof Error ? error.message : String(error),
      });
      if (processId) await this.#manager.executor.stop(processId).catch(() => undefined);
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
    await this.#manager.executor.stop(process.processId).catch(() => undefined);
  }
}
