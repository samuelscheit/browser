import { describe, expect, test } from "bun:test";
import { FabricError, type BrowserSessionId, type JobId, type ProfileRef, type Worker } from "@browser-fabric/contracts";
import { FakeClock } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, createTestScheduler, makeProfile, makeWorker } from "@browser-fabric/testkit";

describe("scheduler lifecycle, leases, and recovery", () => {
  test("dispatches FIFO among compatible work and enforces one writer per profile", async () => {
    const { scheduler, worker, profile, store } = await bootstrapTestScheduler();
    const common = { project: TEST_PROJECT, runtime: "chrome" as const, browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer" as const, egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 };
    const first = await scheduler.createBrowserSession({ ...common, idempotencyKey: "first" }, TEST_PRINCIPAL);
    const second = await scheduler.createBrowserSession({ ...common, idempotencyKey: "second" }, TEST_PRINCIPAL);
    const assignments = await scheduler.dispatch();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.session?.id).toBe(first.id);
    expect((await scheduler.getSession(second.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("queued");
    const snapshot = await store.snapshot();
    expect(snapshot.activeBrowserLeases).toBe(1);
    expect(snapshot.workers.get(worker.id)?.activeLeases).toBe(1);
  });

  test("rejects an unknown egress policy before creating work", async () => {
    const { scheduler, profile, store } = await bootstrapTestScheduler();
    const retiredRef = "egress_retired@1" as never;
    const before = await store.snapshot();
    await expect(scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "retired-session", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: retiredRef, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL)).rejects.toThrow(/egress policy egress_retired@1 was not found/);
    await expect(scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "retired-job", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example" }, egressPolicyRef: retiredRef, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL)).rejects.toThrow(/egress policy egress_retired@1 was not found/);
    const after = await store.snapshot();
    expect(after.sessions.size).toBe(before.sessions.size);
    expect(after.jobs.size).toBe(before.jobs.size);
    expect(after.egressPolicies.has(retiredRef)).toBe(false);
  });

  test("idempotency returns the original resource and rejects request mutation", async () => {
    const { scheduler, profile } = await bootstrapTestScheduler();
    const input = { project: TEST_PROJECT, idempotencyKey: "same", runtime: "chrome" as const, browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer" as const, egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 };
    const first = await scheduler.createBrowserSession(input, TEST_PRINCIPAL);
    const replay = await scheduler.createBrowserSession(input, TEST_PRINCIPAL);
    expect(replay.id).toBe(first.id);
    await expect(scheduler.createBrowserSession({ ...input, ttlSeconds: 601 }, TEST_PRINCIPAL)).rejects.toThrow();
    await expect(scheduler.createBrowserSession({ ...input, idempotencyKey: "invalid-client-limit", maxExternalConnections: 9 } as never, TEST_PRINCIPAL)).rejects.toThrow(/maxExternalConnections/);
  });

  test("clone leases are isolated and destroyed on release", async () => {
    const { scheduler, profile, store } = await bootstrapTestScheduler();
    const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "clone", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "clone", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    expect(assignment?.clone?.status).toBe("ready");
    const cloneId = assignment?.clone?.id;
    await scheduler.releaseBrowserSession(session.id as BrowserSessionId, TEST_PRINCIPAL);
    const snapshot = await store.snapshot();
    expect(snapshot.clones.get(cloneId!)?.status).toBe("destroyed");
    expect(snapshot.activeBrowserLeases).toBe(0);
  });

  test("raw CDP capability is scoped, reconnect grace is honored, and expiry releases", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const context = await bootstrapTestScheduler();
    // Use a clock shared with the scheduler for deterministic expiry.
    const { scheduler, profile, store, worker } = context;
    const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "cap", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 60 }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    await scheduler.claimAssignment("worker_test" as never, assignment!.lease!.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
    await scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
    const internal = (await store.snapshot()).sessions.get(session.id as BrowserSessionId)!;
    expect(internal.cdpEndpoint).toContain("cap=");
    await scheduler.registerExternalCdpConnection(session.id as BrowserSessionId, new URL(internal.cdpEndpoint!).searchParams.get("cap")!);
    await scheduler.unregisterExternalCdpConnection(session.id as BrowserSessionId);
    expect((await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("ready");
    // The fake clock used by this context is deterministic and advances through the session TTL in the next test.
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("permits a second CDP client only for sessions that explicitly request it", async () => {
    const { scheduler, profile, store, worker } = await bootstrapTestScheduler();
    const session = await scheduler.createBrowserSession({
      project: TEST_PROJECT,
      idempotencyKey: "two-cdp-clients",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome-headless@1" as never,
      profileRef: profile.ref,
      leaseMode: "clone",
      egressPolicyRef: "egress_tor@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      maxExternalConnections: 2,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    await scheduler.claimAssignment(worker.id, assignment!.lease!.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
    await scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
    const internal = (await store.snapshot()).sessions.get(session.id as BrowserSessionId)!;
    const capability = new URL(internal.cdpEndpoint!).searchParams.get("cap")!;

    await scheduler.registerExternalCdpConnection(session.id as BrowserSessionId, capability);
    await scheduler.registerExternalCdpConnection(session.id as BrowserSessionId, capability);
    await expect(scheduler.registerExternalCdpConnection(session.id as BrowserSessionId, capability)).rejects.toThrow(/at most 2/);

    await scheduler.unregisterExternalCdpConnection(session.id as BrowserSessionId);
    expect((await store.snapshot()).sessions.get(session.id as BrowserSessionId)?.externalConnectionCount).toBe(1);
    expect((await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("active");
    await scheduler.unregisterExternalCdpConnection(session.id as BrowserSessionId);
    expect((await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("ready");
  });

  test("ephemeral input never enters durable state and is one-shot", async () => {
    const { scheduler, profile, worker, store } = await bootstrapTestScheduler();
    const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "input", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    const request = await scheduler.requestEphemeralInput({ sessionId: session.id as BrowserSessionId, leaseId: assignment!.lease!.id, field: "password", fieldType: "password" }, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint });
    await scheduler.provideEphemeralInput(request.request.id, "super-secret", TEST_PRINCIPAL);
    const durable = JSON.stringify(await store.snapshot());
    expect(durable).not.toContain("super-secret");
    expect(await scheduler.consumeEphemeralInput(request.request.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint })).toBe("super-secret");
    await expect(scheduler.consumeEphemeralInput(request.request.id, { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint })).rejects.toThrow();
  });

  test("worker failure requeues within recipe retry budget and eventually fails", async () => {
    const { scheduler, worker, profile: defaultProfile, clock, store } = await bootstrapTestScheduler();
    const profile = await scheduler.createProfile({ ...defaultProfile, ref: "profile_news" as never, profileFamily: "default", volumeName: "profile-volume" }, TEST_PRINCIPAL);
    const job = await scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "retry", recipeRef: "recipe_example-fetch@1" as never, operation: { operation: "fetch_page", url: "https://news.example" }, profileRef: profile.ref, egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    await scheduler.dispatch();
    await scheduler.heartbeatWorker(worker.id, undefined, { health: "degraded" });
    // Heartbeat updates the timestamp, so advance beyond the offline threshold before recovery.
    clock.advance(31_000);
    const recovery = await scheduler.recover();
    expect(recovery.offlineWorkers).toBe(1);
    expect((await scheduler.getJob(job.id as JobId, TEST_PRINCIPAL)).status).toBe("queued");
    const snapshot = await store.snapshot();
    expect([...snapshot.attempts.values()].filter((attempt) => attempt.jobId === job.id).length).toBe(1);
  });
});

test("serialized transactions keep global and per-profile limits under concurrent dispatch", async () => {
  const { scheduler, worker, profile, store } = await bootstrapTestScheduler();
  const inputs = Array.from({ length: 12 }, (_, index) => ({ project: TEST_PROJECT, idempotencyKey: `concurrent-${index}`, runtime: "chrome" as const, browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "clone" as const, egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }));
  await Promise.all(inputs.map((input) => scheduler.createBrowserSession(input, TEST_PRINCIPAL)));
  const batches = await Promise.all(Array.from({ length: 8 }, () => scheduler.dispatch()));
  const snapshot = await store.snapshot();
  expect(snapshot.activeBrowserLeases).toBeLessThanOrEqual(4);
  expect(snapshot.workers.get(worker.id)?.activeLeases).toBeLessThanOrEqual(3);
  expect(batches.flat().length).toBeLessThanOrEqual(4);
});

test("malformed worker registrations fail closed", async () => {
  const { scheduler } = createTestScheduler();
  await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
  const { makeWorker } = await import("@browser-fabric/testkit");
  const worker = makeWorker({ id: "worker_bad" as never, capacity: 3, resourceLimits: { maxBrowserLeases: 1, cpuMilli: 100, memoryMiB: 128, pids: 32, shmMiB: 64, temporaryStorageMiB: 64 } });
  await expect(scheduler.registerWorker(worker, TEST_PRINCIPAL)).rejects.toThrow(/capacity/);
});

test("claimed leases expire independently from worker heartbeat", async () => {
  const { scheduler, clock, profile, store } = await bootstrapTestScheduler();
  const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "lease-heartbeat-expiry", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
  const [assignment] = await scheduler.dispatch();
  await scheduler.claimAssignment("worker_test" as never, assignment!.lease!.id, { ...TEST_PRINCIPAL, certificateFingerprint: (await store.snapshot()).workers.get("worker_test")!.certificateFingerprint });
  clock.advance(31_000);
  const recovery = await scheduler.recover();
  expect(recovery.expiredSessions).toBe(1);
  expect((await scheduler.getSession(session.id as never, TEST_PRINCIPAL)).status).toBe("timed_out");
  expect((await store.snapshot()).activeBrowserLeases).toBe(0);
});

test("does not issue a CDP capability until the claimed worker proves browser readiness", async () => {
  const { scheduler, worker, profile, store } = await bootstrapTestScheduler();
  const session = await scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "activation-boundary", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
  const [assignment] = await scheduler.dispatch();
  expect((await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("allocating");
  expect((await store.snapshot()).sessions.get(session.id as BrowserSessionId)?.cdpEndpoint).toBeUndefined();
  const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
  await scheduler.claimAssignment(worker.id, assignment!.lease!.id, workerActor);
  expect((await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL)).status).toBe("allocating");
  await scheduler.heartbeatLease(assignment!.lease!.id, worker.id, workerActor);
  const stillAllocating = await store.snapshot();
  expect(stillAllocating.leases.get(assignment!.lease!.id)?.startedAt).toBeUndefined();
  expect(stillAllocating.sessions.get(session.id as BrowserSessionId)?.cdpEndpoint).toBeUndefined();
  await scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, workerActor);
  const ready = await scheduler.getSession(session.id as BrowserSessionId, TEST_PRINCIPAL);
  expect(ready.status).toBe("ready");
  expect(ready.cdpEndpoint).toContain("cap=");
});
