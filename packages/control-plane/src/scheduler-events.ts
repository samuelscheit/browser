import { FabricError, type BrowserSessionId, type FabricEvent, type JobId, type Principal, type BrowserSessionResponse, type JobResponse } from "@browser-fabric/contracts";
import type { Clock } from "./clock";
import type { FabricStore } from "./store";
import type { SchedulerKernel } from "./scheduler-kernel";

export interface SchedulerEventsContext { store: FabricStore; clock: Clock; kernel: SchedulerKernel; }

export async function getSession(context: SchedulerEventsContext, sessionId: BrowserSessionId, actor?: Principal): Promise<BrowserSessionResponse> {
  return context.store.transact((state) => {
    const session = context.kernel.session(state, sessionId);
    context.kernel.authorizeProject(state, actor, session.project, "read_browser_session", sessionId);
    context.kernel.materializeSessionCapability(state, session);
    return {
      id: session.id, status: session.status,
      ...(session.cdpEndpoint === undefined ? {} : { cdpEndpoint: session.cdpEndpoint }),
      expiresAt: session.expiresAt,
      ...(session.workerId === undefined ? {} : { workerId: session.workerId }),
      ...(session.leaseId === undefined ? {} : { profileLease: { id: session.leaseId, mode: session.leaseMode, ...(session.profileRef === undefined ? {} : { profileRef: session.profileRef }) } })
    };
  });
}

export async function getJob(context: SchedulerEventsContext, jobId: JobId, actor?: Principal): Promise<JobResponse> {
  return context.store.read((state) => {
    const job = context.kernel.job(state, jobId);
    context.kernel.authorizeProject(state, actor, job.project, "read_job", jobId);
    return {
      id: job.id,
      status: job.status,
      expiresAt: job.expiresAt,
      ...(job.workerId === undefined ? {} : { workerId: job.workerId }),
      ...(job.result === undefined ? {} : { result: structuredClone(job.result) }),
      ...(job.failureReason === undefined ? {} : { failureReason: job.failureReason }),
    };
  });
}

type EventSubject = { kind: "browser_session" | "job"; id: string };

export async function events(context: SchedulerEventsContext, subject: EventSubject, actor?: Principal, afterSequence?: number): Promise<FabricEvent[]> {
  if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) throw new FabricError("validation_failed", "event cursor must be a non-negative integer", 400);
  return context.store.read((state) => {
    const project = subject.kind === "browser_session" ? context.kernel.session(state, subject.id as BrowserSessionId).project : context.kernel.job(state, subject.id as JobId).project;
    context.kernel.authorizeProject(state, actor, project, "read_events", subject.id);
    return [...state.events.values()].filter((event) => event.subject.kind === subject.kind && event.subject.id === subject.id && (afterSequence === undefined || event.sequence > afterSequence)).sort((left, right) => left.sequence - right.sequence).map((event) => structuredClone(event));
  });
}

export async function* watchEvents(context: SchedulerEventsContext, subject: EventSubject, options: { afterSequence?: number; signal?: AbortSignal; pollMs?: number; maxDurationMs?: number; actor?: Principal } = {}): AsyncGenerator<FabricEvent> {
  let cursor = options.afterSequence ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0) throw new FabricError("validation_failed", "event cursor must be a non-negative integer", 400);
  const deadline = context.clock.now().getTime() + (options.maxDurationMs ?? 300_000);
  const pollMs = Math.max(25, Math.min(10_000, options.pollMs ?? 250));
  while (!(options.signal?.aborted ?? false) && context.clock.now().getTime() < deadline) {
    const batch = await events(context, subject, options.actor, cursor);
    if (batch.length) { for (const event of batch) { cursor = Math.max(cursor, event.sequence); yield event; } } else await Bun.sleep(pollMs);
  }
}
