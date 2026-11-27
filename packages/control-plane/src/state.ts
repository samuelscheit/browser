import type {
  Artifact,
  ArtifactPolicy,
  AuditEvent,
  BrowserLease,
  BrowserRecipe,
  BrowserSession,
  ChallengeHandlerSet,
  EgressPolicy,
  EphemeralInputRequest,
  FabricEvent,
  IdempotencyRecord,
  Job,
  JobAttempt,
  Principal,
  Profile,
  ProfileClone,
  Project,
  VolumeGeneration,
  Worker
} from "@browser-fabric/contracts";
import { isDeepStrictEqual } from "node:util";

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

/** The keyed entity maps of the state. */
export type StateCollection = { [K in keyof FabricState]: FabricState[K] extends Map<string, unknown> ? K : never }[keyof FabricState];
type Entity<C extends StateCollection> = FabricState[C] extends Map<string, infer T> ? T : never;
type StateCounters = Pick<FabricState, "eventSequence" | "queueSequence" | "activeBrowserLeases">;

/** Map key for idempotent create replays; reloaded snapshots must index records the same way. */
export function idempotencyKey(project: string, scope: IdempotencyRecord["scope"], key: string): string {
  return `${project}:${scope}:${key}`;
}

const byId = (item: { id: string }): string => item.id;
const byRef = (item: { ref: string }): string => item.ref;

/** Every collection with the key its map uses; snapshots and deltas re-key entities with it. */
const COLLECTION_KEYS: { [C in StateCollection]: (item: Entity<C>) => string } = {
  projects: byId,
  principals: byId,
  workers: byId,
  recipes: byRef,
  egressPolicies: byRef,
  challengeSets: byRef,
  artifactPolicies: byRef,
  profiles: byRef,
  volumeGenerations: byId,
  sessions: byId,
  leases: byId,
  clones: byId,
  jobs: byId,
  attempts: byId,
  events: byId,
  artifacts: byId,
  inputRequests: byId,
  idempotency: (record) => idempotencyKey(record.project, record.scope, record.key),
  audits: byId
};
const COLLECTIONS = Object.keys(COLLECTION_KEYS) as StateCollection[];

function collection(state: FabricState, name: StateCollection): Map<string, unknown> {
  return state[name] as Map<string, unknown>;
}

function keyOf(name: StateCollection, item: unknown): string {
  return (COLLECTION_KEYS[name] as (item: unknown) => string)(item);
}

function counters(state: FabricState): StateCounters {
  return { eventSequence: state.eventSequence, queueSequence: state.queueSequence, activeBrowserLeases: state.activeBrowserLeases };
}

function rawCounters(raw: Partial<Record<keyof StateCounters, unknown>>): StateCounters {
  return { eventSequence: Number(raw.eventSequence ?? 0), queueSequence: Number(raw.queueSequence ?? 0), activeBrowserLeases: Number(raw.activeBrowserLeases ?? 0) };
}

export function emptyFabricState(): FabricState {
  const state = { eventSequence: 0, queueSequence: 0, activeBrowserLeases: 0 } as FabricState;
  for (const name of COLLECTIONS) (state as unknown as Record<StateCollection, Map<string, unknown>>)[name] = new Map();
  return state;
}

export function cloneState(state: FabricState): FabricState {
  return structuredClone(state);
}

const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["ready", "active"]);

/**
 * Capability URLs and worker-only CDP routes are ephemeral: they never reach PostgreSQL (a
 * restart reissues capabilities after a fresh worker claim). Everything else is durable.
 */
function persistable(name: StateCollection, item: unknown): unknown {
  if (name === "sessions") {
    const session = { ...(item as BrowserSession) };
    delete session.cdpEndpoint;
    delete session.cdpInternalEndpoint;
    delete session.cdpCapabilityExpiresAt;
    return session;
  }
  if (name === "leases") {
    const lease = { ...(item as BrowserLease) };
    delete lease.internalCdpEndpoint;
    return lease;
  }
  return item;
}

/**
 * Carry this process's ephemeral capability material onto a durable revision of the same entity,
 * but only while the same live lease still serves it: if the durable state moved back to
 * allocation or terminal cleanup, keeping the old URL would resurrect a revoked browser endpoint.
 * Durable fields (connection count, client grace) always come from the database.
 */
function restoreEphemeral(name: StateCollection, loaded: unknown, previous: unknown): void {
  if (previous === undefined) return;
  if (name === "sessions") {
    const session = loaded as BrowserSession;
    const before = previous as BrowserSession;
    if (!LIVE_SESSION_STATUSES.has(session.status) || !LIVE_SESSION_STATUSES.has(before.status)) return;
    if (session.leaseId === undefined || session.leaseId !== before.leaseId) return;
    session.cdpEndpoint = before.cdpEndpoint;
    session.cdpInternalEndpoint = before.cdpInternalEndpoint;
    session.cdpCapabilityExpiresAt = before.cdpCapabilityExpiresAt;
  } else if (name === "leases") {
    const lease = loaded as BrowserLease;
    const before = previous as BrowserLease;
    if (lease.status === "active" && before.status === "active" && lease.workerId === before.workerId) lease.internalCdpEndpoint = before.internalCdpEndpoint;
  }
}

/** Full-state checkpoint: every collection as an array of its persistable entities. */
export function serializeState(state: FabricState): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...counters(state) };
  for (const name of COLLECTIONS) raw[name] = [...collection(state, name).values()].map((item) => persistable(name, item));
  return raw;
}

/** Rebuild a checkpoint; `previous` (this process's cached state) supplies ephemeral capability material. */
export function deserializeState(raw: Record<string, unknown>, previous?: FabricState): FabricState {
  const state = emptyFabricState();
  for (const name of COLLECTIONS) {
    const target = collection(state, name);
    for (const item of (raw[name] as unknown[] | undefined) ?? []) {
      const key = keyOf(name, item);
      if (previous) restoreEphemeral(name, item, collection(previous, name).get(key));
      target.set(key, item);
    }
  }
  return Object.assign(state, rawCounters(raw));
}

/** Entities a transaction added or modified, by map key, and the keys it removed. */
export interface StateChanges {
  changed: { [C in StateCollection]: Map<string, Entity<C>> };
  removed: { [C in StateCollection]: string[] };
}

function removedKeys(base: FabricState, next: FabricState, name: StateCollection): string[] {
  const current = collection(next, name);
  return [...collection(base, name).keys()].filter((key) => !current.has(key));
}

/** Compare a draft with its pre-transaction base; undefined when the transaction changed nothing. */
export function diffState(base: FabricState, next: FabricState): StateChanges | undefined {
  const changes = { changed: {}, removed: {} } as StateChanges;
  let empty = isDeepStrictEqual(counters(base), counters(next));
  for (const name of COLLECTIONS) {
    const before = collection(base, name);
    const changed = new Map<string, unknown>();
    for (const [key, item] of collection(next, name)) {
      const previous = before.get(key);
      if (previous === undefined || !isDeepStrictEqual(previous, item)) changed.set(key, item);
    }
    const removed = removedKeys(base, next, name);
    (changes.changed as Record<StateCollection, Map<string, unknown>>)[name] = changed;
    changes.removed[name] = removed;
    if (changed.size > 0 || removed.length > 0) empty = false;
  }
  return empty ? undefined : changes;
}

/**
 * The durable record of one transaction: replaying deltas in sequence order onto the preceding
 * checkpoint reproduces the state. Entries are full persistable entities, so a delta is
 * idempotent and applying it twice is harmless.
 */
export interface StateDelta {
  upserts: Partial<Record<StateCollection, unknown[]>>;
  deletes: Partial<Record<StateCollection, string[]>>;
  counters: StateCounters;
}

/**
 * Encode the transition from `base` to `next`. `changes` was taken before the store compacted
 * `next`, so entities compaction dropped again are omitted and every key gone from `base` is a delete.
 */
export function encodeStateDelta(base: FabricState, next: FabricState, changes: StateChanges): StateDelta {
  const delta: StateDelta = { upserts: {}, deletes: {}, counters: counters(next) };
  for (const name of COLLECTIONS) {
    const current = collection(next, name);
    const upserts = [...(changes.changed[name] as Map<string, unknown>)].filter(([key, item]) => current.get(key) === item).map(([, item]) => persistable(name, item));
    const deletes = removedKeys(base, next, name);
    if (upserts.length > 0) delta.upserts[name] = upserts;
    if (deletes.length > 0) delta.deletes[name] = deletes;
  }
  return delta;
}

/** Apply a delta in place; ephemeral capability material of entities already present is kept. */
export function applyStateDelta(state: FabricState, delta: StateDelta, previous: FabricState = state): void {
  for (const name of COLLECTIONS) {
    const target = collection(state, name);
    for (const key of delta.deletes[name] ?? []) target.delete(key);
    for (const item of delta.upserts[name] ?? []) {
      const key = keyOf(name, item);
      restoreEphemeral(name, item, collection(previous, name).get(key));
      target.set(key, item);
    }
  }
  Object.assign(state, rawCounters(delta.counters));
}
