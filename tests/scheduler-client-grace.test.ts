import { describe, expect, test } from "bun:test";
import type { BrowserLease, BrowserSessionId, Principal, Worker } from "@browser-fabric/contracts";
import { BrowserScheduler, CapabilitySigner, FakeClock, InMemoryFabricStore, MemoryEphemeralInputVault, cdpClientGraceSecondsFromEnvironment } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, exampleCatalog, makeProfile, makeWorker } from "@browser-fabric/testkit";

const SESSION = {
  project: TEST_PROJECT,
  runtime: "chrome" as const,
  browserRecipeRef: "recipe_chrome-headless@1" as never,
  leaseMode: "clone" as const,
  egressPolicyRef: "egress_direct@1" as never,
  artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
  ttlSeconds: 900,
};

/** A scheduler whose worker and leases keep heartbeating, so only the client grace or the TTL can end a session. */
async function graceFixture(options: { cdpClientGraceSeconds?: number; maxActiveBrowserLeases?: number } = {}) {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const store = new InMemoryFabricStore();
  const scheduler = new BrowserScheduler({
    store,
    clock,
    catalog: exampleCatalog,
    capabilitySigner: new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" }),
    ephemeralInputVault: new MemoryEphemeralInputVault(() => clock.now()),
    allowPlaintextEphemeralInputs: true,
    ...options,
  });
  await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
  const worker = makeWorker({ id: "worker_grace" as Worker["id"] });
  await scheduler.registerWorker(worker);
  const profile = makeProfile(worker);
  await scheduler.createProfile(profile);
  const workerActor: Principal = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
  const leases = new Set<BrowserLease["id"]>();

  const status = async (id: string) => (await scheduler.getSession(id as BrowserSessionId, TEST_PRINCIPAL)).status;
  const create = async (key: string) => (await scheduler.createBrowserSession({ ...SESSION, profileRef: profile.ref, idempotencyKey: key }, TEST_PRINCIPAL)).id as BrowserSessionId;
  /** Dispatch, claim and start the next queued session, as a worker does. */
  const start = async () => {
    const [assignment] = await scheduler.dispatch();
    const lease = assignment!.lease!;
    await scheduler.claimAssignment(worker.id, lease.id, workerActor);
    await scheduler.markLeaseStarted(lease.id, worker.id, workerActor);
    leases.add(lease.id);
    return assignment!.session!.id as BrowserSessionId;
  };
  const capability = async (id: BrowserSessionId) => new URL((await store.snapshot()).sessions.get(id)!.cdpEndpoint!).searchParams.get("cap")!;
  /** Let time pass in heartbeat-sized steps, then run the scheduler's recovery tick. */
  const elapse = async (seconds: number) => {
    for (let remaining = seconds; remaining > 0; remaining -= 10) {
      clock.advance(Math.min(10, remaining) * 1_000);
      await scheduler.heartbeatWorker(worker.id, workerActor);
      for (const lease of leases) await scheduler.heartbeatLease(lease, worker.id, workerActor).catch(() => undefined);
      await scheduler.recover();
    }
  };
  return { scheduler, store, create, start, status, capability, elapse };
}

describe("CDP client grace", () => {
  test("a ready session no client connects to is released after the grace and frees its slot", async () => {
    const fixture = await graceFixture({ maxActiveBrowserLeases: 1 });
    const abandoned = await fixture.create("abandoned");
    const waiting = await fixture.create("waiting");
    expect(await fixture.start()).toBe(abandoned);
    expect(await fixture.status(waiting)).toBe("queued");

    await fixture.elapse(50);
    expect(await fixture.status(abandoned)).toBe("ready");
    await fixture.elapse(20);
    expect(await fixture.status(abandoned)).toBe("released");
    const state = await fixture.store.snapshot();
    expect(state.activeBrowserLeases).toBe(0);
    expect([...state.leases.values()].find((lease) => lease.sessionId === abandoned)?.status).toBe("released");
    const released = [...state.events.values()].find((event) => event.subject.id === abandoned && event.type === "browser_session.released");
    expect(released?.payload).toEqual({ reason: "no CDP client connected within the grace period" });

    // The slot the abandoned session held now serves the queued one, long before the 900 s TTL.
    expect(await fixture.start()).toBe(waiting);
    expect(await fixture.status(waiting)).toBe("ready");
  });

  test("a connected session outlives the grace until its client leaves", async () => {
    const fixture = await graceFixture();
    await fixture.create("connected");
    const session = await fixture.start();
    await fixture.scheduler.registerExternalCdpConnection(session, await fixture.capability(session));
    await fixture.elapse(300);
    expect(await fixture.status(session)).toBe("active");

    await fixture.scheduler.unregisterExternalCdpConnection(session);
    await fixture.elapse(50);
    expect(await fixture.status(session)).toBe("ready");
    await fixture.elapse(20);
    expect(await fixture.status(session)).toBe("released");
  });

  test("a client that reconnects within the grace keeps its session, and each disconnect restarts the grace", async () => {
    const fixture = await graceFixture();
    await fixture.create("reconnecting");
    const session = await fixture.start();
    const capability = await fixture.capability(session);
    // Connecting late, but within the grace that started at readiness, is fine.
    await fixture.elapse(40);
    await fixture.scheduler.registerExternalCdpConnection(session, capability);
    for (let round = 0; round < 3; round++) {
      await fixture.scheduler.unregisterExternalCdpConnection(session);
      await fixture.elapse(50);
      expect(await fixture.status(session)).toBe("ready");
      await fixture.scheduler.registerExternalCdpConnection(session, capability);
      expect(await fixture.status(session)).toBe("active");
    }
    await fixture.elapse(120);
    expect(await fixture.status(session)).toBe("active");
  });

  test("queued and allocating sessions are not subject to the grace", async () => {
    const fixture = await graceFixture({ maxActiveBrowserLeases: 1 });
    await fixture.create("holder");
    const holder = await fixture.start();
    await fixture.scheduler.registerExternalCdpConnection(holder, await fixture.capability(holder));
    const queued = await fixture.create("queued");
    await fixture.elapse(300);
    expect(await fixture.status(queued)).toBe("queued");
    expect((await fixture.store.snapshot()).sessions.get(queued)?.reconnectGraceUntil).toBeUndefined();
  });

  test("the grace is configurable and validated", async () => {
    const fixture = await graceFixture({ cdpClientGraceSeconds: 10 });
    await fixture.create("short");
    const session = await fixture.start();
    await fixture.elapse(10);
    expect(await fixture.status(session)).toBe("released");

    for (const cdpClientGraceSeconds of [0, 4, 3_601, 1.5]) {
      expect(() => new BrowserScheduler({ cdpClientGraceSeconds })).toThrow("CDP client grace must be an integer from 5 to 3600 seconds");
    }
    expect(cdpClientGraceSecondsFromEnvironment({})).toBe(60);
    expect(cdpClientGraceSecondsFromEnvironment({ FABRIC_CDP_CLIENT_GRACE_SECONDS: " 45 " })).toBe(45);
    for (const value of ["4", "3601", "1.5", "sixty", "-1"]) {
      expect(() => cdpClientGraceSecondsFromEnvironment({ FABRIC_CDP_CLIENT_GRACE_SECONDS: value })).toThrow("FABRIC_CDP_CLIENT_GRACE_SECONDS must be an integer from 5 to 3600");
    }
  });
});
