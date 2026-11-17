import { describe, expect, test } from "bun:test";
import {
  CaptchaSolverError,
  ChromiumProcessSupervisor,
  TurnstileGuardian,
  defaultTurnstileGuardianSpec,
  type BrowserContainerSpec,
  type CaptchaTask,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";
import type { ChallengeHandler } from "@browser-fabric/contracts";
import { browserIntegration, requireChromium } from "./support/chromium";


// Google's public reCAPTCHA v2 test sitekey. Its widget loads from google.com, which this test never
// needs to solve: the solver is a deterministic fake that returns a token shaped like a real one.
const TEST_SITEKEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
const SOLVED_TOKEN = `03AFcWeA${"x".repeat(56)}`;

/** A fake provider that records what it was asked to solve, so the test can prove the sitekey and page URL. */
function recordingSolver(): { solver: TokenCaptchaSolver; tasks: CaptchaTask[] } {
  const tasks: CaptchaTask[] = [];
  return {
    tasks,
    solver: {
      async solve(task: CaptchaTask) {
        tasks.push(task);
        return SOLVED_TOKEN;
      },
    },
  };
}

/**
 * A guardian-backed Chromium launched through the production local supervisor. The solver is supplied by
 * the same recipe-gated selector a managed browser uses, so this exercises the real token path end to end.
 */
async function launchGuardedChrome(port: number, handlersSolver?: TokenCaptchaSolver, handlers: ChallengeHandler[] | undefined = [{ id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: {} }]) {
  const supervisor = new ChromiumProcessSupervisor({
    executablePath: requireChromium(),
    startupTimeoutMs: 20_000,
    cwd: "/tmp",
    tokenSolverFor: (handlers) => (handlersSolver && handlers?.some((handler) => handler.mode === "automatic" && (handler.kind === "dbc" || handler.kind === "anticaptcha")) ? handlersSolver : undefined),
  });
  const spec: BrowserContainerSpec = {
    workerId: "worker_captcha_integration" as never,
    leaseId: `browser-lease_captcha_${crypto.randomUUID().replaceAll("-", "")}` as never,
    image: "integration",
    browserVersion: "system-test",
    command: [requireChromium(), "--headless=new"],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port },
    turnstileGuardian: { ...defaultTurnstileGuardianSpec(), pollIntervalMs: 250 },
    ...(handlers ? { challengeHandlers: handlers } : {}),
  };
  const launched = await supervisor.start(spec);
  return { supervisor, launched };
}

/** Serves one page with a reCAPTCHA v2 widget whose callback records the token it receives. */
function captchaPage(): string {
  return `<!doctype html><html><body>
    <form action="/report" method="post">
      <div class="g-recaptcha" data-sitekey="${TEST_SITEKEY}" data-callback="onCaptchaSolved"></div>
      <input name="reportRef" value="ref-1">
    </form>
    <script>window.onCaptchaSolved = function (token) { window.__solvedToken = token; document.body.dataset.solved = "yes"; };</script>
    <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  </body></html>`;
}

describe("token CAPTCHA solving on a real Chromium page", () => {
  test.skipIf(!browserIntegration)("a recipe-enabled guardian solves a reCAPTCHA v2 widget and the page callback receives the token", async () => {
    const port = 25_000 + Math.floor(Math.random() * 1_000);
    const { solver, tasks } = recordingSolver();
    const server = Bun.serve({ port: 0, fetch: () => new Response(captchaPage(), { headers: { "content-type": "text/html" } }) });
    const { supervisor, launched } = await launchGuardedChrome(port, solver);
    let browser: PuppeteerBrowser | undefined;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint });
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/report`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForFunction(() => (window as any).__solvedToken !== undefined, { timeout: 30_000 });
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBe(SOLVED_TOKEN);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: "recaptcha-v2", sitekey: TEST_SITEKEY });
      await page.close();
    } finally {
      await browser?.disconnect().catch(() => undefined);
      await supervisor.stopAll();
      server.stop(true);
    }
  }, 120_000);

  test.skipIf(!browserIntegration)("a provider that keeps failing is asked once per page document, not on every poll", async () => {
    const port = 27_000 + Math.floor(Math.random() * 1_000);
    const tasks: CaptchaTask[] = [];
    const failing: TokenCaptchaSolver = {
      async solve(task: CaptchaTask) {
        tasks.push(task);
        throw new CaptchaSolverError("rejected", "provider refused the task");
      },
    };
    const server = Bun.serve({ port: 0, fetch: () => new Response(captchaPage(), { headers: { "content-type": "text/html" } }) });
    const { supervisor, launched } = await launchGuardedChrome(port, failing);
    let browser: PuppeteerBrowser | undefined;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint });
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/report`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // Several poll intervals elapse while the widget stays unsolved: a per-poll retry would issue many solves.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(tasks).toHaveLength(1);
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBeUndefined();
      await page.close();
    } finally {
      await browser?.disconnect().catch(() => undefined);
      await supervisor.stopAll();
      server.stop(true);
    }
  }, 120_000);

  test.skipIf(!browserIntegration)("a browser without a recipe solver never asks any provider for a token", async () => {
    const port = 26_000 + Math.floor(Math.random() * 1_000);
    const server = Bun.serve({ port: 0, fetch: () => new Response(captchaPage(), { headers: { "content-type": "text/html" } }) });
    const { solver, tasks } = recordingSolver();
    // The recipe declares only a manual handler, so the selector must hand the guardian no solver at all.
    const manualOnly: ChallengeHandler[] = [{ id: "manual-auth", kind: "manual-handoff", mode: "manual", configuration: {} }];
    const { supervisor, launched } = await launchGuardedChrome(port, solver, manualOnly);
    let browser: PuppeteerBrowser | undefined;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint });
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/report`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(tasks).toHaveLength(0);
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBeUndefined();
      await page.close();
    } finally {
      await browser?.disconnect().catch(() => undefined);
      await supervisor.stopAll();
      server.stop(true);
    }
  }, 120_000);
});
