/**
 * reCAPTCHA v2 token fallback of the CAPTCHA guardian. llm-captcha passes Turnstile reliably but
 * reCAPTCHA v2 image grids only rarely (live, claude-opus-5-5: Turnstile 5/5, reCAPTCHA forms 0-2/5;
 * it also ended sessions `idle` with the widget under a cookie banner, and `solved` with an empty
 * response). So whenever a visible reCAPTCHA v2 widget still has no response after a session, and
 * the recipe enables a token provider, the guardian buys one token for the page document and injects
 * it.
 *
 * The probe runs in an isolated world of the guardian's own, which page scripts cannot observe, and
 * returns only scalar facts. The token travels as a JSON string literal inside the injection call and
 * is never returned, logged, or stored.
 */

import { CaptchaSolverError, isCaptchaSitekey, type TokenCaptchaSolver } from "./types";

/** One CDP command on the page's top-level session. */
export type PageSend = (method: string, params?: Record<string, unknown>) => Promise<any>;

const WORLD = "fabric-recaptcha";
/** How long a bought token waits for reCAPTCHA to create its response field. */
const FILL_FIELD_WAIT_MS = 5_000;
const FILL_FIELD_POLL_MS = 150;

/**
 * The first visible reCAPTCHA v2 checkbox widget whose response field is empty: its public sitekey,
 * or null when the document shows none.
 *
 * Every rendered v2 checkbox is an `api2/anchor` iframe (www.google.com or www.recaptcha.net) with its
 * sitekey in `k` and its size in `size`, next to the widget's `g-recaptcha-response` textarea. That
 * holds however the page rendered it: `.g-recaptcha[data-sitekey]` markup, or `grecaptcha.render()`
 * into any container (newfold.com/abuse renders into `div#captcha`, with no `.g-recaptcha` at all).
 * The invisible variant (`size=invisible`) and Enterprise (`enterprise/anchor`) are left alone. Below
 * the fold counts as visible: llm-captcha scrolls a widget into view, a token needs no view at all.
 */
export const RECAPTCHA_V2_PROBE_SCRIPT = `(() => {
  for (const anchor of Array.from(document.querySelectorAll('iframe[src*="/recaptcha/api2/anchor"]'))) {
    let url;
    try { url = new URL(anchor.src); } catch { continue; }
    if (String(url.searchParams.get('size') || '').toLowerCase() === 'invisible') continue;
    const rect = anchor.getBoundingClientRect();
    if (!anchor.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || rect.width < 10 || rect.height < 10) continue;
    const sitekey = String(url.searchParams.get('k') || '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(sitekey)) continue;
    // The widget is the nearest ancestor holding a response field; api.js adds it next to the frame.
    let response = null;
    for (let node = anchor.parentElement, depth = 0; node && !response && depth < 6; node = node.parentElement, depth += 1) {
      response = node.querySelector('textarea[name="g-recaptcha-response"]');
    }
    // The probe never returns the response itself, only whether one is present.
    if (!!response && String(response.value || '').trim().length > 0) continue;
    return { sitekey };
  }
  return null;
})()`;

/**
 * Fills every reCAPTCHA response field. Runs in the guardian's isolated world, which can write the DOM
 * but cannot reach the page's own `data-callback` global, so the callback is invoked separately in the
 * main world.
 */
export function recaptchaFillScript(token: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    const fields = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"]'));
    if (fields.length === 0) return false;
    for (const field of fields) {
      field.value = token;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return fields.every((field) => field.value === token);
  })()`;
}

/**
 * Calls the success callback the page gave the widget, in the page's main world where it lives. The
 * callback is either a function passed to `grecaptcha.render()` (newfold.com/abuse passes an inline
 * one) or the name of a global, from `data-callback` or a string `callback` option. Both are found in
 * reCAPTCHA's own registry `___grecaptcha_cfg.clients`, on the parameters object whose `sitekey` is
 * the widget's; `data-callback` of the widget's element is read as well. Each callback runs once. A
 * name is only looked up on `window`, never evaluated. Returns how many callbacks ran.
 */
export function recaptchaCallbackScript(token: string, sitekey: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    const sitekey = ${JSON.stringify(sitekey)};
    const found = new Set();
    const add = (callback) => {
      if (typeof callback === 'function') found.add(callback);
      else if (typeof callback === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback) && typeof window[callback] === 'function') found.add(window[callback]);
    };
    const seen = new Set();
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 5 || seen.has(value) || value instanceof Node || value === window) return;
      seen.add(value);
      let keys;
      try { keys = Object.keys(value); } catch { return; }
      if (value.sitekey === sitekey && 'callback' in value) add(value.callback);
      for (const key of keys) {
        let child;
        try { child = value[key]; } catch { continue; }
        visit(child, depth + 1);
      }
    };
    const clients = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    if (clients && typeof clients === 'object') for (const key of Object.keys(clients)) visit(clients[key], 0);
    for (const element of Array.from(document.querySelectorAll('[data-sitekey][data-callback]'))) {
      if (element.getAttribute('data-sitekey') === sitekey) add(element.getAttribute('data-callback'));
    }
    for (const callback of found) {
      try { callback(token); } catch {}
    }
    return found.size;
  })()`;
}

/** A visible reCAPTCHA v2 widget whose response field is still empty. */
export interface PendingRecaptcha {
  sitekey: string;
}

/** Creates the guardian's isolated world in the page's current top-level document. */
export async function recaptchaWorld(send: PageSend): Promise<number | undefined> {
  const tree = await send("Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== "string") return undefined;
  const world = await send("Page.createIsolatedWorld", { frameId, worldName: WORLD });
  return typeof world?.executionContextId === "number" ? world.executionContextId : undefined;
}

async function evaluate(send: PageSend, expression: string, contextId?: number): Promise<unknown> {
  const answer = await send("Runtime.evaluate", { expression, returnByValue: true, ...(contextId === undefined ? {} : { contextId }) });
  if (answer?.exceptionDetails) throw new Error("reCAPTCHA page script failed");
  return answer?.result?.value;
}

/** The unsolved widget the document shows, if any. Throws when the world is gone (the caller makes a new one). */
export async function probePendingRecaptcha(send: PageSend, contextId: number): Promise<PendingRecaptcha | undefined> {
  const probe = await evaluate(send, RECAPTCHA_V2_PROBE_SCRIPT, contextId) as { sitekey?: unknown } | null | undefined;
  return probe && isCaptchaSitekey(probe.sitekey) ? { sitekey: probe.sitekey } : undefined;
}

export type RecaptchaTokenOutcome = { outcome: "injected" } | { outcome: "failed"; error: string };

/**
 * Buys one token for the widget and hands it to the page. The caller runs this at most once per page
 * document; a provider failure is final for that document.
 */
export async function injectRecaptchaToken(input: { solver: TokenCaptchaSolver; send: PageSend; contextId: number; widget: PendingRecaptcha; pageUrl: string; signal: AbortSignal }): Promise<RecaptchaTokenOutcome> {
  const { solver, send, contextId, widget, pageUrl, signal } = input;
  try {
    const token = await solver.solve({ sitekey: widget.sitekey, pageUrl }, signal);
    // reCAPTCHA creates its response field after the widget renders. Retry briefly: the token is paid for.
    const deadline = Date.now() + FILL_FIELD_WAIT_MS;
    while (await evaluate(send, recaptchaFillScript(token), contextId) !== true) {
      if (signal.aborted) throw new CaptchaSolverError("canceled", "CAPTCHA solve was canceled");
      if (Date.now() >= deadline) throw new CaptchaSolverError("unavailable", "reCAPTCHA response field was not present");
      await new Promise((resolve) => setTimeout(resolve, FILL_FIELD_POLL_MS));
    }
    await evaluate(send, recaptchaCallbackScript(token, widget.sitekey));
    return { outcome: "injected" };
  } catch (error) {
    // Provider errors carry only a stable failure class; CDP errors can echo page details.
    return { outcome: "failed", error: error instanceof CaptchaSolverError ? error.kind : "Error" };
  }
}
