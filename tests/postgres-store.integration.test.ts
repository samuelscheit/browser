import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import type { BrowserSessionId, JobId, Principal, Worker } from "@browser-fabric/contracts";
import { BrowserScheduler, CapabilitySigner, FakeClock, MemoryEphemeralInputVault, PgSqlClient, PostgresFabricStore, loadPostgresMigrations, serializeState } from "@browser-fabric/control-plane";
import { exampleCatalog, TEST_PRINCIPAL, TEST_PROJECT, makeProfile, makeWorker } from "@browser-fabric/testkit";

/**
 * Exercises the normalized projection against a real PostgreSQL server. A recording fake cannot
 * catch type errors such as a text value bound to a `$n::jsonb` placeholder; PostgreSQL rejects
 * those with 22P02 and rolls back the whole transition.
 *
 * Set FABRIC_TEST_DATABASE_URL to a role that may CREATE/DROP DATABASE. Each run creates and
 * drops its own database, so it never touches existing data.
 */
const adminUrl = process.env.FABRIC_TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const DIRECT = "egress_direct@1" as never;
const ARTIFACTS = "artifact-policy_standard-30-days@1" as never;

suite("PostgreSQL store against a real server", () => {
  const databaseName = `browser_fabric_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let schema: string;

  const databaseUrl = (name: string): string => {
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    return url.toString();
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    pool = new Pool({ connectionString: databaseUrl(databaseName), max: 4 });
    schema = await loadPostgresMigrations();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.end();
  });

  /** A scheduler process on the shared database; a second call models a sibling/restarted replica. */
  async function startProcess(clock: FakeClock, checkpointInterval?: number): Promise<{ scheduler: BrowserScheduler; store: PostgresFabricStore }> {
    const store = new PostgresFabricStore(PgSqlClient.fromPool(pool), schema, { now: () => clock.now().getTime(), ...(checkpointInterval === undefined ? {} : { checkpointInterval }) });
    await store.initialize();
    const scheduler = new BrowserScheduler({ catalog: exampleCatalog,
      store,
      clock,
      capabilitySigner: new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" }),
      ephemeralInputVault: new MemoryEphemeralInputVault(() => clock.now()),
      allowPlaintextEphemeralInputs: true,
    });
    return { scheduler, store };
  }

  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  let scheduler: BrowserScheduler;
  let worker: Worker;
  let workerActor: Principal;
  let newsProfile: string;
  let exampleProfile: string;

  async function jobRow(id: string): Promise<{ status: string; failure_reason: string | null; result: unknown; metadata: unknown; operation: unknown; lease_id: string | null }> {
    const { rows } = await pool.query("SELECT status, failure_reason, result, metadata, operation, lease_id FROM fabric_jobs WHERE id = $1", [id]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function sessionRow(id: string): Promise<{ status: string; failure_reason: string | null; metadata: unknown }> {
    const { rows } = await pool.query("SELECT status, failure_reason, metadata FROM fabric_browser_sessions WHERE id = $1", [id]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function failureEvent(subjectId: string, type: string): Promise<unknown> {
    const { rows } = await pool.query("SELECT payload FROM fabric_events WHERE subject_id = $1 AND type = $2", [subjectId, type]);
    expect(rows).toHaveLength(1);
    return rows[0].payload;
  }

  /** Dispatch the next job/session, claim its lease as the worker, and return the lease id. */
  async function dispatchAndClaim(): Promise<string> {
    await scheduler.heartbeatWorker(worker.id, workerActor);
    const [assignment] = await scheduler.dispatch();
    expect(assignment?.lease).toBeDefined();
    await scheduler.claimAssignment(worker.id, assignment!.lease!.id, workerActor);
    return assignment!.lease!.id;
  }

  beforeAll(async () => {
    ({ scheduler } = await startProcess(clock));
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    worker = await scheduler.registerWorker(makeWorker({ id: "worker_pg" as Worker["id"] }));
    workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
    newsProfile = (await scheduler.createProfile(makeProfile(worker, { ref: "profile_pg-news" as never, profileFamily: "default" }))).ref;
    exampleProfile = (await scheduler.createProfile(makeProfile(worker, { ref: "profile_pg-example" as never, volumeName: "profile-volume-g1" }))).ref;
  });

  test("a stale claimed job lease is retried, then failed with a plain-text reason", async () => {
    const job = await scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "stale-job", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example" }, profileRef: newsProfile as never, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS, ttlSeconds: 3_600, metadata: { label: "browser", attempt: 1, urgent: true, note: null } }, TEST_PRINCIPAL);

    // recipe_example-fetch@1 allows two attempts: the first stale lease requeues the job.
    await dispatchAndClaim();
    clock.advance(31_000);
    expect((await scheduler.recover()).expiredJobs).toBe(1);
    expect((await jobRow(job.id)).status).toBe("queued");

    // The second stale lease exhausts the budget. Before the fix this transaction failed with
    // `invalid input syntax for type json` because failure_reason was bound as `$19::jsonb`.
    await dispatchAndClaim();
    clock.advance(31_000);
    expect((await scheduler.recover()).expiredJobs).toBe(1);

    const row = await jobRow(job.id);
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("browser lease heartbeat expired");
    expect(row.lease_id).toBeNull();
    expect(row.result).toBeNull();
    expect(row.metadata).toEqual({ label: "browser", attempt: 1, urgent: true, note: null });
    expect(row.operation).toEqual({ operation: "fetch_page", url: "https://news.example" });
    expect(await failureEvent(job.id, "job.failed")).toEqual({ reason: "browser lease heartbeat expired" });
    expect((await scheduler.getJob(job.id as JobId, TEST_PRINCIPAL)).status).toBe("failed");
  });

  test("cancelling a queued job and a running job persists the cancellation reason", async () => {
    const queued = await scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "cancel-queued", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example/queued" }, profileRef: newsProfile as never, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS }, TEST_PRINCIPAL);
    expect((await scheduler.cancelJob(queued.id as JobId, TEST_PRINCIPAL)).status).toBe("cancelled");
    expect(await jobRow(queued.id)).toMatchObject({ status: "cancelled", failure_reason: "cancelled by client", result: null });

    const running = await scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "cancel-running", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example/running" }, profileRef: newsProfile as never, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS, ttlSeconds: 3_600 }, TEST_PRINCIPAL);
    const leaseId = await dispatchAndClaim();
    expect((await jobRow(running.id)).status).toBe("running");
    expect((await scheduler.cancelJob(running.id as JobId, TEST_PRINCIPAL)).status).toBe("cancelled");
    expect(await jobRow(running.id)).toMatchObject({ status: "cancelled", failure_reason: "cancelled by client", lease_id: leaseId });
    const { rows } = await pool.query("SELECT status FROM fabric_browser_leases WHERE id = $1", [leaseId]);
    expect(rows[0]?.status).toBe("released");
  });

  test("a completed job round-trips its JSON result", async () => {
    const job = await scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "complete", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example/done" }, profileRef: newsProfile as never, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS, ttlSeconds: 3_600 }, TEST_PRINCIPAL);
    await dispatchAndClaim();
    const result = { title: "browser", count: 3, ratio: 0.5, ok: true, missing: null, tags: ["a", "b"], nested: { quote: "\"quoted\" \\ text", unicode: "Grüße" } };
    await scheduler.completeJob(job.id as JobId, result, workerActor);
    const row = await jobRow(job.id);
    expect(row.status).toBe("succeeded");
    expect(row.failure_reason).toBeNull();
    expect(row.result).toEqual(result);
  });

  test("a stale claimed session lease times out with a plain-text reason, and cancel persists", async () => {
    const common = { project: TEST_PROJECT, runtime: "chrome" as const, browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: exampleProfile as never, leaseMode: "writer" as const, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS, ttlSeconds: 3_600 };
    const stale = await scheduler.createBrowserSession({ ...common, idempotencyKey: "stale-session", metadata: { purpose: "browser", retries: 0 } }, TEST_PRINCIPAL);
    const leaseId = await dispatchAndClaim();
    await scheduler.markLeaseStarted(leaseId as never, worker.id, workerActor);
    expect((await sessionRow(stale.id)).status).toBe("ready");
    clock.advance(31_000);
    expect((await scheduler.recover()).expiredSessions).toBe(1);
    expect(await sessionRow(stale.id)).toEqual({ status: "timed_out", failure_reason: "browser lease heartbeat expired", metadata: { purpose: "browser", retries: 0 } });
    expect(await failureEvent(stale.id, "browser_session.timed_out")).toEqual({ reason: "browser lease heartbeat expired" });

    const queued = await scheduler.createBrowserSession({ ...common, idempotencyKey: "cancel-session" }, TEST_PRINCIPAL);
    expect((await sessionRow(queued.id)).status).toBe("queued");
    await scheduler.cancelBrowserSession(queued.id as BrowserSessionId, TEST_PRINCIPAL);
    expect(await sessionRow(queued.id)).toMatchObject({ status: "cancelled", failure_reason: "cancelled by client" });
  });

  test("a restarted process reloads the persisted state", async () => {
    const restarted = await startProcess(clock);
    const snapshot = await restarted.store.snapshot();
    const jobs = [...snapshot.jobs.values()];
    expect(jobs.find((job) => job.idempotencyKey === "stale-job")).toMatchObject({ status: "failed", failureReason: "browser lease heartbeat expired" });
    expect(jobs.find((job) => job.idempotencyKey === "cancel-queued")).toMatchObject({ status: "cancelled", failureReason: "cancelled by client" });
    expect(jobs.find((job) => job.idempotencyKey === "complete")?.result).toMatchObject({ title: "browser", nested: { unicode: "Grüße" } });
    expect([...snapshot.sessions.values()].find((session) => session.idempotencyKey === "stale-session")).toMatchObject({ status: "timed_out", failureReason: "browser lease heartbeat expired" });
    expect(snapshot.activeBrowserLeases).toBe(0);
  });

  test("a ready session no client connects to is released by a sibling scheduler process after the grace", async () => {
    const recovery = await startProcess(clock);
    const common = { project: TEST_PROJECT, runtime: "chrome" as const, browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: exampleProfile as never, leaseMode: "writer" as const, egressPolicyRef: DIRECT, artifactPolicyRef: ARTIFACTS, ttlSeconds: 900 };
    const abandoned = await scheduler.createBrowserSession({ ...common, idempotencyKey: "abandoned-session" }, TEST_PRINCIPAL);
    // The recovery process caches the session while it is still allocating.
    const leaseId = await dispatchAndClaim();
    expect((await recovery.store.snapshot()).sessions.get(abandoned.id)?.status).toBe("allocating");
    await scheduler.markLeaseStarted(leaseId as never, worker.id, workerActor);

    const elapse = async (seconds: number) => {
      for (let remaining = seconds; remaining > 0; remaining -= 10) {
        clock.advance(10_000);
        await scheduler.heartbeatWorker(worker.id, workerActor);
        await scheduler.heartbeatLease(leaseId as never, worker.id, workerActor).catch(() => undefined);
        await recovery.scheduler.recover();
      }
    };
    await elapse(50);
    expect((await sessionRow(abandoned.id)).status).toBe("ready");
    await elapse(20);
    expect((await sessionRow(abandoned.id)).status).toBe("released");
    const { rows } = await pool.query("SELECT status FROM fabric_browser_leases WHERE id = $1", [leaseId]);
    expect(rows[0]?.status).toBe("released");
    expect((await scheduler.getSession(abandoned.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("released");
  });

  test("the journal stays compact and a restarted process replays its checkpoint and deltas", async () => {
    const busy = await startProcess(clock, 5);
    for (let beat = 0; beat < 23; beat++) {
      clock.advance(1_000);
      await busy.scheduler.heartbeatWorker(worker.id, workerActor);
    }
    const checkpoints = await pool.query("SELECT sequence FROM fabric_state_snapshots");
    expect(checkpoints.rows).toHaveLength(1);
    const head = await pool.query("SELECT max(sequence)::int AS head, count(*)::int AS count FROM fabric_state_deltas");
    expect(Number(checkpoints.rows[0].sequence) % 5).toBe(0);
    expect(head.rows[0].count).toBeLessThanOrEqual(10);

    const live = await busy.store.snapshot();
    const restarted = await startProcess(clock, 5);
    expect(serializeState(await restarted.store.snapshot())).toEqual(serializeState(live));
    // The long-lived process from the first test caught up incrementally to the same state.
    expect(serializeState(await scheduler.store.snapshot())).toEqual(serializeState(live));
    expect(live.workers.get(worker.id)?.lastHeartbeatAt).toBe(clock.now().toISOString());
  });
});
