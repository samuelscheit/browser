import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATADOME_SLIDER_POLICY,
  SiteAttemptLedger,
  TurnstileGuardian,
  challengeDecision,
  challengeSite,
  frameRectToPage,
  isDataDomeFrameUrl,
  newChallengeState,
  rectContains,
  sliderDragSteps,
  type ChallengeBudgetPolicy,
  type MouseStep,
} from "@browser-fabric/worker-runtime";
import puppeteer, { type Browser as PuppeteerBrowser } from "puppeteer-core";
import { FakeCdpTransport, challengeObservation, eventually, inputEvents, type Command } from "./support/fake-guardian-transport";
import { browserIntegration, launchChromium, type TestChromium } from "./support/chromium";

/** Deterministic random source, so path properties are checked over many reproducible plans. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DATADOME_URL = "https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA&hash=229542D5&cid=Jn9e&t=fe&referer=https%3A%2F%2Fwww.g2.com%2F&s=48636&dm=cd";

describe("DataDome frame URL validation", () => {
  test("accepts DataDome's HTTPS CAPTCHA documents", () => {
    for (const url of [
      DATADOME_URL,
      "https://captcha-delivery.com/captcha/?cid=1",
      "https://GEO.Captcha-Delivery.COM/captcha/",
      "https://eu.geo.captcha-delivery.com:443/captcha/?x=1",
    ]) expect(isDataDomeFrameUrl(url)).toBe(true);
  });

  test("rejects lookalike hosts, other schemes, credentials, ports, other paths, and non-strings", () => {
    for (const url of [
      "http://geo.captcha-delivery.com/captcha/",
      "https://geo.captcha-delivery.com.evil.example/captcha/",
      "https://evilcaptcha-delivery.com/captcha/",
      "https://captcha-delivery.co/captcha/",
      "https://captcha-delivery.com@evil.example/captcha/",
      "https://user:pass@geo.captcha-delivery.com/captcha/",
      "https://geo.captcha-delivery.com:8443/captcha/",
      "https://geo.captcha-delivery.com/interstitial/?cid=1",
      "https://geo.captcha-delivery.com/captchax/",
      "https://geo.captcha-delivery.com/",
      "https://evil.example/captcha/?next=https://geo.captcha-delivery.com/captcha/",
      "https://evil.example/geo.captcha-delivery.com/captcha/",
      "javascript:alert(1)//geo.captcha-delivery.com/captcha/",
      "data:text/html,geo.captcha-delivery.com/captcha/",
      `https://geo.captcha-delivery.com/captcha/?${"a".repeat(9_000)}`,
      "",
    ]) expect(isDataDomeFrameUrl(url)).toBe(false);
    for (const value of [undefined, null, 42, {}, ["https://geo.captcha-delivery.com/captcha/"]]) expect(isDataDomeFrameUrl(value)).toBe(false);
  });
});

describe("DataDome slider geometry", () => {
  test("moves a rectangle from the frame's viewport into top-level page coordinates", () => {
    const owner = { x: 100.5, y: 50, width: 400, height: 300 };
    expect(frameRectToPage(owner, { x: 20, y: 100, width: 63, height: 40 })).toEqual({ x: 120.5, y: 150, width: 63, height: 40 });
    expect(frameRectToPage({ x: 0, y: 0, width: 0, height: 0 }, { x: 7, y: 9, width: 3, height: 4 })).toEqual({ x: 7, y: 9, width: 3, height: 4 });
  });

  test("checks containment with a one-pixel tolerance on every edge", () => {
    const owner = { x: 100, y: 50, width: 400, height: 300 };
    expect(rectContains(owner, { x: 100, y: 50, width: 400, height: 300 })).toBe(true);
    expect(rectContains(owner, { x: 99.5, y: 49.5, width: 401, height: 301 })).toBe(true);
    expect(rectContains(owner, { x: 98, y: 60, width: 10, height: 10 })).toBe(false);
    expect(rectContains(owner, { x: 450, y: 60, width: 52, height: 10 })).toBe(false);
    expect(rectContains(owner, { x: 150, y: 345, width: 10, height: 7 })).toBe(false);
    expect(rectContains(owner, { x: 150, y: 48, width: 10, height: 10 })).toBe(false);
  });
});

/** DataDome's simple-mode layout: a 63px handle at the start, its target clamped 222px further. */
const handle = { x: 120, y: 150, width: 63, height: 40 };
const target = { x: 342, y: 150, width: 63, height: 40 };

function phases(steps: MouseStep[]) {
  const pressIndex = steps.findIndex((step) => step.type === "mousePressed");
  const releaseIndex = steps.findIndex((step) => step.type === "mouseReleased");
  return {
    approach: steps.slice(0, pressIndex),
    press: steps[pressIndex]!,
    drag: steps.slice(pressIndex + 1, releaseIndex),
    release: steps[releaseIndex]!,
    pressIndex,
    releaseIndex,
  };
}

describe("DataDome slider drag path", () => {
  test("over many plans: hovers onto the handle, presses on it, drags monotonically past the end with bounded jitter, settles, and releases on the target", () => {
    const distance = (target.x + target.width / 2) - (handle.x + handle.width / 2);
    for (let seed = 1; seed <= 500; seed += 1) {
      const steps = sliderDragSteps(handle, target, seeded(seed))!;
      expect(steps).toBeDefined();
      const { approach, press, drag, release, pressIndex, releaseIndex } = phases(steps);
      expect(steps.filter((step) => step.type === "mousePressed")).toHaveLength(1);
      expect(steps.filter((step) => step.type === "mouseReleased")).toHaveLength(1);
      expect(releaseIndex).toBe(steps.length - 1);

      // Approach: hover moves with no button held, ending exactly where the press happens.
      expect(approach.length).toBeGreaterThanOrEqual(8);
      expect(approach.every((step) => step.type === "mouseMoved" && step.buttons === 0)).toBe(true);
      expect(approach.at(-1)).toMatchObject({ x: press.x, y: press.y });
      expect(approach[0]!.x).toBeLessThan(press.x);

      // Press: on the handle, near its center, button held.
      expect(rectContains(handle, { x: press.x, y: press.y, width: 0, height: 0 }, 0)).toBe(true);
      expect(Math.abs(press.x - (handle.x + handle.width / 2))).toBeLessThanOrEqual(6);
      expect(press.buttons).toBe(1);

      // Drag: every move holds the button; x never decreases until the overshoot peak.
      expect(drag.length).toBeGreaterThanOrEqual(26 + 2);
      expect(drag.every((step) => step.type === "mouseMoved" && step.buttons === 1)).toBe(true);
      const xs = drag.map((step) => step.x);
      const peakIndex = xs.lastIndexOf(Math.max(...xs));
      for (let index = 1; index <= peakIndex; index += 1) expect(xs[index]!).toBeGreaterThanOrEqual(xs[index - 1]!);
      expect(peakIndex).toBeGreaterThanOrEqual(25);
      // Overshoot of 3..9px past the end, then a settle that never falls back short of the end.
      const end = press.x + distance;
      expect(xs[peakIndex]! - end).toBeGreaterThanOrEqual(3);
      expect(xs[peakIndex]! - end).toBeLessThanOrEqual(9);
      for (const x of xs.slice(peakIndex)) expect(x).toBeGreaterThan(end);
      // Vertical wander stays within 2.5px of the press point, and so inside the handle's row.
      for (const step of [...drag, release]) expect(Math.abs(step.y - press.y)).toBeLessThanOrEqual(2.5 + 1e-9);

      // Release: past the track end, on the target, button up.
      expect(release.x).toBeGreaterThan(end);
      expect(release.x).toBeLessThan(target.x + target.width);
      expect(rectContains(target, { x: release.x, y: release.y, width: 0, height: 0 }, 0)).toBe(true);
      expect(release.buttons).toBe(0);
      expect(release.x).toBe(drag.at(-1)!.x);

      // Timing: a human-paced drag, from press to release, with varied step delays.
      const dragMs = steps.slice(pressIndex, releaseIndex).reduce((total, step) => total + step.delayMs, 0);
      expect(dragMs).toBeGreaterThanOrEqual(600);
      expect(dragMs).toBeLessThanOrEqual(1_900);
      const delays = drag.slice(0, peakIndex).map((step) => step.delayMs);
      expect(new Set(delays.map((delay) => Math.round(delay))).size).toBeGreaterThan(5);
      expect(Math.min(...delays)).toBeGreaterThan(0);
    }
  });

  test("varies between runs", () => {
    const first = sliderDragSteps(handle, target)!;
    const second = sliderDragSteps(handle, target)!;
    expect(first.map((step) => [step.x, step.y])).not.toEqual(second.map((step) => [step.x, step.y]));
  });

  test("refuses geometry that does not describe a slide to the right", () => {
    expect(sliderDragSteps(handle, { ...target, x: handle.x - 100 })).toBeUndefined();
    expect(sliderDragSteps(handle, { ...target, x: handle.x + 10 })).toBeUndefined();
    expect(sliderDragSteps({ ...handle, width: 0 }, target)).toBeUndefined();
    expect(sliderDragSteps({ ...handle, height: 0 }, target)).toBeUndefined();
  });
});

describe("challenge attempt budget", () => {
  const policy: ChallengeBudgetPolicy = { ...DATADOME_SLIDER_POLICY, timeoutMs: 12_000 };

  test("waits a human beat before the first slide, then waits for the verdict between slides, and bounds after two", () => {
    const state = newChallengeState("datadome", policy, 1_000, "geometry");
    expect(challengeDecision(state, policy, 1_000)).toBe("wait");
    expect(challengeDecision(state, policy, 2_499)).toBe("wait");
    expect(challengeDecision(state, policy, 2_500)).toBe("act");
    state.attempts = 1;
    state.nextAttemptAt = 2_500 + policy.retryDelayMs;
    expect(challengeDecision(state, policy, 7_499)).toBe("wait");
    expect(challengeDecision(state, policy, 7_500)).toBe("act");
    state.attempts = 2;
    state.nextAttemptAt = 7_500 + policy.retryDelayMs;
    expect(challengeDecision(state, policy, 8_000)).toBe("bound");
    state.bounded = true;
    expect(challengeDecision(state, policy, 60_000)).toBe("bounded");
  });

  test("bounds a challenge that outlives its timeout, and one whose site budget is spent", () => {
    const state = newChallengeState("datadome", policy, 0, "geometry");
    expect(challengeDecision(state, policy, 12_000)).toBe("act");
    expect(challengeDecision(state, policy, 12_001)).toBe("bound");
    const fresh = newChallengeState("datadome", policy, 0, "geometry");
    expect(challengeDecision(fresh, policy, 2_000, 2)).toBe("act");
    expect(challengeDecision(fresh, policy, 2_000, 3)).toBe("bound");
  });

  test("counts site attempts in a sliding window per vendor and top-level origin", () => {
    const ledger = new SiteAttemptLedger();
    const site = challengeSite("datadome", "https://www.g2.com/products/notion/reviews");
    expect(site).toBe(challengeSite("datadome", "https://www.g2.com/other?x=1"));
    expect(site).not.toBe(challengeSite("datadome", "https://g2.com/"));
    expect(site).not.toBe(challengeSite("turnstile", "https://www.g2.com/"));
    expect(challengeSite("datadome", "data:text/html,secret")).toBe(challengeSite("datadome", "data:text/html,other"));
    const window = 30 * 60_000;
    ledger.record(site, 0);
    ledger.record(site, 1_000);
    ledger.record(challengeSite("datadome", "https://other.example/"), 1_000);
    expect(ledger.count(site, window, 2_000)).toBe(2);
    expect(ledger.count(site, window, window)).toBe(1);
    expect(ledger.count(site, window, window + 1_000)).toBe(0);
  });
});

type WidgetModel = {
  /** The frame renders in the page's process: no frame target, quads already in page coordinates. */
  inProcess?: boolean;
  frameUrl?: string;
  targetUrl?: string;
  frameClass?: string;
  containerClass?: string;
};

/** A g2-like DataDome page: an out-of-process captcha frame at (100,50) 400x300 with the simple slider inside. */
function dataDomeTransport(model: WidgetModel = {}): FakeCdpTransport {
  const frameUrl = model.frameUrl ?? DATADOME_URL;
  const nodes: Record<string, number> = { "#captcha__frame": 2, ".sliderContainer": 3, ".slider": 11, ".sliderTarget": 12 };
  const quad = (x: number, y: number, width: number, height: number) => [x, y, x + width, y, x + width, y + height, x, y + height];
  const transport: FakeCdpTransport = new FakeCdpTransport({
    observation: challengeObservation({ url: "https://www.g2.com/products/notion/reviews", title: "g2.com", signals: [] }),
    respond: (command: Command) => {
      const inFrame = command.sessionId === "frame-session" || (model.inProcess === true && command.method === "DOM.getBoxModel" && command.params?.nodeId !== undefined);
      const origin = model.inProcess ? { x: 100, y: 50 } : { x: 0, y: 0 };
      switch (command.method) {
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "top", url: "https://www.g2.com/products/notion/reviews" }, childFrames: [{ frame: { id: "dd-frame", parentId: "top", url: frameUrl } }] } };
        case "DOM.getFrameOwner":
          return { backendNodeId: 90 };
        case "Target.getTargetInfo":
          if (model.inProcess) return { error: { message: "No target with given id found" } };
          return { targetInfo: { targetId: command.params?.targetId, type: "iframe", url: model.targetUrl ?? frameUrl } };
        case "Target.attachToTarget":
          if (command.params?.targetId !== "dd-frame") return undefined;
          // Chromium announces the new session before answering; the guardian must not detach it.
          transport.emitEvent("Target.attachedToTarget", { sessionId: "frame-session", targetInfo: { targetId: "dd-frame", type: "iframe", url: frameUrl } });
          return { sessionId: "frame-session" };
        case "DOM.getDocument":
          if (command.sessionId === "frame-session") return { root: { nodeId: 1, nodeName: "#document" } };
          // The page's pierced DOM carries an in-process frame's document under its owner.
          return model.inProcess
            ? { root: { nodeId: 100, nodeName: "#document", children: [{ nodeId: 101, nodeName: "IFRAME", backendNodeId: 90, frameId: "dd-frame", contentDocument: { nodeId: 1, nodeName: "#document" } }] } }
            : undefined;
        case "DOM.querySelector":
          return { nodeId: nodes[String(command.params?.selector)] ?? 0 };
        case "DOM.getAttributes":
          if (command.params?.nodeId === 2) return { attributes: ["id", "captcha__frame", "class", model.frameClass ?? "simple"] };
          return { attributes: ["class", `sliderContainer ${model.containerClass ?? ""}`.trim()] };
        case "DOM.getBoxModel":
          if (inFrame && command.params?.nodeId === 11) return { model: { border: quad(origin.x + 20, origin.y + 100, 63, 40) } };
          if (inFrame && command.params?.nodeId === 12) return { model: { border: quad(origin.x + 242, origin.y + 100, 63, 40) } };
          if (command.params?.backendNodeId === 90) return { model: { content: quad(100, 50, 400, 300) } };
          return { error: { message: "Could not compute box model." } };
        case "Page.getLayoutMetrics":
          return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
        default:
          return undefined;
      }
    },
  });
  return transport;
}

type GuardianLog = { event: string; details?: Record<string, unknown> };

async function runGuardian(transport: FakeCdpTransport, settleMs: number, until?: (logs: GuardianLog[]) => boolean) {
  const logs: GuardianLog[] = [];
  const guardian = new TurnstileGuardian({
    endpoint: "ws://browser.test/devtools/browser/datadome",
    transportFactory: async () => transport,
    pollIntervalMs: 250,
    logger: (event, details) => logs.push({ event, details }),
  });
  await guardian.start();
  if (until) await eventually(() => until(logs), settleMs);
  else await new Promise((resolve) => setTimeout(resolve, settleMs));
  const snapshot = guardian.snapshot;
  await guardian.stop();
  return { logs, snapshot };
}

describe("guardian on a DataDome page", () => {
  test("reads the slider through the frame's own session and drags it with trusted input on the page session", async () => {
    const transport = dataDomeTransport();
    const { logs, snapshot } = await runGuardian(transport, 6_000, () => inputEvents(transport).some((event) => event.params?.type === "mouseReleased"));

    const events = inputEvents(transport);
    expect(events.every((event) => event.sessionId === "page-session-1")).toBe(true);
    const press = events.find((event) => event.params?.type === "mousePressed")!.params as { x: number; y: number };
    const release = events.find((event) => event.params?.type === "mouseReleased")!.params as { x: number; y: number };
    // The handle is at frame (20,100) 63x40, so (120,150) on the page; its target 222px further.
    expect(press.x).toBeGreaterThanOrEqual(120);
    expect(press.x).toBeLessThanOrEqual(183);
    expect(press.y).toBeGreaterThanOrEqual(150);
    expect(press.y).toBeLessThanOrEqual(190);
    expect(release.x - press.x).toBeGreaterThan(222);
    expect(release.x).toBeLessThan(405);
    const drag = events.slice(events.indexOf(events.find((event) => event.params?.type === "mousePressed")!) + 1, -1);
    expect(drag.length).toBeGreaterThanOrEqual(28);
    expect(drag.every((event) => event.params?.buttons === 1 && event.params?.button === "left")).toBe(true);

    // The frame session lived exactly as long as the read: detached once, by the handler, before input.
    const detaches = transport.commands.filter((command) => command.method === "Target.detachFromTarget" && command.params?.sessionId === "frame-session");
    expect(detaches).toHaveLength(1);
    expect(transport.commands.indexOf(detaches[0]!)).toBeGreaterThan(transport.commands.indexOf(events.at(-1)!));
    // Only DOM-domain reads and focus emulation touch the widget; nothing runs in its JavaScript realm.
    const frameMethods = new Set(transport.commands.filter((command) => command.sessionId === "frame-session").map((command) => command.method));
    expect([...frameMethods].every((method) => method.startsWith("DOM.") || method === "Emulation.setFocusEmulationEnabled")).toBe(true);
    // Both documents report focus for exactly the length of the gesture.
    for (const sessionId of ["page-session-1", "frame-session"]) {
      const focus = transport.commands.filter((command) => command.method === "Emulation.setFocusEmulationEnabled" && command.sessionId === sessionId);
      expect(focus.map((command) => command.params?.enabled)).toEqual([true, false]);
      expect(transport.commands.indexOf(focus[0]!)).toBeLessThan(transport.commands.indexOf(events[0]!));
      expect(transport.commands.indexOf(focus[1]!)).toBeGreaterThan(transport.commands.indexOf(events.at(-1)!));
    }

    expect(snapshot.clickAttempts).toBe(1);
    expect(logs.find(({ event }) => event === "detected")?.details).toMatchObject({ kind: "datadome", url: "https://www.g2.com" });
    expect(logs.find(({ event }) => event === "slid")?.details).toMatchObject({ kind: "datadome", clickAttempts: 1 });
    expect(JSON.stringify(logs)).not.toContain("initialCid");
  }, 10_000);

  test("reads an in-process frame through the page session, whose quads are already in page coordinates", async () => {
    const transport = dataDomeTransport({ inProcess: true });
    const { snapshot } = await runGuardian(transport, 6_000, () => inputEvents(transport).some((event) => event.params?.type === "mouseReleased"));
    const press = inputEvents(transport).find((event) => event.params?.type === "mousePressed")!.params as { x: number; y: number };
    const release = inputEvents(transport).find((event) => event.params?.type === "mouseReleased")!.params as { x: number; y: number };
    expect(press.x).toBeGreaterThanOrEqual(120);
    expect(press.x).toBeLessThanOrEqual(183);
    expect(release.x - press.x).toBeGreaterThan(222);
    expect(release.x).toBeLessThan(405);
    expect(transport.commands.some((command) => command.method === "Target.attachToTarget" && command.params?.targetId === "dd-frame")).toBe(false);
    expect(transport.commands.some((command) => command.method === "DOM.querySelector" && command.sessionId === "page-session-1" && command.params?.nodeId === 1)).toBe(true);
    expect(snapshot.clickAttempts).toBe(1);
  }, 10_000);

  test("waits a human beat after detection before the first slide", async () => {
    const transport = dataDomeTransport();
    await runGuardian(transport, 1_000);
    expect(inputEvents(transport)).toHaveLength(0);
  });

  test("leaves the puzzle variant alone and bounds it", async () => {
    const transport = dataDomeTransport({ frameClass: "" });
    const { logs, snapshot } = await runGuardian(transport, 4_000, (events) => events.some(({ event }) => event === "bounded"));
    expect(inputEvents(transport)).toHaveLength(0);
    expect(snapshot.clickAttempts).toBe(0);
    expect(logs.find(({ event }) => event === "bounded")?.details).toMatchObject({ kind: "datadome", reason: "unsupported-variant" });
  }, 6_000);

  test("does not slide a slider that already reports success", async () => {
    const transport = dataDomeTransport({ containerClass: "slider-success" });
    const { snapshot } = await runGuardian(transport, 2_500);
    expect(inputEvents(transport)).toHaveLength(0);
    expect(snapshot.clickAttempts).toBe(0);
  });

  test("does not slide when the frame's target reports a different document than the frame tree", async () => {
    const transport = dataDomeTransport({ targetUrl: "https://evil.example/captcha/" });
    const { snapshot } = await runGuardian(transport, 2_500);
    expect(inputEvents(transport)).toHaveLength(0);
    expect(transport.commands.some((command) => command.method === "Target.attachToTarget" && command.params?.targetId === "dd-frame")).toBe(false);
    expect(snapshot.clickAttempts).toBe(0);
  });

  test("never treats a lookalike captcha host as DataDome", async () => {
    const transport = dataDomeTransport({ frameUrl: "https://geo.captcha-delivery.com.evil.example/captcha/?cid=1" });
    const { logs } = await runGuardian(transport, 2_000);
    expect(inputEvents(transport)).toHaveLength(0);
    expect(transport.commands.some((command) => command.method === "Target.getTargetInfo")).toBe(false);
    expect(logs.some(({ event }) => event === "detected")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Real Chromium: a local DataDome look-alike, served as https://geo.captcha-delivery.com through a
// host-resolver rule, embedded cross-site (so it is an out-of-process frame) in a localhost page.
// The slider only accepts a trusted drag to the end, then the page reloads to its content.
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
      // DataDome resets after a failure; this fixture's 'reject-top' variant reloads the whole page.
      setTimeout(() => ${mode === "reject-top" ? "parent.postMessage({ ddReload: true }, '*')" : "location.reload()"}, 600);
    }
  });
</script></body></html>`;

const protectedDocument = (mode: string) => `<!doctype html><html><head><title>example</title></head><body style="margin:0">
<script>
  addEventListener('message', (event) => {
    if (event.origin !== 'https://geo.captcha-delivery.com') return;
    if (event.data && event.data.ddToken) { document.cookie = 'datadome=' + event.data.ddToken + '; path=/'; location.reload(); }
    if (event.data && event.data.ddReload) location.reload();
  });
</script>
<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=local&cid=fixture&mode=${mode}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
</body></html>`;

describe.skipIf(!browserIntegration)("real Chromium with a DataDome slider in an out-of-process frame", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabric-datadome-"));
  const verifications: Array<{ mode: string; accepted: boolean; left: number; moves: number; trusted: boolean; focused: boolean; ms: number }> = [];
  const tokens = new Set<string>();
  let captchaServer: ReturnType<typeof Bun.serve>;
  let siteServer: ReturnType<typeof Bun.serve>;
  let chrome: TestChromium;

  beforeAll(async () => {
    const certificate = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=geo.captcha-delivery.com",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stderr: "pipe" });
    if (certificate.exitCode !== 0) throw new Error(`openssl failed: ${certificate.stderr.toString()}`);
    captchaServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(join(directory, "key.pem")), cert: Bun.file(join(directory, "cert.pem")) },
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
  async function openProtected(mode: string, until: (page: Awaited<ReturnType<PuppeteerBrowser["newPage"]>>, logs: GuardianLog[]) => Promise<boolean>, timeoutMs: number, holdMs = 0) {
    const logs: GuardianLog[] = [];
    const guardian = new TurnstileGuardian({ endpoint: chrome.endpoint, pollIntervalMs: 250, logger: (event, details) => logs.push({ event, details }) });
    await guardian.start();
    const browser = await puppeteer.connect({ browserURL: chrome.endpoint, defaultViewport: null });
    const page = await browser.newPage();
    try {
      // Each scenario starts without the clearance cookie an earlier one earned.
      const session = await page.createCDPSession();
      await session.send("Network.clearBrowserCookies");
      await session.detach();
      await page.goto(`http://localhost:${siteServer.port}/reviews?mode=${mode}`, { waitUntil: "domcontentloaded" });
      // The captcha must really be an out-of-process frame, so this exercises the OOPIF path.
      await eventually(() => page.frames().some((frame) => frame.url().startsWith("https://geo.captcha-delivery.com/captcha/")), 5_000);
      const frameTarget = browser.targets().find((target) => target.url().startsWith("https://geo.captcha-delivery.com/captcha/"));
      expect(String(frameTarget?.type())).toBe("other");
      const deadline = Date.now() + timeoutMs;
      while (!(await until(page, logs).catch(() => false))) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      return { logs, snapshot: guardian.snapshot, title: await page.title().catch(() => "") };
    } finally {
      await page.close().catch(() => undefined);
      await browser.disconnect().catch(() => undefined);
      await guardian.stop();
    }
  }

  test("slides the slider to the end with trusted input and reaches the protected content", async () => {
    verifications.length = 0;
    const { logs, snapshot, title } = await openProtected("accept", async (page) => (await page.title()) === "Protected content", 15_000);
    expect(title).toBe("Protected content");
    expect(verifications).toHaveLength(1);
    expect(verifications[0]).toMatchObject({ accepted: true, trusted: true, focused: true, left: 222 });
    expect(verifications[0]!.moves).toBeGreaterThanOrEqual(26);
    expect(verifications[0]!.ms).toBeGreaterThan(500);
    expect(snapshot.clickAttempts).toBe(1);
    expect(logs.map(({ event }) => event)).toEqual(expect.arrayContaining(["detected", "slid", "cleared"]));
    expect(logs.find(({ event }) => event === "cleared")?.details).toMatchObject({ by: "navigation", kinds: ["datadome"] });
  }, 30_000);

  test("stops after two slides when the challenge keeps rejecting and resets itself", async () => {
    verifications.length = 0;
    // Past the bound, a reset widget must not get a third slide.
    const { logs, snapshot } = await openProtected("reject", async (_page, events) => events.some(({ event }) => event === "bounded"), 20_000, DATADOME_SLIDER_POLICY.retryDelayMs + 1_000);
    expect(verifications.map(({ mode, accepted }) => [mode, accepted])).toEqual([["reject", false], ["reject", false]]);
    expect(verifications.every(({ trusted, left }) => trusted && left === 222)).toBe(true);
    expect(snapshot.clickAttempts).toBe(2);
    expect(logs.find(({ event }) => event === "bounded")?.details).toMatchObject({ kind: "datadome", clickAttempts: 2 });
  }, 40_000);

  test("caps slides per site even when every failure reloads the whole page", async () => {
    verifications.length = 0;
    const siteLimit = DATADOME_SLIDER_POLICY.site!.maxAttempts;
    // Every failed slide reloads the page into a fresh challenge with a fresh per-challenge budget.
    // Give the fresh document past the limit more than its first-slide delay to (not) act.
    const { logs, snapshot } = await openProtected("reject-top", async (_page, events) => events.filter(({ event }) => event === "detected").length > siteLimit, 30_000, DATADOME_SLIDER_POLICY.firstAttemptDelayMs + 2_000);
    expect(logs.filter(({ event }) => event === "detected").length).toBeGreaterThan(siteLimit);
    expect(verifications).toHaveLength(siteLimit);
    expect(snapshot.clickAttempts).toBe(siteLimit);
    expect(logs.filter(({ event }) => event === "slid")).toHaveLength(siteLimit);
    expect(logs.find(({ event }) => event === "bounded")?.details).toMatchObject({ kind: "datadome", siteAttempts: siteLimit });
  }, 50_000);
});
