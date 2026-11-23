import {
  terminalBrowserSessionStatuses,
  terminalJobStatuses,
  type Artifact,
  type ArtifactPolicy,
  type AuditEvent,
  type BrowserLease,
  type BrowserRecipe,
  type BrowserSession,
  type ChallengeHandlerSet,
  type EgressPolicy,
  type EphemeralInputRequest,
  type FabricEvent,
  type IdempotencyRecord,
  type Job,
  type JobAttempt,
  type Principal,
  type Profile,
  type ProfileClone,
  type Project,
  type VolumeGeneration,
  type Worker
} from "@browser-fabric/contracts";
import { isDeepStrictEqual } from "node:util";
import { Mutex } from "./mutex";

// A durable snapshot is a crash-recovery checkpoint, not an audit log. Keeping every full JSON
// state forever makes heartbeat-heavy deployments grow without bound and eventually blocks the
// control plane on multi-gigabyte snapshot scans. Retain a bounded recent window and keep the
// normalized tables/events as the queryable history.
const STATE_SNAPSHOT_RETENTION = 100;
const STATE_SNAPSHOT_PRUNE_INTERVAL = 25;

// Only browser-session and job events are served from the hot state (the per-subject event
// APIs). Worker and profile events are durable telemetry: they are appended to fabric_events
// and then dropped from the state, so worker registration churn cannot grow every snapshot.
const HOT_EVENT_SUBJECTS: ReadonlySet<FabricEvent["subject"]["kind"]> = new Set(["browser_session", "job"]);

// Terminal sessions and jobs stay hot for a bounded window so clients can still read their final
// status, events, and idempotent replays; afterwards they live only in the normalized tables.
const TERMINAL_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set(terminalBrowserSessionStatuses);
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(terminalJobStatuses);

/**
 * Drop terminal sessions/jobs older than the retention window, with every record that only
 * exists to describe them. A subject stays hot while anything live can still resolve it: an
 * unexpired artifact listing, a pending input request, or a lease that has not been released.
 */
function evictTerminalHistory(state: FabricState, nowMs: number, retentionMs: number): void {
  const pinned = new Set<string>();
  for (const artifact of state.artifacts.values()) {
    if (Date.parse(artifact.expiresAt) <= nowMs) continue;
    if (artifact.sessionId) pinned.add(artifact.sessionId);
    if (artifact.jobId) pinned.add(artifact.jobId);
  }
  for (const request of state.inputRequests.values()) {
    if (request.status !== "pending" && request.status !== "supplied") continue;
    if (request.sessionId) pinned.add(request.sessionId);
    if (request.jobId) pinned.add(request.jobId);
  }
  for (const lease of state.leases.values()) {
    if (lease.status !== "active" && lease.status !== "releasing") continue;
    if (lease.sessionId) pinned.add(lease.sessionId);
    if (lease.jobId) pinned.add(lease.jobId);
  }
  const cutoff = nowMs - retentionMs;
  const evicted = new Set<string>();
  for (const session of state.sessions.values()) {
    if (TERMINAL_SESSION_STATUSES.has(session.status) && Date.parse(session.releasedAt ?? session.updatedAt) <= cutoff && !pinned.has(session.id)) evicted.add(session.id);
  }
  for (const job of state.jobs.values()) {
    if (TERMINAL_JOB_STATUSES.has(job.status) && Date.parse(job.updatedAt) <= cutoff && !pinned.has(job.id)) evicted.add(job.id);
  }
  if (evicted.size === 0) return;
  const evictedLeases = new Set<string>();
  for (const [id, lease] of state.leases) {
    const owner = lease.sessionId ?? lease.jobId;
    if (owner === undefined || !evicted.has(owner)) continue;
    state.leases.delete(id);
    evictedLeases.add(id);
  }
  for (const [id, clone] of state.clones) if (clone.status === "destroyed" && evictedLeases.has(clone.createdForLease)) state.clones.delete(id);
  for (const [id, attempt] of state.attempts) if (evicted.has(attempt.jobId)) state.attempts.delete(id);
  for (const [id, event] of state.events) if (evicted.has(event.subject.id)) state.events.delete(id);
  for (const [id, record] of state.idempotency) if (evicted.has(record.responseId)) state.idempotency.delete(id);
  for (const [id, request] of state.inputRequests) {
    if ((request.sessionId && evicted.has(request.sessionId)) || (request.jobId && evicted.has(request.jobId))) state.inputRequests.delete(id);
  }
  for (const id of evicted) {
    state.sessions.delete(id);
    state.jobs.delete(id);
  }
}

/** Map key for idempotent create replays; reloaded snapshots must index records the same way. */
export function idempotencyKey(project: string, scope: IdempotencyRecord["scope"], key: string): string {
  return `${project}:${scope}:${key}`;
}

/** Entities that are new or differ from the pre-transaction state; all of them without a base. */
function changedValues<T>(current: Map<string, T>, previous: Map<string, T> | undefined): Iterable<T> {
  if (previous === undefined) return current.values();
  return [...current].filter(([id, value]) => {
    const before = previous.get(id);
    return before === undefined || !isDeepStrictEqual(before, value);
  }).map(([, value]) => value);
}

export interface FabricState {
  projects: Map<string, Project>;
  principals: Map<string, Principal>;
  workers: Map<string, Worker>;
  recipes: Map<string, BrowserRecipe>;
  egressPolicies: Map<string, EgressPolicy>;
  challengeSets: Map<string, ChallengeHandlerSet>;
  artifactPolicies: Map<string, ArtifactPolicy>;
  profiles: Map<string, Profile>;
  volumeGenerations: Map<string, VolumeGeneration>;
  sessions: Map<string, BrowserSession>;
  leases: Map<string, BrowserLease>;
  clones: Map<string, ProfileClone>;
  jobs: Map<string, Job>;
  attempts: Map<string, JobAttempt>;
  events: Map<string, FabricEvent>;
  artifacts: Map<string, Artifact>;
  inputRequests: Map<string, EphemeralInputRequest>;
  idempotency: Map<string, IdempotencyRecord>;
  audits: Map<string, AuditEvent>;
  eventSequence: number;
  queueSequence: number;
  activeBrowserLeases: number;
}

export function emptyFabricState(): FabricState {
  return {
    projects: new Map(),
    principals: new Map(),
    workers: new Map(),
    recipes: new Map(),
    egressPolicies: new Map(),
    challengeSets: new Map(),
    artifactPolicies: new Map(),
    profiles: new Map(),
    volumeGenerations: new Map(),
    sessions: new Map(),
    leases: new Map(),
    clones: new Map(),
    jobs: new Map(),
    attempts: new Map(),
    events: new Map(),
    artifacts: new Map(),
    inputRequests: new Map(),
    idempotency: new Map(),
    audits: new Map(),
    eventSequence: 0,
    queueSequence: 0,
    activeBrowserLeases: 0
  };
}

function cloneState(state: FabricState): FabricState {
  return structuredClone(state);
}

export interface FabricStore {
  transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T>;
  read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T>;
  snapshot(): Promise<FabricState>;
}

/** In-process store used by development and tests. Transactions use copy-on-write drafts. */
export class InMemoryFabricStore implements FabricStore {
  protected state: FabricState;
  protected readonly mutex = new Mutex();

  public constructor(initial?: FabricState) {
    this.state = cloneState(initial ?? emptyFabricState());
  }

  public async transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const draft = cloneState(this.state);
      const result = await operation(draft);
      await this.persistDraft(draft);
      this.state = draft;
      return result;
    });
  }

  public async read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => operation(cloneState(this.state)));
  }

  public async snapshot(): Promise<FabricState> {
    return this.read((snapshot) => snapshot);
  }

  protected async persistDraft(_draft: FabricState): Promise<void> {
    // Hook for durable implementations.
  }

  protected replaceState(next: FabricState): void {
    this.state = cloneState(next);
  }
}

export interface SqlClient {
  query<T = unknown>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: T[] }>;
  /** Executes `operation` on one database connection inside one SQL transaction when supported. */
  withTransaction?<T>(operation: (transaction: SqlClient) => Promise<T>): Promise<T>;
  /** Pin a cross-process coordination lock to one database session when supported. */
  withAdvisoryLock?<T>(key: string, operation: (client: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * PostgreSQL-backed store. The normalized schema is created by deploy/postgres/001_initial.sql;
 * a compact JSON projection makes recovery deterministic while the entity tables remain queryable.
 */
export class PostgresFabricStore extends InMemoryFabricStore {
  readonly #client: SqlClient;
  readonly #schemaSql: string;
  #initialized = false;
  #initializing?: Promise<void>;
  #persistedSequence = -1;
  readonly #now: () => number;
  readonly #terminalHistoryRetentionMs: number;

  public constructor(client: SqlClient, schemaSql: string, options: { now?: () => number; terminalHistoryRetentionMs?: number } = {}) {
    super();
    this.#client = client;
    this.#schemaSql = schemaSql;
    this.#now = options.now ?? Date.now;
    this.#terminalHistoryRetentionMs = options.terminalHistoryRetentionMs ?? TERMINAL_HISTORY_RETENTION_MS;
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    const initializing = this.#initializing ??= this.#initialize();
    try {
      await initializing;
    } finally {
      if (this.#initializing === initializing) this.#initializing = undefined;
    }
  }

  async #initialize(): Promise<void> {
    const initialize = async (client: SqlClient): Promise<void> => {
      await client.query(this.#schemaSql);
      await this.#loadLatestState(client, false);
    };
    if (this.#client.withAdvisoryLock) await this.#client.withAdvisoryLock("browser-fabric-schema", initialize);
    else await initialize(this.#client);
    this.#initialized = true;
  }

  /**
   * PostgreSQL deployments coordinate schedulers with a transaction-scoped advisory lock.
   * The in-memory mutex still protects this process, while the database lock protects sibling
   * API/scheduler replicas from allocating the same worker/profile concurrently.
   */
  public override async transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    return this.mutex.run(async () => {
      const previousState = cloneState(this.state);
      const previousPersistedSequence = this.#persistedSequence;
      const run = async (transaction: SqlClient): Promise<T> => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext('browser-fabric-schema'))");
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext('browser-fabric-scheduler'))");
        // Lock in a stable order so concurrent schedulers cannot race worker/profile capacity
        // or deadlock while one replica is dispatching and another is recovering.
        await transaction.query("SELECT id FROM fabric_capacity WHERE id = 1 FOR UPDATE");
        await transaction.query("SELECT id FROM fabric_workers ORDER BY id FOR UPDATE");
        await transaction.query("SELECT ref FROM fabric_profiles ORDER BY ref FOR UPDATE");
        await transaction.query("SELECT id FROM fabric_browser_leases WHERE status = 'active' ORDER BY id FOR UPDATE");
        await this.#loadLatestState(transaction, false);
        const projectionBase = cloneState(this.state);
        const draft = cloneState(this.state);
        const result = await operation(draft);
        // Idle scheduler recover/dispatch ticks and idempotent replays frequently leave state
        // unchanged; skip the normalized upserts and ~1 MB JSONB snapshot insert on no-ops.
        if (!isDeepStrictEqual(draft, projectionBase)) {
          await this.persistNormalizedProjection(draft, transaction, projectionBase);
        }
        this.state = draft;
        return result;
      };
      if (this.#client.withTransaction) {
        try {
          return await this.#client.withTransaction(run);
        } catch (error) {
          this.state = previousState;
          this.#persistedSequence = previousPersistedSequence;
          throw error;
        }
      }
      // Test adapters that do not expose a dedicated connection still get explicit transaction
      // semantics. The production PgSqlClient always takes the `withTransaction` branch.
      await this.#client.query("BEGIN");
      try {
        const result = await run(this.#client);
        await this.#client.query("COMMIT");
        return result;
      } catch (error) {
        await this.#client.query("ROLLBACK");
        this.state = previousState;
        this.#persistedSequence = previousPersistedSequence;
        throw error;
      }
    });
  }

  public override async read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    return this.mutex.run(async () => {
      await this.#loadLatestState(this.#client, false);
      return operation(cloneState(this.state));
    });
  }

  protected override async persistDraft(draft: FabricState): Promise<void> {
    if (!this.#initialized) return;
    await this.persistNormalizedProjection(draft);
  }

  async #loadLatestState(client: SqlClient, recoverProcessState: boolean): Promise<void> {
    const result = await client.query<{ sequence: string | number; state: string | Record<string, unknown> }>("SELECT sequence, state FROM fabric_state_snapshots ORDER BY sequence DESC LIMIT 1");
    const persistedSequence = Number(result.rows[0]?.sequence ?? -1);
    if (!recoverProcessState && persistedSequence <= this.#persistedSequence) return;
    const raw = result.rows[0]?.state;
    if (!raw) return;
    const loaded = deserializeState(typeof raw === "string" ? JSON.parse(raw) : raw, { recoverProcessState });
    if (!recoverProcessState) {
      // Snapshots intentionally omit volatile CDP URLs/tokens. Preserve values issued by this
      // process when the durable revision is reloaded, while accepting all durable state changes
      // made by sibling API/scheduler replicas.
      for (const [id, session] of loaded.sessions) {
        const previous = this.state.sessions.get(id);
        if (!previous) continue;
        // Volatile capability material may be carried across a sibling revision only while the
        // same live lease remains started. If the durable state moved back to allocation or
        // terminal cleanup, retaining the old URL would resurrect a revoked browser endpoint.
        const preserveCapability =
          (session.status === "ready" || session.status === "active") &&
          (previous.status === "ready" || previous.status === "active") &&
          session.leaseId !== undefined &&
          session.leaseId === previous.leaseId;
        if (preserveCapability) {
          session.cdpEndpoint = previous.cdpEndpoint;
          session.cdpInternalEndpoint = previous.cdpInternalEndpoint;
          session.cdpCapabilityExpiresAt = previous.cdpCapabilityExpiresAt;
          session.externalConnectionCount = previous.externalConnectionCount;
        } else {
          session.cdpEndpoint = undefined;
          session.cdpInternalEndpoint = undefined;
          session.cdpCapabilityExpiresAt = undefined;
          session.externalConnectionCount = 0;
          session.reconnectGraceUntil = undefined;
        }
        loaded.sessions.set(id, session);
      }
      for (const [id, lease] of loaded.leases) {
        const previous = this.state.leases.get(id);
        if (!previous) continue;
        if (lease.status === "active" && previous.status === "active" && lease.workerId === previous.workerId) {
          lease.internalCdpEndpoint = previous.internalCdpEndpoint;
        } else {
          lease.internalCdpEndpoint = undefined;
        }
        loaded.leases.set(id, lease);
      }
    }
    this.replaceState(loaded);
    this.#persistedSequence = persistedSequence;
  }

  private async persistNormalizedProjection(
    draft: FabricState,
    client: SqlClient = this.#client,
    previous?: FabricState,
  ): Promise<void> {
    const revisionResult = await client.query<{ next: string | number }>("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM fabric_state_snapshots");
    const sequence = Number(revisionResult.rows[0]?.next ?? 1);
    // Keep the normalized tables queryable as well as the compact crash-recovery snapshot. Every
    // statement runs inside the caller's transaction; a failed projection rolls back the whole
    // state transition rather than leaving an allocation half-written. Given the pre-transaction
    // state, only new or changed rows are written; the tables already hold everything else.
    for (const project of changedValues(draft.projects, previous?.projects)) {
      await client.query("INSERT INTO fabric_projects(id,name,active,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active", [project.id, project.name, project.active, project.createdAt]);
    }
    // System-authored profile grants need a durable principal to satisfy the foreign key. This
    // principal has no project grants and cannot authenticate to the public API.
    await client.query("INSERT INTO fabric_principals(id,display_name,certificate_fingerprint,roles,created_at) VALUES ('principal_system','Browser Fabric system','system-internal',ARRAY['system'],now()) ON CONFLICT (id) DO NOTHING");
    for (const principal of changedValues(draft.principals, previous?.principals)) {
      await client.query("INSERT INTO fabric_principals(id,display_name,certificate_fingerprint,roles,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,certificate_fingerprint=EXCLUDED.certificate_fingerprint,roles=EXCLUDED.roles", [principal.id, principal.displayName, principal.certificateFingerprint, principal.roles, principal.createdAt]);
      await client.query("DELETE FROM fabric_principal_projects WHERE principal_id=$1", [principal.id]);
      for (const projectId of principal.projectGrants) await client.query("INSERT INTO fabric_principal_projects(principal_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [principal.id, projectId]);
    }
    for (const worker of changedValues(draft.workers, previous?.workers)) {
      await client.query("INSERT INTO fabric_workers(id,certificate_fingerprint,enrollment_token_hash,input_encryption_public_key_pem,endpoint,cdp_relay_endpoint,runtime_families,recipe_refs,browser_versions,supported_profile_families,supports_interactive,capacity,active_leases,is_local,volume_names,cpu_milli,memory_mib,pids,shm_mib,temporary_storage_mib,health,last_heartbeat_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT (id) DO UPDATE SET certificate_fingerprint=EXCLUDED.certificate_fingerprint,enrollment_token_hash=EXCLUDED.enrollment_token_hash,input_encryption_public_key_pem=EXCLUDED.input_encryption_public_key_pem,endpoint=EXCLUDED.endpoint,cdp_relay_endpoint=EXCLUDED.cdp_relay_endpoint,runtime_families=EXCLUDED.runtime_families,recipe_refs=EXCLUDED.recipe_refs,browser_versions=EXCLUDED.browser_versions,supported_profile_families=EXCLUDED.supported_profile_families,supports_interactive=EXCLUDED.supports_interactive,capacity=EXCLUDED.capacity,active_leases=EXCLUDED.active_leases,is_local=EXCLUDED.is_local,volume_names=EXCLUDED.volume_names,cpu_milli=EXCLUDED.cpu_milli,memory_mib=EXCLUDED.memory_mib,pids=EXCLUDED.pids,shm_mib=EXCLUDED.shm_mib,temporary_storage_mib=EXCLUDED.temporary_storage_mib,health=EXCLUDED.health,last_heartbeat_at=EXCLUDED.last_heartbeat_at,updated_at=EXCLUDED.updated_at", [worker.id, worker.certificateFingerprint, worker.enrollmentTokenHash ?? null, worker.inputEncryptionPublicKeyPem ?? null, worker.endpoint, worker.cdpRelayEndpoint, worker.capabilities.runtimeFamilies, worker.capabilities.recipeRefs, JSON.stringify(worker.capabilities.browserVersions), worker.capabilities.supportedProfileFamilies, worker.capabilities.supportsInteractive, worker.capacity, worker.activeLeases, worker.isLocal, worker.volumeNames, worker.resourceLimits.cpuMilli, worker.resourceLimits.memoryMiB, worker.resourceLimits.pids, worker.resourceLimits.shmMiB, worker.resourceLimits.temporaryStorageMiB, worker.health, worker.lastHeartbeatAt, worker.createdAt, worker.updatedAt]);
    }
    for (const recipe of changedValues(draft.recipes, previous?.recipes)) await client.query("INSERT INTO fabric_recipes(ref,family,version,immutable_hash,runtime,definition,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (ref) DO UPDATE SET definition=EXCLUDED.definition", [recipe.ref, recipe.family, recipe.version, recipe.immutableHash, recipe.runtime, JSON.stringify(recipe), recipe.createdAt]);
    for (const policy of changedValues(draft.egressPolicies, previous?.egressPolicies)) await client.query("INSERT INTO fabric_egress_policies(ref,family,version,immutable_hash,definition,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (ref) DO UPDATE SET definition=EXCLUDED.definition", [policy.ref, policy.family, policy.version, policy.immutableHash, JSON.stringify(policy), policy.createdAt]);
    for (const challenge of changedValues(draft.challengeSets, previous?.challengeSets)) await client.query("INSERT INTO fabric_challenge_handler_sets(ref,family,version,immutable_hash,definition,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (ref) DO UPDATE SET definition=EXCLUDED.definition", [challenge.ref, challenge.family, challenge.version, challenge.immutableHash, JSON.stringify(challenge), challenge.createdAt]);
    for (const policy of changedValues(draft.artifactPolicies, previous?.artifactPolicies)) await client.query("INSERT INTO fabric_artifact_policies(ref,retention_days,allowed_kinds,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO UPDATE SET retention_days=EXCLUDED.retention_days,allowed_kinds=EXCLUDED.allowed_kinds", [policy.ref, policy.retentionDays, policy.allowedKinds, policy.createdAt]);
    for (const profile of changedValues(draft.profiles, previous?.profiles)) {
      await client.query("INSERT INTO fabric_profiles(ref,owner_project_id,worker_id,volume_name,profile_family,volume_generation,status,last_health_check_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (ref) DO UPDATE SET owner_project_id=EXCLUDED.owner_project_id,worker_id=EXCLUDED.worker_id,volume_name=EXCLUDED.volume_name,profile_family=EXCLUDED.profile_family,volume_generation=EXCLUDED.volume_generation,status=EXCLUDED.status,last_health_check_at=EXCLUDED.last_health_check_at,updated_at=EXCLUDED.updated_at", [profile.ref, profile.ownerProject, profile.workerId, profile.volumeName, profile.profileFamily, profile.volumeGeneration, profile.status, profile.lastHealthCheckAt ?? null, profile.createdAt, profile.updatedAt]);
      await client.query("DELETE FROM fabric_profile_grants WHERE profile_ref=$1", [profile.ref]);
      for (const projectId of profile.grants) await client.query("INSERT INTO fabric_profile_grants(profile_ref,project_id,granted_by,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [profile.ref, projectId, "principal_system", profile.createdAt]);
    }
    for (const generation of changedValues(draft.volumeGenerations, previous?.volumeGenerations)) await client.query("INSERT INTO fabric_volume_generations(id,profile_ref,generation,worker_id,volume_name,status,checksum,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,checksum=EXCLUDED.checksum", [generation.id, generation.profileRef, generation.generation, generation.workerId, generation.volumeName, generation.status, generation.checksum ?? null, generation.createdAt]);
    for (const session of changedValues(draft.sessions, previous?.sessions)) await client.query("INSERT INTO fabric_browser_sessions(id,project_id,idempotency_key,runtime,browser_recipe_ref,profile_ref,lease_mode,egress_policy_ref,artifact_policy_ref,metadata,status,queue_sequence,worker_id,lease_id,cdp_endpoint,cdp_capability_expires_at,max_external_connections,external_connection_count,reconnect_grace_until,expires_at,last_heartbeat_at,created_at,updated_at,released_at,failure_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,NULL,NULL,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,queue_sequence=EXCLUDED.queue_sequence,worker_id=EXCLUDED.worker_id,lease_id=EXCLUDED.lease_id,metadata=EXCLUDED.metadata,max_external_connections=EXCLUDED.max_external_connections,external_connection_count=EXCLUDED.external_connection_count,reconnect_grace_until=EXCLUDED.reconnect_grace_until,expires_at=EXCLUDED.expires_at,last_heartbeat_at=EXCLUDED.last_heartbeat_at,updated_at=EXCLUDED.updated_at,released_at=EXCLUDED.released_at,failure_reason=EXCLUDED.failure_reason", [session.id, session.project, session.idempotencyKey, session.runtime, session.browserRecipeRef, session.profileRef ?? null, session.leaseMode, session.egressPolicyRef, session.artifactPolicyRef, JSON.stringify(session.metadata), session.status, session.queueSequence ?? 0, session.workerId ?? null, session.leaseId ?? null, session.maxExternalConnections ?? 1, session.externalConnectionCount, session.reconnectGraceUntil ?? null, session.expiresAt, session.lastHeartbeatAt, session.createdAt, session.updatedAt, session.releasedAt ?? null, session.failureReason ?? null]);
    for (const job of changedValues(draft.jobs, previous?.jobs)) await client.query("INSERT INTO fabric_jobs(id,project_id,idempotency_key,recipe_ref,runtime,operation,profile_ref,lease_mode,egress_policy_ref,artifact_policy_ref,callback_url,callback_secret_ref,metadata,status,queue_sequence,worker_id,lease_id,result,failure_reason,assignment_claimed_at,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,queue_sequence=EXCLUDED.queue_sequence,worker_id=EXCLUDED.worker_id,lease_id=EXCLUDED.lease_id,result=EXCLUDED.result,failure_reason=EXCLUDED.failure_reason,assignment_claimed_at=EXCLUDED.assignment_claimed_at,updated_at=EXCLUDED.updated_at", [job.id, job.project, job.idempotencyKey, job.recipeRef, job.runtime, JSON.stringify(job.operation), job.profileRef ?? null, job.leaseMode, job.egressPolicyRef, job.artifactPolicyRef, job.callback?.url ?? null, job.callback?.eventSecretRef ?? null, JSON.stringify(job.metadata), job.status, job.queueSequence ?? 0, job.workerId ?? null, job.leaseId ?? null, job.result === undefined ? null : JSON.stringify(job.result), job.failureReason ?? null, job.assignmentClaimedAt ?? null, job.expiresAt, job.createdAt, job.updatedAt]);
    for (const lease of changedValues(draft.leases, previous?.leases)) await client.query("INSERT INTO fabric_browser_leases(id,session_id,job_id,project_id,profile_ref,worker_id,mode,clone_id,status,expires_at,last_heartbeat_at,assignment_claimed_at,started_at,created_at,released_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,last_heartbeat_at=EXCLUDED.last_heartbeat_at,assignment_claimed_at=EXCLUDED.assignment_claimed_at,started_at=EXCLUDED.started_at,released_at=EXCLUDED.released_at", [lease.id, lease.sessionId ?? null, lease.jobId ?? null, lease.project, lease.profileRef ?? null, lease.workerId, lease.mode, lease.cloneId ?? null, lease.status, lease.expiresAt, lease.lastHeartbeatAt, lease.assignmentClaimedAt ?? null, lease.startedAt ?? null, lease.createdAt, lease.releasedAt ?? null]);
    for (const clone of changedValues(draft.clones, previous?.clones)) await client.query("INSERT INTO fabric_profile_clones(id,source_profile_ref,worker_id,volume_name,created_for_lease,status,created_at,deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,deleted_at=EXCLUDED.deleted_at", [clone.id, clone.sourceProfileRef, clone.workerId, clone.volumeName, clone.createdForLease, clone.status, clone.createdAt, clone.deletedAt ?? null]);
    for (const attempt of changedValues(draft.attempts, previous?.attempts)) await client.query("INSERT INTO fabric_job_attempts(id,job_id,attempt_number,worker_id,lease_id,status,created_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,completed_at=EXCLUDED.completed_at", [attempt.id, attempt.jobId, attempt.number, attempt.workerId ?? null, attempt.leaseId ?? null, attempt.status, attempt.createdAt, attempt.completedAt ?? null]);
    const newEvents = previous === undefined
      ? draft.events.values()
      : [...draft.events.values()].filter((event) => !previous.events.has(event.id));
    for (const event of newEvents) await client.query("INSERT INTO fabric_events(id,sequence,project_id,subject_kind,subject_id,type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (id) DO NOTHING", [event.id, event.sequence, event.project ?? null, event.subject.kind, event.subject.id, event.type, JSON.stringify(event.payload), event.createdAt]);
    for (const [id, event] of draft.events) {
      if (!HOT_EVENT_SUBJECTS.has(event.subject.kind)) draft.events.delete(id);
    }
    for (const artifact of changedValues(draft.artifacts, previous?.artifacts)) await client.query("INSERT INTO fabric_artifacts(id,project_id,session_id,job_id,profile_ref,kind,object_key,sha256,mime_type,size_bytes,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET expires_at=EXCLUDED.expires_at", [artifact.id, artifact.project, artifact.sessionId ?? null, artifact.jobId ?? null, artifact.profileRef ?? null, artifact.kind, artifact.objectKey, artifact.sha256, artifact.mimeType, artifact.sizeBytes, artifact.createdAt, artifact.expiresAt]);
    for (const request of changedValues(draft.inputRequests, previous?.inputRequests)) await client.query("INSERT INTO fabric_ephemeral_input_requests(id,project_id,session_id,job_id,lease_id,worker_id,worker_input_encryption_public_key_pem,field,field_type,status,expires_at,created_at,resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,resolved_at=EXCLUDED.resolved_at", [request.id, request.project, request.sessionId ?? null, request.jobId ?? null, request.leaseId, request.workerId ?? null, request.workerInputEncryptionPublicKeyPem ?? null, request.field, request.fieldType, request.status, request.expiresAt, request.createdAt, request.resolvedAt ?? null]);
    const newIdempotencyRecords = previous === undefined
      ? draft.idempotency.values()
      : [...draft.idempotency].filter(([key]) => !previous.idempotency.has(key)).map(([, record]) => record);
    for (const record of newIdempotencyRecords) await client.query("INSERT INTO fabric_idempotency(id,project_id,scope,key,request_hash,response_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id,scope,key) DO UPDATE SET request_hash=EXCLUDED.request_hash,response_id=EXCLUDED.response_id", [record.id, record.project, record.scope, record.key, record.requestHash, record.responseId, record.createdAt]);
    const newAudits = previous === undefined
      ? draft.audits.values()
      : [...draft.audits.values()].filter((audit) => !previous.audits.has(audit.id));
    for (const audit of newAudits) await client.query("INSERT INTO fabric_audit_events(id,actor_id,project_id,action,target_kind,target_id,outcome,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (id) DO NOTHING", [audit.id, audit.actor, audit.project ?? null, audit.action, audit.target.kind, audit.target.id, audit.outcome, JSON.stringify(audit.metadata), audit.createdAt]);
    // Audits are append-only records that no state reader consults; keep them in the table only.
    draft.audits.clear();
    await client.query("INSERT INTO fabric_capacity(id,active_browser_leases,updated_at) VALUES (1,$1,now()) ON CONFLICT (id) DO UPDATE SET active_browser_leases=EXCLUDED.active_browser_leases,updated_at=now()", [draft.activeBrowserLeases]);
    evictTerminalHistory(draft, this.#now(), this.#terminalHistoryRetentionMs);
    const serialized = JSON.stringify(serializeState(draft));
    await client.query("INSERT INTO fabric_state_snapshots(sequence, state) VALUES ($1, $2::jsonb) ON CONFLICT (sequence) DO UPDATE SET state = EXCLUDED.state, created_at = now()", [sequence, serialized]);
    if (sequence % STATE_SNAPSHOT_PRUNE_INTERVAL === 0) {
      const cutoff = sequence - STATE_SNAPSHOT_RETENTION;
      if (cutoff > 0) {
        await client.query("DELETE FROM fabric_state_snapshots WHERE sequence < $1", [cutoff]);
      }
    }
    this.#persistedSequence = sequence;
  }
}

/** Serialize Maps without leaking ephemeral values (the vault is intentionally not part of FabricState). */
export function serializeState(state: FabricState): Record<string, unknown> {
  // Capability URLs and worker-only CDP routes are intentionally ephemeral. They must never
  // reach PostgreSQL snapshots (a restart reissues capabilities after a fresh worker claim).
  const sessions = [...state.sessions.values()].map((session) => {
    const persisted = structuredClone(session) as unknown as Record<string, unknown>;
    delete persisted.cdpEndpoint;
    delete persisted.cdpInternalEndpoint;
    delete persisted.cdpCapabilityExpiresAt;
    return persisted;
  });
  const leases = [...state.leases.values()].map((lease) => {
    const persisted = structuredClone(lease) as unknown as Record<string, unknown>;
    delete persisted.internalCdpEndpoint;
    return persisted;
  });
  return {
    projects: [...state.projects.values()],
    principals: [...state.principals.values()],
    workers: [...state.workers.values()],
    recipes: [...state.recipes.values()],
    egressPolicies: [...state.egressPolicies.values()],
    challengeSets: [...state.challengeSets.values()],
    artifactPolicies: [...state.artifactPolicies.values()],
    profiles: [...state.profiles.values()],
    volumeGenerations: [...state.volumeGenerations.values()],
    sessions,
    leases,
    clones: [...state.clones.values()],
    jobs: [...state.jobs.values()],
    attempts: [...state.attempts.values()],
    events: [...state.events.values()],
    artifacts: [...state.artifacts.values()],
    inputRequests: [...state.inputRequests.values()],
    idempotency: [...state.idempotency.values()],
    audits: [...state.audits.values()],
    eventSequence: state.eventSequence,
    queueSequence: state.queueSequence,
    activeBrowserLeases: state.activeBrowserLeases
  };
}

export function deserializeState(raw: Record<string, unknown>, options: { recoverProcessState?: boolean } = {}): FabricState {
  const state = emptyFabricState();
  const map = <T>(key: string, keyOf: (item: T) => string): Map<string, T> => new Map(((raw[key] as T[] | undefined) ?? []).map((item) => [keyOf(item), item]));
  state.projects = map("projects", (item) => String((item as { id: string }).id));
  state.principals = map("principals", (item) => String((item as { id: string }).id));
  state.workers = map("workers", (item) => String((item as { id: string }).id));
  state.recipes = map("recipes", (item) => String((item as { ref: string }).ref));
  state.egressPolicies = map("egressPolicies", (item) => String((item as { ref: string }).ref));
  state.challengeSets = map("challengeSets", (item) => String((item as { ref: string }).ref));
  state.artifactPolicies = map("artifactPolicies", (item) => String((item as { ref: string }).ref));
  state.profiles = map("profiles", (item) => String((item as { ref: string }).ref));
  state.volumeGenerations = map("volumeGenerations", (item) => String((item as { id: string }).id));
  state.sessions = map("sessions", (item) => String((item as { id: string }).id));
  state.leases = map("leases", (item) => String((item as { id: string }).id));
  state.clones = map("clones", (item) => String((item as { id: string }).id));
  state.jobs = map("jobs", (item) => String((item as { id: string }).id));
  state.attempts = map("attempts", (item) => String((item as { id: string }).id));
  state.events = map("events", (item) => String((item as { id: string }).id));
  state.artifacts = map("artifacts", (item) => String((item as { id: string }).id));
  state.inputRequests = map("inputRequests", (item) => String((item as { id: string }).id));
  state.idempotency = map("idempotency", (item) => {
    const record = item as IdempotencyRecord;
    return idempotencyKey(record.project, record.scope, record.key);
  });
  state.audits = map("audits", (item) => String((item as { id: string }).id));
  state.eventSequence = Number(raw.eventSequence ?? 0);
  state.queueSequence = Number(raw.queueSequence ?? 0);
  state.activeBrowserLeases = Number(raw.activeBrowserLeases ?? 0);
  if (options.recoverProcessState === false) return state;
  // Browser processes are not durable. Any non-terminal allocation from a prior process is
  // made queueable; the scheduler will allocate a fresh worker process and capability.
  for (const session of state.sessions.values()) {
    if (["ready", "active", "allocating", "releasing"].includes(session.status)) {
      session.status = "queued";
      session.workerId = undefined;
      session.leaseId = undefined;
      session.cdpEndpoint = undefined;
      session.cdpInternalEndpoint = undefined;
      session.cdpCapabilityExpiresAt = undefined;
      session.externalConnectionCount = 0;
      session.reconnectGraceUntil = undefined;
      state.sessions.set(session.id, session);
    }
  }
  for (const job of state.jobs.values()) {
    if (job.status === "running" || job.status === "awaiting_input") {
      job.status = "queued";
      job.workerId = undefined;
      job.leaseId = undefined;
      job.assignmentClaimedAt = undefined;
      state.jobs.set(job.id, job);
    }
  }
  for (const lease of state.leases.values()) {
    if (lease.status === "active" || lease.status === "releasing") {
      lease.status = "lost";
      lease.releasedAt = new Date().toISOString();
      state.leases.set(lease.id, lease);
    }
  }
  for (const clone of state.clones.values()) {
    if (clone.status !== "destroyed") {
      clone.status = "destroyed";
      clone.deletedAt = new Date().toISOString();
      state.clones.set(clone.id, clone);
    }
  }
  state.activeBrowserLeases = 0;
  for (const worker of state.workers.values()) {
    worker.activeLeases = 0;
    state.workers.set(worker.id, worker);
  }
  return state;
}
