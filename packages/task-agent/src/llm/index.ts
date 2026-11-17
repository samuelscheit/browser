import { AnthropicModel } from "./anthropic";
import type { HttpOptions } from "./http";
import { OpenAiModel } from "./openai";
import type { ChatModel } from "./types";

export * from "./types";
export { AnthropicModel, anthropicMessages, parseAnthropicResponse } from "./anthropic";
export { OpenAiModel, openAiMessages, parseOpenAiResponse } from "./openai";
export { postJson, type Fetcher, type HttpOptions } from "./http";

export const MODEL_SPEC_HELP = "use provider/model, e.g. anthropic/claude-sonnet-4-5 or openai/gpt-4.1 (any OpenAI-compatible server via OPENAI_BASE_URL)";

/**
 * Build a model from `provider/model` and the environment: ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL),
 * or OPENAI_API_KEY (+ OPENAI_BASE_URL; a custom base URL may need no key).
 */
export function createModel(spec: string, env: Record<string, string | undefined> = process.env, http?: HttpOptions): ChatModel {
  const slash = spec.indexOf("/");
  const provider = slash > 0 ? spec.slice(0, slash) : "";
  const model = slash > 0 ? spec.slice(slash + 1) : "";
  if (!provider || !model) throw new Error(`invalid model ${JSON.stringify(spec)}; ${MODEL_SPEC_HELP}`);
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicModel({ model, apiKey, ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}), ...(http ? { http } : {}) });
  }
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey && !env.OPENAI_BASE_URL) throw new Error("OPENAI_API_KEY is not set (or set OPENAI_BASE_URL for a server without keys)");
    return new OpenAiModel({ model, ...(apiKey ? { apiKey } : {}), ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}), ...(http ? { http } : {}) });
  }
  throw new Error(`unknown model provider ${JSON.stringify(provider)}; ${MODEL_SPEC_HELP}`);
}
