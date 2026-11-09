import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { BrowserBackend } from "../apps/cli/src/backend";
import { EndpointServer, closeReason } from "../apps/cli/src/endpoint-server";
import { FakeCdpBrowser } from "./support/fake-cdp-browser";

class FakeBackend implements BrowserBackend {
  acquires = 0;
  suspends = 0;
  closed = false;
  public constructor(readonly browser: FakeCdpBrowser, readonly headers?: Record<string, string>) {}
  async acquire() { this.acquires += 1; return { url: this.browser.url, ...(this.headers ? { headers: this.headers } : {}) }; }
  async suspend() { this.suspends += 1; }
  async close() { this.closed = true; }
  describe() { return { detail: "fake backend" }; }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

class Client {
  readonly messages: Record<string, any>[] = [];
  closed?: { code: number; reason: string };
  readonly socket: WebSocket;
  public constructor(url: string, headers?: Record<string, string>) {
    this.socket = headers ? new WebSocket(url, { headers } as never) : new WebSocket(url);
    this.socket.addEventListener("message", (event) => this.messages.push(JSON.parse(String(event.data))));
    this.socket.addEventListener("close", (event) => { this.closed = { code: event.code, reason: event.reason }; });
  }
  async opened(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve(true);
      this.socket.addEventListener("open", () => resolve(true), { once: true });
      this.socket.addEventListener("error", () => resolve(false), { once: true });
    });
  }
  send(message: Record<string, unknown>) { this.socket.send(JSON.stringify(message)); }
  async reply(id: number) { await waitFor(() => this.messages.some((message) => message.id === id)); return this.messages.find((message) => message.id === id)!; }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: { idleMs?: number; targets?: ConstructorParameters<typeof FakeCdpBrowser>[0]; headers?: Record<string, string> } = {}) {
  const browser = new FakeCdpBrowser(options.targets).start();
  const backend = new FakeBackend(browser, options.headers);
  const port = await freePort();
  const states: string[] = [];
  const server = new EndpointServer({ backend, port, idleMs: options.idleMs ?? 60_000, liveViewHtml: "<!doctype html><title>live</title>", onStateChange: (state) => states.push(state) });
  server.listen();
  cleanups.push(() => browser.stop(), () => server.stop());
  const base = `http://127.0.0.1:${port}`;
  return { browser, backend, server, port, base, ws: `ws://127.0.0.1:${port}`, states };
}

describe("fabric endpoint: Chrome-compatible HTTP surface", () => {
  test("/json/version advertises the loopback browser socket under the caller's host", async () => {
    const { base, port, backend } = await setup();
    const version = await (await fetch(`${base}/json/version`)).json() as Record<string, string>;
    expect(version).toEqual({
      Browser: "FakeChrome/1.0", "Protocol-Version": "1.3", "User-Agent": "FakeAgent", "V8-Version": "1.0", "WebKit-Version": "@fake",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fabric`,
    });
    const viaLocalhost = await (await fetch(`http://localhost:${port}/json/version/`)).json() as Record<string, string>;
    expect(viaLocalhost.webSocketDebuggerUrl).toBe(`ws://localhost:${port}/devtools/browser/fabric`);
    // One anchor serves every /json request; no extra browser connection per query.
    expect(backend.acquires).toBe(1);
  });

  test("/json/list hides browser targets and orders pages by most recent use", async () => {
    const { base, browser, port } = await setup({ targets: [{ targetId: "A", url: "https://a.test/" }, { targetId: "W", type: "service_worker", url: "https://a.test/sw.js" }] });
    await fetch(`${base}/json/version`);
    const created = await (await fetch(`${base}/json/new?https://b.test/`, { method: "PUT" })).json() as Record<string, string>;
    expect(created).toMatchObject({ type: "page", url: "https://b.test/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${created.id}` });
    expect(created.devtoolsFrontendUrl).toBe(`devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${port}/devtools/page/${created.id}`);
    const ids = async () => ((await (await fetch(`${base}/json/list`)).json()) as { id: string }[]).map((target) => target.id);
    expect((await ids())[0]).toBe(created.id);
    expect(await ids()).not.toContain("B");
    // A navigation makes a tab the current one; a title-only change does not.
    browser.navigate("A", "https://a.test/next");
    await waitFor(() => true);
    await Bun.sleep(30);
    expect((await ids())[0]).toBe("A");
    browser.targets.get(created.id!)!.title = "renamed";
    expect((await ids())[0]).toBe("A");
    expect(await (await fetch(`${base}/json/activate/${created.id}`)).text()).toBe("Target activated");
    expect((await ids())[0]).toBe(created.id);
    expect(await (await fetch(`${base}/json`)).json()).toEqual(await (await fetch(`${base}/json/list`)).json());
  });

  test("/json/close and errors from the browser surface as HTTP results", async () => {
    const { base, browser } = await setup({ targets: [{ targetId: "A" }] });
    expect(await (await fetch(`${base}/json/close/A`)).text()).toBe("Target is closing");
    expect(browser.targets.has("A")).toBe(false);
    const missing = await fetch(`${base}/json/close/A`);
    expect(missing.status).toBe(502);
    expect(await missing.text()).toContain("No target");
    expect((await fetch(`${base}/json/new`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/json/protocol`)).status).toBe(404);
    expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ status: "ok", clients: 0, detail: "fake backend" });
  });

  test("rejects DNS-rebinding hosts and cross-site websocket origins", async () => {
    const { base, ws, port } = await setup();
    expect((await fetch(`${base}/json/version`, { headers: { host: `evil.test:${port}` } })).status).toBe(403);
    expect((await fetch(`${base}/json/version`, { headers: { host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
    expect(await new Client(`${ws}/devtools/browser/fabric`, { origin: "https://evil.test" }).opened()).toBe(false);
    expect(await new Client(`${ws}/devtools/browser/fabric`, { origin: `http://127.0.0.1:${port + 1}` }).opened()).toBe(false);
    expect(await new Client(`${ws}/devtools/browser/fabric`, { origin: "null" }).opened()).toBe(false);
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "devtools://devtools"]) {
      const allowed = new Client(`${ws}/devtools/browser/fabric`, { origin });
      expect(await allowed.opened()).toBe(true);
      allowed.socket.close();
    }
    expect(await new Client(`${ws}/devtools/unknown/x`).opened()).toBe(false);
  });
});

describe("fabric endpoint: websocket relays", () => {
  test("a browser socket relays both ways and flushes frames sent before the browser was ready, in order", async () => {
    const { ws, browser, backend } = await setup({ headers: { authorization: "Basic abc" } });
    const client = new Client(`${ws}/devtools/browser/fabric`);
    await client.opened();
    client.send({ id: 1, method: "Browser.getVersion" });
    client.send({ id: 2, method: "Target.getTargets" });
    expect((await client.reply(1)).result.product).toBe("FakeChrome/1.0");
    expect((await client.reply(2)).result.targetInfos.length).toBeGreaterThan(0);
    const anchorConnection = browser.received[0]!.connection;
    const fromClient = browser.received.filter((entry) => entry.connection !== anchorConnection);
    expect(fromClient.map((entry) => entry.message.method)).toEqual(["Browser.getVersion", "Target.getTargets"]);
    // The anchor plus this client: each client gets its own upstream connection.
    expect(new Set(browser.received.map((entry) => entry.connection)).size).toBe(2);
    expect(backend.acquires).toBe(2);
    expect(browser.authorizations).toEqual(["Basic abc", "Basic abc"]);
  });

  test("a page socket speaks unscoped CDP while the endpoint multiplexes it onto a flat session", async () => {
    const { ws, browser } = await setup({ targets: [{ targetId: "A" }, { targetId: "B" }] });
    const pageA = new Client(`${ws}/devtools/page/A`);
    const pageB = new Client(`${ws}/devtools/page/B`);
    await Promise.all([pageA.opened(), pageB.opened()]);
    pageA.send({ id: 7, method: "Runtime.evaluate", params: { expression: "1+1" } });
    pageB.send({ id: 7, method: "Runtime.evaluate", params: { expression: "2+2" } });
    expect(await pageA.reply(7)).toEqual({ id: 7, result: { result: { type: "string", value: "A:1+1" } } });
    expect(await pageB.reply(7)).toEqual({ id: 7, result: { result: { type: "string", value: "B:2+2" } } });
    const [sessionA] = browser.sessionsFor("A");
    expect(browser.received.find((entry) => entry.message.id === 7 && entry.message.sessionId === sessionA)).toBeDefined();
    // Events reach only the page they belong to, without a sessionId.
    browser.emitToTarget("A", "Page.loadEventFired", { timestamp: 1 });
    await waitFor(() => pageA.messages.some((message) => message.method === "Page.loadEventFired"));
    expect(pageA.messages.find((message) => message.method === "Page.loadEventFired")).toEqual({ method: "Page.loadEventFired", params: { timestamp: 1 } });
    await Bun.sleep(30);
    expect(pageB.messages.some((message) => message.method === "Page.loadEventFired")).toBe(false);
    // Closing the target closes its page socket.
    browser.detach(sessionA!);
    await waitFor(() => pageA.closed !== undefined);
    expect(pageA.closed).toEqual({ code: 1000, reason: "target closed" });
    expect(pageB.closed).toBeUndefined();
  });

  test("a page socket for an unknown target closes with a clear reason", async () => {
    const { ws } = await setup();
    const client = new Client(`${ws}/devtools/page/NOPE`);
    await client.opened();
    await waitFor(() => client.closed !== undefined);
    expect(client.closed).toEqual({ code: 1011, reason: "No such target NOPE" });
  });

  test("closing a client closes its upstream connection", async () => {
    const { ws, browser } = await setup();
    const client = new Client(`${ws}/devtools/browser/fabric`);
    await client.opened();
    client.send({ id: 1, method: "Browser.getVersion" });
    await client.reply(1);
    expect(browser.sockets.size).toBe(2);
    client.socket.close();
    await waitFor(() => browser.sockets.size === 1);
  });
});

describe("fabric endpoint: anchor and idle lifecycle", () => {
  test("suspends the backend after the idle window without clients and resumes on the next client", async () => {
    const { ws, base, backend, browser, server, states } = await setup({ idleMs: 80 });
    await server.warm();
    expect(states).toEqual(["ready"]);
    await waitFor(() => backend.suspends === 1);
    expect(states).toEqual(["ready", "idle"]);
    await waitFor(() => browser.sockets.size === 0);
    expect((await (await fetch(`${base}/healthz`)).json() as { suspended: boolean }).suspended).toBe(true);
    const client = new Client(`${ws}/devtools/browser/fabric`);
    await client.opened();
    client.send({ id: 1, method: "Browser.getVersion" });
    await client.reply(1);
    expect(states).toEqual(["ready", "idle", "ready"]);
    // A connected client keeps the browser: no suspension while it stays.
    await Bun.sleep(200);
    expect(backend.suspends).toBe(1);
    client.socket.close();
    await waitFor(() => backend.suspends === 2);
  });

  test("an /json request alone restarts the idle window instead of keeping the browser forever", async () => {
    const { base, backend } = await setup({ idleMs: 100 });
    await fetch(`${base}/json/version`);
    await waitFor(() => backend.suspends === 1);
  });

  test("reconnects the anchor when the browser drops (expired session, crashed Chrome)", async () => {
    const { base, backend, browser, server } = await setup();
    await server.warm();
    expect(backend.acquires).toBe(1);
    browser.dropConnections();
    await waitFor(() => browser.sockets.size === 0);
    await Bun.sleep(20);
    expect((await fetch(`${base}/json/version`)).status).toBe(200);
    expect(backend.acquires).toBe(2);
  });
});

test("closeReason keeps websocket close reasons within 123 bytes, even for multi-byte text", () => {
  expect(closeReason("short")).toBe("short");
  const long = closeReason("é".repeat(200));
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(123);
  expect(long.endsWith("...")).toBe(true);
  expect(long).not.toContain("�");
});
