import { expect, test } from "bun:test";

import { createCdpClientRelayServer, fabricSessionUrl, parseCdpSessionRoute, parseClientApiRoute, relayConfigFromEnvironment, resolveFabricCdpEndpoint } from "./index";

test("the client relay accepts only an opaque Fabric browser-session path", () => {
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc")).toEqual({ sessionId: "browser-session_abc" });
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc?cap=opaque")).toBeUndefined();
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc/extra")).toBeUndefined();
  expect(parseCdpSessionRoute("/v1/worker-relay/worker_x/browser-lease_y")).toBeUndefined();
});

test("the client relay always looks up the fixed Fabric API session", () => {
  const route = parseCdpSessionRoute("/v1/cdp/browser-session_abc")!;
  expect(fabricSessionUrl({ apiBaseUrl: "https://fabric.internal.example/v1" } as never, route))
    .toBe("https://fabric.internal.example/v1/browser-sessions/browser-session_abc");
});

test("the client relay exposes only write-only browser session lifecycle routes", () => {
  expect(parseClientApiRoute("/v1/browser-sessions", "POST")).toEqual({ path: "/browser-sessions" });
  expect(parseClientApiRoute("/v1/browser-sessions/browser-session_abc/heartbeat", "POST"))
    .toEqual({ path: "/browser-sessions/browser-session_abc/heartbeat" });
  expect(parseClientApiRoute("/v1/browser-sessions/browser-session_abc/release", "POST"))
    .toEqual({ path: "/browser-sessions/browser-session_abc/release" });
  expect(parseClientApiRoute("/v1/browser-sessions/browser-session_abc/cancel", "POST"))
    .toEqual({ path: "/browser-sessions/browser-session_abc/cancel" });
  expect(parseClientApiRoute("/v1/browser-sessions/browser-session_abc", "GET")).toBeUndefined();
  expect(parseClientApiRoute("/v1/jobs", "POST")).toBeUndefined();
  expect(parseClientApiRoute("/v1/browser-sessions?project=other", "POST")).toBeUndefined();
});

test("the HTTP lifecycle relay authenticates upstream and strips CDP capability material", async () => {
  const originalFetch = globalThis.fetch;
  let seen: { url?: string; authorization?: string; idempotencyKey?: string } = {};
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    seen = {
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      idempotencyKey: headers.get("idempotency-key") ?? undefined,
    };
    return Response.json({ id: "browser-session_abc", status: "ready", cdpEndpoint: "wss://fabric/v1/cdp/browser-session_abc?cap=secret" });
  }) as typeof globalThis.fetch;
  const relay = createCdpClientRelayServer({
    apiBaseUrl: "https://fabric.example/v1",
    cdpGatewayBaseUrl: "ws://fabric.example",
    headers: { authorization: "Basic internal-only" },
    maxConnections: 1,
    readyTimeoutMs: 5_000,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = relay.server.address();
    if (!address || typeof address === "string") throw new Error("relay test server did not bind a TCP port");
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/browser-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "reporting-test" },
      body: JSON.stringify({ project: "project_reporting_support" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "browser-session_abc", status: "ready" });
    expect(seen).toEqual({
      url: "https://fabric.example/v1/browser-sessions",
      authorization: "Basic internal-only",
      idempotencyKey: "reporting-test",
    });
  } finally {
    await relay.close();
    globalThis.fetch = originalFetch;
  }
});

test("relay configuration refuses missing password credentials before it can serve a connection", () => {
  expect(() => relayConfigFromEnvironment({
    FABRIC_API_URL: "https://fabric.example/v1/other",
    FABRIC_CDP_GATEWAY_URL: "ws://fabric.example",
    FABRIC_API_USERNAME: "principal_reporting",
  })).toThrow("FABRIC_API_PASSWORD");
});

test("the relay waits internally for readiness instead of giving a capability to its caller", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let now = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json(calls === 1
      ? { id: "browser-session_abc", status: "allocating" }
      : { id: "browser-session_abc", status: "ready", cdpEndpoint: "wss://fabric.example/v1/cdp/browser-session_abc?cap=opaque" });
  }) as unknown as typeof globalThis.fetch;
  try {
    const endpoint = await resolveFabricCdpEndpoint({
      apiBaseUrl: "https://fabric.example/v1",
      cdpGatewayBaseUrl: "ws://fabric.example",
      headers: {},
      maxConnections: 1,
      readyTimeoutMs: 5_000,
    }, { sessionId: "browser-session_abc" }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    });
    expect(endpoint).toContain("cap=opaque");
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
