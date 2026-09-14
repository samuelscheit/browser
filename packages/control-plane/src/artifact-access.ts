import type { Artifact, ArtifactResponse, Principal, ProjectId } from "@browser-fabric/contracts";
import { FabricError, publicArtifact } from "@browser-fabric/contracts";
import type { ObjectStore } from "./object-store";
import type { BrowserScheduler } from "./scheduler";

export interface ArtifactDownload {
  artifact: ArtifactResponse;
  url: string;
  expiresAt: string;
}

export interface ArtifactAccessOptions {
  scheduler: BrowserScheduler;
  objectStore: ObjectStore;
  clock?: () => Date;
}

/**
 * The API-facing half of artifact access. It resolves authorization and immutable metadata before
 * it asks the object store to mint a short-lived read URL, so applications never learn object keys
 * or storage credentials.
 */
export class ArtifactAccess {
  readonly #scheduler: BrowserScheduler;
  readonly #objectStore: ObjectStore;
  readonly #clock: () => Date;

  public constructor(options: ArtifactAccessOptions) {
    this.#scheduler = options.scheduler;
    this.#objectStore = options.objectStore;
    this.#clock = options.clock ?? (() => options.scheduler.now());
  }

  public async download(artifactId: Artifact["id"], project: ProjectId, actor?: Principal, ttlSeconds = 60): Promise<ArtifactDownload> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
      throw new FabricError("validation_failed", "artifact download TTL must be from 1 to 900 seconds", 400);
    }
    const artifact = await this.#scheduler.getArtifact(artifactId, project, actor);
    const url = await this.#objectStore.signedReadUrl(artifact.objectKey, ttlSeconds);
    return {
      artifact: publicArtifact(artifact),
      url,
      expiresAt: new Date(this.#clock().getTime() + ttlSeconds * 1_000).toISOString(),
    };
  }
}
