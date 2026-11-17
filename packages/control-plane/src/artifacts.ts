import { createHash } from "node:crypto";
import type { Artifact, ArtifactPolicy, BrowserSessionId, JobId, Principal, ProfileRef, ProjectId } from "@browser-fabric/contracts";
import { FabricError } from "@browser-fabric/contracts";
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
  profileRef?: ProfileRef;
  kind: Artifact["kind"];
  contentType: string;
  bytes: Uint8Array | ArrayBuffer;
  policy: ArtifactPolicy;
  label?: string;
  /** API-originated attachment keeps the caller's project grant at the durable boundary. */
  actor?: Principal;
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
    if (hasSessionOwner === hasJobOwner) throw new FabricError("validation_failed", "artifact belongs to exactly one session or job", 400);
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const owner = input.sessionId ?? input.jobId!;
    const keyTail = `${digest.slice(7)}${input.label ? `-${input.label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)}` : ""}`;
    const key = `projects/${input.project}/artifacts/${owner}/${input.kind}/${keyTail}`;
    const requestedExpiry = new Date(this.#clock().getTime() + input.policy.retentionDays * 86_400_000).toISOString();
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
      ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
      kind: input.kind,
      objectKey: key,
      sha256: digest,
      mimeType: input.contentType,
      sizeBytes: bytes.byteLength,
      expiresAt: stored.expiresAt,
    };
    return this.#scheduler.attachArtifact(artifactInput, input.actor);
  }

}
