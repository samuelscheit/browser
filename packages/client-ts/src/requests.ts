import {
  FabricError,
  type ArtifactPolicyRef,
  type BrowserSessionCreateInput,
  type EgressPolicyRef,
  type JobCreateInput,
  type LeaseMode,
  type ProfileRef,
  type ProjectId,
  type RecipeRef,
  type RuntimeFamily,
} from "@browser-fabric/contracts";
import { BrowserFabricClient, type FetchLike } from "./index";

/** The built-in 30-day artifact policy every deployment has. */
export const DEFAULT_ARTIFACT_POLICY_REF = "artifact-policy_standard-30-days@1" as ArtifactPolicyRef;

type Metadata = Record<string, string | number | boolean | null>;

function assertScalarMetadata(metadata: Metadata | undefined): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new FabricError("validation_failed", `metadata key ${key} is invalid`, 400);
    if (typeof value === "string" && value.length > 512) throw new FabricError("validation_failed", `metadata value ${key} is too long`, 400);
  }
}

function assertIdempotencyKey(key: string): void {
  if (!key || key.length > 255) throw new FabricError("validation_failed", "idempotencyKey must be non-empty and at most 255 characters", 400);
}

const secretField = /(password|passphrase|secret|token|cookie|credential|authorization|proxy(?:_?url)?|otp|api[_-]?key)/i;

/** Typed operations are durable; a secret belongs in an ephemeral input request instead. */
export function assertNoDurableSecrets(value: unknown, path = "operation"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoDurableSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (secretField.test(key) && !key.endsWith("Ref")) throw new FabricError("secret_rejected", `${path}.${key} must be supplied through an ephemeral input request`, 400);
    assertNoDurableSecrets(child, `${path}.${key}`);
  }
}

export interface SessionRequestOptions {
  project: ProjectId;
  idempotencyKey: string;
  runtime: RuntimeFamily;
  recipeRef: RecipeRef;
  egressPolicyRef: EgressPolicyRef;
  profileRef?: ProfileRef;
  leaseMode?: LeaseMode;
  artifactPolicyRef?: ArtifactPolicyRef;
  maxExternalConnections?: number;
  ttlSeconds?: number;
  metadata?: Metadata;
}

/** A raw-CDP session request from explicit refs (discover them with `GET /v1/me`). */
export function buildSessionRequest(options: SessionRequestOptions): BrowserSessionCreateInput {
  assertIdempotencyKey(options.idempotencyKey);
  assertScalarMetadata(options.metadata);
  const leaseMode = options.leaseMode ?? "writer";
  return {
    project: options.project,
    idempotencyKey: options.idempotencyKey,
    runtime: options.runtime,
    browserRecipeRef: options.recipeRef,
    ...(options.profileRef === undefined ? {} : { profileRef: options.profileRef }),
    leaseMode,
    egressPolicyRef: options.egressPolicyRef,
    artifactPolicyRef: options.artifactPolicyRef ?? DEFAULT_ARTIFACT_POLICY_REF,
    ...(options.maxExternalConnections === undefined ? {} : { maxExternalConnections: options.maxExternalConnections }),
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
    ttlSeconds: options.ttlSeconds ?? (leaseMode === "interactive" ? 1_800 : 900),
  };
}

export interface JobRequestOptions {
  project: ProjectId;
  idempotencyKey: string;
  recipeRef: RecipeRef;
  operation: Record<string, unknown>;
  egressPolicyRef: EgressPolicyRef;
  profileRef?: ProfileRef;
  leaseMode?: LeaseMode;
  artifactPolicyRef?: ArtifactPolicyRef;
  callback?: JobCreateInput["callback"];
  ttlSeconds?: number;
  metadata?: Metadata;
}

/** A typed-job request from explicit refs; rejects secret-looking operation fields before they leave the process. */
export function buildJobRequest(options: JobRequestOptions): JobCreateInput {
  assertIdempotencyKey(options.idempotencyKey);
  assertNoDurableSecrets(options.operation);
  assertScalarMetadata(options.metadata);
  return {
    project: options.project,
    idempotencyKey: options.idempotencyKey,
    recipeRef: options.recipeRef,
    operation: { ...options.operation },
    ...(options.profileRef === undefined ? {} : { profileRef: options.profileRef }),
    ...(options.leaseMode === undefined ? {} : { leaseMode: options.leaseMode }),
    egressPolicyRef: options.egressPolicyRef,
    artifactPolicyRef: options.artifactPolicyRef ?? DEFAULT_ARTIFACT_POLICY_REF,
    ...(options.callback === undefined ? {} : { callback: options.callback }),
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}

/** Operations of the built-in media recipes (`recipe_media-relay@1`, `recipe_media-playback@1`). */
export const mediaOperations = {
  relay: (manifestRef: string, range?: { start: number; end?: number }): Record<string, unknown> => ({ operation: "relay", manifestRef, ...(range === undefined ? {} : { range: { ...range } }) }),
  playback: (manifestRef: string): Record<string, unknown> => ({ operation: "playback", manifestRef }),
} as const;

/** A client authenticated with FABRIC_API_URL, FABRIC_API_USERNAME (principal ID) and FABRIC_API_PASSWORD. */
export function createFabricClientFromEnvironment(fetchImpl?: FetchLike): BrowserFabricClient {
  const baseUrl = globalThis.process?.env?.FABRIC_API_URL;
  if (!baseUrl) throw new Error("FABRIC_API_URL is required");
  const username = globalThis.process?.env?.FABRIC_API_USERNAME;
  const password = globalThis.process?.env?.FABRIC_API_PASSWORD;
  if (!username || !/^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(username)) throw new Error("FABRIC_API_USERNAME must be an opaque Fabric principal ID");
  if (!password || password.length < 24 || password.length > 4096 || /[\0\r\n]/.test(password)) throw new Error("FABRIC_API_PASSWORD must be a secret of 24 to 4096 characters");
  return new BrowserFabricClient({ baseUrl, fetch: fetchImpl, headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` } });
}
