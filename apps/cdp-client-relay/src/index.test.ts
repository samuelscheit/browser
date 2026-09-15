import { expect, test } from "bun:test";

import { fabricSessionUrl, parseCdpSessionRoute, relayConfigFromEnvironment, resolveFabricCdpEndpoint } from "./index";

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
