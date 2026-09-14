/**
 * Privileged, idempotent Browser Fabric bootstrap.
 *
 * This is intentionally an operator CLI instead of a public API route. It creates the initial
 * projects/principals/workers/profiles needed before application mTLS identities can call the
 * control plane. The manifest contains public identities, worker capability declarations, named
 * volume metadata, and *hashes* of enrollment secrets only; it must never contain raw cookies,
 * passwords, proxy URLs with credentials, private keys, or enrollment token bytes.
 */
import { readFile } from "node:fs/promises";
import {
  canonicalJson,
  FabricError,
  parseProfileCreate,
  type Principal,
  type Profile,
  type ProjectId,
  type Worker,
} from "@browser-fabric/contracts";
import { createPostgresScheduler, type BrowserScheduler } from "@browser-fabric/control-plane";
import { parseWorkerRegistration } from "./protocol";

/** The dynamic fields are deliberately omitted from an operator manifest. */
export type ProvisionWorker = Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt">;
export type ProvisionProfile = Omit<Profile, "createdAt" | "updatedAt">;

/**
 * Keep reconciliation independent from PostgreSQL so it can be exercised against the same
 * scheduler contract used by production and by deterministic tests.
 */
export interface ProvisionRuntime {
  scheduler: BrowserScheduler;
}

export interface ProvisionManifest {
  version: 1;
  bootstrapAdminId: Principal["id"];
  projects: readonly { id: ProjectId; name: string }[];
  principals: readonly Principal[];
  workers: readonly ProvisionWorker[];
  profiles: readonly ProvisionProfile[];
}

export interface ProvisionPlan {
  projectsToCreate: readonly ProjectId[];
  principalsToCreate: readonly Principal["id"][];
  workersToCreate: readonly Worker["id"][];
  profilesToCreate: readonly Profile["ref"][];
}

function fail(message: string): never {
  throw new FabricError("validation_failed", message, 400);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(`${name} must be a bounded non-empty string`);
  return value.trim();
}

const rawSecretName = /(password|passphrase|secret(?!.*hash)|token(?!.*hash)|cookie|credential|authorization|proxy(?:_?url)?|otp|api[_-]?key|private[_-]?key)/i;

function assertNoRawSecrets(value: unknown, path = "manifest"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (rawSecretName.test(key) && !/hash$/i.test(key)) fail(`${path}.${key} must not appear in a provisioning manifest`);
    assertNoRawSecrets(child, `${path}.${key}`);
  }
}

function parsePrincipal(value: unknown, projects: ReadonlySet<string>, index: number): Principal {
  const raw = object(value, `principals[${index}]`);
  const id = string(raw.id, `principals[${index}].id`, 128);
  if (!/^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail(`principals[${index}].id is invalid`);
  const displayName = string(raw.displayName, `principals[${index}].displayName`, 255);
  const certificateFingerprint = string(raw.certificateFingerprint, `principals[${index}].certificateFingerprint`, 512);
  if (!Array.isArray(raw.projectGrants) || raw.projectGrants.some((item) => typeof item !== "string" || !projects.has(item))) fail(`principals[${index}].projectGrants must reference declared projects`);
  const allowedRoles = new Set(["project_admin", "project_operator", "project_reader", "fabric_admin"]);
  if (!Array.isArray(raw.roles) || raw.roles.length === 0 || raw.roles.some((item) => typeof item !== "string" || !allowedRoles.has(item))) fail(`principals[${index}].roles is invalid`);
  const createdAt = raw.createdAt === undefined ? new Date().toISOString() : string(raw.createdAt, `principals[${index}].createdAt`, 64);
  return {
    id: id as Principal["id"],
    displayName,
    projectGrants: [...new Set(raw.projectGrants)] as Principal["projectGrants"],
    roles: [...new Set(raw.roles)] as Principal["roles"],
    certificateFingerprint,
    createdAt,
  };
}

/** Parse and reject a manifest before it can be sent to a privileged database connection. */
export function parseProvisionManifest(value: unknown): ProvisionManifest {
  const raw = object(value, "manifest");
  if (raw.version !== 1) fail("manifest.version must be 1");
  assertNoRawSecrets(raw);
  if (!Array.isArray(raw.projects) || raw.projects.length < 1 || raw.projects.length > 128) fail("manifest.projects must contain one to 128 projects");
  const projects = raw.projects.map((entry, index) => {
    const project = object(entry, `projects[${index}]`);
    const id = string(project.id, `projects[${index}].id`, 128);
    const name = string(project.name, `projects[${index}].name`, 255);
    if (!/^project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail(`projects[${index}].id is invalid`);
    return { id: id as ProjectId, name };
  });
  if (new Set(projects.map((project) => project.id)).size !== projects.length) fail("manifest project IDs must be unique");
  const projectIds = new Set(projects.map((project) => String(project.id)));
  if (!Array.isArray(raw.principals) || raw.principals.length < 1 || raw.principals.length > 256) fail("manifest.principals must contain one to 256 principals");
  const principals = raw.principals.map((principal, index) => parsePrincipal(principal, projectIds, index));
  if (new Set(principals.map((principal) => principal.id)).size !== principals.length) fail("manifest principal IDs must be unique");
  if (new Set(principals.map((principal) => principal.certificateFingerprint)).size !== principals.length) fail("manifest principal certificate fingerprints must be unique");
  const bootstrapAdminId = string(raw.bootstrapAdminId, "bootstrapAdminId", 128) as Principal["id"];
  const bootstrapAdmin = principals.find((principal) => principal.id === bootstrapAdminId);
  if (!bootstrapAdmin?.roles.includes("fabric_admin")) fail("bootstrapAdminId must identify a declared fabric_admin principal");
  if (!Array.isArray(raw.workers) || raw.workers.length < 1 || raw.workers.length > 128) fail("manifest.workers must contain one to 128 workers");
  const workers = raw.workers.map((worker, index) => {
    const parsed = object(worker, `workers[${index}]`);
    const fingerprint = string(parsed.certificateFingerprint, `workers[${index}].certificateFingerprint`, 512);
    const registered = parseWorkerRegistration(parsed, fingerprint) as ProvisionWorker;
    // Every worker-manager operation is bound to its mTLS certificate *and* this independent
    // proof. Allowing a bootstrap record without the hash would create a worker that can never
    // authenticate safely (or tempt an operator to weaken the control channel later).
    if (!registered.enrollmentTokenHash) fail(`workers[${index}].enrollmentTokenHash is required`);
    return registered;
  });
  if (new Set(workers.map((worker) => String(worker.id))).size !== workers.length) fail("manifest worker IDs must be unique");
  if (!Array.isArray(raw.profiles) || raw.profiles.length > 512) fail("manifest.profiles must be an array of at most 512 profiles");
  const workersById = new Map(workers.map((worker) => [String(worker.id), worker]));
  const profiles = raw.profiles.map((profile, index) => {
    const parsed = parseProfileCreate(profile);
    if (!projectIds.has(String(parsed.ownerProject)) || parsed.grants.some((grant) => !projectIds.has(String(grant)))) fail(`profiles[${index}] references an undeclared project`);
    const worker = workersById.get(String(parsed.workerId));
    if (!worker) fail(`profiles[${index}] references an undeclared worker`);
    const volumeNames = Array.isArray(worker.volumeNames) ? worker.volumeNames.map(String) : [];
    if (!volumeNames.includes(parsed.volumeName)) fail(`profiles[${index}].volumeName is not declared by its worker`);
    return parsed as ProvisionProfile;
  });
  if (new Set(profiles.map((profile) => String(profile.ref))).size !== profiles.length) fail("manifest profile refs must be unique");
  return { version: 1, bootstrapAdminId, projects, principals, workers, profiles };
}

function staticPrincipalEqual(left: Principal, right: Principal): boolean {
  // createdAt is bookkeeping generated by the parser when an operator omits it. It is not part
  // of the principal's static identity; comparing it would make an otherwise identical manifest
  // non-idempotent on every replay.
  return canonicalJson({
    id: left.id,
    displayName: left.displayName,
    projectGrants: [...left.projectGrants].sort(),
    roles: [...left.roles].sort(),
    certificateFingerprint: left.certificateFingerprint
  }) === canonicalJson({
    id: right.id,
    displayName: right.displayName,
    projectGrants: [...right.projectGrants].sort(),
    roles: [...right.roles].sort(),
    certificateFingerprint: right.certificateFingerprint
  });
}

function staticWorkerIdentity(worker: ProvisionWorker | Worker): Record<string, unknown> {
  const mediaCapacity = worker.mediaCapacity ?? (worker.isLocal ? 0 : 8);
  return {
    id: worker.id,
    certificateFingerprint: worker.certificateFingerprint,
    enrollmentTokenHash: worker.enrollmentTokenHash,
    inputEncryptionPublicKeyPem: worker.inputEncryptionPublicKeyPem,
    endpoint: worker.endpoint,
    cdpRelayEndpoint: worker.cdpRelayEndpoint,
    // A playback-capable worker's private relay address decides where bearer capabilities are
    // forwarded. It is therefore deployment identity, not mutable heartbeat state: silently
    // accepting a changed endpoint could route an active player to the wrong worker.
    mediaPlaybackEndpoint: worker.mediaPlaybackEndpoint,
    capabilities: {
      ...worker.capabilities,
      runtimeFamilies: [...worker.capabilities.runtimeFamilies].sort(),
      recipeRefs: [...worker.capabilities.recipeRefs].sort(),
      supportedProfileFamilies: [...worker.capabilities.supportedProfileFamilies].sort(),
    },
    capacity: worker.capacity,
    mediaCapacity,
    // Health is runtime state reported by the worker heartbeat. It must not turn a safe,
    // unchanged bootstrap replay into a conflict merely because a worker is temporarily
    // degraded/offline; reconciliation never overwrites that state.
    isLocal: worker.isLocal,
    volumeNames: [...worker.volumeNames].sort(),
    resourceLimits: worker.resourceLimits,
  };
}

function staticWorkerEqual(left: Worker, right: ProvisionWorker): boolean {
  return canonicalJson(staticWorkerIdentity(left)) === canonicalJson(staticWorkerIdentity(right));
}

function staticProfileEqual(left: Profile, right: ProvisionProfile): boolean {
  return canonicalJson({
    ref: left.ref,
    ownerProject: left.ownerProject,
    grants: [...left.grants].sort(),
    workerId: left.workerId,
    volumeName: left.volumeName,
    profileFamily: left.profileFamily,
    volumeGeneration: left.volumeGeneration,
    status: left.status,
  }) === canonicalJson({
    ref: right.ref,
    ownerProject: right.ownerProject,
    grants: [...right.grants].sort(),
    workerId: right.workerId,
    volumeName: right.volumeName,
    profileFamily: right.profileFamily,
    volumeGeneration: right.volumeGeneration,
    status: right.status,
  });
}

/** Reconcile a parsed manifest without overwriting an existing principal/worker/profile identity. */
export async function provisionManifest(runtime: ProvisionRuntime, manifest: ProvisionManifest, dryRun = false): Promise<ProvisionPlan> {
  const state = await runtime.scheduler.store.snapshot();
  const projectsToCreate: ProjectId[] = [];
  const principalsToCreate: Principal["id"][] = [];
  const workersToCreate: Worker["id"][] = [];
  const profilesToCreate: Profile["ref"][] = [];
  for (const project of manifest.projects) {
    const existing = state.projects.get(project.id);
    if (!existing) projectsToCreate.push(project.id);
    else if (existing.name !== project.name || !existing.active) throw new FabricError("conflict", `existing project ${project.id} differs from provisioning manifest`, 409);
  }
  for (const principal of manifest.principals) {
    const existing = state.principals.get(principal.id);
    if (!existing) principalsToCreate.push(principal.id);
    else if (!staticPrincipalEqual(existing, principal)) throw new FabricError("conflict", `existing principal ${principal.id} differs from provisioning manifest`, 409);
  }
  const bootstrapAdmin = manifest.principals.find((principal) => principal.id === manifest.bootstrapAdminId)!;
  for (const worker of manifest.workers) {
    const existing = state.workers.get(worker.id);
    if (!existing) workersToCreate.push(worker.id);
    else if (!staticWorkerEqual(existing, worker)) throw new FabricError("conflict", `existing worker ${worker.id} differs from provisioning manifest`, 409);
  }
  for (const profile of manifest.profiles) {
    const existing = state.profiles.get(profile.ref);
    if (!existing) profilesToCreate.push(profile.ref);
    else if (!staticProfileEqual(existing, profile)) throw new FabricError("conflict", `existing profile ${profile.ref} differs from provisioning manifest`, 409);
  }
  const plan: ProvisionPlan = { projectsToCreate, principalsToCreate, workersToCreate, profilesToCreate };
  if (dryRun) return plan;
  // Creation order is important: projects -> principals -> workers -> profiles. Refresh a snapshot
  // between stages because every method intentionally uses a serialized transaction.
  for (const project of manifest.projects) if (projectsToCreate.includes(project.id)) await runtime.scheduler.registerProject(project);
  for (const principal of manifest.principals) if (principalsToCreate.includes(principal.id)) await runtime.scheduler.registerPrincipal(principal);
  for (const worker of manifest.workers) {
    if (workersToCreate.includes(worker.id)) await runtime.scheduler.registerWorker(worker, bootstrapAdmin);
  }
  for (const profile of manifest.profiles) {
    if (profilesToCreate.includes(profile.ref)) await runtime.scheduler.createProfile(profile, bootstrapAdmin);
  }
  return plan;
}

async function loadSecret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) return (await readFile(file, "utf8")).trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const manifestFlag = args.indexOf("--manifest");
  const manifestPath = manifestFlag >= 0 ? args[manifestFlag + 1] : undefined;
  if (!manifestPath || args.some((arg) => arg === "--help" || arg === "-h")) {
    console.error("Usage: bun apps/worker-manager/src/provision-fabric.ts --manifest /absolute/path/provision.json [--dry-run]");
    process.exit(manifestPath ? 0 : 2);
  }
  const manifest = parseProvisionManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const runtime = await createPostgresScheduler({
    databaseUrl: await loadSecret("FABRIC_DB_URL"),
    capabilitySecret: await loadSecret("FABRIC_CAPABILITY_SECRET"),
    gatewayBaseUrl: process.env.FABRIC_GATEWAY_BASE_URL,
    poolSize: Number(process.env.FABRIC_DB_POOL_SIZE ?? 10),
    ssl: process.env.FABRIC_DB_SSL === "1",
  });
  try {
    const plan = await provisionManifest(runtime, manifest, args.includes("--dry-run"));
    // Report only identifiers/counts; do not echo certificate/public-key/enrollment-hash values.
    console.info(JSON.stringify({ event: "fabric.provisioned", dryRun: args.includes("--dry-run"), ...plan }));
  } finally {
    await runtime.close();
  }
}
