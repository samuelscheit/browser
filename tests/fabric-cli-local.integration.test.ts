import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.RUN_BROWSER_INTEGRATION === "1";
const chrome = process.env.FABRIC_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const run = enabled && existsSync(chrome) ? describe : describe.skip;
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
    const started = JSON.parse(ok("up", "--local", "--headless", "--port", String(port), "--json"));
    expect(started).toMatchObject({ status: "ready", endpoint: `http://127.0.0.1:${port}`, request: { mode: "local", name: "local", headless: true } });
    const again = JSON.parse(ok("up", "--local", "--headless", "--port", String(port), "--json"));
    expect(again.pid).toBe(started.pid);
    const conflict = fabric("up", "--local", "--port", String(port));
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("already running with other settings");
  });

  test("actions drive the current tab: goto, eval, tabs and screenshots", () => {
    const page = "data:text/html,<title>Fabric test</title><h1 style='height:3000px'>Hello</h1>";
    expect(ok("goto", page, "--local")).toBe(`Fabric test\n${page}`);
    expect(ok("eval", "--local", "document.querySelector('h1').textContent")).toBe("Hello");
    expect(JSON.parse(ok("eval", "--local", "--json", "({ n: 1 + 1, list: [1, 'a'] })"))).toEqual({ n: 2, list: [1, "a"] });
    const thrown = fabric("eval", "--local", "throw new Error('boom')");
    expect(thrown.code).toBe(1);
    expect(thrown.stderr).toContain("boom");
    const viewport = join(home, "viewport.png");
    const full = join(home, "full.png");
    expect(ok("shot", viewport, "--local")).toBe(viewport);
    expect(ok("shot", full, "--full", "--local")).toBe(full);
    const png = (path: string) => { const bytes = readFileSync(path); return { signature: bytes.subarray(1, 4).toString(), height: bytes.readUInt32BE(20) }; };
    expect(png(viewport).signature).toBe("PNG");
    expect(png(full).height).toBeGreaterThan(png(viewport).height);
    const tabs = JSON.parse(ok("tabs", "--local", "--json")) as { targetId: string; title: string }[];
    expect(tabs[0]!.title).toBe("Fabric test");
  });

  test("a new tab becomes current, and --tab switches back", async () => {
    await fetch(`http://127.0.0.1:${port}/json/new?data:text/html,<title>Second</title>`, { method: "PUT" });
    await Bun.sleep(300);
    expect(ok("eval", "--local", "document.title")).toBe("Second");
    expect(ok("eval", "--local", "--tab", "1", "document.title")).toBe("Fabric test");
    expect(ok("eval", "--local", "document.title")).toBe("Fabric test");
    expect(fabric("eval", "--local", "--tab", "9", "1").stderr).toContain("no tab 9");
  });

  test("a login cookie set just before `down` survives in the persistent profile", async () => {
    // A tiny HTTP origin (cookies need a real scheme and host) in its own process: the CLI runs
    // through spawnSync, which blocks this test's event loop.
    const sitePort = await freePort();
    const site = Bun.spawn([process.execPath, "-e", `Bun.serve({ hostname: "127.0.0.1", port: ${sitePort}, fetch: () => new Response("<title>site</title>", { headers: { "content-type": "text/html" } }) })`]);
    try {
      const origin = `http://127.0.0.1:${sitePort}/`;
      for (let attempt = 0; attempt < 50 && !(await fetch(origin).then((response) => response.ok, () => false)); attempt += 1) await Bun.sleep(50);
      ok("goto", origin, "--local");
      expect(ok("eval", "--local", "document.cookie = 'session=fresh; max-age=86400; path=/'; document.cookie")).toBe("session=fresh");
      expect(ok("down", "local")).toBe("stopped local");
      ok("up", "--local", "--headless", "--port", String(port));
      ok("goto", origin, "--local");
      expect(ok("eval", "--local", "document.cookie")).toBe("session=fresh");
    } finally {
      site.kill();
    }
  });

  test("status lists the browser; down stops Chrome and frees the port", async () => {
    expect(ok("status")).toContain(`CDP endpoint  http://127.0.0.1:${port}`);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { detail: string };
    const chromePid = Number(/pid (\d+)/.exec(health.detail)?.[1]);
    expect(chromePid).toBeGreaterThan(0);
    expect(ok("down", "local")).toBe("stopped local");
    expect(() => process.kill(chromePid, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(ok("status")).toContain("no browser running");
    expect(ok("down", "local")).toBe("local is not running");
  });

  test("a busy port fails fast with an actionable message", async () => {
    const busy = await freePort();
    const blocker: Server = createServer().listen(busy, "127.0.0.1");
    await new Promise((resolve) => blocker.once("listening", resolve));
    try {
      const result = fabric("up", "--local", "--headless", "--name", "busy", "--port", String(busy));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Cannot listen on 127.0.0.1:${busy}`);
      expect(result.stderr).toContain("pass --port");
    } finally {
      blocker.close();
    }
  });
});
