import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A Chromium binary for browser tests: $FABRIC_TEST_CHROMIUM, Playwright's, or a system install. */
export async function findChromium(): Promise<string | undefined> {
  const candidates = [process.env.FABRIC_TEST_CHROMIUM];
  try {
    const { chromium } = await import("playwright-core");
    candidates.push(chromium.executablePath());
  } catch { /* playwright-core is optional here */ }
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  );
  return candidates.find((path): path is string => Boolean(path) && existsSync(path!));
}

export interface TestChromium {
  /** HTTP endpoint (`http://127.0.0.1:<port>`) for CDP discovery. */
  endpoint: string;
  close(): Promise<void>;
}

/**
 * A throwaway headless Chromium: own profile directory, an OS-assigned debugging port, strict site
 * isolation, and `*.test` hostnames resolving to 127.0.0.1 so fixtures can be cross-site.
 */
export async function launchChromium(executable: string): Promise<TestChromium> {
  const profile = mkdtempSync(join(tmpdir(), "task-agent-chromium-"));
  const child: ChildProcess = spawn(executable, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--site-per-process",
    "--host-resolver-rules=MAP *.test 127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
      throw new Error(`Chromium did not start (${executable})`);
    }
    await Bun.sleep(50);
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
