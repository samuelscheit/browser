import { describe, expect, test } from "bun:test";
import type { Artifact, AuditEvent, BrowserLease, BrowserSession, EphemeralInputRequest, FabricEvent, IdempotencyRecord, Job, JobAttempt, ProfileClone } from "@browser-fabric/contracts";
import { PostgresFabricStore, idempotencyKey, type SqlClient } from "@browser-fabric/control-plane";

/** Records projection statements and serves the newest snapshot back like PostgreSQL would. */
class RecordingSqlClient implements SqlClient {
  public statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  #snapshots: Array<{ sequence: number; state: string }> = [];

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
    if (sql.startsWith("SELECT sequence, state FROM fabric_state_snapshots")) {
      const latest = this.#snapshots.at(-1);
      return { rows: (latest ? [latest] : []) as T[] };
    }
    if (sql.startsWith("SELECT COALESCE(MAX(sequence),0)+1")) {
      return { rows: [{ next: (this.#snapshots.at(-1)?.sequence ?? 0) + 1 }] as T[] };
    }
    if (sql.startsWith("INSERT INTO fabric_state_snapshots")) {
      this.#snapshots.push({ sequence: Number(parameters[0]), state: String(parameters[1]) });
    }
    return { rows: [] };
  }

  public async withTransaction<T>(operation: (transaction: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }

  public async withAdvisoryLock<T>(_key: string, operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }

  public latestSnapshot(): Record<string, unknown> {
    return JSON.parse(this.#snapshots.at(-1)!.state) as Record<string, unknown>;
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

describe("PostgreSQL state projection", () => {
  test("writes only rows that changed since the pre-transaction state", async () => {
    const client = new RecordingSqlClient();
    const store = new PostgresFabricStore(client, "-- schema");
    await store.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
      draft.sessions.set("browser-session_b", session("browser-session_b", "queued"));
    });
    expect(client.take("INSERT INTO fabric_browser_sessions")).toHaveLength(2);

    client.statements = [];
    await store.transact((draft) => {
      draft.sessions.get("browser-session_b")!.status = "released";
    });
    const written = client.take("INSERT INTO fabric_browser_sessions");
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe("browser-session_b");
    expect(written[0]?.[10]).toBe("released");
    expect(client.take("INSERT INTO fabric_state_snapshots")).toHaveLength(1);
  });

  test("binds text failure reasons as text and JSON results as JSON", async () => {
    const client = new RecordingSqlClient();
    const store = new PostgresFabricStore(client, "-- schema");
    const job = (id: string, fields: Record<string, unknown>) => record<Job>({ id, status: "failed", metadata: { label: "browser" }, operation: { operation: "fetch_news" }, ...fields });
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
    const store = new PostgresFabricStore(client, "-- schema");
    await store.transact((draft) => {
      draft.events.set("event_worker", event("event_worker", "worker", 1));
      draft.events.set("event_session", event("event_session", "browser_session", 2));
      draft.eventSequence = 2;
    });

    expect(client.take("INSERT INTO fabric_events").map((parameters) => parameters[0])).toEqual(["event_worker", "event_session"]);
    const persisted = client.latestSnapshot();
    expect((persisted.events as FabricEvent[]).map((item) => String(item.id))).toEqual(["event_session"]);
    expect(persisted.eventSequence).toBe(2);
    expect([...(await store.snapshot()).events.keys()].map(String)).toEqual(["event_session"]);
  });

  test("compacts worker events already present in a legacy snapshot without re-appending them", async () => {
    const client = new RecordingSqlClient();
    const legacy = new PostgresFabricStore(client, "-- schema");
    // Seed a snapshot as an earlier release wrote it: worker events inside the hot state.
    await client.query("INSERT INTO fabric_state_snapshots(sequence, state) VALUES ($1, $2::jsonb)", [1, JSON.stringify({
      events: [event("event_worker", "worker", 1), event("event_session", "browser_session", 2)],
      eventSequence: 2,
    })]);
    client.statements = [];
    await legacy.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
    });

    expect(client.take("INSERT INTO fabric_events")).toHaveLength(0);
    expect((client.latestSnapshot().events as FabricEvent[]).map((item) => String(item.id))).toEqual(["event_session"]);
  });

  test("evicts terminal history past the retention window but keeps anything still reachable", async () => {
    const client = new RecordingSqlClient();
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    const store = new PostgresFabricStore(client, "-- schema", { now: () => now, terminalHistoryRetentionMs: 60 * 60 * 1_000 });
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
      draft.idempotency.set("idempotency_old", record<IdempotencyRecord>({ id: "idempotency_old", scope: "browser_session", responseId: "browser-session_old" }));
      draft.artifacts.set("artifact_live", record<Artifact>({ id: "artifact_live", sessionId: "browser-session_artifact", expiresAt: "2026-11-16T00:00:00.000Z" }));
      draft.jobs.set("job_old", record<Job>({ id: "job_old", status: "succeeded", updatedAt: old, metadata: {}, operation: {} }));
      draft.jobs.set("job_waiting", record<Job>({ id: "job_waiting", status: "failed", updatedAt: old, metadata: {}, operation: {} }));
      draft.attempts.set("attempt_old", record<JobAttempt>({ id: "attempt_old", jobId: "job_old", status: "succeeded" }));
      draft.inputRequests.set("input_old", record<EphemeralInputRequest>({ id: "input_old", jobId: "job_old", status: "consumed" }));
      draft.inputRequests.set("input_waiting", record<EphemeralInputRequest>({ id: "input_waiting", jobId: "job_waiting", status: "pending" }));
    });

    // Rows reach the normalized tables before the hot state forgets them; nothing is deleted.
    expect(client.take("INSERT INTO fabric_browser_sessions").map((parameters) => parameters[0])).toContain("browser-session_old");
    expect(client.statements.filter((statement) => statement.sql.startsWith("DELETE") && !statement.sql.includes("grants") && !statement.sql.includes("principal_projects"))).toHaveLength(0);

    const state = await store.snapshot();
    expect([...state.sessions.keys()].sort()).toEqual(["browser-session_artifact", "browser-session_queued", "browser-session_recent"]);
    expect([...state.leases.keys()]).toEqual([]);
    expect([...state.clones.keys()]).toEqual([]);
    expect([...state.events.keys()].map(String)).toEqual(["event_recent"]);
    expect([...state.idempotency.keys()]).toEqual([]);
    expect([...state.jobs.keys()]).toEqual(["job_waiting"]);
    expect([...state.attempts.keys()]).toEqual([]);
    expect([...state.inputRequests.keys()]).toEqual(["input_waiting"]);
    expect((client.latestSnapshot().sessions as BrowserSession[]).map((item) => String(item.id)).sort()).toEqual(["browser-session_artifact", "browser-session_queued", "browser-session_recent"]);
  });

  test("appends audits durably without keeping them in the hot state", async () => {
    const client = new RecordingSqlClient();
    const store = new PostgresFabricStore(client, "-- schema");
    await store.transact((draft) => {
      draft.audits.set("audit-event_1", record<AuditEvent>({ id: "audit-event_1", actor: "principal_system", action: "test", target: { kind: "worker", id: "worker_1" }, outcome: "succeeded", metadata: {}, createdAt: "2026-10-16T00:00:00.000Z" }));
    });
    expect(client.take("INSERT INTO fabric_audit_events").map((parameters) => parameters[0])).toEqual(["audit-event_1"]);
    expect(client.latestSnapshot().audits).toEqual([]);
    expect((await store.snapshot()).audits.size).toBe(0);
  });

  test("finds idempotency records by their replay key after another process reloads the snapshot", async () => {
    const client = new RecordingSqlClient();
    const api = new PostgresFabricStore(client, "-- schema");
    const sibling = new PostgresFabricStore(client, "-- schema");
    const replayKey = idempotencyKey("project_test", "browser_session", "client-key");
    await api.transact((draft) => {
      draft.sessions.set("browser-session_a", session("browser-session_a", "queued"));
      draft.idempotency.set(replayKey, record<IdempotencyRecord>({ id: "idempotency_a", project: "project_test", scope: "browser_session", key: "client-key", responseId: "browser-session_a" }));
    });
    // Another process commits, so the API process reloads the shared snapshot before its replay.
    await sibling.transact((draft) => {
      draft.sessions.set("browser-session_b", session("browser-session_b", "queued"));
    });

    client.statements = [];
    const replayed = await api.transact((draft) => draft.idempotency.get(replayKey)?.responseId);
    expect(replayed as string | undefined).toBe("browser-session_a");
    expect(client.take("INSERT INTO fabric_idempotency")).toHaveLength(0);
  });
});
