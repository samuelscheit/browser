import { postJson, type HttpOptions } from "./http";
import { LlmError, type ChatModel, type ChatRequest, type ChatResponse, type ContentPart, type ToolCall } from "./types";

type OpenAiMessage = Record<string, unknown>;

function userContent(content: readonly ContentPart[]): string | Record<string, unknown>[] {
  if (content.every((part) => part.type === "text")) return content.map((part) => (part as { text: string }).text).join("\n\n");
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
}

/**
 * Encode the neutral history as Chat Completions messages. Tool messages carry text only, so
 * images from tool results follow in one user message after the tool messages.
 */
export function openAiMessages(system: string, messages: ChatRequest["messages"]): OpenAiMessage[] {
  const encoded: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") encoded.push({ role: "user", content: userContent(message.content) });
    else if (message.role === "assistant") {
      encoded.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length ? {
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        } : {}),
      });
    } else {
      const images: ContentPart[] = [];
      for (const result of message.results) {
        const text = result.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n\n");
        images.push(...result.content.filter((part) => part.type === "image"));
        encoded.push({ role: "tool", tool_call_id: result.toolCallId, content: result.isError ? `ERROR: ${text}` : text || "ok" });
      }
      if (images.length) encoded.push({ role: "user", content: userContent([{ type: "text", text: "Screenshot of the current page:" }, ...images]) });
    }
  }
  return encoded;
}

export function parseOpenAiResponse(body: unknown): ChatResponse {
  const response = body as {
    choices?: { message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = response?.choices?.[0];
  if (!choice?.message) throw new LlmError("chat completion has no message");
  const toolCalls: ToolCall[] = [];
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
    const name = call.function?.name;
    if (typeof name !== "string") continue;
    const id = typeof call.id === "string" && call.id ? call.id : `call_${index}`;
    const raw = call.function?.arguments;
    if (raw && typeof raw === "object") {
      toolCalls.push({ id, name, arguments: raw as Record<string, unknown> });
      continue;
    }
    try {
      const parsed = JSON.parse(typeof raw === "string" && raw.trim() ? raw : "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments are not a JSON object");
      toolCalls.push({ id, name, arguments: parsed as Record<string, unknown> });
    } catch (error) {
      toolCalls.push({ id, name, arguments: {}, argumentsError: `invalid JSON arguments (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  const content = choice.message.content;
  return {
    text: typeof content === "string" ? content.trim() : "",
    toolCalls,
    usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
    stopReason: choice.finish_reason ?? "unknown",
  };
}

/** OpenAI Chat Completions, or any server speaking it (OpenRouter, vLLM, Ollama, LiteLLM, …). */
export class OpenAiModel implements ChatModel {
  public readonly id: string;

  public constructor(private readonly options: { model: string; apiKey?: string; baseUrl?: string; http?: HttpOptions }) {
    this.id = `openai/${options.model}`;
  }

  public async complete(request: ChatRequest): Promise<ChatResponse> {
    const base = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const official = new URL(base).hostname === "api.openai.com";
    const tools = request.tools ?? [];
    const body = {
      model: this.options.model,
      messages: openAiMessages(request.system, request.messages),
      // OpenAI's reasoning models reject max_tokens; most compatible servers only know it.
      [official ? "max_completion_tokens" : "max_tokens"]: request.maxTokens ?? 4_096,
      ...(tools.length ? {
        tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        // Not "required": several models and gateways reject a forced tool call; the agent loop
        // answers a reply without a tool call with a reminder instead.
        tool_choice: "auto",
      } : {}),
    };
    const headers: Record<string, string> = this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
    return parseOpenAiResponse(await postJson(`${base}/chat/completions`, headers, body, request.signal, this.options.http));
  }
}
