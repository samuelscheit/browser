import { createPublicKey } from "node:crypto";
import { FabricError, isSafeDockerVolumeName, type Principal, type Worker, type WorkerCapabilities, type WorkerResourceLimits, runtimeFamilies } from "@browser-fabric/contracts";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new FabricError("validation_failed", `${field} must be a non-empty string`, 400);
  return value;
}
function opaqueWorkerId(value: unknown): Worker["id"] {
  const parsed = requiredString(value, "id");
  if (!/^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed)) throw new FabricError("validation_failed", "id must be an opaque worker identifier", 400);
  return parsed as Worker["id"];
}
function endpoint(value: unknown, field: string, protocols: readonly string[]): string {
  const parsed = requiredString(value, field);
  let url: URL;
  try { url = new URL(parsed); } catch { throw new FabricError("validation_failed", `${field} must be a valid URL`, 400); }
  if (!protocols.includes(url.protocol)) throw new FabricError("validation_failed", `${field} uses an unsupported protocol`, 400);
  if (url.username || url.password) throw new FabricError("secret_rejected", `${field} must not embed credentials`, 400);
  return parsed;
}
function boundedInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new FabricError("validation_failed", `${field} must be an integer from ${min} to ${max}`, 400);
  return value;
}

export function parseWorkerRegistration(value: unknown, certificateFingerprint: string): Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FabricError("validation_failed", "worker registration must be an object", 400);
  const input = value as Record<string, unknown>;
  const capabilitiesRaw = input.capabilities;
  if (capabilitiesRaw === null || typeof capabilitiesRaw !== "object" || Array.isArray(capabilitiesRaw)) throw new FabricError("validation_failed", "capabilities must be an object", 400);
  const capabilitiesInput = capabilitiesRaw as Record<string, unknown>;
  const runtimeList = capabilitiesInput.runtimeFamilies;
  const recipeList = capabilitiesInput.recipeRefs;
  const profileList = capabilitiesInput.supportedProfileFamilies;
  if (!Array.isArray(runtimeList) || runtimeList.some((item) => typeof item !== "string" || !runtimeFamilies.includes(item as never))) throw new FabricError("validation_failed", "capabilities.runtimeFamilies is invalid", 400);
  if (!Array.isArray(recipeList) || recipeList.some((item) => typeof item !== "string" || !/^recipe_[A-Za-z0-9][A-Za-z0-9_.-]*@\d+$/.test(item))) throw new FabricError("validation_failed", "capabilities.recipeRefs is invalid", 400);
  if (!Array.isArray(profileList) || profileList.some((item) => typeof item !== "string")) throw new FabricError("validation_failed", "capabilities.supportedProfileFamilies is invalid", 400);
  const capabilities: WorkerCapabilities = {
    runtimeFamilies: runtimeList as WorkerCapabilities["runtimeFamilies"],
    recipeRefs: recipeList as WorkerCapabilities["recipeRefs"],
    browserVersions: typeof capabilitiesInput.browserVersions === "object" && capabilitiesInput.browserVersions !== null ? capabilitiesInput.browserVersions as Record<string, string> : {},
    supportsInteractive: capabilitiesInput.supportsInteractive === true,
    supportsCompanionCompanion: capabilitiesInput.supportsCompanionCompanion === true,
    supportedProfileFamilies: profileList as string[]
  };
  const limitsInput = input.resourceLimits;
  if (limitsInput === null || typeof limitsInput !== "object" || Array.isArray(limitsInput)) throw new FabricError("validation_failed", "resourceLimits must be an object", 400);
  const limits = limitsInput as Record<string, unknown>;
  const resourceLimits: WorkerResourceLimits = {
    maxBrowserLeases: boundedInt(limits.maxBrowserLeases, "resourceLimits.maxBrowserLeases", 1, 3),
    cpuMilli: boundedInt(limits.cpuMilli, "resourceLimits.cpuMilli", 100, 64_000),
    memoryMiB: boundedInt(limits.memoryMiB, "resourceLimits.memoryMiB", 128, 131_072),
    pids: boundedInt(limits.pids, "resourceLimits.pids", 32, 16_384),
    shmMiB: boundedInt(limits.shmMiB, "resourceLimits.shmMiB", 64, 16_384),
    temporaryStorageMiB: boundedInt(limits.temporaryStorageMiB, "resourceLimits.temporaryStorageMiB", 64, 1_048_576)
  };
  const isLocal = input.isLocal === true;
  const capacity = boundedInt(input.capacity, "capacity", 0, isLocal ? 1 : 3);
  if (isLocal && (!capabilities.supportsInteractive || capacity !== 1)) throw new FabricError("validation_failed", "local workers must support interactive mode and have capacity one", 400);
  // A media task is intentionally outside the browser-lease cap, but it is still a bounded
  // worker resource. Normalize the default here rather than letting a later registration/replay
  // invent it, so operator manifests have a stable static identity.
  const mediaCapacity = input.mediaCapacity === undefined
    ? (isLocal ? 0 : 8)
    : boundedInt(input.mediaCapacity, "mediaCapacity", 0, 64);
  const mediaPlaybackEndpoint = input.mediaPlaybackEndpoint === undefined
    ? undefined
    : endpoint(input.mediaPlaybackEndpoint, "mediaPlaybackEndpoint", ["https:", "http:"]);
  if (runtimeList.includes("media-playback" as never) && !mediaPlaybackEndpoint) {
    throw new FabricError("validation_failed", "media-playback workers require mediaPlaybackEndpoint", 400);
  }
  let inputEncryptionPublicKeyPem: string | undefined;
  if (input.inputEncryptionPublicKeyPem !== undefined) {
    if (typeof input.inputEncryptionPublicKeyPem !== "string" || input.inputEncryptionPublicKeyPem.length > 8_192) throw new FabricError("validation_failed", "inputEncryptionPublicKeyPem is invalid", 400);
    try {
      const key = createPublicKey(input.inputEncryptionPublicKeyPem);
      if (key.asymmetricKeyType !== "rsa") throw new Error("worker input key must be RSA");
      inputEncryptionPublicKeyPem = input.inputEncryptionPublicKeyPem;
    } catch {
      throw new FabricError("validation_failed", "inputEncryptionPublicKeyPem must be a valid RSA public key", 400);
    }
  }
  let enrollmentTokenHash: string | undefined;
  if (input.enrollmentTokenHash !== undefined) {
    if (typeof input.enrollmentTokenHash !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(input.enrollmentTokenHash)) throw new FabricError("validation_failed", "enrollmentTokenHash must be a SHA-256 digest", 400);
    enrollmentTokenHash = input.enrollmentTokenHash.toLowerCase();
  }
  const volumeNames = Array.isArray(input.volumeNames) && input.volumeNames.every(isSafeDockerVolumeName)
    ? [...input.volumeNames]
    : undefined;
  if (!volumeNames || new Set(volumeNames).size !== volumeNames.length) throw new FabricError("validation_failed", "volumeNames must be unique safe Docker volume names", 400);
  return {
    id: opaqueWorkerId(input.id),
    certificateFingerprint,
    ...(inputEncryptionPublicKeyPem === undefined ? {} : { inputEncryptionPublicKeyPem }),
    ...(enrollmentTokenHash === undefined ? {} : { enrollmentTokenHash }),
    endpoint: endpoint(input.endpoint, "endpoint", ["https:", "http:"]),
    cdpRelayEndpoint: endpoint(input.cdpRelayEndpoint, "cdpRelayEndpoint", ["wss:", "ws:", "https:", "http:"]),
    ...(mediaPlaybackEndpoint === undefined ? {} : { mediaPlaybackEndpoint }),
    capabilities,
    capacity,
    mediaCapacity,
    health: "healthy",
    isLocal,
    volumeNames,
    resourceLimits
  };
}

export function workerPrincipal(worker: Worker, principalId = `principal_worker_${worker.id}`): Principal {
  return { id: principalId as Principal["id"], displayName: worker.id, projectGrants: [], roles: [], certificateFingerprint: worker.certificateFingerprint, createdAt: new Date().toISOString() };
}
