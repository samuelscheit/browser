import { terminalBrowserSessionStatuses, terminalJobStatuses, type FabricEvent } from "@browser-fabric/contracts";
import type { FabricState } from "./state";

/**
 * How long finished sessions and jobs stay in the hot state, which every control-plane process
 * caches and the PostgreSQL store checkpoints. Afterwards they live only in the normalized tables.
 */
export interface HotStateRetention {
  /** Terminal sessions/jobs older than this are evicted. */
  terminalHistoryMs: number;
  /** At most this many unpinned terminal sessions, and as many jobs, stay hot (newest first). */
  terminalHistoryLimit: number;
}

// Clients read a final status or replay an idempotent create within seconds or minutes of the
// end; an hour of history covers that while keeping the hot state compact under heavy churn.
export const DEFAULT_HOT_STATE_RETENTION: HotStateRetention = { terminalHistoryMs: 60 * 60 * 1_000, terminalHistoryLimit: 1_000 };

// Only browser-session and job events are served from the hot state (the per-subject event
// APIs). Worker and profile events are durable telemetry: they are appended to fabric_events
// and then dropped from the state, so worker registration churn cannot grow the state.
const HOT_EVENT_SUBJECTS: ReadonlySet<FabricEvent["subject"]["kind"]> = new Set(["browser_session", "job"]);
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set(terminalBrowserSessionStatuses);
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(terminalJobStatuses);

/**
 * Drop everything the durable tables already hold and no live reader needs: append-only audits,
 * telemetry events, terminal history past the retention bounds, and every record that only
 * describes an evicted session or job (leases, clones, attempts, events, idempotency records,
 * input requests). Run it after the transaction's rows reached the normalized tables.
 */
export function compactHotState(state: FabricState, nowMs: number, retention: HotStateRetention): void {
  state.audits.clear();
  for (const [id, event] of state.events) if (!HOT_EVENT_SUBJECTS.has(event.subject.kind)) state.events.delete(id);
  for (const [id, artifact] of state.artifacts) if (Date.parse(artifact.expiresAt) <= nowMs) state.artifacts.delete(id);
  const pinned = pinnedSubjects(state, nowMs);
  const cutoff = nowMs - retention.terminalHistoryMs;
  const finishedSessions = [...state.sessions.values()]
    .filter((session) => TERMINAL_SESSION_STATUSES.has(session.status) && !pinned.has(session.id))
    .map((session) => ({ id: session.id, finishedAt: Date.parse(session.releasedAt ?? session.updatedAt) }));
  const finishedJobs = [...state.jobs.values()]
    .filter((job) => TERMINAL_JOB_STATUSES.has(job.status) && !pinned.has(job.id))
    .map((job) => ({ id: job.id, finishedAt: Date.parse(job.updatedAt) }));
  for (const id of beyondRetention(finishedSessions, cutoff, retention.terminalHistoryLimit)) state.sessions.delete(id);
  for (const id of beyondRetention(finishedJobs, cutoff, retention.terminalHistoryLimit)) state.jobs.delete(id);
  dropOrphans(state);
}

/**
 * A finished subject stays hot while anything live can still resolve it: an unexpired artifact
 * listing, a pending input request, or a lease that has not been released.
 */
function pinnedSubjects(state: FabricState, nowMs: number): Set<string> {
  const pinned = new Set<string>();
  const pin = (owner: { sessionId?: string; jobId?: string }) => {
    if (owner.sessionId) pinned.add(owner.sessionId);
    if (owner.jobId) pinned.add(owner.jobId);
  };
  for (const artifact of state.artifacts.values()) if (Date.parse(artifact.expiresAt) > nowMs) pin(artifact);
  for (const request of state.inputRequests.values()) if (request.status === "pending" || request.status === "supplied") pin(request);
  for (const lease of state.leases.values()) if (lease.status === "active" || lease.status === "releasing") pin(lease);
  return pinned;
}

function beyondRetention(finished: Array<{ id: string; finishedAt: number }>, cutoff: number, limit: number): string[] {
  const newestFirst = finished.length > limit ? [...finished].sort((left, right) => right.finishedAt - left.finishedAt) : finished;
  return newestFirst.filter((record, index) => record.finishedAt <= cutoff || index >= limit).map((record) => record.id);
}

/** Remove records whose session or job is no longer hot; they are only reachable through it. */
function dropOrphans(state: FabricState): void {
  const hot = (id: string | undefined): boolean => id !== undefined && (state.sessions.has(id) || state.jobs.has(id));
  for (const [id, lease] of state.leases) {
    const owner = lease.sessionId ?? lease.jobId;
    if (owner !== undefined && !hot(owner)) state.leases.delete(id);
  }
  for (const [id, clone] of state.clones) if (clone.status === "destroyed" && !state.leases.has(clone.createdForLease)) state.clones.delete(id);
  for (const [id, attempt] of state.attempts) if (!state.jobs.has(attempt.jobId)) state.attempts.delete(id);
  for (const [id, event] of state.events) if (!hot(event.subject.id)) state.events.delete(id);
  for (const [id, record] of state.idempotency) if (!hot(record.responseId)) state.idempotency.delete(id);
  for (const [id, request] of state.inputRequests) {
    if ((request.sessionId && !state.sessions.has(request.sessionId)) || (request.jobId && !state.jobs.has(request.jobId))) state.inputRequests.delete(id);
  }
}
