import { createHash } from "node:crypto";
import type { Artifact, ArtifactPolicy, BrowserSessionId, JobId, ProfileRef, ProjectId } from "@browser-fabric/contracts";
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
}

/** Writes immutable object bytes first, then records a matching artifact row. */
export class ArtifactCollector {
  readonly #scheduler: BrowserScheduler;
  readonly #objectStore: ObjectStore;
  readonly #clock: () => Date;

  public constructor(options: ArtifactCollectorOptions) {
    this.#scheduler = options.scheduler;
    this.#objectStore = options.objectStore;
    this.#clock = options.clock ?? (() => new Date());
  }

  public async capture(input: CaptureArtifactInput): Promise<Artifact> {
    if (!input.policy.allowedKinds.includes(input.kind)) throw new FabricError("validation_failed", `artifact kind ${input.kind} is not enabled by policy`, 400);
    if ((input.sessionId === undefined) === (input.jobId === undefined)) throw new FabricError("validation_failed", "artifact belongs to exactly one session or job", 400);
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const owner = input.sessionId ?? input.jobId!;
    const key = `projects/${input.project}/artifacts/${owner}/${input.kind}/${digest.slice(7)}${input.label ? `-${input.label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)}` : ""}`;
    const expiresAt = new Date(this.#clock().getTime() + input.policy.retentionDays * 86_400_000).toISOString();
    await this.#objectStore.put({ key, body: bytes, contentType: input.contentType, expiresAt, metadata: { project: input.project, kind: input.kind, sha256: digest } });
    const artifactInput: ArtifactInput = {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
      kind: input.kind,
      objectKey: key,
      sha256: digest,
      mimeType: input.contentType,
      sizeBytes: bytes.byteLength
    };
    try {
      return await this.#scheduler.attachArtifact(artifactInput);
    } catch (error) {
      await this.#objectStore.delete(key).catch(() => undefined);
      throw error;
    }
  }
}
