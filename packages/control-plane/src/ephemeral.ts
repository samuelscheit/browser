import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  createPrivateKey,
  type KeyObject
} from "node:crypto";
import { FabricError, type EphemeralInputRequest, type WorkerId } from "@browser-fabric/contracts";

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * An envelope carries ciphertext only. It is safe to relay transiently through the control plane:
 * only the registered worker-private key can decrypt the input value.
 */
export interface EphemeralInputEnvelope {
  version: 1;
  algorithm: "rsa-oaep-sha256+a256gcm";
  requestId: EphemeralInputRequest["id"];
  workerId: WorkerId;
  expiresAt: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface WorkerInputKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateWorkerInputKeyPair(modulusLength = 3072): WorkerInputKeyPair {
  if (!Number.isInteger(modulusLength) || modulusLength < 2048) throw new Error("worker input key must be at least RSA-2048");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength, publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function assertEnvelopeShape(envelope: EphemeralInputEnvelope): void {
  if (envelope.version !== 1 || envelope.algorithm !== "rsa-oaep-sha256+a256gcm" || !envelope.requestId || !envelope.workerId) throw new FabricError("validation_failed", "ephemeral input envelope is malformed", 400);
  for (const field of [envelope.wrappedKey, envelope.iv, envelope.tag, envelope.ciphertext]) {
    if (!/^[A-Za-z0-9_-]+$/.test(field) || field.length > 32_768) throw new FabricError("validation_failed", "ephemeral input envelope encoding is invalid", 400);
  }
}

export function encryptEphemeralInput(input: { request: EphemeralInputRequest; workerId: WorkerId; workerPublicKeyPem: string; value: string; now?: Date }): EphemeralInputEnvelope {
  if (!input.value || Buffer.byteLength(input.value, "utf8") > 16_384) throw new FabricError("validation_failed", "ephemeral input must be non-empty and at most 16KiB", 400);
  if (new Date(input.request.expiresAt).getTime() <= (input.now ?? new Date()).getTime()) throw new FabricError("invalid_state", "input request has expired", 409);
  const key = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key: input.workerPublicKeyPem, oaepHash: "sha256" }, key);
  return {
    version: 1,
    algorithm: "rsa-oaep-sha256+a256gcm",
    requestId: input.request.id,
    workerId: input.workerId,
    expiresAt: input.request.expiresAt,
    wrappedKey: wrappedKey.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptEphemeralInput(envelope: EphemeralInputEnvelope, privateKeyPem: string | KeyObject, expected: { requestId: EphemeralInputRequest["id"]; workerId: WorkerId; now?: Date }): string {
  assertEnvelopeShape(envelope);
  if (envelope.requestId !== expected.requestId || envelope.workerId !== expected.workerId) throw new FabricError("authorization_denied", "envelope is not scoped to this worker input request", 403);
  if (new Date(envelope.expiresAt).getTime() <= (expected.now ?? new Date()).getTime()) throw new FabricError("invalid_state", "ephemeral input envelope has expired", 409);
  let symmetricKey: Buffer | undefined;
  try {
    symmetricKey = privateDecrypt({ key: typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem, oaepHash: "sha256" }, Buffer.from(envelope.wrappedKey, "base64url"));
    if (symmetricKey.byteLength !== AES_KEY_BYTES) throw new Error("wrong symmetric key length");
    const decipher = createDecipheriv("aes-256-gcm", symmetricKey, Buffer.from(envelope.iv, "base64url"), { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const value = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    if (!value || Buffer.byteLength(value, "utf8") > 16_384) throw new Error("input value is invalid");
    return value;
  } catch {
    throw new FabricError("secret_rejected", "ephemeral input envelope could not be decrypted", 400);
  } finally {
    symmetricKey?.fill(0);
  }
}

/**
 * A ciphertext-only handoff queue. It intentionally has no `value` property and must be owned by
 * the worker's mTLS channel. Take removes the envelope before decryption, making it one-shot.
 */
export class EncryptedEphemeralInputInbox {
  readonly #envelopes = new Map<string, EphemeralInputEnvelope>();

  public offer(envelope: EphemeralInputEnvelope, request: EphemeralInputRequest): void {
    assertEnvelopeShape(envelope);
    if (request.status !== "pending" || request.id !== envelope.requestId || request.expiresAt !== envelope.expiresAt) throw new FabricError("invalid_state", "input request is not pending or does not match envelope", 409);
    if (this.#envelopes.has(envelope.requestId)) throw new FabricError("conflict", "input envelope was already supplied", 409);
    this.#envelopes.set(envelope.requestId, structuredClone(envelope));
  }

  public take(request: EphemeralInputRequest, workerId: WorkerId, privateKeyPem: string | KeyObject, now = new Date()): string {
    const envelope = this.takeEnvelope(request, workerId);
    return decryptEphemeralInput(envelope, privateKeyPem, { requestId: request.id, workerId, now });
  }

  public takeEnvelope(request: EphemeralInputRequest, workerId: WorkerId): EphemeralInputEnvelope {
    const envelope = this.#envelopes.get(request.id);
    if (!envelope) throw new FabricError("not_found", "no encrypted input has been supplied", 404);
    if (envelope.workerId !== workerId) throw new FabricError("authorization_denied", "input envelope is addressed to another worker", 403);
    this.#envelopes.delete(request.id);
    return structuredClone(envelope);
  }

  public expire(now = new Date()): number {
    let count = 0;
    for (const [id, envelope] of this.#envelopes) {
      if (new Date(envelope.expiresAt).getTime() <= now.getTime()) {
        this.#envelopes.delete(id);
        count += 1;
      }
    }
    return count;
  }

  public has(requestId: EphemeralInputRequest["id"]): boolean { return this.#envelopes.has(requestId); }
  public discard(requestId: EphemeralInputRequest["id"]): void { this.#envelopes.delete(requestId); }
  public clear(): void { this.#envelopes.clear(); }
}

export interface EphemeralInputVault {
  /** Store/deliver a plaintext value only in the worker-local memory boundary. */
  put(request: EphemeralInputRequest, workerId: WorkerId, value: string): void;
  /** Accept a ciphertext envelope without exposing its plaintext to the control-plane process. */
  putEnvelope?(envelope: EphemeralInputEnvelope, request: EphemeralInputRequest): void;
  /** One-shot read; implementations must erase their copy before returning. */
  take(request: EphemeralInputRequest, workerId: WorkerId): string;
  /** One-shot ciphertext retrieval for a worker process that decrypts locally. */
  takeEnvelope?(request: EphemeralInputRequest, workerId: WorkerId): EphemeralInputEnvelope;
  discard(requestId: EphemeralInputRequest["id"]): void;
  expire(now?: Date): number;
}

/** Development/test vault. Production deployments should inject a worker-local or E2E channel. */
export class MemoryEphemeralInputVault implements EphemeralInputVault {
  readonly #values = new Map<string, { value: string; workerId: WorkerId; expiresAt: number }>();
  readonly #clock: () => Date;
  public constructor(clock: () => Date = () => new Date()) { this.#clock = clock; }
  public put(request: EphemeralInputRequest, workerId: WorkerId, value: string): void {
    if (this.#values.has(request.id)) throw new FabricError("conflict", "ephemeral input was already supplied", 409);
    this.#values.set(request.id, { value, workerId, expiresAt: new Date(request.expiresAt).getTime() });
  }
  public take(request: EphemeralInputRequest, workerId: WorkerId): string {
    const entry = this.#values.get(request.id);
    this.#values.delete(request.id);
    if (!entry || entry.workerId !== workerId || entry.expiresAt <= this.#clock().getTime()) throw new FabricError("invalid_state", "ephemeral input is unavailable", 409);
    return entry.value;
  }
  public discard(requestId: EphemeralInputRequest["id"]): void { this.#values.delete(requestId); }
  public expire(now = new Date()): number {
    let count = 0;
    for (const [id, entry] of this.#values) if (entry.expiresAt <= now.getTime()) { this.#values.delete(id); count += 1; }
    return count;
  }
  public has(requestId: EphemeralInputRequest["id"]): boolean { return this.#values.has(requestId); }
}

/**
 * Worker-local vault backed by a ciphertext-only inbox. The private key is deliberately supplied
 * by the worker process at construction and is never serializable or exposed through the API.
 */
export class EncryptedWorkerInputVault implements EphemeralInputVault {
  readonly #inbox: EncryptedEphemeralInputInbox;
  readonly #workerId: WorkerId;
  readonly #privateKey: string | KeyObject;
  readonly #publicKeyPem: string;

  public constructor(input: { workerId: WorkerId; privateKeyPem: string | KeyObject; publicKeyPem?: string; inbox?: EncryptedEphemeralInputInbox }) {
    this.#workerId = input.workerId;
    this.#privateKey = input.privateKeyPem;
    this.#publicKeyPem = input.publicKeyPem ?? "";
    this.#inbox = input.inbox ?? new EncryptedEphemeralInputInbox();
  }

  public put(_request: EphemeralInputRequest, _workerId: WorkerId, _value: string): never {
    throw new FabricError("secret_rejected", "plaintext input cannot be injected into an encrypted worker vault; encrypt it for the worker first", 400);
  }
  public putEnvelope(envelope: EphemeralInputEnvelope, request: EphemeralInputRequest): void { this.#inbox.offer(envelope, request); }
  public offer(envelope: EphemeralInputEnvelope, request: EphemeralInputRequest): void { this.putEnvelope(envelope, request); }
  public take(request: EphemeralInputRequest, workerId: WorkerId): string {
    if (workerId !== this.#workerId) throw new FabricError("authorization_denied", "input vault belongs to another worker", 403);
    return this.#inbox.take(request, workerId, this.#privateKey);
  }
  public takeEnvelope(request: EphemeralInputRequest, workerId: WorkerId): EphemeralInputEnvelope {
    if (workerId !== this.#workerId) throw new FabricError("authorization_denied", "input vault belongs to another worker", 403);
    return this.#inbox.takeEnvelope(request, workerId);
  }
  public discard(requestId: EphemeralInputRequest["id"]): void { this.#inbox.discard(requestId); }
  public expire(now = new Date()): number { return this.#inbox.expire(now); }
  public publicKeyPem(): string { return this.#publicKeyPem; }
}

/**
 * Control-plane-safe ciphertext router. It can be backed by a transient mTLS message bus in
 * production; this in-memory implementation is deterministic for tests and single-process mode.
 * It deliberately cannot return plaintext through `take`.
 */
export class EncryptedInputRouter implements EphemeralInputVault {
  readonly #inboxes = new Map<WorkerId, EncryptedEphemeralInputInbox>();

  public put(_request: EphemeralInputRequest, _workerId: WorkerId, _value: string): never {
    throw new FabricError("secret_rejected", "plaintext input cannot enter the control-plane router; encrypt it for the worker first", 400);
  }

  public putEnvelope(envelope: EphemeralInputEnvelope, request: EphemeralInputRequest): void {
    let inbox = this.#inboxes.get(envelope.workerId);
    if (!inbox) { inbox = new EncryptedEphemeralInputInbox(); this.#inboxes.set(envelope.workerId, inbox); }
    inbox.offer(envelope, request);
  }

  public take(_request: EphemeralInputRequest, _workerId: WorkerId): never {
    throw new FabricError("secret_rejected", "the control plane cannot decrypt worker input; retrieve the ciphertext envelope at the worker", 400);
  }

  public takeEnvelope(request: EphemeralInputRequest, workerId: WorkerId): EphemeralInputEnvelope {
    const inbox = this.#inboxes.get(workerId);
    if (!inbox) throw new FabricError("not_found", "no encrypted input has been supplied", 404);
    return inbox.takeEnvelope(request, workerId);
  }

  public discard(requestId: EphemeralInputRequest["id"]): void { for (const inbox of this.#inboxes.values()) inbox.discard(requestId); }
  public expire(now = new Date()): number { let count = 0; for (const inbox of this.#inboxes.values()) count += inbox.expire(now); return count; }
  public clear(): void { this.#inboxes.clear(); }
}
