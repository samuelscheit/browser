import type { TurnstileChallengeBox, TurnstilePageObservation } from "./turnstile-guardian-types";

/**
 * The page-side part deliberately returns only scalar signals. It never returns
 * HTML, cookies, form values, or Turnstile response tokens. Trusted geometry is
 * collected separately through CDP DOM commands by the guardian core.
 */
export const TURNSTILE_OBSERVATION_SCRIPT = `(() => {
  const lower = (value) => String(value || '').toLowerCase();
  const title = document.title || '';
  // The bounded sample stays inside the renderer; only boolean marker results
  // leave this evaluation. It catches Cloudflare's managed-edge challenge page.
  const html = (document.documentElement?.innerHTML || '').slice(0, 262144);
  const titleMarkers = ['just a moment', 'checking your browser', 'please wait', 'attention required', 'verify you are human'];
  const htmlMarkers = ['cf_chl_opt', 'cf-chl-', 'cf-browser-verification', 'performing security verification', 'enable javascript and cookies to continue'];
  const signals = [];
  if (titleMarkers.some((marker) => lower(title).includes(marker))) signals.push('title-marker');
  if (htmlMarkers.some((marker) => lower(html).includes(marker))) signals.push('html-marker');

  const responseFields = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'));
  const responsePresent = responseFields.length > 0;
  // Inspect only an empty/non-empty predicate. The opaque token itself is never
  // serialized, returned, logged, or stored by the guardian.
  const responseValue = responsePresent && responseFields.every((field) => String(field.value || '').trim().length > 0);
  if (responsePresent) signals.push('turnstile-field');

  // Keep selectors vendor-specific. Bare data-sitekey also matches reCAPTCHA
  // and hCaptcha, which must never be clicked by this helper.
  const widgets = Array.from(document.querySelectorAll(
    '.cf-turnstile, [data-cf-turnstile], [data-cf-turnstile-sitekey], [data-turnstile-sitekey]'
  ));
  if (widgets.length > 0) signals.push('turnstile-widget');

  const turnstileScript = Array.from(document.querySelectorAll('script[src]')).some((script) => {
    const rawSrc = String(script.getAttribute('src') || '');
    try {
      const parsed = new URL(rawSrc, location.href);
      const hostname = lower(parsed.hostname);
      const path = lower(parsed.pathname + parsed.search);
      return (hostname === 'challenges.cloudflare.com' || hostname.endsWith('.challenges.cloudflare.com')) && path.includes('turnstile');
    } catch (_) {
      return false;
    }
  });
  if (turnstileScript) signals.push('turnstile-script');

  // This scans only open roots / ordinary DOM and contributes detection
  // evidence. CDP, not the page realm, supplies all click rectangles.
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const rawSrc = String(frame.getAttribute('src') || frame.src || '');
    try {
      const parsed = new URL(rawSrc, location.href);
      const hostname = lower(parsed.hostname);
      const path = lower(parsed.pathname + parsed.search);
      if ((hostname === 'challenges.cloudflare.com' || hostname.endsWith('.challenges.cloudflare.com'))
        && (path.includes('/turnstile/') || path.includes('turnstile'))) {
        signals.push('challenge-frame');
      }
    } catch (_) {
      // Ignore malformed or detached frames. The CDP frame tree retries later.
    }
  }

  const explicitChallenge = responsePresent || widgets.length > 0 || turnstileScript || signals.includes('html-marker') || signals.includes('challenge-frame');
  return {
    url: location.href,
    title,
    signals: Array.from(new Set(signals)),
    challenge: explicitChallenge && !responseValue,
    solved: responseValue,
    boxes: [],
  };
})()`;

/** Compatibility hint used by Cloudflare/Rebrowser event inspection. */
export const TURNSTILE_MOUSE_COMPAT_SCRIPT = `(() => {
  try {
    if (!Object.prototype.hasOwnProperty.call(MouseEvent.prototype, '__fabricTurnstileScreenPatch')) {
      Object.defineProperty(MouseEvent.prototype, 'screenX', {
        configurable: true,
        get() { return this.clientX + (window.screenX || 0); },
      });
      Object.defineProperty(MouseEvent.prototype, 'screenY', {
        configurable: true,
        get() { return this.clientY + (window.screenY || 0); },
      });
      Object.defineProperty(MouseEvent.prototype, '__fabricTurnstileScreenPatch', { value: true });
    }
  } catch (_) {
    // A hardened page may reject the prototype patch. Trusted CDP input still
    // remains useful, so do not fail the browser session for this hint.
  }
})()`;

type CdpFrame = { id?: unknown; url?: unknown; parentId?: unknown };
type CdpFrameTree = { frame?: CdpFrame; childFrames?: unknown };

/** Strictly scope input to Cloudflare's HTTPS Turnstile endpoint. */
export function isTurnstileFrameUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    const cloudflareHost = hostname === "challenges.cloudflare.com" || hostname.endsWith(".challenges.cloudflare.com");
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return cloudflareHost && (path.includes("/turnstile/") || path.includes("turnstile"));
  } catch {
    return false;
  }
}

export function childFrames(tree: unknown): CdpFrame[] {
  const result: CdpFrame[] = [];
  const visit = (candidate: unknown, includeCurrent: boolean) => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as CdpFrameTree;
    if (includeCurrent && record.frame) result.push(record.frame);
    if (Array.isArray(record.childFrames)) for (const child of record.childFrames) visit(child, true);
  };
  visit(tree, false);
  return result;
}

export function boxFromContentQuad(value: unknown, frameUrl: string, instanceId?: string): TurnstileChallengeBox | undefined {
  if (!Array.isArray(value) || value.length < 8 || value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) return undefined;
  const xs = value.filter((_, index) => index % 2 === 0) as number[];
  const ys = value.filter((_, index) => index % 2 === 1) as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height, frameUrl, ...(instanceId ? { instanceId } : {}) } : undefined;
}

export function attributeValue(attributes: unknown, name: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === name && typeof attributes[index + 1] === "string") return attributes[index + 1];
  }
  return undefined;
}

export function resolveTurnstileFrameUrl(rawUrl: unknown, documentUrl: string): string | undefined {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 2_048) return undefined;
  try {
    const resolved = new URL(rawUrl, documentUrl).toString();
    return isTurnstileFrameUrl(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Deduplicate the same physical iframe seen through DOM and frame-tree APIs. */
export function distinctBoxes(boxes: readonly TurnstileChallengeBox[]): TurnstileChallengeBox[] {
  const distinct: TurnstileChallengeBox[] = [];
  for (const box of boxes) {
    const duplicate = distinct.some((existing) => {
      const centerDistanceX = Math.abs((existing.x + existing.width / 2) - (box.x + box.width / 2));
      const centerDistanceY = Math.abs((existing.y + existing.height / 2) - (box.y + box.height / 2));
      return centerDistanceX <= 4
        && centerDistanceY <= 4
        && Math.abs(existing.width - box.width) <= 4
        && Math.abs(existing.height - box.height) <= 4;
    });
    if (!duplicate) distinct.push(box);
  }
  return distinct;
}

export function safeGuardianDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "url" || key === "frameUrl") {
      const location = safePageLocation(value);
      if (location !== undefined) safe[key] = location;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function safePageLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > 8_192) {
    const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1];
    return scheme ? scheme.toLowerCase() : "opaque";
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    return parsed.protocol.slice(0, -1);
  } catch {
    return undefined;
  }
}

/** CDP errors can echo page details; retain only a stable error class. */
export function safeErrorKind(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(error.name)) return error.name;
  return "Error";
}

export function normalizeObservation(value: unknown): TurnstilePageObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.slice(0, 8_192) : "";
  const title = typeof record.title === "string" ? record.title.slice(0, 512) : "";
  const knownSignals = new Set(["title-marker", "html-marker", "turnstile-field", "turnstile-widget", "turnstile-script", "challenge-frame"]);
  const signals = Array.isArray(record.signals)
    ? record.signals.filter((signal): signal is string => typeof signal === "string" && knownSignals.has(signal)).slice(0, 32)
    : [];
  // The production page script intentionally emits no boxes, but retaining this
  // parser keeps injected deterministic transports bounded and safe.
  const boxes = Array.isArray(record.boxes)
    ? record.boxes.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const box = candidate as Record<string, unknown>;
      const x = typeof box.x === "number" ? box.x : Number.NaN;
      const y = typeof box.y === "number" ? box.y : Number.NaN;
      const width = typeof box.width === "number" ? box.width : Number.NaN;
      const height = typeof box.height === "number" ? box.height : Number.NaN;
      const frameUrl = typeof box.frameUrl === "string" ? box.frameUrl : "";
      const instanceId = typeof box.instanceId === "string" && box.instanceId.length <= 2_048 ? box.instanceId : undefined;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || frameUrl.length > 2_048) return [];
      return [{ x, y, width, height, frameUrl, ...(instanceId ? { instanceId } : {}) }];
    }).slice(0, 64)
    : [];
  return { url, title, signals, challenge: record.challenge === true, solved: record.solved === true, boxes };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function jitter(value: number, range = 2): number {
  return value + (Math.random() * 2 - 1) * range;
}

export function isUsableBox(box: TurnstileChallengeBox): boolean {
  // Reject tiny/degenerate boxes so an attacker cannot use a hidden 1x1 frame
  // to turn this into an arbitrary trusted input event.
  return Number.isFinite(box.x) && Number.isFinite(box.y) && box.width >= 8 && box.height >= 8;
}

export function turnstileChallengeKey(box: TurnstileChallengeBox): string {
  if (box.instanceId?.startsWith("frame:")) return box.instanceId;
  return `box:${Math.round(box.x / 2)}\u0000${Math.round(box.y / 2)}\u0000${Math.round(box.width / 2)}\u0000${Math.round(box.height / 2)}`;
}

export function turnstileGeometryKey(box: TurnstileChallengeBox): string {
  return `${Math.round((box.x + box.width / 2) / 4)}\u0000${Math.round((box.y + box.height / 2) / 4)}\u0000${Math.round(box.width / 4)}\u0000${Math.round(box.height / 4)}`;
}

export function parseJsonMessage(event: any): Record<string, any> | undefined {
  const raw = typeof event?.data === "string"
    ? event.data
    : event?.data instanceof ArrayBuffer
      ? new TextDecoder().decode(event.data)
      : undefined;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}
