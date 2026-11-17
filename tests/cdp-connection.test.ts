import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { CdpConnectError, CdpConnection, closeBrowserGracefully, resolveBrowserWebSocketEndpoint } from "@browser-fabric/worker-runtime";
import { FakeCdpBrowser } from "./support/fake-cdp-browser";

const browsers: FakeCdpBrowser[] = [];
afterEach(() => { for (const browser of browsers.splice(0)) browser.stop(); });
const start = () => { const browser = new FakeCdpBrowser().start(); browsers.push(browser); return browser; };

describe("closeBrowserGracefully", () => {
  test("sends Browser.close and reports success once Chromium drops the connection", async () => {
    const browser = start();
    expect(await closeBrowserGracefully(browser.url, { timeoutMs: 2_000 })).toBe(true);
    expect(browser.received.map((entry) => entry.message.method)).toEqual(["Browser.close"]);
  });

  test("passes upgrade headers to authenticated gateways", async () => {
    const browser = start();
    expect(await closeBrowserGracefully(browser.url, { headers: { authorization: "Basic x" } })).toBe(true);
    expect(browser.authorizations).toEqual(["Basic x"]);
  });

  test("returns false within its deadline when the browser does not shut down", async () => {
    const browser = start();
    browser.closesOnBrowserClose = false;
    const started = Date.now();
    expect(await closeBrowserGracefully(browser.url, { timeoutMs: 300 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
    // The helper does not leave its own connection behind.
    await Bun.sleep(50);
    expect(browser.sockets.size).toBe(0);
  });

  test("returns false, without throwing, when the browser is unreachable", async () => {
    const browser = start();
    const url = browser.url;
    browser.stop();
    expect(await closeBrowserGracefully(url, { timeoutMs: 500 })).toBe(false);
    expect(await closeBrowserGracefully("not a url")).toBe(false);
  });
});

/** What `connect` rejected with; fails the test when it connected. */
async function connectError(endpoint: string, timeoutMs = 2_000): Promise<CdpConnectError> {
  const error = await CdpConnection.connect({ endpoint, timeoutMs }).then((connection) => { connection.close(); return undefined; }, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(CdpConnectError);
  return error as CdpConnectError;
}

describe("CdpConnection connect failures", () => {
  // Chrome answers a declined "Allow remote debugging?" prompt with 403; gateways answer 401/404.
  test.each([403, 401, 404, 500])("a refused upgrade reports the HTTP status %d, whatever the runtime's error text", async (status) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Connection rejected", { status }) });
    try {
      const error = await connectError(`ws://127.0.0.1:${server.port}/devtools/browser/x`);
      expect(error.status).toBe(status);
      expect(error.timedOut).toBe(false);
      expect(error.message).toBe(`CDP websocket failed to connect (HTTP ${status} instead of 101 Switching Protocols)`);
    } finally {
      server.stop(true);
    }
  });

  test("a closed port is a connect failure without a status, not a timeout", async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
    });
    const started = Date.now();
    const error = await connectError(`ws://127.0.0.1:${port}/devtools/browser/x`);
    expect(error.status).toBeUndefined();
    expect(error.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("an upgrade nobody answers times out without a status", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => { sockets.add(socket); });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
    try {
      const error = await connectError(`ws://127.0.0.1:${port}/devtools/browser/x`, 300);
      expect(error.timedOut).toBe(true);
      expect(error.status).toBeUndefined();
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });
});

describe("CdpConnection", () => {
  test("accepts Fabric gateway session paths as browser-level websockets", async () => {
    expect(await resolveBrowserWebSocketEndpoint("wss://fabric.test/v1/cdp/browser-session_abc?cap=x")).toBe("wss://fabric.test/v1/cdp/browser-session_abc?cap=x");
    await expect(resolveBrowserWebSocketEndpoint("wss://fabric.test/v1/cdp/other")).rejects.toThrow(/browser-level/);
    await expect(resolveBrowserWebSocketEndpoint("ws://user:pw@host/devtools/browser/x")).rejects.toThrow(/credentials/);
  });

  test("names the failing method in CDP errors and honours per-command timeouts", async () => {
    const browser = start();
    const connection = await CdpConnection.connect({ endpoint: browser.url });
    await expect(connection.send("Target.closeTarget", { targetId: "missing" })).rejects.toThrow("Target.closeTarget: No target with given id found");
    const started = Date.now();
    await expect(connection.send("Fake.neverAnswered", {}, undefined, 100)).rejects.toThrow("CDP command Fake.neverAnswered timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    // A pending command fails as soon as the browser goes away, not at its timeout.
    const pending = connection.send("Fake.neverAnswered", {}, undefined, 10_000);
    browser.dropConnections();
    await expect(pending).rejects.toThrow("CDP connection closed");
    expect(connection.closed).toBe(true);
  });
});
