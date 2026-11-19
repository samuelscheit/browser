import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
  TURNSTILE_CLICK_POLICY,
  TURNSTILE_UNKNOWN_WIDGET_GRACE_MS,
  TurnstileGuardian,
  challengeDecision,
  newChallengeState,
  readTurnstileWidget,
  type CdpSend,
  type ChallengeBudgetPolicy,
  type TurnstileWidgetState,
} from "@browser-fabric/worker-runtime";
import {
  FakeCdpTransport,
  FakeTurnstileWidget,
  buttonEvents,
  eventually,
  morePolls,
  type Command,
  type FakeWidgetState,
} from "./support/fake-guardian-transport";

/** A CDP sender over one fake widget, as its own frame session sees it. */
function widgetSend(widget: FakeTurnstileWidget, sent: Command[] = []): CdpSend {
  return async (method, params, sessionId) => {
    sent.push({ id: sent.length + 1, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
    if (method === "DOM.getDocument") return { root: widget.document() };
    if (method === "DOM.getBoxModel") {
      if (widget.rendered(Number(params?.nodeId))) return { model: { border: [0, 0, 24, 0, 24, 24, 0, 24] } };
      throw new Error("Could not compute box model.");
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe("Turnstile widget state", () => {
  test("reads each state from the widget's structure, not its randomized ids", async () => {
    const expected: Record<FakeWidgetState, TurnstileWidgetState> = {
      interactive: "interactive",
      verifying: "verifying",
      succeeded: "succeeded",
      failed: "failed",
      expired: "failed",
      timeout: "failed",
      error: "failed",
      booting: "unknown",
    };
    for (const [state, reading] of Object.entries(expected) as Array<[FakeWidgetState, TurnstileWidgetState]>) {
      const sent: Command[] = [];
      expect(await readTurnstileWidget(widgetSend(new FakeTurnstileWidget(state), sent), "frame-session")).toBe(reading);
      // Only DOM-domain reads on the frame's own session; nothing runs in the widget's realm.
      expect(sent.every((command) => command.method.startsWith("DOM.") && command.sessionId === "frame-session")).toBe(true);
      expect(sent[0]).toMatchObject({ method: "DOM.getDocument", params: { depth: -1, pierce: true } });
    }
  });

  test("recognizes an ARIA checkbox, and stops at an unreadable or unrecognizable document", async () => {
    const ariaCheckbox: CdpSend = async (method, params) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1, nodeName: "#document", children: [{ nodeId: 2, nodeName: "DIV", attributes: ["role", "Checkbox"] }] } };
      if (method === "DOM.getBoxModel" && params?.nodeId === 2) return { model: { border: [0, 0, 24, 0, 24, 24, 0, 24] } };
      throw new Error("Could not compute box model.");
    };
    expect(await readTurnstileWidget(ariaCheckbox, "frame-session")).toBe("interactive");

    const unreadable: CdpSend = async () => { throw new Error("Target closed"); };
    expect(await readTurnstileWidget(unreadable, "frame-session")).toBe("unknown");
    const foreign: CdpSend = async () => ({ root: { nodeId: 1, nodeName: "#document", children: [{ nodeId: 2, nodeName: "INPUT", attributes: ["type", "text"] }] } });
    expect(await readTurnstileWidget(foreign, "frame-session")).toBe("unknown");
    const empty: CdpSend = async () => ({});
    expect(await readTurnstileWidget(empty, "frame-session")).toBe("unknown");
  });

  test("a checkbox without a layout box does not count, even with zero-size geometry", async () => {
    const send: CdpSend = async (method, params) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1, nodeName: "#document", children: [{ nodeId: 2, nodeName: "INPUT", attributes: ["type", "CHECKBOX"] }] } };
      if (method === "DOM.getBoxModel" && params?.nodeId === 2) return { model: { border: [5, 5, 5, 5, 5, 5, 5, 5] } };
      throw new Error("unexpected");
    };
    expect(await readTurnstileWidget(send, "frame-session")).toBe("verifying");
  });

  test("reads an in-process widget from the page's pierced DOM, and only that frame's document", async () => {
    const widget = new FakeTurnstileWidget("verifying");
    const sent: Command[] = [];
    const send: CdpSend = async (method, params, sessionId) => {
      sent.push({ id: sent.length + 1, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
      if (method === "DOM.getDocument") {
        return {
          root: {
            nodeId: 100, nodeName: "#document", children: [
              // Another frame's checkbox must not be mistaken for the widget's.
              { nodeId: 101, nodeName: "IFRAME", frameId: "other-frame", contentDocument: { nodeId: 102, nodeName: "#document", children: [{ nodeId: 103, nodeName: "INPUT", attributes: ["type", "checkbox"] }] } },
              { nodeId: 104, nodeName: "IFRAME", frameId: "ts-frame", contentDocument: widget.document() },
            ],
          },
        };
      }
      if (method === "DOM.getBoxModel" && (params?.nodeId === 103 || widget.rendered(Number(params?.nodeId)))) return { model: { border: [0, 0, 24, 0, 24, 24, 0, 24] } };
      throw new Error("Could not compute box model.");
    };
    expect(await readTurnstileWidget(send, "page-session", "ts-frame")).toBe("verifying");
    expect(sent.every((command) => command.sessionId === "page-session")).toBe(true);
    expect(await readTurnstileWidget(send, "page-session", "missing-frame")).toBe("unknown");
  });

  test("bounds its box-model reads on a hostile document", async () => {
    let boxReads = 0;
    const send: CdpSend = async (method) => {
      if (method === "DOM.getDocument") {
        const children = Array.from({ length: 500 }, (_, index) => ({ nodeId: 10 + index, nodeName: "DIV", attributes: ["role", index % 2 ? "alert" : "checkbox"] }));
        return { root: { nodeId: 1, nodeName: "#document", children } };
      }
      boxReads += 1;
      throw new Error("Could not compute box model.");
    };
    expect(await readTurnstileWidget(send, "frame-session")).toBe("verifying");
    expect(boxReads).toBeLessThanOrEqual(32);
  });
});

describe("Turnstile click budget", () => {
  const policy: ChallengeBudgetPolicy = {
    ...TURNSTILE_CLICK_POLICY,
    maxAttempts: DEFAULT_TURNSTILE_MAX_CLICK_ATTEMPTS,
    timeoutMs: DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS,
  };

  test("waits a human beat, then gives every click the time Cloudflare's verdict takes", () => {
    const state = newChallengeState("turnstile", policy, 0, "geometry");
    expect(challengeDecision(state, policy, 999)).toBe("wait");
    expect(challengeDecision(state, policy, 1_000)).toBe("act");
    state.attempts = 1;
    state.nextAttemptAt = 1_000 + policy.retryDelayMs;
    // The production failure: a re-click every poll while Cloudflare was still verifying.
    for (const now of [2_000, 3_000, 5_000, 8_999]) expect(challengeDecision(state, policy, now)).toBe("wait");
    expect(challengeDecision(state, policy, 9_000)).toBe("act");
  });

  test("fits every spaced click into the default budget, then bounds", () => {
    const state = newChallengeState("turnstile", policy, 0, "geometry");
    const clicks: number[] = [];
    for (let now = 0; now <= 60_000; now += 1_000) {
      const decision = challengeDecision(state, policy, now);
      if (decision === "bound") {
        state.bounded = true;
        break;
      }
      if (decision !== "act") continue;
      clicks.push(now);
      state.attempts += 1;
      state.nextAttemptAt = now + policy.retryDelayMs;
    }
    expect(clicks).toEqual([1_000, 9_000, 17_000, 25_000, 33_000]);
    expect(state.bounded).toBe(true);
    // A longer budget is bounded by time instead of clicks.
    const longer = { ...policy, maxAttempts: 20 };
    const timed = newChallengeState("turnstile", longer, 0, "geometry");
    timed.attempts = 6;
    timed.nextAttemptAt = 49_000;
    expect(challengeDecision(timed, longer, DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS)).toBe("wait");
    expect(challengeDecision(timed, longer, DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS + 1)).toBe("bound");
  });
});

type GuardianLog = { event: string; details?: Record<string, unknown> };

/**
 * The guardian against a fake widget on a frozen clock: polls run in real time (every 250 ms) while
 * `at` moves Date.now(), so delays of tens of seconds are checked exactly and quickly.
 */
async function guardedWidget(widget: FakeTurnstileWidget | null, options: { maxClickAttempts?: number; respond?: (command: Command) => Record<string, unknown> | undefined } = {}) {
  const start = Date.now();
  setSystemTime(new Date(start));
  const transport = new FakeCdpTransport({ widget, ...(options.respond ? { respond: options.respond } : {}) });
  const logs: GuardianLog[] = [];
  const guardian = new TurnstileGuardian({
    endpoint: "ws://browser.test/devtools/browser/turnstile-widget",
    transportFactory: async () => transport,
    pollIntervalMs: 250,
    ...(options.maxClickAttempts ? { maxClickAttempts: options.maxClickAttempts } : {}),
    logger: (event, details) => logs.push({ event, details }),
  });
  await guardian.start();
  const clicks = () => buttonEvents(transport).filter((command) => command.params?.type === "mouseReleased");
  return {
    transport,
    guardian,
    logs,
    clicks,
    /** Click times, ms after detection, from the frozen clock each click was sent at. */
    clickTimes: () => clicks().map((command) => Math.round(Number(command.params?.timestamp) * 1_000) - start),
    widgetLog: () => logs.filter(({ event }) => event === "widget").map(({ details }) => details?.widget),
    /** Moves the clock to `ms` after detection and lets the guardian poll there. */
    at: async (ms: number) => {
      setSystemTime(new Date(start + ms));
      await morePolls(transport, 2);
    },
  };
}

describe("guardian on a Turnstile widget", () => {
  afterEach(() => setSystemTime());

  test("clicks once, then waits out a slow verification without clicking again until it succeeds", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive", "verifying"));
    await run.at(500);
    expect(run.clicks()).toHaveLength(0);
    await run.at(1_000);
    expect(run.clickTimes()).toEqual([1_000]);
    // Over Tor, Cloudflare verifies for a long time; every poll past the retry delay finds it busy.
    for (let ms = 9_000; ms <= 30_000; ms += 3_000) await run.at(ms);
    expect(run.clicks()).toHaveLength(1);
    run.transport.widget!.state = "succeeded";
    await run.at(31_000);
    await run.at(44_000);
    expect(run.clicks()).toHaveLength(1);
    expect(run.guardian.snapshot.clickAttempts).toBe(1);
    expect(run.widgetLog()).toEqual(["interactive", "verifying", "succeeded"]);
    expect(run.logs.some(({ event }) => event === "bounded")).toBe(false);
    await run.guardian.stop();
  }, 20_000);

  test("re-clicks after a failure only once the widget offers its checkbox again, and never before the retry delay", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive", "failed"));
    await run.at(1_000);
    expect(run.clickTimes()).toEqual([1_000]);
    // A failure the widget retries on its own is no reason to click.
    await run.at(9_000);
    await run.at(12_000);
    expect(run.clicks()).toHaveLength(1);
    run.transport.widget!.state = "verifying";
    await run.at(13_000);
    run.transport.widget!.state = "interactive";
    await run.at(14_000);
    expect(run.clickTimes()).toEqual([1_000, 14_000]);
    // Back to the checkbox right away: the retry delay still spaces the clicks.
    run.transport.widget!.state = "interactive";
    await run.at(20_000);
    await run.at(21_999);
    expect(run.clicks()).toHaveLength(2);
    await run.at(22_000);
    expect(run.clickTimes()).toEqual([1_000, 14_000, 22_000]);
    expect(run.widgetLog()).toEqual(["interactive", "failed", "verifying", "interactive"]);
    await run.guardian.stop();
  }, 20_000);

  test("never clicks a widget that verifies on its own, as on Cloudflare's managed challenge", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("verifying"));
    for (let ms = 1_000; ms <= 20_000; ms += 4_000) await run.at(ms);
    run.transport.widget!.state = "succeeded";
    await run.at(21_000);
    expect(run.clicks()).toHaveLength(0);
    expect(run.guardian.snapshot.clickAttempts).toBe(0);
    expect(run.widgetLog()).toEqual(["verifying", "succeeded"]);
    // Each read used a short-lived frame session: DOM reads only, detached again.
    const frameCommands = run.transport.commands.filter((command) => command.sessionId?.startsWith("frame-session:"));
    expect(frameCommands.length).toBeGreaterThan(0);
    expect(frameCommands.every((command) => command.method.startsWith("DOM."))).toBe(true);
    const attaches = run.transport.commands.filter((command) => command.method === "Target.attachToTarget" && command.params?.targetId === "turnstile-frame-1").length;
    const detaches = run.transport.commands.filter((command) => command.method === "Target.detachFromTarget" && String(command.params?.sessionId).startsWith("frame-session:")).length;
    expect(attaches).toBe(detaches);
    await run.guardian.stop();
  }, 20_000);

  test("spends the whole click budget on a widget that ignores clicks, spaced by the retry delay, then bounds", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive"));
    // Just before and at every moment a click becomes due.
    for (const due of [1_000, 9_000, 17_000, 25_000, 33_000, 41_000]) {
      await run.at(due - 1);
      await run.at(due);
    }
    await run.at(50_000);
    expect(run.clickTimes()).toEqual([1_000, 9_000, 17_000, 25_000, 33_000]);
    const bounded = run.logs.filter(({ event }) => event === "bounded");
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.details).toMatchObject({ kind: "turnstile", clickAttempts: 5, widget: "interactive" });
    await run.guardian.stop();
  }, 30_000);

  test("bounds by time when the click budget outlasts it", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive"), { maxClickAttempts: 20 });
    for (const due of [1_000, 9_000, 17_000, 25_000, 33_000, 41_000]) await run.at(due);
    await run.at(DEFAULT_TURNSTILE_CHALLENGE_TIMEOUT_MS);
    expect(run.logs.some(({ event }) => event === "bounded")).toBe(false);
    await run.at(49_000);
    expect(run.clickTimes()).toEqual([1_000, 9_000, 17_000, 25_000, 33_000, 41_000]);
    expect(run.logs.find(({ event }) => event === "bounded")?.details?.elapsedMs).toBe(49_000);
    await run.guardian.stop();
  }, 30_000);

  test("a top-level navigation starts a fresh budget for the new document", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive"), { maxClickAttempts: 1 });
    await run.at(1_000);
    await run.at(9_000);
    expect(run.logs.filter(({ event }) => event === "bounded")).toHaveLength(1);
    expect(run.clicks()).toHaveLength(1);
    // The widget's own frame reloading (its auto-retry) keeps the spent budget.
    run.transport.emitEvent("Page.frameNavigated", { frame: { id: "turnstile-frame-1", parentId: "top", url: "https://challenges.cloudflare.com/turnstile/v0/retry" } }, "page-session-1");
    await run.at(20_000);
    expect(run.clicks()).toHaveLength(1);
    run.transport.emitEvent("Page.frameNavigated", { frame: { id: "top", url: "https://example.test/protected?again" } }, "page-session-1");
    await run.at(20_000);
    expect(run.logs.find(({ event }) => event === "cleared")?.details).toMatchObject({ by: "navigation", clickAttempts: 1 });
    expect(run.logs.filter(({ event }) => event === "detected")).toHaveLength(2);
    expect(run.clicks()).toHaveLength(1);
    await run.at(21_000);
    expect(run.clickTimes()).toEqual([1_000, 21_000]);
    await run.guardian.stop();
  }, 20_000);

  test("falls back to clicks spaced by the retry delay when the widget cannot be read, after a boot grace", async () => {
    const run = await guardedWidget(null);
    await run.at(1_000);
    await run.at(TURNSTILE_UNKNOWN_WIDGET_GRACE_MS - 1);
    expect(run.clicks()).toHaveLength(0);
    await run.at(TURNSTILE_UNKNOWN_WIDGET_GRACE_MS);
    await run.at(10_000);
    await run.at(11_000);
    expect(run.clickTimes()).toEqual([TURNSTILE_UNKNOWN_WIDGET_GRACE_MS, 11_000]);
    expect(run.widgetLog()).toEqual(["unknown"]);
    await run.guardian.stop();
  }, 20_000);

  test("waits for a booting widget to render instead of clicking blindly", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("booting"));
    await run.at(1_000);
    await run.at(2_000);
    run.transport.widget!.state = "interactive";
    await run.at(2_500);
    expect(run.clickTimes()).toEqual([2_500]);
    expect(run.widgetLog()).toEqual(["unknown", "interactive"]);
    await run.guardian.stop();
  }, 20_000);

  test("does not click when the frame's target reports a document other than Turnstile's", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive"), {
      respond: (command) => command.method === "Target.getTargetInfo"
        ? { targetInfo: { targetId: command.params?.targetId, type: "iframe", url: "https://evil.example/turnstile/" } }
        : undefined,
    });
    for (const ms of [1_000, 5_000, 12_000]) await run.at(ms);
    expect(run.clicks()).toHaveLength(0);
    expect(run.transport.commands.some((command) => command.method === "Target.attachToTarget" && command.params?.targetId === "turnstile-frame-1")).toBe(false);
    await run.guardian.stop();
  }, 20_000);

  test("clicks with trusted input on the page session, after the frame session is gone", async () => {
    const run = await guardedWidget(new FakeTurnstileWidget("interactive", "verifying"));
    await run.at(1_000);
    await eventually(() => run.clicks().length === 1, 2_000);
    const commands = run.transport.commands;
    const input = commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(input.every((command) => command.sessionId === "page-session-1")).toBe(true);
    const lastDetach = commands.findLastIndex((command, index) => index < commands.indexOf(input[0]!) && command.method === "Target.detachFromTarget");
    const lastRead = commands.findLastIndex((command, index) => index < commands.indexOf(input[0]!) && command.sessionId?.startsWith("frame-session:") === true);
    expect(lastDetach).toBeGreaterThan(lastRead);
    await run.guardian.stop();
  }, 20_000);
});
