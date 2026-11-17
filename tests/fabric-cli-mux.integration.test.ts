import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import { CdpConnection } from "@browser-fabric/worker-runtime";
import { EndpointServer } from "../apps/cli/src/endpoint-server";
import { SystemChromeBackend } from "../apps/cli/src/system-chrome-backend";
import { ToggleProxy } from "./support/toggle-proxy";
import { browserIntegration, launchChromium, type TestChromium } from "./support/chromium";

/**
 * The endpoint's multiplexer against a real Chromium that stands in for the user's Chrome: a
 * throwaway profile with --remote-debugging-port, behind a proxy that behaves like Chrome's
 * remote-debugging toggle (no /json, no page sockets, one prompt per browser socket, counted).
 */
const run = browserIntegration ? describe : describe.skip;

let systemDir: string;
let testBrowser: TestChromium;
let direct: string;
let proxy: ToggleProxy;
let server: EndpointServer;
let base: string;
let ws: string;
let site: ReturnType<typeof Bun.serve>;
const log: string[] = [];

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});
/** A page on a real HTTP origin (Chrome refuses top-level popups to data: URLs). */
const html = (title: string, body = "") => `http://127.0.0.1:${site.port}/?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

/** A hand-written CDP client that records every frame it receives. */
class RawClient {
  readonly messages: Record<string, any>[] = [];
  readonly sessions = new Set<string>();
  readonly socket: WebSocket;
  closed?: { code: number; reason: string };
  readonly #waiting = new Map<number, (message: Record<string, any>) => void>();
  public constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.messages.push(message);
      if (message.method === "Target.attachedToTarget") this.sessions.add(message.params.sessionId);
      if (typeof message.id === "number") this.#waiting.get(message.id)?.(message);
    });
    this.socket.addEventListener("close", (event) => { this.closed = { code: event.code, reason: event.reason }; });
  }
  async opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve) => this.socket.addEventListener("open", resolve, { once: true }));
  }
  send(id: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
    const answer = new Promise<Record<string, any>>((resolve) => this.#waiting.set(id, resolve));
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }
  async attach(id: number, targetId: string): Promise<string> {
    const { result } = await this.send(id, "Target.attachToTarget", { targetId, flatten: true });
    this.sessions.add(result.sessionId);
    return result.sessionId;
  }
  /** Wait until the page in `sessionId` shows `title` (ids from 10_000 up, out of the tests' way). */
  async loaded(sessionId: string | undefined, title: string): Promise<void> {
    let id = 10_000;
    await waitFor(async () => (await this.send(id++, "Runtime.evaluate", { expression: "document.title" }, sessionId)).result?.result?.value === title);
  }
}

/** Chrome itself, bypassing fabric: what the user's own browser shows. */
async function directly<T>(use: (connection: CdpConnection) => Promise<T>): Promise<T> {
  const connection = await CdpConnection.connect({ endpoint: direct });
  try { return await use(connection); } finally { connection.close(); }
}
const pageTargets = () => directly(async (connection) => ((await connection.send("Target.getTargets")).targetInfos as { targetId: string; type: string; title: string; url: string }[]).filter((target) => target.type === "page"));
const browserContexts = () => directly(async (connection) => (await connection.send("Target.getBrowserContexts")).browserContextIds as string[]);

run("fabric endpoint multiplexer on a Chrome with the remote-debugging toggle", () => {
  beforeAll(async () => {
    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        return new Response(`<!doctype html><title>${url.searchParams.get("title") ?? ""}</title>${url.searchParams.get("body") ?? ""}`, { headers: { "content-type": "text/html" } });
      },
    });
    systemDir = mkdtempSync(join(tmpdir(), "fabric-mux-system-"));
    testBrowser = await launchChromium();
    direct = testBrowser.webSocket;
    proxy = new ToggleProxy(direct).start();
    writeFileSync(join(systemDir, "DevToolsActivePort"), proxy.devToolsActivePort);
    const port = await freePort();
    const backend = new SystemChromeBackend({
      chrome: { userDataDir: systemDir, isRunning: () => true, start: () => { throw new Error("must not start Chrome"); }, openRemoteDebuggingPage: () => { throw new Error("toggle is on"); } },
      log: (message) => log.push(message),
    });
    server = new EndpointServer({ backend, port, idleMs: 60_000, liveViewHtml: "", log: (message) => log.push(message) });
    server.listen();
    base = `http://127.0.0.1:${port}`;
    ws = `ws://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    proxy?.stop();
    site?.stop(true);
    // Only the Chromium this file started; nothing else is touched.
    await testBrowser?.close();
    rmSync(systemDir, { recursive: true, force: true });
  });

  test("the toggle refuses what the old port allowed, so only the endpoint's one socket can work", async () => {
    expect((await fetch(`http://127.0.0.1:${proxy.port}/json/version`)).status).toBe(404);
    const page = new WebSocket(`ws://127.0.0.1:${proxy.port}/devtools/page/x`);
    expect(await new Promise<string>((resolve) => { page.onopen = () => resolve("open"); page.onerror = () => resolve("refused"); })).toBe("refused");
    expect(proxy.upgrades).toBe(0);
  });

  test("two Playwright clients run side by side over one upstream socket", async () => {
    const drive = async (name: string) => {
      const browser = await chromium.connectOverCDP(base);
      const context = await browser.newContext();
      const isolated = await context.newPage();
      await isolated.goto(html(`${name}-isolated`));
      const shared = await browser.contexts()[0]!.newPage();
      await shared.goto(html(`${name}-shared`, `<a target=_blank href='${html("popup")}'>x</a>`));
      const [popup] = await Promise.all([shared.waitForEvent("popup"), shared.click("a")]);
      await popup.waitForLoadState();
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? isolated : shared).evaluate((value) => `${document.title}:${value}`, index)));
      return { browser, context, isolated, shared, popup, results, popupTitle: await popup.title() };
    };
    const [a, b] = await Promise.all([drive("a"), drive("b")]);
    for (const [name, client] of [["a", a], ["b", b]] as const) {
      expect(client.popupTitle).toBe("popup");
      client.results.forEach((value, index) => expect(value).toBe(`${name}-${index % 2 ? "isolated" : "shared"}:${index}`));
    }
    expect(proxy.upgrades).toBe(1);

    // Playwright redirects downloads to its temp folder; in the user's Chrome the default context
    // (the user's own browsing) keeps Chrome's behaviour with events, only Playwright's own contexts are redirected.
    const downloads = proxy.sent.filter((frame) => frame.method === "Browser.setDownloadBehavior");
    const defaultContext = downloads.filter((frame) => frame.params.browserContextId === undefined);
    expect(defaultContext.length).toBeGreaterThan(0);
    for (const frame of defaultContext) expect(frame.params).toEqual({ behavior: "default", eventsEnabled: true });
    expect(downloads.some((frame) => frame.params.browserContextId !== undefined && frame.params.behavior === "allowAndName")).toBe(true);

    // Sessions are never shared: each client's sessions are its own.
    const perClient = server.mux!.stats().perClient.filter((client) => !client.agentTabsOnly);
    expect(perClient).toHaveLength(2);
    const [first, second] = perClient.map((client) => new Set(client.sessions));
    expect([...first!].some((session) => second!.has(session))).toBe(false);

    // Every tab both clients opened counts as an agent tab, popups included.
    const pages = await (await fetch(`${base}/json/list`)).json() as { id: string; title: string; agentTab: boolean }[];
    for (const title of ["a-isolated", "a-shared", "b-isolated", "b-shared", "popup"]) expect(pages.find((page) => page.title === title)?.agentTab).toBe(true);

    // A leaves while B keeps working: A's own context is disposed, B's survives.
    const contextsBefore = await browserContexts();
    expect(contextsBefore.length).toBe(2);
    await a.browser.close();
    await waitFor(async () => (await browserContexts()).length === 1);
    expect(await b.isolated.evaluate(() => document.title)).toBe("b-isolated");
    expect(await b.shared.evaluate(() => 6 * 7)).toBe(42);
    // Playwright redirects downloads for the whole browser; once both left, fabric restores Chrome's default.
    await b.browser.close();
    await waitFor(() => server.mux!.stats().perClient.filter((client) => !client.agentTabsOnly).length === 0);
    await waitFor(() => proxy.sent.some((frame) => frame.method === "Browser.setDownloadBehavior" && frame.params.behavior === "default"));
    expect(proxy.upgrades).toBe(1);
  }, 60_000);

  test("Puppeteer next to Playwright; Puppeteer's browser.close() closes its tabs, not Chrome", async () => {
    const playwright = await chromium.connectOverCDP(base);
    const keep = await playwright.contexts()[0]!.newPage();
    await keep.goto(html("playwright-keeps"));
    const browser = await puppeteer.connect({ browserURL: base, defaultViewport: null });
    const page = await browser.newPage();
    await page.goto(html("puppeteer-page"));
    expect(await page.evaluate(() => document.title)).toBe("puppeteer-page");
    expect(await keep.evaluate(() => document.title)).toBe("playwright-keeps");
    const puppeteerTarget = (await pageTargets()).find((target) => target.title === "puppeteer-page")!;
    await browser.close();
    await waitFor(async () => !(await pageTargets()).some((target) => target.targetId === puppeteerTarget.targetId));
    expect(testBrowser.running).toBe(true);
    expect(await keep.evaluate(() => document.title)).toBe("playwright-keeps");
    expect(proxy.sent.some((frame) => frame.method === "Browser.close")).toBe(false);
    await playwright.close();
    expect(proxy.upgrades).toBe(1);
  }, 60_000);

  test("raw clients with colliding ids get only their own answers, events and sessions", async () => {
    const x = new RawClient(`${ws}/devtools/browser/fabric`);
    const y = new RawClient(`${ws}/devtools/browser/fabric`);
    await Promise.all([x.opened(), y.opened()]);
    const { result: { targetId: tx } } = await x.send(1, "Target.createTarget", { url: html("x") });
    const { result: { targetId: ty } } = await y.send(1, "Target.createTarget", { url: html("y") });
    const sx = await x.attach(2, tx);
    const sy = await y.attach(2, ty);
    await Promise.all([x.loaded(sx, "x"), y.loaded(sy, "y")]);
    await y.send(3, "Target.setDiscoverTargets", { discover: true });
    // 50 commands each, same ids, interleaved.
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => [
      x.send(100 + index, "Runtime.evaluate", { expression: `document.title + ${index}` }, sx),
      y.send(100 + index, "Runtime.evaluate", { expression: `document.title + ${index}` }, sy),
    ]).flat());
    answers.forEach((answer, index) => expect(answer.result.result.value).toBe(`${index % 2 ? "y" : "x"}${Math.floor(index / 2)}`));
    // Each got its answers exactly once.
    for (const client of [x, y]) expect(client.messages.filter((message) => message.id >= 100 && message.id < 150).length).toBe(50);
    // Another client's session is not addressable.
    const stolen = await y.send(4, "Runtime.evaluate", { expression: "1" }, sx);
    expect(stolen.error).toEqual({ code: -32001, message: "Session with given id not found." });
    // Events: page events only to the session owner; target events only to the discovering client.
    await x.send(5, "Page.enable", {}, sx);
    await x.send(6, "Page.navigate", { url: html("x2") }, sx);
    await waitFor(() => x.messages.some((message) => message.method === "Page.loadEventFired" && message.sessionId === sx));
    await waitFor(() => y.messages.some((message) => message.method === "Target.targetInfoChanged" && message.params.targetInfo.targetId === tx));
    expect(x.messages.some((message) => message.method?.startsWith("Target.target"))).toBe(false);
    for (const client of [x, y]) {
      // Events (answers echo the session they were sent to, like Chrome's own refusal above).
      const foreign = client.messages.filter((message) => message.id === undefined && message.sessionId && !client.sessions.has(message.sessionId));
      expect(foreign).toEqual([]);
    }
    x.socket.close();
    y.socket.close();
    await waitFor(() => server.mux!.stats().perClient.every((client) => client.agentTabsOnly));
    expect(proxy.upgrades).toBe(1);
  }, 60_000);

  test("a /devtools/page/<id> client becomes a session on the shared socket", async () => {
    const created = await (await fetch(`${base}/json/new?${html("page-socket")}`, { method: "PUT" })).json() as { id: string; webSocketDebuggerUrl: string; agentTab: boolean };
    expect(created.agentTab).toBe(true);
    const page = new RawClient(created.webSocketDebuggerUrl);
    await page.opened();
    await page.loaded(undefined, "page-socket");
    expect((await page.send(1, "Runtime.evaluate", { expression: "document.title" })).result.result.value).toBe("page-socket");
    await page.send(2, "Page.enable");
    const navigated = await page.send(3, "Page.navigate", { url: html("page-socket-2") });
    expect(navigated.sessionId).toBeUndefined();
    await waitFor(() => page.messages.find((message) => message.method === "Page.loadEventFired"));
    expect(page.messages.every((message) => message.sessionId === undefined)).toBe(true);
    // Closing the tab closes its page socket.
    await fetch(`${base}/json/close/${created.id}`);
    await waitFor(() => page.closed);
    expect(page.closed).toEqual({ code: 1000, reason: "target closed" });
    expect(proxy.upgrades).toBe(1);
  }, 30_000);

  test("a client that disconnects mid-flight leaves no session or pending command behind", async () => {
    const leaver = new RawClient(`${ws}/devtools/browser/fabric`);
    const stayer = new RawClient(`${ws}/devtools/browser/fabric`);
    await Promise.all([leaver.opened(), stayer.opened()]);
    const { result: { targetId } } = await leaver.send(1, "Target.createTarget", { url: html("leaver") });
    const session = await leaver.attach(2, targetId);
    await leaver.loaded(session, "leaver");
    await leaver.send(3, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    leaver.socket.send(JSON.stringify({ id: 4, method: "Runtime.evaluate", params: { expression: "new Promise((resolve) => setTimeout(() => resolve(1), 800))", awaitPromise: true }, sessionId: session }));
    leaver.socket.send(JSON.stringify({ id: 5, method: "Target.attachToTarget", params: { targetId, flatten: true } }));
    leaver.socket.close();
    const own = await stayer.attach(1, targetId);
    expect((await stayer.send(2, "Runtime.evaluate", { expression: "document.title" }, own)).result.result.value).toBe("leaver");
    await Bun.sleep(1_200);
    const stats = server.mux!.stats();
    expect(stats.orphanedPending).toBe(0);
    const clients = stats.perClient.filter((client) => !client.agentTabsOnly);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.sessions).toEqual([own]);
    // The late attach answer of the departed client was detached again: only fabric's guardian and the stayer remain.
    const attachedSessions = stats.sessions;
    expect(attachedSessions).toBe(stats.perClient.reduce((sum, client) => sum + client.sessions.length, 0));
    stayer.socket.close();
    expect(proxy.upgrades).toBe(1);
  }, 30_000);

  test("the Turnstile guardian shares the socket and watches agent tabs only, never the user's own", async () => {
    // The user opens a tab in their Chrome (not through fabric).
    const userTab = await directly(async (connection) => (await connection.send("Target.createTarget", { url: html("users-own-tab") })).targetId as string);
    const agent = await (await fetch(`${base}/json/new?${html("agent-tab")}`, { method: "PUT" })).json() as { id: string };
    const guardian = await waitFor(() => {
      const found = server.mux!.stats().perClient.find((client) => client.agentTabsOnly);
      return found?.targets.includes(agent.id) ? found : undefined;
    });
    expect(guardian.targets).not.toContain(userTab);
    for (const targetId of guardian.targets) expect(server.mux!.isAgentTarget(targetId)).toBe(true);
    // The user's tab is untouched by fabric: still there, unchanged, and not listed as an agent tab.
    const pages = await (await fetch(`${base}/json/list`)).json() as { id: string; agentTab: boolean }[];
    expect(pages.find((page) => page.id === userTab)?.agentTab).toBe(false);
    expect(proxy.upgrades).toBe(1);
  }, 30_000);

  test("fabric actions use an agent tab, never the user's current one", async () => {
    const { goto, evaluate } = await import("../apps/cli/src/actions");
    const port = Number(new URL(base).port);
    const userTab = await directly(async (connection) => (await connection.send("Target.createTarget", { url: html("user-current") })).targetId as string);
    await fetch(`${base}/json/activate/${userTab}`);
    // Closing every agent tab first: goto must open a new one rather than take the user's.
    for (const page of await (await fetch(`${base}/json/list`)).json() as { id: string; agentTab: boolean }[]) if (page.agentTab) await fetch(`${base}/json/close/${page.id}`);
    await Bun.sleep(200);
    expect((await goto(port, html("agent-goto"))).title).toBe("agent-goto");
    expect(await evaluate(port, "document.title")).toBe("agent-goto");
    const user = (await pageTargets()).find((target) => target.targetId === userTab)!;
    expect(user.title).toBe("user-current");
    expect(proxy.upgrades).toBe(1);
  }, 30_000);

  test("Chrome quitting drops every client; the next client reconnects once; stopping fabric leaves Chrome and its tabs alone", async () => {
    const client = new RawClient(`${ws}/devtools/browser/fabric`);
    await client.opened();
    await client.send(1, "Browser.getVersion");
    proxy.dropConnections();
    await waitFor(() => client.closed);
    expect(client.closed!.code).toBe(1011);
    // No retry loop: nothing reconnects until a client needs the browser.
    await Bun.sleep(500);
    expect(proxy.upgrades).toBe(1);
    expect((await fetch(`${base}/json/version`)).status).toBe(200);
    expect(proxy.upgrades).toBe(2);

    const tabsBefore = (await pageTargets()).map((target) => target.targetId).sort();
    await server.stop();
    await Bun.sleep(300);
    expect(testBrowser.running).toBe(true);
    expect((await pageTargets()).map((target) => target.targetId).sort()).toEqual(tabsBefore);
    expect(log.some((line) => line.includes("click Allow"))).toBe(true);
  }, 30_000);
});
