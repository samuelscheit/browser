import {
  createId,
  canonicalJson,
  FabricError,
  type Artifact,
  type ArtifactPolicy,
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
  type Profile,
  type ProfileClone,
  type ProjectId,
  type RuntimeFamily,
  type Worker,
  type WorkerAssignment,
  terminalBrowserSessionStatuses,
  terminalJobStatuses
} from "@browser-fabric/contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import { assertRuntimePolicyCompatibility, builtInChallengeSets, builtInEgressPolicies } from "@browser-fabric/policy";
import { RecipeRegistry, type RecipeDefinition, validateTypedOperation } from "@browser-fabric/recipes";
import { CapabilitySigner } from "./capability";
import { type Clock, SystemClock } from "./clock";
import { EncryptedInputRouter, type EphemeralInputEnvelope, type EphemeralInputVault } from "./ephemeral";
import { assertDurablePayload, safeFailureReason, scalarMetadata } from "./security";
import { type FabricState, type FabricStore, InMemoryFabricStore } from "./store";
import { SchedulerKernel } from "./scheduler-kernel";
import { recoverSchedulerState } from "./scheduler-recovery";
import { events, getJob, getSession, watchEvents } from "./scheduler-events";
import { getProfile as adminGetProfile, listProfiles as adminListProfiles, listWorkers as adminListWorkers, getWorker as adminGetWorker, setWorkerHealth as adminSetWorkerHealth, revokeProfile as adminRevokeProfile } from "./scheduler-admin";

export interface BrowserSchedulerOptions {
  store?: FabricStore;
  clock?: Clock;
  capabilitySigner?: CapabilitySigner;
  recipes?: RecipeRegistry;
  maxActiveBrowserLeases?: number;
  reconnectGraceSeconds?: number;
  maxExternalCdpConnections?: number;
  assignmentClaimTimeoutSeconds?: number;
  /** Production should inject a worker-local/E2E encrypted channel; memory is for local tests. */
  ephemeralInputVault?: EphemeralInputVault;
  /** Plaintext convenience endpoint is disabled for production stores by default. */
  allowPlaintextEphemeralInputs?: boolean;
}

export interface ArtifactInput {
  sessionId?: BrowserSessionId;
  jobId?: JobId;
  profileRef?: Profile["ref"];
  kind: Artifact["kind"];
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

export interface InputRequestResponse {
  request: EphemeralInputRequest;
  /** Never expose the supplied value in the control plane response. */
}

const isTerminalSession = (status: BrowserSession["status"]): boolean => terminalBrowserSessionStatuses.includes(status as never);
const isTerminalJob = (status: JobStatus): boolean => terminalJobStatuses.includes(status as never);
const asDate = (iso: string) => new Date(iso).getTime();
const now = (clock: Clock) => clock.now().toISOString();
const after = (clock: Clock, seconds: number) => new Date(clock.now().getTime() + seconds * 1_000).toISOString();
const defaultArtifactRef = "artifact-policy_standard-30-days@1" as ArtifactPolicy["ref"];

function requestFingerprint(scope: string, payload: unknown): string {
  return `${scope}:sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function idempotencyKey(project: ProjectId, scope: "browser_session" | "job", key: string): string {
  return `${project}:${scope}:${key}`;
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
        })
  };
}

function jobResponse(job: Job): JobResponse {
  return {
    id: job.id,
    status: job.status,
    expiresAt: job.expiresAt,
    ...(job.workerId === undefined ? {} : { workerId: job.workerId }),
    ...(job.result === undefined ? {} : { result: structuredClone(job.result) })
  };
}

export class BrowserScheduler {
  readonly #store: FabricStore;
  readonly #clock: Clock;
  readonly #capabilitySigner: CapabilitySigner;
  readonly #recipes: RecipeRegistry;
  readonly #maxActiveBrowserLeases: number;
  readonly #reconnectGraceSeconds: number;
  readonly #maxExternalCdpConnections: number;
  readonly #assignmentClaimTimeoutSeconds: number;
  /** Ephemeral values live only in process memory and never enter FabricState. */
  readonly #ephemeralInputVault: EphemeralInputVault;
  readonly #allowPlaintextEphemeralInputs: boolean;
  readonly #kernel: SchedulerKernel;

  public constructor(options: BrowserSchedulerOptions = {}) {
    this.#store = options.store ?? new InMemoryFabricStore();
    this.#clock = options.clock ?? new SystemClock();
    this.#capabilitySigner = options.capabilitySigner ?? new CapabilitySigner({ secret: "development-only-capability-secret-change-me", clock: this.#clock });
    this.#recipes = options.recipes ?? new RecipeRegistry();
    this.#maxActiveBrowserLeases = options.maxActiveBrowserLeases ?? 4;
    this.#reconnectGraceSeconds = options.reconnectGraceSeconds ?? 60;
    this.#maxExternalCdpConnections = options.maxExternalCdpConnections ?? 1;
    this.#assignmentClaimTimeoutSeconds = options.assignmentClaimTimeoutSeconds ?? 30;
    this.#ephemeralInputVault = options.ephemeralInputVault ?? new EncryptedInputRouter();
    this.#allowPlaintextEphemeralInputs = options.allowPlaintextEphemeralInputs ?? false;
    if (!Number.isInteger(this.#maxActiveBrowserLeases) || this.#maxActiveBrowserLeases < 1 || this.#maxActiveBrowserLeases > 4) {
      throw new Error("Browser Fabric global browser capacity must be an integer from one to four");
    }
    if (!Number.isInteger(this.#assignmentClaimTimeoutSeconds) || this.#assignmentClaimTimeoutSeconds < 5 || this.#assignmentClaimTimeoutSeconds > 300) throw new Error("assignment claim timeout must be between 5 and 300 seconds");
    this.#kernel = new SchedulerKernel({
      clock: this.#clock,
      capabilitySigner: this.#capabilitySigner,
      recipes: this.#recipes,
      maxActiveBrowserLeases: this.#maxActiveBrowserLeases,
      reconnectGraceSeconds: this.#reconnectGraceSeconds,
      maxExternalCdpConnections: this.#maxExternalCdpConnections,
      assignmentClaimTimeoutSeconds: this.#assignmentClaimTimeoutSeconds,
      ephemeralInputVault: this.#ephemeralInputVault
    });
  }

  public get store(): FabricStore {
    return this.#store;
  }

  /** Exposes only the vault interface; implementations must keep values/envelopes worker-local. */
  public get ephemeralInputVault(): EphemeralInputVault {
    return this.#ephemeralInputVault;
  }

  public async bootstrap(input: { projects?: readonly { id: ProjectId; name: string }[]; principals?: readonly Principal[] } = {}): Promise<void> {
    await this.#store.transact((state) => {
      for (const policy of builtInEgressPolicies) state.egressPolicies.set(policy.ref, structuredClone(policy));
      for (const recipe of this.#recipes.list()) state.recipes.set(recipe.ref, structuredClone(recipe));
      for (const challengeSet of builtInChallengeSets) state.challengeSets.set(challengeSet.ref, structuredClone(challengeSet));
      for (const recipe of state.recipes.values()) {
        if (recipe.challengeHandlerSetRef && !state.challengeSets.has(recipe.challengeHandlerSetRef)) {
          throw new Error(`recipe ${recipe.ref} references a missing challenge handler set ${recipe.challengeHandlerSetRef}`);
        }
      }
      state.artifactPolicies.set(defaultArtifactRef, this.#recipes.getArtifactPolicy(defaultArtifactRef));
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

  public async registerWorker(worker: Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt"> & Partial<Pick<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt">>, actor?: Principal): Promise<Worker> {
    return this.#store.transact((state) => {
      this.#kernel.authorizeFabricAdmin(state, actor, "register_worker", worker.id);
      if (!/^worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(worker.id) || !worker.certificateFingerprint || worker.certificateFingerprint.length > 512) throw new FabricError("validation_failed", "worker identity is invalid", 400);
      for (const family of worker.capabilities.runtimeFamilies) if (!["chromium-cdp", "patchright", "rebrowser-puppeteer", "playwright-social", "companion", "media-relay"].includes(family)) throw new FabricError("validation_failed", "worker runtime capability is invalid", 400);
      if (worker.capacity < 0 || worker.capacity > 4) throw new FabricError("validation_failed", "worker capacity must be from 0 to 4", 400);
      if (worker.isLocal && worker.capacity !== 1) throw new FabricError("validation_failed", "the federated local worker must have exactly one interactive lease capacity", 400);
      if (!worker.isLocal && worker.capacity > 3) throw new FabricError("validation_failed", "managed fabric-host workers may host at most three leases in aggregate", 400);
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
   * Worker-side registration refresh. The worker must already be provisioned by a Fabric admin
   * and prove possession of its per-worker enrollment token on every control-channel request.
   */
  public async refreshWorkerRegistration(worker: Omit<Worker, "activeLeases" | "createdAt" | "updatedAt" | "lastHeartbeatAt" | "enrollmentTokenHash">, certificateFingerprint: string, enrollmentToken: string): Promise<Worker> {
    return this.#store.transact((state) => {
      const existing = this.#kernel.worker(state, worker.id);
      if (existing.certificateFingerprint !== certificateFingerprint || worker.certificateFingerprint !== certificateFingerprint) throw new FabricError("authorization_denied", "worker certificate does not match its provisioned identity", 403);
      if (!matchesEnrollmentToken(existing.enrollmentTokenHash, enrollmentToken)) throw new FabricError("authentication_required", "worker enrollment token is invalid", 401);
      // A worker cannot use refresh to expand its powers or relocate persistent profile volumes.
      if (JSON.stringify(existing.capabilities) !== JSON.stringify(worker.capabilities) || existing.capacity !== worker.capacity || existing.isLocal !== worker.isLocal || JSON.stringify(existing.resourceLimits) !== JSON.stringify(worker.resourceLimits) || JSON.stringify(existing.volumeNames) !== JSON.stringify(worker.volumeNames) || existing.endpoint !== worker.endpoint || existing.cdpRelayEndpoint !== worker.cdpRelayEndpoint) {
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

  public async heartbeatWorker(workerId: Worker["id"], actor?: Principal, resource?: Partial<Pick<Worker, "capacity" | "health" | "mediaCapacity">>): Promise<Worker> {
    return this.#store.transact((state) => {
      const worker = this.#kernel.worker(state, workerId);
      this.#kernel.authorizeWorker(state, actor, worker, "heartbeat_worker");
      if (resource?.capacity !== undefined) {
        if (resource.capacity < worker.activeLeases || resource.capacity > (worker.isLocal ? 1 : 3)) {
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
      assertDurablePayload(input.operation);
      const effectiveLeaseMode = input.leaseMode ?? (recipe.runtime === "media-relay" ? "clone" : "writer");
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
        lease.assignmentClaimedAt = now(this.#clock);
        state.leases.set(lease.id, lease);
        if (lease.sessionId) {
          const session = this.#kernel.session(state, lease.sessionId);
          if (session.status === "ready") {
            session.status = "active";
            session.updatedAt = now(this.#clock);
            state.sessions.set(session.id, session);
            this.#kernel.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.active", { workerId });
          }
          return this.#kernel.assignmentForLease(state, lease);
        }
        if (lease.jobId) {
          const job = this.#kernel.job(state, lease.jobId);
          job.assignmentClaimedAt = now(this.#clock);
          job.updatedAt = now(this.#clock);
          state.jobs.set(job.id, job);
          return this.#kernel.assignmentForLease(state, lease);
        }
      }
      if (jobId) {
        const job = this.#kernel.job(state, jobId);
        if (job.runtime !== "media-relay" || job.workerId !== workerId || job.status !== "running") {
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
        if (job.runtime !== "media-relay" || job.workerId !== workerId || job.status !== "running" || job.assignmentClaimedAt) continue;
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
        if (job.runtime !== "media-relay" || job.workerId !== workerId || job.status !== "running") continue;
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
      lease.startedAt ??= lease.lastHeartbeatAt;
      state.leases.set(lease.id, lease);
      return structuredClone(lease);
    });
  }

  public async registerExternalCdpConnection(sessionId: BrowserSessionId, capability: string): Promise<void> {
    await this.#store.transact((state) => {
      const session = this.#kernel.session(state, sessionId);
      if (!session.workerId) throw new FabricError("invalid_state", "session does not have an allocated worker", 409);
      this.#capabilitySigner.verify(capability, { sessionId, project: session.project, profileRef: session.profileRef, workerId: session.workerId });
      if (!(session.status === "ready" || session.status === "active")) throw new FabricError("invalid_state", "CDP is unavailable for this session", 409);
      if (session.externalConnectionCount >= this.#maxExternalCdpConnections) throw new FabricError("conflict", "only one external CDP connection is allowed", 409);
      session.externalConnectionCount += 1;
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

  /** Record a bounded retry performed by a recipe while retaining its current lease. */
  public async beginJobRetry(jobId: JobId, actor?: Principal): Promise<number> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeAssignedWorker(state, actor, job.workerId, "retry_job", jobId);
      if (job.status !== "running") throw new FabricError("invalid_state", `cannot retry a ${job.status} job`, 409);
      const recipe = this.#kernel.recipe(state, job.recipeRef) as RecipeDefinition;
      const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id);
      if (attempts.length >= recipe.maxAttempts) throw new FabricError("conflict", "recipe retry budget is exhausted", 409);
      this.#kernel.finishAttempt(state, job, "failed");
      this.#kernel.startAttempt(state, job, job.workerId!, job.leaseId);
      this.#kernel.event(state, job.project, { kind: "job", id: job.id }, "job.retry_started", { attempt: attempts.length + 1 });
      return attempts.length + 1;
    });
  }

  public async failJob(jobId: JobId, status: Extract<JobStatus, "failed" | "blocked_challenge" | "awaiting_manual" | "auth_required">, reason: string, actor?: Principal): Promise<JobResponse> {
    return this.#store.transact((state) => {
      const job = this.#kernel.job(state, jobId);
      this.#kernel.authorizeAssignedWorker(state, actor, job.workerId, "fail_job", jobId);
      if (isTerminalJob(job.status)) throw new FabricError("invalid_state", `job is already ${job.status}`, 409);
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
      if (input.jobId && lease.jobId !== input.jobId) throw new FabricError("authorization_denied", "lease does not belong to this job", 403);
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
      this.#kernel.event(state, lease.project, { kind: input.jobId ? "job" : "browser_session", id: input.jobId ?? input.sessionId! }, "ephemeral_input.requested", { field: input.field, fieldType: input.fieldType });
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
      if (!this.#allowPlaintextEphemeralInputs || this.#ephemeralInputVault.putEnvelope) {
        throw new FabricError("validation_failed", "this scheduler uses encrypted input envelopes; call provideEncryptedEphemeralInput", 400);
      }
      this.#ephemeralInputVault.put(request, this.#kernel.lease(state, request.leaseId).workerId, value);
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
      const lease = this.#kernel.lease(state, request.leaseId);
      if (envelope.workerId !== lease.workerId) throw new FabricError("authorization_denied", "encrypted input envelope is addressed to another worker", 403);
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
      const lease = this.#kernel.lease(state, request.leaseId);
      this.#kernel.authorizeAssignedWorker(state, actor, lease.workerId, "consume_ephemeral_input", requestId);
      if (request.status !== "supplied") {
        this.#ephemeralInputVault.discard(request.id);
        request.status = "expired";
        state.inputRequests.set(request.id, request);
        throw new FabricError("invalid_state", "ephemeral input is unavailable", 409);
      }
      const value = this.#ephemeralInputVault.take(request, lease.workerId);
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
      const lease = this.#kernel.lease(state, request.leaseId);
      this.#kernel.authorizeWorker(state, actor, this.#kernel.worker(state, workerId), "take_encrypted_ephemeral_input");
      if (lease.workerId !== workerId) throw new FabricError("authorization_denied", "input request is assigned to another worker", 403);
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
      const lease = this.#kernel.lease(state, request.leaseId);
      this.#kernel.authorizeWorker(state, actor, this.#kernel.worker(state, workerId), "mark_encrypted_input_consumed");
      if (lease.workerId !== workerId) throw new FabricError("authorization_denied", "input request is assigned to another worker", 403);
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
      if ((input.sessionId === undefined) === (input.jobId === undefined)) throw new FabricError("validation_failed", "artifact must belong to exactly one session or job", 400);
      const sessionOwner = input.sessionId ? this.#kernel.session(state, input.sessionId) : undefined;
      const jobOwner = input.jobId ? this.#kernel.job(state, input.jobId) : undefined;
      const project = sessionOwner?.project ?? jobOwner?.project;
      if (!project) throw new FabricError("validation_failed", "artifact must belong to a session or job", 400);
      if (input.profileRef && sessionOwner?.profileRef !== input.profileRef) throw new FabricError("authorization_denied", "artifact profile does not match session profile", 403);
      if (input.profileRef && jobOwner?.profileRef !== input.profileRef) throw new FabricError("authorization_denied", "artifact profile does not match job profile", 403);
      this.#kernel.authorizeProject(state, actor, project, "attach_artifact", input.objectKey);
      if (!/^sha256:[a-f0-9]{64}$/i.test(input.sha256)) throw new FabricError("validation_failed", "artifact sha256 must be a SHA-256 digest", 400);
      if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new FabricError("validation_failed", "artifact size must be non-negative", 400);
      const artifactPolicyRef = sessionOwner?.artifactPolicyRef ?? jobOwner?.artifactPolicyRef;
      const artifactPolicy = artifactPolicyRef ? this.#kernel.artifactPolicy(state, artifactPolicyRef) : undefined;
      if (!artifactPolicy?.allowedKinds.includes(input.kind)) throw new FabricError("validation_failed", `artifact kind ${input.kind} is not allowed by the owning policy`, 400);
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
        expiresAt: after(this.#clock, (artifactPolicy?.retentionDays ?? 30) * 24 * 60 * 60)
      };
      state.artifacts.set(artifact.id, artifact);
      this.#kernel.event(state, project, { kind: input.jobId ? "job" : "browser_session", id: input.jobId ?? input.sessionId! }, "artifact.finalized", { kind: artifact.kind, sizeBytes: artifact.sizeBytes });
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
