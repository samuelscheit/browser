import type { ResolvedRef, TaskBrowser } from "./browser";
import { parseChord } from "./keys";
import { pageText } from "./observation";
import { assignValue, callExpression, chooseOptions, coveringElement, editKind, scrollDocument, scrollState, selectContents } from "./page-script";
import type { Secrets, UploadPolicy } from "./safety";

export interface ActionContext {
  browser: TaskBrowser;
  secrets: Secrets;
  uploads: UploadPolicy;
}

type Args = Record<string, unknown>;

export class ActionError extends Error {}

function string(args: Args, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new ActionError(`missing argument ${name}`);
    return undefined;
  }
  if (typeof value !== "string") throw new ActionError(`argument ${name} must be a string`);
  return value;
}

function number(args: Args, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ActionError(`argument ${name} must be a number`);
  return value;
}

interface Point { x: number; y: number }

/**
 * Scroll the element into view (ancestor frames first) and return its center in top-level page
 * coordinates. Content quads are relative to the session's local root (in-process child frames
 * included); an OOPIF session adds its <iframe>'s offset.
 */
async function locate(context: ActionContext, ref: ResolvedRef): Promise<Point> {
  return (await locateBox(context, ref)).page;
}

/** The click point in page coordinates, and in the ref session's local-root coordinates (`local`). */
async function locateBox(context: ActionContext, ref: ResolvedRef): Promise<{ page: Point; local: Point }> {
  const { browser } = context;
  const offset = await browser.frameOffset(ref.tab, ref.session);
  await browser.send("DOM.scrollIntoViewIfNeeded", { objectId: ref.objectId }, ref.session.sessionId).catch(() => undefined);
  const { quads } = await browser.send("DOM.getContentQuads", { objectId: ref.objectId }, ref.session.sessionId).catch(() => ({ quads: [] })) as { quads: number[][] };
  const area = (quad: number[]) => Math.abs((quad[2]! - quad[0]!) * (quad[5]! - quad[1]!));
  const quad = quads.filter((candidate) => candidate.length === 8 && area(candidate) > 0.5).sort((left, right) => area(right) - area(left))[0];
  if (!quad) throw new ActionError("the element has no visible box (hidden, zero-size or detached)");
  const local = { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
  const page = { x: local.x + offset.x, y: local.y + offset.y };
  const { cssLayoutViewport } = await browser.send("Page.getLayoutMetrics", {}, ref.tab.sessionId) as { cssLayoutViewport: { clientWidth: number; clientHeight: number } };
  if (page.x < 0 || page.y < 0 || page.x > cssLayoutViewport.clientWidth || page.y > cssLayoutViewport.clientHeight) {
    throw new ActionError("the element is outside the visible viewport even after scrolling");
  }
  return { page, local };
}

async function mouseClick(context: ActionContext, point: Point): Promise<void> {
  const { browser } = context;
  const sessionId = browser.active.sessionId;
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 }, sessionId);
  await browser.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 }, sessionId);
  await browser.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, sessionId);
}

/** Trusted click at the center of the element's largest box; refuses when something else would receive it. */
async function clickRef(context: ActionContext, ref: ResolvedRef, force: boolean): Promise<void> {
  const { page, local } = await locateBox(context, ref);
  if (!force) {
    const cover = await context.browser.callOn<string | null>(ref, coveringElement, await context.browser.nodeAt(ref, local) ?? null);
    if (cover) throw new ActionError(`the element is covered by ${cover}; close or scroll past it first (or click with force=true)`);
  }
  await mouseClick(context, page);
}

async function pressChord(context: ActionContext, chord: string): Promise<void> {
  const { modifiers, modifierKeys, key } = parseChord(chord);
  const sessionId = context.browser.active.sessionId;
  const event = (type: string, definition: typeof key, mods: number) => context.browser.send("Input.dispatchKeyEvent", {
    type, modifiers: mods, key: definition.key, code: definition.code,
    windowsVirtualKeyCode: definition.keyCode, nativeVirtualKeyCode: definition.keyCode,
    ...(type === "keyDown" && definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
  }, sessionId);
  let held = 0;
  for (const modifier of modifierKeys) {
    held |= modifiers & (modifier.key === "Alt" ? 1 : modifier.key === "Control" ? 2 : modifier.key === "Meta" ? 4 : 8);
    await event("rawKeyDown", modifier, held);
  }
  await event(key.text ? "keyDown" : "rawKeyDown", key, modifiers);
  await event("keyUp", key, modifiers);
  for (const modifier of [...modifierKeys].reverse()) await event("keyUp", modifier, 0);
}

async function navigated<T>(context: ActionContext, run: () => Promise<T>): Promise<string> {
  const tab = context.browser.active;
  const before = tab.navigations;
  await run();
  await context.browser.settle();
  const now = context.browser.active;
  if (now !== tab) return "a new tab is now active";
  return tab.navigations !== before ? "the page navigated" : "";
}

const join = (...parts: string[]) => parts.filter(Boolean).join("; ");

function safeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ActionError(`invalid URL ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.href !== "about:blank") throw new ActionError("only http(s) URLs can be opened");
  return url.href;
}

async function currentValue(context: ActionContext, ref: ResolvedRef): Promise<string> {
  return context.browser.callOn<string>(ref, function (this: Element) {
    const element = this as HTMLInputElement;
    if (element.type === "password") return element.value ? "(password entered)" : "";
    return "value" in element ? String(element.value) : (element as unknown as HTMLElement).innerText;
  });
}

/** Browser actions the model can call; each returns a short outcome for the model. */
export const ACTIONS: Record<string, (context: ActionContext, args: Args) => Promise<string>> = {
  async navigate(context, args) {
    const url = safeUrl(string(args, "url")!);
    const outcome = await navigated(context, async () => {
      const result = await context.browser.send("Page.navigate", { url }, context.browser.active.sessionId, 30_000) as { errorText?: string };
      if (result.errorText) throw new ActionError(`navigation failed: ${result.errorText}`);
    });
    return join(`opened ${url}`, outcome === "the page navigated" ? "" : outcome);
  },

  async back(context) {
    const sessionId = context.browser.active.sessionId;
    const history = await context.browser.send("Page.getNavigationHistory", {}, sessionId) as { currentIndex: number; entries: { id: number; url: string }[] };
    const entry = history.entries[history.currentIndex - 1];
    if (!entry) throw new ActionError("there is no previous page in this tab");
    await navigated(context, () => context.browser.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId));
    return `went back to ${entry.url}`;
  },

  async click(context, args) {
    const ref = string(args, "ref")!;
    const resolved = await context.browser.resolveRef(ref);
    const outcome = await navigated(context, () => clickRef(context, resolved, args.force === true));
    return join(`clicked ${ref}`, outcome);
  },

  async type(context, args) {
    const ref = string(args, "ref")!;
    const raw = string(args, "text")!;
    const text = context.secrets.resolve(raw);
    const resolved = await context.browser.resolveRef(ref);
    const kind = await context.browser.callOn<string>(resolved, editKind);
    if (kind === "select") throw new ActionError(`${ref} is a <select>; use select`);
    if (kind === "file") throw new ActionError(`${ref} is a file input; use upload`);
    if (kind === "none") throw new ActionError(`${ref} is not a text field`);
    if (kind === "value") {
      const assigned = await context.browser.callOn<{ ok: boolean; value: string }>(resolved, assignValue, text);
      if (!assigned.ok) throw new ActionError(`the field rejected the value (check its format); it is still ${JSON.stringify(assigned.value)}`);
    } else {
      // Focus with a trusted click, as a person would; fall back to focus() when it is covered.
      await clickRef(context, resolved, false).catch(() => context.browser.callOn(resolved, function (this: HTMLElement) { this.focus(); }));
      if (args.clear !== false) await context.browser.callOn(resolved, selectContents);
      if (text) await context.browser.send("Input.insertText", { text }, context.browser.active.sessionId);
      else if (args.clear !== false) await pressChord(context, "Backspace");
    }
    let outcome = "";
    if (args.submit === true) outcome = await navigated(context, () => pressChord(context, "Enter"));
    else await context.browser.settle();
    const value = outcome ? "" : await currentValue(context, resolved).catch(() => "");
    const shown = context.secrets.hasPlaceholder(raw) ? "(secret entered)" : JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
    return join(`typed into ${ref}`, value || context.secrets.hasPlaceholder(raw) ? `its value is now ${shown}` : "", args.submit === true ? "pressed Enter" : "", outcome);
  },

  async select(context, args) {
    const ref = string(args, "ref")!;
    const raw = args.values ?? args.value;
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : undefined;
    if (!values?.length) throw new ActionError("missing argument value");
    const resolved = await context.browser.resolveRef(ref);
    if (await context.browser.callOn<string>(resolved, editKind) !== "select") throw new ActionError(`${ref} is not a native <select>; click it and then click the option`);
    const result = await context.browser.callOn<{ ok: boolean; selected: string[]; available: string[] }>(resolved, chooseOptions, values);
    if (!result.ok) throw new ActionError(`no matching option for ${JSON.stringify(values)}; options: ${result.available.join(" | ")}`);
    const outcome = await navigated(context, async () => undefined);
    return join(`selected ${result.selected.map((value) => JSON.stringify(value)).join(", ")} in ${ref}`, outcome);
  },

  async press(context, args) {
    const key = string(args, "key")!;
    const outcome = await navigated(context, () => pressChord(context, key));
    return join(`pressed ${key}`, outcome);
  },

  async scroll(context, args) {
    const direction = string(args, "direction", false) ?? "down";
    if (!["up", "down", "left", "right"].includes(direction)) throw new ActionError("direction must be up, down, left or right");
    const screens = number(args, "amount") ?? 0.8;
    const { browser } = context;
    const sessionId = browser.active.sessionId;
    const { cssLayoutViewport } = await browser.send("Page.getLayoutMetrics", {}, sessionId) as { cssLayoutViewport: { clientWidth: number; clientHeight: number } };
    const vertical = direction === "up" || direction === "down";
    const distance = Math.round((vertical ? cssLayoutViewport.clientHeight : cssLayoutViewport.clientWidth) * screens * (direction === "up" || direction === "left" ? -1 : 1));
    const [dx, dy] = vertical ? [0, distance] : [distance, 0];
    const ref = string(args, "ref", false);
    const world = await browser.mainWorld(browser.active);
    // The page itself scrolls directly; a wheel at a point would move whatever scroll area is under it.
    const movedDocument = !ref && await browser.evaluate<boolean>(sessionId, world, callExpression(scrollDocument, dx, dy));
    if (!movedDocument) {
      const point = ref ? await locate(context, await browser.resolveRef(ref)) : { x: cssLayoutViewport.clientWidth / 2, y: cssLayoutViewport.clientHeight / 2 };
      await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: dx, deltaY: dy }, sessionId);
      await Bun.sleep(300);
    }
    await browser.settle();
    const state = await browser.evaluate<{ scrollY: number; scrollHeight: number; viewportHeight: number }>(sessionId, await browser.mainWorld(browser.active), callExpression(scrollState));
    return `scrolled ${direction}${ref ? ` inside ${ref}` : ""}; page now shows ${state.scrollY}-${state.scrollY + state.viewportHeight}px of ${state.scrollHeight}px`;
  },

  async upload(context, args) {
    const ref = string(args, "ref")!;
    const raw = args.paths ?? args.path;
    const paths = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
    if (!paths.length) throw new ActionError("missing argument path");
    const files = paths.map((path) => {
      try {
        return context.uploads.check(path);
      } catch (error) {
        throw new ActionError(error instanceof Error ? error.message : String(error));
      }
    });
    const resolved = await context.browser.resolveRef(ref);
    if (await context.browser.callOn<string>(resolved, editKind) !== "file") throw new ActionError(`${ref} is not a file input`);
    await context.browser.send("DOM.setFileInputFiles", { files, objectId: resolved.objectId }, resolved.session.sessionId);
    await context.browser.settle();
    return `attached ${files.map((file) => file.split(/[\\/]/).pop()).join(", ")} to ${ref}`;
  },

  async wait(context, args) {
    const text = string(args, "text", false);
    const seconds = Math.min(Math.max(number(args, "seconds") ?? (text ? 10 : 1), 0), 30);
    if (!text) {
      await Bun.sleep(seconds * 1_000);
      await context.browser.settle();
      return `waited ${seconds}s`;
    }
    const deadline = Date.now() + seconds * 1_000;
    const wanted = text.toLowerCase();
    while (true) {
      const content = await pageText(context.browser, 500_000).catch(() => "");
      if (content.toLowerCase().includes(wanted)) return `the text ${JSON.stringify(text)} is on the page`;
      if (Date.now() >= deadline) throw new ActionError(`the text ${JSON.stringify(text)} did not appear within ${seconds}s`);
      await Bun.sleep(300);
    }
  },
};
