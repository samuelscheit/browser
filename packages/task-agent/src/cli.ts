import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runTask, type StepLog, type TaskResult } from "./agent";
import { MODEL_SPEC_HELP } from "./llm";
import { Secrets, type JsonSchema } from "./safety";

export const TASK_HELP = `fabric task "<goal>" — let an LLM agent do a task in the fabric browser

  fabric task "find the latest release of bun" --url https://github.com/oven-sh/bun
  fabric task "log in and read my balance" --url https://bank.example --schema balance.schema.json

Options:
  --url <url>            start page
  --schema <file>        JSON Schema the result must match (default: a text answer)
  --model <provider/id>  anthropic/<model> or openai/<model> (default $FABRIC_TASK_MODEL)
  --max-steps <n>        model turns before giving up (default 25)
  --timeout <10m|90s>    wall-clock limit (default 10m)
  --vision               send a screenshot with every observation
  --upload-dir <dir>     allow uploading files from this directory (repeatable)
  --keep-tab             leave the tab open (prints its id); --target <id> continues in a tab
  --remote, --name <n>   which fabric browser (as for every command)
  --json                 print the full result, including every step, as JSON

Keys: ANTHROPIC_API_KEY / OPENAI_API_KEY (+ ANTHROPIC_BASE_URL / OPENAI_BASE_URL).
Secrets: FABRIC_SECRET_<NAME>=value lets the agent type {{secret:NAME}} without seeing the value.
Exit status: 0 done, 2 needs input, 1 otherwise.`;

const options = {
  url: { type: "string" },
  schema: { type: "string" },
  model: { type: "string" },
  "max-steps": { type: "string" },
  timeout: { type: "string" },
  vision: { type: "boolean" },
  "upload-dir": { type: "string", multiple: true },
  "keep-tab": { type: "boolean" },
  target: { type: "string" },
  remote: { type: "boolean" },
  name: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 600_000;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) throw new Error(`invalid --timeout ${JSON.stringify(raw)}; use 10m, 90s or 1h`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const ms = unit === "h" ? value * 3_600_000 : unit === "m" ? value * 60_000 : unit === "ms" ? value : value * 1_000;
  if (ms < 1_000 || ms > 4 * 3_600_000) throw new Error("--timeout must be between 1s and 4h");
  return ms;
}

function describeStep(step: StepLog): string {
  const actions = step.actions.map((action) => `${action.ok ? "✓" : "✗"} ${action.tool} ${JSON.stringify(action.args)} → ${action.output.split("\n")[0]!.slice(0, 160)}`);
  return [`step ${step.step} (${step.url})${step.thought ? `: ${step.thought.split("\n")[0]!.slice(0, 200)}` : ""}`, ...actions.map((line) => `  ${line}`)].join("\n");
}

function describeResult(result: TaskResult): string {
  const lines = [`${result.status}: ${result.summary}`];
  if (result.result !== undefined) lines.push(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2));
  if (result.targetId) lines.push(`tab ${result.targetId} (continue with --target ${result.targetId})`);
  lines.push(`${result.steps.length} steps, ${result.usage.inputTokens} input + ${result.usage.outputTokens} output tokens`);
  return lines.join("\n");
}

/**
 * `fabric task`: run the agent against the endpoint of a fabric browser. `endpoint` resolves
 * (and starts, when needed) the browser that `--remote` / `--name` select.
 */
export async function taskCommand(argv: string[], dependencies: { endpoint(selection: { remote: boolean; name?: string }): Promise<string> }): Promise<TaskResult | undefined> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  if (values.help) {
    console.log(TASK_HELP);
    return undefined;
  }
  const goal = positionals.join(" ").trim();
  if (!goal) throw new Error(`usage: ${TASK_HELP.split("\n")[0]}`);
  const model = values.model ?? process.env.FABRIC_TASK_MODEL;
  if (!model) throw new Error(`pass --model or set FABRIC_TASK_MODEL; ${MODEL_SPEC_HELP}`);
  let maxSteps: number | undefined;
  if (values["max-steps"] !== undefined) {
    maxSteps = Number(values["max-steps"]);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new Error("--max-steps must be an integer from 1 to 200");
  }
  let resultSchema: JsonSchema | undefined;
  if (values.schema) {
    try {
      resultSchema = JSON.parse(readFileSync(values.schema, "utf8")) as JsonSchema;
    } catch (error) {
      throw new Error(`cannot read --schema ${values.schema}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resultSchema || typeof resultSchema !== "object" || Array.isArray(resultSchema)) throw new Error("--schema must contain a JSON Schema object");
  }
  const cdpEndpoint = await dependencies.endpoint({ remote: values.remote ?? false, ...(values.name ? { name: values.name } : {}) });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", stop);
  try {
    const result = await runTask({
      cdpEndpoint,
      goal,
      model,
      signal: controller.signal,
      secrets: Secrets.fromEnvironment(),
      timeoutMs: parseTimeout(values.timeout),
      screenshots: values.vision ?? false,
      keepTab: values["keep-tab"] ?? false,
      ...(values.url ? { startUrl: values.url } : {}),
      ...(resultSchema ? { resultSchema } : {}),
      ...(maxSteps ? { maxSteps } : {}),
      ...(values["upload-dir"] ? { uploadDirs: values["upload-dir"] } : {}),
      ...(values.target ? { targetId: values.target } : {}),
      onStep: (step) => console.error(describeStep(step)),
    });
    console.log(values.json ? JSON.stringify(result, null, 2) : describeResult(result));
    process.exitCode = result.status === "done" ? 0 : result.status === "needs_input" ? 2 : 1;
    return result;
  } finally {
    process.off("SIGINT", stop);
  }
}
