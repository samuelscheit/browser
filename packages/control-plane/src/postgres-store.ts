import { Mutex } from "./mutex";
import { writeNormalizedProjection } from "./postgres-projection";
import { applyStateDelta, cloneState, deserializeState, diffState, emptyFabricState, encodeStateDelta, serializeState, type FabricState, type StateDelta } from "./state";
import { compactHotState, DEFAULT_HOT_STATE_RETENTION, type HotStateRetention } from "./state-retention";
import type { FabricStore } from "./store";

export interface SqlClient {
  query<T = unknown>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: T[] }>;
  /** Executes `operation` on one database connection inside one SQL transaction when supported. */
  withTransaction?<T>(operation: (transaction: SqlClient) => Promise<T>): Promise<T>;
  /** Pin a cross-process coordination lock to one database session when supported. */
  withAdvisoryLock?<T>(key: string, operation: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface PostgresFabricStoreOptions {
  now?: () => number;
  retention?: Partial<HotStateRetention>;
  /** A full checkpoint is written every this many transactions; loads replay the deltas after it. */
  checkpointInterval?: number;
}

const DEFAULT_CHECKPOINT_INTERVAL = 200;

/** Both journal heads: two primary-key lookups, so an unchanged state costs no payload transfer. */
const JOURNAL_HEAD_SQL = "SELECT (SELECT max(sequence) FROM fabric_state_snapshots) AS checkpoint, (SELECT max(sequence) FROM fabric_state_deltas) AS delta";
const DELTAS_AFTER_SQL = "SELECT sequence, delta FROM fabric_state_deltas WHERE sequence > $1 ORDER BY sequence";
/** One statement, so the checkpoint and its following deltas come from one MVCC snapshot. */
const JOURNAL_SQL = `SELECT sequence, state, NULL::jsonb AS delta FROM fabric_state_snapshots WHERE sequence = (SELECT max(sequence) FROM fabric_state_snapshots)
UNION ALL
SELECT sequence, NULL::jsonb AS state, delta FROM fabric_state_deltas WHERE sequence > COALESCE((SELECT max(sequence) FROM fabric_state_snapshots), 0)
ORDER BY sequence`;

type Sequence = string | number;
type JsonColumn = string | Record<string, unknown>;

function json<T>(value: JsonColumn): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/**
 * PostgreSQL-backed store. The normalized schema is created by deploy/postgres/001_schema.sql.
 *
 * Every process caches the hot state with the journal sequence it reflects. A transaction appends
 * one small delta (`fabric_state_deltas`) and, every `checkpointInterval` transactions, a full
 * checkpoint (`fabric_state_snapshots`). Reads compare the cached sequence with the journal head
 * and replay only the missing deltas, so an unchanged or slightly changed state is never
 * re-fetched and re-parsed in full. A restart loads the latest checkpoint plus its deltas.
 */
export class PostgresFabricStore implements FabricStore {
  readonly #client: SqlClient;
  readonly #schemaSql: string;
  readonly #mutex = new Mutex();
  readonly #now: () => number;
  readonly #retention: HotStateRetention;
  readonly #checkpointInterval: number;
  #state = emptyFabricState();
  /** Journal sequence `#state` reflects; -1 until the first load. */
  #sequence = -1;
  /** Sequence of the latest full checkpoint known to this store. */
  #checkpointSequence = 0;
  #initialized = false;
  #initializing?: Promise<void>;

  public constructor(client: SqlClient, schemaSql: string, options: PostgresFabricStoreOptions = {}) {
    this.#client = client;
    this.#schemaSql = schemaSql;
    this.#now = options.now ?? Date.now;
    this.#retention = { ...DEFAULT_HOT_STATE_RETENTION, ...options.retention };
    this.#checkpointInterval = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    if (!Number.isInteger(this.#checkpointInterval) || this.#checkpointInterval < 1) throw new Error("checkpoint interval must be a positive integer");
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
      await this.#mutex.run(() => this.#sync(client));
    };
    if (this.#client.withAdvisoryLock) await this.#client.withAdvisoryLock("browser-fabric-schema", initialize);
    else await initialize(this.#client);
    this.#initialized = true;
  }

  /**
   * PostgreSQL deployments coordinate schedulers with a transaction-scoped advisory lock.
   * The in-memory mutex still protects this process, while the database lock protects sibling
   * API/scheduler replicas from allocating the same worker/profile concurrently. The draft is
   * adopted only after the SQL transaction committed.
   */
  public async transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    return this.#mutex.run(async () => {
      const outcome = await this.#inTransaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext('browser-fabric-schema'))");
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext('browser-fabric-scheduler'))");
        // Lock in a stable order so concurrent schedulers cannot race worker/profile capacity
        // or deadlock while one replica is dispatching and another is recovering.
        await transaction.query("SELECT id FROM fabric_capacity WHERE id = 1 FOR UPDATE");
        await transaction.query("SELECT id FROM fabric_workers ORDER BY id FOR UPDATE");
        await transaction.query("SELECT ref FROM fabric_profiles ORDER BY ref FOR UPDATE");
        await transaction.query("SELECT id FROM fabric_browser_leases WHERE status = 'active' ORDER BY id FOR UPDATE");
        await this.#sync(transaction);
        const base = this.#state;
        const draft = cloneState(base);
        const result = await operation(draft);
        // Idle scheduler recover/dispatch ticks and idempotent replays frequently leave state
        // unchanged; they write nothing.
        const changes = diffState(base, draft);
        if (!changes) return { result };
        await writeNormalizedProjection(transaction, draft, changes);
        compactHotState(draft, this.#now(), this.#retention);
        const sequence = this.#sequence + 1;
        const checkpointed = await this.#append(transaction, sequence, encodeStateDelta(base, draft, changes), draft);
        return { result, committed: { state: draft, sequence, checkpointed } };
      });
      if (outcome.committed) {
        this.#state = outcome.committed.state;
        this.#sequence = outcome.committed.sequence;
        if (outcome.committed.checkpointed) this.#checkpointSequence = outcome.committed.sequence;
      }
      return outcome.result;
    });
  }

  public async read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    return this.#mutex.run(async () => {
      await this.#sync(this.#client);
      return operation(cloneState(this.#state));
    });
  }

  public async snapshot(): Promise<FabricState> {
    return this.read((snapshot) => snapshot);
  }

  async #inTransaction<T>(run: (transaction: SqlClient) => Promise<T>): Promise<T> {
    if (this.#client.withTransaction) return this.#client.withTransaction(run);
    // Test adapters that do not expose a dedicated connection still get explicit transaction
    // semantics. The production PgSqlClient always takes the `withTransaction` branch.
    await this.#client.query("BEGIN");
    try {
      const result = await run(this.#client);
      await this.#client.query("COMMIT");
      return result;
    } catch (error) {
      await this.#client.query("ROLLBACK");
      throw error;
    }
  }

  /**
   * Append the transaction's delta. A checkpoint replaces older checkpoints; deltas stay for one
   * more interval so processes a little behind still catch up incrementally instead of reloading.
   */
  async #append(client: SqlClient, sequence: number, delta: StateDelta, state: FabricState): Promise<boolean> {
    await client.query("INSERT INTO fabric_state_deltas(sequence, delta) VALUES ($1, $2::jsonb)", [sequence, JSON.stringify(delta)]);
    if (sequence % this.#checkpointInterval !== 0 && sequence - this.#checkpointSequence < this.#checkpointInterval) return false;
    await client.query("INSERT INTO fabric_state_snapshots(sequence, state) VALUES ($1, $2::jsonb)", [sequence, JSON.stringify(serializeState(state))]);
    await client.query("DELETE FROM fabric_state_snapshots WHERE sequence < $1", [sequence]);
    await client.query("DELETE FROM fabric_state_deltas WHERE sequence <= $1", [sequence - this.#checkpointInterval]);
    return true;
  }

  /** Bring the cached state to the journal head; callers hold the mutex. */
  async #sync(client: SqlClient): Promise<void> {
    const { rows: [head] } = await client.query<{ checkpoint: Sequence | null; delta: Sequence | null }>(JOURNAL_HEAD_SQL);
    const checkpoint = Number(head?.checkpoint ?? 0);
    if (checkpoint > this.#checkpointSequence) this.#checkpointSequence = checkpoint;
    const latest = Math.max(checkpoint, Number(head?.delta ?? 0));
    if (latest === this.#sequence) return;
    if (this.#sequence >= 0 && latest > this.#sequence && await this.#catchUp(client)) return;
    await this.#reload(client);
  }

  /** Replay the deltas after the cached sequence; false when they were compacted away. */
  async #catchUp(client: SqlClient): Promise<boolean> {
    const { rows } = await client.query<{ sequence: Sequence; delta: JsonColumn }>(DELTAS_AFTER_SQL, [this.#sequence]);
    if (rows.length === 0 || !rows.every((row, index) => Number(row.sequence) === this.#sequence + 1 + index)) return false;
    // Deltas carry whole entities, so a failure part-way leaves a state that replaying them again repairs.
    for (const row of rows) {
      applyStateDelta(this.#state, json<StateDelta>(row.delta));
      this.#sequence = Number(row.sequence);
    }
    return true;
  }

  async #reload(client: SqlClient): Promise<void> {
    const { rows } = await client.query<{ sequence: Sequence; state: JsonColumn | null; delta: JsonColumn | null }>(JOURNAL_SQL);
    let state = emptyFabricState();
    let sequence = 0;
    let checkpointSequence = 0;
    for (const row of rows) {
      const rowSequence = Number(row.sequence);
      if (row.state !== null) {
        state = deserializeState(json(row.state), this.#state);
        checkpointSequence = rowSequence;
      } else {
        if (rowSequence !== sequence + 1) throw new Error(`Browser Fabric state journal is missing sequence ${sequence + 1}`);
        applyStateDelta(state, json<StateDelta>(row.delta!), this.#state);
      }
      sequence = rowSequence;
    }
    this.#state = state;
    this.#sequence = sequence;
    this.#checkpointSequence = checkpointSequence;
  }
}
