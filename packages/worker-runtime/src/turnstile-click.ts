/**
 * Cloudflare Turnstile: one trusted click on the checkbox at the left of the widget iframe,
 * after a short eased approach, and only while the widget asks for it.
 *
 * A click starts Cloudflare's check: the widget swaps its checkbox for a "Verifying…" spinner,
 * then shows success, or a failure it retries by itself (it reloads its frame and verifies
 * again). Clicking again while it verifies restarts the check, which over a slow egress (Tor)
 * never gets to finish. So the handler reads the widget's state from its frame first and clicks
 * only when the checkbox is shown; when the state cannot be read, clicks start after a boot grace
 * and stay spaced by the policy's retry delay.
 */
import type { CdpSend, ChallengeBudgetPolicy, ChallengeFrameBox, ChallengeHandler } from "./challenge-handlers";
import { approachSteps, dispatchMouseSteps, jitter, type MouseStep, type RandomSource } from "./trusted-mouse";
import { attributeValue, challengeFrameDocument, isTurnstileFrameUrl, rectFromQuad, type CdpDomNode } from "./turnstile-guardian-observation";

/**
 * A human beat before the first click, then at least the time Cloudflare's verdict takes over a
 * slow egress before the next. The widget's own state additionally holds clicks while it verifies.
 */
export const TURNSTILE_CLICK_POLICY: Pick<ChallengeBudgetPolicy, "firstAttemptDelayMs" | "retryDelayMs"> = {
  firstAttemptDelayMs: 1_000,
  retryDelayMs: 8_000,
};

/**
 * - `interactive`: the checkbox is shown and waits for a click.
 * - `verifying`: neither the checkbox nor a verdict is shown: the widget boots or runs its check.
 * - `succeeded` / `failed`: a verdict is shown. A failure is retried by the widget itself.
 * - `unknown`: the frame's document is not readable or not recognizably a Turnstile widget.
 */
export type TurnstileWidgetState = "interactive" | "verifying" | "succeeded" | "failed" | "unknown";

/**
 * How long an unrecognizable widget may boot (its frame document exists before the widget renders
 * into it) before clicks fall back to the retry delay alone.
 */
export const TURNSTILE_UNKNOWN_WIDGET_GRACE_MS = 3_000;

/** Bounds the box-model reads per poll; a real widget has one checkbox and six status panels. */
const MAX_WIDGET_NODES = 16;

/**
 * Reads the widget's state from its frame document (`challengeFrameDocument` explains the session
 * arguments) through DOM-domain commands only. Cloudflare randomizes the widget's ids and classes
 * on every load, so the state comes from its structure inside the frame's closed shadow root: one
 * checkbox (`input[type=checkbox]`), a verifying panel, and `role=alert` panels for success
 * (always first), failure, expiry, timeout, and error. A panel counts as shown when it has a
 * layout box: the widget hides the others with `display: none`.
 */
export async function readTurnstileWidget(send: CdpSend, sessionId: string, sameProcessFrameId?: string): Promise<TurnstileWidgetState> {
  let root: CdpDomNode | undefined;
  try {
    root = await challengeFrameDocument(send, sessionId, sameProcessFrameId, { subtree: true });
  } catch {
    return "unknown";
  }
  const checkboxes: number[] = [];
  const alerts: number[] = [];
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const node = candidate as CdpDomNode;
    if (typeof node.nodeId === "number") {
      const role = attributeValue(node.attributes, "role")?.toLowerCase();
      const checkbox = role === "checkbox" || (node.nodeName === "INPUT" && attributeValue(node.attributes, "type")?.toLowerCase() === "checkbox");
      if (checkbox && checkboxes.length < MAX_WIDGET_NODES) checkboxes.push(node.nodeId);
      if (role === "alert" && alerts.length < MAX_WIDGET_NODES) alerts.push(node.nodeId);
    }
    // Nested frames are other documents; the widget's own markup is in this one.
    for (const children of [node.children, node.shadowRoots]) {
      if (Array.isArray(children)) for (const child of children) visit(child);
    }
  };
  visit(root);
  if (checkboxes.length === 0 && alerts.length === 0) return "unknown";
  const shown = async (nodeId: number) => {
    const result = await send("DOM.getBoxModel", { nodeId }, sessionId).catch(() => undefined);
    return rectFromQuad(result?.model?.border) !== undefined;
  };
  for (const nodeId of checkboxes) if (await shown(nodeId)) return "interactive";
  for (const [index, nodeId] of alerts.entries()) if (await shown(nodeId)) return index === 0 ? "succeeded" : "failed";
  return "verifying";
}

/** The checkbox sits near the widget's left edge, vertically centered. */
export function turnstileClickSteps(box: ChallengeFrameBox, random: RandomSource = Math.random): MouseStep[] {
  const x = Math.max(1, box.x + Math.min(Math.max(2, box.width / 2), Math.max(2, Math.min(30, box.width - 2))));
  const y = Math.max(1, box.y + Math.min(Math.max(2, box.height / 2), Math.max(2, box.height - 2)));
  const approach = approachSteps({ x: jitter(x, 2, random), y: jitter(y, 2, random) }, random);
  approach[approach.length - 1]!.delayMs = 40;
  const click = { x: jitter(x, 1, random), y: jitter(y, 1, random) };
  return [
    ...approach,
    { type: "mousePressed", ...click, buttons: 1, delayMs: 55 },
    { type: "mouseReleased", ...click, buttons: 0, delayMs: 0 },
  ];
}

export function turnstileClickHandler(budget: { maxAttempts: number; timeoutMs: number }): ChallengeHandler {
  return {
    kind: "turnstile",
    actionEvent: "clicked",
    policy: { ...budget, ...TURNSTILE_CLICK_POLICY },
    matchesFrameUrl: isTurnstileFrameUrl,
    async act(context, box) {
      const widget = await context.withFrameSession(box, async (frameSessionId): Promise<TurnstileWidgetState> => {
        // Without its own session or frame id, the frame's document cannot be told apart from the page's.
        if (frameSessionId === undefined && box.frameId === undefined) return "unknown";
        return readTurnstileWidget(context.send, frameSessionId ?? context.pageSessionId, frameSessionId ? undefined : box.frameId);
      });
      context.noteWidget(widget);
      if (widget === "succeeded") return "solved";
      if (widget === "verifying" || widget === "failed") return "waiting";
      if (widget === "unknown" && context.elapsedMs < TURNSTILE_UNKNOWN_WIDGET_GRACE_MS) return "waiting";
      await dispatchMouseSteps(context.send, context.pageSessionId, turnstileClickSteps(box));
      return "acted";
    },
  };
}
