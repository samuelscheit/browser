import {
  FabricError,
  type BrowserSessionCreateInput,
  type BrowserSessionResponse,
  type JobCreateInput,
  type JobResponse,
  type JobStatus,
  type BrowserSessionStatus,
  type InputFieldType,
  type InputRequestId,
  type BrowserSessionId,
  type JobId,
  type Artifact,
  type ArtifactResponse,
  type ArtifactPolicyRef,
  type ProjectId,
  type MediaManifest,
  MEDIA_MANIFEST_CONTENT_TYPE,
  type MediaPlaybackEndpoint,
} from "@browser-fabric/contracts";

/**
 * Transport-independent options for the generated-style client.
 *
 * Credentials are deliberately not accepted here. The caller supplies a
 * fetch implementation or an Authorization header backed by its password
 * secret and may add transport-specific headers through `headers`.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FabricClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

export interface WaitOptions {
  /** Maximum wall-clock time to wait. Defaults to five minutes. */
  timeoutMs?: number;
  /** Initial polling delay. Defaults to 250 ms. */
  pollIntervalMs?: number;
  /** Upper bound for exponential polling. Defaults to two seconds. */
  maxPollIntervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (resource: BrowserSessionResponse | JobResponse) => void;
}

export interface SessionRunOptions extends WaitOptions {
  /** Release the session after the callback even when the callback throws. */
  releaseOnExit?: boolean;
  /** Optional lease heartbeat interval. Zero (the default) leaves heartbeats to the caller. */
  heartbeatIntervalMs?: number;
}

export interface JobRunOptions extends WaitOptions {
  /** Cancel the job when the callback throws. */
  cancelOnExit?: boolean;
}

export interface ArtifactUploadInput {
  kind: Artifact["kind"];
  contentType: string;
  bytes: Uint8Array | ArrayBuffer;
  /** Optional safe label; it never becomes a storage key supplied by the application. */
  label?: string;
}

export interface ArtifactDownload {
  artifact: ArtifactResponse;
  url: string;
  expiresAt: string;
}

export interface MediaManifestUploadOptions {
  artifactPolicyRef?: ArtifactPolicyRef;
  label?: string;
}

/** A live browser lease returned after Fabric has verified browser-level CDP readiness. */
export class BrowserSessionLeaseHandle {
  readonly #client: BrowserFabricClient;
  readonly #session: BrowserSessionResponse;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  public constructor(client: BrowserFabricClient, session: BrowserSessionResponse, heartbeatIntervalMs = 0) {
    this.#client = client;
    this.#session = session;
    if (heartbeatIntervalMs > 0) {
      if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000) throw new RangeError("heartbeatIntervalMs must be at least 1000 ms");
      this.#heartbeatTimer = setInterval(() => void this.heartbeat().catch(() => undefined), heartbeatIntervalMs);
    }
  }

  public get id(): BrowserSessionId | string { return this.#session.id; }
  public get endpoint(): string {
    if (!this.#session.cdpEndpoint) throw new FabricError("invalid_state", "browser session has no CDP endpoint", 409);
    return this.#session.cdpEndpoint;
  }
  public get response(): BrowserSessionResponse { return structuredClone(this.#session); }
  public get closed(): boolean { return this.#closed; }

  public async heartbeat(): Promise<BrowserSessionResponse> {
    if (this.#closed) throw new FabricError("invalid_state", "browser session lease is closed", 409);
    const current = await this.#client.browserSessions.heartbeat(this.#session.id);
    Object.assign(this.#session, current);
    return this.response;
  }

  public async release(): Promise<BrowserSessionResponse> {
    if (this.#closed) return this.response;
    this.#closed = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    const released = await this.#client.browserSessions.release(this.#session.id);
    Object.assign(this.#session, released);
    return this.response;
  }

  public async cancel(): Promise<BrowserSessionResponse> {
    if (this.#closed) return this.response;
    this.#closed = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    const cancelled = await this.#client.browserSessions.cancel(this.#session.id);
    Object.assign(this.#session, cancelled);
    return this.response;
  }

  public async close(): Promise<void> { await this.release().catch(() => undefined); }
  public async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000;

const terminalSessionStatuses = new Set<BrowserSessionStatus>([
  "released",
  "cancelled",
  "failed",
  "timed_out",
]);

const terminalJobStatuses = new Set<JobStatus>([
  "succeeded",
  "failed",
  "blocked_challenge",
  "awaiting_manual",
  "auth_required",
  "timed_out",
  "cancelled",
]);

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "The operation was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateWaitOptions(options: WaitOptions): Required<Pick<WaitOptions, "timeoutMs" | "pollIntervalMs" | "maxPollIntervalMs">> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60_000) {
    throw new RangeError("timeoutMs must be between 1 ms and 24 hours");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new RangeError("pollIntervalMs must be positive");
  if (!Number.isFinite(maxPollIntervalMs) || maxPollIntervalMs < pollIntervalMs) {
    throw new RangeError("maxPollIntervalMs must be at least pollIntervalMs");
  }
  return { timeoutMs, pollIntervalMs, maxPollIntervalMs };
}

function isReadySession(resource: BrowserSessionResponse): boolean {
  return (resource.status === "ready" || resource.status === "active") && typeof resource.cdpEndpoint === "string" && resource.cdpEndpoint.length > 0;
}

function isJobActionable(resource: JobResponse): boolean {
  return resource.status === "awaiting_input" || resource.status === "awaiting_manual";
}

/**
 * Small HTTP client used by every application adapter. It intentionally
 * contains the complete lifecycle surface so applications do not reimplement
 * polling, cancellation, URL encoding, or release-on-error behaviour.
 */
export class BrowserFabricClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #headers: Record<string, string>;

  public constructor(options: FabricClientOptions) {
    if (!options.baseUrl || !/^https?:\/\//i.test(options.baseUrl)) throw new TypeError("baseUrl must be an HTTP(S) URL");
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = { ...(options.headers ?? {}) };
  }

  public readonly browserSessions = {
    create: (input: BrowserSessionCreateInput) => this.#request<BrowserSessionResponse>("/browser-sessions", { method: "POST", body: input, idempotencyKey: input.idempotencyKey }),
    get: (id: BrowserSessionId | string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}`),
    heartbeat: (id: BrowserSessionId | string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/heartbeat`, { method: "POST" }),
    release: (id: BrowserSessionId | string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/release`, { method: "POST" }),
    cancel: (id: BrowserSessionId | string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    events: (id: BrowserSessionId | string, after?: number) => this.#request<unknown[]>(`/browser-sessions/${encodeURIComponent(id)}/events${after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`}`),
  };

  public readonly jobs = {
    create: (input: JobCreateInput) => this.#request<JobResponse>("/jobs", { method: "POST", body: input, idempotencyKey: input.idempotencyKey }),
    get: (id: JobId | string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}`),
    cancel: (id: JobId | string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    resume: (id: JobId | string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" }),
    events: (id: JobId | string, after?: number) => this.#request<unknown[]>(`/jobs/${encodeURIComponent(id)}/events${after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`}`),
    /** Issue short-lived HLS/direct-media endpoints once a media-playback job is ready. */
    issuePlayback: (id: JobId | string) => this.#request<MediaPlaybackEndpoint>(`/jobs/${encodeURIComponent(id)}/media-playback`, { method: "POST" }),
  };

  public readonly inputRequests = {
    createForSession: (sessionId: BrowserSessionId | string, input: { leaseId: string; field: string; fieldType: InputFieldType }) => this.#request<unknown>(`/browser-sessions/${encodeURIComponent(sessionId)}/input-requests`, { method: "POST", body: input }),
    createForJob: (jobId: JobId | string, input: { leaseId: string; field: string; fieldType: InputFieldType }) => this.#request<unknown>(`/jobs/${encodeURIComponent(jobId)}/input-requests`, { method: "POST", body: input }),
    listForSession: (sessionId: BrowserSessionId | string) => this.#request<unknown[]>(`/browser-sessions/${encodeURIComponent(sessionId)}/input-requests`),
    listForJob: (jobId: JobId | string) => this.#request<unknown[]>(`/jobs/${encodeURIComponent(jobId)}/input-requests`),
    get: (id: InputRequestId | string) => this.#request<unknown>(`/input-requests/${encodeURIComponent(id)}`),
    provideEncrypted: (id: InputRequestId | string, envelope: unknown) => this.#request<unknown>(`/input-requests/${encodeURIComponent(id)}/envelope`, { method: "POST", body: envelope }),
  };

  public readonly profiles = {
    create: (input: unknown) => this.#request<unknown>("/profiles", { method: "POST", body: input }),
    list: (project: string) => this.#request<unknown[]>(`/profiles?project=${encodeURIComponent(project)}`),
    get: (id: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}`),
    grant: (id: string, project: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}/grants`, { method: "POST", body: { project } }),
    revoke: (id: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  };

  /** Upload to an existing session/job owner without exposing object-store credentials or keys. */
  public readonly artifacts = {
    uploadForSession: (sessionId: BrowserSessionId | string, input: ArtifactUploadInput) => this.#uploadArtifact(`/browser-sessions/${encodeURIComponent(sessionId)}/artifacts`, input),
    uploadForJob: (jobId: JobId | string, input: ArtifactUploadInput) => this.#uploadArtifact(`/jobs/${encodeURIComponent(jobId)}/artifacts`, input),
    listForSession: (sessionId: BrowserSessionId | string) => this.#request<ArtifactResponse[]>(`/browser-sessions/${encodeURIComponent(sessionId)}/artifacts`),
    listForJob: (jobId: JobId | string) => this.#request<ArtifactResponse[]>(`/jobs/${encodeURIComponent(jobId)}/artifacts`),
    download: (artifactId: Artifact["id"] | string, project: ProjectId | string, ttlSeconds = 60) => {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new RangeError("artifact download TTL must be from 1 to 900 seconds");
      return this.#request<ArtifactDownload>(`/artifacts/${encodeURIComponent(artifactId)}?project=${encodeURIComponent(project)}&ttlSeconds=${ttlSeconds}`);
    },
    /**
     * Create the immutable input consumed by a later media-only job. The provider URL is parsed
     * server-side before storage; this client never receives an object key or storage credential.
     */
    uploadMediaManifest: (project: ProjectId | string, manifest: MediaManifest, options: MediaManifestUploadOptions = {}) => {
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      return this.#uploadArtifact(
        `/projects/${encodeURIComponent(project)}/media-manifests`,
        { kind: "media_manifest", contentType: MEDIA_MANIFEST_CONTENT_TYPE, bytes, ...(options.label === undefined ? {} : { label: options.label }) },
        options.artifactPolicyRef === undefined ? {} : { "x-fabric-artifact-policy-ref": options.artifactPolicyRef },
      );
    },
  };

  /** Poll until the browser endpoint is usable or a terminal state is reached. */
  public async waitForBrowserSession(id: BrowserSessionId | string, options: WaitOptions = {}): Promise<BrowserSessionResponse> {
    const bounds = validateWaitOptions(options);
    const started = Date.now();
    let delay = bounds.pollIntervalMs;
    while (true) {
      const current = await this.browserSessions.get(id);
      options.onUpdate?.(current);
      if (isReadySession(current) || terminalSessionStatuses.has(current.status)) return current;
      if (Date.now() - started >= bounds.timeoutMs) throw new FabricError("deadline_exceeded", `browser session ${id} did not become ready before the deadline`, 408);
      await sleep(Math.min(delay, Math.max(1, bounds.timeoutMs - (Date.now() - started))), options.signal);
      delay = Math.min(bounds.maxPollIntervalMs, Math.ceil(delay * 1.5));
    }
  }

  /** Acquire a verified browser lease for adapters that connect with their own CDP library. */
  public async acquireBrowserSession(input: BrowserSessionCreateInput, options: SessionRunOptions = {}): Promise<BrowserSessionLeaseHandle> {
    const created = await this.browserSessions.create(input);
    let ready: BrowserSessionResponse | undefined;
    try {
      ready = await this.waitForBrowserSession(created.id, options);
      if (!isReadySession(ready)) throw new FabricError("worker_unavailable", `browser session ${created.id} ended in ${ready.status}`, 503);
      return new BrowserSessionLeaseHandle(this, ready, options.heartbeatIntervalMs ?? 0);
    } catch (error) {
      if (!terminalSessionStatuses.has((ready ?? created).status)) await this.browserSessions.cancel(created.id).catch(() => undefined);
      throw error;
    }
  }

  /** Poll until a job reaches a terminal result or requires a manual handoff/input. */
  public async waitForJob(id: JobId | string, options: WaitOptions = {}): Promise<JobResponse> {
    const bounds = validateWaitOptions(options);
    const started = Date.now();
    let delay = bounds.pollIntervalMs;
    while (true) {
      const current = await this.jobs.get(id);
      options.onUpdate?.(current);
      if (terminalJobStatuses.has(current.status) || isJobActionable(current)) return current;
      if (Date.now() - started >= bounds.timeoutMs) throw new FabricError("deadline_exceeded", `job ${id} did not reach a terminal state before the deadline`, 408);
      await sleep(Math.min(delay, Math.max(1, bounds.timeoutMs - (Date.now() - started))), options.signal);
      delay = Math.min(bounds.maxPollIntervalMs, Math.ceil(delay * 1.5));
    }
  }

  /** Poll until a queued job is assigned and starts running (or asks for input/manual work). */
  public async waitForJobState(id: JobId | string, options: WaitOptions = {}): Promise<JobResponse> {
    const bounds = validateWaitOptions(options);
    const started = Date.now();
    let delay = bounds.pollIntervalMs;
    while (true) {
      const current = await this.jobs.get(id);
      options.onUpdate?.(current);
      if (current.status !== "queued") return current;
      if (Date.now() - started >= bounds.timeoutMs) throw new FabricError("deadline_exceeded", `job ${id} was not assigned before the deadline`, 408);
      await sleep(Math.min(delay, Math.max(1, bounds.timeoutMs - (Date.now() - started))), options.signal);
      delay = Math.min(bounds.maxPollIntervalMs, Math.ceil(delay * 1.5));
    }
  }

  /** Execute a raw-CDP callback with deterministic acquire/release semantics. */
  public async withBrowserSession<T>(input: BrowserSessionCreateInput, run: (session: BrowserSessionResponse) => Promise<T>, options: SessionRunOptions = {}): Promise<T> {
    let handle: BrowserSessionLeaseHandle | undefined;
    try {
      handle = await this.acquireBrowserSession(input, options);
      return await run(handle.response);
    } catch (error) {
      if (handle && !handle.closed) await handle.cancel().catch(() => undefined);
      throw error;
    } finally {
      if (options.releaseOnExit !== false && handle && !handle.closed) await handle.release().catch(() => undefined);
    }
  }

  /** Execute a typed job callback and cancel it if the callback fails. */
  public async withJob<T>(input: JobCreateInput, run: (job: JobResponse) => Promise<T>, options: JobRunOptions = {}): Promise<T> {
    const job = await this.jobs.create(input);
    let current: JobResponse | undefined;
    try {
      current = await this.waitForJob(job.id, options);
      return await run(current);
    } catch (error) {
      if (options.cancelOnExit !== false && current && !terminalJobStatuses.has(current.status)) await this.jobs.cancel(current.id).catch(() => undefined);
      throw error;
    }
  }

  async #request<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method ?? "GET",
        signal: init.signal,
        headers: {
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
          ...this.#headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new FabricError("internal_error", "Fabric transport request failed", 502);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const problem = body as { code?: string; detail?: string; status?: number; details?: Record<string, unknown> };
      const knownCodes = new Set([
        "authentication_required",
        "authorization_denied",
        "not_found",
        "conflict",
        "validation_failed",
        "idempotency_conflict",
        "invalid_state",
        "capacity_exhausted",
        "capability_invalid",
        "capability_expired",
        "secret_rejected",
        "worker_unavailable",
        "deadline_exceeded",
        "internal_error",
      ]);
      throw new FabricError(knownCodes.has(String(problem.code)) ? (problem.code as never) : "internal_error", problem.detail ?? `Fabric request failed (${response.status})`, problem.status ?? response.status, problem.details);
    }
    return body as T;
  }

  async #uploadArtifact(path: string, input: ArtifactUploadInput, additionalHeaders: Record<string, string> = {}): Promise<ArtifactResponse> {
    if (!input || !["screenshot", "mhtml", "trace", "har", "download", "video", "log", "media_manifest"].includes(input.kind)) {
      throw new FabricError("validation_failed", "artifact kind is invalid", 400);
    }
    if (!input.contentType || input.contentType.length > 255 || /[\0\r\n]/.test(input.contentType)) {
      throw new FabricError("validation_failed", "artifact content type is invalid", 400);
    }
    if (input.label !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(input.label)) {
      throw new FabricError("validation_failed", "artifact label is invalid", 400);
    }
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    if (bytes.byteLength > 32 * 1024 * 1024) throw new FabricError("validation_failed", "artifact upload exceeds the configured limit", 413);
    const uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": input.contentType,
          "x-fabric-artifact-kind": input.kind,
          ...(input.label === undefined ? {} : { "x-fabric-artifact-label": input.label }),
          ...additionalHeaders,
          ...this.#headers,
        },
        body: uploadBody,
      });
    } catch {
      throw new FabricError("internal_error", "Fabric transport request failed", 502);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const problem = body as { code?: string; detail?: string; status?: number; details?: Record<string, unknown> };
      const knownCodes = new Set(["authentication_required", "authorization_denied", "not_found", "conflict", "validation_failed", "idempotency_conflict", "invalid_state", "capacity_exhausted", "capability_invalid", "capability_expired", "secret_rejected", "worker_unavailable", "deadline_exceeded", "internal_error"]);
      throw new FabricError(knownCodes.has(String(problem.code)) ? (problem.code as never) : "internal_error", problem.detail ?? `Fabric request failed (${response.status})`, problem.status ?? response.status, problem.details);
    }
    return body as ArtifactResponse;
  }
}

export type { BrowserSessionId, JobId } from "@browser-fabric/contracts";

export * from "./adapters";

export * from "./input";
