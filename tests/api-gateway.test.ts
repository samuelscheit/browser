import { describe, expect, test } from "bun:test";
import { createApiFetch } from "../apps/api/src/index";
import { CdpGateway } from "../apps/cdp-gateway/src/index";
import { CapabilitySigner, FakeClock } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler } from "@browser-fabric/testkit";
import type { BrowserSessionId } from "@browser-fabric/contracts";

describe("private API and CDP gateway boundary", () => {
  test("requires mTLS principal and enforces idempotency header", async () => {
    const { scheduler } = await bootstrapTestScheduler();
    const unauthenticated = createApiFetch({ scheduler, authenticate: () => undefined });
    const noAuth = await unauthenticated(new Request("https://fabric.test/v1/browser-sessions", { method: "POST" }));
    expect(noAuth.status).toBe(401);

    const authenticated = createApiFetch({ scheduler, authenticate: () => TEST_PRINCIPAL });
    const payload = {
      project: TEST_PROJECT,
      idempotencyKey: "api-1",
      runtime: "rebrowser-puppeteer",
      browserRecipeRef: "recipe_rebrowser-reporting@1",
      profileRef: "profile_missing",
      leaseMode: "writer",
      egressPolicyRef: "egress_reporting-residential@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      ttlSeconds: 600
    };
    const missingHeader = await authenticated(new Request("https://fabric.test/v1/browser-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    expect(missingHeader.status).toBe(400);
    expect((await missingHeader.json()).code).toBe("validation_failed");
  });

  test("serves /v1 routes and RFC problem responses", async () => {
    const context = await bootstrapTestScheduler();
    const fetchApi = createApiFetch({ scheduler: context.scheduler, authenticate: () => TEST_PRINCIPAL });
    const payload = {
      project: TEST_PROJECT,
      idempotencyKey: "api-2",
      runtime: "rebrowser-puppeteer",
      browserRecipeRef: "recipe_rebrowser-reporting@1",
      profileRef: context.profile.ref,
      leaseMode: "writer",
      egressPolicyRef: "egress_reporting-residential@1",
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

    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "gateway", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_reporting-residential@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    await context.scheduler.dispatch();
    const internal = (await context.store.snapshot()).sessions.get(session.id as BrowserSessionId)!;
    const token = new URL(internal.cdpEndpoint!).searchParams.get("cap")!;
    const rejected = await gateway.fetch(new Request(`https://fabric.test/v1/cdp/${session.id}?cap=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } }));
    // Non-Bun fetch adapter deliberately returns a 426 rather than pretending to upgrade.
    expect(rejected.status).toBe(426);
  });
});
