/**
 * Page-side reCAPTCHA v2 discovery and token injection. The guardian runs these from its isolated world,
 * so page scripts cannot observe the probe. Discovery returns only scalar facts. The token travels as a
 * JSON string literal inside the injection call and is never returned, logged, or stored.
 */

/** Reads the public sitekey and state of an unsolved reCAPTCHA v2 widget. Returns null if none exists. */
export const RECAPTCHA_V2_PROBE_SCRIPT = `(() => {
  const widget = document.querySelector('.g-recaptcha[data-sitekey]');
  if (!widget) return null;
  const sitekey = String(widget.getAttribute('data-sitekey') || '');
  const response = document.querySelector('textarea[name="g-recaptcha-response"]');
  const callback = String(widget.getAttribute('data-callback') || '');
  return {
    sitekey: /^[A-Za-z0-9_-]{16,80}$/.test(sitekey) ? sitekey : '',
    // Only a plain global identifier may be invoked; anything else is ignored.
    callback: /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback) ? callback : '',
    solved: !!response && String(response.value || '').trim().length > 0,
    hasResponseField: !!response,
  };
})()`;

/**
 * Fills every reCAPTCHA response field. Runs in the guardian's isolated world, which can write the DOM but
 * cannot reach the page's own `data-callback` global, so the callback is invoked separately in the main world.
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
