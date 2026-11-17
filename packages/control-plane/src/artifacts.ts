import { createHash } from "node:crypto";
import type { Artifact, ArtifactPolicy, AttemptId, BrowserSessionId, JobId, Principal, ProfileRef, ProjectId, Worker } from "@browser-fabric/contracts";
import { FabricError, MEDIA_MANIFEST_CONTENT_TYPE, MEDIA_MANIFEST_MAX_BYTES, parseMediaManifest } from "@browser-fabric/contracts";
import type { ObjectStore } from "./object-store";
import type { BrowserScheduler, ArtifactInput } from "./scheduler";

export interface ArtifactCollectorOptions {
  scheduler: BrowserScheduler;
  objectStore: ObjectStore;
  clock?: () => Date;
}

export interface CaptureArtifactInput {
  project: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  /** A media_manifest can be project-scoped before the consuming media job exists. */
  projectScoped?: boolean;
  profileRef?: ProfileRef;
  kind: Artifact["kind"];
  contentType: string;
  bytes: Uint8Array | ArrayBuffer;
  policy: ArtifactPolicy;
  label?: string;
  /** Stable, non-secret idempotency suffix for a one-shot media result. */
  immutableKeySuffix?: string;
  /** Restrict a media result to its still-active assigned worker during durable attachment. */
  expectedWorkerId?: Worker["id"];
  /** Restrict a media result to the exact attempt that received its capability. */
  expectedMediaAttemptId?: AttemptId;
  /** API-originated attachment keeps the caller's project grant at the durable boundary. */
  actor?: Principal;
  /** Capability-bound media results may provide a stable lifecycle deadline for idempotent replays. */
  expiresAt?: string;
}

export interface ReadArtifactInput {
  artifact: Artifact;
  project: ProjectId;
  /** Hard cap before bytes enter memory. */
  maxBytes: number;
}

/** Writes immutable object bytes first, then records a matching artifact row. */
export class ArtifactCollector {
  readonly #scheduler: BrowserScheduler;
  readonly #objectStore: ObjectStore;
  readonly #clock: () => Date;

  public constructor(options: ArtifactCollectorOptions) {
    this.#scheduler = options.scheduler;
    this.#objectStore = options.objectStore;
    // The durable scheduler owns the retention clock. Sharing it prevents a fake/test clock—or a
    // production clock skew between services—from producing an object expiry that the scheduler
    // immediately rejects as outside its 30-day artifact policy.
    this.#clock = options.clock ?? (() => options.scheduler.now());
  }

  public async capture(input: CaptureArtifactInput): Promise<Artifact> {
    if (!input.policy.allowedKinds.includes(input.kind)) throw new FabricError("validation_failed", `artifact kind ${input.kind} is not enabled by policy`, 400);
    const hasSessionOwner = input.sessionId !== undefined;
    const hasJobOwner = input.jobId !== undefined;
    const projectScopedManifest = input.projectScoped === true && input.kind === "media_manifest";
    if (hasSessionOwner === hasJobOwner && !projectScopedManifest) {
      throw new FabricError("validation_failed", "artifact belongs to exactly one session/job or is a project-scoped media manifest", 400);
    }
    if (projectScopedManifest && (hasSessionOwner || hasJobOwner)) {
      throw new FabricError("validation_failed", "a project-scoped media manifest cannot also have a session or job owner", 400);
    }
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    if (input.kind === "media_manifest") {
      const contentType = input.contentType.toLowerCase().split(";", 1)[0]?.trim();
      if (contentType !== MEDIA_MANIFEST_CONTENT_TYPE) throw new FabricError("validation_failed", "media manifest artifacts require the Fabric media-manifest content type", 415);
      if (bytes.byteLength > MEDIA_MANIFEST_MAX_BYTES) throw new FabricError("validation_failed", "media manifest artifact exceeds the configured limit", 413);
      let manifest: unknown;
      try {
        manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new FabricError("validation_failed", "media manifest artifact is not valid UTF-8 JSON", 400);
      }
      parseMediaManifest(manifest);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const owner = input.sessionId ?? input.jobId ?? "media-manifests";
    if (input.immutableKeySuffix !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(input.immutableKeySuffix)) {
      throw new FabricError("validation_failed", "artifact immutable key suffix is invalid", 400);
    }
    const keyTail = input.immutableKeySuffix
      ?? `${digest.slice(7)}${input.label ? `-${input.label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)}` : ""}`;
    const key = `projects/${input.project}/artifacts/${owner}/${input.kind}/${keyTail}`;
    const requestedExpiry = input.expiresAt ?? new Date(this.#clock().getTime() + input.policy.retentionDays * 86_400_000).toISOString();
    if (!Number.isFinite(new Date(requestedExpiry).getTime()) || new Date(requestedExpiry).getTime() <= this.#clock().getTime()) {
      throw new FabricError("validation_failed", "artifact expiry is invalid", 400);
    }
    // Artifact keys are deterministic so a lost response can be replayed. Retention must therefore
    // be taken from a pre-existing immutable object on replay; recomputing `now + 30d` would turn
    // a harmless retry into an S3 conflict. Do not delete a failed/replayed object below: without
    // an ownership token a cleanup race could erase another request's already-attached artifact.
    let stored = await this.#objectStore.head(key).catch((error: unknown) => {
      if (error instanceof FabricError && error.code === "not_found") return undefined;
      throw error;
    });
    if (stored) {
      if (stored.sha256 !== digest || stored.sizeBytes !== bytes.byteLength || stored.contentType !== input.contentType) {
        throw new FabricError("conflict", "artifact object key is already bound to different immutable bytes", 409);
      }
    } else {
      try {
        await this.#objectStore.put({ key, body: bytes, contentType: input.contentType, expiresAt: requestedExpiry, metadata: { project: input.project, kind: input.kind } });
      } catch (error) {
        // A competing first writer can choose a slightly different retention timestamp. The key
        // is immutable, so accept that race only after the stored bytes and MIME metadata prove
        // it is the exact same artifact—not merely another object at a colliding path.
        if (!(error instanceof FabricError && error.code === "conflict")) throw error;
      }
      // A conditional create may have raced another equal writer. Re-read authoritative storage
      // metadata rather than assuming this call's requested expiry won the race.
      stored = await this.#objectStore.head(key);
      if (stored.sha256 !== digest || stored.sizeBytes !== bytes.byteLength || stored.contentType !== input.contentType) {
        throw new FabricError("conflict", "artifact object key is already bound to different immutable bytes", 409);
      }
    }
    const artifactInput: ArtifactInput = {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(projectScopedManifest ? { project: input.project, artifactPolicyRef: input.policy.ref } : {}),
      ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
      kind: input.kind,
      objectKey: key,
      sha256: digest,
      mimeType: input.contentType,
      sizeBytes: bytes.byteLength,
      ...(input.expectedWorkerId === undefined ? {} : { expectedWorkerId: input.expectedWorkerId }),
      ...(input.expectedMediaAttemptId === undefined ? {} : { expectedMediaAttemptId: input.expectedMediaAttemptId }),
      expiresAt: stored.expiresAt,
    };
    try {
      return await this.#scheduler.attachArtifact(artifactInput, input.actor);
    } catch (error) { throw error; }
  }

  /**
   * Read a previously registered immutable object for a Fabric-owned service. The caller
   * never receives an arbitrary object key: project, digest, size, and MIME metadata must all
   * match the durable artifact record first.
   */
  public async read(input: ReadArtifactInput): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (input.artifact.project !== input.project) throw new FabricError("authorization_denied", "artifact belongs to another project", 403);
    if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 256 * 1024 * 1024) {
      throw new FabricError("validation_failed", "artifact read limit is outside safe bounds", 400);
    }
    if (input.artifact.sizeBytes > input.maxBytes) throw new FabricError("validation_failed", "artifact exceeds the read limit", 413);
    const stored = await this.#objectStore.get(input.artifact.objectKey);
    if (
      stored.sha256 !== input.artifact.sha256 ||
      stored.sizeBytes !== input.artifact.sizeBytes ||
      stored.contentType !== input.artifact.mimeType
    ) throw new FabricError("conflict", "artifact object no longer matches durable metadata", 409);
    if (stored.body.byteLength > input.maxBytes) throw new FabricError("validation_failed", "artifact exceeds the read limit", 413);
    return { bytes: new Uint8Array(stored.body), contentType: stored.contentType };
  }
}
