/**
 * The vision model the CAPTCHA guardian asks, and the egress its requests take. Configuration comes from
 * the owner's secret files and environment; the key stays in the owning process and never reaches a
 * browser or a log line.
 */
import { createModel } from "llm-captcha-solver";
import type { CaptchaModels } from "./captcha-guardian-types";

/** Fabric's AI gateway, which speaks Anthropic's Messages API. */
export const DEFAULT_LLM_CAPTCHA_BASE_URL = "https://ollama.samuelscheit.com/v1";
export const DEFAULT_LLM_CAPTCHA_MODEL = "claude-opus-5-5";

/**
 * Requests through the reviewed Fabric egress sidecar's captcha-solver listener, which admits only the
 * solver hostnames (the model gateway, the token providers). Solving therefore never becomes a general
 * direct-egress path.
 */
export function proxiedFetch(proxyUrl: string): typeof globalThis.fetch {
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, proxy: proxyUrl } as RequestInit),
    { preconnect: fetch.preconnect },
  );
}

/** The guardian's models: none without a key, so only challenges that need no model are solved. */
export function llmCaptchaModels(config: { apiKey: string | undefined; baseURL?: string | undefined; model?: string | undefined; fetch: typeof globalThis.fetch }): CaptchaModels {
  if (!config.apiKey) return [];
  return [createModel({
    provider: "anthropic",
    baseURL: config.baseURL?.trim() || DEFAULT_LLM_CAPTCHA_BASE_URL,
    apiKey: config.apiKey,
    model: config.model?.trim() || DEFAULT_LLM_CAPTCHA_MODEL,
  }, { fetch: config.fetch })];
}
