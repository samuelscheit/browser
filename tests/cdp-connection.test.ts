import { afterEach, describe, expect, test } from "bun:test";
import { CdpConnection, closeBrowserGracefully, resolveBrowserWebSocketEndpoint } from "@browser-fabric/worker-runtime";
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
