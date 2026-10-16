import { describe, expect, test } from "bun:test";
import type { BrowserSession, FabricEvent } from "@browser-fabric/contracts";
import { PostgresFabricStore, type SqlClient } from "@browser-fabric/control-plane";

/** Records projection statements and serves the newest snapshot back like PostgreSQL would. */
class RecordingSqlClient implements SqlClient {
  public statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  #snapshots: Array<{ sequence: number; state: string }> = [];

  public async query<T = unknown>(sql: string, parameters: readonly unknown[] = []): Promise<{ rows: T[] }> {
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

function session(id: string, status: BrowserSession["status"]): BrowserSession {
  return { id, project: "project_test", idempotencyKey: id, status, metadata: {}, externalConnectionCount: 0 } as unknown as BrowserSession;
}

function event(id: string, kind: FabricEvent["subject"]["kind"], sequence: number): FabricEvent {
  return { id: id as FabricEvent["id"], sequence, subject: { kind, id: `${kind}_1` }, type: `${kind}.changed`, payload: {}, createdAt: "2026-10-16T00:00:00.000Z" };
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
});
