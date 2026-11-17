import type { Artifact, BrowserSessionId, JobId, Principal } from "@browser-fabric/contracts";
import type { ArtifactCollector, CaptureArtifactInput } from "./artifacts";
import type { ArtifactOwnerContext, BrowserScheduler } from "./scheduler";

export type ArtifactOwner =
  | { sessionId: BrowserSessionId }
  | { jobId: JobId };

/**
 * Resolves an attachment owner before any application-supplied bytes are sent to storage. This
 * gives API uploads the same project authorization and immutable-policy boundary as worker
 * artifacts while keeping object-store credentials entirely inside Fabric.
 */
export class ArtifactService {
  readonly #scheduler: BrowserScheduler;
  readonly #collector: ArtifactCollector;

  public constructor(options: { scheduler: BrowserScheduler; collector: ArtifactCollector }) {
    this.#scheduler = options.scheduler;
    this.#collector = options.collector;
  }

  public async resolveOwner(owner: ArtifactOwner, actor?: Principal): Promise<ArtifactOwnerContext> {
    return this.#scheduler.resolveArtifactOwner(owner, actor);
  }

  public async capture(owner: ArtifactOwner, input: Omit<CaptureArtifactInput, "project" | "sessionId" | "jobId" | "profileRef" | "policy" | "actor">, actor?: Principal): Promise<Artifact> {
    const resolved = await this.resolveOwner(owner, actor);
    const policy = await this.#scheduler.getArtifactPolicy(resolved.artifactPolicyRef);
    return this.#collector.capture({
      ...input,
      project: resolved.project,
      ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
      ...(resolved.jobId === undefined ? {} : { jobId: resolved.jobId }),
      ...(resolved.profileRef === undefined ? {} : { profileRef: resolved.profileRef }),
      policy,
      actor,
    });
  }

}
