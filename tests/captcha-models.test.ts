import { describe, expect, test } from "bun:test";
import { DEFAULT_LLM_CAPTCHA_BASE_URL, DEFAULT_LLM_CAPTCHA_MODELS, llmCaptchaModels, proxiedFetch } from "@browser-fabric/worker-runtime";
import { captchaSolvingFromEnvironment } from "../apps/worker-manager/src/captcha-solver-factory";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Seen = { url: string; headers: Record<string, string>; body: string };

/** A fetch that answers like Anthropic's Messages API and records each request. */
function recordingFetch(): { fetch: typeof globalThis.fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return Response.json({ id: "msg", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }, { preconnect: globalThis.fetch.preconnect });
  return { fetch, seen };
}

async function ask(model: unknown): Promise<void> {
  await (model as { doGenerate(options: unknown): Promise<unknown> }).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "which tiles?" }] }] });
}

describe("the CAPTCHA guardian's model", () => {
  test("asks Opus, then Sonnet, then GPT through the AI gateway's Messages API, with the key only in its header", async () => {
    const { fetch, seen } = recordingFetch();
    const models = llmCaptchaModels({ apiKey: "gateway-key", fetch });
    for (const model of models) await ask(model);
    expect(seen.map(({ body }) => JSON.parse(body).model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.5"]);
    for (const request of seen) {
      expect(request.url).toBe(`${DEFAULT_LLM_CAPTCHA_BASE_URL}/messages`);
      expect(request.headers["x-api-key"]).toBe("gateway-key");
      expect(request.body).not.toContain("gateway-key");
    }
  });

  test("takes a base URL and a comma-separated model list; blank values keep the defaults", async () => {
    const { fetch, seen } = recordingFetch();
    for (const model of llmCaptchaModels({ apiKey: "k", baseURL: "https://gateway.example/v1", models: " one-model , ,other-model", fetch })) await ask(model);
    expect(llmCaptchaModels({ apiKey: "k", baseURL: " ", models: " , ", fetch })).toHaveLength(DEFAULT_LLM_CAPTCHA_MODELS.length);
    await ask(llmCaptchaModels({ apiKey: "k", baseURL: " ", models: "", fetch })[0]);
    expect(seen.map(({ url, body }) => [url, JSON.parse(body).model])).toEqual([
      ["https://gateway.example/v1/messages", "one-model"],
      ["https://gateway.example/v1/messages", "other-model"],
      [`${DEFAULT_LLM_CAPTCHA_BASE_URL}/messages`, DEFAULT_LLM_CAPTCHA_MODELS[0]],
    ]);
  });

  test("without a key there is no model", () => {
    expect(llmCaptchaModels({ apiKey: undefined, fetch: recordingFetch().fetch })).toEqual([]);
    expect(llmCaptchaModels({ apiKey: "", fetch: recordingFetch().fetch })).toEqual([]);
  });

  test("model requests go through the egress sidecar's proxy, never directly", async () => {
    const proxied: string[] = [];
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { proxied.push(request.url); return new Response("via proxy"); } });
    try {
      // An http target, so the proxy sees the request itself rather than a CONNECT tunnel.
      const response = await proxiedFetch(`http://127.0.0.1:${proxy.port}`)("http://gateway.invalid/v1/messages", { method: "POST", body: "{}" });
      expect(await response.text()).toBe("via proxy");
      expect(proxied).toEqual(["http://gateway.invalid/v1/messages"]);
    } finally {
      proxy.stop(true);
    }
  });

  test("an owner reads the key from its secret file; a placeholder means no key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fabric-llm-captcha-"));
    try {
      writeFileSync(join(directory, "placeholder"), "# not-yet-provisioned\n");
      writeFileSync(join(directory, "key"), "gateway-key\n");
      const models: number[] = [];
      for (const file of ["placeholder", "key", "missing"]) {
        models.push((await captchaSolvingFromEnvironment("http://127.0.0.1:9", { FABRIC_LLM_CAPTCHA_API_KEY_FILE: join(directory, file) })).models.length);
      }
      expect(models).toEqual([0, DEFAULT_LLM_CAPTCHA_MODELS.length, 0]);
      expect((await captchaSolvingFromEnvironment("http://127.0.0.1:9", {})).models).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
