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

const objectKeyPattern = /^[a-z0-9][a-z0-9/_\-.]{0,511}$/;

function assertObjectKey(key: string): void {
  if (!objectKeyPattern.test(key) || key.includes("//") || key.includes("..")) {
    throw new FabricError("validation_failed", "object key contains invalid characters", 400);
  }
}

function assertObjectInput(input: Pick<ObjectStorePutInput, "key" | "contentType" | "expiresAt">): void {
  assertObjectKey(input.key);
  if (!input.contentType || input.contentType.length > 255 || /[\0\r\n]/.test(input.contentType)) {
    throw new FabricError("validation_failed", "content type is invalid", 400);
  }
  if (!Number.isFinite(new Date(input.expiresAt).getTime())) throw new FabricError("validation_failed", "object expiry is invalid", 400);
}

function normalizeMetadata(metadata: Record<string, string> | undefined, allowInternal = false): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/i.test(key) ||
      typeof value !== "string" ||
      value.length > 1_024 ||
      /[\0\r\n]/.test(value)
    ) {
      throw new FabricError("validation_failed", "object metadata is invalid", 400);
    }
    if (normalizedKey === "sha256" && (!allowInternal || !/^sha256:[a-f0-9]{64}$/i.test(value))) {
      throw new FabricError("validation_failed", "object metadata is invalid", 400);
    }
    if (normalizedKey === "expires-at" && (!allowInternal || !Number.isFinite(new Date(value).getTime()))) {
      throw new FabricError("validation_failed", "object metadata is invalid", 400);
    }
    const previous = normalized[normalizedKey];
    if (previous !== undefined && previous !== value) {
      throw new FabricError("validation_failed", "object metadata contains duplicate keys", 400);
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

function digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function sameMetadata(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalize = (value: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return normalize(left) === normalize(right);
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
    assertObjectInput(input);
    const inputMetadata = normalizeMetadata(input.metadata);
    const body = normalizeBody(input.body);
    const object: ObjectStoreObject = {
      key: input.key,
      body,
      contentType: input.contentType,
      sha256: digest(body),
      sizeBytes: body.byteLength,
      metadata: inputMetadata,
      createdAt: this.#clock().toISOString(),
      expiresAt: input.expiresAt
    };
    const existing = this.#objects.get(input.key);
    if (existing) {
      if (
        existing.sha256 !== object.sha256 ||
        existing.contentType !== object.contentType ||
        existing.expiresAt !== object.expiresAt ||
        !sameMetadata(existing.metadata, object.metadata)
      ) throw new FabricError("conflict", "object keys are immutable", 409);
      return structuredClone(existing);
    }
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

/** Adapter boundary for S3-compatible stores (RustFS, AWS S3, ...). The AWS SDK can implement this without changing Fabric contracts. */
export interface S3LikeClient {
  /** `ifNoneMatch="*"` is required for the first write to an immutable key. */
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; metadata: Record<string, string>; ifNoneMatch?: "*" }): Promise<{ etag?: string }>;
  headObject(input: { bucket: string; key: string }): Promise<{ contentType?: string; contentLength: number; metadata?: Record<string, string> }>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; contentType?: string; metadata?: Record<string, string> }>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string>;
}

export class S3ObjectStore implements ObjectStore {
  public constructor(readonly client: S3LikeClient, readonly bucket: string, readonly clock: () => Date = () => new Date()) {}

  public async put(input: ObjectStorePutInput): Promise<ObjectStoreObject> {
    assertObjectInput(input);
    const inputMetadata = normalizeMetadata(input.metadata);
    const body = normalizeBody(input.body);
    const sha256 = digest(body);
    let existing: Awaited<ReturnType<S3LikeClient["headObject"]>> | undefined;
    try {
      existing = await this.client.headObject({ bucket: this.bucket, key: input.key });
    } catch (error) {
      // Only a proven absence permits a create. Treating an authorization, transport, or
      // availability fault as "missing" would turn immutable writes into destructive retries.
      if (!(error instanceof FabricError && error.code === "not_found")) throw error;
    }
    if (existing) {
      const storedMetadata = existing.metadata ?? {};
      if (
        storedMetadata.sha256 !== sha256 ||
        storedMetadata["expires-at"] !== input.expiresAt ||
        existing.contentLength !== body.byteLength ||
        existing.contentType !== input.contentType ||
        !sameMetadata(publicMetadata(storedMetadata), inputMetadata)
      ) throw new FabricError("conflict", "object keys are immutable", 409);
      return {
        key: input.key,
        body,
        contentType: existing.contentType,
        sha256,
        sizeBytes: body.byteLength,
        metadata: publicMetadata(storedMetadata),
        createdAt: this.clock().toISOString(),
        expiresAt: storedMetadata["expires-at"],
      };
    }
    try {
      await this.client.putObject({
        bucket: this.bucket,
        key: input.key,
        body,
        contentType: input.contentType,
        metadata: { ...inputMetadata, sha256, "expires-at": input.expiresAt },
        ifNoneMatch: "*",
      });
    } catch (error) {
      // Another writer may have won the conditional create. Re-read once and accept only an
      // exact immutable replay; never turn an unavailable object store into an overwrite.
      if (!(error instanceof FabricError && error.code === "conflict")) throw error;
      const raced = await this.client.headObject({ bucket: this.bucket, key: input.key });
      const racedMetadata = raced.metadata ?? {};
      if (
        racedMetadata.sha256 !== sha256 ||
        racedMetadata["expires-at"] !== input.expiresAt ||
        raced.contentLength !== body.byteLength ||
        raced.contentType !== input.contentType ||
        !sameMetadata(publicMetadata(racedMetadata), inputMetadata)
      ) throw new FabricError("conflict", "object keys are immutable", 409);
    }
    return { key: input.key, body, contentType: input.contentType, sha256, sizeBytes: body.byteLength, metadata: inputMetadata, createdAt: this.clock().toISOString(), expiresAt: input.expiresAt };
  }

  public async head(key: string) {
    assertObjectKey(key);
    const result = await this.client.headObject({ bucket: this.bucket, key });
    const sha256 = result.metadata?.sha256;
    const expiresAt = result.metadata?.["expires-at"];
    if (!sha256 || !expiresAt) throw new FabricError("internal_error", "artifact object metadata is incomplete", 500);
    if (!/^sha256:[a-f0-9]{64}$/i.test(sha256) || !Number.isFinite(new Date(expiresAt).getTime()) || !Number.isSafeInteger(result.contentLength) || result.contentLength < 0) {
      throw new FabricError("internal_error", "artifact object metadata is invalid", 500);
    }
    return { key, contentType: result.contentType ?? "application/octet-stream", sha256, sizeBytes: result.contentLength, expiresAt };
  }

  public async get(key: string): Promise<ObjectStoreObject> {
    const metadata = await this.head(key);
    if (new Date(metadata.expiresAt).getTime() <= this.clock().getTime()) throw new FabricError("not_found", "artifact object has expired", 404);
    const result = await this.client.getObject({ bucket: this.bucket, key });
    if (result.body.byteLength !== metadata.sizeBytes || digest(result.body) !== metadata.sha256) throw new FabricError("internal_error", "artifact object integrity verification failed", 500);
    return { ...metadata, body: result.body, contentType: result.contentType ?? metadata.contentType, metadata: publicMetadata(result.metadata ?? {}), createdAt: this.clock().toISOString() };
  }

  public async delete(key: string): Promise<void> {
    assertObjectKey(key);
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

function publicMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key.toLowerCase() !== "sha256" && key.toLowerCase() !== "expires-at"));
}

/**
 * Small dependency-free S3 client used by production workers. It implements the subset
 * needed by ObjectStore and signs every request with AWS Signature V4; credentials never appear
 * in URLs, object metadata, or error messages. Keeping this adapter here avoids making the
 * control-plane contract depend on a particular AWS SDK package while remaining compatible with
 * RustFS, AWS S3 and other S3-compatible stores.
 */
export interface S3HttpClientOptions {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Injected by tests; production uses the current UTC instant. */
  clock?: () => Date;
}

function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function hmac(key: Uint8Array | string, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function hex(value: Uint8Array): string { return Buffer.from(value).toString("hex"); }
function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }

export class S3HttpClient implements S3LikeClient {
  readonly #endpoint: URL;
  readonly #accessKey: string;
  readonly #secretKey: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #clock: () => Date;

  public constructor(options: S3HttpClientOptions) {
    try { this.#endpoint = new URL(options.endpoint); } catch { throw new Error("S3 endpoint must be a valid URL"); }
    if (
      (this.#endpoint.protocol !== "http:" && this.#endpoint.protocol !== "https:") ||
      this.#endpoint.username ||
      this.#endpoint.password ||
      (this.#endpoint.pathname !== "" && this.#endpoint.pathname !== "/")
    ) throw new Error("S3 endpoint must be credential-free HTTP(S)");
    if (!options.accessKey || !options.secretKey || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(options.bucket)) throw new Error("S3 credentials/bucket are invalid");
    this.#accessKey = options.accessKey;
    this.#secretKey = options.secretKey;
    this.#bucket = options.bucket;
    this.#region = options.region ?? "us-east-1";
    if (!/^[a-z0-9-]{1,32}$/.test(this.#region)) throw new Error("S3 region is invalid");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
  }

  public async putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; metadata: Record<string, string>; ifNoneMatch?: "*" }): Promise<{ etag?: string }> {
    this.assertBucket(input.bucket);
    const metadata = normalizeMetadata(input.metadata, true);
    const result = await this.request("PUT", input.key, input.body, {
      "content-type": input.contentType,
      ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${key}`, value])),
      ...(input.ifNoneMatch === "*" ? { "if-none-match": "*" } : {}),
    });
    return { etag: result.headers.get("etag") ?? undefined };
  }

  public async headObject(input: { bucket: string; key: string }): Promise<{ contentType?: string; contentLength: number; metadata?: Record<string, string> }> {
    this.assertBucket(input.bucket);
    const response = await this.request("HEAD", input.key);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new FabricError("internal_error", "object store returned an invalid content length", 502);
    return { contentType: response.headers.get("content-type") ?? undefined, contentLength, metadata: this.metadata(response.headers) };
  }

  public async getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; contentType?: string; metadata?: Record<string, string> }> {
    this.assertBucket(input.bucket);
    const response = await this.request("GET", input.key);
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? undefined, metadata: this.metadata(response.headers) };
  }

  public async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    this.assertBucket(input.bucket);
    await this.request("DELETE", input.key);
  }

  public async presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string> {
    this.assertBucket(input.bucket);
    if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > 900) throw new FabricError("validation_failed", "signed URL TTL must be from 1 to 900 seconds", 400);
    const now = this.#clock();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const date = amzDate.slice(0, 8);
    const credential = `${this.#accessKey}/${date}/${this.#region}/s3/aws4_request`;
    const path = this.path(input.key);
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": credential, "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(input.expiresIn), "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = Object.keys(query).sort().map((key) => `${awsEncode(key)}=${awsEncode(query[key]!)}`).join("&");
    const canonicalRequest = ["GET", path, canonicalQuery, `host:${this.#endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.#secretKey}`, date), this.#region), "s3"), "aws4_request");
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hex(hmac(signingKey, stringToSign));
    query["X-Amz-Signature"] = signature;
    return `${this.#endpoint.origin}${path}?${Object.keys(query).sort().map((key) => `${awsEncode(key)}=${awsEncode(query[key]!)}`).join("&")}`;
  }

  async request(method: string, key: string, body?: Uint8Array, extraHeaders: Record<string, string> = {}): Promise<Response> {
    assertObjectKey(key);
    const url = `${this.#endpoint.origin}${this.path(key)}`;
    const payloadHash = body === undefined ? sha256("") : sha256(body);
    const now = this.#clock();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries({ host: this.#endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders })) {
      const normalized = name.toLowerCase();
      if (!/^[a-z0-9-]+$/.test(normalized) || typeof value !== "string" || /[\0\r\n]/.test(value)) throw new FabricError("validation_failed", "object store request headers are invalid", 400);
      headers[normalized] = value;
    }
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
    const canonicalRequest = [method, this.path(key), "", canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.#secretKey}`, date), this.#region), "s3"), "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKey}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${hex(hmac(signingKey, `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`))}`;
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
    });
    if (!response.ok) {
      const code = response.status === 404
        ? "not_found"
        : response.status === 409 || response.status === 412
          ? "conflict"
          : response.status === 401 || response.status === 403
            ? "authorization_denied"
            : "worker_unavailable";
      const status = code === "not_found" ? 404 : code === "conflict" ? 409 : code === "authorization_denied" ? 403 : 503;
      throw new FabricError(code, `object store returned HTTP ${response.status}`, status);
    }
    return response;
  }

  path(key: string): string { return `/${awsEncode(this.#bucket)}/${key.split("/").map(awsEncode).join("/")}`; }
  assertBucket(bucket: string): void { if (bucket !== this.#bucket) throw new FabricError("authorization_denied", "object store bucket is not authorized", 403); }
  metadata(headers: Headers): Record<string, string> { return Object.fromEntries([...headers.entries()].filter(([key]) => key.startsWith("x-amz-meta-")).map(([key, value]) => [key.slice("x-amz-meta-".length), value])); }
}
