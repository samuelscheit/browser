/**
 * DataDome "Slide right to secure your access" slider.
 *
 * DataDome serves its CAPTCHA in a cross-origin iframe from *.captcha-delivery.com (an
 * out-of-process frame under site isolation). Its `simple` variant is a plain slide-to-end:
 * the 63px handle is clamped at the far end, where `.sliderTarget` sits, and on mouseup the
 * widget reports the handle position together with its recorded trusted mouse movement. Its
 * `puzzle` variant instead needs the handle dropped on an image gap; this handler detects it
 * and leaves it alone rather than guessing a distance.
 *
 * The handler reads the widget's geometry through CDP on the frame's own target (never from
 * page JavaScript), converts it to top-level coordinates, and drags the handle with trusted
 * input on the page session.
 */
import type { CdpSend, ChallengeBudgetPolicy, ChallengeFrameBox, ChallengeHandler } from "./challenge-handlers";
import { approachSteps, between, dispatchMouseSteps, withEmulatedFocus, type MouseStep, type RandomSource } from "./trusted-mouse";
import { attributeValue, rectFromQuad, type Rect } from "./turnstile-guardian-observation";

/**
 * DataDome blocks the IP after failed slides, and a failure may reload the whole page, so
 * the budget is small per challenge and also per site across reloads and tabs.
 */
export const DATADOME_SLIDER_POLICY: Omit<ChallengeBudgetPolicy, "timeoutMs"> = {
  maxAttempts: 2,
  firstAttemptDelayMs: 1_500,
  retryDelayMs: 5_000,
  site: { maxAttempts: 3, windowMs: 30 * 60_000 },
};

/** Strictly scope input to DataDome's HTTPS CAPTCHA document. */
export function isDataDomeFrameUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const hostname = parsed.hostname.toLowerCase();
    const dataDomeHost = hostname === "captcha-delivery.com" || hostname.endsWith(".captcha-delivery.com");
    return dataDomeHost && parsed.pathname.startsWith("/captcha/");
  } catch {
    return false;
  }
}

/** A rectangle inside a frame, in the frame's own viewport, moved into top-level page coordinates. */
export function frameRectToPage(frameOwner: Rect, inner: Rect): Rect {
  return { x: frameOwner.x + inner.x, y: frameOwner.y + inner.y, width: inner.width, height: inner.height };
}

export function rectContains(outer: Rect, inner: Rect, tolerance = 1): boolean {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

/** Minimum-jerk profile: the velocity curve of a deliberate human reach. */
function minimumJerk(progress: number): number {
  return progress ** 3 * (10 - 15 * progress + 6 * progress * progress);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A human-like drag of `handle` until its center is over `target`'s center: hover onto the
 * handle, press, accelerate and decelerate along the track with a small vertical wander,
 * overshoot by a few pixels, settle back (staying past the end), pause, release. Returns
 * undefined when the geometry does not describe a slide to the right.
 */
export function sliderDragSteps(handle: Rect, target: Rect, random: RandomSource = Math.random): MouseStep[] | undefined {
  const distance = (target.x + target.width / 2) - (handle.x + handle.width / 2);
  if (!(handle.width > 0 && handle.height > 0 && distance > handle.width / 2)) return undefined;
  const press = {
    x: handle.x + handle.width / 2 + between(random, -1, 1) * Math.min(6, handle.width / 4),
    y: handle.y + handle.height / 2 + between(random, -1, 1) * Math.min(4, handle.height / 4),
  };
  const steps = approachSteps(press, random, { steps: Math.round(between(random, 8, 13)), delayMs: [10, 28] });
  steps[steps.length - 1]!.delayMs = between(random, 80, 200);
  steps.push({ type: "mousePressed", ...press, buttons: 1, delayMs: between(random, 90, 190) });

  const end = press.x + distance;
  const overshoot = between(random, 3, 9);
  const peak = end + overshoot;
  const moves = Math.round(between(random, 26, 40));
  const duration = between(random, 600, 1_200);
  const wander = Math.min(2.5, handle.height / 4);
  let x = press.x;
  let y = press.y;
  for (let move = 1; move <= moves; move += 1) {
    const base = press.x + (peak - press.x) * minimumJerk(move / moves);
    x = move === moves ? peak : clamp(base + between(random, -0.6, 0.6), x, peak);
    y = clamp(y + between(random, -0.8, 0.8), press.y - wander, press.y + wander);
    steps.push({ type: "mouseMoved", x, y, buttons: 1, delayMs: (duration / moves) * between(random, 0.7, 1.3) });
  }

  const release = end + between(random, 0.5, overshoot - 2);
  const settles = Math.round(between(random, 2, 4));
  for (let settle = 1; settle <= settles; settle += 1) {
    x = peak + (release - peak) * (settle / settles);
    y = clamp(y + between(random, -0.5, 0.5), press.y - wander, press.y + wander);
    steps.push({ type: "mouseMoved", x, y, buttons: 1, delayMs: between(random, 25, 60) });
  }
  steps[steps.length - 1]!.delayMs = between(random, 60, 150);
  steps.push({ type: "mouseReleased", x: release, y, buttons: 0, delayMs: 0 });
  return steps;
}

export interface DataDomeSliderWidget {
  /** `simple` is slide-to-end; anything else needs an image gap and is not touched. */
  mode: "simple" | "puzzle";
  state: "ready" | "solved" | "resetting";
  /** Handle and target in the coordinate space of the session that read them. */
  handle?: Rect;
  target?: Rect;
}

async function frameDocumentNodeId(send: CdpSend, sessionId: string, sameProcessFrameId: string | undefined): Promise<number | undefined> {
  if (sameProcessFrameId === undefined) {
    const document = await send("DOM.getDocument", { depth: 0 }, sessionId);
    return typeof document?.root?.nodeId === "number" ? document.root.nodeId : undefined;
  }
  // An in-process frame's document hangs off its owner element in the page's pierced DOM.
  const document = await send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  let found: number | undefined;
  const visit = (node: any) => {
    if (found !== undefined || !node || typeof node !== "object") return;
    if (node.frameId === sameProcessFrameId && typeof node.contentDocument?.nodeId === "number") {
      found = node.contentDocument.nodeId;
      return;
    }
    for (const children of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : undefined]) {
      if (Array.isArray(children)) for (const child of children) visit(child);
    }
  };
  visit(document?.root);
  return found;
}

/**
 * Reads DataDome's slider through DOM-domain commands only: they run in the renderer
 * without evaluating anything in the widget's JavaScript realm. Pass `sameProcessFrameId`
 * when `sessionId` is the page's session and the frame renders in the page's process;
 * quads are then already in top-level coordinates.
 */
export async function readDataDomeSlider(send: CdpSend, sessionId: string, sameProcessFrameId?: string): Promise<DataDomeSliderWidget | undefined> {
  const root = await frameDocumentNodeId(send, sessionId, sameProcessFrameId);
  if (root === undefined) return undefined;
  const query = async (selector: string): Promise<number | undefined> => {
    const result = await send("DOM.querySelector", { nodeId: root, selector }, sessionId).catch(() => undefined);
    return typeof result?.nodeId === "number" && result.nodeId > 0 ? result.nodeId : undefined;
  };
  const classes = async (nodeId: number): Promise<string[]> => {
    const result = await send("DOM.getAttributes", { nodeId }, sessionId).catch(() => undefined);
    return (attributeValue(result?.attributes, "class") ?? "").split(/\s+/).filter(Boolean);
  };
  const rect = async (nodeId: number | undefined): Promise<Rect | undefined> => {
    if (nodeId === undefined) return undefined;
    const result = await send("DOM.getBoxModel", { nodeId }, sessionId).catch(() => undefined);
    return rectFromQuad(result?.model?.border);
  };

  const frame = await query("#captcha__frame");
  const container = await query(".sliderContainer");
  if (frame === undefined || container === undefined) return undefined;
  const mode = (await classes(frame)).includes("simple") ? "simple" : "puzzle";
  const containerClasses = await classes(container);
  const state = containerClasses.includes("slider-success")
    ? "solved"
    : containerClasses.includes("slider-error") ? "resetting" : "ready";
  if (state !== "ready" || mode !== "simple") return { mode, state };
  // DataDome scrolls inside its own frame on short viewports; bring the track into view first.
  await send("DOM.scrollIntoViewIfNeeded", { nodeId: container }, sessionId).catch(() => undefined);
  const handle = await rect(await query(".slider"));
  const target = await rect(await query(".sliderTarget"));
  return { mode, state, ...(handle ? { handle } : {}), ...(target ? { target } : {}) };
}

async function layoutViewport(send: CdpSend, sessionId: string): Promise<Rect | undefined> {
  const metrics = await send("Page.getLayoutMetrics", {}, sessionId).catch(() => undefined);
  const viewport = metrics?.cssLayoutViewport;
  if (typeof viewport?.clientWidth !== "number" || typeof viewport?.clientHeight !== "number") return undefined;
  return { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight };
}

export function dataDomeSliderHandler(budget: { timeoutMs: number }): ChallengeHandler {
  return {
    kind: "datadome",
    actionEvent: "slid",
    policy: { ...DATADOME_SLIDER_POLICY, timeoutMs: budget.timeoutMs },
    matchesFrameUrl: isDataDomeFrameUrl,
    act: (context, box: ChallengeFrameBox) => context.withFrameSession(box, async (frameSessionId) => {
      if (frameSessionId === undefined && box.frameId === undefined) return "waiting";
      const widget = await readDataDomeSlider(context.send, frameSessionId ?? context.pageSessionId, frameSessionId ? undefined : box.frameId);
      if (!widget) return "waiting";
      if (widget.state === "solved") return "solved";
      if (widget.mode !== "simple") return "unsupported";
      if (widget.state !== "ready" || !widget.handle || !widget.target) return "waiting";
      const offset = frameSessionId ? box : { x: 0, y: 0, width: 0, height: 0 };
      const handle = frameRectToPage(offset, widget.handle);
      const target = frameRectToPage(offset, widget.target);
      // The whole track must be inside the visible iframe and the page viewport; input
      // never lands outside the validated DataDome frame.
      const viewport = await layoutViewport(context.send, context.pageSessionId);
      if (!viewport || ![handle, target].every((rect) => rectContains(box, rect) && rectContains(viewport, rect))) return "waiting";
      const steps = sliderDragSteps(handle, target);
      if (!steps) return "unsupported";
      // The widget records document.hasFocus() with every move it sees.
      const sessions = frameSessionId ? [context.pageSessionId, frameSessionId] : [context.pageSessionId];
      await withEmulatedFocus(context.send, sessions, () => dispatchMouseSteps(context.send, context.pageSessionId, steps));
      return "acted";
    }),
  };
}
