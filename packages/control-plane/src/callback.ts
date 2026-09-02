import { createHmac } from "node:crypto";
import { FabricError, terminalJobStatuses, type Job, type JobStatus } from "@browser-fabric/contracts";
import type { FabricStore } from "./store";

export interface CallbackRequest {
  job: Pick<Job, "id" | "project" | "status" | "result" | "failureReason" | "updatedAt">;
  attempt: number;
}

export interface CallbackTransport {
  send(input: { url: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ status: number }>;
}

export interface CallbackDeliveryResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

function safePayload(request: CallbackRequest): Record<string, unknown> {
  // `result` and failureReason have already passed assertDurablePayload/safeFailureReason in the scheduler.
  return {
    event: `job.${request.job.status}`,
    jobId: request.job.id,
    project: request.job.project,
    status: request.job.status,
    ...(request.job.result === undefined ? {} : { result: request.job.result }),
    ...(request.job.failureReason === undefined ? {} : { failureReason: request.job.failureReason }),
    updatedAt: request.job.updatedAt,
    attempt: request.attempt
  };
}

export class FetchCallbackTransport implements CallbackTransport {
  public constructor(readonly fetcher: typeof fetch = globalThis.fetch) {}

  public async send(input: { url: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ status: number }> {
    const response = await this.fetcher(input.url, { method: "POST", headers: { "content-type": "application/json", ...input.headers }, body: input.body, signal: input.signal });
    return { status: response.status };
  }
}

/** Signed, bounded webhook delivery. Secret bytes are supplied by the caller and never persisted. */
export class WebhookCallbackDispatcher {
  readonly #transport: CallbackTransport;
  readonly #clock: () => Date;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;

  public constructor(options: { transport?: CallbackTransport; clock?: () => Date; maxAttempts?: number; timeoutMs?: number } = {}) {
    this.#transport = options.transport ?? new FetchCallbackTransport();
    this.#clock = options.clock ?? (() => new Date());
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  public async deliver(input: { url: string; secret: string; request: CallbackRequest }): Promise<CallbackDeliveryResult> {
    if (!/^https:\/\//.test(input.url)) throw new FabricError("validation_failed", "callback URL must use HTTPS", 400);
    if (!input.secret || input.secret.length < 16) throw new FabricError("validation_failed", "callback signing secret is too short", 400);
    const payload = safePayload(input.request);
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(this.#clock().getTime() / 1_000).toString();
    const signature = createHmac("sha256", input.secret).update(`${timestamp}.${body}`).digest("hex");
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const result = await this.#transport.send({ url: input.url, headers: { "x-fabric-event-id": input.request.job.id, "x-fabric-event-timestamp": timestamp, "x-fabric-event-signature": `v1=${signature}` }, body, signal: controller.signal });
        lastStatus = result.status;
        if (result.status >= 200 && result.status < 300) return { delivered: true, attempts: attempt, lastStatus };
        lastError = `callback returned HTTP ${result.status}`;
        if (result.status >= 400 && result.status < 500 && result.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "callback transport failed";
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.#maxAttempts) await Bun.sleep(Math.min(2_000, 100 * 2 ** (attempt - 1)));
    }
    return { delivered: false, attempts: attemptsMade, ...(lastStatus === undefined ? {} : { lastStatus }), ...(lastError === undefined ? {} : { lastError }) };
  }
}

/** Pollable callback queue with in-memory dedupe; deployments can persist delivery IDs separately. */
export class CallbackQueue {
  readonly #delivered = new Set<string>();
  readonly #inFlight = new Set<string>();

  public constructor(readonly store: FabricStore, readonly dispatcher: WebhookCallbackDispatcher) {}

  public async drain(secretForJob: (job: Job) => Promise<string | undefined> | string | undefined): Promise<CallbackDeliveryResult[]> {
    const snapshot = await this.store.snapshot();
    const results: CallbackDeliveryResult[] = [];
    for (const job of snapshot.jobs.values()) {
      if (!job.callback || !terminalJobStatuses.includes(job.status as never) || this.#delivered.has(job.id) || this.#inFlight.has(job.id)) continue;
      this.#inFlight.add(job.id);
      try {
        const secret = await secretForJob(job);
        if (!secret) continue;
        const attempts = [...snapshot.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
        const result = await this.dispatcher.deliver({ url: job.callback.url, secret, request: { job, attempt: attempts } });
        results.push(result);
        if (result.delivered) this.#delivered.add(job.id);
      } finally {
        this.#inFlight.delete(job.id);
      }
    }
    return results;
  }

  public delivered(jobId: string): boolean { return this.#delivered.has(jobId); }
}
