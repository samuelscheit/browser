import type { AttemptId, Principal, Worker, WorkerAssignment } from "@browser-fabric/contracts";
import { BrowserScheduler } from "@browser-fabric/control-plane";
import { WorkerManager, type Executor, type MediaExecutor } from "./index";
import { workerPrincipal } from "./protocol";
import type { MediaResultGateway } from "./media-result";

export interface ManagedWorkerControllerOptions {
  scheduler: BrowserScheduler;
  /** The production implementation is DockerServiceExecutor; the controller itself only needs
   * the narrow executor contract, which keeps liveness/recovery independently testable. */
  browserExecutor: Executor;
  mediaExecutor?: MediaExecutor;
  /** Required for the manager-owned media runtime so its output enters Fabric artifact storage. */
  mediaResultGateway?: Pick<MediaResultGateway, "prepare" | "verifyCompletion">;
  /** Runtime families executed by this Docker controller. Native workers poll their own mailbox. */
  managedRuntimeFamilies?: readonly string[];
  pollIntervalMs?: number;
  maxWorkersPerTick?: number;
}

interface ActiveProcess {
  workerId: Worker["id"];
  identity: string;
  processId: string;
  media: boolean;
  leaseId?: string;
  mediaAttemptId?: AttemptId;
  watching?: boolean;
}

/**
 * Controller-side loop for managed fabric-host workers. It is the only component with Docker access;
 * browser worker containers themselves have no socket. Each assignment is claimed before service
 * creation, and services are removed as soon as the durable lease/job disappears.
 */
export class ManagedWorkerController {
  readonly #scheduler: BrowserScheduler;
  readonly #manager: WorkerManager;
  readonly #mediaExecutor?: MediaExecutor;
  readonly #mediaResultGateway?: Pick<MediaResultGateway, "prepare" | "verifyCompletion">;
  readonly #managedRuntimeFamilies: ReadonlySet<string>;
  readonly #pollIntervalMs: number;
  readonly #maxWorkersPerTick: number;
  readonly #active = new Map<string, ActiveProcess>();
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #stopping = false;

  public constructor(options: ManagedWorkerControllerOptions) {
    this.#scheduler = options.scheduler;
    this.#mediaExecutor = options.mediaExecutor;
    this.#mediaResultGateway = options.mediaResultGateway;
    this.#managedRuntimeFamilies = new Set(options.managedRuntimeFamilies ?? ["chromium-cdp", "patchright", "rebrowser-puppeteer", "companion", "media-relay"]);
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
        // Native runtimes (notably SocialApi/Playwright) own their execution loop and must not
        // race this controller for the same unclaimed assignment.
        if (![...worker.capabilities.runtimeFamilies].some((runtime) => this.#managedRuntimeFamilies.has(runtime))) continue;
        const workerPrincipalIdentity = workerPrincipal(worker);
        for (const process of this.#active.values()) {
          if (process.workerId !== worker.id || process.media || !process.leaseId) continue;
          if (this.#manager.executor.isRunning) {
            const running = await Promise.resolve(this.#manager.executor.isRunning(process.processId)).catch(() => false);
            if (!running) {
              await this.#scheduler.failLease(process.leaseId as never, worker.id, "managed browser process exited", workerPrincipalIdentity).catch(() => undefined);
              await this.#stopProcess(process);
              this.#active.delete(process.identity);
              continue;
            }
          }
          await this.#scheduler.heartbeatLease(process.leaseId as never, worker.id, workerPrincipalIdentity).catch(() => undefined);
        }
        const assignments = await this.#scheduler.assignmentsForWorker(worker.id, worker.capacity + (worker.mediaCapacity ?? 0));
        for (const assignment of assignments) {
          if (!this.#managedRuntimeFamilies.has(assignment.recipe.runtime)) continue;
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

  /**
   * Called only after DockerServiceExecutor removes browser services from an earlier manager
   * process. A fresh controller has no guardian/liveness ownership for those leases, so release
   * them promptly instead of waiting for the heartbeat timeout.
   */
  public async failUntrackedBrowserLeases(): Promise<number> {
    let released = 0;
    const workers = await this.#scheduler.listWorkers();
    for (const worker of workers) {
      if (worker.isLocal || ![...worker.capabilities.runtimeFamilies].some((runtime) => this.#managedRuntimeFamilies.has(runtime))) continue;
      const actor = workerPrincipal(worker);
      const assignments = await this.#scheduler.activeAssignmentsForWorker(worker.id, 128, actor);
      for (const assignment of assignments) {
        const lease = assignment.lease;
        const identity = lease?.id ?? assignment.job?.id;
        if (!lease?.assignmentClaimedAt || !identity || this.#active.has(identity) || !this.#managedRuntimeFamilies.has(assignment.recipe.runtime)) continue;
        const releasedLease = await this.#scheduler
          .failLease(lease.id, worker.id, "manager restarted; stopped an untracked browser to preserve Turnstile guardian ownership", actor)
          .then(() => true)
          .catch(() => false);
        if (releasedLease) released += 1;
      }
    }
    return released;
  }

  /**
   * The manager owns media service completion. On restart its in-memory watcher is gone, so every
   * still-running media assignment must be reclaimed after Docker has stopped inherited services.
   */
  public async failUntrackedMediaTasks(): Promise<number> {
    let released = 0;
    const workers = await this.#scheduler.listWorkers();
    for (const worker of workers) {
      if (worker.isLocal || !worker.capabilities.runtimeFamilies.includes("media-relay")) continue;
      const actor = workerPrincipal(worker);
      const assignments = await this.#scheduler.activeAssignmentsForWorker(worker.id, 128, actor);
      for (const assignment of assignments) {
        const job = assignment.job;
        if (!job || job.runtime !== "media-relay" || !job.assignmentClaimedAt) continue;
        // A service can complete between Docker list and inspect. Still reclaim the durable
        // assignment: a fresh manager owns neither its watcher nor its result capability.
        const requeued = await this.#scheduler
          .failMediaTask(job.id, worker.id, job.mediaAttemptId, "manager restarted; stopped an untracked media relay service", actor)
          .then(() => true)
          .catch(() => false);
        if (requeued) released += 1;
      }
    }
    return released;
  }

  async #startAssignment(worker: Worker, assignment: WorkerAssignment): Promise<void> {
    const identity = assignment.lease?.id ?? assignment.job?.id;
    if (!identity) return;
    const actor: Principal = workerPrincipal(worker);
    let startedProcess: { processId: string; media: boolean; mediaAttemptId?: AttemptId } | undefined;
    let claimed: WorkerAssignment | undefined;
    try {
      claimed = await this.#manager.claim(worker, assignment, actor);
      const mediaAttemptId = claimed.recipe.runtime === "media-relay" ? claimed.job?.mediaAttemptId : undefined;
      if (claimed.recipe.runtime === "media-relay" && !mediaAttemptId) {
        throw new Error("media assignment has no active attempt binding");
      }
      const relay = claimed.recipe.runtime === "media-relay"
        ? await this.#prepareMediaRelay(claimed, worker)
        : undefined;
      const started = await this.#manager.startClaimed(worker, claimed, [], relay);
      startedProcess = { processId: started.processId, media: claimed.recipe.runtime === "media-relay", ...(mediaAttemptId === undefined ? {} : { mediaAttemptId }) };
      if (claimed.lease && !claimed.lease.startedAt) {
        await this.#scheduler.markLeaseStarted(claimed.lease.id, worker.id, actor);
      }
      this.#active.set(identity, { workerId: worker.id, identity, processId: started.processId, media: startedProcess.media, ...(claimed.lease ? { leaseId: claimed.lease.id } : {}), ...(mediaAttemptId === undefined ? {} : { mediaAttemptId }) });
      if (startedProcess.media && this.#mediaExecutor?.wait && claimed.job) {
      const active = this.#active.get(identity);
        if (active) {
          active.watching = true;
          void this.#watchMediaJob(worker, claimed.job.id, mediaAttemptId!, identity, started.processId, actor);
        }
      }
    } catch (error) {
      console.error("[fabric] managed assignment failed", {
        workerId: worker.id,
        identity,
        runtime: assignment.recipe.runtime,
        error: error instanceof Error ? error.message : String(error),
      });
      if (startedProcess) await this.#stopProcess({ workerId: worker.id, identity, ...startedProcess }).catch(() => undefined);
      if (claimed?.job?.runtime === "media-relay") {
        const message = error instanceof Error ? error.message : "managed media worker failed to start";
        await this.#scheduler.failMediaTask(claimed.job.id, worker.id, claimed.job.mediaAttemptId, message, actor).catch(() => undefined);
      } else if (assignment.job) {
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

  async #prepareMediaRelay(assignment: WorkerAssignment, worker: Worker) {
    if (!assignment.job || !this.#mediaResultGateway) {
      throw new Error("media assignment requires the manager-owned artifact result gateway");
    }
    return this.#mediaResultGateway.prepare(assignment.job, worker);
  }

  async #stopProcess(process: ActiveProcess): Promise<void> {
    if (process.media && this.#mediaExecutor) await this.#mediaExecutor.stop(process.processId).catch(() => undefined);
    else await this.#manager.executor.stop(process.processId).catch(() => undefined);
  }

  async #watchMediaJob(worker: Worker, jobId: NonNullable<WorkerAssignment["job"]>["id"], attemptId: AttemptId, identity: string, processId: string, actor: Principal): Promise<void> {
    if (!this.#mediaExecutor?.wait) return;
    let completion: { status: "succeeded" | "failed"; result?: Record<string, unknown>; reason?: string };
    try {
      completion = await this.#mediaExecutor.wait(processId);
    } catch (error) {
      completion = { status: "failed", reason: error instanceof Error ? error.message : "media relay did not report a result" };
    }
    // A cancellation/expiry can win the race while the remote service is finishing.  In that
    // case the scheduler rejects the stale completion and the normal reconciliation path removes
    // the service; never resurrect a terminal job.
    try {
      if (completion.status === "succeeded") {
        if (!this.#mediaResultGateway) throw new Error("media completion has no manager-owned artifact gateway");
        const receipt = completion.result?.receipt;
        if (typeof receipt !== "string") throw new Error("media relay completed without a manager-signed receipt");
        const verified = await this.#mediaResultGateway.verifyCompletion(jobId, worker.id, attemptId, receipt);
        await this.#scheduler.completeMediaTask(jobId, worker.id, attemptId, { ...verified }, actor);
      }
      else await this.#scheduler.failMediaTask(jobId, worker.id, attemptId, completion.reason ?? "media relay failed", actor);
    } catch (error) {
      // A terminal/reclaimed job will reject this as stale, which is harmless. A malformed receipt
      // or failed manager verification must instead release/requeue the live media attempt; simply
      // stopping its service would otherwise leave a claimed `running` job with no controller
      // watcher until the recovery timeout.
      const reason = error instanceof Error ? error.message : "media result receipt could not be verified";
      await this.#scheduler.failMediaTask(jobId, worker.id, attemptId, reason, actor).catch(() => undefined);
    }
    const active = this.#active.get(identity);
    if (active?.processId === processId) {
      await this.#stopProcess(active);
      this.#active.delete(identity);
    }
  }
}
