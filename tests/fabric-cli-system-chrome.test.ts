import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_NOTICE, ENABLE_NOTICE, SystemChromeBackend, systemChrome, type SystemChrome } from "../apps/cli/src/system-chrome-backend";
import { FakeCdpBrowser } from "./support/fake-cdp-browser";
import { ToggleProxy } from "./support/toggle-proxy";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** A stand-in for the user's Chrome: a user data dir, and recorded start/prompt calls instead of `open`. */
function fakeChrome(options: { running?: boolean } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "fabric-system-chrome-"));
  cleanups.push(() => rmSync(userDataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const chrome: SystemChrome & { running: boolean; onStart?: () => void } = {
    userDataDir,
    running: options.running ?? true,
    isRunning: () => chrome.running,
    start: () => { calls.push("start"); chrome.onStart?.(); },
    openRemoteDebuggingPage: () => { calls.push("open chrome://inspect/#remote-debugging"); },
  };
  return { chrome, calls, writeActivePort: (contents: string) => writeFileSync(join(userDataDir, "DevToolsActivePort"), contents) };
}

function toggle() {
  const browser = new FakeCdpBrowser().start();
  const proxy = new ToggleProxy(browser.url).start();
  cleanups.push(() => proxy.stop(), () => browser.stop());
  return { browser, proxy };
}

const closedPort = () => new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

describe("your own Chrome via the remote-debugging toggle", () => {
  test("connects through DevToolsActivePort with exactly one prompt, and tells the user to click Allow", async () => {
    const { proxy } = toggle();
    const { chrome, calls, writeActivePort } = fakeChrome();
    writeActivePort(proxy.devToolsActivePort);
    const notices: (string | undefined)[] = [];
    const backend = new SystemChromeBackend({ chrome, notify: (notice) => notices.push(notice) });
    const connection = await backend.connect();
    expect((await connection.send("Browser.getVersion")).product).toBe("FakeChrome/1.0");
    expect(proxy.upgrades).toBe(1);
    expect(notices).toEqual([ALLOW_NOTICE, undefined]);
    expect(calls).toEqual([]);
    expect(backend.owner).toBe("user");
    expect(backend.guardian).toBe(true);
    // Closing fabric's side never touches Chrome: close() has nothing to quit.
    await backend.close();
    expect(proxy.upgrades).toBe(1);
    connection.close();
  });

  test("a declined prompt is reported as declined, once: clients retrying right away get no new prompt", async () => {
    const { proxy } = toggle();
    const { chrome, writeActivePort } = fakeChrome();
    writeActivePort(proxy.devToolsActivePort);
    proxy.prompt = "decline";
    const backend = new SystemChromeBackend({ chrome });
    await expect(backend.connect()).rejects.toThrow("“Allow remote debugging?” was declined. Run the command again and click Allow.");
    await expect(backend.connect()).rejects.toThrow(/was declined/);
    expect(proxy.upgrades).toBe(1);
  });

  test("an unanswered prompt times out as unanswered, without a retry", async () => {
    const { proxy } = toggle();
    const { chrome, writeActivePort } = fakeChrome();
    writeActivePort(proxy.devToolsActivePort);
    proxy.prompt = "ignore";
    const backend = new SystemChromeBackend({ chrome, approvalTimeoutMs: 400 });
    const started = Date.now();
    await expect(backend.connect()).rejects.toThrow("Nobody answered Chrome's “Allow remote debugging?” prompt within 0 s");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(proxy.upgrades).toBe(1);
  });

  test("toggle off (no file, or a stale one): opens chrome://inspect once, asks to enable it, and continues once enabled", async () => {
    const { proxy } = toggle();
    const { chrome, calls, writeActivePort } = fakeChrome();
    // A file left from an earlier session points at a port nobody listens on.
    writeActivePort(`${await closedPort()}\n/devtools/browser/stale\n`);
    const notices: (string | undefined)[] = [];
    const backend = new SystemChromeBackend({ chrome, notify: (notice) => notices.push(notice), enableTimeoutMs: 10_000 });
    const connecting = backend.connect();
    for (let attempt = 0; attempt < 100 && !notices.includes(ENABLE_NOTICE); attempt += 1) await Bun.sleep(20);
    expect(notices).toEqual([ENABLE_NOTICE]);
    expect(calls).toEqual(["open chrome://inspect/#remote-debugging"]);
    expect(proxy.upgrades).toBe(0);
    // The user flips the toggle: Chrome writes the file again.
    writeActivePort(proxy.devToolsActivePort);
    const connection = await connecting;
    expect(notices).toEqual([ENABLE_NOTICE, undefined, ALLOW_NOTICE, undefined]);
    expect(calls).toEqual(["open chrome://inspect/#remote-debugging"]);
    expect(proxy.upgrades).toBe(1);
    connection.close();
  });

  test("toggle never enabled: fails with the steps to take", async () => {
    const { chrome, calls } = fakeChrome();
    const backend = new SystemChromeBackend({ chrome, enableTimeoutMs: 300 });
    await expect(backend.connect()).rejects.toThrow("Remote debugging is off in your Chrome. Open chrome://inspect/#remote-debugging, enable it, and run the command again");
    // A second attempt does not open the page again.
    await expect(backend.connect()).rejects.toThrow(/Remote debugging is off/);
    expect(calls).toEqual(["open chrome://inspect/#remote-debugging"]);
  });

  test("Chrome not running: starts it normally and waits for its debugging server", async () => {
    const { proxy } = toggle();
    const { chrome, calls, writeActivePort } = fakeChrome({ running: false });
    chrome.onStart = () => setTimeout(() => { chrome.running = true; writeActivePort(proxy.devToolsActivePort); }, 300);
    const backend = new SystemChromeBackend({ chrome });
    const connection = await backend.connect();
    expect(calls).toEqual(["start"]);
    expect(proxy.upgrades).toBe(1);
    connection.close();
  });

  test("Chrome started but its toggle is off: asks for the toggle after the startup grace", async () => {
    const { chrome, calls } = fakeChrome({ running: false });
    chrome.onStart = () => { chrome.running = true; };
    const backend = new SystemChromeBackend({ chrome, startupGraceMs: 200, enableTimeoutMs: 600 });
    await expect(backend.connect()).rejects.toThrow(/Remote debugging is off/);
    expect(calls).toEqual(["start", "open chrome://inspect/#remote-debugging"]);
  });

  test("platform defaults point at the everyday profile", () => {
    expect(systemChrome("darwin", "/Users/u").userDataDir).toBe("/Users/u/Library/Application Support/Google/Chrome");
    expect(systemChrome("linux", "/home/u").userDataDir).toBe("/home/u/.config/google-chrome");
    expect(() => systemChrome("win32", "C:/u")).toThrow(/--profile/);
  });
});
