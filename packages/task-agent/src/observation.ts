import type { TaskBrowser, Tab } from "./browser";
import { callExpression, frameText, snapshotFrame, type RawElement, type RawFrameSnapshot } from "./page-script";

export interface ObservationOptions {
  /** Character budget of the whole observation text (roughly 4 characters per token). */
  maxChars: number;
  screenshot: boolean;
}

export interface Observation {
  url: string;
  title: string;
  /** What the model reads. */
  text: string;
  elementCount: number;
  omittedElements: number;
  frameCount: number;
  /** Base64 JPEG of the viewport, when screenshots are on. */
  screenshot?: string;
}

interface FrameEntry {
  ordinal: number;
  sessionId: string;
  frameId: string;
  loaderId: string;
  crossProcess: boolean;
}

interface FrameSnapshot extends FrameEntry {
  snapshot: RawFrameSnapshot;
}

const MAX_FRAMES = 20;
const MAX_ELEMENTS_PER_FRAME = 1_500;

type CdpFrameTree = { frame: { id: string; loaderId: string; url: string; parentId?: string }; childFrames?: CdpFrameTree[] };

/** Every frame of the tab: those in each session's own frame tree; OOPIFs come from their session. */
async function listFrames(browser: TaskBrowser, tab: Tab): Promise<FrameEntry[]> {
  const frames: FrameEntry[] = [];
  const seen = new Set<string>();
  const ordinalOf = (frameId: string): number => {
    let ordinal = tab.frameOrdinals.get(frameId);
    if (ordinal === undefined) {
      ordinal = tab.frameOrdinals.size;
      tab.frameOrdinals.set(frameId, ordinal);
    }
    return ordinal;
  };
  // A parent's frame tree may list an OOPIF too; only the OOPIF's own session can read it.
  const sessions = [...tab.sessions.values()];
  const oopifSession = new Map(sessions.filter((session) => session.parentSessionId).map((session) => [session.targetId, session.sessionId]));
  for (const session of sessions) {
    const tree = await browser.send("Page.getFrameTree", {}, session.sessionId).then((result) => result.frameTree as CdpFrameTree).catch(() => undefined);
    if (!tree) continue;
    const visit = (node: CdpFrameTree) => {
      const owner = oopifSession.get(node.frame.id);
      if (owner !== undefined && owner !== session.sessionId) return;
      if (!seen.has(node.frame.id)) {
        seen.add(node.frame.id);
        frames.push({ ordinal: ordinalOf(node.frame.id), sessionId: session.sessionId, frameId: node.frame.id, loaderId: node.frame.loaderId, crossProcess: owner !== undefined });
      }
      for (const child of node.childFrames ?? []) visit(child);
    };
    visit(tree);
  }
  return frames;
}

async function snapshotFrames(browser: TaskBrowser, tab: Tab, maxChars: number): Promise<FrameSnapshot[]> {
  const frames = (await listFrames(browser, tab)).slice(0, MAX_FRAMES);
  const results: FrameSnapshot[] = [];
  const refFrames = new Map<number, { sessionId: string; contextId: number }>();
  for (const frame of frames) {
    try {
      const contextId = await browser.world(tab, frame.sessionId, frame.frameId, frame.loaderId);
      const textChars = frame.ordinal === 0 ? Math.max(500, Math.floor(maxChars * 0.3)) : 600;
      const snapshot = await browser.evaluate<RawFrameSnapshot>(frame.sessionId, contextId, callExpression(snapshotFrame, { maxElements: MAX_ELEMENTS_PER_FRAME, textChars }));
      refFrames.set(frame.ordinal, { sessionId: frame.sessionId, contextId });
      results.push({ ...frame, snapshot });
    } catch {
      // A frame that navigated away mid-snapshot, or one in another session: skipped this time.
    }
  }
  tab.refFrames = refFrames;
  return results;
}

const quote = (text: string) => JSON.stringify(text);

export function formatElement(prefix: string, element: RawElement): string {
  const parts = [`[${prefix}e${element.id}]`, element.role];
  if (element.name) parts.push(quote(element.name));
  if (element.value !== undefined && element.value !== "") parts.push(`value=${quote(element.value)}`);
  parts.push(...element.states);
  if (element.options) parts.push(`options=${quote(element.options.join(" | "))}`);
  if (element.href) parts.push(`→ ${element.href}`);
  if (element.distance > 0) parts.push(`(${element.distance} screen${element.distance > 1 ? "s" : ""} away)`);
  return parts.join(" ");
}

/**
 * Keep the elements nearest the visible area within the budget, then print them in document
 * order, frame by frame.
 */
function renderElements(frames: readonly FrameSnapshot[], budget: number): { lines: string[]; shown: number; omitted: number } {
  const all = frames.flatMap((frame, frameIndex) => frame.snapshot.elements.map((element, order) => ({
    frameIndex, order, element, line: formatElement(frame.ordinal ? `f${frame.ordinal}` : "", element),
  })));
  const ranked = [...all].sort((left, right) => left.element.distance - right.element.distance || left.frameIndex - right.frameIndex || left.order - right.order);
  const kept = new Set<(typeof all)[number]>();
  let used = 0;
  for (const entry of ranked) {
    if (used + entry.line.length + 1 > budget) break;
    used += entry.line.length + 1;
    kept.add(entry);
  }
  const lines: string[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const entries = all.filter((entry) => entry.frameIndex === frameIndex && kept.has(entry));
    if (frame.ordinal !== 0) {
      lines.push(`-- frame f${frame.ordinal}${frame.crossProcess ? " (cross-origin)" : ""} ${frame.snapshot.url}${frame.snapshot.title ? ` ${quote(frame.snapshot.title)}` : ""}${entries.length ? "" : ": no interactive elements"}`);
    }
    lines.push(...entries.map((entry) => entry.line));
  }
  const capped = frames.reduce((sum, frame) => sum + frame.snapshot.total - frame.snapshot.elements.length, 0);
  return { lines, shown: kept.size, omitted: all.length - kept.size + capped };
}

/** Observe the active tab: a compact, indexed list of interactive elements plus visible text. */
export async function observe(browser: TaskBrowser, options: ObservationOptions, notices: readonly string[] = []): Promise<Observation> {
  const tab = browser.active;
  const frames = await snapshotFrames(browser, tab, options.maxChars);
  const main = frames.find((frame) => frame.ordinal === 0)?.snapshot;
  const url = main?.url ?? "about:blank";
  const title = main?.title ?? "";
  const header = [`URL: ${url}`, `Title: ${title || "(none)"}`];
  if (main) {
    const bottom = main.scrollY + main.viewportHeight;
    header.push(`Scroll: showing ${main.scrollY}-${bottom}px of ${main.scrollHeight}px${bottom < main.scrollHeight - 2 ? " (more below)" : ""}`);
  } else header.push("The page could not be read (it may still be loading, or it is a browser-internal page).");
  for (const notice of notices) header.push(`Notice: ${notice}`);

  const textParts = frames.filter((frame) => frame.snapshot.text).map((frame) => frame.ordinal === 0 ? frame.snapshot.text : `[frame f${frame.ordinal}] ${frame.snapshot.text}`);
  const textBudget = Math.max(400, Math.floor(options.maxChars * 0.3));
  let text = textParts.join("\n");
  if (text.length > textBudget) text = `${text.slice(0, textBudget - 1)}…`;
  const headerChars = header.join("\n").length;
  const elementBudget = Math.max(500, options.maxChars - headerChars - text.length - 120);
  const elements = renderElements(frames, elementBudget);

  const sections = [
    ...header,
    "",
    `Interactive elements (${elements.shown}${elements.omitted ? `, ${elements.omitted} more not shown: scroll or use extract` : ""}):`,
    ...(elements.lines.length ? elements.lines : ["(none)"]),
    "",
    "Page text (excerpt):",
    text || "(none)",
  ];
  let screenshot: string | undefined;
  if (options.screenshot) {
    screenshot = await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, tab.sessionId, 15_000)
      .then((result) => result.data as string).catch(() => undefined);
  }
  return {
    url, title, text: sections.join("\n"), elementCount: elements.shown, omittedElements: elements.omitted, frameCount: frames.length,
    ...(screenshot ? { screenshot } : {}),
  };
}

/** The whole readable text of the active tab (all frames), bounded, for extraction. */
export async function pageText(browser: TaskBrowser, maxChars: number): Promise<string> {
  const tab = browser.active;
  const frames = (await listFrames(browser, tab)).slice(0, MAX_FRAMES);
  const parts: string[] = [];
  let remaining = maxChars;
  for (const frame of frames) {
    if (remaining <= 0) break;
    try {
      const contextId = await browser.world(tab, frame.sessionId, frame.frameId, frame.loaderId);
      const text = await browser.evaluate<string>(frame.sessionId, contextId, callExpression(frameText, remaining));
      if (!text) continue;
      parts.push(frame.ordinal === 0 ? text : `[frame f${frame.ordinal}]\n${text}`);
      remaining -= text.length;
    } catch { /* skipped frame */ }
  }
  return parts.join("\n\n");
}
