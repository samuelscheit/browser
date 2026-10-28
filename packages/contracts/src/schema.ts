import { FabricError } from "./errors";
import {
  inputFieldTypes,
  leaseModes,
  runtimeFamilies,
  type BrowserSessionCreateInput,
  type JobCreateInput,
  type LeaseMode,
  type RuntimeFamily
} from "./model";
import type { ArtifactPolicyRef, EgressPolicyRef, ProfileRef, ProjectId, RecipeRef, WorkerId } from "./ids";
import type { Profile } from "./model";

export type JsonObject = Record<string, unknown>;

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FabricError("validation_failed", `${name} must be an object`, 400);
  }
  return value as JsonObject;
}

function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new FabricError("validation_failed", `${name} must be a non-empty string no longer than ${max} characters`, 400);
  }
  return value;
}

function enumValue<T extends readonly string[]>(value: unknown, name: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new FabricError("validation_failed", `${name} must be one of ${values.join(", ")}`, 400);
  }
  return value as T[number];
}

function optionalObject(value: unknown, name: string): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  const candidate = object(value, name);
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(candidate)) {
    if (key.length === 0 || key.length > 128 || !["string", "number", "boolean"].includes(typeof item) && item !== null) {
      throw new FabricError("validation_failed", `${name}.${key} must be a scalar or null`, 400);
    }
    if (typeof item === "string" && item.length > 4096) {
      throw new FabricError("validation_failed", `${name}.${key} is too long`, 400);
    }
    output[key] = item as string | number | boolean | null;
  }
  return output;
}

function id<T extends string>(value: unknown, name: string, prefix: string): T {
  const parsed = string(value, name, 256);
  if (!parsed.startsWith(`${prefix}_`)) {
    throw new FabricError("validation_failed", `${name} must be an opaque ${prefix} identifier`, 400);
  }
  return parsed as T;
}

function positiveInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FabricError("validation_failed", `${name} must be an integer from ${min} to ${max}`, 400);
  }
  return value;
}

/** Docker volume identifiers are data-plane capabilities, never arbitrary mount strings. */
export function isSafeDockerVolumeName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,127}$/.test(value);
}

function secureHttpsUrl(value: unknown, name: string): string {
  const parsed = string(value, name, 2048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new FabricError("validation_failed", `${name} must use HTTPS`, 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new FabricError("validation_failed", `${name} must use credential-free HTTPS`, 400);
  }
  // Callback authorization belongs in an explicit secret reference/header, never in a URL query
  // that would be copied into durable job records, events, and retry payloads.
  for (const key of url.searchParams.keys()) {
    if (/(password|passphrase|secret|token|cookie|credential|authorization|proxy|otp|api[_-]?key|signature|sig|code|state)/i.test(key)) {
      throw new FabricError("secret_rejected", `${name} must not embed credential material in its query string`, 400);
    }
  }
  return parsed;
}

export function parseBrowserSessionCreate(value: unknown): BrowserSessionCreateInput {
  const input = object(value, "request");
  const metadata = optionalObject(input.metadata, "metadata");
  return {
    project: id<ProjectId>(input.project, "project", "project"),
    idempotencyKey: string(input.idempotencyKey, "idempotencyKey", 255),
    runtime: enumValue(input.runtime, "runtime", runtimeFamilies) as RuntimeFamily,
    browserRecipeRef: id<RecipeRef>(input.browserRecipeRef, "browserRecipeRef", "recipe"),
    ...(input.profileRef === undefined ? {} : { profileRef: id<ProfileRef>(input.profileRef, "profileRef", "profile") }),
    leaseMode: enumValue(input.leaseMode, "leaseMode", leaseModes) as LeaseMode,
    egressPolicyRef: id<EgressPolicyRef>(input.egressPolicyRef, "egressPolicyRef", "egress"),
    artifactPolicyRef: id<ArtifactPolicyRef>(input.artifactPolicyRef, "artifactPolicyRef", "artifact-policy"),
    maxExternalConnections: input.maxExternalConnections === undefined
      ? 1
      : input.maxExternalConnections === 1 || input.maxExternalConnections === 2
        ? input.maxExternalConnections
        : (() => { throw new FabricError("validation_failed", "maxExternalConnections must be 1 or 2", 400); })(),
    ...(metadata === undefined ? {} : { metadata }),
    ttlSeconds: input.ttlSeconds === undefined ? 1_800 : positiveInt(input.ttlSeconds, "ttlSeconds", 60, 14_400)
  };
}

export function parseJobCreate(value: unknown): JobCreateInput {
  const input = object(value, "request");
  const operation = object(input.operation, "operation");
  const callbackValue = input.callback;
  let callback: JobCreateInput["callback"];
  if (callbackValue !== undefined) {
    const rawCallback = object(callbackValue, "callback");
    const url = secureHttpsUrl(rawCallback.url, "callback.url");
    callback = {
      url,
      ...(rawCallback.eventSecretRef === undefined ? {} : { eventSecretRef: string(rawCallback.eventSecretRef, "callback.eventSecretRef", 255) })
    };
  }
  const metadata = optionalObject(input.metadata, "metadata");
  return {
    project: id<ProjectId>(input.project, "project", "project"),
    idempotencyKey: string(input.idempotencyKey, "idempotencyKey", 255),
    recipeRef: id<RecipeRef>(input.recipeRef, "recipeRef", "recipe"),
    operation,
    ...(input.profileRef === undefined ? {} : { profileRef: id<ProfileRef>(input.profileRef, "profileRef", "profile") }),
    ...(input.leaseMode === undefined ? {} : { leaseMode: enumValue(input.leaseMode, "leaseMode", leaseModes) as LeaseMode }),
    egressPolicyRef: id<EgressPolicyRef>(input.egressPolicyRef, "egressPolicyRef", "egress"),
    artifactPolicyRef: id<ArtifactPolicyRef>(input.artifactPolicyRef, "artifactPolicyRef", "artifact-policy"),
    ...(callback === undefined ? {} : { callback }),
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: positiveInt(input.ttlSeconds, "ttlSeconds", 60, 14_400) }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

export function parseProfileCreate(value: unknown): Omit<Profile, "createdAt" | "updatedAt"> {
  const input = object(value, "request");
  const grantsValue = input.grants;
  if (!Array.isArray(grantsValue) || grantsValue.some((grant) => typeof grant !== "string")) {
    throw new FabricError("validation_failed", "grants must be an array of project identifiers", 400);
  }
  const profileStatus = input.status === undefined ? "active" : enumValue(input.status, "status", ["active"] as const);
  return {
    ref: id<ProfileRef>(input.ref, "ref", "profile"),
    ownerProject: id<ProjectId>(input.ownerProject, "ownerProject", "project"),
    workerId: id<WorkerId>(input.workerId, "workerId", "worker"),
    volumeName: (() => {
      const volumeName = string(input.volumeName, "volumeName", 128);
      if (!isSafeDockerVolumeName(volumeName)) throw new FabricError("validation_failed", "volumeName is not a safe Docker volume name", 400);
      return volumeName;
    })(),
    profileFamily: string(input.profileFamily, "profileFamily", 128),
    grants: grantsValue.map((grant) => id<ProjectId>(grant, "grants[]", "project")),
    volumeGeneration: input.volumeGeneration === undefined ? 1 : positiveInt(input.volumeGeneration, "volumeGeneration", 1, 1_000_000),
    status: profileStatus
  };
}

export function parseInputFieldType(value: unknown) {
  return enumValue(value, "fieldType", inputFieldTypes);
}
