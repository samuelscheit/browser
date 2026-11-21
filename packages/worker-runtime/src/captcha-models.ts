/**
 * The vision model the CAPTCHA guardian asks, and the egress its requests take. Configuration comes from
 * the owner's secret files and environment; the key stays in the owning process and never reaches a
 * browser or a log line.
 */
import { createModel } from "llm-captcha-solver";
import type { CaptchaModels } from "./captcha-guardian-types";

/** Fabric's AI gateway, which speaks Anthropic's Messages API. */
export const DEFAULT_LLM_CAPTCHA_BASE_URL = "https://ollama.samuelscheit.com/v1";
/**
 * Asked in this order: the next takes over when one fails (llm-captcha's fallback), so a gateway
 * cooldown on one model does not stop solving. Order is by the llm-captcha benchmark (Opus 91%,
 * Sonnet 65%, GPT 62% on labelled real challenges).
 */
export const DEFAULT_LLM_CAPTCHA_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.5"] as const;

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

/**
 * The guardian's models, in fallback order: none without a key, so only challenges that need no model
 * are solved. `models` is a comma-separated list; blank means the defaults.
 */
export function llmCaptchaModels(config: { apiKey: string | undefined; baseURL?: string | undefined; models?: string | undefined; fetch: typeof globalThis.fetch }): CaptchaModels {
  const { apiKey } = config;
  if (!apiKey) return [];
  const listed = (config.models ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  const baseURL = config.baseURL?.trim() || DEFAULT_LLM_CAPTCHA_BASE_URL;
  return (listed.length ? listed : DEFAULT_LLM_CAPTCHA_MODELS).map((model) => createModel({ provider: "anthropic", baseURL, apiKey, model }, { fetch: config.fetch }));
}
