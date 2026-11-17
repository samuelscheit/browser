import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_CANDIDATES } from "../../apps/cli/src/launched-chrome-backend";
import { readDevToolsActivePort } from "../../apps/cli/src/devtools-active-port";

/**
 * The one browser every real-browser test uses: $FABRIC_TEST_CHROMIUM when set (CI sets it, and a
 * path that does not exist is an error, never a silent skip), else Playwright's pinned Chrome for
 * Testing (`bunx playwright-core install chromium`), else an installed Chrome or Chromium.
 */
async function findChromium(): Promise<string | undefined> {
  const explicit = process.env.FABRIC_TEST_CHROMIUM;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`FABRIC_TEST_CHROMIUM=${explicit} does not exist`);
    return explicit;
  }
  const { chromium } = await import("playwright-core");
  return [chromium.executablePath(), ...CHROME_CANDIDATES].find((path) => existsSync(path));
}

/** The Chromium binary for browser tests; undefined (and those tests skip) when none is installed. */
export const chromiumExecutable = await findChromium();
if (!chromiumExecutable) {
  console.warn("Skipping real-browser tests: no Chromium found. Run `bunx playwright-core install chromium` or set FABRIC_TEST_CHROMIUM.");
}

/** RUN_BROWSER_INTEGRATION=1 opts into the slower real-browser suites; they also need a browser. */
export const browserIntegration = process.env.RUN_BROWSER_INTEGRATION === "1" && chromiumExecutable !== undefined;

export interface TestChromium {
  /** HTTP endpoint (`http://127.0.0.1:<port>`) for CDP discovery. */
  endpoint: string;
  /** The browser-level CDP websocket. */
  webSocket: string;
  /** Whether the browser process is still alive. */
  readonly running: boolean;
  close(): Promise<void>;
}

export interface LaunchChromiumOptions {
  /** Chromium's --host-resolver-rules; by default `*.test` resolves to 127.0.0.1 so fixtures can be cross-site. */
  hostResolverRules?: string;
  args?: string[];
}

const STARTUP_TIMEOUT_MS = 20_000;

/**
 * A throwaway headless Chromium: own profile directory, an OS-assigned debugging port and strict
 * site isolation. A browser that cannot start fails at once with its own reason (Chromium's FATAL
 * line, e.g. "No usable sandbox!" where unprivileged user namespaces are blocked), not after the
 * startup timeout.
 */
export async function launchChromium(executable = requireChromium(), options: LaunchChromiumOptions = {}): Promise<TestChromium> {
  const profile = mkdtempSync(join(tmpdir(), "fabric-test-chromium-"));
  const child = spawn(executable, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--site-per-process",
    `--host-resolver-rules=${options.hostResolverRules ?? "MAP *.test 127.0.0.1"}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,900",
    ...options.args ?? [],
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // Keep draining stderr for the browser's whole life (a full pipe would stall it); remember the tail.
  let stderr = "";
  let fatal: string | undefined;
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
    fatal ??= /^.*:FATAL:.*$/m.exec(stderr)?.[0];
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)]) === false) child.kill("SIGKILL");
    }
    rmSync(profile, { recursive: true, force: true });
  };
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const active = readDevToolsActivePort(profile);
    if (active) {
      return {
        endpoint: `http://127.0.0.1:${active.port}`,
        webSocket: `ws://127.0.0.1:${active.port}${active.path}`,
        get running() { return child.exitCode === null && child.signalCode === null; },
        close,
      };
    }
    const failure = fatal ?? (child.exitCode !== null || child.signalCode !== null ? `exited (${child.exitCode ?? child.signalCode})` : undefined)
      ?? (Date.now() > deadline ? `published no DevToolsActivePort within ${STARTUP_TIMEOUT_MS / 1000} s` : undefined);
    if (failure) {
      child.kill("SIGKILL");
      await close();
      throw new Error(`Chromium did not start (${executable}): ${failure}${stderr && !fatal ? `\n${stderr.trim()}` : ""}`);
    }
    await Bun.sleep(50);
  }
}

export function requireChromium(): string {
  if (!chromiumExecutable) throw new Error("No Chromium for browser tests: run `bunx playwright-core install chromium` or set FABRIC_TEST_CHROMIUM");
  return chromiumExecutable;
}
