import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { taskCommand, TASK_HELP } from "@browser-fabric/task-agent";
import { HELP } from "../apps/cli/src/cli";
import { findChromium, launchChromium, type TestChromium } from "./support/chromium";
import { startFixtureSite, type FixtureSite } from "./support/task-agent-fixtures";

const executable = await findChromium();
let chromium: TestChromium;
let site: FixtureSite;
let llm: Server<undefined>;
const requests: any[] = [];
const directory = mkdtempSync(join(tmpdir(), "task-agent-cli-"));
const schemaFile = join(directory, "schema.json");
writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { clicks: { type: "integer" } }, required: ["clicks"] }));

/** An OpenAI-compatible server playing a two-turn script: click "Count", then finish. */
function startFakeOpenAi(): Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push({ authorization: request.headers.get("authorization"), body });
      const turn = requests.length;
      const observation = JSON.stringify(body.messages).split("Current page:").at(-1)!;
      const ref = /\[(e\d+)\] button \\"Count\\"/.exec(observation)?.[1];
      const call = turn === 1
        ? { name: "click", arguments: JSON.stringify({ ref }) }
        : { name: "done", arguments: JSON.stringify({ result: { clicks: 1 }, summary: "Clicked Count once." }) };
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: `call_${turn}`, type: "function", function: call }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    },
  });
}

beforeAll(async () => {
  if (!executable) return;
  chromium = await launchChromium(executable);
  site = startFixtureSite();
  llm = startFakeOpenAi();
});
afterAll(async () => {
  await chromium?.close();
  site?.stop();
  llm?.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

async function captured(run: () => Promise<unknown>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values) => { out.push(values.join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...values) => { err.push(values.join(" ")); });
  try {
    await run();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe.skipIf(!executable)("fabric task", () => {
  test("runs the agent through an OpenAI-compatible endpoint and prints the result", async () => {
    const saved = { ...process.env };
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${llm.port}/v1`;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.FABRIC_SECRET_PIN = "4711-pin";
    const selections: unknown[] = [];
    try {
      const { out, err } = await captured(() => taskCommand(
        ["click", "the", "count", "button", "--url", `${site.origin}/counter`, "--schema", schemaFile, "--model", "openai/fake-model", "--max-steps", "4", "--json", "--name", "work"],
        { endpoint: async (selection) => { selections.push(selection); return chromium.endpoint; } },
      ));
      expect(selections).toEqual([{ remote: false, name: "work" }]);
      const result = JSON.parse(out);
      expect(result).toMatchObject({ status: "done", result: { clicks: 1 }, summary: "Clicked Count once.", usage: { inputTokens: 20, outputTokens: 4 } });
      expect(process.exitCode).toBe(0);
      expect(err).toContain("step 1 (");
      expect(err).toMatch(/✓ click \{"ref":"e\d+"\} → clicked e\d+/);
      expect(requests[0].authorization).toBe("Bearer sk-test");
      expect(requests[0].body.model).toBe("fake-model");
      expect(JSON.stringify(requests[0].body)).toContain("Task: click the count button");
      expect(JSON.stringify(requests[0].body)).toContain("Secrets you can type: {{secret:PIN}}");
    } finally {
      process.env = saved;
      process.exitCode = 0;
    }
  });
});

describe("fabric task arguments", () => {
  const endpoint = async () => { throw new Error("must not start a browser"); };

  test("validates before touching the browser", async () => {
    const saved = process.env.FABRIC_TASK_MODEL;
    delete process.env.FABRIC_TASK_MODEL;
    try {
      await expect(taskCommand([], { endpoint })).rejects.toThrow("usage: fabric task");
      await expect(taskCommand(["goal"], { endpoint })).rejects.toThrow("pass --model or set FABRIC_TASK_MODEL");
      await expect(taskCommand(["goal", "--model", "x/y", "--max-steps", "0"], { endpoint })).rejects.toThrow("--max-steps must be an integer");
      await expect(taskCommand(["goal", "--model", "x/y", "--schema", join(directory, "missing.json")], { endpoint })).rejects.toThrow("cannot read --schema");
      await expect(taskCommand(["goal", "--bogus"], { endpoint })).rejects.toThrow();
    } finally {
      if (saved !== undefined) process.env.FABRIC_TASK_MODEL = saved;
    }
  });

  test("help is reachable from fabric's help and --help", async () => {
    expect(HELP).toContain("fabric task \"<goal>\"");
    const { out } = await captured(() => taskCommand(["--help"], { endpoint }));
    expect(out).toBe(TASK_HELP);
  });
});
