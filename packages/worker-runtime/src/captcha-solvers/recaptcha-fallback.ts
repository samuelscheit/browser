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
 * The first visible, rendered reCAPTCHA v2 checkbox widget (api.js rendered its frame into it; the
 * invisible variant is left alone), its public sitekey, its callback name, and whether its response
 * field holds a token. Null when the document shows none.
 */
export const RECAPTCHA_V2_PROBE_SCRIPT = `(() => {
  for (const widget of Array.from(document.querySelectorAll('.g-recaptcha[data-sitekey]'))) {
    if (String(widget.getAttribute('data-size') || '').toLowerCase() === 'invisible') continue;
    const rect = widget.getBoundingClientRect();
    const shown = widget.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && rect.width >= 10 && rect.height >= 10;
    if (!shown || !widget.querySelector('iframe')) continue;
    const sitekey = String(widget.getAttribute('data-sitekey') || '');
    const callback = String(widget.getAttribute('data-callback') || '');
    const response = widget.querySelector('textarea[name="g-recaptcha-response"]') || document.querySelector('textarea[name="g-recaptcha-response"]');
    return {
      sitekey: /^[A-Za-z0-9_-]{16,80}$/.test(sitekey) ? sitekey : '',
      // Only a plain global identifier may be invoked; anything else is ignored.
      callback: /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback) ? callback : '',
      solved: !!response && String(response.value || '').trim().length > 0,
    };
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

/** Calls the widget's own data-callback global in the page's main world. The callback name is pre-validated. */
export function recaptchaCallbackScript(token: string, callback: string): string {
  return `(() => {
    const name = ${JSON.stringify(callback)};
    const invoke = name ? window[name] : undefined;
    if (typeof invoke !== 'function') return false;
    invoke(${JSON.stringify(token)});
    return true;
  })()`;
}

/** A visible reCAPTCHA v2 widget whose response field is still empty. */
export interface PendingRecaptcha {
  sitekey: string;
  callback: string;
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
  const probe = await evaluate(send, RECAPTCHA_V2_PROBE_SCRIPT, contextId) as { sitekey?: unknown; callback?: unknown; solved?: unknown } | null | undefined;
  if (!probe || probe.solved === true || !isCaptchaSitekey(probe.sitekey)) return undefined;
  return { sitekey: probe.sitekey, callback: typeof probe.callback === "string" ? probe.callback : "" };
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
    if (widget.callback) await evaluate(send, recaptchaCallbackScript(token, widget.callback));
    return { outcome: "injected" };
  } catch (error) {
    // Provider errors carry only a stable failure class; CDP errors can echo page details.
    return { outcome: "failed", error: error instanceof CaptchaSolverError ? error.kind : "Error" };
  }
}
