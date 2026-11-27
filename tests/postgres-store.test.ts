import { describe, expect, test } from "bun:test";
import type { Artifact, AuditEvent, BrowserLease, BrowserSession, EphemeralInputRequest, FabricEvent, IdempotencyRecord, Job, JobAttempt, ProfileClone } from "@browser-fabric/contracts";
import { PostgresFabricStore, idempotencyKey, type PostgresFabricStoreOptions, type SqlClient, type StateDelta } from "@browser-fabric/control-plane";

/**
 * Records projection statements and serves the state journal (checkpoints and deltas) back like
 * PostgreSQL would. Rows are stored as JSON text, as the `$n::jsonb` parameters arrive.
 */
class RecordingSqlClient implements SqlClient {
  public statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  public readonly checkpoints = new Map<number, string>();
  public readonly deltas = new Map<number, string>();
  /** Fail the next statement starting with this prefix, as a database error would. */
  public failOn?: string;

  public async query<T = unknown>(sql: string, parameters: readonly unknown[] = []): Promise<{ rows: T[] }> {
    // PostgreSQL parses a `$n::jsonb` parameter as JSON text and fails the transaction with 22P02
    // otherwise; reject the same mis-bound placeholders here so every projection test guards them.
    for (const [, index] of sql.matchAll(/\$(\d+)::jsonb/g)) {
      const value = parameters[Number(index) - 1];
      if (value === null) continue;
      if (typeof value !== "string") throw new Error(`$${index}::jsonb must be bound to JSON text, got ${typeof value}`);
      try { JSON.parse(value); } catch { throw new Error(`invalid input syntax for type json: $${index}=${JSON.stringify(value)}`); }
    }
    this.statements.push({ sql, parameters });
    if (this.failOn && sql.startsWith(this.failOn)) {
      this.failOn = undefined;
      throw new Error("simulated database failure");
    }
    const sorted = (rows: Map<number, string>) => [...rows].sort(([left], [right]) => left - right);
    const latestCheckpoint = sorted(this.checkpoints).at(-1);
    if (sql.startsWith("SELECT (SELECT max(sequence) FROM fabric_state_snapshots) AS checkpoint")) {
      return { rows: [{ checkpoint: latestCheckpoint?.[0] ?? null, delta: sorted(this.deltas).at(-1)?.[0] ?? null }] as T[] };
    }
    if (sql.startsWith("SELECT sequence, delta FROM fabric_state_deltas WHERE sequence > $1")) {
      return { rows: sorted(this.deltas).filter(([sequence]) => sequence > Number(parameters[0])).map(([sequence, delta]) => ({ sequence, delta })) as T[] };
    }
    if (sql.startsWith("SELECT sequence, state, NULL::jsonb AS delta")) {
      const after = latestCheckpoint?.[0] ?? 0;
      return {
        rows: [
          ...(latestCheckpoint ? [{ sequence: latestCheckpoint[0], state: latestCheckpoint[1], delta: null }] : []),
          ...sorted(this.deltas).filter(([sequence]) => sequence > after).map(([sequence, delta]) => ({ sequence, state: null, delta })),
        ] as T[],
      };
    }
    if (sql.startsWith("INSERT INTO fabric_state_snapshots")) this.#insert(this.checkpoints, parameters);
    if (sql.startsWith("INSERT INTO fabric_state_deltas")) this.#insert(this.deltas, parameters);
    if (sql.startsWith("DELETE FROM fabric_state_snapshots WHERE sequence < $1")) for (const sequence of [...this.checkpoints.keys()]) if (sequence < Number(parameters[0])) this.checkpoints.delete(sequence);
    if (sql.startsWith("DELETE FROM fabric_state_deltas WHERE sequence <= $1")) for (const sequence of [...this.deltas.keys()]) if (sequence <= Number(parameters[0])) this.deltas.delete(sequence);
    return { rows: [] };
  }

  #insert(table: Map<number, string>, parameters: readonly unknown[]): void {
    const sequence = Number(parameters[0]);
    if (table.has(sequence)) throw new Error(`duplicate key value violates unique constraint (sequence ${sequence})`);
    table.set(sequence, String(parameters[1]));
  }

  public async withTransaction<T>(operation: (transaction: SqlClient) => Promise<T>): Promise<T> {
    // Roll the journal back like PostgreSQL when the transaction fails.
    const checkpoints = new Map(this.checkpoints);
    const deltas = new Map(this.deltas);
    try {
      return await operation(this);
    } catch (error) {
      this.checkpoints.clear();
      this.deltas.clear();
      for (const [sequence, state] of checkpoints) this.checkpoints.set(sequence, state);
      for (const [sequence, delta] of deltas) this.deltas.set(sequence, delta);
      throw error;
    }
  }

  public async withAdvisoryLock<T>(_key: string, operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }

  public latestDelta(): StateDelta {
    return JSON.parse([...this.deltas].sort(([left], [right]) => left - right).at(-1)![1]) as StateDelta;
  }

  public take(prefix: string): Array<readonly unknown[]> {
    return this.statements.filter((statement) => statement.sql.startsWith(prefix)).map((statement) => statement.parameters);
  }
}

function session(id: string, status: BrowserSession["status"], updatedAt = "2026-10-16T00:00:00.000Z"): BrowserSession {
  return { id, project: "project_test", idempotencyKey: id, status, metadata: {}, externalConnectionCount: 0, updatedAt } as unknown as BrowserSession;
}

function event(id: string, kind: FabricEvent["subject"]["kind"], sequence: number, subjectId = `${kind}_1`): FabricEvent {
  return { id: id as FabricEvent["id"], sequence, subject: { kind, id: subjectId }, type: `${kind}.changed`, payload: {}, createdAt: "2026-10-16T00:00:00.000Z" };
}

/** Cast a partial fixture to a contract type; projection writes tolerate absent optional columns. */
function record<T>(value: Record<string, unknown>): T {
  return value as T;
}

async function openStore(client: RecordingSqlClient, options: PostgresFabricStoreOptions = {}): Promise<PostgresFabricStore> {
  const store = new PostgresFabricStore(client, "-- schema", options);
  await store.initialize();
  return store;
}

const READS = ["SELECT sequence, delta FROM fabric_state_deltas", "SELECT sequence, state, NULL::jsonb AS delta"];

describe("PostgreSQL state projection", () => {
  test("writes only rows that changed since the pre-transaction state", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
      draft.sessions.set("browser-session_b", session("browser-session_b", "queued"));
    });
    expect(client.take("INSERT INTO fabric_browser_sessions")).toHaveLength(2);

    client.statements = [];
    await store.transact((draft) => {
      draft.sessions.get("browser-session_b")!.status = "allocating";
    });
    const written = client.take("INSERT INTO fabric_browser_sessions");
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe("browser-session_b");
    expect(written[0]?.[10]).toBe("allocating");
    // The journal records just that change, not the whole state.
    expect(client.take("INSERT INTO fabric_state_deltas")).toHaveLength(1);
    expect(client.take("INSERT INTO fabric_state_snapshots")).toHaveLength(0);
    expect(client.latestDelta()).toEqual({ upserts: { sessions: [session("browser-session_b", "allocating")] }, deletes: {}, counters: { eventSequence: 0, queueSequence: 0, activeBrowserLeases: 0 } });
  });

  test("binds text failure reasons as text and JSON results as JSON", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    const job = (id: string, fields: Record<string, unknown>) => record<Job>({ id, status: "failed", metadata: { label: "browser" }, operation: { operation: "fetch_page" }, ...fields });
    await store.transact((draft) => {
      draft.jobs.set("job_failed", job("job_failed", { failureReason: "browser lease heartbeat expired" }));
      draft.jobs.set("job_done", job("job_done", { status: "succeeded", result: { title: "browser", nested: { ok: true, missing: null } } }));
    });
    const rows = new Map(client.take("INSERT INTO fabric_jobs").map((parameters) => [parameters[0], parameters]));
    // Column order: ...,lease_id($17),result($18),failure_reason($19),...
    expect(rows.get("job_failed")?.[17]).toBeNull();
    expect(rows.get("job_failed")?.[18]).toBe("browser lease heartbeat expired");
    expect(JSON.parse(String(rows.get("job_done")?.[17]))).toEqual({ title: "browser", nested: { ok: true, missing: null } });
    expect(rows.get("job_done")?.[18]).toBeNull();
  });

  test("appends worker events durably without keeping them in the hot state", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_1", session("browser-session_1", "queued"));
      draft.events.set("event_worker", event("event_worker", "worker", 1));
      draft.events.set("event_session", event("event_session", "browser_session", 2, "browser-session_1"));
      draft.eventSequence = 2;
    });

    expect(client.take("INSERT INTO fabric_events").map((parameters) => parameters[0])).toEqual(["event_worker", "event_session"]);
    const delta = client.latestDelta();
    expect((delta.upserts.events as FabricEvent[]).map((item) => String(item.id))).toEqual(["event_session"]);
    expect(delta.counters.eventSequence).toBe(2);
    expect([...(await store.snapshot()).events.keys()].map(String)).toEqual(["event_session"]);
  });

  test("compacts a legacy checkpoint: worker events and audits leave the hot state without being re-appended", async () => {
    const client = new RecordingSqlClient();
    client.checkpoints.set(7, JSON.stringify({
      sessions: [session("browser-session_1", "queued")],
      events: [event("event_worker", "worker", 1), event("event_session", "browser_session", 2, "browser-session_1")],
      audits: [record<AuditEvent>({ id: "audit-event_old", actor: "principal_system", action: "test", target: { kind: "worker", id: "worker_1" }, outcome: "succeeded", metadata: {}, createdAt: "2026-10-16T00:00:00.000Z" })],
      eventSequence: 2,
    }));
    const store = await openStore(client);
    expect((await store.snapshot()).events.size).toBe(2);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
    });

    expect(client.take("INSERT INTO fabric_events")).toHaveLength(0);
    expect(client.take("INSERT INTO fabric_audit_events")).toHaveLength(0);
    expect([...client.deltas.keys()]).toEqual([8]);
    expect(client.latestDelta().deletes).toEqual({ events: ["event_worker"], audits: ["audit-event_old"] });
    const state = await store.snapshot();
    expect([...state.events.keys()].map(String)).toEqual(["event_session"]);
    expect(state.audits.size).toBe(0);
    // A restarted process replays the legacy checkpoint plus the new delta to the same state.
    expect(await (await openStore(client)).snapshot()).toEqual(state);
  });

  test("evicts terminal history past the retention window but keeps anything still reachable", async () => {
    const client = new RecordingSqlClient();
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    const store = await openStore(client, { now: () => now, retention: { terminalHistoryMs: 60 * 60 * 1_000 } });
    const old = "2026-10-16T09:00:00.000Z";
    const recent = "2026-10-16T11:30:00.000Z";
    await store.transact((draft) => {
      draft.sessions.set("browser-session_old", { ...session("browser-session_old", "released", old), releasedAt: old, leaseId: "browser-lease_old" } as BrowserSession);
      draft.sessions.set("browser-session_recent", { ...session("browser-session_recent", "released", recent), releasedAt: recent } as BrowserSession);
      draft.sessions.set("browser-session_artifact", session("browser-session_artifact", "released", old));
      draft.sessions.set("browser-session_queued", session("browser-session_queued", "queued", old));
      draft.leases.set("browser-lease_old", record<BrowserLease>({ id: "browser-lease_old", sessionId: "browser-session_old", status: "released" }));
      draft.clones.set("profile-clone_old", record<ProfileClone>({ id: "profile-clone_old", createdForLease: "browser-lease_old", status: "destroyed" }));
      draft.events.set("event_old", event("event_old", "browser_session", 1, "browser-session_old"));
      draft.events.set("event_recent", event("event_recent", "browser_session", 2, "browser-session_recent"));
      draft.idempotency.set(idempotencyKey("project_test", "browser_session", "old"), record<IdempotencyRecord>({ id: "idempotency_old", project: "project_test", scope: "browser_session", key: "old", responseId: "browser-session_old" }));
      draft.idempotency.set(idempotencyKey("project_test", "browser_session", "recent"), record<IdempotencyRecord>({ id: "idempotency_recent", project: "project_test", scope: "browser_session", key: "recent", responseId: "browser-session_recent" }));
      draft.artifacts.set("artifact_live", record<Artifact>({ id: "artifact_live", sessionId: "browser-session_artifact", expiresAt: "2026-11-16T00:00:00.000Z" }));
      draft.artifacts.set("artifact_expired", record<Artifact>({ id: "artifact_expired", sessionId: "browser-session_old", expiresAt: "2026-10-15T00:00:00.000Z" }));
      draft.jobs.set("job_old", record<Job>({ id: "job_old", status: "succeeded", updatedAt: old, metadata: {}, operation: {} }));
      draft.jobs.set("job_waiting", record<Job>({ id: "job_waiting", status: "failed", updatedAt: old, metadata: {}, operation: {} }));
      draft.attempts.set("attempt_old", record<JobAttempt>({ id: "attempt_old", jobId: "job_old", status: "succeeded" }));
      draft.inputRequests.set("input_old", record<EphemeralInputRequest>({ id: "input_old", jobId: "job_old", status: "consumed" }));
      draft.inputRequests.set("input_waiting", record<EphemeralInputRequest>({ id: "input_waiting", jobId: "job_waiting", status: "pending" }));
    });

    // Rows reach the normalized tables before the hot state forgets them; nothing is deleted.
    expect(client.take("INSERT INTO fabric_browser_sessions").map((parameters) => parameters[0])).toContain("browser-session_old");
    expect(client.take("INSERT INTO fabric_idempotency").map((parameters) => parameters[0])).toContain("idempotency_old");
    expect(client.statements.filter((statement) => statement.sql.startsWith("DELETE") && !statement.sql.includes("grants") && !statement.sql.includes("principal_projects"))).toHaveLength(0);

    const state = await store.snapshot();
    expect([...state.sessions.keys()].sort()).toEqual(["browser-session_artifact", "browser-session_queued", "browser-session_recent"]);
    expect([...state.leases.keys()]).toEqual([]);
    expect([...state.clones.keys()]).toEqual([]);
    expect([...state.events.keys()].map(String)).toEqual(["event_recent"]);
    expect([...state.idempotency.values()].map((item) => String(item.id))).toEqual(["idempotency_recent"]);
    expect([...state.jobs.keys()]).toEqual(["job_waiting"]);
    expect([...state.attempts.keys()]).toEqual([]);
    expect([...state.inputRequests.keys()]).toEqual(["input_waiting"]);
    expect([...state.artifacts.keys()]).toEqual(["artifact_live"]);
    // The evicted entities never enter the journal, so a reload agrees with this process.
    expect((client.latestDelta().upserts.sessions as BrowserSession[]).map((item) => String(item.id)).sort()).toEqual(["browser-session_artifact", "browser-session_queued", "browser-session_recent"]);
    expect(await (await openStore(client, { now: () => now })).snapshot()).toEqual(state);
  });

  test("keeps at most the newest terminal sessions within the window under heavy churn", async () => {
    const client = new RecordingSqlClient();
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    const store = await openStore(client, { now: () => now, retention: { terminalHistoryLimit: 3 } });
    await store.transact((draft) => {
      for (let minute = 0; minute < 10; minute++) {
        const finished = new Date(now - (10 - minute) * 60_000).toISOString();
        const id = `browser-session_${minute}`;
        draft.sessions.set(id, { ...session(id, minute % 2 ? "timed_out" : "cancelled", finished), releasedAt: finished } as BrowserSession);
        draft.events.set(`event_${minute}`, event(`event_${minute}`, "browser_session", minute, id));
      }
      draft.sessions.set("browser-session_live", session("browser-session_live", "ready"));
    });
    const state = await store.snapshot();
    expect([...state.sessions.keys()].sort()).toEqual(["browser-session_7", "browser-session_8", "browser-session_9", "browser-session_live"]);
    expect([...state.events.keys()].sort()).toEqual(["event_7", "event_8", "event_9"]);
    expect(client.take("INSERT INTO fabric_browser_sessions")).toHaveLength(11);
  });

  test("appends audits durably without keeping them in the hot state", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.audits.set("audit-event_1", record<AuditEvent>({ id: "audit-event_1", actor: "principal_system", action: "test", target: { kind: "worker", id: "worker_1" }, outcome: "succeeded", metadata: {}, createdAt: "2026-10-16T00:00:00.000Z" }));
    });
    expect(client.take("INSERT INTO fabric_audit_events").map((parameters) => parameters[0])).toEqual(["audit-event_1"]);
    // Nothing hot changed, so the journal has an empty delta at most.
    expect(client.latestDelta().upserts).toEqual({});
    expect((await store.snapshot()).audits.size).toBe(0);
  });

  test("finds idempotency records by their replay key after another process committed", async () => {
    const client = new RecordingSqlClient();
    const api = await openStore(client);
    const sibling = await openStore(client);
    const replayKey = idempotencyKey("project_test", "browser_session", "client-key");
    await api.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
      draft.idempotency.set(replayKey, record<IdempotencyRecord>({ id: "idempotency_a", project: "project_test", scope: "browser_session", key: "client-key", responseId: "browser-session_a" }));
    });
    await sibling.transact((draft) => {
      draft.sessions.set("browser-session_b", session("browser-session_b", "queued"));
    });

    client.statements = [];
    const replayed = await api.transact((draft) => draft.idempotency.get(replayKey)?.responseId);
    expect(replayed as string | undefined).toBe("browser-session_a");
    expect(client.take("INSERT INTO")).toHaveLength(0);
    expect((await api.snapshot()).sessions.has("browser-session_b")).toBe(true);
  });

  test("skips journal and projection writes when a transaction makes no state changes", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
    });
    expect(client.take("INSERT INTO fabric_state_deltas")).toHaveLength(1);

    client.statements = [];
    const outcome = await store.transact((draft) => draft.sessions.size);
    expect(outcome).toBe(1);
    expect(client.take("INSERT INTO")).toHaveLength(0);
    expect(client.take("DELETE FROM")).toHaveLength(0);
    expect(client.take("UPDATE ")).toHaveLength(0);
  });
});

describe("PostgreSQL state journal", () => {
  test("reads and transactions skip fetching state while the journal head is unchanged", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
    });
    client.statements = [];
    for (let read = 0; read < 5; read++) expect((await store.snapshot()).sessions.size).toBe(1);
    await store.transact((draft) => draft.sessions.size);
    expect(client.take("SELECT (SELECT max(sequence)")).toHaveLength(6);
    for (const prefix of READS) expect(client.take(prefix)).toHaveLength(0);
  });

  test("a sibling process catches up by replaying only the deltas it lacks", async () => {
    const client = new RecordingSqlClient();
    const api = await openStore(client);
    const gateway = await openStore(client);
    await api.transact((draft) => {
      draft.sessions.set("browser-session_a", { ...session("browser-session_a", "ready"), leaseId: "browser-lease_a", cdpEndpoint: "wss://fabric.test/v1/cdp/browser-session_a?cap=api" } as BrowserSession);
      draft.sessions.set("browser-session_b", session("browser-session_b", "queued"));
    });
    expect((await gateway.snapshot()).sessions.get("browser-session_a")?.cdpEndpoint).toBeUndefined();

    // The gateway records a client; the API process sees the durable count and grace change.
    await gateway.transact((draft) => {
      const live = draft.sessions.get("browser-session_a")!;
      live.status = "active";
      live.externalConnectionCount = 1;
      live.reconnectGraceUntil = undefined;
      draft.sessions.delete("browser-session_b");
      draft.queueSequence = 5;
    });
    client.statements = [];
    const state = await api.snapshot();
    expect(client.take(READS[0]!)).toEqual([[1]]);
    expect(client.take(READS[1]!)).toHaveLength(0);
    const live = state.sessions.get("browser-session_a")!;
    expect(live.status).toBe("active");
    expect(live.externalConnectionCount).toBe(1);
    // The capability this process issued survives because the same lease still serves it.
    expect(live.cdpEndpoint).toBe("wss://fabric.test/v1/cdp/browser-session_a?cap=api");
    expect(state.sessions.has("browser-session_b")).toBe(false);
    expect(state.queueSequence).toBe(5);

    // A sibling moving the session to another lease revokes the capability cached here.
    await gateway.transact((draft) => {
      draft.sessions.get("browser-session_a")!.leaseId = "browser-lease_other" as never;
    });
    expect((await api.snapshot()).sessions.get("browser-session_a")?.cdpEndpoint).toBeUndefined();
  });

  test("durable grace and connection count written by a sibling are never replaced by cached values", async () => {
    const client = new RecordingSqlClient();
    const scheduler = await openStore(client);
    const worker = await openStore(client);
    await scheduler.transact((draft) => {
      draft.sessions.set("browser-session_a", { ...session("browser-session_a", "allocating"), leaseId: "browser-lease_a" } as BrowserSession);
    });
    expect((await worker.snapshot()).sessions.get("browser-session_a")?.status).toBe("allocating");
    await worker.transact((draft) => {
      const started = draft.sessions.get("browser-session_a")!;
      started.status = "ready";
      started.reconnectGraceUntil = "2026-10-16T00:01:00.000Z";
    });
    const seen = (await scheduler.snapshot()).sessions.get("browser-session_a")!;
    expect(seen.status).toBe("ready");
    expect(seen.reconnectGraceUntil).toBe("2026-10-16T00:01:00.000Z");
  });

  test("checkpoints periodically, prunes the journal, and a restarted process reloads the same state", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client, { checkpointInterval: 10 });
    for (let index = 1; index <= 35; index++) {
      await store.transact((draft) => {
        draft.sessions.set(`browser-session_${index % 7}`, { ...session(`browser-session_${index % 7}`, "active"), externalConnectionCount: index } as BrowserSession);
        draft.queueSequence = index;
      });
    }
    expect([...client.checkpoints.keys()]).toEqual([30]);
    // Deltas from one interval before the latest checkpoint stay for processes slightly behind.
    expect([...client.deltas.keys()].sort((left, right) => left - right)).toEqual(Array.from({ length: 15 }, (_, index) => 21 + index));

    client.statements = [];
    const restarted = await openStore(client, { checkpointInterval: 10 });
    const reloaded = await restarted.snapshot();
    expect(reloaded).toEqual(await store.snapshot());
    expect(reloaded.queueSequence).toBe(35);
    expect(client.take(READS[1]!)).toHaveLength(1);

    // The restarted process continues the same journal.
    await restarted.transact((draft) => {
      draft.queueSequence = 36;
    });
    expect((await store.snapshot()).queueSequence).toBe(36);
    expect(Math.max(...client.deltas.keys())).toBe(36);
  });

  test("a process left behind a pruned journal reloads from the checkpoint", async () => {
    const client = new RecordingSqlClient();
    const behind = await openStore(client, { checkpointInterval: 5 });
    const busy = await openStore(client, { checkpointInterval: 5 });
    for (let index = 1; index <= 12; index++) {
      await busy.transact((draft) => {
        draft.queueSequence = index;
      });
    }
    expect(Math.min(...client.deltas.keys())).toBe(6);
    client.statements = [];
    expect((await behind.snapshot()).queueSequence).toBe(12);
    expect(client.take(READS[1]!)).toHaveLength(1);
  });

  test("a failed transaction leaves the cached state and the journal untouched", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
    });
    await expect(store.transact((draft) => {
      draft.sessions.get("browser-session_a")!.status = "cancelled";
      throw new Error("validation failed");
    })).rejects.toThrow("validation failed");
    client.failOn = "INSERT INTO fabric_state_deltas";
    await expect(store.transact((draft) => {
      draft.sessions.get("browser-session_a")!.status = "allocating";
    })).rejects.toThrow("simulated database failure");

    expect((await store.snapshot()).sessions.get("browser-session_a")?.status).toBe("queued");
    expect([...client.deltas.keys()]).toEqual([1]);
    await store.transact((draft) => {
      draft.sessions.get("browser-session_a")!.status = "allocating";
    });
    expect([...client.deltas.keys()]).toEqual([1, 2]);
    expect((await (await openStore(client)).snapshot()).sessions.get("browser-session_a")?.status).toBe("allocating");
  });

  test("refuses to load a journal with a missing delta", async () => {
    const client = new RecordingSqlClient();
    const store = await openStore(client);
    for (let index = 1; index <= 3; index++) await store.transact((draft) => { draft.queueSequence = index; });
    client.deltas.delete(2);
    await expect(openStore(client)).rejects.toThrow("Browser Fabric state journal is missing sequence 2");
  });
});
