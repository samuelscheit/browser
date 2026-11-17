import { describe, expect, test } from "bun:test";
import { ReverseCdpRelayRegistry, RELAY_OPEN, RELAY_CLOSED } from "../apps/cdp-gateway/src/reverse-relay";
import { OutboundCdpRelay } from "../apps/local-agent/src/cdp-relay";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, makeWorker } from "@browser-fabric/testkit";

class FakeSocket {
  readyState = RELAY_OPEN;
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  closed = false;
  private listeners = new Map<string, Set<(event: any) => void>>();
  send(data: string | ArrayBuffer | Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = RELAY_CLOSED; this.emit("close", {}); }
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }) {
    const listeners = this.listeners.get(type) ?? new Set();
    const wrapped = options?.once ? (event: any) => { listeners.delete(wrapped); listener(event); } : listener;
    listeners.add(wrapped); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe("federated reverse CDP relay", () => {
  test("waiters receive a registered socket and replacement cannot remove the new socket", async () => {
    const registry = new ReverseCdpRelayRegistry();
    const pending = registry.waitFor("worker_local:browser-lease_1", 100);
    const first = new FakeSocket();
    registry.register("worker_local:browser-lease_1", first);
    expect(await pending).toBe(first);
    const second = new FakeSocket();
    registry.register("worker_local:browser-lease_1", second);
    first.emit("close", {});
    expect(registry.get("worker_local:browser-lease_1")).toBe(second);
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  test("outbound relay copies complete frames in both directions and closes both peers", async () => {
    const browser = new FakeSocket();
    const gateway = new FakeSocket();
    const sockets: FakeSocket[] = [];
    const relay = new OutboundCdpRelay({
      gatewayUrl: "wss://fabric.example/v1/worker-relay/{workerId}/{leaseId}",
      workerId: "worker_local" as never,
      leaseId: "browser-lease_1",
      browserEndpoint: "ws://127.0.0.1:9222/devtools/browser/test",
      headers: { "x-fabric-worker-cert-fingerprint": "fingerprint" },
      socketFactory: (url) => { const socket = url.startsWith("wss:") ? gateway : browser; sockets.push(socket); return socket as unknown as WebSocket; },
    });
    await relay.start();
    browser.emit("message", { data: "browser-frame" });
    gateway.emit("message", { data: new Uint8Array([1, 2, 3]) });
    expect(gateway.sent).toEqual(["browser-frame"]);
    expect(browser.sent).toHaveLength(1);
    await relay.stop();
    expect(browser.closed).toBe(true);
    expect(gateway.closed).toBe(true);
    expect(relay.connected).toBe(false);
  });

  test("local worker leases use an opaque reverse endpoint and never expose loopback to the gateway", async () => {
    const context = await bootstrapTestScheduler({ localWorker: true });
    const profile = await context.scheduler.createProfile({ ...context.profile, ref: "profile_local_interactive" as never, profileFamily: "interactive" }, TEST_PRINCIPAL);
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "local-reverse", runtime: "chromium-cdp", browserRecipeRef: "recipe_interactive-chromium@1" as never, profileRef: profile.ref, leaseMode: "interactive", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    expect(assignment?.lease?.internalCdpEndpoint).toMatch(/^reverse:\/\/worker_local\/browser-lease_/);
    const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
    await context.scheduler.claimAssignment(context.worker.id, assignment!.lease!.id, undefined, actor);
    await context.scheduler.markLeaseStarted(assignment!.lease!.id, context.worker.id, actor);
    expect((await context.scheduler.getSession(session.id as never, TEST_PRINCIPAL)).cdpEndpoint).toContain("wss://fabric.test/v1/cdp/");
  });
});
