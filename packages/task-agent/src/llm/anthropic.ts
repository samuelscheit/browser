import { postJson, type HttpOptions } from "./http";
import { LlmError, type ChatModel, type ChatRequest, type ChatResponse, type ContentPart, type ToolCall } from "./types";

type AnthropicBlock = Record<string, unknown>;

function blocks(content: readonly ContentPart[]): AnthropicBlock[] {
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } });
}

/** Encode the neutral history as Anthropic Messages: tool results travel in a user turn. */
export function anthropicMessages(messages: ChatRequest["messages"]): { role: "user" | "assistant"; content: AnthropicBlock[] }[] {
  const encoded: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: AnthropicBlock[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      encoded.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] });
      continue;
    }
    const content = message.role === "user"
      ? blocks(message.content)
      : message.results.map((result) => ({ type: "tool_result", tool_use_id: result.toolCallId, content: blocks(result.content), ...(result.isError ? { is_error: true } : {}) }));
    // Consecutive user turns (tool results followed by a note) merge into one.
    const previous = encoded.at(-1);
    if (previous?.role === "user") previous.content.push(...content);
    else encoded.push({ role: "user", content });
  }
  return encoded;
}

export function parseAnthropicResponse(body: unknown): ChatResponse {
  const response = body as { content?: AnthropicBlock[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  if (!Array.isArray(response?.content)) throw new LlmError("Anthropic response has no content");
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const input = block.input;
      toolCalls.push(input && typeof input === "object" && !Array.isArray(input)
        ? { id: block.id, name: block.name, arguments: input as Record<string, unknown> }
        : { id: block.id, name: block.name, arguments: {}, argumentsError: "tool input is not an object" });
    }
  }
  const usage = response.usage ?? {};
  return {
    text: text.join("\n").trim(),
    toolCalls,
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
    },
    stopReason: response.stop_reason ?? "unknown",
  };
}

export class AnthropicModel implements ChatModel {
  public readonly id: string;

  public constructor(private readonly options: { model: string; apiKey: string; baseUrl?: string; http?: HttpOptions }) {
    this.id = `anthropic/${options.model}`;
  }

  public async complete(request: ChatRequest): Promise<ChatResponse> {
    const tools = (request.tools ?? []).map((tool, index, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // The system prompt and tools are identical every step: cache them.
      ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const body = {
      model: this.options.model,
      max_tokens: request.maxTokens ?? 4_096,
      system: [{ type: "text", text: request.system, ...(tools.length ? {} : { cache_control: { type: "ephemeral" } }) }],
      messages: anthropicMessages(request.messages),
      // Not "any": models with extended thinking (and some gateways) reject a forced tool call; the
      // agent loop answers a reply without a tool call with a reminder instead.
      ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
    };
    const base = (this.options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const response = await postJson(`${base}/v1/messages`, { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" }, body, request.signal, this.options.http);
    return parseAnthropicResponse(response);
  }
}
