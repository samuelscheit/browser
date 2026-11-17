import {
  createId,
  canonicalJson,
  FabricError,
  isMediaRuntime,
  isSafeDockerVolumeName,
  MEDIA_MANIFEST_CONTENT_TYPE,
  parseMediaPlaybackOperation,
  parseMediaRelayOperation,
  type Artifact,
  type ArtifactPolicy,
  type AttemptId,
  type AuditEvent,
  type BrowserLease,
  type BrowserRecipe,
  type BrowserSession,
  type BrowserSessionCreateInput,
  type BrowserSessionId,
  type BrowserSessionResponse,
  type EgressPolicy,
  type EphemeralInputRequest,
  type FabricEvent,
  type InputFieldType,
  type Job,
  type JobCreateInput,
  type JobId,
  type JobResponse,
  type JobStatus,
  type LeaseMode,
  type Principal,
  type PrincipalCapabilities,
  DEFAULT_ACTIVE_BROWSER_LEASES,
  MAX_ACTIVE_BROWSER_LEASES,
  type Profile,
  type ProfileClone,
  type ProjectId,
  type RuntimeFamily,
  type Worker,
  type WorkerAssignment,
  terminalBrowserSessionStatuses,
  terminalJobStatuses,
  runtimeFamilies,
  MAX_WORKER_BROWSER_LEASES
} from "@browser-fabric/contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import { assertRuntimePolicyCompatibility, builtInChallengeSets, builtInEgressPolicies } from "@browser-fabric/policy";
import { builtInRecipes, RecipeRegistry, type RecipeDefinition, validateTypedOperation } from "@browser-fabric/recipes";
import { emptyFabricCatalog, type FabricCatalog } from "./catalog";
import { CapabilitySigner } from "./capability";
import { type Clock, SystemClock } from "./clock";
import { EncryptedInputRouter, type EphemeralInputEnvelope, type EphemeralInputVault } from "./ephemeral";
import { assertDurablePayload, safeFailureReason, scalarMetadata } from "./security";
import { type FabricState, type FabricStore, InMemoryFabricStore, idempotencyKey } from "./store";
import { SchedulerKernel } from "./scheduler-kernel";
import { recoverSchedulerState } from "./scheduler-recovery";
import { events, getJob, getSession, watchEvents } from "./scheduler-events";
import { getProfile as adminGetProfile, listProfiles as adminListProfiles, listWorkers as adminListWorkers, getWorker as adminGetWorker, setWorkerHealth as adminSetWorkerHealth, revokeProfile as adminRevokeProfile } from "./scheduler-admin";

export interface BrowserSchedulerOptions {
  store?: FabricStore;
  clock?: Clock;
  capabilitySigner?: CapabilitySigner;
  /** The deployment's catalog (FABRIC_CATALOG_FILE): recipes, egress policies, challenge sets and projects added to the built-ins. */
  catalog?: FabricCatalog;
  maxActiveBrowserLeases?: number;
  reconnectGraceSeconds?: number;
  assignmentClaimTimeoutSeconds?: number;
  /** Production should inject a worker-local/E2E encrypted channel; memory is for local tests. */
  ephemeralInputVault?: EphemeralInputVault;
  /** Plaintext convenience endpoint is disabled for production stores by default. */
  allowPlaintextEphemeralInputs?: boolean;
}

/**
 * The reviewed managed-worker change: browser capacity and limits, and which recipes and profile
 * families it serves (so a catalog recipe can be enabled on an existing worker). Identity,
 * endpoints, runtimes, interactivity and volumes stay immutable.
 */
export interface ManagedWorkerReconfiguration {
  capacity: number;
  resourceLimits: Worker["resourceLimits"];
  recipeRefs: Worker["capabilities"]["recipeRefs"];
  supportedProfileFamilies: Worker["capabilities"]["supportedProfileFamilies"];
}

export interface ArtifactInput {
  /** Required only for a project-scoped media_manifest, which exists before a consuming job. */
  project?: ProjectId;
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  profileRef?: Profile["ref"];
  kind: Artifact["kind"];
  /** Required only for a project-scoped media_manifest; owner-scoped artifacts derive it. */
  artifactPolicyRef?: ArtifactPolicy["ref"];
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  /** Restricts a media result finalization to one currently active media assignment. */
  expectedWorkerId?: Worker["id"];
  /** Restricts a media result finalization to its exact active media attempt. */
  expectedMediaAttemptId?: AttemptId;
  /** Stable, bounded expiry reserved by the worker manager before an immutable result upload. */
  expiresAt?: string;
}

/** Non-secret ownership metadata used before an application can upload artifact bytes. */
export interface ArtifactOwnerContext {
  project: ProjectId;
  artifactPolicyRef: ArtifactPolicy["ref"];
  profileRef?: Profile["ref"];
  sessionId?: BrowserSessionId;
  jobId?: JobId;
}

/** Project-scoped artifact context used only for an immutable media manifest before a media job exists. */
export interface ProjectArtifactContext {
  project: ProjectId;
  artifactPolicyRef: ArtifactPolicy["ref"];
}

export interface InputRequestResponse {
  request: EphemeralInputRequest;
  /** Never expose the supplied value in the control plane response. */
}

/** Internal worker-manager handoff: the manifest reference remains durable; source bytes do not. */
export interface MediaPlaybackSourceRequestResponse {
  request: EphemeralInputRequest;
  job: Job;
}

/** Capability-gateway lookup result. It contains no provider URL or encrypted source data. */
export interface ActiveMediaPlaybackBinding {
  job: Job;
  worker: Worker;
  attemptId: AttemptId;
}

const isTerminalSession = (status: BrowserSession["status"]): boolean => terminalBrowserSessionStatuses.includes(status as never);
const isTerminalJob = (status: JobStatus): boolean => terminalJobStatuses.includes(status as never);
const asDate = (iso: string) => new Date(iso).getTime();
const now = (clock: Clock) => clock.now().toISOString();
const after = (clock: Clock, seconds: number) => new Date(clock.now().getTime() + seconds * 1_000).toISOString();
const defaultArtifactRef = "artifact-policy_standard-30-days@1" as ArtifactPolicy["ref"];

/** Resolve the active worker for either an ordinary lease-scoped input or a media-attempt source. */
function inputRequestWorker(kernel: SchedulerKernel, state: FabricState, request: EphemeralInputRequest): Worker["id"] {
  if (request.leaseId !== undefined) return kernel.lease(state, request.leaseId).workerId;
  if (request.jobId !== undefined && request.mediaAttemptId !== undefined) {
    const job = kernel.job(state, request.jobId);
    if (
      job.runtime !== "media-playback" ||
      job.mediaAttemptId !== request.mediaAttemptId ||
      !job.workerId ||
      (job.status !== "running" && job.status !== "awaiting_input")
    ) {
      throw new FabricError("invalid_state", "media playback source request is no longer active", 409);
    }
    return job.workerId;
  }
  throw new FabricError("invalid_state", "input request has no active assignment", 409);
}

function requestFingerprint(scope: string, payload: unknown): string {
  return `${scope}:sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

const safeArtifactObjectKey = /^[a-z0-9][a-z0-9/_\-.]{0,511}$/;
// Artifact expiry is selected by the object-store write that may be performed by a sibling
// control-plane replica. Accept a small, bounded clock skew while still preventing a caller from
// stretching the immutable 30-day policy into an arbitrary retention period.
const ARTIFACT_EXPIRY_CLOCK_SKEW_MS = 5 * 60_000;

function assertSafeCallback(callback: JobCreateInput["callback"]): void {
  if (callback === undefined) return;
  if (!callback || typeof callback.url !== "string") throw new FabricError("validation_failed", "callback must contain a URL", 400);
  let url: URL;
  try {
    url = new URL(callback.url);
  } catch {
    throw new FabricError("validation_failed", "callback.url must use credential-free HTTPS", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new FabricError("validation_failed", "callback.url must use credential-free HTTPS", 400);
  // `assertDurablePayload` also rejects signed/token query values. Keep this call at the direct
  // scheduler boundary so an internal caller cannot evade the HTTP schema parser.
  assertDurablePayload(callback, "callback");
}

export function workerEnrollmentTokenHash(token: string): string {
  if (!token || Buffer.byteLength(token, "utf8") < 24 || Buffer.byteLength(token, "utf8") > 16_384) throw new FabricError("validation_failed", "worker enrollment token is outside safe bounds", 400);
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function matchesEnrollmentToken(hash: string | undefined, token: string): boolean {
  if (!hash || !/^sha256:[a-f0-9]{64}$/i.test(hash)) return false;
  let computed: string;
  try { computed = workerEnrollmentTokenHash(token); } catch { return false; }
  const expected = Buffer.from(hash.slice(7), "hex");
  const received = Buffer.from(computed.slice(7), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
/**
 * Worker registrations cross a PostgreSQL JSONB boundary. JSONB preserves values but not object
 * insertion order, so JSON.stringify would reject an otherwise identical worker every time a
 * nested capability or resource-limits object is rehydrated in a different key order.
 */
function matchesProvisionedWorkerRegistration(
  existing: Worker,
  worker: Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt" | "enrollmentTokenHash">,
): boolean {
  return canonicalJson({
    capabilities: existing.capabilities,
    capacity: existing.capacity,
    mediaCapacity: existing.mediaCapacity,
    isLocal: existing.isLocal,
    resourceLimits: existing.resourceLimits,
    volumeNames: existing.volumeNames,
    endpoint: existing.endpoint,
    cdpRelayEndpoint: existing.cdpRelayEndpoint,
    mediaPlaybackEndpoint: existing.mediaPlaybackEndpoint,
  }) === canonicalJson({
    capabilities: worker.capabilities,
    capacity: worker.capacity,
    mediaCapacity: worker.mediaCapacity,
    isLocal: worker.isLocal,
    resourceLimits: worker.resourceLimits,
    volumeNames: worker.volumeNames,
    endpoint: worker.endpoint,
    cdpRelayEndpoint: worker.cdpRelayEndpoint,
    mediaPlaybackEndpoint: worker.mediaPlaybackEndpoint,
  });
}

function sessionResponse(session: BrowserSession): BrowserSessionResponse {
  return {
    id: session.id,
    status: session.status,
    ...(session.cdpEndpoint === undefined ? {} : { cdpEndpoint: session.cdpEndpoint }),
    expiresAt: session.expiresAt,
    ...(session.workerId === undefined ? {} : { workerId: session.workerId }),
    ...(session.leaseId === undefined
      ? {}
      : {
          profileLease: {
            id: session.leaseId,
            mode: session.leaseMode,
            ...(session.profileRef === undefined ? {} : { profileRef: session.profileRef })
          }
        }),
    ...(session.failureReason === undefined ? {} : { failureReason: session.failureReason })
  };
}

function jobResponse(job: Job): JobResponse {
  return {
    id: job.id,
    status: job.status,
    expiresAt: job.expiresAt,
    ...(job.workerId === undefined ? {} : { workerId: job.workerId }),
    ...(job.result === undefined ? {} : { result: structuredClone(job.result) }),
    ...(job.failureReason === undefined ? {} : { failureReason: job.failureReason })
  };
}

export class BrowserScheduler {
  readonly #store: FabricStore;
  readonly #clock: Clock;
  readonly #capabilitySigner: CapabilitySigner;
  readonly #recipes: RecipeRegistry;
  readonly #catalog: FabricCatalog;
  readonly #maxActiveBrowserLeases: number;
  readonly #reconnectGraceSeconds: number;
  readonly #assignmentClaimTimeoutSeconds: number;
  /** Ephemeral values live only in process memory and never enter FabricState. */
  readonly #ephemeralInputVault: EphemeralInputVault;
  readonly #allowPlaintextEphemeralInputs: boolean;
  readonly #kernel: SchedulerKernel;

  public constructor(options: BrowserSchedulerOptions = {}) {
    this.#store = options.store ?? new InMemoryFabricStore();
    this.#clock = options.clock ?? new SystemClock();
    this.#capabilitySigner = options.capabilitySigner ?? new CapabilitySigner({ secret: "development-only-capability-secret-change-me", clock: this.#clock });
    this.#catalog = options.catalog ?? emptyFabricCatalog;
    this.#recipes = new RecipeRegistry([...builtInRecipes, ...this.#catalog.recipes]);
    this.#maxActiveBrowserLeases = options.maxActiveBrowserLeases ?? DEFAULT_ACTIVE_BROWSER_LEASES;
    this.#reconnectGraceSeconds = options.reconnectGraceSeconds ?? 60;
    this.#assignmentClaimTimeoutSeconds = options.assignmentClaimTimeoutSeconds ?? 30;
    this.#ephemeralInputVault = options.ephemeralInputVault ?? new EncryptedInputRouter();
    this.#allowPlaintextEphemeralInputs = options.allowPlaintextEphemeralInputs ?? false;
    if (!Number.isInteger(this.#maxActiveBrowserLeases) || this.#maxActiveBrowserLeases < 1 || this.#maxActiveBrowserLeases > MAX_ACTIVE_BROWSER_LEASES) {
      throw new Error(`Browser Fabric global browser capacity must be an integer from 1 to ${MAX_ACTIVE_BROWSER_LEASES}`);
    }
    if (!Number.isInteger(this.#assignmentClaimTimeoutSeconds) || this.#assignmentClaimTimeoutSeconds < 5 || this.#assignmentClaimTimeoutSeconds > 300) throw new Error("assignment claim timeout must be between 5 and 300 seconds");
    this.#kernel = new SchedulerKernel({
      clock: this.#clock,
      capabilitySigner: this.#capabilitySigner,
      recipes: this.#recipes,
      maxActiveBrowserLeases: this.#maxActiveBrowserLeases,
      reconnectGraceSeconds: this.#reconnectGraceSeconds,
      assignmentClaimTimeoutSeconds: this.#assignmentClaimTimeoutSeconds,
      ephemeralInputVault: this.#ephemeralInputVault
    });
  }

  public get store(): FabricStore {
    return this.#store;
  }

  /** Shared authoritative clock for artifact retention and media capability boundaries. */
  public now(): Date {
    return new Date(this.#clock.now().getTime());
  }

  /** Exposes only the vault interface; implementations must keep values/envelopes worker-local. */
  public get ephemeralInputVault(): EphemeralInputVault {
    return this.#ephemeralInputVault;
  }

  public async bootstrap(input: { projects?: readonly { id: ProjectId; name: string }[]; principals?: readonly Principal[] } = {}): Promise<void> {
    await this.#store.transact((state) => {
      for (const policy of [...builtInEgressPolicies, ...this.#catalog.egressPolicies]) state.egressPolicies.set(policy.ref, structuredClone(policy));
      for (const recipe of this.#recipes.list()) state.recipes.set(recipe.ref, structuredClone(recipe));
      for (const challengeSet of [...builtInChallengeSets, ...this.#catalog.challengeSets]) state.challengeSets.set(challengeSet.ref, structuredClone(challengeSet));
      for (const recipe of state.recipes.values()) {
        if (recipe.challengeHandlerSetRef && !state.challengeSets.has(recipe.challengeHandlerSetRef)) {
          throw new Error(`recipe ${recipe.ref} references a missing challenge handler set ${recipe.challengeHandlerSetRef}`);
        }
      }
      state.artifactPolicies.set(defaultArtifactRef, this.#recipes.getArtifactPolicy(defaultArtifactRef));
      // Catalog projects are created once; a restart never rewrites an existing project.
      for (const project of this.#catalog.projects) {
        if (!state.projects.has(project.id)) state.projects.set(project.id, { id: project.id, name: project.name, active: true, createdAt: now(this.#clock) });
      }
      for (const project of input.projects ?? []) {
        if (!/^project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project.id) || typeof project.name !== "string" || project.name.length < 1 || project.name.length > 255) throw new FabricError("validation_failed", "project identity is invalid", 400);
        state.projects.set(project.id, { id: project.id, name: project.name, active: true, createdAt: now(this.#clock) });
      }
      for (const principal of input.principals ?? []) {
        if (!/^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(principal.id) || !principal.certificateFingerprint || principal.roles.length === 0) throw new FabricError("validation_failed", "principal identity is invalid", 400);
        for (const project of principal.projectGrants) this.#kernel.project(state, project);
        state.principals.set(principal.id, structuredClone(principal));
      }
    });
  }

  public async registerProject(project: { id: ProjectId; name: string }): Promise<void> {
    await this.#store.transact((state) => {
      if (!/^project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project.id) || typeof project.name !== "string" || project.name.length < 1 || project.name.length > 255) throw new FabricError("validation_failed", "project identity is invalid", 400);
      if (state.projects.has(project.id)) throw new FabricError("conflict", `project ${project.id} already exists`, 409);
      state.projects.set(project.id, { ...project, active: true, createdAt: now(this.#clock) });
    });
  }

  public async registerPrincipal(principal: Principal): Promise<void> {
    await this.#store.transact((state) => {
      if (!principal.id || !principal.certificateFingerprint || principal.certificateFingerprint.length > 512) throw new FabricError("validation_failed", "principal identity is invalid", 400);
      if (principal.roles.length === 0) throw new FabricError("validation_failed", "principal must have at least one role", 400);
      if (!/^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(principal.id)) throw new FabricError("validation_failed", "principal ID is invalid", 400);
      const certificateOwner = [...state.principals.values()].find((candidate) => candidate.id !== principal.id && candidate.certificateFingerprint === principal.certificateFingerprint);
      if (certificateOwner) throw new FabricError("conflict", `principal certificate is already bound to ${certificateOwner.id}`, 409);
      for (const project of principal.projectGrants) this.#kernel.project(state, project);
      state.principals.set(principal.id, structuredClone(principal));
    });
  }

  public async getProfile(profileRef: Profile["ref"], actor?: Principal): Promise<Profile> {
    return adminGetProfile({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, profileRef, actor);
  }

  public async listProfiles(project: ProjectId, actor?: Principal): Promise<Profile[]> {
    return adminListProfiles({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, project, actor);
  }

  /** What `actor` may use: its projects, their profiles, served recipes and policy refs. */
  public async describePrincipal(actor: Principal): Promise<PrincipalCapabilities> {
    const state = await this.#store.snapshot();
    const principal = this.#kernel.authorizeIdentity(state, actor, "describe_principal", actor.id) ?? actor;
    const admin = principal.roles.includes("fabric_admin");
    const projects = [...state.projects.values()].filter((project) => project.active && (admin || principal.projectGrants.includes(project.id)));
    const projectIds = new Set<string>(projects.map((project) => project.id));
    const served = new Set<string>([...state.workers.values()].flatMap((worker) => worker.capabilities.recipeRefs));
    const byRef = <T extends { ref: string }>(left: T, right: T) => left.ref.localeCompare(right.ref);
    return {
      principal: principal.id,
      roles: [...principal.roles],
      projects: projects.map((project) => ({ id: project.id, name: project.name })).sort((left, right) => left.id.localeCompare(right.id)),
      profiles: [...state.profiles.values()]
        .filter((profile) => profile.status !== "revoked" && (projectIds.has(profile.ownerProject) || profile.grants.some((grant) => projectIds.has(grant))))
        .map((profile) => ({ ref: profile.ref, ownerProject: profile.ownerProject, grants: [...profile.grants], profileFamily: profile.profileFamily, status: profile.status }))
        .sort(byRef),
      recipes: [...state.recipes.values()]
        .filter((recipe) => served.has(recipe.ref))
        .map((recipe) => ({ ref: recipe.ref, runtime: recipe.runtime, mode: recipe.mode, access: (recipe as RecipeDefinition).access, profileFamily: recipe.profileFamily }))
        .sort(byRef),
      egressPolicies: [...state.egressPolicies.keys()].sort() as PrincipalCapabilities["egressPolicies"],
      artifactPolicies: [...state.artifactPolicies.keys()].sort() as PrincipalCapabilities["artifactPolicies"],
    };
  }

  public async listWorkers(actor?: Principal): Promise<Worker[]> {
    return adminListWorkers({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, actor);
  }

  public async getWorker(workerId: Worker["id"], actor?: Principal): Promise<Worker> {
    return adminGetWorker({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, workerId, actor);
  }

  public async setWorkerHealth(workerId: Worker["id"], health: Worker["health"], actor?: Principal): Promise<Worker> {
    return adminSetWorkerHealth({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, workerId, health, actor);
  }

  public async revokeProfile(profileRef: Profile["ref"], actor?: Principal): Promise<Profile> {
    return adminRevokeProfile({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, profileRef, actor);
  }

  /**
   * Resolve one immutable artifact through the project authorization boundary.
   *
   * Fabric-owned services must never accept an artifact id and then read an
   * arbitrary object-store key.  They first obtain this project-scoped record and
   * then use ArtifactCollector.read(), which verifies the object bytes against the
   * durable digest/size/MIME metadata.
   */
  public async getArtifact(artifactId: Artifact["id"], project: ProjectId, actor?: Principal): Promise<Artifact> {
    return this.#store.read((state) => {
      const artifact = state.artifacts.get(artifactId);
      if (!artifact) throw new FabricError("not_found", `artifact ${artifactId} was not found`, 404);
      if (artifact.project !== project) throw new FabricError("authorization_denied", "artifact belongs to another project", 403);
      this.#kernel.authorizeProject(state, actor, project, "read_artifact", artifactId);
      if (asDate(artifact.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("not_found", "artifact has expired", 404);
      return structuredClone(artifact);
    });
  }

  /**
   * Resolve a session/job owner before accepting externally supplied artifact bytes. The caller
   * must hold the same project permission that would be required for the final attachment.
   */
  public async resolveArtifactOwner(input: { sessionId?: BrowserSessionId; jobId?: JobId }, actor?: Principal): Promise<ArtifactOwnerContext> {
    if ((input.sessionId === undefined) === (input.jobId === undefined)) {
      throw new FabricError("validation_failed", "artifact upload requires exactly one session or job owner", 400);
    }
    return this.#store.read((state) => {
      if (input.sessionId !== undefined) {
        const session = this.#kernel.session(state, input.sessionId);
        this.#kernel.authorizeProject(state, actor, session.project, "create_artifact", session.id);
        return {
          project: session.project,
          artifactPolicyRef: session.artifactPolicyRef,
          ...(session.profileRef === undefined ? {} : { profileRef: session.profileRef }),
          sessionId: session.id,
        };
      }
      const job = this.#kernel.job(state, input.jobId!);
      this.#kernel.authorizeProject(state, actor, job.project, "create_artifact", job.id);
      return {
        project: job.project,
        artifactPolicyRef: job.artifactPolicyRef,
        ...(job.profileRef === undefined ? {} : { profileRef: job.profileRef }),
        jobId: job.id,
      };
    });
  }

  /**
   * A media manifest is the one intentionally project-scoped artifact: it is created before the
   * media-only job that consumes it. It remains subject to the same project authorization and
   * artifact-policy lookup as browser/job outputs.
   */
  public async resolveProjectArtifact(project: ProjectId, artifactPolicyRef: ArtifactPolicy["ref"], actor?: Principal): Promise<ProjectArtifactContext> {
    return this.#store.read((state) => {
      this.#kernel.authorizeProject(state, actor, project, "create_media_manifest", artifactPolicyRef);
      this.#kernel.artifactPolicy(state, artifactPolicyRef);
      return { project, artifactPolicyRef };
    });
  }

  /** List a job's immutable artifacts after checking the owning project grant. */
  public async listArtifactsForJob(jobId: JobId, actor?: Principal): Promise<Artifact[]> {
    return this.#store.read((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeProject(state, actor, job.project, "read_artifacts", jobId);
      return [...state.artifacts.values()]
        .filter((artifact) => artifact.jobId === jobId)
        .filter((artifact) => asDate(artifact.expiresAt) > this.#clock.now().getTime())
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((artifact) => structuredClone(artifact));
    });
  }

  /** List a browser session's immutable artifacts after checking the owning project grant. */
  public async listArtifactsForSession(sessionId: BrowserSessionId, actor?: Principal): Promise<Artifact[]> {
    return this.#store.read((state) => {
      const session = this.#kernel.session(state, sessionId);
      this.#kernel.authorizeProject(state, actor, session.project, "read_artifacts", sessionId);
      return [...state.artifacts.values()]
        .filter((artifact) => artifact.sessionId === sessionId)
        .filter((artifact) => asDate(artifact.expiresAt) > this.#clock.now().getTime())
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((artifact) => structuredClone(artifact));
    });
  }

  /** Return an immutable artifact policy for trusted Fabric services. */
  public async getArtifactPolicy(policyRef: ArtifactPolicy["ref"], actor?: Principal): Promise<ArtifactPolicy> {
    return this.#store.read((state) => {
      this.#kernel.authorizeFabricAdmin(state, actor, "read_artifact_policy", policyRef);
      return structuredClone(this.#kernel.artifactPolicy(state, policyRef));
    });
  }

  public async registerWorker(worker: Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt"> & Partial<Pick<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt">>, actor?: Principal): Promise<Worker> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeFabricAdmin(state, actor, "register_worker", worker.id);
      if (!/^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(worker.id) || !worker.certificateFingerprint || worker.certificateFingerprint.length > 512) throw new FabricError("validation_failed", "worker identity is invalid", 400);
      for (const family of worker.capabilities.runtimeFamilies) if (!(runtimeFamilies as readonly string[]).includes(family)) throw new FabricError("validation_failed", "worker runtime capability is invalid", 400);
      if (worker.capabilities.runtimeFamilies.includes("media-playback") && !worker.mediaPlaybackEndpoint) {
        throw new FabricError("validation_failed", "media-playback worker requires a private mediaPlaybackEndpoint", 400);
      }
      if (!worker.volumeNames.every(isSafeDockerVolumeName) || new Set(worker.volumeNames).size !== worker.volumeNames.length) throw new FabricError("validation_failed", "worker volumes must be unique safe Docker volume names", 400);
      if (!Number.isInteger(worker.capacity) || worker.capacity < 0 || worker.capacity > MAX_WORKER_BROWSER_LEASES) throw new FabricError("validation_failed", `worker capacity must be from 0 to ${MAX_WORKER_BROWSER_LEASES}`, 400);
      if (worker.isLocal && worker.capacity !== 1) throw new FabricError("validation_failed", "the federated local worker must have exactly one interactive lease capacity", 400);
      if (worker.capacity > worker.resourceLimits.maxBrowserLeases) throw new FabricError("validation_failed", "worker capacity exceeds its declared browser resource limit", 400);
      if (worker.mediaCapacity !== undefined && (!Number.isInteger(worker.mediaCapacity) || worker.mediaCapacity < 0 || worker.mediaCapacity > 64)) throw new FabricError("validation_failed", "worker media capacity is outside safe bounds", 400);
      const timestamp = now(this.#clock);
      const previous = state.workers.get(worker.id);
      if (previous && previous.certificateFingerprint !== worker.certificateFingerprint) {
        throw new FabricError("authorization_denied", "worker ID is already bound to a different certificate", 403);
      }
      const certificateOwner = [...state.workers.values()].find((candidate) => candidate.id !== worker.id && candidate.certificateFingerprint === worker.certificateFingerprint);
      if (certificateOwner) throw new FabricError("conflict", `worker certificate is already bound to ${certificateOwner.id}`, 409);
      if (previous && worker.capacity < previous.activeLeases) throw new FabricError("conflict", "worker re-registration cannot reduce capacity below active leases", 409);
      const entity: Worker = {
        ...worker,
        // Re-registration must not reset counters while leases are active; doing so would
        // silently exceed the global cap after a worker reconnects.
        activeLeases: previous?.activeLeases ?? 0,
        mediaCapacity: worker.mediaCapacity ?? previous?.mediaCapacity ?? (worker.isLocal ? 0 : 8),
        activeMediaTasks: previous?.activeMediaTasks ?? 0,
        lastHeartbeatAt: timestamp,
        createdAt: previous?.createdAt ?? worker.createdAt ?? timestamp,
        updatedAt: timestamp
      };
      state.workers.set(entity.id, structuredClone(entity));
      this.#kernel.event(state, undefined, { kind: "worker", id: entity.id }, previous ? "worker.reregistered" : "worker.registered", { health: entity.health, capacity: entity.capacity });
      return structuredClone(entity);
    });
  }

  /**
   * Resize an idle managed worker: how many browsers it hosts and the limits each one gets. A
   * running browser keeps the limits it started with, so the worker must be idle; identity,
   * endpoints, recipes, profile families and volumes stay immutable.
   */
  public async reconfigureManagedWorker(workerId: Worker["id"], change: ManagedWorkerReconfiguration, actor?: Principal): Promise<Worker> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeFabricAdmin(state, actor, "reconfigure_managed_worker", workerId);
      const worker = this.#kernel.worker(state, workerId);
      if (worker.isLocal) throw new FabricError("validation_failed", "the federated local worker hosts exactly one browser", 400);
      const { capacity, resourceLimits, recipeRefs, supportedProfileFamilies } = change;
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_WORKER_BROWSER_LEASES || capacity > resourceLimits.maxBrowserLeases) {
        throw new FabricError("validation_failed", `worker capacity must be 0 to ${MAX_WORKER_BROWSER_LEASES} and within its browser resource limit`, 400);
      }
      if (recipeRefs.some((ref) => !/^recipe_[A-Za-z0-9][A-Za-z0-9_.-]*@\d+$/.test(ref)) || new Set(recipeRefs).size !== recipeRefs.length) {
        throw new FabricError("validation_failed", "worker recipe refs must be unique recipe references", 400);
      }
      if (supportedProfileFamilies.some((family) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(family)) || new Set(supportedProfileFamilies).size !== supportedProfileFamilies.length) {
        throw new FabricError("validation_failed", "worker profile families must be unique names", 400);
      }
      const current = { capacity: worker.capacity, resourceLimits: worker.resourceLimits, recipeRefs: [...worker.capabilities.recipeRefs].sort(), supportedProfileFamilies: [...worker.capabilities.supportedProfileFamilies].sort() };
      const desired = { capacity, resourceLimits, recipeRefs: [...recipeRefs].sort(), supportedProfileFamilies: [...supportedProfileFamilies].sort() };
      if (canonicalJson(current) === canonicalJson(desired)) return structuredClone(worker);
      if ([...state.leases.values()].some((lease) => lease.workerId === worker.id && lease.status === "active")) {
        throw new FabricError("conflict", "cannot reconfigure a worker while it has an active lease", 409);
      }
      worker.capacity = capacity;
      worker.resourceLimits = structuredClone(resourceLimits);
      worker.capabilities = { ...worker.capabilities, recipeRefs: [...recipeRefs], supportedProfileFamilies: [...supportedProfileFamilies] };
      worker.updatedAt = now(this.#clock);
      state.workers.set(worker.id, worker);
      const details = {
        previousCapacity: current.capacity,
        capacity,
        previousMaxBrowserLeases: current.resourceLimits.maxBrowserLeases,
        maxBrowserLeases: resourceLimits.maxBrowserLeases,
        recipes: recipeRefs.length,
        profileFamilies: supportedProfileFamilies.length,
      };
      this.#kernel.event(state, undefined, { kind: "worker", id: worker.id }, "worker.reconfigured", details);
      this.#kernel.audit(state, actor, undefined, "worker.reconfigured", { kind: "worker", id: worker.id }, "succeeded", details);
      return structuredClone(worker);
    });
  }

  /**
   * Worker-side registration refresh. The worker must already be provisioned by a Fabric admin
   * and prove possession of its per-worker enrollment token on every control-channel request.
   */
  public async refreshWorkerRegistration(worker: Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt" | "enrollmentTokenHash">, certificateFingerprint: string, enrollmentToken: string): Promise<Worker> {
    return this.#store.transact((state) => {
      const existing = this.#kernel.worker(state, worker.id);
      if (existing.certificateFingerprint !== certificateFingerprint || worker.certificateFingerprint !== certificateFingerprint) throw new FabricError("authorization_denied", "worker certificate does not match its provisioned identity", 403);
      if (!matchesEnrollmentToken(existing.enrollmentTokenHash, enrollmentToken)) throw new FabricError("authentication_required", "worker enrollment token is invalid", 401);
      // A worker cannot use refresh to expand its powers or relocate persistent profile volumes.
      if (!matchesProvisionedWorkerRegistration(existing, worker)) {
        throw new FabricError("authorization_denied", "worker registration differs from its admin-provisioned configuration", 403);
      }
      if (worker.inputEncryptionPublicKeyPem && existing.inputEncryptionPublicKeyPem && worker.inputEncryptionPublicKeyPem !== existing.inputEncryptionPublicKeyPem) throw new FabricError("authorization_denied", "worker input encryption key differs from the provisioned key", 403);
      existing.health = "healthy";
      existing.lastHeartbeatAt = now(this.#clock);
      existing.updatedAt = existing.lastHeartbeatAt;
      state.workers.set(existing.id, existing);
      this.#kernel.event(state, undefined, { kind: "worker", id: existing.id }, "worker.reregistered", { health: existing.health, capacity: existing.capacity });
      return structuredClone(existing);
    });
  }

  /**
   * Authenticate every worker-manager control request, not only registration. Bun's server-side
   * request abstraction does not expose a peer-certificate fingerprint, so the worker-specific
   * enrollment secret binds a claimed worker ID to the already-provisioned worker record. This
   * prevents one valid worker certificate from impersonating another merely by forging the
   * convenience fingerprint header on the private mTLS connection.
   */
  public async authenticateWorkerControlChannel(workerId: Worker["id"], certificateFingerprint: string, enrollmentToken: string): Promise<Worker> {
    return this.#store.read((state) => {
      const worker = this.#kernel.worker(state, workerId);
      if (worker.certificateFingerprint !== certificateFingerprint) throw new FabricError("authorization_denied", "worker certificate does not match its provisioned identity", 403);
      if (!matchesEnrollmentToken(worker.enrollmentTokenHash, enrollmentToken)) throw new FabricError("authentication_required", "worker enrollment token is invalid", 401);
      return structuredClone(worker);
    });
  }

  public async heartbeatWorker(workerId: Worker["id"], actor?: Principal, resource?: Partial<Pick<Worker, "capacity" | "health" | "mediaCapacity">>): Promise<Worker> {
    return this.#store.transact((state) => {
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "heartbeat_worker");
      if (resource?.capacity !== undefined) {
        if (resource.capacity < worker.activeLeases || resource.capacity > (worker.isLocal ? 1 : MAX_WORKER_BROWSER_LEASES)) {
          throw new FabricError("validation_failed", "worker capacity is outside permitted bounds", 400);
        }
        worker.capacity = resource.capacity;
      }
      if (resource?.health !== undefined) worker.health = resource.health;
      else if (worker.health === "offline") worker.health = "healthy";
      if (resource?.mediaCapacity !== undefined) {
        if (!Number.isInteger(resource.mediaCapacity) || resource.mediaCapacity < (worker.activeMediaTasks ?? 0) || resource.mediaCapacity > 64) throw new FabricError("validation_failed", "media capacity is outside permitted bounds", 400);
        worker.mediaCapacity = resource.mediaCapacity;
      }
      worker.lastHeartbeatAt = now(this.#clock);
      worker.updatedAt = worker.lastHeartbeatAt;
      state.workers.set(worker.id, worker);
      return structuredClone(worker);
    });
  }

  public async createProfile(input: Omit<Profile, "createdAt" | "updatedAt" | "volumeGeneration"> & Partial<Pick<Profile, "createdAt" | "updatedAt" | "volumeGeneration">>, actor?: Principal): Promise<Profile> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeProject(state, actor, input.ownerProject, "create_profile", input.ref);
      if (state.profiles.has(input.ref)) throw new FabricError("conflict", `profile ${input.ref} already exists`, 409);
      const worker = this.#kernel.worker(state, input.workerId);
      if (!worker.volumeNames.includes(input.volumeName)) throw new FabricError("validation_failed", "profile volume is not owned by its affine worker", 400);
      if (!worker.capabilities.supportedProfileFamilies.includes(input.profileFamily)) throw new FabricError("validation_failed", "worker does not support this profile family", 400);
      for (const grant of input.grants) this.#kernel.project(state, grant);
      const timestamp = now(this.#clock);
      const profile: Profile = {
        ...input,
        grants: [...new Set([input.ownerProject, ...input.grants])],
        volumeGeneration: input.volumeGeneration ?? 1,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp
      };
      state.profiles.set(profile.ref, profile);
      const generation = {
        id: createId("volume-generation"),
        profileRef: profile.ref,
        generation: profile.volumeGeneration,
        workerId: profile.workerId,
        volumeName: profile.volumeName,
        status: "active" as const,
        createdAt: timestamp
      };
      state.volumeGenerations.set(generation.id, generation);
      this.#kernel.event(state, profile.ownerProject, { kind: "profile", id: profile.ref }, "profile.created", { workerId: profile.workerId, volumeGeneration: profile.volumeGeneration });
      return structuredClone(profile);
    });
  }

  public async grantProfile(profileRef: Profile["ref"], project: ProjectId, actor?: Principal): Promise<Profile> {
    return this.#store.transact((state) => {
      const profile = this.#kernel.profile(state, profileRef);
      this.#kernel.authorizeProject(state, actor, profile.ownerProject, "grant_profile", profileRef);
      this.#kernel.project(state, project);
      profile.grants = [...new Set([...profile.grants, project])];
      profile.updatedAt = now(this.#clock);
      state.profiles.set(profile.ref, profile);
      this.#kernel.event(state, profile.ownerProject, { kind: "profile", id: profile.ref }, "profile.granted", { project });
      return structuredClone(profile);
    });
  }

  public async relocateProfile(profileRef: Profile["ref"], targetWorkerId: Worker["id"], verifiedChecksum: string, actor?: Principal): Promise<Profile> {
    return this.#store.transact((state) => {
      const profile = this.#kernel.profile(state, profileRef);
      this.#kernel.authorizeProject(state, actor, profile.ownerProject, "relocate_profile", profileRef);
      if (!verifiedChecksum) throw new FabricError("validation_failed", "relocation requires a verified volume checksum", 400);
      if ([...state.leases.values()].some((lease) => lease.profileRef === profile.ref && lease.status === "active")) {
        throw new FabricError("conflict", "cannot relocate a profile with an active lease", 409);
      }
      const target = this.#kernel.worker(state, targetWorkerId);
      if (target.health !== "healthy") throw new FabricError("worker_unavailable", "target worker is not healthy", 409);
      if (!target.capabilities.supportedProfileFamilies.includes(profile.profileFamily)) throw new FabricError("validation_failed", "target worker does not support the profile family", 400);
      const nextVolume = `${profile.volumeName}-g${profile.volumeGeneration + 1}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 128).replace(/[_.-]+$/, "");
      if (!nextVolume) throw new FabricError("validation_failed", "profile relocation generated an invalid volume name", 400);
      if (!target.volumeNames.includes(nextVolume)) throw new FabricError("validation_failed", "target volume must be pre-created and verified on the target worker", 400);
      profile.status = "relocating";
      profile.updatedAt = now(this.#clock);
      profile.workerId = targetWorkerId;
      profile.volumeName = nextVolume;
      profile.volumeGeneration += 1;
      profile.status = "active";
      state.profiles.set(profile.ref, profile);
      for (const generation of state.volumeGenerations.values()) {
        if (generation.profileRef === profile.ref && generation.status === "active") {
          generation.status = "retired";
          state.volumeGenerations.set(generation.id, generation);
        }
      }
      const generation = {
        id: createId("volume-generation"),
        profileRef: profile.ref,
        generation: profile.volumeGeneration,
        workerId: targetWorkerId,
        volumeName: nextVolume,
        status: "active" as const,
        checksum: verifiedChecksum,
        createdAt: now(this.#clock)
      };
      state.volumeGenerations.set(generation.id, generation);
      this.#kernel.event(state, profile.ownerProject, { kind: "profile", id: profile.ref }, "profile.relocated", { targetWorkerId, volumeGeneration: profile.volumeGeneration });
      this.#kernel.audit(state, actor, profile.ownerProject, "profile.relocated", { kind: "profile", id: profile.ref }, "succeeded", { targetWorkerId, volumeGeneration: profile.volumeGeneration });
      return structuredClone(profile);
    });
  }

  public async createBrowserSession(input: BrowserSessionCreateInput, actor?: Principal): Promise<BrowserSessionResponse> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeProject(state, actor, input.project, "create_browser_session", input.browserRecipeRef);
      const metadata = scalarMetadata(input.metadata);
      const hash = requestFingerprint("browser_session", input);
      const existing = state.idempotency.get(idempotencyKey(input.project, "browser_session", input.idempotencyKey));
      if (existing) {
        if (existing.requestHash !== hash) throw new FabricError("idempotency_conflict", "idempotency key was already used with different request content", 409);
        return sessionResponse(this.#kernel.session(state, existing.responseId as BrowserSessionId));
      }
      this.#kernel.validateSessionInput(state, input);
      const timestamp = now(this.#clock);
      const session: BrowserSession = {
        id: createId("browser-session"),
        project: input.project,
        idempotencyKey: input.idempotencyKey,
        runtime: input.runtime,
        browserRecipeRef: input.browserRecipeRef,
        ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
        leaseMode: input.leaseMode,
        egressPolicyRef: input.egressPolicyRef,
        artifactPolicyRef: input.artifactPolicyRef,
        metadata: structuredClone(metadata),
        status: "queued",
        queueSequence: ++state.queueSequence,
        maxExternalConnections: input.maxExternalConnections ?? 1,
        externalConnectionCount: 0,
        expiresAt: after(this.#clock, input.ttlSeconds),
        lastHeartbeatAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.sessions.set(session.id, session);
      state.idempotency.set(idempotencyKey(input.project, "browser_session", input.idempotencyKey), {
        id: createId("idempotency"),
        project: input.project,
        scope: "browser_session",
        key: input.idempotencyKey,
        requestHash: hash,
        responseId: session.id,
        createdAt: timestamp
      });
      this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.queued", { runtime: session.runtime, leaseMode: session.leaseMode });
      this.#kernel.audit(state, actor, session.project, "browser_session.created", { kind: "browser_session", id: session.id }, "succeeded", { recipe: session.browserRecipeRef });
      return sessionResponse(session);
    });
  }

  public async createJob(input: JobCreateInput, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeProject(state, actor, input.project, "create_job", input.recipeRef);
      const hash = requestFingerprint("job", input);
      const existing = state.idempotency.get(idempotencyKey(input.project, "job", input.idempotencyKey));
      if (existing) {
        if (existing.requestHash !== hash) throw new FabricError("idempotency_conflict", "idempotency key was already used with different request content", 409);
        return jobResponse(this.#kernel.job(state, existing.responseId as JobId));
      }
      const recipe = this.#kernel.recipe(state, input.recipeRef) as RecipeDefinition;
      if (recipe.access !== "typed_job") throw new FabricError("validation_failed", `${recipe.ref} is raw-CDP only`, 400);
      validateTypedOperation(recipe, input.operation);
      if (isMediaRuntime(recipe.runtime)) {
        if (input.profileRef !== undefined) throw new FabricError("validation_failed", "media-only work must not attach a browser profile", 400);
        const media = recipe.runtime === "media-relay"
          ? parseMediaRelayOperation(input.operation)
          : parseMediaPlaybackOperation(input.operation);
        const manifest = state.artifacts.get(media.manifestRef as Artifact["id"]);
        // Fail at submission rather than allocating worker capacity for a missing, foreign,
        // expired, or non-manifest artifact. The bytes themselves were validated at ingestion and
        // are verified again by the manager before the relay starts.
        if (!manifest || manifest.project !== input.project || asDate(manifest.expiresAt) <= this.#clock.now().getTime()) {
          throw new FabricError("not_found", "media manifest artifact was not found for this project", 404);
        }
        if (manifest.kind !== "media_manifest" || manifest.mimeType.toLowerCase().split(";", 1)[0]?.trim() !== MEDIA_MANIFEST_CONTENT_TYPE) {
          throw new FabricError("validation_failed", "manifestRef must identify a Fabric media_manifest artifact", 400);
        }
      }
      assertDurablePayload(input.operation);
      assertSafeCallback(input.callback);
      const effectiveLeaseMode = input.leaseMode ?? (isMediaRuntime(recipe.runtime) ? "clone" : "writer");
      const metadata = scalarMetadata(input.metadata);
      this.#kernel.validateCommonReferences(state, input.project, recipe, input.profileRef, effectiveLeaseMode, input.egressPolicyRef, input.artifactPolicyRef);
      const timestamp = now(this.#clock);
      const job: Job = {
        id: createId("job"),
        project: input.project,
        idempotencyKey: input.idempotencyKey,
        recipeRef: input.recipeRef,
        runtime: recipe.runtime,
        operation: structuredClone(input.operation),
        ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
        leaseMode: effectiveLeaseMode,
        egressPolicyRef: input.egressPolicyRef,
        artifactPolicyRef: input.artifactPolicyRef,
        ...(input.callback === undefined ? {} : { callback: structuredClone(input.callback) }),
        metadata: structuredClone(metadata),
        status: "queued",
        queueSequence: ++state.queueSequence,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: after(this.#clock, input.ttlSeconds ?? 1_800)
      };
      state.jobs.set(job.id, job);
      state.idempotency.set(idempotencyKey(input.project, "job", input.idempotencyKey), {
        id: createId("idempotency"),
        project: input.project,
        scope: "job",
        key: input.idempotencyKey,
        requestHash: hash,
        responseId: job.id,
        createdAt: timestamp
      });
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.queued", { recipe: job.recipeRef, runtime: job.runtime });
      this.#kernel.audit(state, actor, job.project, "job.created", { kind: "job", id: job.id }, "succeeded", { recipe: job.recipeRef });
      return jobResponse(job);
    });
  }

  /** FIFO only among tasks already compatible with a currently available healthy worker/profile. */
  public async dispatch(maxAssignments = 4, onlyWorkerId?: Worker["id"]): Promise<WorkerAssignment[]> {
    if (!Number.isInteger(maxAssignments) || maxAssignments < 1) throw new FabricError("validation_failed", "maxAssignments must be positive", 400);
    return this.#store.transact((state) => {
      const assignments: WorkerAssignment[] = [];
      const work = [
        ...[...state.sessions.values()].filter((session) => session.status === "queued").map((session) => ({ type: "session" as const, createdAt: session.createdAt, item: session })),
        ...[...state.jobs.values()].filter((job) => job.status === "queued").map((job) => ({ type: "job" as const, createdAt: job.createdAt, item: job }))
      ].sort((left, right) => (left.item.queueSequence ?? Number.MAX_SAFE_INTEGER) - (right.item.queueSequence ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt));
      for (const candidate of work) {
        if (assignments.length >= maxAssignments) break;
        if (candidate.type === "session") {
          if (asDate(candidate.item.expiresAt) <= this.#clock.now().getTime()) {
            this.#kernel.releaseSession(state, candidate.item, "timed_out", "session TTL expired before dispatch");
            continue;
          }
          const assignment = this.#kernel.assignSession(state, candidate.item, onlyWorkerId);
          if (assignment) assignments.push(assignment);
        } else {
          if (asDate(candidate.item.expiresAt) <= this.#clock.now().getTime()) {
            candidate.item.status = "timed_out";
            candidate.item.failureReason = "job TTL expired before dispatch";
            candidate.item.updatedAt = now(this.#clock);
            state.jobs.set(candidate.item.id, candidate.item);
            this.#kernel.event(state, candidate.item.project, { kind: "job", id: candidate.item.id }, "job.timed_out", {});
            continue;
          }
          const assignment = this.#kernel.assignJob(state, candidate.item, onlyWorkerId);
          if (assignment) assignments.push(assignment);
        }
      }
      return assignments.map((assignment) => structuredClone(assignment));
    });
  }

  /** Workers claim a signed assignment; no arbitrary worker can execute another worker's job. */
  public async claimAssignment(workerId: Worker["id"], leaseId: BrowserLease["id"] | undefined, jobId: JobId | undefined, actor?: Principal): Promise<WorkerAssignment> {
    return this.#store.transact((state) => {
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "claim_assignment");
      if (leaseId) {
        const lease = this.#kernel.lease(state, leaseId);
        if (lease.workerId !== workerId || lease.status !== "active") throw new FabricError("authorization_denied", "assignment is not allocated to this worker", 403);
        const timestamp = now(this.#clock);
        lease.assignmentClaimedAt = timestamp;
        // A controller can spend several seconds creating a constrained Docker container. Treat a
        // successful claim as a liveness signal while it performs that bounded startup work;
        // markLeaseStarted records actual browser readiness separately.
        lease.lastHeartbeatAt = timestamp;
        state.leases.set(lease.id, lease);
        if (lease.sessionId) {
          const session = this.#kernel.session(state, lease.sessionId);
          if (session.status === "allocating") {
            session.updatedAt = timestamp;
            state.sessions.set(session.id, session);
            this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.claimed", { workerId, leaseId: lease.id });
          }
          return this.#kernel.assignmentForLease(state, lease);
        }
        if (lease.jobId) {
          const job = this.#kernel.job(state, lease.jobId);
          job.assignmentClaimedAt = timestamp;
          job.updatedAt = timestamp;
          state.jobs.set(job.id, job);
          return this.#kernel.assignmentForLease(state, lease);
        }
      }
      if (jobId) {
        const job = this.#kernel.job(state, jobId);
        const activeMediaStatus = job.status === "running" || (job.runtime === "media-playback" && job.status === "awaiting_input");
        if (!isMediaRuntime(job.runtime) || job.workerId !== workerId || !activeMediaStatus) {
          throw new FabricError("authorization_denied", "media assignment is not allocated to this worker", 403);
        }
        job.assignmentClaimedAt = now(this.#clock);
        job.updatedAt = now(this.#clock);
        state.jobs.set(job.id, job);
        return this.#kernel.assignmentForMediaJob(state, job);
      }
      throw new FabricError("validation_failed", "assignment requires a leaseId or media jobId", 400);
    });
  }

  /**
   * Pull mailbox for worker agents. Existing allocations are returned until the worker claims
   * them; this makes a central scheduler and outbound-only local agents compose without racing
   * over a second dispatch operation.
   */
  public async assignmentsForWorker(workerId: Worker["id"], limit = 8, actor?: Principal): Promise<WorkerAssignment[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new FabricError("validation_failed", "assignment limit must be from 1 to 32", 400);
    return this.#store.read((state) => {
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "read_assignments");
      const assignments: WorkerAssignment[] = [];
      for (const lease of [...state.leases.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (assignments.length >= limit) break;
        if (lease.workerId !== workerId || lease.status !== "active" || lease.assignmentClaimedAt) continue;
        assignments.push(this.#kernel.assignmentForLease(state, lease));
      }
      for (const job of [...state.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (assignments.length >= limit) break;
        const activeMediaStatus = job.status === "running" || (job.runtime === "media-playback" && job.status === "awaiting_input");
        if (!isMediaRuntime(job.runtime) || job.workerId !== workerId || !activeMediaStatus || job.assignmentClaimedAt) continue;
        assignments.push(this.#kernel.assignmentForMediaJob(state, job));
      }
      return assignments.map((assignment) => structuredClone(assignment));
    });
  }

  /** All currently live work for reconciliation; includes assignments already claimed by a process. */
  public async activeAssignmentsForWorker(workerId: Worker["id"], limit = 32, actor?: Principal): Promise<WorkerAssignment[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new FabricError("validation_failed", "assignment limit must be from 1 to 128", 400);
    return this.#store.read((state) => {
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "read_active_assignments");
      const assignments: WorkerAssignment[] = [];
      for (const lease of [...state.leases.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (assignments.length >= limit) break;
        if (lease.workerId !== workerId || lease.status !== "active") continue;
        assignments.push(this.#kernel.assignmentForLease(state, lease));
      }
      for (const job of [...state.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (assignments.length >= limit) break;
        const activeMediaStatus = job.status === "running" || (job.runtime === "media-playback" && job.status === "awaiting_input");
        if (!isMediaRuntime(job.runtime) || job.workerId !== workerId || !activeMediaStatus) continue;
        assignments.push(this.#kernel.assignmentForMediaJob(state, job));
      }
      return assignments.map((assignment) => structuredClone(assignment));
    });
  }

  public async heartbeatSession(sessionId: BrowserSessionId, actor?: Principal): Promise<BrowserSessionResponse> {
    return this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      this.#kernel.authorizeProject(state, actor, session.project, "heartbeat_browser_session", sessionId);
      if (isTerminalSession(session.status)) throw new FabricError("invalid_state", `cannot heartbeat a ${session.status} session`, 409);
      if (asDate(session.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("invalid_state", "session has expired", 409);
      session.lastHeartbeatAt = now(this.#clock);
      session.updatedAt = session.lastHeartbeatAt;
      state.sessions.set(session.id, session);
      return sessionResponse(session);
    });
  }

  /** Worker heartbeat for the assigned lease. It does not extend the caller-requested TTL. */
  public async heartbeatLease(leaseId: BrowserLease["id"], workerId: Worker["id"], actor?: Principal): Promise<BrowserLease> {
    return this.#store.transact((state) => {
      const lease = this.#kernel.lease(state, leaseId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "heartbeat_lease");
      if (lease.workerId !== workerId) throw new FabricError("authorization_denied", "lease is assigned to another worker", 403);
      if (lease.status !== "active") throw new FabricError("invalid_state", `lease is ${lease.status}`, 409);
      if (asDate(lease.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("invalid_state", "lease has expired", 409);
      lease.lastHeartbeatAt = now(this.#clock);
      // A heartbeat proves the worker process is still alive while it is launching/recovering a
      // browser. It is deliberately *not* browser readiness: setting startedAt here would make a
      // slow native/managed launch look connectable and reintroduce the CDP readiness race.
      state.leases.set(lease.id, lease);
      return structuredClone(lease);
    });
  }

  /**
   * Mark a claimed browser lease usable only after the worker has started the process and
   * verified browser-level CDP.  This is the activation boundary for raw-CDP capability issuance;
   * merely allocating a Docker service must never expose a connectable session.
   */
  public async markLeaseStarted(leaseId: BrowserLease["id"], workerId: Worker["id"], actor?: Principal): Promise<BrowserLease> {
    return this.#store.transact((state) => {
      const lease = this.#kernel.lease(state, leaseId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "mark_lease_started");
      if (lease.workerId !== workerId) throw new FabricError("authorization_denied", "lease is assigned to another worker", 403);
      if (lease.status !== "active") throw new FabricError("invalid_state", `lease is ${lease.status}`, 409);
      if (!lease.assignmentClaimedAt) throw new FabricError("invalid_state", "lease must be claimed before it can start", 409);
      if (asDate(lease.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("invalid_state", "lease has expired", 409);
      const timestamp = now(this.#clock);
      lease.startedAt ??= timestamp;
      lease.lastHeartbeatAt = timestamp;
      state.leases.set(lease.id, lease);
      if (lease.sessionId) {
        const session = this.#kernel.session(state, lease.sessionId);
        if (session.status === "allocating") {
          session.status = "ready";
          session.updatedAt = timestamp;
          state.sessions.set(session.id, session);
          this.#kernel.materializeSessionCapability(state, session);
          this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.ready", { workerId, leaseId: lease.id });
        } else if (session.status !== "ready" && session.status !== "active") {
          throw new FabricError("invalid_state", `session is ${session.status}, not allocating`, 409);
        }
      }
      if (lease.jobId) {
        const job = this.#kernel.job(state, lease.jobId);
        if (job.status !== "running" && job.status !== "awaiting_input" && job.status !== "awaiting_manual") {
          throw new FabricError("invalid_state", `job is ${job.status}, not running`, 409);
        }
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.browser_ready", { workerId, leaseId: lease.id });
      }
      return structuredClone(lease);
    });
  }

  /**
   * A worker reports that a claimed browser cannot be recovered (for example, a federated relay
   * disappeared and could not reconnect).  Do not leave a public `ready` capability backed by a
   * dead process until the heartbeat timeout; revoke it transactionally and apply the normal
   * bounded retry rule for typed jobs.
   */
  public async failLease(leaseId: BrowserLease["id"], workerId: Worker["id"], reason: string, actor?: Principal): Promise<void> {
    await this.#store.transact((state) => {
      const lease = this.#kernel.lease(state, leaseId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "fail_lease");
      if (lease.workerId !== workerId) throw new FabricError("authorization_denied", "lease is assigned to another worker", 403);
      if (lease.status !== "active") return;
      const failureReason = safeFailureReason(reason);
      const timestamp = now(this.#clock);
      if (lease.sessionId) {
        const session = this.#kernel.session(state, lease.sessionId);
        this.#kernel.releaseLease(state, lease);
        if (!isTerminalSession(session.status)) {
          session.status = "failed";
          session.failureReason = failureReason;
          session.workerId = undefined;
          session.leaseId = undefined;
          session.cdpEndpoint = undefined;
          session.cdpInternalEndpoint = undefined;
          session.cdpCapabilityExpiresAt = undefined;
          session.externalConnectionCount = 0;
          session.reconnectGraceUntil = undefined;
          session.releasedAt = timestamp;
          session.updatedAt = timestamp;
          state.sessions.set(session.id, session);
          this.#kernel.cancelInputRequests(state, { sessionId: session.id });
          this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.failed", { reason: failureReason });
          this.#kernel.audit(state, actor, session.project, "browser_session.worker_failed", { kind: "browser_session", id: session.id }, "failed", {});
        }
        return;
      }
      if (!lease.jobId) return;
      const job = this.#kernel.job(state, lease.jobId);
      this.#kernel.releaseLease(state, lease);
      this.#kernel.cancelInputRequests(state, { jobId: job.id });
      this.#kernel.finishAttempt(state, job, "failed");
      const recipe = this.#kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
      job.workerId = undefined;
      job.leaseId = undefined;
      job.assignmentClaimedAt = undefined;
      job.updatedAt = timestamp;
      if (attempts < recipe.maxAttempts && asDate(job.expiresAt) > this.#clock.now().getTime()) {
        job.status = "queued";
        job.failureReason = undefined;
        state.jobs.set(job.id, job);
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.requeued_after_lease_failure", { attempts });
      } else {
        job.status = "failed";
        job.failureReason = failureReason;
        state.jobs.set(job.id, job);
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.failed", { reason: failureReason });
        this.#kernel.audit(state, actor, job.project, "job.worker_failed", { kind: "job", id: job.id }, "failed", {});
      }
    });
  }

  /**
   * Release a manager-owned media assignment after its one-shot service exits, is stopped during
   * recovery, or cannot deliver a verified artifact receipt. This mirrors browser-lease recovery:
   * capacity is released first and a bounded recipe retry is then eligible for FIFO dispatch.
   */
  public async failMediaTask(jobId: JobId, workerId: Worker["id"], attemptId: AttemptId | undefined, reason: string, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "fail_media_task");
      if (!isMediaRuntime(job.runtime) || job.workerId !== workerId || job.mediaAttemptId !== attemptId) {
        throw new FabricError("authorization_denied", "media task is not assigned to this worker", 403);
      }
      if (isTerminalJob(job.status)) return jobResponse(job);
      const failureReason = safeFailureReason(reason);
      this.#kernel.releaseMediaTask(state, job);
      this.#kernel.finishAttempt(state, job, "failed");
      this.#kernel.cancelInputRequests(state, { jobId: job.id });
      const recipe = this.#kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).length;
      job.assignmentClaimedAt = undefined;
      job.updatedAt = now(this.#clock);
      if (attempts < recipe.maxAttempts && asDate(job.expiresAt) > this.#clock.now().getTime()) {
        job.status = "queued";
        job.workerId = undefined;
        job.failureReason = undefined;
        state.jobs.set(job.id, job);
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.requeued_after_media_failure", { attempts });
      } else {
        job.status = asDate(job.expiresAt) <= this.#clock.now().getTime() ? "timed_out" : "failed";
        job.failureReason = failureReason;
        state.jobs.set(job.id, job);
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, `job.${job.status}`, { reason: failureReason });
        this.#kernel.audit(state, actor, job.project, "media_task.failed", { kind: "job", id: job.id }, "failed", {});
      }
      return jobResponse(job);
    });
  }

  /**
   * Create (or return) the one encrypted input request that carries a signed HLS/MP4 provider
   * source for an already claimed playback attempt. The durable job retains only manifestRef;
   * neither this method nor its events contain the URL, cookie, or request headers.
   */
  public async requestMediaPlaybackSource(
    input: { jobId: JobId; workerId: Worker["id"]; attemptId: AttemptId; refresh?: boolean },
    actor?: Principal,
  ): Promise<MediaPlaybackSourceRequestResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, input.jobId);
      const worker = this.#kernel.worker(state, input.workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "request_media_playback_source");
      if (
        job.runtime !== "media-playback" ||
        job.workerId !== input.workerId ||
        job.mediaAttemptId !== input.attemptId ||
        !job.assignmentClaimedAt ||
        (job.status !== "running" && job.status !== "awaiting_input")
      ) {
        throw new FabricError("invalid_state", "media playback task is not active for this worker attempt", 409);
      }
      if (!worker.inputEncryptionPublicKeyPem) {
        throw new FabricError("worker_unavailable", "media playback worker has no input encryption public key", 503);
      }
      const timestamp = now(this.#clock);
      const current = job.mediaPlaybackSourceRequestId === undefined
        ? undefined
        : state.inputRequests.get(job.mediaPlaybackSourceRequestId);
      if (
        current &&
        current.jobId === job.id &&
        current.mediaAttemptId === input.attemptId &&
        current.field === "media_source" &&
        current.fieldType === "media_playback_source" &&
        (current.status === "pending" || current.status === "supplied")
      ) {
        if (asDate(current.expiresAt) > this.#clock.now().getTime()) {
          return { request: structuredClone(current), job: structuredClone(job) };
        }
        // Do not make a worker wait for the periodic recovery loop to notice the same timed-out
        // source request. It is addressed to one worker/attempt, so expire and discard it before
        // allocating its replacement in this serialized transaction.
        current.status = "expired";
        current.resolvedAt = timestamp;
        state.inputRequests.set(current.id, current);
        this.#kernel.discardInput(current.id);
      }
      if (!input.refresh && job.mediaPlaybackReadyAt !== undefined) {
        throw new FabricError("invalid_state", "media playback source is already active for this attempt", 409);
      }
      const request: EphemeralInputRequest = {
        id: createId("input-request"),
        project: job.project,
        jobId: job.id,
        mediaAttemptId: input.attemptId,
        workerId: worker.id,
        workerInputEncryptionPublicKeyPem: worker.inputEncryptionPublicKeyPem,
        field: "media_source",
        fieldType: "media_playback_source",
        status: "pending",
        expiresAt: after(this.#clock, 60),
        createdAt: timestamp,
      };
      state.inputRequests.set(request.id, request);
      job.status = "awaiting_input";
      job.mediaPlaybackReadyAt = undefined;
      job.mediaPlaybackSourceRequestId = request.id;
      job.updatedAt = timestamp;
      state.jobs.set(job.id, job);
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "media_playback.source_requested", { requestId: request.id, refresh: input.refresh === true });
      return { request: structuredClone(request), job: structuredClone(job) };
    });
  }

  /** Mark a local media worker's in-memory source session usable after it consumed a ciphertext. */
  public async markMediaPlaybackReady(
    input: { jobId: JobId; workerId: Worker["id"]; attemptId: AttemptId; requestId: EphemeralInputRequest["id"] },
    actor?: Principal,
  ): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, input.jobId);
      const worker = this.#kernel.worker(state, input.workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "mark_media_playback_ready");
      if (
        job.runtime !== "media-playback" ||
        job.workerId !== input.workerId ||
        job.mediaAttemptId !== input.attemptId
      ) {
        throw new FabricError("invalid_state", "media playback task is not active for this worker attempt", 409);
      }
      if (job.mediaPlaybackSourceRequestId !== input.requestId) {
        throw new FabricError("authorization_denied", "media playback readiness does not match the active source request", 403);
      }
      if (job.status !== "running") {
        throw new FabricError("invalid_state", "media playback task is awaiting its current encrypted source", 409);
      }
      const sourceRequest = this.#kernel.inputRequest(state, input.requestId);
      if (
        sourceRequest.jobId !== job.id ||
        sourceRequest.mediaAttemptId !== input.attemptId ||
        sourceRequest.workerId !== worker.id ||
        sourceRequest.field !== "media_source" ||
        sourceRequest.fieldType !== "media_playback_source" ||
        sourceRequest.status !== "consumed"
      ) {
        throw new FabricError("invalid_state", "media playback source has not been consumed for this exact request", 409);
      }
      job.mediaPlaybackReadyAt = now(this.#clock);
      job.updatedAt = job.mediaPlaybackReadyAt;
      state.jobs.set(job.id, job);
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "media_playback.ready", { workerId: worker.id });
      return jobResponse(job);
    });
  }

  /**
   * Resolve a live playback binding for the public capability gateway. The caller's bearer
   * capability is authenticated separately, so this method deliberately accepts no principal.
   */
  public async getActiveMediaPlaybackBinding(
    jobId: JobId,
    expected: { workerId: Worker["id"]; attemptId: AttemptId },
  ): Promise<ActiveMediaPlaybackBinding> {
    return this.#store.read((state) => {
      const job = this.#kernel.job(state, jobId);
      if (
        job.runtime !== "media-playback" ||
        job.status !== "running" ||
        job.mediaPlaybackSourceRequestId === undefined ||
        job.mediaPlaybackReadyAt === undefined ||
        job.workerId !== expected.workerId ||
        job.mediaAttemptId !== expected.attemptId ||
        asDate(job.expiresAt) <= this.#clock.now().getTime()
      ) {
        throw new FabricError("invalid_state", "media playback session is unavailable", 409);
      }
      const sourceRequest = this.#kernel.inputRequest(state, job.mediaPlaybackSourceRequestId);
      if (
        sourceRequest.status !== "consumed" ||
        sourceRequest.jobId !== job.id ||
        sourceRequest.mediaAttemptId !== expected.attemptId ||
        sourceRequest.workerId !== expected.workerId ||
        sourceRequest.field !== "media_source" ||
        sourceRequest.fieldType !== "media_playback_source"
      ) {
        throw new FabricError("invalid_state", "media playback source is no longer bound to this active attempt", 409);
      }
      const worker = this.#kernel.worker(state, expected.workerId);
      if (worker.health !== "healthy" || !worker.mediaPlaybackEndpoint) {
        throw new FabricError("worker_unavailable", "media playback worker is unavailable", 503);
      }
      return { job: structuredClone(job), worker: structuredClone(worker), attemptId: expected.attemptId };
    });
  }

  /** Project-authorized access check used before issuing a volatile public playback capability. */
  public async getProjectMediaPlaybackBinding(jobId: JobId, actor?: Principal): Promise<ActiveMediaPlaybackBinding> {
    return this.#store.read((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeProject(state, actor, job.project, "read_media_playback", job.id);
      if (job.runtime !== "media-playback" || !job.workerId || !job.mediaAttemptId) {
        throw new FabricError("invalid_state", "job is not an active media playback session", 409);
      }
      if (job.status !== "running" || job.mediaPlaybackSourceRequestId === undefined || job.mediaPlaybackReadyAt === undefined || asDate(job.expiresAt) <= this.#clock.now().getTime()) {
        throw new FabricError("invalid_state", "media playback session is unavailable", 409);
      }
      const sourceRequest = this.#kernel.inputRequest(state, job.mediaPlaybackSourceRequestId);
      if (
        sourceRequest.status !== "consumed" ||
        sourceRequest.jobId !== job.id ||
        sourceRequest.mediaAttemptId !== job.mediaAttemptId ||
        sourceRequest.workerId !== job.workerId ||
        sourceRequest.field !== "media_source" ||
        sourceRequest.fieldType !== "media_playback_source"
      ) {
        throw new FabricError("invalid_state", "media playback source is no longer bound to this active attempt", 409);
      }
      const worker = this.#kernel.worker(state, job.workerId);
      if (worker.health !== "healthy" || !worker.mediaPlaybackEndpoint) throw new FabricError("worker_unavailable", "media playback worker is unavailable", 503);
      return { job: structuredClone(job), worker: structuredClone(worker), attemptId: job.mediaAttemptId };
    });
  }

  /**
   * Reserve the storage expiry before a media worker uploads bytes. The value is persisted on the
   * job so a crashed manager can retry the same immutable object key without changing its S3
   * metadata. It is intentionally not part of a public job response.
   */
  public async reserveMediaArtifactExpiry(jobId: JobId, workerId: Worker["id"], attemptId: AttemptId, actor?: Principal): Promise<{ job: Job; expiresAt: string }> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "reserve_media_artifact_expiry");
      if (
        job.runtime !== "media-relay" ||
        job.workerId !== workerId ||
        job.mediaAttemptId !== attemptId ||
        job.status !== "running" ||
        !job.assignmentClaimedAt
      ) throw new FabricError("invalid_state", "media task is not active on this worker", 409);
      const policy = this.#kernel.artifactPolicy(state, job.artifactPolicyRef);
      const currentTime = this.#clock.now().getTime();
      if (job.mediaArtifactExpiresAt === undefined) {
        job.mediaArtifactExpiresAt = after(this.#clock, policy.retentionDays * 86_400);
        job.updatedAt = now(this.#clock);
        state.jobs.set(job.id, job);
        this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "media_artifact.expiry_reserved", {});
      }
      if (!Number.isFinite(asDate(job.mediaArtifactExpiresAt)) || asDate(job.mediaArtifactExpiresAt) <= currentTime) {
        throw new FabricError("deadline_exceeded", "media artifact retention window has expired", 409);
      }
      return { job: structuredClone(job), expiresAt: job.mediaArtifactExpiresAt };
    });
  }

  public async registerExternalCdpConnection(sessionId: BrowserSessionId, capability: string): Promise<void> {
    await this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      if (!session.workerId) throw new FabricError("invalid_state", "session does not have an allocated worker", 409);
      this.#capabilitySigner.verify(capability, { sessionId, project: session.project, profileRef: session.profileRef, workerId: session.workerId });
      if (!(session.status === "ready" || session.status === "active")) throw new FabricError("invalid_state", "CDP is unavailable for this session", 409);
      const connectionLimit = session.maxExternalConnections ?? 1;
      if (session.externalConnectionCount >= connectionLimit) {
        throw new FabricError("conflict", `this session allows at most ${connectionLimit} external CDP connection${connectionLimit === 1 ? "" : "s"}`, 409);
      }
      session.externalConnectionCount += 1;
      if (session.status === "ready") {
        session.status = "active";
        this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.active", { workerId: session.workerId });
      }
      session.reconnectGraceUntil = undefined;
      session.updatedAt = now(this.#clock);
      state.sessions.set(session.id, session);
      this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.cdp_connected", { externalConnectionCount: session.externalConnectionCount });
    });
  }

  public async unregisterExternalCdpConnection(sessionId: BrowserSessionId): Promise<void> {
    await this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      if (session.externalConnectionCount > 0) session.externalConnectionCount -= 1;
      if (!isTerminalSession(session.status) && session.externalConnectionCount === 0 && session.status === "active") session.status = "ready";
      if (!isTerminalSession(session.status) && session.externalConnectionCount === 0) session.reconnectGraceUntil = after(this.#clock, this.#reconnectGraceSeconds);
      session.updatedAt = now(this.#clock);
      state.sessions.set(session.id, session);
      this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.cdp_disconnected", { externalConnectionCount: session.externalConnectionCount });
    });
  }

  public async releaseBrowserSession(sessionId: BrowserSessionId, actor?: Principal): Promise<BrowserSessionResponse> {
    return this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      this.#kernel.authorizeProject(state, actor, session.project, "release_browser_session", sessionId);
      this.#kernel.releaseSession(state, session, "released", "released by client");
      return sessionResponse(session);
    });
  }

  public async cancelBrowserSession(sessionId: BrowserSessionId, actor?: Principal): Promise<BrowserSessionResponse> {
    return this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      this.#kernel.authorizeProject(state, actor, session.project, "cancel_browser_session", sessionId);
      this.#kernel.releaseSession(state, session, "cancelled", "cancelled by client");
      return sessionResponse(session);
    });
  }

  public async cancelJob(jobId: JobId, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeProject(state, actor, job.project, "cancel_job", jobId);
      if (isTerminalJob(job.status)) return jobResponse(job);
      job.status = "cancelled";
      job.updatedAt = now(this.#clock);
      job.failureReason = "cancelled by client";
      state.jobs.set(job.id, job);
      if (job.leaseId) this.#kernel.releaseLease(state, this.#kernel.lease(state, job.leaseId));
      this.#kernel.releaseMediaTask(state, job);
      this.#kernel.finishAttempt(state, job, "cancelled");
      this.#kernel.cancelInputRequests(state, { jobId: job.id });
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.cancelled", {});
      this.#kernel.audit(state, actor, job.project, "job.cancelled", { kind: "job", id: job.id }, "succeeded", {});
      return jobResponse(job);
    });
  }

  public async resumeJob(jobId: JobId, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeProject(state, actor, job.project, "resume_job", jobId);
      if (job.status !== "awaiting_manual" && job.status !== "awaiting_input") {
        throw new FabricError("invalid_state", `cannot resume a ${job.status} job`, 409);
      }
      // Playback source waits are a Fabric-internal encrypted handoff, not a caller-controlled
      // pause. Letting a client resume it would orphan the pending source request while retaining
      // a running attempt/capacity reservation. Media retries always release and requeue through
      // the dedicated worker/recovery path instead.
      if (isMediaRuntime(job.runtime)) {
        throw new FabricError("invalid_state", "media jobs cannot be resumed through the generic job lifecycle", 409);
      }
      if (asDate(job.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("invalid_state", "job has expired", 409);
      const activeLease = job.leaseId ? state.leases.get(job.leaseId) : undefined;
      const assignedWorker = job.workerId ? state.workers.get(job.workerId) : undefined;
      // Manual/input pauses retain a live browser when possible. Resuming that lease directly
      // avoids allocating a second writer against the same profile. If the worker/lease vanished,
      // clear the stale assignment and let FIFO dispatch choose a compatible worker.
      if (activeLease?.status === "active" && assignedWorker?.health === "healthy") {
        job.status = "running";
      } else {
        if (activeLease) this.#kernel.releaseLease(state, activeLease);
        this.#kernel.releaseMediaTask(state, job);
        job.status = "queued";
        job.workerId = undefined;
        job.leaseId = undefined;
      }
      job.updatedAt = now(this.#clock);
      state.jobs.set(job.id, job);
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.resumed", {});
      return jobResponse(job);
    });
  }

  public async completeJob(jobId: JobId, result: Record<string, unknown>, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeAssignedWorker(state, actor, job.workerId, "complete_job", jobId);
      if (isTerminalJob(job.status)) throw new FabricError("invalid_state", `job is already ${job.status}`, 409);
      if (isMediaRuntime(job.runtime)) {
        throw new FabricError("invalid_state", "media jobs must complete through their Fabric-owned media path", 409);
      }
      assertDurablePayload(result);
      job.status = "succeeded";
      job.result = structuredClone(result);
      job.updatedAt = now(this.#clock);
      state.jobs.set(job.id, job);
      if (job.leaseId) this.#kernel.releaseLease(state, this.#kernel.lease(state, job.leaseId));
      this.#kernel.releaseMediaTask(state, job);
      this.#kernel.finishAttempt(state, job, "succeeded");
      this.#kernel.cancelInputRequests(state, { jobId: job.id });
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.succeeded", {});
      this.#kernel.audit(state, actor, job.project, "job.completed", { kind: "job", id: job.id }, "succeeded", {});
      return jobResponse(job);
    });
  }

  /**
   * Complete a media-only job after the manager has verified the receipt against a Fabric-owned
   * immutable artifact. Generic worker completion is deliberately unavailable for this runtime.
   */
  public async completeMediaTask(jobId: JobId, workerId: Worker["id"], attemptId: AttemptId, result: Record<string, unknown>, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "complete_media_task");
      if (
        job.runtime !== "media-relay" ||
        job.workerId !== workerId ||
        job.mediaAttemptId !== attemptId ||
        job.status !== "running" ||
        !job.assignmentClaimedAt
      ) throw new FabricError("invalid_state", "media task is no longer active for this attempt", 409);
      assertDurablePayload(result);
      const artifactId = result.artifactId;
      const kind = result.kind;
      const contentType = result.contentType;
      const sizeBytes = result.sizeBytes;
      const sha256 = result.sha256;
      if (
        typeof artifactId !== "string" ||
        typeof kind !== "string" ||
        typeof contentType !== "string" ||
        !Number.isSafeInteger(sizeBytes) ||
        typeof sha256 !== "string"
      ) throw new FabricError("validation_failed", "media completion result is invalid", 400);
      const artifact = state.artifacts.get(artifactId as Artifact["id"]);
      if (
        !artifact ||
        artifact.jobId !== job.id ||
        artifact.kind !== kind ||
        artifact.mimeType !== contentType ||
        artifact.sizeBytes !== sizeBytes ||
        artifact.sha256 !== sha256
      ) throw new FabricError("conflict", "media completion does not match an immutable Fabric artifact", 409);
      job.status = "succeeded";
      job.result = structuredClone(result);
      job.updatedAt = now(this.#clock);
      state.jobs.set(job.id, job);
      this.#kernel.releaseMediaTask(state, job);
      this.#kernel.finishAttempt(state, job, "succeeded");
      this.#kernel.cancelInputRequests(state, { jobId: job.id });
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.succeeded", {});
      this.#kernel.audit(state, actor, job.project, "media_task.completed", { kind: "job", id: job.id }, "succeeded", {});
      return jobResponse(job);
    });
  }

  /** Record a bounded retry performed by a recipe while retaining its current lease. */
  public async beginJobRetry(jobId: JobId, actor?: Principal): Promise<number> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeAssignedWorker(state, actor, job.workerId, "retry_job", jobId);
      if (job.status !== "running") throw new FabricError("invalid_state", `cannot retry a ${job.status} job`, 409);
      // A media retry must invalidate the old attempt-bound result/playback capability, release
      // its media slot, and be redispatched. The generic in-place retry intentionally retains a
      // browser lease, so applying it here would leave job.mediaAttemptId stale.
      if (isMediaRuntime(job.runtime)) {
        throw new FabricError("invalid_state", "media jobs retry only through Fabric media-task recovery", 409);
      }
      const recipe = this.#kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id);
      if (attempts.length >= recipe.maxAttempts) throw new FabricError("conflict", "recipe retry budget is exhausted", 409);
      this.#kernel.finishAttempt(state, job, "failed");
      this.#kernel.startAttempt(state, job, job.workerId!, job.leaseId);
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.retry_started", { attempt: attempts.length + 1 });
      return attempts.length + 1;
    });
  }

  public async failJob(jobId: JobId, status: Extract<JobStatus, "failed" | "blocked_challenge" | "awaiting_manual" | "auth_required" | "timed_out">, reason: string, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeAssignedWorker(state, actor, job.workerId, "fail_job", jobId);
      if (isTerminalJob(job.status)) throw new FabricError("invalid_state", `job is already ${job.status}`, 409);
      // Generic failure permits `awaiting_manual`, which deliberately retains a browser lease.
      // Media tasks have no browser lease and must instead release their attempt-bound capacity
      // via failMediaTask so no signed result or playback capability outlives the assignment.
      if (isMediaRuntime(job.runtime)) {
        throw new FabricError("invalid_state", "media jobs must use the Fabric media-task failure lifecycle", 409);
      }
      job.status = status;
      job.failureReason = safeFailureReason(reason);
      job.updatedAt = now(this.#clock);
      state.jobs.set(job.id, job);
      if (status !== "awaiting_manual" && job.leaseId) this.#kernel.releaseLease(state, this.#kernel.lease(state, job.leaseId));
      if (status !== "awaiting_manual") this.#kernel.releaseMediaTask(state, job);
      if (status !== "awaiting_manual") this.#kernel.finishAttempt(state, job, "failed");
      if (status !== "awaiting_manual") this.#kernel.cancelInputRequests(state, { jobId: job.id });
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, `job.${status}`, { reason: job.failureReason });
      return jobResponse(job);
    });
  }

  public async requestEphemeralInput(input: { sessionId?: BrowserSessionId; jobId?: JobId; leaseId: BrowserLease["id"]; field: string; fieldType: InputFieldType }, actor?: Principal): Promise<InputRequestResponse> {
    return this.#store.transact((state) => {
      if (typeof input.field !== "string" || input.field.length < 1 || input.field.length > 255) throw new FabricError("validation_failed", "input field must be between 1 and 255 characters", 400);
      if (!["password", "otp", "captcha_provider_credential", "proxy_credential", "form_value"].includes(input.fieldType)) throw new FabricError("validation_failed", "input field type is invalid", 400);
      const lease = this.#kernel.lease(state, input.leaseId);
      this.#kernel.authorizeAssignedWorker(state, actor, lease.workerId, "request_ephemeral_input", lease.id);
      if (lease.status !== "active") throw new FabricError("invalid_state", "cannot request input for an inactive lease", 409);
      if ((input.sessionId === undefined) === (input.jobId === undefined)) throw new FabricError("validation_failed", "input request must belong to exactly one session or job", 400);
      if (input.sessionId && lease.sessionId !== input.sessionId) throw new FabricError("authorization_denied", "lease does not belong to this session", 403);
      if (input.jobId) {
        if (lease.jobId !== input.jobId) throw new FabricError("authorization_denied", "lease does not belong to this job", 403);
        const job = this.#kernel.job(state, input.jobId);
        const recipe = this.#kernel.recipe(state, job.recipeRef) as RecipeDefinition;
        const operationName = typeof job.operation.operation === "string" ? job.operation.operation : undefined;
        const operation = operationName === undefined ? undefined : recipe.typedOperations?.find((candidate) => candidate.name === operationName);
        if (!operation || !operation.secretInputFields.includes(input.field)) {
          throw new FabricError("validation_failed", `input field ${input.field} is not declared by the typed recipe`, 400);
        }
      }
      const timestamp = now(this.#clock);
      const request: EphemeralInputRequest = {
        id: createId("input-request"),
        project: lease.project,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
        leaseId: lease.id,
        workerId: lease.workerId,
        ...(this.#kernel.worker(state, lease.workerId).inputEncryptionPublicKeyPem === undefined ? {} : { workerInputEncryptionPublicKeyPem: this.#kernel.worker(state, lease.workerId).inputEncryptionPublicKeyPem }),
        field: input.field,
        fieldType: input.fieldType,
        status: "pending",
        expiresAt: after(this.#clock, 60),
        createdAt: timestamp
      };
      state.inputRequests.set(request.id, request);
      if (input.jobId) {
        const job = this.#kernel.job(state, input.jobId);
        job.status = "awaiting_input";
        job.updatedAt = timestamp;
        state.jobs.set(job.id, job);
      }
      this.#kernel.event(state, lease.project, { kind: input.jobId ? "job" : "browser_session", id: input.jobId ?? input.sessionId! }, "ephemeral_input.requested", { requestId: request.id, field: input.field, fieldType: input.fieldType });
      return { request: structuredClone(request) };
    });
  }

  /** List non-secret input-request metadata for one active session or typed job. */
  public async listEphemeralInputRequests(scope: { sessionId?: BrowserSessionId; jobId?: JobId }, actor?: Principal): Promise<EphemeralInputRequest[]> {
    if ((scope.sessionId === undefined) === (scope.jobId === undefined)) throw new FabricError("validation_failed", "input-request listing must target exactly one session or job", 400);
    return this.#store.read((state) => {
      const project = scope.jobId !== undefined ? this.#kernel.job(state, scope.jobId).project : this.#kernel.session(state, scope.sessionId!).project;
      this.#kernel.authorizeProject(state, actor, project, "read_ephemeral_input_requests", scope.jobId ?? scope.sessionId!);
      return [...state.inputRequests.values()]
        .filter((request) => (scope.jobId !== undefined ? request.jobId === scope.jobId : request.sessionId === scope.sessionId))
        .filter((request) => request.status === "pending" || request.status === "supplied")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((request) => structuredClone(request));
    });
  }

  /** Return input-request metadata (including the worker public key) without exposing a value. */
  public async getEphemeralInputRequest(requestId: EphemeralInputRequest["id"], actor?: Principal): Promise<InputRequestResponse> {
    return this.#store.read((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      this.#kernel.authorizeProject(state, actor, request.project, "read_ephemeral_input_request", requestId);
      if (request.status === "cancelled" || request.status === "expired" || request.status === "consumed") {
        throw new FabricError("invalid_state", `input request is ${request.status}`, 409);
      }
      return { request: structuredClone(request) };
    });
  }

  public async provideEphemeralInput(requestId: EphemeralInputRequest["id"], value: string, actor?: Principal): Promise<InputRequestResponse> {
    return this.#store.transact((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      this.#kernel.authorizeProject(state, actor, request.project, "provide_ephemeral_input", requestId);
      if (request.status !== "pending") throw new FabricError("invalid_state", `input request is ${request.status}`, 409);
      if (asDate(request.expiresAt) <= this.#clock.now().getTime()) {
        request.status = "expired";
        state.inputRequests.set(request.id, request);
        throw new FabricError("invalid_state", "input request has expired", 409);
      }
      if (!value || value.length > 16_384) throw new FabricError("validation_failed", "input value must be non-empty and at most 16KiB", 400);
      if (!request.leaseId) throw new FabricError("validation_failed", "media playback sources must be supplied as encrypted envelopes", 400);
      if (!this.#allowPlaintextEphemeralInputs || this.#ephemeralInputVault.putEnvelope) {
        throw new FabricError("validation_failed", "this scheduler uses encrypted input envelopes; call provideEncryptedEphemeralInput", 400);
      }
      this.#ephemeralInputVault.put(request, inputRequestWorker(this.#kernel, state, request), value);
      this.#kernel.markInputSupplied(state, request);
      this.#kernel.event(state, request.project, { kind: request.jobId ? "job" : "browser_session", id: request.jobId ?? request.sessionId! }, "ephemeral_input.supplied", { field: request.field, fieldType: request.fieldType });
      return { request: structuredClone(request) };
    });
  }

  /**
   * Accept a ciphertext-only envelope. The control plane validates scope and expiry but cannot
   * decrypt the value; the worker retrieves and decrypts it with its private key.
   */
  public async provideEncryptedEphemeralInput(requestId: EphemeralInputRequest["id"], envelope: EphemeralInputEnvelope, actor?: Principal): Promise<InputRequestResponse> {
    return this.#store.transact((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      this.#kernel.authorizeProject(state, actor, request.project, "provide_encrypted_ephemeral_input", requestId);
      if (!this.#ephemeralInputVault.putEnvelope) throw new FabricError("validation_failed", "encrypted ephemeral input is not configured for this scheduler", 400);
      // A client may retry after losing the HTTP response. Once the request is marked supplied,
      // treat the same scoped envelope submission as an idempotent acknowledgement; the external
      // ciphertext broker retains the one envelope for the worker to consume.
      if (request.status === "supplied") return { request: structuredClone(request) };
      if (request.status !== "pending") throw new FabricError("invalid_state", `input request is ${request.status}`, 409);
      if (request.expiresAt !== envelope.expiresAt || envelope.requestId !== request.id) throw new FabricError("authorization_denied", "encrypted input envelope does not match the request", 403);
      const assignedWorkerId = inputRequestWorker(this.#kernel, state, request);
      if (envelope.workerId !== assignedWorkerId) throw new FabricError("authorization_denied", "encrypted input envelope is addressed to another worker", 403);
      if (asDate(request.expiresAt) <= this.#clock.now().getTime()) throw new FabricError("invalid_state", "input request has expired", 409);
      this.#ephemeralInputVault.putEnvelope(envelope, request);
      this.#kernel.markInputSupplied(state, request);
      this.#kernel.event(state, request.project, { kind: request.jobId ? "job" : "browser_session", id: request.jobId ?? request.sessionId! }, "ephemeral_input.supplied", { field: request.field, fieldType: request.fieldType, encrypted: true });
      return { request: structuredClone(request) };
    });
  }

  /** One-time consumption; value is deleted from memory before the promise resolves. */
  public async consumeEphemeralInput(requestId: EphemeralInputRequest["id"], actor?: Principal): Promise<string> {
    return this.#store.transact((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      if (!request.leaseId) throw new FabricError("validation_failed", "media playback sources must be consumed by an encrypted worker channel", 400);
      const assignedWorkerId = inputRequestWorker(this.#kernel, state, request);
      this.#kernel.authorizeAssignedWorker(state, actor, assignedWorkerId, "consume_ephemeral_input", requestId);
      if (request.status !== "supplied") {
        this.#ephemeralInputVault.discard(request.id);
        request.status = "expired";
        state.inputRequests.set(request.id, request);
        throw new FabricError("invalid_state", "ephemeral input is unavailable", 409);
      }
      const value = this.#ephemeralInputVault.take(request, assignedWorkerId);
      request.status = "consumed";
      request.resolvedAt = now(this.#clock);
      state.inputRequests.set(request.id, request);
      return value;
    });
  }

  /** Worker-side one-shot ciphertext retrieval; plaintext never traverses this method. */
  public async takeEncryptedEphemeralInput(requestId: EphemeralInputRequest["id"], workerId: Worker["id"], actor?: Principal): Promise<EphemeralInputEnvelope> {
    return this.#store.transact((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      this.#kernel.authorizeWorker(state, actor, this.#kernel.worker(state, workerId), "take_encrypted_ephemeral_input");
      if (inputRequestWorker(this.#kernel, state, request) !== workerId) throw new FabricError("authorization_denied", "input request is assigned to another worker", 403);
      if (!this.#ephemeralInputVault.takeEnvelope) throw new FabricError("validation_failed", "encrypted ephemeral input is not configured", 400);
      if (request.status !== "supplied") throw new FabricError("invalid_state", `input request is ${request.status}`, 409);
      const envelope = this.#ephemeralInputVault.takeEnvelope(request, workerId);
      request.status = "consumed";
      request.resolvedAt = now(this.#clock);
      state.inputRequests.set(request.id, request);
      this.#kernel.event(state, request.project, { kind: request.jobId ? "job" : "browser_session", id: request.jobId ?? request.sessionId! }, "ephemeral_input.consumed", { field: request.field, fieldType: request.fieldType, encrypted: true });
      return envelope;
    });
  }

  /** Mark a ciphertext envelope consumed after an external transient broker has removed it. */
  public async markEncryptedInputConsumed(requestId: EphemeralInputRequest["id"], workerId: Worker["id"], actor?: Principal): Promise<void> {
    await this.#store.transact((state) => {
      const request = this.#kernel.inputRequest(state, requestId);
      this.#kernel.authorizeWorker(state, actor, this.#kernel.worker(state, workerId), "mark_encrypted_input_consumed");
      if (inputRequestWorker(this.#kernel, state, request) !== workerId) throw new FabricError("authorization_denied", "input request is assigned to another worker", 403);
      if (request.status !== "supplied") throw new FabricError("invalid_state", `input request is ${request.status}`, 409);
      request.status = "consumed";
      request.resolvedAt = now(this.#clock);
      state.inputRequests.set(request.id, request);
      this.#kernel.event(state, request.project, { kind: request.jobId ? "job" : "browser_session", id: request.jobId ?? request.sessionId! }, "ephemeral_input.consumed", { field: request.field, fieldType: request.fieldType, encrypted: true });
    });
  }

  /** Wait for the application-sidecar to supply a value, then consume it exactly once. */
  public async awaitEphemeralInput(requestId: EphemeralInputRequest["id"], options: { signal?: AbortSignal; pollMs?: number; actor?: Principal } = {}): Promise<string> {
    const pollMs = Math.max(10, Math.min(1_000, options.pollMs ?? 100));
    while (!(options.signal?.aborted ?? false)) {
      const snapshot = await this.#store.read((state) => this.#kernel.inputRequest(state, requestId));
      if (snapshot.status === "supplied") return this.consumeEphemeralInput(requestId, options.actor);
      if (snapshot.status === "cancelled" || snapshot.status === "expired" || snapshot.status === "consumed") {
        throw new FabricError("invalid_state", `ephemeral input is ${snapshot.status}`, 409);
      }
      if (asDate(snapshot.expiresAt) <= this.#clock.now().getTime()) {
        await this.recover();
        throw new FabricError("invalid_state", "ephemeral input request expired", 409);
      }
      await Bun.sleep(pollMs);
    }
    throw new FabricError("invalid_state", "ephemeral input wait was cancelled", 409);
  }

  public async attachArtifact(input: ArtifactInput, actor?: Principal): Promise<Artifact> {
    return this.#store.transact((state) => {
      const hasSessionOwner = input.sessionId !== undefined;
      const hasJobOwner = input.jobId !== undefined;
      const projectScopedManifest = !hasSessionOwner && !hasJobOwner && input.kind === "media_manifest" && input.project !== undefined;
      if (hasSessionOwner === hasJobOwner && !projectScopedManifest) {
        throw new FabricError("validation_failed", "artifact must belong to exactly one session/job or be a project-scoped media manifest", 400);
      }
      const sessionOwner = input.sessionId ? this.#kernel.session(state, input.sessionId) : undefined;
      const jobOwner = input.jobId ? this.#kernel.job(state, input.jobId) : undefined;
      const project = sessionOwner?.project ?? jobOwner?.project ?? input.project;
      if (!project) throw new FabricError("validation_failed", "artifact must belong to a session or job", 400);
      if (input.project !== undefined && input.project !== project) throw new FabricError("authorization_denied", "artifact project does not match its owner", 403);
      if (projectScopedManifest && input.profileRef !== undefined) throw new FabricError("validation_failed", "a project-scoped media manifest cannot reference a browser profile", 400);
      if (input.expectedWorkerId !== undefined) {
        if (
          !jobOwner ||
          jobOwner.runtime !== "media-relay" ||
          jobOwner.workerId !== input.expectedWorkerId ||
          (input.expectedMediaAttemptId !== undefined && jobOwner.mediaAttemptId !== input.expectedMediaAttemptId) ||
          jobOwner.status !== "running"
        ) {
          throw new FabricError("invalid_state", "media artifact result is no longer assigned to this worker", 409);
        }
      }
      // An artifact has exactly one owner. Do not compare a valid session profile against an
      // absent job owner (or vice versa): optional chaining turns that into an accidental denial.
      if (input.profileRef && sessionOwner && sessionOwner.profileRef !== input.profileRef) throw new FabricError("authorization_denied", "artifact profile does not match session profile", 403);
      if (input.profileRef && jobOwner && jobOwner.profileRef !== input.profileRef) throw new FabricError("authorization_denied", "artifact profile does not match job profile", 403);
      this.#kernel.authorizeProject(state, actor, project, "attach_artifact", input.objectKey);
      if (!/^sha256:[a-f0-9]{64}$/i.test(input.sha256)) throw new FabricError("validation_failed", "artifact sha256 must be a SHA-256 digest", 400);
      if (!safeArtifactObjectKey.test(input.objectKey) || input.objectKey.includes("//") || input.objectKey.includes("..")) throw new FabricError("validation_failed", "artifact object key is invalid", 400);
      if (typeof input.mimeType !== "string" || !input.mimeType || input.mimeType.length > 255 || /[\0\r\n]/.test(input.mimeType)) throw new FabricError("validation_failed", "artifact MIME type is invalid", 400);
      if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new FabricError("validation_failed", "artifact size must be non-negative", 400);
      const artifactPolicyRef = sessionOwner?.artifactPolicyRef ?? jobOwner?.artifactPolicyRef ?? input.artifactPolicyRef;
      const artifactPolicy = artifactPolicyRef ? this.#kernel.artifactPolicy(state, artifactPolicyRef) : undefined;
      if (!artifactPolicy?.allowedKinds.includes(input.kind)) throw new FabricError("validation_failed", `artifact kind ${input.kind} is not allowed by the owning policy`, 400);
      const defaultExpiry = after(this.#clock, (artifactPolicy?.retentionDays ?? 30) * 24 * 60 * 60);
      const expiresAt = input.expiresAt ?? defaultExpiry;
      if (!Number.isFinite(asDate(expiresAt)) || asDate(expiresAt) <= this.#clock.now().getTime()) throw new FabricError("validation_failed", "artifact expiry is invalid", 400);
      // A caller may shorten retention for a bounded workflow but cannot turn this internal field
      // into a policy bypass. The object-store writer can be another healthy replica, so its
      // canonical expiry is allowed a bounded five-minute clock-skew window beyond this replica's
      // local policy calculation. Larger divergence is rejected instead of silently extending
      // retention.
      if (asDate(expiresAt) > asDate(defaultExpiry) + ARTIFACT_EXPIRY_CLOCK_SKEW_MS) {
        throw new FabricError("validation_failed", "artifact expiry exceeds the owning policy retention", 400);
      }
      const existing = [...state.artifacts.values()].find((candidate) => candidate.objectKey === input.objectKey);
      if (existing) {
        if (
          existing.project !== project ||
          existing.sessionId !== input.sessionId ||
          existing.jobId !== input.jobId ||
          existing.profileRef !== input.profileRef ||
          existing.kind !== input.kind ||
          existing.sha256 !== input.sha256 ||
          existing.mimeType !== input.mimeType ||
          existing.sizeBytes !== input.sizeBytes
        ) throw new FabricError("conflict", "artifact object key is already bound to different metadata", 409);
        // Artifact collection may be retried after a lost response. The immutable object key is
        // the idempotency boundary; return the existing record instead of attempting a second
        // row insert (and, in PostgreSQL, violating the unique object-key constraint).
        return structuredClone(existing);
      }
      const artifact: Artifact = {
        id: createId("artifact"),
        project,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
        ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
        kind: input.kind,
        objectKey: input.objectKey,
        sha256: input.sha256,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdAt: now(this.#clock),
        expiresAt
      };
      state.artifacts.set(artifact.id, artifact);
      this.#kernel.event(
        state,
        project,
        input.jobId ? { kind: "job", id: input.jobId } : input.sessionId ? { kind: "browser_session", id: input.sessionId } : { kind: "artifact", id: artifact.id },
        "artifact.finalized",
        { kind: artifact.kind, sizeBytes: artifact.sizeBytes },
      );
      return structuredClone(artifact);
    });
  }

  public async recover(): Promise<{ expiredSessions: number; expiredJobs: number; offlineWorkers: number; expiredInputs: number; reconnectReleased: number }> {
    return this.#store.transact((state) => recoverSchedulerState(state, { clock: this.#clock, kernel: this.#kernel, assignmentClaimTimeoutSeconds: this.#assignmentClaimTimeoutSeconds }));
  }

  public async getSession(sessionId: BrowserSessionId, actor?: Principal): Promise<BrowserSessionResponse> {
    return getSession({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, sessionId, actor);
  }

  public async getJob(jobId: JobId, actor?: Principal): Promise<JobResponse> {
    return getJob({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, jobId, actor);
  }

  public async events(subject: { kind: "browser_session" | "job"; id: string }, actor?: Principal): Promise<FabricEvent[]> {
    return events({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, subject, actor);
  }

  public async eventsSince(subject: { kind: "browser_session" | "job"; id: string }, afterSequence = 0, actor?: Principal): Promise<FabricEvent[]> {
    return events({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, subject, actor, afterSequence);
  }

  public watchEvents(subject: { kind: "browser_session" | "job"; id: string }, options: { afterSequence?: number; signal?: AbortSignal; pollMs?: number; maxDurationMs?: number; actor?: Principal } = {}): AsyncGenerator<FabricEvent> {
    return watchEvents({ store: this.#store, clock: this.#clock, kernel: this.#kernel }, subject, options);
  }
}
