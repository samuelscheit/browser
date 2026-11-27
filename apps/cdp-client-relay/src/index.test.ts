import { expect, test } from "bun:test";
import WebSocket from "ws";

import { createCdpClientRelayServer, fabricSessionUrl, parseCdpSessionRoute, parseClientApiRoute, relayConfigFromEnvironment, relayProblem, resolveFabricCdpEndpoint } from "./index";

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
      headers: { "content-type": "application/json", "idempotency-key": "example-test" },
      body: JSON.stringify({ project: "project_example" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "browser-session_abc", status: "ready" });
    expect(seen).toEqual({
      url: "https://fabric.example/v1/browser-sessions",
      authorization: "Basic internal-only",
      idempotencyKey: "example-test",
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
    FABRIC_API_USERNAME: "principal_example",
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

type FabricApiCall = { method: string; url: string };

/**
 * A relay in front of a fake Fabric API. `sessionStatus` answers the readiness poll; every call
 * is recorded so tests can see lookups and cancellations.
 */
async function startRelay(options: { readyTimeoutMs?: number; sessionStatus?: () => string; respond?: (call: FabricApiCall) => Response | undefined } = {}) {
  const originalFetch = globalThis.fetch;
  const calls: FabricApiCall[] = [];
  const cancelled: Array<() => void> = [];
  globalThis.fetch = (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input) };
    calls.push(call);
    const custom = options.respond?.(call);
    if (custom) return custom;
    if (call.url.endsWith("/cancel")) {
      for (const notify of cancelled.splice(0)) notify();
      return Response.json({ id: "browser-session_abc", status: "cancelled" });
    }
    return Response.json({ id: "browser-session_abc", status: options.sessionStatus?.() ?? "queued" });
  }) as typeof globalThis.fetch;
  const relay = createCdpClientRelayServer({
    apiBaseUrl: "https://fabric.example/v1",
    cdpGatewayBaseUrl: "ws://fabric.example",
    headers: { authorization: "Basic internal-only" },
    maxConnections: 4,
    readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const address = relay.server.address();
  if (!address || typeof address === "string") throw new Error("relay test server did not bind a TCP port");
  const base = `127.0.0.1:${address.port}`;
  return {
    calls,
    cancels: () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/cancel")),
    lookups: () => calls.filter((call) => call.method === "GET"),
    /** Resolves on the next cancellation request. */
    nextCancel: () => new Promise<void>((resolve) => cancelled.push(resolve)),
    http: (path: string, init?: RequestInit) => originalFetch(`http://${base}${path}`, init),
    connect: async (sessionId = "browser-session_abc") => {
      const socket = new WebSocket(`ws://${base}/v1/cdp/${sessionId}`);
      await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
      return socket;
    },
    closed: (socket: WebSocket) => new Promise<number>((resolve) => socket.once("close", (code) => resolve(code))),
    stop: async () => {
      await relay.close();
      globalThis.fetch = originalFetch;
    },
  };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

test("a client that disconnects before its session is ready cancels the session and stops polling", async () => {
  const relay = await startRelay();
  try {
    const client = await relay.connect();
    await settle();
    expect(relay.lookups().length).toBeGreaterThan(0);
    const cancelled = relay.nextCancel();
    client.close();
    await cancelled;
    expect(relay.cancels()).toEqual([{ method: "POST", url: "https://fabric.example/v1/browser-sessions/browser-session_abc/cancel" }]);
    const lookups = relay.lookups().length;
    await settle(500);
    expect(relay.lookups().length).toBe(lookups);
    expect(relay.cancels()).toHaveLength(1);
  } finally {
    await relay.stop();
  }
});

test("a readiness timeout closes the client and cancels the session", async () => {
  const relay = await startRelay({ readyTimeoutMs: 300 });
  try {
    const client = await relay.connect();
    const cancelled = relay.nextCancel();
    expect(await relay.closed(client)).toBe(1011);
    await cancelled;
    expect(relay.cancels()).toHaveLength(1);
  } finally {
    await relay.stop();
  }
});

test("a session that already ended is not cancelled again", async () => {
  const relay = await startRelay({ sessionStatus: () => "timed_out" });
  try {
    const client = await relay.connect();
    expect(await relay.closed(client)).toBe(1011);
    await settle();
    expect(relay.cancels()).toHaveLength(0);
  } finally {
    await relay.stop();
  }
});

test("one client leaving never cancels a session another relay client still waits for", async () => {
  const relay = await startRelay();
  try {
    const first = await relay.connect();
    const second = await relay.connect();
    first.close();
    await settle(300);
    expect(relay.cancels()).toHaveLength(0);
    const cancelled = relay.nextCancel();
    second.close();
    await cancelled;
    expect(relay.cancels()).toHaveLength(1);
  } finally {
    await relay.stop();
  }
});

test("a transient Fabric API lookup error does not cancel the session", async () => {
  const relay = await startRelay({ respond: (call) => call.method === "GET" ? Response.json({ detail: "unavailable" }, { status: 503 }) : undefined });
  try {
    const client = await relay.connect();
    expect(await relay.closed(client)).toBe(1011);
    await settle();
    expect(relay.cancels()).toHaveLength(0);
  } finally {
    await relay.stop();
  }
});

test("a client leaving while polling an already-active session does not cancel it", async () => {
  const relay = await startRelay({ sessionStatus: () => "active" });
  try {
    const client = await relay.connect();
    await settle();
    client.close();
    await settle();
    expect(relay.cancels()).toHaveLength(0);
  } finally {
    await relay.stop();
  }
});

test("a failing cancellation is best effort and never breaks the relay", async () => {
  const relay = await startRelay({ respond: (call) => call.url.endsWith("/cancel") ? Response.json(null, { status: 503 }) : undefined });
  try {
    const client = await relay.connect();
    await settle();
    client.close();
    await settle();
    expect(relay.cancels()).toHaveLength(1);
    expect((await relay.http("/healthz")).status).toBe(200);
  } finally {
    await relay.stop();
  }
});

test("relay error responses are always problem objects", async () => {
  const upstream = new Map<string, () => Response>([
    ["/browser-sessions", () => new Response("null", { status: 409, headers: { "content-type": "application/json" } })],
    ["/browser-sessions/browser-session_a/heartbeat", () => new Response(null, { status: 401 })],
    ["/browser-sessions/browser-session_b/heartbeat", () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["/browser-sessions/browser-session_c/release", () => Response.json({ type: "https://browser-fabric.dev/problems/not_found", title: "not found", status: 404, detail: "session not found", code: "not_found", cdpEndpoint: "wss://leak" }, { status: 404 })],
    ["/browser-sessions/browser-session_d/cancel", () => { throw new Error("connection refused"); }],
  ]);
  const relay = await startRelay({ respond: (call) => upstream.get(call.url.replace("https://fabric.example/v1", ""))?.() });
  try {
    const problem = async (path: string, init: RequestInit = { method: "POST" }) => {
      const response = await relay.http(path, init);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      return { status: response.status, body: await response.json() };
    };
    expect(await problem("/v1/browser-sessions")).toEqual({ status: 409, body: { type: "https://browser-fabric.dev/problems/fabric_api_error", title: "fabric api error", status: 409, detail: "Fabric API request failed with HTTP 409", code: "fabric_api_error" } });
    expect((await problem("/v1/browser-sessions/browser-session_a/heartbeat")).body).toMatchObject({ status: 401, code: "fabric_api_error" });
    expect((await problem("/v1/browser-sessions/browser-session_b/heartbeat")).body).toMatchObject({ status: 502, code: "fabric_api_error" });
    expect(await problem("/v1/browser-sessions/browser-session_c/release")).toEqual({ status: 404, body: { type: "https://browser-fabric.dev/problems/not_found", title: "not found", status: 404, detail: "session not found", code: "not_found" } });
    expect(await problem("/v1/browser-sessions/browser-session_d/cancel")).toEqual({ status: 502, body: relayProblem(502, "relay_failed", "Fabric client relay request failed") });
    expect(await problem("/v1/unknown", { method: "GET" })).toEqual({ status: 404, body: relayProblem(404, "not_found", "route not found") });
  } finally {
    await relay.stop();
  }
});
