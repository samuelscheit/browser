import { createHash, createHmac, randomBytes } from "node:crypto";
import { FabricError, type Artifact } from "@browser-fabric/contracts";

export interface ObjectStorePutInput {
  key: string;
  body: Uint8Array | ArrayBuffer;
  contentType: string;
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface ObjectStoreObject {
  key: string;
  body: Uint8Array;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, string>;
  createdAt: string;
  expiresAt: string;
}

export interface ObjectStore {
  put(input: ObjectStorePutInput): Promise<ObjectStoreObject>;
  head(key: string): Promise<Pick<ObjectStoreObject, "key" | "contentType" | "sha256" | "sizeBytes" | "expiresAt">>;
  get(key: string): Promise<ObjectStoreObject>;
  delete(key: string): Promise<void>;
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
  deleteExpired(at?: Date): Promise<number>;
}

function digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function normalizeBody(body: Uint8Array | ArrayBuffer): Uint8Array {
  return body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body);
}

/** Deterministic in-memory object store used by tests and local development. */
export class MemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, ObjectStoreObject>();
  readonly #secret: Uint8Array;
  readonly #clock: () => Date;

  public constructor(secret = randomBytes(32), clock: () => Date = () => new Date()) {
    if (secret.byteLength < 32) throw new Error("object-store signing secret must be at least 256 bits");
    this.#secret = new Uint8Array(secret);
    this.#clock = clock;
  }

  public async put(input: ObjectStorePutInput): Promise<ObjectStoreObject> {
    if (!/^[a-z0-9][a-z0-9/_\-.]{0,511}$/.test(input.key)) throw new FabricError("validation_failed", "object key contains invalid characters", 400);
    if (!input.contentType || input.contentType.length > 255) throw new FabricError("validation_failed", "content type is invalid", 400);
    const body = normalizeBody(input.body);
    const object: ObjectStoreObject = {
      key: input.key,
      body,
      contentType: input.contentType,
      sha256: digest(body),
      sizeBytes: body.byteLength,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: this.#clock().toISOString(),
      expiresAt: input.expiresAt
    };
    const existing = this.#objects.get(input.key);
    if (existing && existing.sha256 !== object.sha256) throw new FabricError("conflict", "object keys are immutable", 409);
    this.#objects.set(input.key, object);
    return structuredClone(object);
  }

  public async head(key: string) {
    const object = this.#objects.get(key);
    if (!object) throw new FabricError("not_found", "artifact object was not found", 404);
    return structuredClone({ key: object.key, contentType: object.contentType, sha256: object.sha256, sizeBytes: object.sizeBytes, expiresAt: object.expiresAt });
  }

  public async get(key: string): Promise<ObjectStoreObject> {
    const object = this.#objects.get(key);
    if (!object) throw new FabricError("not_found", "artifact object was not found", 404);
    if (new Date(object.expiresAt).getTime() <= this.#clock().getTime()) throw new FabricError("not_found", "artifact object has expired", 404);
    return structuredClone(object);
  }

  public async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  public async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new FabricError("validation_failed", "signed URL TTL must be from 1 to 900 seconds", 400);
    await this.head(key);
    const exp = Math.floor(this.#clock().getTime() / 1_000) + ttlSeconds;
    const payload = `${key}:${exp}`;
    const signature = createHmac("sha256", this.#secret).update(payload).digest("hex");
    return `memory://fabric-artifacts/${encodeURIComponent(key)}?exp=${exp}&sig=${signature}`;
  }

  public async deleteExpired(at = new Date()): Promise<number> {
    let count = 0;
    for (const [key, object] of this.#objects) {
      if (new Date(object.expiresAt).getTime() <= at.getTime()) {
        this.#objects.delete(key);
        count += 1;
      }
    }
    return count;
  }

  public async list(): Promise<ObjectStoreObject[]> {
    return [...this.#objects.values()].map((object) => structuredClone(object));
  }
}

/** Adapter boundary for MinIO/S3. The AWS SDK can implement this without changing Fabric contracts. */
export interface S3LikeClient {
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; metadata: Record<string, string> }): Promise<{ etag?: string }>;
  headObject(input: { bucket: string; key: string }): Promise<{ contentType?: string; contentLength: number; metadata?: Record<string, string> }>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; contentType?: string; metadata?: Record<string, string> }>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string>;
}

export class S3ObjectStore implements ObjectStore {
  public constructor(readonly client: S3LikeClient, readonly bucket: string, readonly clock: () => Date = () => new Date()) {}

  public async put(input: ObjectStorePutInput): Promise<ObjectStoreObject> {
    const body = normalizeBody(input.body);
    const sha256 = digest(body);
    const existing = await this.client.headObject({ bucket: this.bucket, key: input.key }).catch(() => undefined);
    if (existing?.metadata?.sha256 && existing.metadata.sha256 !== sha256) throw new FabricError("conflict", "object keys are immutable", 409);
    await this.client.putObject({ bucket: this.bucket, key: input.key, body, contentType: input.contentType, metadata: { ...(input.metadata ?? {}), sha256, expiresAt: input.expiresAt } });
    return { key: input.key, body, contentType: input.contentType, sha256, sizeBytes: body.byteLength, metadata: { ...(input.metadata ?? {}) }, createdAt: this.clock().toISOString(), expiresAt: input.expiresAt };
  }

  public async head(key: string) {
    const result = await this.client.headObject({ bucket: this.bucket, key }).catch(() => { throw new FabricError("not_found", "artifact object was not found", 404); });
    const sha256 = result.metadata?.sha256;
    const expiresAt = result.metadata?.expiresAt;
    if (!sha256 || !expiresAt) throw new FabricError("internal_error", "artifact object metadata is incomplete", 500);
    return { key, contentType: result.contentType ?? "application/octet-stream", sha256, sizeBytes: result.contentLength, expiresAt };
  }

  public async get(key: string): Promise<ObjectStoreObject> {
    const metadata = await this.head(key);
    if (new Date(metadata.expiresAt).getTime() <= this.clock().getTime()) throw new FabricError("not_found", "artifact object has expired", 404);
    const result = await this.client.getObject({ bucket: this.bucket, key });
    return { ...metadata, body: result.body, contentType: result.contentType ?? metadata.contentType, metadata: result.metadata ?? {}, createdAt: this.clock().toISOString() };
  }

  public async delete(key: string): Promise<void> {
    await this.client.deleteObject({ bucket: this.bucket, key });
  }

  public async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new FabricError("validation_failed", "signed URL TTL must be from 1 to 900 seconds", 400);
    await this.head(key);
    return this.client.presignGet({ bucket: this.bucket, key, expiresIn: ttlSeconds });
  }

  public async deleteExpired(): Promise<number> {
    // S3 lifecycle rules perform deletion; this method is intentionally a no-op adapter hook.
    return 0;
  }
}
