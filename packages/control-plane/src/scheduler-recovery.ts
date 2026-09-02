import type { BrowserSession, JobStatus } from "@browser-fabric/contracts";
import { type RecipeDefinition } from "@browser-fabric/recipes";
import type { Clock } from "./clock";
import type { FabricState } from "./store";
import type { SchedulerKernel } from "./scheduler-kernel";

const asDate = (iso: string) => new Date(iso).getTime();
const now = (clock: Clock) => clock.now().toISOString();
const terminalSession = (status: BrowserSession["status"]): boolean => ["released", "cancelled", "failed", "timed_out"].includes(status);
const terminalJob = (status: JobStatus): boolean => ["succeeded", "failed", "blocked_challenge", "auth_required", "timed_out", "cancelled"].includes(status);

export interface RecoveryOptions { clock: Clock; kernel: SchedulerKernel; assignmentClaimTimeoutSeconds: number; }

export function recoverSchedulerState(state: FabricState, options: RecoveryOptions): { expiredSessions: number; expiredJobs: number; offlineWorkers: number; expiredInputs: number; reconnectReleased: number } {

  let expiredSessions = 0;
  let expiredJobs = 0;
  let offlineWorkers = 0;
  let expiredInputs = 0;
  let reconnectReleased = 0;
  const timestamp = options.clock.now().getTime();
  for (const worker of state.workers.values()) {
    if (worker.health !== "offline" && timestamp - asDate(worker.lastHeartbeatAt) > 30_000) {
      worker.health = "offline";
      worker.updatedAt = now(options.clock);
      state.workers.set(worker.id, worker);
      offlineWorkers += 1;
      options.kernel.event(state, undefined, { kind: "worker", id: worker.id }, "worker.offline", {});
    }
  }
  for (const lease of [...state.leases.values()]) {
    if (lease.status !== "active" || lease.assignmentClaimedAt || timestamp - asDate(lease.createdAt) <= options.assignmentClaimTimeoutSeconds * 1_000) continue;
    // An allocation that no worker claimed is an orphan, not an active browser. Return it
    // to FIFO while preserving the job/session idempotency record.
    if (lease.sessionId) {
      const session = options.kernel.session(state, lease.sessionId);
      options.kernel.releaseLease(state, lease);
      if (!terminalSession(session.status)) {
        session.status = "queued";
        session.workerId = undefined;
        session.leaseId = undefined;
        session.cdpEndpoint = undefined;
        session.cdpInternalEndpoint = undefined;
        session.cdpCapabilityExpiresAt = undefined;
        session.updatedAt = now(options.clock);
        state.sessions.set(session.id, session);
        options.kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.requeued_after_unclaimed_assignment", {});
      }
    } else if (lease.jobId) {
      const job = options.kernel.job(state, lease.jobId);
      options.kernel.releaseLease(state, lease);
      options.kernel.finishAttempt(state, job, "failed");
      const recipe = options.kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
      if (attempts < recipe.maxAttempts && asDate(job.expiresAt) > timestamp) {
        job.status = "queued";
        job.workerId = undefined;
        job.leaseId = undefined;
        job.updatedAt = now(options.clock);
        state.jobs.set(job.id, job);
        options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.requeued_after_unclaimed_assignment", { attempts });
      } else {
        job.status = "failed";
        job.failureReason = "worker did not claim assignment within timeout";
        job.updatedAt = now(options.clock);
        state.jobs.set(job.id, job);
        options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.failed", { reason: job.failureReason });
      }
    }
  }
  // A healthy worker process can continue heartbeating while an individual browser process has
  // died. Once a claimed lease misses its own heartbeat window, reclaim it independently of the
  // worker heartbeat and apply the same bounded job retry policy.
  for (const lease of [...state.leases.values()]) {
    if (lease.status !== "active" || !lease.assignmentClaimedAt || timestamp - asDate(lease.lastHeartbeatAt) <= 30_000) continue;
    options.kernel.releaseLease(state, lease);
    if (lease.sessionId) {
      const session = options.kernel.session(state, lease.sessionId);
      if (!terminalSession(session.status)) {
        session.status = "timed_out";
        session.failureReason = "browser lease heartbeat expired";
        session.workerId = undefined;
        session.leaseId = undefined;
        session.cdpEndpoint = undefined;
        session.cdpInternalEndpoint = undefined;
        session.cdpCapabilityExpiresAt = undefined;
        session.updatedAt = now(options.clock);
        state.sessions.set(session.id, session);
        options.kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.timed_out", { reason: session.failureReason });
        expiredSessions += 1;
      }
    } else if (lease.jobId) {
      const job = options.kernel.job(state, lease.jobId);
      options.kernel.finishAttempt(state, job, "failed");
      const recipe = options.kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
      if (attempts < recipe.maxAttempts && asDate(job.expiresAt) > timestamp) {
        job.status = "queued";
        job.workerId = undefined;
        job.leaseId = undefined;
        job.updatedAt = now(options.clock);
        state.jobs.set(job.id, job);
        options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.requeued_after_lease_heartbeat_expiry", { attempts });
      } else {
        job.status = "failed";
        job.workerId = undefined;
        job.leaseId = undefined;
        job.failureReason = "browser lease heartbeat expired";
        job.updatedAt = now(options.clock);
        state.jobs.set(job.id, job);
        options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.failed", { reason: job.failureReason });
      }
      expiredJobs += 1;
    }
  }
  for (const job of [...state.jobs.values()]) {
    if (job.runtime !== "media-relay" || job.status !== "running" || job.assignmentClaimedAt || !job.workerId || timestamp - asDate(job.updatedAt) <= options.assignmentClaimTimeoutSeconds * 1_000) continue;
    const worker = state.workers.get(job.workerId);
    if (worker) {
      worker.activeMediaTasks = Math.max(0, (worker.activeMediaTasks ?? 0) - 1);
      worker.updatedAt = now(options.clock);
      state.workers.set(worker.id, worker);
    }
    options.kernel.finishAttempt(state, job, "failed");
    const recipe = options.kernel.recipe(state, job.recipeRef) as RecipeDefinition;
    const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
    if (attempts < recipe.maxAttempts && asDate(job.expiresAt) > timestamp) {
      job.status = "queued";
      job.workerId = undefined;
      job.updatedAt = now(options.clock);
      state.jobs.set(job.id, job);
    } else {
      job.status = "failed";
      job.failureReason = "media worker did not claim assignment within timeout";
      job.updatedAt = now(options.clock);
      state.jobs.set(job.id, job);
    }
  }
  for (const session of [...state.sessions.values()]) {
    if (terminalSession(session.status)) continue;
    const workerOffline = session.workerId ? state.workers.get(session.workerId)?.health === "offline" : false;
    if (asDate(session.expiresAt) <= timestamp || workerOffline) {
      options.kernel.releaseSession(state, session, "timed_out", workerOffline ? "assigned worker went offline" : "session TTL expired");
      expiredSessions += 1;
      continue;
    }
    if (session.reconnectGraceUntil && asDate(session.reconnectGraceUntil) <= timestamp && session.externalConnectionCount === 0) {
      options.kernel.releaseSession(state, session, "released", "CDP reconnect grace elapsed");
      reconnectReleased += 1;
    }
  }
  // A worker crash is recoverable for jobs: release the orphaned lease and requeue only
  // while the immutable recipe still has attempts remaining. Durable profiles are never
  // silently copied; affinity remains enforced on the next dispatch.
  for (const job of [...state.jobs.values()]) {
    if (job.status !== "running" || !job.workerId || state.workers.get(job.workerId)?.health !== "offline") continue;
    if (job.leaseId) options.kernel.releaseLease(state, options.kernel.lease(state, job.leaseId));
    options.kernel.releaseMediaTask(state, job);
    options.kernel.finishAttempt(state, job, "failed");
    const recipe = options.kernel.recipe(state, job.recipeRef) as RecipeDefinition;
    const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
    if (asDate(job.expiresAt) > timestamp && attempts < recipe.maxAttempts) {
      job.status = "queued";
      job.workerId = undefined;
      job.leaseId = undefined;
      job.updatedAt = now(options.clock);
      state.jobs.set(job.id, job);
      options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.requeued_after_worker_failure", { attempts });
    } else {
      job.status = asDate(job.expiresAt) <= timestamp ? "timed_out" : "failed";
      job.failureReason = "assigned worker went offline";
      job.updatedAt = now(options.clock);
      state.jobs.set(job.id, job);
      options.kernel.event(state, job.project, { kind: "job", id: job.id }, `job.${job.status}`, { reason: job.failureReason });
    }
  }
  for (const job of state.jobs.values()) {
    if (!terminalJob(job.status) && asDate(job.expiresAt) <= timestamp) {
      job.status = "timed_out";
      job.failureReason = "job TTL expired";
      job.updatedAt = now(options.clock);
      state.jobs.set(job.id, job);
      if (job.leaseId) options.kernel.releaseLease(state, options.kernel.lease(state, job.leaseId));
      options.kernel.releaseMediaTask(state, job);
      options.kernel.finishAttempt(state, job, "failed");
      options.kernel.cancelInputRequests(state, { jobId: job.id });
      options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.timed_out", {});
      expiredJobs += 1;
    }
  }
  for (const request of state.inputRequests.values()) {
    if ((request.status === "pending" || request.status === "supplied") && asDate(request.expiresAt) <= timestamp) {
      request.status = "expired";
      state.inputRequests.set(request.id, request);
      options.kernel.discardInput(request.id);
      expiredInputs += 1;
      if (request.jobId) {
        const job = options.kernel.job(state, request.jobId);
        if (job.status === "awaiting_input") {
          job.status = "awaiting_manual";
          job.failureReason = "ephemeral input was not supplied within 60 seconds";
          job.updatedAt = now(options.clock);
          state.jobs.set(job.id, job);
          options.kernel.event(state, job.project, { kind: "job", id: job.id }, "job.awaiting_manual", { reason: job.failureReason });
        }
      }
    }
  }
  return { expiredSessions, expiredJobs, offlineWorkers, expiredInputs, reconnectReleased };
}
