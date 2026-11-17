/** A provider-neutral chat model with tool calling, as the agent sees it. */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png"; data: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; a provider that sent unparseable JSON yields `{}` and `argumentsError`. */
  arguments: Record<string, unknown>;
  argumentsError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: ContentPart[];
  isError?: boolean;
}

export type ChatMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of an object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** "required" forces a tool call where the provider supports it. */
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason: string;
}

export interface ChatModel {
  /** `provider/model`, for logs. */
  readonly id: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export class LlmError extends Error {
  public constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
}
