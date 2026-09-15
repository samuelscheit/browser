import { createId, FabricError, isMediaRuntime, type Artifact, type ArtifactPolicy, type AuditEvent, type BrowserLease, type BrowserRecipe, type BrowserSession, type BrowserSessionCreateInput, type BrowserSessionId, type BrowserSessionResponse, type EgressPolicy, type EphemeralInputRequest, type FabricEvent, type Job, type JobId, type JobResponse, type JobStatus, type LeaseMode, type Principal, type Profile, type ProfileClone, type ProjectId, type Worker, type WorkerAssignment } from "@browser-fabric/contracts";
import { assertRuntimePolicyCompatibility } from "@browser-fabric/policy";
import { RecipeRegistry, type RecipeDefinition } from "@browser-fabric/recipes";
import { CapabilitySigner } from "./capability";
import type { Clock } from "./clock";
import type { EphemeralInputVault } from "./ephemeral";
import { assertDurablePayload, safeFailureReason } from "./security";
import type { FabricState } from "./store";

const asDate = (iso: string) => new Date(iso).getTime();
const now = (clock: Clock) => clock.now().toISOString();
const after = (clock: Clock, seconds: number) => new Date(clock.now().getTime() + seconds * 1_000).toISOString();
const terminalSession = (status: BrowserSession["status"]): boolean => ["released", "cancelled", "failed", "timed_out"].includes(status);
const terminalJob = (status: JobStatus): boolean => ["succeeded", "failed", "blocked_challenge", "auth_required", "timed_out", "cancelled"].includes(status);
const boundedVolumeName = (base: string, suffix: string): string => {
  const normalized = `${base}${suffix}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z]+/, "fabric-");
  return normalized.slice(0, 128).replace(/[_.-]+$/, "") || "fabric-volume";
};

export interface SchedulerKernelOptions {
  clock: Clock;
  capabilitySigner: CapabilitySigner;
  recipes: RecipeRegistry;
  maxActiveBrowserLeases: number;
  reconnectGraceSeconds: number;
  maxExternalCdpConnections: number;
  assignmentClaimTimeoutSeconds: number;
  ephemeralInputVault?: EphemeralInputVault;
}

/** Pure state-transition kernel kept separate from the HTTP/service facade. */
export class SchedulerKernel {
  readonly #clock: Clock;
  readonly #capabilitySigner: CapabilitySigner;
  readonly #recipes: RecipeRegistry;
  readonly #maxActiveBrowserLeases: number;
  readonly #reconnectGraceSeconds: number;
  readonly #maxExternalCdpConnections: number;
  readonly #assignmentClaimTimeoutSeconds: number;
  readonly #ephemeralInputVault?: EphemeralInputVault;

  public constructor(options: SchedulerKernelOptions) {
    this.#clock = options.clock;
    this.#capabilitySigner = options.capabilitySigner;
    this.#recipes = options.recipes;
    this.#maxActiveBrowserLeases = options.maxActiveBrowserLeases;
    this.#reconnectGraceSeconds = options.reconnectGraceSeconds;
    this.#maxExternalCdpConnections = options.maxExternalCdpConnections;
    this.#assignmentClaimTimeoutSeconds = options.assignmentClaimTimeoutSeconds;
    this.#ephemeralInputVault = options.ephemeralInputVault;
  }

  public validateSessionInput(state: FabricState, input: BrowserSessionCreateInput): void {
    const recipe = this.recipe(state, input.browserRecipeRef) as RecipeDefinition;
    if (recipe.access !== "raw_cdp") throw new FabricError("validation_failed", `${recipe.ref} only supports typed jobs`, 400);
    if (input.runtime !== recipe.runtime) throw new FabricError("validation_failed", "runtime must match the selected recipe", 400);
    this.validateCommonReferences(state, input.project, recipe, input.profileRef, input.leaseMode, input.egressPolicyRef, input.artifactPolicyRef);
  }

  public validateCommonReferences(
    state: FabricState,
    project: ProjectId,
    recipe: BrowserRecipe,
    profileRef: Profile["ref"] | undefined,
    leaseMode: LeaseMode,
    egressPolicyRef: EgressPolicy["ref"],
    artifactPolicyRef: ArtifactPolicy["ref"]
  ): void {
    this.project(state, project);
    const egress = state.egressPolicies.get(egressPolicyRef);
    if (!egress) throw new FabricError("not_found", `egress policy ${egressPolicyRef} was not found`, 404);
    try {
      assertRuntimePolicyCompatibility(recipe.runtime, egress);
    } catch (error) {
      throw new FabricError("validation_failed", error instanceof Error ? error.message : "runtime and egress policy are incompatible", 400);
    }
    if (!state.artifactPolicies.has(artifactPolicyRef)) throw new FabricError("not_found", `artifact policy ${artifactPolicyRef} was not found`, 404);
    if (profileRef) {
      const profile = this.profile(state, profileRef);
      if (!profile.grants.includes(project)) throw new FabricError("authorization_denied", "project does not have a grant for this profile", 403);
      if (profile.status !== "active") throw new FabricError("conflict", `profile is ${profile.status}`, 409);
      if (profile.profileFamily !== recipe.profileFamily) throw new FabricError("validation_failed", "profile family is incompatible with browser recipe", 400);
    }
    if (recipe.runtime === "playwright-social" && !profileRef) {
      throw new FabricError("validation_failed", "Social jobs require a persistent Chromium profile", 400);
    }
    // `profileRef` is optional by contract. Without one, writer/interactive work receives a
    // disposable worker-local volume (represented on the lease) rather than silently sharing a
    // global profile. A clone request without a profile simply gets a fresh disposable volume.
    if (leaseMode === "interactive" && recipe.mode !== "interactive") throw new FabricError("validation_failed", "interactive lease requires an interactive recipe", 400);
    if (isMediaRuntime(recipe.runtime) && leaseMode !== "clone") throw new FabricError("validation_failed", "media-only work does not use profile writer leases", 400);
  }

  public assignSession(state: FabricState, session: BrowserSession, onlyWorkerId?: Worker["id"]): WorkerAssignment | undefined {
    const recipe = this.recipe(state, session.browserRecipeRef);
    const decision = this.selectWorker(state, session.project, recipe, session.profileRef, session.leaseMode, onlyWorkerId);
    if (!decision) return undefined;
    const { worker, profile } = decision;
    const lease = this.createLease(state, {
      sessionId: session.id,
      project: session.project,
      profile,
      worker,
      mode: session.leaseMode,
      expiresAt: session.expiresAt
    });
    // Allocation is deliberately not readiness.  A capability issued before Chromium has
    // started races the gateway against a non-existent CDP endpoint and makes a queued browser
    // look usable.  The worker/controller calls markLeaseStarted only after it has verified
    // browser-level `/json/version`; that transition materializes the capability.
    session.status = "allocating";
    session.workerId = worker.id;
    session.leaseId = lease.id;
    session.cdpEndpoint = undefined;
    session.cdpInternalEndpoint = undefined;
    session.cdpCapabilityExpiresAt = undefined;
    session.updatedAt = now(this.#clock);
    state.sessions.set(session.id, session);
    this.event(state, session.project, { kind: "browser_session", id: session.id }, "browser_session.allocating", { workerId: worker.id, leaseId: lease.id });
    return this.assignmentForLease(state, lease);
  }

  public assignJob(state: FabricState, job: Job, onlyWorkerId?: Worker["id"]): WorkerAssignment | undefined {
    const recipe = this.recipe(state, job.recipeRef);
    if (isMediaRuntime(job.runtime)) {
      const worker = [...state.workers.values()]
        .filter((candidate) => !candidate.isLocal && candidate.health === "healthy" && candidate.capabilities.runtimeFamilies.includes(job.runtime) && (candidate.activeMediaTasks ?? 0) < (candidate.mediaCapacity ?? 0) && (onlyWorkerId === undefined || candidate.id === onlyWorkerId))
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!worker) return undefined;
      job.status = "running";
      job.workerId = worker.id;
      job.mediaPlaybackReadyAt = undefined;
      job.mediaPlaybackSourceRequestId = undefined;
      worker.activeMediaTasks = (worker.activeMediaTasks ?? 0) + 1;
      worker.updatedAt = now(this.#clock);
      state.workers.set(worker.id, worker);
      job.updatedAt = now(this.#clock);
      // A media result capability is bound to this exact durable attempt. Reusing only job and
      // worker identity would let a delayed result from a prior retry reach a newly assigned task.
      job.mediaAttemptId = this.startAttempt(state, job, worker.id, undefined).id;
      state.jobs.set(job.id, job);
      this.event(state, job.project, { kind: "job", id: job.id }, "job.running", { workerId: worker.id, mediaOnly: true });
      return this.assignmentForMediaJob(state, job);
    }
    const decision = this.selectWorker(state, job.project, recipe, job.profileRef, job.leaseMode, onlyWorkerId);
    if (!decision) return undefined;
    const { worker, profile } = decision;
    const lease = this.createLease(state, {
      jobId: job.id,
      project: job.project,
      profile,
      worker,
      mode: job.leaseMode,
      expiresAt: job.expiresAt
    });
    job.status = "running";
    job.workerId = worker.id;
    job.leaseId = lease.id;
    job.updatedAt = now(this.#clock);
    state.jobs.set(job.id, job);
    this.startAttempt(state, job, worker.id, lease.id);
    this.event(state, job.project, { kind: "job", id: job.id }, "job.running", { workerId: worker.id, leaseId: lease.id });
    return this.assignmentForLease(state, lease);
  }

  public selectWorker(state: FabricState, project: ProjectId, recipe: BrowserRecipe, profileRef: Profile["ref"] | undefined, mode: LeaseMode, onlyWorkerId?: Worker["id"]): { worker: Worker; profile?: Profile } | undefined {
    let profile: Profile | undefined;
    if (profileRef) {
      profile = this.profile(state, profileRef);
      if (!profile.grants.includes(project) || profile.status !== "active") return undefined;
      if (mode === "clone" && [...state.leases.values()].some((lease) => lease.profileRef === profile!.ref && lease.status === "active" && (lease.mode === "writer" || lease.mode === "interactive"))) {
        // Local named volumes have no portable snapshot primitive. Wait for the exclusive writer
        // to release before copying so a clone cannot observe a torn browser profile transaction.
        return undefined;
      }
      if (mode !== "clone" && [...state.leases.values()].some((lease) => lease.profileRef === profile!.ref && lease.status === "active" && (lease.mode === "writer" || lease.mode === "interactive"))) {
        return undefined;
      }
    }
    if (!isMediaRuntime(recipe.runtime) && state.activeBrowserLeases >= this.#maxActiveBrowserLeases) return undefined;
    const activeLeases = [...state.leases.values()].filter((lease) => lease.status === "active");
    const activeManagedLeases = activeLeases.filter((lease) => !state.workers.get(lease.workerId)?.isLocal).length;
    const activeLocalLeases = activeLeases.length - activeManagedLeases;
    const candidates = [...state.workers.values()]
      .filter((worker) => worker.health === "healthy")
      .filter((worker) => worker.activeLeases < worker.capacity)
      .filter((worker) => worker.capabilities.runtimeFamilies.includes(recipe.runtime))
      .filter((worker) => worker.capabilities.recipeRefs.includes(recipe.ref))
      .filter((worker) => worker.capabilities.supportedProfileFamilies.includes(recipe.profileFamily))
      // Interactive Fabric workloads may run either on a federated local
      // worker or on a managed worker that explicitly advertises its private
      // Xvfb/interactive capability. A generic managed CDP worker remains
      // ineligible until provisioning enables this capability.
      .filter((worker) => recipe.mode !== "interactive" || worker.capabilities.supportsInteractive)
      .filter((worker) => profile === undefined || worker.id === profile.workerId)
      .filter((worker) => onlyWorkerId === undefined || worker.id === onlyWorkerId)
      .filter((worker) => worker.isLocal ? activeLocalLeases < 1 : activeManagedLeases < 3)
      .sort((left, right) => left.activeLeases - right.activeLeases || left.id.localeCompare(right.id));
    const worker = candidates[0];
    return worker ? { worker, ...(profile === undefined ? {} : { profile }) } : undefined;
  }

  public createLease(state: FabricState, input: { sessionId?: BrowserSessionId; jobId?: JobId; project: ProjectId; profile?: Profile; worker: Worker; mode: LeaseMode; expiresAt: string }): BrowserLease {
    const leaseId = createId("browser-lease");
    const endpointIdentity = leaseId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    // A local federated worker cannot accept an inbound connection from the gateway. Its agent
    // opens an outbound reverse relay keyed by this opaque lease instead of advertising a
    // loopback/private-overlay address. Managed workers use their constrained service template.
    const relayBase = input.worker.isLocal
      ? `reverse://${input.worker.id}/${leaseId}`
      : (() => {
          const relayTemplate = input.worker.cdpRelayEndpoint.replace(/\/$/, "");
          return relayTemplate.includes("{leaseId}") ? relayTemplate.replaceAll("{leaseId}", endpointIdentity) : `${relayTemplate}/leases/${endpointIdentity}`;
        })();
    const lease: BrowserLease = {
      id: leaseId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      project: input.project,
      ...(input.profile === undefined ? {} : { profileRef: input.profile.ref }),
      workerId: input.worker.id,
      // This route is reachable only over the private worker overlay/mTLS channel. Keeping the
      // path deterministic lets a gateway replica reconstruct it after a control-plane restart;
      // no bearer token is placed in durable state or a public URL.
      internalCdpEndpoint: relayBase,
      ...(input.profile === undefined ? { ephemeralVolumeName: `fabric-ephemeral-${leaseId.slice(-20)}` } : {}),
      mode: input.mode,
      status: "active",
      expiresAt: input.expiresAt,
      lastHeartbeatAt: now(this.#clock),
      createdAt: now(this.#clock)
    };
    if (input.mode === "clone" && input.profile) {
      const clone: ProfileClone = {
        id: createId("clone"),
        sourceProfileRef: input.profile.ref,
        workerId: input.worker.id,
        volumeName: boundedVolumeName(input.profile.volumeName, `-clone-${lease.id.slice(-12)}`),
        createdForLease: lease.id,
        status: "ready",
        createdAt: now(this.#clock)
      };
      lease.cloneId = clone.id;
      state.clones.set(clone.id, clone);
    }
    input.worker.activeLeases += 1;
    input.worker.updatedAt = now(this.#clock);
    state.workers.set(input.worker.id, input.worker);
    state.activeBrowserLeases += 1;
    state.leases.set(lease.id, lease);
    return lease;
  }

  public releaseSession(state: FabricState, session: BrowserSession, finalStatus: Extract<BrowserSession["status"], "released" | "cancelled" | "timed_out">, reason: string): void {
    if (terminalSession(session.status)) return;
    session.status = finalStatus;
    session.failureReason = finalStatus === "released" ? undefined : safeFailureReason(reason);
    session.releasedAt = now(this.#clock);
    session.updatedAt = session.releasedAt;
    session.externalConnectionCount = 0;
    session.reconnectGraceUntil = undefined;
    // A terminal response must never retain a usable CDP URL. The worker-only route and
    // capability are also cleared before the state is persisted or returned to an API caller.
    session.cdpEndpoint = undefined;
    session.cdpInternalEndpoint = undefined;
    session.cdpCapabilityExpiresAt = undefined;
    state.sessions.set(session.id, session);
    if (session.leaseId) this.releaseLease(state, this.lease(state, session.leaseId));
    this.cancelInputRequests(state, { sessionId: session.id });
    this.event(state, session.project, { kind: "browser_session", id: session.id }, `browser_session.${finalStatus}`, { reason: safeFailureReason(reason) });
  }

  public releaseLease(state: FabricState, lease: BrowserLease): void {
    if (lease.status !== "active") return;
    lease.status = "released";
    lease.releasedAt = now(this.#clock);
    lease.internalCdpEndpoint = undefined;
    state.leases.set(lease.id, lease);
    const worker = this.worker(state, lease.workerId);
    worker.activeLeases = Math.max(0, worker.activeLeases - 1);
    worker.updatedAt = now(this.#clock);
    state.workers.set(worker.id, worker);
    state.activeBrowserLeases = Math.max(0, state.activeBrowserLeases - 1);
    if (lease.cloneId) {
      const clone = state.clones.get(lease.cloneId);
      if (clone && clone.status !== "destroyed") {
        clone.status = "destroyed";
        clone.deletedAt = now(this.#clock);
        state.clones.set(clone.id, clone);
      }
    }
  }

  public releaseMediaTask(state: FabricState, job: Job): void {
    // The exact active attempt is the sole media-capacity ownership marker. Keeping a second
    // boolean made snapshot recovery vulnerable to stale derived state and duplicated the
    // attempt-binding authority used by worker/result verification.
    if (!isMediaRuntime(job.runtime) || job.mediaAttemptId === undefined) return;
    const worker = job.workerId ? state.workers.get(job.workerId) : undefined;
    // Invalidate any manager-issued result capability before a retry can become eligible.
    job.mediaAttemptId = undefined;
    job.mediaPlaybackReadyAt = undefined;
    job.mediaPlaybackSourceRequestId = undefined;
    state.jobs.set(job.id, job);
    if (!worker) return;
    worker.activeMediaTasks = Math.max(0, (worker.activeMediaTasks ?? 0) - 1);
    worker.updatedAt = now(this.#clock);
    state.workers.set(worker.id, worker);
  }

  public startAttempt(state: FabricState, job: Job, workerId: Worker["id"], leaseId: BrowserLease["id"] | undefined): import("@browser-fabric/contracts").JobAttempt {
    const previous = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id).sort((a, b) => b.number - a.number)[0];
    const attempt: import("@browser-fabric/contracts").JobAttempt = {
      id: createId("attempt"),
      jobId: job.id,
      number: (previous?.number ?? 0) + 1,
      workerId,
      ...(leaseId === undefined ? {} : { leaseId }),
      status: "running",
      createdAt: now(this.#clock)
    };
    state.attempts.set(attempt.id, attempt);
    return attempt;
  }

  public finishAttempt(state: FabricState, job: Job, status: "succeeded" | "failed" | "cancelled"): void {
    const attempts = [...state.attempts.values()].filter((attempt) => attempt.jobId === job.id && attempt.status === "running").sort((a, b) => b.number - a.number);
    const attempt = attempts[0];
    if (!attempt) return;
    attempt.status = status;
    attempt.completedAt = now(this.#clock);
    state.attempts.set(attempt.id, attempt);
  }

  public assignmentForLease(state: FabricState, lease: BrowserLease): WorkerAssignment {
    this.materializeLeaseEndpoint(state, lease);
    const session = lease.sessionId ? this.session(state, lease.sessionId) : undefined;
    const job = lease.jobId ? this.job(state, lease.jobId) : undefined;
    const recipe = this.recipe(state, session?.browserRecipeRef ?? job!.recipeRef);
    return {
      lease: structuredClone(lease),
      ...(session === undefined ? {} : { session: structuredClone(session) }),
      ...(job === undefined ? {} : { job: structuredClone(job) }),
      recipe: structuredClone(recipe),
      egressPolicy: structuredClone(this.egress(state, session?.egressPolicyRef ?? job!.egressPolicyRef)),
      artifactPolicy: structuredClone(this.artifactPolicy(state, session?.artifactPolicyRef ?? job!.artifactPolicyRef)),
      ...(lease.profileRef === undefined ? {} : { profile: structuredClone(this.profile(state, lease.profileRef)) }),
      ...(lease.cloneId === undefined ? {} : { clone: structuredClone(state.clones.get(lease.cloneId)!) })
    };
  }

  public materializeLeaseEndpoint(state: FabricState, lease: BrowserLease): void {
    if (lease.internalCdpEndpoint) return;
    const worker = this.worker(state, lease.workerId);
    const endpointIdentity = lease.id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    lease.internalCdpEndpoint = worker.isLocal
      ? `reverse://${worker.id}/${lease.id}`
      : (() => {
          const template = worker.cdpRelayEndpoint.replace(/\/$/, "");
          return template.includes("{leaseId}") ? template.replaceAll("{leaseId}", endpointIdentity) : `${template}/leases/${endpointIdentity}`;
        })();
    state.leases.set(lease.id, lease);
  }

  /** Re-issue volatile capability material after a process/replca restart without persisting it. */
  public materializeSessionCapability(state: FabricState, session: BrowserSession): void {
    if (!session.workerId || !session.leaseId || terminalSession(session.status)) return;
    if (session.status !== "ready" && session.status !== "active") return;
    if (asDate(session.expiresAt) <= this.#clock.now().getTime()) return;
    const worker = this.worker(state, session.workerId);
    const lease = this.lease(state, session.leaseId);
    if (lease.status !== "active" || !lease.startedAt) return;
    this.materializeLeaseEndpoint(state, lease);
    const capability = this.#capabilitySigner.issue({
      sessionId: session.id,
      project: session.project,
      ...(session.profileRef === undefined ? {} : { profileRef: session.profileRef }),
      workerId: worker.id,
      ttlSeconds: Math.min(3_600, Math.max(1, Math.floor((asDate(session.expiresAt) - this.#clock.now().getTime()) / 1_000)))
    });
    session.cdpEndpoint = capability.endpoint;
    session.cdpInternalEndpoint = lease.internalCdpEndpoint;
    session.cdpCapabilityExpiresAt = capability.expiresAt;
    session.updatedAt = now(this.#clock);
    state.sessions.set(session.id, session);
  }

  public assignmentForMediaJob(state: FabricState, job: Job): WorkerAssignment {
    return {
      job: structuredClone(job),
      recipe: structuredClone(this.recipe(state, job.recipeRef)),
      egressPolicy: structuredClone(this.egress(state, job.egressPolicyRef)),
      artifactPolicy: structuredClone(this.artifactPolicy(state, job.artifactPolicyRef))
    };
  }

  public discardInput(requestId: EphemeralInputRequest["id"]): void { this.#ephemeralInputVault?.discard(requestId); }

  public cancelInputRequests(state: FabricState, scope: { sessionId?: BrowserSessionId; jobId?: JobId }): void {
    for (const request of state.inputRequests.values()) {
      if ((scope.sessionId && request.sessionId === scope.sessionId) || (scope.jobId && request.jobId === scope.jobId)) {
        if (request.status === "pending" || request.status === "supplied") {
          request.status = "cancelled";
          request.resolvedAt = now(this.#clock);
          state.inputRequests.set(request.id, request);
        }
        this.#ephemeralInputVault?.discard(request.id);
      }
    }
  }

  public markInputSupplied(state: FabricState, request: EphemeralInputRequest): void {
    request.status = "supplied";
    request.resolvedAt = now(this.#clock);
    state.inputRequests.set(request.id, request);
    if (request.jobId) {
      const job = this.job(state, request.jobId);
      const pendingForJob = [...state.inputRequests.values()].some(
        (candidate) => candidate.jobId === job.id && candidate.status === "pending" && asDate(candidate.expiresAt) > this.#clock.now().getTime(),
      );
      if (job.status === "awaiting_input" && !pendingForJob) {
        job.status = "running";
        job.updatedAt = now(this.#clock);
        state.jobs.set(job.id, job);
      }
    }
  }

  public event(state: FabricState, project: ProjectId | undefined, subject: FabricEvent["subject"], type: string, payload: FabricEvent["payload"]): void {
    const event: FabricEvent = {
      id: createId("event"),
      sequence: ++state.eventSequence,
      project,
      subject,
      type,
      payload: structuredClone(payload),
      createdAt: now(this.#clock)
    };
    state.events.set(event.id, event);
  }

  public audit(state: FabricState, actor: Principal | undefined, project: ProjectId | undefined, action: string, target: AuditEvent["target"], outcome: AuditEvent["outcome"], metadata: AuditEvent["metadata"]): void {
    const audit: AuditEvent = {
      id: createId("audit-event"),
      actor: actor?.id ?? ("principal_system" as Principal["id"]),
      ...(project === undefined ? {} : { project }),
      action,
      target,
      outcome,
      metadata,
      createdAt: now(this.#clock)
    };
    state.audits.set(audit.id, audit);
  }

  public project(state: FabricState, id: ProjectId) {
    const project = state.projects.get(id);
    if (!project || !project.active) throw new FabricError("not_found", `active project ${id} was not found`, 404);
    return project;
  }
  public worker(state: FabricState, id: Worker["id"]) {
    const worker = state.workers.get(id);
    if (!worker) throw new FabricError("not_found", `worker ${id} was not found`, 404);
    return worker;
  }
  public profile(state: FabricState, ref: Profile["ref"]) {
    const profile = state.profiles.get(ref);
    if (!profile) throw new FabricError("not_found", `profile ${ref} was not found`, 404);
    return profile;
  }
  public session(state: FabricState, id: BrowserSessionId) {
    const session = state.sessions.get(id);
    if (!session) throw new FabricError("not_found", `browser session ${id} was not found`, 404);
    return session;
  }
  public lease(state: FabricState, id: BrowserLease["id"]) {
    const lease = state.leases.get(id);
    if (!lease) throw new FabricError("not_found", `browser lease ${id} was not found`, 404);
    return lease;
  }
  public job(state: FabricState, id: JobId) {
    const job = state.jobs.get(id);
    if (!job) throw new FabricError("not_found", `job ${id} was not found`, 404);
    return job;
  }
  public inputRequest(state: FabricState, id: EphemeralInputRequest["id"]) {
    const request = state.inputRequests.get(id);
    if (!request) throw new FabricError("not_found", `input request ${id} was not found`, 404);
    return request;
  }
  public recipe(state: FabricState, ref: BrowserRecipe["ref"]) {
    const recipe = state.recipes.get(ref);
    if (!recipe) throw new FabricError("not_found", `recipe ${ref} was not found`, 404);
    return recipe;
  }
  public egress(state: FabricState, ref: EgressPolicy["ref"]) {
    const policy = state.egressPolicies.get(ref);
    if (!policy) throw new FabricError("not_found", `egress policy ${ref} was not found`, 404);
    return policy;
  }
  public artifactPolicy(state: FabricState, ref: ArtifactPolicy["ref"]) {
    const policy = state.artifactPolicies.get(ref);
    if (!policy) throw new FabricError("not_found", `artifact policy ${ref} was not found`, 404);
    return policy;
  }

  public authorizeProject(state: FabricState, actor: Principal | undefined, project: ProjectId, action: string, target: string): void {
    this.project(state, project);
    if (!actor) return; // Internal call paths run under mTLS service identity, validated at the API boundary.
    const registered = this.authorizeIdentity(state, actor, action, target);
    const permitted = !registered || registered.roles.includes("fabric_admin") || (registered.projectGrants.includes(project) && registered.roles.some((role) => role === "project_admin" || role === "project_operator" || (action.startsWith("read_") && role === "project_reader")));
    if (!permitted) {
      this.audit(state, actor, project, action, { kind: "authorization", id: target }, "denied", {});
      throw new FabricError("authorization_denied", `principal cannot ${action} for project ${project}`, 403);
    }
  }

  public authorizeIdentity(state: FabricState, actor: Principal | undefined, action: string, target: string): Principal | undefined {
    if (!actor) return undefined;
    const registered = state.principals.get(actor.id);
    if (!registered || registered.certificateFingerprint !== actor.certificateFingerprint) {
      this.audit(state, actor, undefined, action, { kind: "authorization", id: target }, "denied", { reason: "unregistered_or_mismatched_principal" });
      throw new FabricError("authorization_denied", "principal is not registered for this Fabric deployment", 403);
    }
    return registered;
  }

  public authorizeFabricAdmin(state: FabricState, actor: Principal | undefined, action: string, target: string): void {
    if (!actor) return;
    const registered = this.authorizeIdentity(state, actor, action, target);
    if (registered && !registered.roles.includes("fabric_admin")) {
      this.audit(state, actor, undefined, action, { kind: "authorization", id: target }, "denied", {});
      throw new FabricError("authorization_denied", `principal cannot ${action}`, 403);
    }
  }

  public authorizeWorker(state: FabricState, actor: Principal | undefined, worker: Worker, action: string): void {
    if (!actor) return;
    if (actor.certificateFingerprint !== worker.certificateFingerprint && !actor.roles.includes("fabric_admin")) {
      this.audit(state, actor, undefined, action, { kind: "worker", id: worker.id }, "denied", {});
      throw new FabricError("authorization_denied", "worker certificate does not match assignment", 403);
    }
  }

  public authorizeAssignedWorker(state: FabricState, actor: Principal | undefined, workerId: Worker["id"] | undefined, action: string, target: string): void {
    if (!workerId) throw new FabricError("invalid_state", "work has no assigned worker", 409);
    this.authorizeWorker(state, actor, this.worker(state, workerId), action);
  }
}
