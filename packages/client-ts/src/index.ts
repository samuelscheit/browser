import { FabricError, type BrowserSessionCreateInput, type BrowserSessionResponse, type JobCreateInput, type JobResponse } from "@browser-fabric/contracts";

export interface FabricClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** mTLS is configured in the platform fetch implementation/sidecar, never encoded in requests. */
  headers?: Record<string, string>;
}

export class BrowserFabricClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  public constructor(options: FabricClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers ?? {};
  }

  public readonly browserSessions = {
    create: (input: BrowserSessionCreateInput) => this.#request<BrowserSessionResponse>("/browser-sessions", { method: "POST", body: input, idempotencyKey: input.idempotencyKey }),
    get: (id: string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}`),
    heartbeat: (id: string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/heartbeat`, { method: "POST" }),
    release: (id: string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/release`, { method: "POST" }),
    cancel: (id: string) => this.#request<BrowserSessionResponse>(`/browser-sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    events: (id: string) => this.#request<unknown[]>(`/browser-sessions/${encodeURIComponent(id)}/events`)
  };

  public readonly jobs = {
    create: (input: JobCreateInput) => this.#request<JobResponse>("/jobs", { method: "POST", body: input, idempotencyKey: input.idempotencyKey }),
    get: (id: string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}`),
    cancel: (id: string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    resume: (id: string) => this.#request<JobResponse>(`/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" }),
    events: (id: string) => this.#request<unknown[]>(`/jobs/${encodeURIComponent(id)}/events`)
  };

  public readonly inputRequests = {
    providePlaintextDevelopment: (id: string, value: string) => this.#request<unknown>(`/input-requests/${encodeURIComponent(id)}/value`, { method: "POST", body: { value } }),
    provideEncrypted: (id: string, envelope: unknown) => this.#request<unknown>(`/input-requests/${encodeURIComponent(id)}/envelope`, { method: "POST", body: envelope })
  };

  public readonly profiles = {
    create: (input: unknown) => this.#request<unknown>("/profiles", { method: "POST", body: input }),
    list: (project: string) => this.#request<unknown[]>(`/profiles?project=${encodeURIComponent(project)}`),
    get: (id: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}`),
    grant: (id: string, project: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}/grants`, { method: "POST", body: { project } }),
    revoke: (id: string) => this.#request<unknown>(`/profiles/${encodeURIComponent(id)}/revoke`, { method: "POST" })
  };

  async #request<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
        ...this.#headers
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const problem = body as { code?: string; detail?: string; status?: number; details?: Record<string, unknown> };
      throw new FabricError((problem.code ?? "internal_error") as never, problem.detail ?? `Fabric request failed (${response.status})`, problem.status ?? response.status, problem.details);
    }
    return body as T;
  }
}
