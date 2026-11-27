import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserIntegration, chromiumExecutable } from "./support/chromium";

const chrome = chromiumExecutable ?? "";
const run = browserIntegration ? describe : describe.skip;
const CLI = new URL("../apps/cli/src/cli.ts", import.meta.url).pathname;

let home: string;
let port: number;
const fabric = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...process.env, FABRIC_HOME: home, FABRIC_CHROME: chrome } });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
};
const ok = (...args: string[]) => {
  const result = fabric(...args);
  if (result.code !== 0) throw new Error(`fabric ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};
const freePort = () => new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port: free } = server.address() as { port: number }; server.close(() => resolve(free)); });
});

run("fabric CLI with a local headless Chrome", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fabric-cli-it-"));
    port = await freePort();
  });
  afterAll(() => {
    fabric("down", "--all");
    rmSync(home, { recursive: true, force: true });
  });

  test("up is idempotent and refuses a running browser with different settings", () => {
    const started = JSON.parse(ok("up", "--headless", "--port", String(port), "--json"));
    expect(started).toMatchObject({ status: "ready", endpoint: `http://127.0.0.1:${port}`, request: { mode: "local", name: "agent", headless: true, profile: "agent" } });
    const again = JSON.parse(ok("up", "--headless", "--port", String(port), "--json"));
    expect(again.pid).toBe(started.pid);
    // Same name ("agent") without --port reuses its existing port idempotently.
    const againNoPort = JSON.parse(ok("up", "--headless", "--json"));
    expect(againNoPort.pid).toBe(started.pid);
    expect(againNoPort.request.port).toBe(port);
    // Different settings under the same name ("agent") fail.
    const conflict = fabric("up", "--profile", "agent", "--port", String(port));
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("already running with other settings");
  });

  test("actions drive the current tab: goto, eval, tabs and screenshots", () => {
    const page = "data:text/html,<title>Fabric test</title><h1 style='height:3000px'>Hello</h1>";
    expect(ok("goto", page)).toBe(`Fabric test\n${page}`);
    expect(ok("eval", "document.querySelector('h1').textContent")).toBe("Hello");
    expect(JSON.parse(ok("eval", "--json", "({ n: 1 + 1, list: [1, 'a'] })"))).toEqual({ n: 2, list: [1, "a"] });
    const thrown = fabric("eval", "throw new Error('boom')");
    expect(thrown.code).toBe(1);
    expect(thrown.stderr).toContain("boom");
    const viewport = join(home, "viewport.png");
    const full = join(home, "full.png");
    expect(ok("shot", viewport)).toBe(viewport);
    expect(ok("shot", full, "--full")).toBe(full);
    const png = (path: string) => { const bytes = readFileSync(path); return { signature: bytes.subarray(1, 4).toString(), height: bytes.readUInt32BE(20) }; };
    expect(png(viewport).signature).toBe("PNG");
    expect(png(full).height).toBeGreaterThan(png(viewport).height);
    const tabs = JSON.parse(ok("tabs", "--json")) as { targetId: string; title: string }[];
    expect(tabs[0]!.title).toBe("Fabric test");
  });

  test("a new tab becomes current, and --tab switches back", async () => {
    await fetch(`http://127.0.0.1:${port}/json/new?data:text/html,<title>Second</title>`, { method: "PUT" });
    await Bun.sleep(300);
    expect(ok("eval", "document.title")).toBe("Second");
    expect(ok("eval", "--tab", "1", "document.title")).toBe("Fabric test");
    expect(ok("eval", "document.title")).toBe("Fabric test");
    expect(fabric("eval", "--tab", "9", "1").stderr).toContain("no tab 9");
  });

  test("a login cookie set just before `down` survives in the persistent profile", async () => {
    // A tiny HTTP origin (cookies need a real scheme and host) in its own process: the CLI runs
    // through spawnSync, which blocks this test's event loop.
    const sitePort = await freePort();
    const site = Bun.spawn([process.execPath, "-e", `Bun.serve({ hostname: "127.0.0.1", port: ${sitePort}, fetch: () => new Response("<title>site</title>", { headers: { "content-type": "text/html" } }) })`]);
    try {
      const origin = `http://127.0.0.1:${sitePort}/`;
      for (let attempt = 0; attempt < 50 && !(await fetch(origin).then((response) => response.ok, () => false)); attempt += 1) await Bun.sleep(50);
      ok("goto", origin);
      expect(ok("eval", "document.cookie = 'session=fresh; max-age=86400; path=/'; document.cookie")).toBe("session=fresh");
      expect(ok("down", "agent")).toBe("stopped agent");
      ok("up", "--headless", "--port", String(port));
      ok("goto", origin);
      expect(ok("eval", "document.cookie")).toBe("session=fresh");
    } finally {
      site.kill();
    }
  });

  test("status lists the browser; down stops Chrome and frees the port", async () => {
    expect(ok("status")).toContain(`CDP endpoint  http://127.0.0.1:${port}`);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { detail: string };
    const chromePid = Number(/pid (\d+)/.exec(health.detail)?.[1]);
    expect(chromePid).toBeGreaterThan(0);
    expect(ok("down", "agent")).toBe("stopped agent");
    expect(() => process.kill(chromePid, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(ok("status")).toContain("no browser running");
    expect(ok("down", "agent")).toBe("agent is not running");
  });

  test("multiple --profile browsers coexist without --name, and quick actions never fall back to another browser", () => {
    const alpha = JSON.parse(ok("up", "--headless", "--profile", "alpha", "--json"));
    const beta = JSON.parse(ok("up", "--headless", "--profile", "beta", "--json"));
    try {
      expect(alpha.request).toMatchObject({ name: "alpha", profile: "alpha", headless: true });
      expect(beta.request).toMatchObject({ name: "beta", profile: "beta", headless: true });
      expect(alpha.request.port).not.toBe(beta.request.port);
      // Re-running `up --headless --profile alpha` without --port is idempotent.
      expect(JSON.parse(ok("up", "--headless", "--profile", "alpha", "--json")).pid).toBe(alpha.pid);
      // Bare quick action refuses to guess when two local browsers run.
      const ambiguous = fabric("eval", "1 + 1");
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain("several local browsers are running (alpha, beta)");
      // Missing --profile or --name fails clearly instead of falling back.
      const missing = fabric("eval", "--profile", "gamma", "1 + 1");
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('browser "gamma" is not running');
      // Each browser is addressed independently via --profile or --name (without repeating --headless).
      expect(ok("goto", "--profile", "alpha", "data:text/html,<title>Alpha</title>")).toContain("Alpha");
      expect(ok("goto", "--profile", "beta", "data:text/html,<title>Beta</title>")).toContain("Beta");
      expect(ok("eval", "--profile", "alpha", "document.title")).toBe("Alpha");
      expect(ok("eval", "--name", "beta", "document.title")).toBe("Beta");
      // Stopping one leaves a sole running browser, which bare actions can then use.
      expect(ok("down", "--profile", "alpha")).toBe("stopped alpha");
      expect(ok("eval", "document.title")).toBe("Beta");
    } finally {
      fabric("down", "alpha");
      fabric("down", "beta");
    }
  });

  test("an MCP-style lazy start costs no browser until the first client, and up wakes it", async () => {
    const lazyPort = await freePort();
    const previousHome = process.env.FABRIC_HOME;
    process.env.FABRIC_HOME = home;
    process.env.FABRIC_CHROME = chrome;
    try {
      const { up } = await import("../apps/cli/src/commands");
      const request = { name: "lazy", mode: "local" as const, port: lazyPort, profile: "agent", fresh: false, ttlSeconds: 3600, idleMinutes: 10, headless: true };
      const state = await up(request, { warm: false });
      expect(state.status).toBe("idle");
      const health = async () => (await (await fetch(`http://127.0.0.1:${lazyPort}/healthz`)).json()) as { detail: string };
      expect((await health()).detail).toContain("not running");
      // The first client starts Chrome.
      expect(ok("eval", "--name", "lazy", "1 + 1")).toBe("2");
      expect((await health()).detail).toMatch(/fabric's Chrome pid \d+/);
      expect(ok("down", "lazy")).toBe("stopped lazy");
      // A warm `up` on a lazy daemon returns only once Chrome runs.
      await up(request, { warm: false });
      const woken = JSON.parse(ok("up", "--headless", "--name", "lazy", "--port", String(lazyPort), "--json"));
      expect(woken.status).toBe("ready");
      expect((await health()).detail).toMatch(/fabric's Chrome pid \d+/);
      expect(ok("down", "lazy")).toBe("stopped lazy");
    } finally {
      if (previousHome === undefined) delete process.env.FABRIC_HOME; else process.env.FABRIC_HOME = previousHome;
    }
  });

  test("a busy port fails fast with an actionable message", async () => {
    const busy = await freePort();
    const blocker: Server = createServer().listen(busy, "127.0.0.1");
    await new Promise((resolve) => blocker.once("listening", resolve));
    try {
      const result = fabric("up", "--headless", "--name", "busy", "--port", String(busy));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Cannot listen on 127.0.0.1:${busy}`);
      expect(result.stderr).toContain("pass --port");
    } finally {
      blocker.close();
    }
  });
});
