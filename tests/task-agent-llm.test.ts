import { describe, expect, test } from "bun:test";
import {
  AnthropicModel,
  createModel,
  LlmError,
  OpenAiModel,
  anthropicMessages,
  openAiMessages,
  type ChatMessage,
  type Fetcher,
  type ToolDefinition,
} from "@browser-fabric/task-agent";

interface Call { url: string; init: RequestInit; body: any }

/** A fetch that answers from a script of responses (or throws for network failures). */
function scriptedFetch(responses: (Response | Error | (() => Response))[]): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      const next = responses.shift();
      if (!next) throw new Error("no scripted response left");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = { sleep: async () => undefined, backoffMs: () => 0 };

const TOOLS: ToolDefinition[] = [{ name: "click", description: "Click", parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } }];

const HISTORY: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "Task: test" }] },
  { role: "assistant", text: "Clicking.", toolCalls: [{ id: "call_1", name: "click", arguments: { ref: "e1" } }, { id: "call_2", name: "click", arguments: { ref: "e2" } }] },
  {
    role: "tool",
    results: [
      { toolCallId: "call_1", name: "click", content: [{ type: "text", text: "clicked e1" }] },
      { toolCallId: "call_2", name: "click", content: [{ type: "text", text: "not executed" }, { type: "image", mediaType: "image/jpeg", data: "AAAA" }], isError: true },
    ],
  },
  { role: "user", content: [{ type: "text", text: "Call a tool." }] },
];

describe("Anthropic Messages adapter", () => {
  test("encodes tools, tool results and images, and parses tool_use blocks", async () => {
    const { fetch, calls } = scriptedFetch([json({
      content: [{ type: "text", text: "Typing now." }, { type: "tool_use", id: "toolu_1", name: "click", input: { ref: "e7" } }, { type: "tool_use", id: "toolu_2", name: "click", input: "oops" }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
    })]);
    const model = new AnthropicModel({ model: "claude-test", apiKey: "sk-ant-test", baseUrl: "https://anthropic.example/", http: { fetch, ...noSleep } });
    const response = await model.complete({ system: "sys", messages: HISTORY, tools: TOOLS, toolChoice: "required", maxTokens: 321 });

    expect(response.text).toBe("Typing now.");
    expect(response.toolCalls).toEqual([
      { id: "toolu_1", name: "click", arguments: { ref: "e7" } },
      { id: "toolu_2", name: "click", arguments: {}, argumentsError: "tool input is not an object" },
    ]);
    expect(response.usage).toEqual({ inputTokens: 1_000, outputTokens: 20 });
    expect(response.stopReason).toBe("tool_use");

    const [call] = calls;
    expect(call!.url).toBe("https://anthropic.example/v1/messages");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(call!.body.model).toBe("claude-test");
    expect(call!.body.max_tokens).toBe(321);
    expect(call!.body.tool_choice).toEqual({ type: "any" });
    expect(call!.body.tools[0]).toEqual({ name: "click", description: "Click", input_schema: TOOLS[0]!.parameters, cache_control: { type: "ephemeral" } });
    // Tool results and the following note merge into one user turn.
    expect(call!.body.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(call!.body.messages[1].content).toEqual([
      { type: "text", text: "Clicking." },
      { type: "tool_use", id: "call_1", name: "click", input: { ref: "e1" } },
      { type: "tool_use", id: "call_2", name: "click", input: { ref: "e2" } },
    ]);
    expect(call!.body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "clicked e1" }] },
      { type: "tool_result", tool_use_id: "call_2", is_error: true, content: [{ type: "text", text: "not executed" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] },
      { type: "text", text: "Call a tool." },
    ]);
  });

  test("an assistant turn without text or calls stays a valid message", () => {
    expect(anthropicMessages([{ role: "assistant", text: "", toolCalls: [] }])).toEqual([{ role: "assistant", content: [{ type: "text", text: "(no reply)" }] }]);
  });
});

describe("OpenAI-compatible chat completions adapter", () => {
  test("encodes tool messages (images in a following user message) and parses tool_calls", async () => {
    const { fetch, calls } = scriptedFetch([json({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "click", arguments: "{\"ref\":\"e3\"}" } },
            { id: "call_b", type: "function", function: { name: "click", arguments: "{\"ref\": " } },
            { id: "call_c", type: "function", function: { name: "click", arguments: "[1,2]" } },
            { type: "function", function: { name: "click", arguments: "" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    })]);
    const model = new OpenAiModel({ model: "gpt-test", apiKey: "sk-test", http: { fetch, ...noSleep } });
    const response = await model.complete({ system: "sys", messages: HISTORY, tools: TOOLS, toolChoice: "required" });

    expect(response.text).toBe("");
    expect(response.toolCalls[0]).toEqual({ id: "call_a", name: "click", arguments: { ref: "e3" } });
    expect(response.toolCalls[1]!.argumentsError).toContain("invalid JSON arguments");
    expect(response.toolCalls[2]!.argumentsError).toContain("not a JSON object");
    expect(response.toolCalls[3]).toEqual({ id: "call_3", name: "click", arguments: {} });
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 5 });

    const [call] = calls;
    expect(call!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(call!.body.max_completion_tokens).toBe(4_096);
    expect(call!.body.max_tokens).toBeUndefined();
    expect(call!.body.tool_choice).toBe("required");
    expect(call!.body.tools).toEqual([{ type: "function", function: { name: "click", description: "Click", parameters: TOOLS[0]!.parameters } }]);
    expect(call!.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Task: test" },
      { role: "assistant", content: "Clicking.", tool_calls: [
        { id: "call_1", type: "function", function: { name: "click", arguments: "{\"ref\":\"e1\"}" } },
        { id: "call_2", type: "function", function: { name: "click", arguments: "{\"ref\":\"e2\"}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", content: "clicked e1" },
      { role: "tool", tool_call_id: "call_2", content: "ERROR: not executed" },
      { role: "user", content: [{ type: "text", text: "Screenshot of the current page:" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
      { role: "user", content: "Call a tool." },
    ]);
  });

  test("a compatible server gets max_tokens and no authorization without a key", async () => {
    const { fetch, calls } = scriptedFetch([json({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] })]);
    const model = new OpenAiModel({ model: "llama", baseUrl: "http://127.0.0.1:11434/v1/", http: { fetch, ...noSleep } });
    const response = await model.complete({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    expect(response).toMatchObject({ text: "hi", toolCalls: [], stopReason: "stop" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(calls[0]!.body.max_tokens).toBe(4_096);
    expect(calls[0]!.body.tools).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("messages with only text collapse to strings", () => {
    expect(openAiMessages("s", [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }])[1]).toEqual({ role: "user", content: "a\n\nb" });
  });
});

describe("HTTP retries", () => {
  const okAnthropic = () => json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });

  test("retries 429 (honoring Retry-After), 5xx, 529 and network errors, then succeeds", async () => {
    const waits: number[] = [];
    const { fetch, calls } = scriptedFetch([
      json({ error: { message: "rate limited" } }, 429, { "retry-after": "2" }),
      json({ error: { message: "overloaded" } }, 529),
      new TypeError("socket hang up"),
      json({ error: "bad gateway" }, 502),
      okAnthropic(),
    ]);
    const model = new AnthropicModel({ model: "m", apiKey: "k", http: { fetch, attempts: 5, sleep: async (ms) => { waits.push(ms); }, backoffMs: (attempt) => attempt * 10 } });
    const response = await model.complete({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    expect(response.text).toBe("ok");
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([2_000, 20, 30, 40]);
  });

  test("gives up after the attempt budget with the last error", async () => {
    const { fetch, calls } = scriptedFetch([json({ error: { message: "busy" } }, 503), json({ error: { message: "still busy" } }, 503)]);
    const model = new OpenAiModel({ model: "m", apiKey: "k", http: { fetch, attempts: 2, ...noSleep } });
    const error = await model.complete({ system: "s", messages: [] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toBe("HTTP 503: still busy");
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  test("does not retry client errors", async () => {
    const { fetch, calls } = scriptedFetch([json({ error: { type: "invalid_request_error", message: "max_tokens too large" } }, 400)]);
    const model = new AnthropicModel({ model: "m", apiKey: "k", http: { fetch, ...noSleep } });
    await expect(model.complete({ system: "s", messages: [] })).rejects.toThrow("HTTP 400: max_tokens too large");
    expect(calls).toHaveLength(1);
  });

  test("an abort stops the retry loop", async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch([() => { controller.abort(new Error("stop")); return json({}, 500); }, okAnthropic()]);
    const model = new AnthropicModel({ model: "m", apiKey: "k", http: { fetch, ...noSleep } });
    await expect(model.complete({ system: "s", messages: [], signal: controller.signal })).rejects.toThrow("stop");
    expect(calls).toHaveLength(1);
  });

  test("an unparseable 200 body is an error, not a retry", async () => {
    const { fetch, calls } = scriptedFetch([new Response("<html>proxy</html>", { status: 200 })]);
    const model = new OpenAiModel({ model: "m", apiKey: "k", http: { fetch, ...noSleep } });
    await expect(model.complete({ system: "s", messages: [] })).rejects.toThrow("invalid JSON");
    expect(calls).toHaveLength(1);
  });
});

describe("createModel", () => {
  test("picks the provider from provider/model and keys from the environment", () => {
    expect(createModel("anthropic/claude-x", { ANTHROPIC_API_KEY: "k" }).id).toBe("anthropic/claude-x");
    expect(createModel("openai/gpt-x", { OPENAI_API_KEY: "k" }).id).toBe("openai/gpt-x");
    // Model ids may contain slashes (OpenRouter-style).
    expect(createModel("openai/meta-llama/llama-3.3-70b", { OPENAI_BASE_URL: "https://router.example/v1" }).id).toBe("openai/meta-llama/llama-3.3-70b");
  });

  test("explains what is missing", () => {
    expect(() => createModel("claude", {})).toThrow("provider/model");
    expect(() => createModel("anthropic/claude-x", {})).toThrow("ANTHROPIC_API_KEY is not set");
    expect(() => createModel("openai/gpt-x", {})).toThrow("OPENAI_API_KEY is not set");
    expect(() => createModel("gemini/x", {})).toThrow("unknown model provider");
  });
});
