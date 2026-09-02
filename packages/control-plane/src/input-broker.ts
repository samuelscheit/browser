import { FabricError } from "@browser-fabric/contracts";
import type { EphemeralInputEnvelope } from "./ephemeral";

/**
 * Transient ciphertext relay boundary. The relay may buffer ciphertext in RAM, but it has no
 * decryption key and never accepts a plaintext value. Implementations must be single-use.
 */
export interface EncryptedInputBroker {
  put(requestId: string, envelope: EphemeralInputEnvelope): Promise<void> | void;
  take(requestId: string, workerId: string): Promise<EphemeralInputEnvelope> | EphemeralInputEnvelope;
  discard(requestId: string): Promise<void> | void;
  expire(now?: Date): Promise<number> | number;
}

function validateEnvelope(requestId: string, envelope: EphemeralInputEnvelope): void {
  if (envelope.version !== 1 || envelope.algorithm !== "rsa-oaep-sha256+a256gcm" || envelope.requestId !== requestId || !envelope.workerId || !envelope.expiresAt) throw new FabricError("validation_failed", "encrypted input envelope is malformed", 400);
  for (const value of [envelope.wrappedKey, envelope.iv, envelope.tag, envelope.ciphertext]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32_768) throw new FabricError("validation_failed", "encrypted input envelope encoding is invalid", 400);
  }
  if (new Date(envelope.expiresAt).getTime() <= Date.now()) throw new FabricError("invalid_state", "encrypted input envelope has expired", 409);
}

export class MemoryEncryptedInputBroker implements EncryptedInputBroker {
  readonly #envelopes = new Map<string, EphemeralInputEnvelope>();
  readonly #maxEnvelopes: number;

  public constructor(maxEnvelopes = 10_000) {
    if (!Number.isInteger(maxEnvelopes) || maxEnvelopes < 1 || maxEnvelopes > 1_000_000) throw new Error("input broker envelope capacity is outside safe bounds");
    this.#maxEnvelopes = maxEnvelopes;
  }

  public put(requestId: string, envelope: EphemeralInputEnvelope): void {
    validateEnvelope(requestId, envelope);
    const previous = this.#envelopes.get(requestId);
    if (previous) {
      if (previous.ciphertext !== envelope.ciphertext || previous.tag !== envelope.tag) throw new FabricError("conflict", "a different encrypted envelope already exists for this request", 409);
      return;
    }
    if (this.#envelopes.size >= this.#maxEnvelopes) throw new FabricError("capacity_exhausted", "encrypted input broker capacity is exhausted", 429);
    this.#envelopes.set(requestId, structuredClone(envelope));
  }

  public take(requestId: string, workerId: string): EphemeralInputEnvelope {
    const envelope = this.#envelopes.get(requestId);
    if (!envelope) throw new FabricError("not_found", "encrypted input envelope was not found", 404);
    if (envelope.workerId !== workerId) throw new FabricError("authorization_denied", "encrypted input envelope belongs to another worker", 403);
    if (new Date(envelope.expiresAt).getTime() <= Date.now()) { this.#envelopes.delete(requestId); throw new FabricError("invalid_state", "encrypted input envelope has expired", 409); }
    this.#envelopes.delete(requestId);
    return structuredClone(envelope);
  }

  public discard(requestId: string): void { this.#envelopes.delete(requestId); }
  public expire(now = new Date()): number { let count = 0; for (const [id, envelope] of this.#envelopes) if (new Date(envelope.expiresAt).getTime() <= now.getTime()) { this.#envelopes.delete(id); count += 1; } return count; }
  public has(requestId: string): boolean { return this.#envelopes.has(requestId); }
  public clear(): void { this.#envelopes.clear(); }
}

export interface HttpEncryptedInputBrokerOptions {
  baseUrl: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  /** Internal service identity header; TLS/mTLS is normally configured by the fetch agent. */
  serviceName?: string;
}

/** Build a Bun fetch function with an explicit service mTLS identity. */
export function createBunMtlsFetch(input: { certificateFile: string; keyFile: string; caFile: string }): (request: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const tls = { cert: Bun.file(input.certificateFile), key: Bun.file(input.keyFile), ca: Bun.file(input.caFile), rejectUnauthorized: true };
  return (request, init = {}) => globalThis.fetch(request, { ...init, tls } as RequestInit);
}

/** HTTP adapter for the private, non-durable input broker service. */
export class HttpEncryptedInputBroker implements EncryptedInputBroker {
  readonly #baseUrl: string;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #headers: Record<string, string>;
  readonly #serviceName: string;

  public constructor(options: HttpEncryptedInputBrokerOptions) {
    const base = options.baseUrl.replace(/\/$/, "");
    if (!/^https:\/\//.test(base) && process.env.NODE_ENV === "production") throw new Error("encrypted input broker must use HTTPS in production");
    this.#baseUrl = base;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers ?? {};
    this.#serviceName = options.serviceName ?? "fabric-service";
  }

  public async put(requestId: string, envelope: EphemeralInputEnvelope): Promise<void> {
    validateEnvelope(requestId, envelope);
    const response = await this.#fetch(`${this.#baseUrl}/v1/input-envelopes/${encodeURIComponent(requestId)}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-fabric-service": this.#serviceName, ...this.#headers }, body: JSON.stringify(envelope) });
    if (!response.ok) throw await brokerError(response);
  }

  public async take(requestId: string, workerId: string): Promise<EphemeralInputEnvelope> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/input-envelopes/${encodeURIComponent(requestId)}?workerId=${encodeURIComponent(workerId)}`, { headers: { accept: "application/json", "x-fabric-service": this.#serviceName, ...this.#headers } });
    if (!response.ok) throw await brokerError(response);
    const envelope = await response.json() as EphemeralInputEnvelope;
    validateEnvelope(requestId, envelope);
    if (envelope.workerId !== workerId) throw new FabricError("authorization_denied", "encrypted input envelope belongs to another worker", 403);
    return envelope;
  }

  public async discard(requestId: string): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/input-envelopes/${encodeURIComponent(requestId)}`, { method: "DELETE", headers: { accept: "application/json", "x-fabric-service": this.#serviceName, ...this.#headers } });
    if (!response.ok && response.status !== 404) throw await brokerError(response);
  }

  public async expire(): Promise<number> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/input-envelopes/expire`, { method: "POST", headers: { accept: "application/json", "x-fabric-service": this.#serviceName, ...this.#headers } });
    if (!response.ok) throw await brokerError(response);
    const body = await response.json() as { deleted?: unknown };
    return typeof body.deleted === "number" ? body.deleted : 0;
  }
}

async function brokerError(response: Response): Promise<FabricError> {
  const body = await response.json().catch(() => ({})) as { code?: string; detail?: string };
  const known = ["authentication_required", "authorization_denied", "not_found", "conflict", "validation_failed", "invalid_state", "worker_unavailable"];
  const code = known.includes(String(body.code)) ? String(body.code) as ConstructorParameters<typeof FabricError>[0] : "worker_unavailable";
  return new FabricError(code, body.detail ?? `input broker returned HTTP ${response.status}`, response.status);
}
