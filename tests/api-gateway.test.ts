import { describe, expect, test } from "bun:test";
import { createApiFetch } from "../apps/api/src/index";
import { CdpGateway } from "../apps/cdp-gateway/src/index";
import { CapabilitySigner, FakeClock } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler } from "@browser-fabric/testkit";
import type { BrowserSessionId } from "@browser-fabric/contracts";

describe("private API and CDP gateway boundary", () => {
  test("requires an authenticated principal and enforces idempotency header", async () => {
    const { scheduler } = await bootstrapTestScheduler();
    const unauthenticated = createApiFetch({ scheduler, authenticate: () => undefined });
    const noAuth = await unauthenticated(new Request("https://fabric.test/v1/browser-sessions", { method: "POST" }));
    expect(noAuth.status).toBe(401);

    const authenticated = createApiFetch({ scheduler, authenticate: () => TEST_PRINCIPAL });
    const payload = {
      project: TEST_PROJECT,
      idempotencyKey: "api-1",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome-headless@1",
      profileRef: "profile_missing",
      leaseMode: "writer",
      egressPolicyRef: "egress_direct@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      ttlSeconds: 600
    };
    const missingHeader = await authenticated(new Request("https://fabric.test/v1/browser-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    expect(missingHeader.status).toBe(400);
    expect((await missingHeader.json()).code).toBe("validation_failed");
  });

  test("does not retain the legacy plaintext input endpoint", async () => {
    const context = await bootstrapTestScheduler();
    const fetchApi = createApiFetch({ scheduler: context.scheduler, authenticate: () => TEST_PRINCIPAL });
    const response = await fetchApi(new Request("https://fabric.test/v1/input-requests/input-request_legacy/value", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "must-not-enter-control-plane" }),
    }));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  test("serves /v1 routes and RFC problem responses", async () => {
    const context = await bootstrapTestScheduler();
    const fetchApi = createApiFetch({ scheduler: context.scheduler, authenticate: () => TEST_PRINCIPAL });
    const payload = {
      project: TEST_PROJECT,
      idempotencyKey: "api-2",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome-headless@1",
      profileRef: context.profile.ref,
      leaseMode: "writer",
      egressPolicyRef: "egress_direct@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      ttlSeconds: 600
    };
    const response = await fetchApi(new Request("https://fabric.test/v1/browser-sessions", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-2" }, body: JSON.stringify(payload) }));
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    const get = await fetchApi(new Request(`https://fabric.test/v1/browser-sessions/${body.id}`));
    expect(get.status).toBe(200);
    const missing = await fetchApi(new Request("https://fabric.test/v1/no-such-route"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("problem+json");
  });

  test("CDP gateway validates capability before accepting an upgrade", async () => {
    const context = await bootstrapTestScheduler();
    const signer = new CapabilitySigner({ secret: "01234567890123456789012345678901", clock: context.clock, gatewayBaseUrl: "wss://fabric.test" });
    const gateway = new CdpGateway({ scheduler: context.scheduler, capabilitySigner: signer, upstream: { connect: async () => { throw new Error("not reached"); } } });
    const bad = await gateway.fetch(new Request("https://fabric.test/v1/cdp/browser-session_missing?cap=bad", { headers: { upgrade: "websocket" } }));
    expect(bad.status).toBe(404);

    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "gateway", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const worker = (await context.store.snapshot()).workers.get("worker_test" as never)!;
    const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
    await context.scheduler.claimAssignment(worker.id, assignment!.lease!.id, workerActor);
    await context.scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, workerActor);
    const internal = (await context.store.snapshot()).sessions.get(session.id as BrowserSessionId)!;
    const token = new URL(internal.cdpEndpoint!).searchParams.get("cap")!;
    const rejected = await gateway.fetch(new Request(`https://fabric.test/v1/cdp/${session.id}?cap=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } }));
    // Non-Bun fetch adapter deliberately returns a 426 rather than pretending to upgrade.
    expect(rejected.status).toBe(426);
  });

  test("CDP gateway sends the assigned project to ingress authorization", async () => {
    const context = await bootstrapTestScheduler();
    const signer = new CapabilitySigner({ secret: "01234567890123456789012345678901", clock: context.clock, gatewayBaseUrl: "wss://fabric.test" });
    const seen: Array<{ kind: string; project?: string }> = [];
    const gateway = new CdpGateway({
      scheduler: context.scheduler,
      capabilitySigner: signer,
      upstream: { connect: async () => { throw new Error("not reached"); } },
      authenticate: (_request, scope) => { seen.push(scope); return false; },
    });
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "gateway-project-auth", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const worker = (await context.store.snapshot()).workers.get("worker_test" as never)!;
    const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
    await context.scheduler.claimAssignment(worker.id, assignment!.lease!.id, workerActor);
    await context.scheduler.markLeaseStarted(assignment!.lease!.id, worker.id, workerActor);
    const internal = (await context.store.snapshot()).sessions.get(session.id as BrowserSessionId)!;
    const token = new URL(internal.cdpEndpoint!).searchParams.get("cap")!;
    const response = await gateway.fetch(new Request(`https://fabric.test/v1/cdp/${session.id}?cap=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(403);
    expect(seen).toEqual([{ kind: "cdp", project: TEST_PROJECT }]);
  });

  test("federated relay authorization binds the active local lease to its worker certificate", async () => {
    const context = await bootstrapTestScheduler({ localWorker: true });
    const profile = await context.scheduler.createProfile({
      ...context.profile,
      ref: "profile_gateway_local" as never,
      profileFamily: "default",
      volumeName: "profile-volume",
    }, TEST_PRINCIPAL);
    const session = await context.scheduler.createBrowserSession({
      project: TEST_PROJECT,
      idempotencyKey: "gateway-local-relay",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1" as never,
      profileRef: profile.ref,
      leaseMode: "interactive",
      egressPolicyRef: "egress_direct@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const gateway = new CdpGateway({
      scheduler: context.scheduler,
      capabilitySigner: new CapabilitySigner({ secret: "01234567890123456789012345678901", clock: context.clock, gatewayBaseUrl: "wss://fabric.test" }),
      upstream: { connect: async () => { throw new Error("not reached"); } },
      authenticate: () => true,
    });
    const worker = (await context.store.snapshot()).workers.get(context.worker.id)!;
    const route = `/v1/worker-relay/${worker.id}/${assignment!.lease!.id}`;
    const accepted = await gateway.authorizeReverseRelay(new Request(`https://fabric.test${route}`, {
      headers: { upgrade: "websocket", "x-fabric-worker-cert-fingerprint": worker.certificateFingerprint },
    }));
    expect(accepted).toEqual({ workerId: worker.id, leaseId: assignment!.lease!.id });
    await expect(gateway.authorizeReverseRelay(new Request(`https://fabric.test${route}`, { headers: { upgrade: "websocket" } }))).rejects.toMatchObject({ code: "authorization_denied" });
    await context.scheduler.cancelBrowserSession(session.id, TEST_PRINCIPAL);
  });
});

test("CDP capability URLs leave the host only over TLS; plain ws is accepted for a loopback edge only", async () => {
  const { CapabilitySigner } = await import("@browser-fabric/control-plane");
  const secret = "01234567890123456789012345678901";
  for (const gatewayBaseUrl of ["wss://fabric.example.com", "ws://127.0.0.1:18086", "ws://localhost:18086", "ws://[::1]:18086"]) {
    expect(() => new CapabilitySigner({ secret, gatewayBaseUrl })).not.toThrow();
  }
  for (const gatewayBaseUrl of ["ws://fabric.example.com", "ws://127.0.0.1.example.com", "http://127.0.0.1:18086", "not a url"]) {
    expect(() => new CapabilitySigner({ secret, gatewayBaseUrl })).toThrow(/wss:\/\//);
  }
});
