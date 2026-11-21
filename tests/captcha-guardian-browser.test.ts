/**
 * The CAPTCHA guardian on real Chromium: llm-captcha solves vendor test widgets and a local slider
 * with trusted input, without a model, and the reCAPTCHA token fallback runs only after llm-captcha
 * failed. RUN_BROWSER_INTEGRATION=1; the vendor widgets also need network access to Cloudflare and Google.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptchaGuardian,
  ChromiumProcessSupervisor,
  defaultCaptchaGuardianSpec,
  type BrowserContainerSpec,
  type CaptchaTask,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import puppeteer, { type Browser as PuppeteerBrowser, type Page } from "puppeteer-core";
import type { ChallengeHandler } from "@browser-fabric/contracts";
import { RECAPTCHA_V2_PROBE_SCRIPT, recaptchaCallbackScript } from "../packages/worker-runtime/src/captcha-solvers/recaptcha-fallback";
import { browserIntegration, launchChromium, requireChromium, type TestChromium } from "./support/chromium";
import { eventually, type GuardianLog } from "./support/fake-guardian-transport";

/** Cloudflare's and Google's public test sitekeys: both always pass. */
const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";
const RECAPTCHA_TEST_SITEKEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
const BOUGHT_TOKEN = `03AFcWeA${"x".repeat(56)}`;

const html = (body: string) => new Response(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

/** A self-signed certificate for a vendor hostname served locally through a host-resolver rule. */
function selfSigned(directory: string, hostname: string): { key: string; cert: string } {
  const key = join(directory, `${hostname}.key`);
  const cert = join(directory, `${hostname}.pem`);
  const result = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${hostname}`, "-keyout", key, "-out", cert], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
  return { key, cert };
}

/** A guarded Chromium launched through the production local supervisor, as a local worker runs one. */
async function launchGuarded(options: { args?: string[]; handlers?: ChallengeHandler[]; tokenSolver?: TokenCaptchaSolver } = {}) {
  const supervisor = new ChromiumProcessSupervisor({
    executablePath: requireChromium(),
    startupTimeoutMs: 20_000,
    cwd: "/tmp",
    ...(options.tokenSolver ? { tokenSolverFor: (handlers: BrowserContainerSpec["challengeHandlers"]) => handlers?.some((handler) => handler.kind === "dbc" && handler.mode === "automatic") ? options.tokenSolver : undefined } : {}),
  });
  const spec: BrowserContainerSpec = {
    workerId: "worker_captcha_integration" as never,
    leaseId: `browser-lease_captcha_${crypto.randomUUID().replaceAll("-", "")}` as never,
    image: "integration",
    browserVersion: "system-test",
    command: [requireChromium(), "--headless=new", "--window-size=1280,900", "--password-store=basic", "--use-mock-keychain", ...(options.args ?? [])],
    environment: {},
    volumes: [],
    networks: [],
    limits: { maxBrowserLeases: 1, cpuMilli: 2_000, memoryMiB: 2_048, pids: 256, shmMiB: 512, temporaryStorageMiB: 512 },
    security: { dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false },
    cdpBind: { host: "127.0.0.1", port: 24_000 + Math.floor(Math.random() * 4_000) },
    captchaGuardian: { ...defaultCaptchaGuardianSpec(), pollIntervalMs: 250, solveTimeoutMs: 60_000 },
    ...(options.handlers ? { challengeHandlers: options.handlers } : {}),
  };
  const launched = await supervisor.start(spec);
  const browser = await puppeteer.connect({ browserWSEndpoint: launched.cdpBrowserEndpoint, defaultViewport: null });
  return {
    supervisor,
    launched,
    browser,
    async close() {
      await browser.disconnect().catch(() => undefined);
      await supervisor.stopAll();
    },
  };
}

const captchaState = (page: Page) => page.evaluate(() => document.documentElement.dataset.captchaState ?? "");

async function waitForState(page: Page, state: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction((expected) => document.documentElement.dataset.captchaState === expected, { timeout: timeoutMs, polling: 100 }, state);
}

describe.skipIf(!browserIntegration)("CAPTCHA guardian on vendor test widgets", () => {
  let site: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/turnstile") {
          return html(`<form><div class="cf-turnstile" data-sitekey="${TURNSTILE_TEST_SITEKEY}"></div></form>
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
        }
        if (path === "/recaptcha") {
          return html(`<form><div class="g-recaptcha" data-sitekey="${RECAPTCHA_TEST_SITEKEY}"></div></form>
            <script src="https://www.google.com/recaptcha/api.js" async defer></script>`);
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => site?.stop(true));

  test("solves a Turnstile and a reCAPTCHA widget on two pages at once, without a model, and fills their tokens", async () => {
    const guarded = await launchGuarded();
    try {
      // Each page in a window of its own: a background tab of one window is hidden and is not rendered.
      const [turnstile, recaptcha] = await Promise.all([1, 2].map(async () => (await guarded.browser.createBrowserContext()).newPage()));
      await Promise.all([
        turnstile!.goto(`http://localhost:${site.port}/turnstile`, { waitUntil: "domcontentloaded" }),
        recaptcha!.goto(`http://localhost:${site.port}/recaptcha`, { waitUntil: "domcontentloaded" }),
      ]);
      await Promise.all([waitForState(turnstile!, "solved", 60_000), waitForState(recaptcha!, "solved", 60_000)]);
      const turnstileToken = await turnstile!.waitForFunction(() => (document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value || "", { timeout: 15_000 }).then((handle) => handle.jsonValue());
      const recaptchaToken = await recaptcha!.waitForFunction(() => (document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null)?.value || "", { timeout: 15_000 }).then((handle) => handle.jsonValue());
      expect(String(turnstileToken).length).toBeGreaterThan(10);
      expect(String(recaptchaToken).length).toBeGreaterThan(10);
      expect(guarded.supervisor.guardianSnapshot(guarded.launched.processId)).toMatchObject({ running: true, attachedPages: expect.any(Number), failed: 0 });
      expect(guarded.supervisor.guardianSnapshot(guarded.launched.processId)!.solved).toBeGreaterThanOrEqual(2);
    } finally {
      await guarded.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// A local DataDome look-alike, served as https://geo.captcha-delivery.com through a host-resolver
// rule, embedded cross-site (so it is an out-of-process frame) in a localhost page. The slider only
// accepts a trusted, focused drag to the end, then the page reloads to its content.
// ---------------------------------------------------------------------------------------------

const sliderDocument = (mode: string) => `<!doctype html><html><head><title>DataDome CAPTCHA</title><style>
  body { margin: 0; font-family: sans-serif; }
  .sliderContainer { position: relative; width: 280px; height: 40px; margin: 260px auto 0; }
  .sliderbg { position: absolute; inset: 0; border: 1px solid #ccc; border-radius: 10px; }
  .sliderTarget { position: absolute; top: 0; left: 222px; width: 63px; height: 40px; border: 1px solid #999; box-sizing: border-box; }
  .slider { position: absolute; top: 0; left: 0; width: 63px; height: 40px; background: #333; cursor: grab; }
</style></head><body>
<p>Slide right to secure your access</p>
<div id="captcha__frame" class="simple"><div class="sliderContainer">
  <div class="sliderbg"></div><div class="sliderTarget"></div><div class="slider"></div>
</div></div>
<script>
  const slider = document.querySelector('.slider');
  const container = document.querySelector('.sliderContainer');
  let down = false, startX = 0, startedAt = 0, moves = 0, trusted = true, focused = true;
  slider.addEventListener('mousedown', (event) => {
    if (!event.isTrusted) return;
    down = true; startX = event.clientX; startedAt = performance.now(); moves = 0; trusted = true; focused = true;
  });
  document.addEventListener('mousemove', (event) => {
    if (!down) return;
    // Like DataDome, which records document.hasFocus() with every move of the drag.
    trusted = trusted && event.isTrusted && event.buttons === 1;
    focused = focused && document.hasFocus();
    moves += 1;
    slider.style.left = Math.min(222, Math.max(0, event.clientX - startX)) + 'px';
  });
  document.addEventListener('mouseup', async (event) => {
    if (!down) return;
    down = false;
    const body = JSON.stringify({ left: parseFloat(slider.style.left) || 0, moves, trusted: trusted && event.isTrusted, focused, ms: performance.now() - startedAt });
    const { token } = await (await fetch('/verify?mode=${mode}', { method: 'POST', body })).json();
    if (token) {
      container.classList.add('slider-success');
      parent.postMessage({ ddToken: token }, '*');
    } else {
      container.classList.add('slider-error');
      // DataDome resets the widget after a failure.
      setTimeout(() => location.reload(), 600);
    }
  });
</script></body></html>`;

const protectedDocument = (mode: string) => `<!doctype html><html><head><title>example</title></head><body style="margin:0">
<script>
  addEventListener('message', (event) => {
    if (event.origin !== 'https://geo.captcha-delivery.com') return;
    if (event.data && event.data.ddToken) { document.cookie = 'datadome=' + event.data.ddToken + '; path=/'; location.reload(); }
  });
</script>
<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=local&cid=fixture&mode=${mode}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
</body></html>`;

describe.skipIf(!browserIntegration)("CAPTCHA guardian on a DataDome slider in an out-of-process frame", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabric-datadome-"));
  const verifications: Array<{ mode: string; accepted: boolean; left: number; moves: number; trusted: boolean; focused: boolean; ms: number }> = [];
  const tokens = new Set<string>();
  let captchaServer: ReturnType<typeof Bun.serve>;
  let siteServer: ReturnType<typeof Bun.serve>;
  let chrome: TestChromium;

  beforeAll(async () => {
    const { key, cert } = selfSigned(directory, "geo.captcha-delivery.com");
    captchaServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode") ?? "accept";
        if (url.pathname === "/captcha/") return new Response(sliderDocument(mode), { headers: { "content-type": "text/html" } });
        if (url.pathname === "/verify") {
          const result = await request.json() as { left: number; moves: number; trusted: boolean; focused: boolean; ms: number };
          const accepted = mode === "accept" && result.trusted && result.focused && result.left >= 218 && result.moves >= 10 && result.ms >= 300;
          verifications.push({ mode, accepted, ...result });
          const token = accepted ? crypto.randomUUID() : undefined;
          if (token) tokens.add(token);
          return Response.json({ token });
        }
        return new Response("not found", { status: 404 });
      },
    });
    siteServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie")?.match(/datadome=([^;]+)/)?.[1];
        if (cookie && tokens.has(cookie)) return new Response("<title>Protected content</title><h1 id=content>Reviews</h1>", { headers: { "content-type": "text/html" } });
        return new Response(protectedDocument(url.searchParams.get("mode") ?? "accept"), { status: 403, headers: { "content-type": "text/html" } });
      },
    });
    chrome = await launchChromium(undefined, {
      hostResolverRules: `MAP geo.captcha-delivery.com 127.0.0.1:${captchaServer.port}`,
      args: ["--ignore-certificate-errors"],
    });
  });

  afterAll(async () => {
    await chrome?.close();
    captchaServer?.stop(true);
    siteServer?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });

  /** Opens the protected page under a fresh guardian until `until` holds, then keeps guarding it for `holdMs`. */
  async function openProtected(mode: string, until: (page: Page) => Promise<boolean>, timeoutMs: number, holdMs = 0) {
    const logs: GuardianLog[] = [];
    const guardian = new CaptchaGuardian({ endpoint: chrome.endpoint, pollIntervalMs: 250, maxRounds: 2, logger: (event, details) => logs.push({ event, ...(details ? { details } : {}) }) });
    await guardian.start();
    const browser: PuppeteerBrowser = await puppeteer.connect({ browserURL: chrome.endpoint, defaultViewport: null });
    const page = await browser.newPage();
    try {
      // Each scenario starts without the clearance cookie an earlier one earned.
      const session = await page.createCDPSession();
      await session.send("Network.clearBrowserCookies");
      await session.detach();
      await page.goto(`http://localhost:${siteServer.port}/reviews?mode=${mode}`, { waitUntil: "domcontentloaded" });
      // The captcha must really be an out-of-process frame, so this exercises the frame-session path.
      await eventually(() => browser.targets().some((target) => target.url().startsWith("https://geo.captcha-delivery.com/captcha/")), 5_000);
      const deadline = Date.now() + timeoutMs;
      while (!(await until(page).catch(() => false))) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      return { logs, snapshot: guardian.snapshot, title: await page.title().catch(() => ""), state: await captchaState(page).catch(() => "") };
    } finally {
      await page.close().catch(() => undefined);
      await browser.disconnect().catch(() => undefined);
      await guardian.stop();
    }
  }

  test("slides the slider to the end with trusted, focused input and reaches the protected content", async () => {
    verifications.length = 0;
    const { title, snapshot, logs } = await openProtected("accept", async (page) => (await page.title()) === "Protected content", 30_000);
    expect(title).toBe("Protected content");
    expect(verifications).toHaveLength(1);
    expect(verifications[0]).toMatchObject({ accepted: true, trusted: true, focused: true });
    expect(snapshot.failed).toBe(0);
    expect(logs.some(({ event }) => event === "solved") || title === "Protected content").toBe(true);
  }, 45_000);

  test("a slider that keeps rejecting fails the session once, and the document gets no further slide", async () => {
    verifications.length = 0;
    const { state, snapshot, logs } = await openProtected("reject", async (page) => (await captchaState(page)) === "failed", 40_000, 3_000);
    expect(state).toBe("failed");
    // maxRounds 2: two slides, then the session ends and the page document is left alone.
    expect(verifications.map(({ accepted }) => accepted)).toEqual([false, false]);
    expect(verifications.every(({ trusted, focused, left }) => trusted && focused && left >= 218)).toBe(true);
    expect(snapshot.failed).toBe(1);
    expect(logs.find(({ event }) => event === "failed")?.details).toMatchObject({ adapter: "datadome-slider" });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The reCAPTCHA token fallback: a local stand-in for reCAPTCHA's image challenge, served as
// https://www.google.com/recaptcha/api2/bframe, which llm-captcha cannot solve without a model. The
// widget's anchor frame (https://www.google.com/recaptcha/api2/anchor) is served empty.
// ---------------------------------------------------------------------------------------------

/** Newfold's widget as saved from newfold.com/abuse: rendered by grecaptcha.render() into div#captcha. */
const NEWFOLD_WIDGET = readFileSync(join(import.meta.dir, "fixtures/newfold-recaptcha-widget.html"), "utf8");
const NEWFOLD_SITEKEY = "6Lc2vj8lAAAAAF4yi77gg_-kxh2q4FyIBHUK9pES";

/** Every `data-captcha-state` the page reads, with its detail, in order, from the document's start. */
const RECORD_STATES = `(() => {
  window.__captchaStates = [];
  // The script runs before <html> exists, so watch the document for it.
  new MutationObserver(() => {
    const html = document.documentElement;
    const entry = (html.dataset.captchaState || '') + ' ' + (html.dataset.captchaDetail || '');
    if (window.__captchaStates.at(-1) !== entry) window.__captchaStates.push(entry);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-captcha-state', 'data-captcha-detail'] });
})()`;
const recordedStates = (page: Page) => page.evaluate(() => (window as any).__captchaStates as string[]);

const imageChallenge = `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
  #rc-imageselect { width: 380px; padding: 8px; }
  .rc-imageselect-desc-wrapper { background: #1a73e8; color: white; padding: 16px; }
  table { border-spacing: 4px; } td.rc-imageselect-tile { width: 110px; height: 110px; background: #8a8; }
  #recaptcha-verify-button { margin-top: 8px; padding: 8px 16px; }
</style></head><body><div id="rc-imageselect">
  <div class="rc-imageselect-desc-wrapper">Select all images with <strong>buses</strong></div>
  <table>${"<tr>" + "<td class=\"rc-imageselect-tile\"></td>".repeat(3) + "</tr>"}${"<tr>" + "<td class=\"rc-imageselect-tile\"></td>".repeat(3) + "</tr>"}${"<tr>" + "<td class=\"rc-imageselect-tile\"></td>".repeat(3) + "</tr>"}</table>
  <button id="recaptcha-verify-button">Verify</button>
</div></body></html>`;

describe.skipIf(!browserIntegration)("CAPTCHA guardian reCAPTCHA token fallback", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabric-recaptcha-"));
  let google: ReturnType<typeof Bun.serve>;
  let site: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    const { key, cert } = selfSigned(directory, "www.google.com");
    google = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch: (request) => new Response(new URL(request.url).pathname.endsWith("/anchor") ? "<!doctype html><title>anchor</title>" : imageChallenge, { headers: { "content-type": "text/html" } }),
    });
    const challenge = (sitekey: string) => `<iframe src="https://www.google.com/recaptcha/api2/bframe?k=${sitekey}" style="width:400px;height:580px;border:0"></iframe>`;
    site = Bun.serve({
      port: 0,
      fetch: (request) => new URL(request.url).pathname === "/newfold"
        // Newfold's markup, and reCAPTCHA's registry as grecaptcha.render("captcha", { sitekey, callback }) leaves it.
        ? html(`${challenge(NEWFOLD_SITEKEY)}${NEWFOLD_WIDGET}
          <script>window.___grecaptcha_cfg = { count: 1, clients: { 0: { id: 0, version: "fixture", Ez: { Nq: { sitekey: "${NEWFOLD_SITEKEY}", size: "normal", callback: (token) => { window.__solvedToken = token; } } } } } };</script>`)
        : html(`<form>
          <div class="g-recaptcha" data-sitekey="${RECAPTCHA_TEST_SITEKEY}" data-callback="onCaptchaSolved">
            <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RECAPTCHA_TEST_SITEKEY}&size=normal" style="width:304px;height:78px;border:0"></iframe>
            <textarea name="g-recaptcha-response" style="display:none"></textarea>
          </div>
        </form>
        ${challenge(RECAPTCHA_TEST_SITEKEY)}
        <script>window.onCaptchaSolved = (token) => { window.__solvedToken = token; };</script>`),
    });
  });
  afterAll(() => {
    google?.stop(true);
    site?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });

  const args = () => [`--host-resolver-rules=MAP www.google.com 127.0.0.1:${google.port}`, "--ignore-certificate-errors"];
  /** A provider that takes `delayMs` per token, as real ones take tens of seconds. */
  const recordingSolver = (delayMs = 0) => {
    const tasks: CaptchaTask[] = [];
    return { tasks, solver: { solve: async (task: CaptchaTask) => { tasks.push(task); await Bun.sleep(delayMs); return BOUGHT_TOKEN; } } satisfies TokenCaptchaSolver };
  };

  /** A new page that records every CAPTCHA state its documents read. */
  const recordingPage = async (browser: PuppeteerBrowser) => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(RECORD_STATES);
    return page;
  };

  test("the probe and the callback on real DOM: any render style, invisible, Enterprise, hidden and solved widgets skipped", async () => {
    const chromium = await launchChromium();
    const browser = await puppeteer.connect({ browserURL: chromium.endpoint, defaultViewport: null });
    try {
      const page = await browser.newPage();
      // Frames point at a closed port: rendered, never loaded, nothing leaves the machine.
      const anchor = (path: string, sitekey: string, size = "normal", style = "") => `<iframe src="http://127.0.0.1:9/recaptcha/${path}?ar=1&k=${sitekey}&size=${size}" style="width:304px;height:78px;${style}"></iframe>`;
      const widget = (inner: string, response = "", attributes = "") => `<div ${attributes}><div>${inner}</div><textarea name="g-recaptcha-response" style="display:none">${response}</textarea></div>`;
      const key = (n: number) => `6Lc${String(n).repeat(37)}`;
      const probe = () => page.evaluate(RECAPTCHA_V2_PROBE_SCRIPT);
      await page.setContent(`<!doctype html><body>
        ${widget(anchor("api2/anchor", key(1), "invisible"))}
        ${widget(anchor("enterprise/anchor", key(2)))}
        ${widget(anchor("api2/anchor", key(3), "normal", "visibility:hidden"))}
        <div style="display:none">${widget(anchor("api2/anchor", key(4)))}</div>
        ${widget(anchor("api2/anchor", "not a sitekey"))}
        ${widget(anchor("api2/anchor", key(5)), "03AFsolved")}
        <div style="margin-top:2000px">${widget(anchor("api2/anchor", key(6)), "", `id="captcha"`)}</div>
        ${widget(anchor("api2/anchor", key(7)), "", `class="g-recaptcha" data-sitekey="${key(7)}" data-callback="onSeven"`)}
        <script>
          window.calls = [];
          window.onSeven = (token) => calls.push('data-callback ' + token);
          window.byName = (token) => calls.push('by name ' + token);
          window.___grecaptcha_cfg = { clients: { 0: { id: 0, Ab: { Cd: { sitekey: "${key(6)}", callback: (token) => calls.push('inline ' + token) } } }, 1: { id: 1, Ef: { sitekey: "${key(7)}", callback: "byName" } }, 2: { id: 2, Gh: { sitekey: "${key(7)}", callback: "alert(1)" } } } };
        </script>`);
      // Below the fold, rendered by grecaptcha.render() into a container of its own.
      expect(await probe()).toEqual({ sitekey: key(6) });
      expect(await page.evaluate(recaptchaCallbackScript("T6", key(6)))).toBe(1);
      await page.evaluate(() => { (document.querySelector("#captcha textarea") as HTMLTextAreaElement).value = "03AFtoken"; });
      // `.g-recaptcha` markup, its data-callback and a string callback in the registry; an expression is never run.
      expect(await probe()).toEqual({ sitekey: key(7) });
      expect(await page.evaluate(recaptchaCallbackScript("T7", key(7)))).toBe(2);
      expect(await page.evaluate(() => (window as any).calls)).toEqual(["inline T6", "by name T7", "data-callback T7"]);
      await page.evaluate(() => { document.querySelectorAll("textarea").forEach((field) => { field.value = "03AFtoken"; }); });
      expect(await probe()).toBeNull();
    } finally {
      await browser.disconnect();
      await chromium.close();
    }
  }, 60_000);

  test("newfold.com/abuse: a widget rendered by grecaptcha.render() below the fold gets the fallback, its inline callback runs, and the page never reads failed", async () => {
    const { tasks, solver } = recordingSolver(1_500);
    const guarded = await launchGuarded({ args: args(), tokenSolver: solver, handlers: [{ id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: {} }] });
    try {
      const page = await recordingPage(guarded.browser);
      await page.goto(`http://localhost:${site.port}/newfold`, { waitUntil: "domcontentloaded" });
      await waitForState(page, "solved", 30_000);
      expect(tasks).toEqual([{ sitekey: NEWFOLD_SITEKEY, pageUrl: `http://localhost:${site.port}/newfold` }]);
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBe(BOUGHT_TOKEN);
      expect(await page.evaluate(() => (document.getElementById("g-recaptcha-response") as HTMLTextAreaElement).value)).toBe(BOUGHT_TOKEN);
      const states = await recordedStates(page);
      expect(states).toContain("solving recaptcha: token fallback");
      expect(states.at(-1)).toBe("solved recaptcha: token");
      expect(states.filter((state) => state.startsWith("failed"))).toEqual([]);
    } finally {
      await guarded.close();
    }
  }, 90_000);

  test("after llm-captcha failed on the image challenge, buys one token for the document, hands it to the page and only then reads solved", async () => {
    const { tasks, solver } = recordingSolver(1_500);
    const guarded = await launchGuarded({ args: args(), tokenSolver: solver, handlers: [{ id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: {} }] });
    try {
      const page = await recordingPage(guarded.browser);
      await page.goto(`http://localhost:${site.port}/report`, { waitUntil: "domcontentloaded" });
      await waitForState(page, "solved", 30_000);
      expect(await page.evaluate(() => document.documentElement.dataset.captchaDetail)).toBe("recaptcha: token");
      // llm-captcha's own `failed (recaptcha-images: …)` never reaches the page: a client stopping on
      // it would release the browser and kill the paid fallback.
      expect(await recordedStates(page)).toEqual(["solving recaptcha-images", "solving recaptcha: token fallback", "solved recaptcha: token"]);
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBe(BOUGHT_TOKEN);
      expect(await page.evaluate(() => (document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement).value)).toBe(BOUGHT_TOKEN);
      // One token per document, however many polls pass.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(tasks).toEqual([{ sitekey: RECAPTCHA_TEST_SITEKEY, pageUrl: `http://localhost:${site.port}/report` }]);
    } finally {
      await guarded.close();
    }
  }, 90_000);

  test("a recipe without a token provider never buys one, and the page reads failed with llm-captcha's reason", async () => {
    const { tasks, solver } = recordingSolver();
    const guarded = await launchGuarded({ args: args(), tokenSolver: solver, handlers: [{ id: "manual-auth", kind: "manual-handoff", mode: "manual", configuration: {} }] });
    try {
      const page = await recordingPage(guarded.browser);
      await page.goto(`http://localhost:${site.port}/report`, { waitUntil: "domcontentloaded" });
      await waitForState(page, "failed", 30_000);
      expect(await page.evaluate(() => document.documentElement.dataset.captchaDetail)).toBe("recaptcha-images: no model configured");
      // `failed` once, as the final word after the guardian decided no fallback runs.
      expect(await recordedStates(page)).toEqual(["solving recaptcha-images", "failed recaptcha-images: no model configured"]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(tasks).toHaveLength(0);
      expect(await page.evaluate(() => (window as any).__solvedToken)).toBeUndefined();
    } finally {
      await guarded.close();
    }
  }, 90_000);
});
