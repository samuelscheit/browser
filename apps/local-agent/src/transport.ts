import type { Worker, WorkerAssignment, WorkerId } from "@browser-fabric/contracts";
import { AssignmentVerifier } from "@browser-fabric/control-plane";
import type { LocalAgentTransport } from "./index";

export interface LocalAgentHttpTransportOptions {
  baseUrl: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  assignmentVerifier: AssignmentVerifier;
  headers?: Record<string, string>;
}

/** Outbound-only transport. The local agent never listens for inbound browser/host commands. */
export class LocalAgentHttpTransport implements LocalAgentTransport {
  readonly #baseUrl: string;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #verifier: AssignmentVerifier;
  readonly #headers: Record<string, string>;
  #workerId?: WorkerId;

  public constructor(options: LocalAgentHttpTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#verifier = options.assignmentVerifier;
    this.#headers = options.headers ?? {};
  }

  public async register(worker: Worker): Promise<void> {
    this.#workerId = worker.id;
    await this.#request(`/v1/workers/register`, { method: "POST", body: worker });
  }

  public async heartbeat(workerId: WorkerId): Promise<void> {
    this.#assertWorker(workerId);
    await this.#request(`/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, { method: "POST" });
  }

  public async nextAssignments(workerId: WorkerId): Promise<WorkerAssignment[]> {
    this.#assertWorker(workerId);
    const response = await this.#request(`/v1/workers/${encodeURIComponent(workerId)}/assignments`);
    if (!Array.isArray(response)) return [];
    // The manager may return signed envelopes; reject unsigned or misaddressed work.
    return response.map((item) => {
      if (!item || typeof item !== "object" || !("signature" in item)) throw new Error("worker-manager returned an unsigned assignment");
      return this.#verifier.verify(item as never, workerId);
    });
  }

  public async claimAssignment(workerId: WorkerId, assignment: WorkerAssignment): Promise<WorkerAssignment> {
    this.#assertWorker(workerId);
    const leaseId = assignment.lease?.id;
    const jobId = leaseId === undefined ? assignment.job?.id : undefined;
    if (!leaseId && !jobId) throw new Error("assignment has neither a lease nor a media job");
    const response = await this.#request(`/v1/workers/${encodeURIComponent(workerId)}/claim`, {
      method: "POST",
      body: { ...(leaseId === undefined ? {} : { leaseId }), ...(jobId === undefined ? {} : { jobId }) }
    });
    if (!response || typeof response !== "object" || !("signature" in response)) throw new Error("worker-manager returned an unsigned claimed assignment");
    return this.#verifier.verify(response as never, workerId);
  }

  public async activeAssignments(workerId: WorkerId): Promise<WorkerAssignment[]> {
    this.#assertWorker(workerId);
    const response = await this.#request(`/v1/workers/${encodeURIComponent(workerId)}/active-assignments`);
    if (!Array.isArray(response)) return [];
    return response.map((item) => {
      if (!item || typeof item !== "object" || !("signature" in item)) throw new Error("worker-manager returned an unsigned active assignment");
      return this.#verifier.verify(item as never, workerId);
    });
  }

  public async takeEncryptedInput(workerId: WorkerId, requestId: string): Promise<unknown> {
    this.#assertWorker(workerId);
    return this.#request(`/v1/workers/${encodeURIComponent(workerId)}/input-requests/${encodeURIComponent(requestId)}`);
  }

  public async heartbeatLease(workerId: WorkerId, leaseId: string): Promise<void> {
    this.#assertWorker(workerId);
    await this.#request(`/v1/workers/${encodeURIComponent(workerId)}/leases/${encodeURIComponent(leaseId)}/heartbeat`, { method: "POST" });
  }

  async #request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { method: init.method ?? "GET", headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...this.#headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`local-agent transport failed (${response.status})`);
    return payload;
  }

  #assertWorker(workerId: WorkerId): void { if (this.#workerId !== workerId) throw new Error("local agent worker identity is not registered"); }
}
