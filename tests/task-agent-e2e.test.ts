import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LlmError, runTask, type ChatModel, type ChatRequest, type ChatResponse, type StepLog, type TaskSteering, type ToolCall } from "@browser-fabric/task-agent";
import { chromiumExecutable as executable, launchChromium, type TestChromium } from "./support/chromium";
import { PASSWORD, startFixtureSite, type FixtureSite } from "./support/task-agent-fixtures";

let chromium: TestChromium;
let site: FixtureSite;

beforeAll(async () => {
  if (!executable) return;
  chromium = await launchChromium(executable);
  site = startFixtureSite();
});
afterAll(async () => {
  await chromium?.close();
  site?.stop();
});

/** Text of everything the model was sent in one request. */
const requestText = (request: ChatRequest) => JSON.stringify(request.messages);

/** The newest observation in a request. */
function latestObservation(request: ChatRequest): string {
  const texts = request.messages.flatMap((message) => message.role === "user" ? message.content : message.role === "tool" ? message.results.flatMap((result) => result.content) : [])
    .filter((part) => part.type === "text").map((part) => (part as { text: string }).text);
  const observation = texts.filter((text) => text.startsWith("Current page:")).at(-1);
  if (!observation) throw new Error("no observation in request");
  return observation;
}

function refIn(observation: string, pattern: string): string {
  const line = observation.split("\n").find((candidate) => candidate.includes(pattern));
  const match = line && /^\[((?:f\d+)?e\d+)\]/.exec(line);
  if (!match) throw new Error(`no element ${pattern} in\n${observation}`);
  return match[1]!;
}

type Turn = (request: ChatRequest, observation: string) => { text?: string; calls: Omit<ToolCall, "id">[] } | Promise<{ text?: string; calls: Omit<ToolCall, "id">[] }>;

/**
 * A deterministic model: each tool-calling request plays the next scripted turn (which reads refs
 * from the observation, as a real model would). Requests without tools are extraction questions.
 */
class ScriptedModel implements ChatModel {
  readonly id = "test/scripted";
  readonly requests: ChatRequest[] = [];
  #calls = 0;

  public constructor(private readonly turns: Turn[], private readonly extract: (content: string) => string = () => "") {}

  public async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const usage = { inputTokens: 100, outputTokens: 10 };
    if (!request.tools) return { text: this.extract(requestText(request)), toolCalls: [], usage, stopReason: "end_turn" };
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    const { text = "", calls } = await turn(request, latestObservation(request));
    return { text, toolCalls: calls.map((call) => ({ id: `call_${++this.#calls}`, ...call })), usage, stopReason: "tool_use" };
  }
}

const RESULT_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, price: { type: "number" }, sku: { type: "string", pattern: "^[A-Z]{2}-\\d{3}$" } },
  required: ["name", "price", "sku"],
  additionalProperties: false,
};

async function pageTargets(): Promise<string[]> {
  const targets = await (await fetch(`${chromium.endpoint}/json/list`)).json() as { id: string; type: string }[];
  return targets.filter((target) => target.type === "page").map((target) => target.id);
}

describe.skipIf(!executable)("runTask end to end (scripted model, real Chromium)", () => {
  test("logs in with a secret, searches, opens a result, extracts and returns a schema-valid result", async () => {
    const before = await pageTargets();
    const model = new ScriptedModel([
      (_request, page) => ({
        text: "I will sign in.",
        calls: [
          { name: "type", arguments: { ref: refIn(page, "textbox \"Username\""), text: "alice" } },
          { name: "type", arguments: { ref: refIn(page, "textbox \"Password\""), text: "{{secret:PASSWORD}}" } },
          { name: "click", arguments: { ref: refIn(page, "button \"Sign in\"") } },
        ],
      }),
      (_request, page) => ({ calls: [{ name: "type", arguments: { ref: refIn(page, "searchbox \"Search catalog\""), text: "widget", submit: true } }] }),
      (_request, page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, "link \"Red Widget\"") } }] }),
      () => ({ calls: [{ name: "extract", arguments: { question: "What are the price and SKU?" } }] }),
      // A result that violates the schema is refused, and the model gets the reasons.
      () => ({ calls: [{ name: "done", arguments: { result: { name: "Red Widget", price: "$42.50", sku: "RW-042" }, summary: "found" } }] }),
      (request) => {
        expect(requestText(request)).toContain("error: the result does not match the schema: result.price: expected number, got string");
        return { calls: [{ name: "done", arguments: { result: { name: "Red Widget", price: 42.5, sku: "RW-042" }, summary: "Signed in, searched and read the Red Widget page." } }] };
      },
    ], (content) => {
      const price = /Price\\n(\$[\d.]+)/.exec(content)?.[1];
      const sku = /SKU\\n([A-Z]{2}-\d{3})/.exec(content)?.[1];
      return `Price ${price}, SKU ${sku}`;
    });
    const logged: StepLog[] = [];
    const result = await runTask({
      cdpEndpoint: chromium.endpoint,
      goal: "Sign in as alice and find the price and SKU of the Red Widget",
      startUrl: `${site.origin}/login`,
      resultSchema: RESULT_SCHEMA,
      model,
      secrets: { PASSWORD },
      historyWindow: 2,
      onStep: (step) => logged.push(step),
    });

    expect(result.status).toBe("done");
    expect(result.result).toEqual({ name: "Red Widget", price: 42.5, sku: "RW-042" });
    expect(result.summary).toBe("Signed in, searched and read the Red Widget page.");
    expect(result.url).toBe(`${site.origin}/item/2`);
    expect(result.steps).toHaveLength(6);
    expect(logged).toEqual(result.steps);
    expect(site.logins).toBe(1);

    const [login, search, open, extract, rejected, done] = result.steps;
    expect(login!.thought).toBe("I will sign in.");
    expect(login!.url).toBe(`${site.origin}/login`);
    expect(login!.actions.map((action) => [action.tool, action.ok])).toEqual([["type", true], ["type", true], ["click", true]]);
    expect(login!.actions[1]!.args).toEqual({ ref: expect.any(String), text: "{{secret:PASSWORD}}" });
    expect(login!.actions[1]!.output).toContain("(secret entered)");
    // Each action names the element its ref pointed at, as the observation showed it.
    expect(login!.actions.map((action) => action.target)).toEqual(['textbox "Username"', 'textbox "Password"', 'button "Sign in"']);
    expect(search!.actions[0]!.target).toBe('searchbox "Search catalog"');
    expect(open!.actions[0]!.target).toBe('link "Red Widget"');
    // Actions without a ref name no element.
    expect(extract!.actions[0]!.target).toBeUndefined();
    expect(login!.actions[2]!.output).toContain("the page navigated");
    expect(search!.url).toBe(`${site.origin}/search`);
    expect(search!.actions[0]!.output).toContain("the page navigated");
    expect(open!.url).toBe(`${site.origin}/search?q=widget`);
    expect(extract!.actions[0]!.output).toBe("Price $42.50, SKU RW-042");
    expect(extract!.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(rejected!.actions[0]!.ok).toBe(false);
    expect(done!.actions).toEqual([{ tool: "done", args: { result: { name: "Red Widget", price: 42.5, sku: "RW-042" }, summary: expect.any(String) }, ok: true, output: "accepted" }]);
    expect(result.usage).toEqual({ inputTokens: 700, outputTokens: 70 });

    // The secret value never reaches the model or the result; only its placeholder does.
    for (const request of model.requests) expect(JSON.stringify(request)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(requestText(model.requests[0]!)).toContain("Secrets you can type: {{secret:PASSWORD}}");
    // Older steps collapse into summaries once they leave the window.
    const last = model.requests.filter((request) => request.tools).at(-1)!;
    expect(requestText(last)).toContain("Earlier steps (summarized):\\n1. type{");
    expect(last.messages).toHaveLength(5);
    // Its own tab is closed again, by the time runTask returns.
    expect(await pageTargets()).toEqual(before);
  });

  test("a secret the page echoes back is redacted from observations", async () => {
    const model = new ScriptedModel([
      (_request, page) => ({ calls: [{ name: "type", arguments: { ref: refIn(page, "textbox \"Username\""), text: "alice" } }, { name: "type", arguments: { ref: refIn(page, "textbox \"Password\""), text: "{{secret:PASSWORD}}", submit: true } }] }),
      (_request, page) => ({ calls: [{ name: "type", arguments: { ref: refIn(page, "Search catalog"), text: "{{secret:PASSWORD}}", submit: true } }] }),
      (request, page) => {
        expect(page).toContain("searchbox \"Search catalog\" value=\"{{secret:PASSWORD}}\"");
        expect(JSON.stringify(request)).not.toContain(PASSWORD);
        return { calls: [{ name: "fail", arguments: { reason: `nothing found for ${PASSWORD}` } }] };
      },
    ]);
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "echo test", startUrl: `${site.origin}/login`, model, secrets: { PASSWORD } });
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("nothing found for {{secret:PASSWORD}}");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  test("terminal tools batched with actions are refused; a reply without tool calls is nudged; batches stop at an error", async () => {
    const model = new ScriptedModel([
      () => ({ text: "Thinking without acting.", calls: [] }),
      (request, page) => {
        expect(requestText(request)).toContain("You did not call a tool.");
        return { calls: [{ name: "click", arguments: { ref: refIn(page, "\"Count\"") } }, { name: "done", arguments: { result: "guess", summary: "s" } }] };
      },
      (_request, page) => ({ calls: [{ name: "click", arguments: { ref: "e999" } }, { name: "click", arguments: { ref: refIn(page, "\"Count\"") } }, { name: "teleport", arguments: {} }] }),
      () => ({ calls: [{ name: "done", arguments: { result: "counted", summary: "clicked once" } }] }),
    ]);
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "click count", startUrl: `${site.origin}/counter`, model });
    expect(result.status).toBe("done");
    expect(result.result).toBe("counted");
    expect(result.steps[0]!.actions).toEqual([]);
    expect(result.steps[1]!.actions.map((action) => [action.tool, action.ok, action.output])).toEqual([
      ["click", true, expect.stringMatching(/^clicked e\d+$/)],
      ["done", false, "not accepted: call done on its own, after you have seen the outcome of your actions"],
    ]);
    expect(result.steps[2]!.actions.map((action) => [action.tool, action.ok, action.output])).toEqual([
      ["click", false, "error: ref e999 no longer exists (the page changed); use a ref from the latest observation"],
      ["click", false, "not executed: an earlier action in this step failed"],
      ["teleport", false, "not executed: an earlier action in this step failed"],
    ]);
  });

  test("the model sees the CAPTCHA guardian's state, waits while it solves, and goes on once solved", async () => {
    const model = new ScriptedModel([
      (request, page) => {
        expect(page).toContain("\nCaptcha: solving (tencent-slider)\n");
        expect(request.system).toContain("While it reads solving, call wait");
        return { calls: [{ name: "wait", arguments: { seconds: 30 } }] };
      },
      (_request, page) => {
        expect(page).toContain("\nCaptcha: solved\n");
        return { calls: [{ name: "click", arguments: { ref: refIn(page, "button \"Continue\"") } }] };
      },
      (_request, page) => {
        expect(page).toContain("continued");
        return { calls: [{ name: "done", arguments: { result: "past the gate", summary: "waited for the CAPTCHA, then continued" } }] };
      },
    ]);
    const started = Date.now();
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "get past the gate", startUrl: `${site.origin}/captcha?after=1500`, model });
    expect(result).toMatchObject({ status: "done", result: "past the gate" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.steps.map((step) => step.captcha)).toEqual([{ state: "solving", detail: "tencent-slider" }, { state: "solved", detail: "tencent-slider" }, { state: "solved", detail: "tencent-slider" }]);
    expect(result.steps[0]!.actions).toEqual([{ tool: "wait", args: { seconds: 30 }, ok: true, output: expect.stringMatching(/^the CAPTCHA was solved after \d\.\ds$/) }]);
  });

  test("stops at the step limit", async () => {
    const scroll = () => ({ calls: [{ name: "scroll", arguments: { direction: "down" } }] });
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "scroll forever", startUrl: `${site.origin}/counter`, model: new ScriptedModel([scroll, scroll, scroll, scroll]), maxSteps: 3 });
    expect(result.status).toBe("step_limit");
    expect(result.summary).toBe("Stopped after 3 steps without finishing.");
    expect(result.steps).toHaveLength(3);
  });

  test("stops at the wall-clock timeout, even inside a model call", async () => {
    const slow: Turn = async (request) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal!.reason); });
      });
      return { calls: [] };
    };
    const before = await pageTargets();
    const started = Date.now();
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "slow", startUrl: `${site.origin}/counter`, model: new ScriptedModel([slow]), timeoutMs: 1_500 });
    expect(result.status).toBe("timeout");
    expect(result.summary).toBe("Timed out after 2 s.");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await pageTargets()).toEqual(before);
  });

  test("an abort from the caller fails the task", async () => {
    const controller = new AbortController();
    const turn: Turn = (_request, page) => {
      controller.abort(new Error("user cancelled"));
      return { calls: [{ name: "click", arguments: { ref: refIn(page, "\"Count\"") } }] };
    };
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "abort", startUrl: `${site.origin}/counter`, model: new ScriptedModel([turn]), signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", summary: "Aborted." });
  });

  test("a model error fails the task with its message", async () => {
    const broken: ChatModel = { id: "test/broken", complete: async () => { throw new LlmError("HTTP 401: invalid x-api-key", 401); } };
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "x", model: broken });
    expect(result).toMatchObject({ status: "failed", summary: "Error: HTTP 401: invalid x-api-key", steps: [] });
  });

  test("needs_input keeps the tab when asked, and a second run continues in it", async () => {
    const first = await runTask({
      cdpEndpoint: chromium.endpoint,
      goal: "sign in",
      startUrl: `${site.origin}/login`,
      model: new ScriptedModel([() => ({ calls: [{ name: "needs_input", arguments: { question: "What is the password for alice?" } }] })]),
      keepTab: true,
    });
    expect(first).toMatchObject({ status: "needs_input", question: "What is the password for alice?", summary: "What is the password for alice?" });
    expect(await pageTargets()).toContain(first.targetId!);

    const second = await runTask({
      cdpEndpoint: chromium.endpoint,
      goal: "sign in",
      targetId: first.targetId!,
      secrets: { PASSWORD },
      model: new ScriptedModel([
        (_request, page) => ({ calls: [{ name: "type", arguments: { ref: refIn(page, "\"Username\""), text: "alice" } }, { name: "type", arguments: { ref: refIn(page, "\"Password\""), text: "{{secret:PASSWORD}}", submit: true } }] }),
        (_request, page) => {
          expect(page).toContain("Catalog search");
          return { calls: [{ name: "done", arguments: { result: "signed in", summary: "ok" } }] };
        },
      ]),
    });
    expect(second.status).toBe("done");
    expect(second.steps[0]!.url).toBe(`${site.origin}/login`);
    // A tab the caller brought is never closed by the agent.
    expect(await pageTargets()).toContain(first.targetId!);
    await fetch(`${chromium.endpoint}/json/close/${first.targetId}`);
  });

  test("steering: a checkpoint holds the task without using its timeout, and its notes arrive with a fresh observation", async () => {
    const checkpoints: number[] = [];
    let turns = 0;
    const steering: TaskSteering = {
      checkpoint: async () => {
        checkpoints.push(Date.now());
        // The second checkpoint is a person driving for longer than the whole timeout.
        if (checkpoints.length !== 2) return { notes: [] };
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return { notes: ["A person clicked Count twice.", "Now finish."] };
      },
      turn: () => { turns += 1; return new AbortController().signal; },
    };
    const model = new ScriptedModel([
      (request, page) => {
        expect(requestText(request)).not.toContain("Notes from the person supervising this task");
        return { calls: [{ name: "click", arguments: { ref: refIn(page, "\"Count\"") } }] };
      },
      (request, page) => {
        const sent = requestText(request);
        expect(sent).toContain("Notes from the person supervising this task:\\n- A person clicked Count twice.\\n- Now finish.");
        // The notes come before the observation taken after them, which is the newest one.
        expect(sent.lastIndexOf("Notes from the person")).toBeLessThan(sent.lastIndexOf("Current page:"));
        expect(page).toStartWith("Current page:");
        return { calls: [{ name: "done", arguments: { result: "ok", summary: "finished after the note" } }] };
      },
    ]);
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "count", startUrl: `${site.origin}/counter`, model, steering, timeoutMs: 1_500 });
    expect(result).toMatchObject({ status: "done", result: "ok" });
    expect(result.steps).toHaveLength(2);
    expect(checkpoints).toHaveLength(2);
    expect(turns).toBe(2);
  });

  test("steering: notes before the first turn replace the first observation", async () => {
    let first = true;
    const steering: TaskSteering = {
      checkpoint: async () => ({ notes: first ? (first = false, ["Look at the counter."]) : [] }),
      turn: () => new AbortController().signal,
    };
    const model = new ScriptedModel([(request) => {
      const first = request.messages[0]!;
      expect(first.role).toBe("user");
      expect(JSON.stringify(first)).toContain("Look at the counter.");
      expect(JSON.stringify(first).match(/Current page:/g)).toHaveLength(1);
      return { calls: [{ name: "done", arguments: { result: "seen", summary: "s" } }] };
    }]);
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "look", startUrl: `${site.origin}/counter`, model, steering });
    expect(result.status).toBe("done");
  });

  test("steering: an interrupted model call uses no step, and an interrupted turn skips the actions not yet run", async () => {
    let interrupt = new AbortController();
    let checkpoints = 0;
    const steering: TaskSteering = {
      checkpoint: async () => (checkpoints += 1, { notes: checkpoints === 2 ? ["The person is done."] : [] }),
      turn: () => (interrupt = new AbortController()).signal,
    };
    const model = new ScriptedModel([
      // The person takes over while the model is still thinking.
      async (request) => {
        setTimeout(() => interrupt.abort(), 50);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal!.reason); });
        });
        return { calls: [] };
      },
      // Then while its actions run: the first click lands, the rest are skipped.
      (request, page) => {
        expect(requestText(request)).toContain("The person is done.");
        const count = refIn(page, "\"Count\"");
        setTimeout(() => interrupt.abort(), 0);
        return { calls: [{ name: "click", arguments: { ref: count } }, { name: "click", arguments: { ref: count } }] };
      },
      () => ({ calls: [{ name: "done", arguments: { result: "ok", summary: "s" } }] }),
    ]);
    // Two steps are enough only because the interrupted call used none.
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "count", startUrl: `${site.origin}/counter`, model, steering, maxSteps: 2 });
    expect(result.status).toBe("done");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.actions.map((action) => [action.tool, action.ok, action.output])).toEqual([
      ["click", true, expect.stringMatching(/^clicked e\d+$/)],
      ["click", false, "not executed: the turn was interrupted by the person supervising this task"],
    ]);
    expect(checkpoints).toBe(3);
  });

  test("steering: a checkpoint that names another of the task's tabs moves the agent there; an unknown tab is ignored", async () => {
    const opener = (await (await fetch(`${chromium.endpoint}/json/new?${site.origin}/counter`, { method: "PUT" })).json() as { id: string }).id;
    let checkpoints = 0;
    const steering: TaskSteering = {
      // After the popup opened (the agent is in it), the person switched back to the counter tab.
      checkpoint: async () => (checkpoints += 1, checkpoints === 2 ? { notes: ["I switched back to the first tab."], targetId: opener } : checkpoints === 3 ? { notes: [], targetId: "no-such-tab" } : { notes: [] }),
      turn: () => new AbortController().signal,
    };
    const model = new ScriptedModel([
      (_request, page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, "link \"Open popup\"") } }] }),
      (_request, page) => {
        expect(page).toContain("Counter");
        expect(page).not.toContain("Popup page");
        return { calls: [{ name: "scroll", arguments: { direction: "down" } }] };
      },
      (_request, page) => {
        expect(page).toContain("Counter");
        return { calls: [{ name: "done", arguments: { result: "back", summary: "s" } }] };
      },
    ]);
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "tabs", targetId: opener, model, steering });
    expect(result).toMatchObject({ status: "done", url: `${site.origin}/counter` });
    expect(result.steps[0]!.actions[0]!.output).toContain("new tab");
    await fetch(`${chromium.endpoint}/json/close/${opener}`);
  });

  test("steering: a caller abort ends a task waiting at its checkpoint", async () => {
    const controller = new AbortController();
    const steering: TaskSteering = {
      checkpoint: (signal) => new Promise((_resolve, reject) => {
        setTimeout(() => controller.abort(new Error("visit ended")), 50);
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
      turn: () => new AbortController().signal,
    };
    const result = await runTask({ cdpEndpoint: chromium.endpoint, goal: "wait", startUrl: `${site.origin}/counter`, model: new ScriptedModel([]), steering, signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", summary: "Aborted.", steps: [] });
  });

  test("an unreachable endpoint fails cleanly", async () => {
    const result = await runTask({ cdpEndpoint: "http://127.0.0.1:1", goal: "x", model: new ScriptedModel([]), timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(result.summary).toStartWith("Error:");
  });
});

describe("runTask argument checks", () => {
  test("requires a goal and an endpoint", async () => {
    await expect(runTask({ goal: " ", cdpEndpoint: "http://127.0.0.1:1", model: new ScriptedModel([]) })).rejects.toThrow("goal is empty");
    await expect(runTask({ goal: "x", model: new ScriptedModel([]) })).rejects.toThrow("cdpEndpoint or connection is required");
  });
});
