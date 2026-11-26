import type { CdpConnection } from "@browser-fabric/worker-runtime/cdp-connection";
import { ACTIONS, type ActionContext } from "./actions";
import { TaskBrowser } from "./browser";
import { createModel } from "./llm";
import type { ChatModel, ContentPart, TokenUsage, ToolCall, ToolResult } from "./llm/types";
import { observe, pageText, type CaptchaStatus, type Observation } from "./observation";
import { buildMessages, SYSTEM_PROMPT, taskIntro, taskTools, TERMINAL_TOOLS, type HistoryStep } from "./prompt";
import { Secrets, UploadPolicy, validateSchema, type JsonSchema } from "./safety";

export type TaskStatus = "done" | "failed" | "needs_input" | "step_limit" | "timeout";

export interface ActionLog {
  tool: string;
  /** Arguments as the model sent them (secrets stay placeholders), redacted. */
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  /** The element the action's `ref` named, as the observation showed it: role and accessible name (`textbox "Email"`), redacted. */
  target?: string;
}

export interface StepLog {
  step: number;
  /** Page the step acted on. */
  url: string;
  title: string;
  /** The CAPTCHA guardian's state on that page, when it saw a challenge there. */
  captcha?: CaptchaStatus;
  /** The model's text alongside its tool calls, if any. */
  thought: string;
  actions: ActionLog[];
  usage: TokenUsage;
  durationMs: number;
}

export interface TaskResult {
  status: TaskStatus;
  /** The `done` result (valid against `resultSchema` when one was given). */
  result?: unknown;
  summary: string;
  /** For `needs_input`: what the agent needs to know. */
  question?: string;
  steps: StepLog[];
  /** Last URL of the active tab. */
  url?: string;
  /** The tab, when `keepTab` kept it open (pass it as `targetId` to continue there). */
  targetId?: string;
  usage: TokenUsage;
}

/**
 * Lets whoever runs a task pause it and talk to it between model turns, for example while a person
 * drives the same tab by hand.
 */
export interface TaskSteering {
  /**
   * Awaited before every model turn: resolves once the task may go on, with notes for the model
   * (what happened meanwhile, new instructions) and, when someone switched tabs meanwhile, the
   * tab to go on in (one of the task's tabs). Notes reach the model with a fresh observation.
   * Time spent here does not count against `timeoutMs`.
   */
  checkpoint(signal: AbortSignal): Promise<{ notes: readonly string[]; targetId?: string }>;
  /**
   * The signal of the turn that is about to start; once it aborts, the turn ends early: an
   * unanswered model call is dropped without using a step, actions not yet run are skipped, and
   * the next checkpoint follows.
   */
  turn(): AbortSignal;
}

export interface RunTaskOptions {
  /** Browser-level CDP endpoint: http(s)://host:port or ws(s)://…/devtools/browser/…. */
  cdpEndpoint?: string;
  /** An existing browser-level connection instead of `cdpEndpoint` (left open). */
  connection?: CdpConnection;
  /** Upgrade headers for an authenticated CDP websocket. */
  cdpHeaders?: Record<string, string>;
  goal: string;
  startUrl?: string;
  /** JSON Schema the `done` result must satisfy. */
  resultSchema?: JsonSchema;
  /** Model turns before giving up (default 25). */
  maxSteps?: number;
  /** Wall-clock limit for the whole task (default 10 minutes). */
  timeoutMs?: number;
  /** A model, or `provider/model` resolved from the environment. */
  model: ChatModel | string;
  signal?: AbortSignal;
  onStep?: (step: StepLog) => void;
  /** Attach a viewport screenshot to each observation (vision-capable models). */
  screenshots?: boolean;
  /** Values for `{{secret:NAME}}` placeholders. */
  secrets?: Record<string, string> | Secrets;
  /** Directories the agent may upload files from; none disables uploads. */
  uploadDirs?: string[];
  /** Keep the tab(s) open at the end. */
  keepTab?: boolean;
  /** Work in this existing tab instead of opening one (it is never closed). */
  targetId?: string;
  /** Steps kept in full in the prompt; older ones become one-line summaries (default 3). */
  historyWindow?: number;
  /** Character budget of one observation, ~4 characters per token (default 12000). */
  observationChars?: number;
  /** Most actions executed from one model turn (default 6). */
  maxActionsPerStep?: number;
  /** Output tokens per model turn (default 4096). */
  maxTokens?: number;
  /** Pause the task and give it notes between model turns. */
  steering?: TaskSteering;
}

/** A timeout whose clock can be stopped and started again. */
function pausableTimeout(ms: number) {
  const controller = new AbortController();
  let remaining = ms;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    startedAt = Date.now();
    timer = setTimeout(() => controller.abort(new DOMException(`timed out after ${ms} ms`, "TimeoutError")), remaining);
    (timer as { unref?: () => void }).unref?.();
  };
  run();
  return {
    signal: controller.signal,
    pause() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    resume() {
      if (!timer && !controller.signal.aborted) run();
    },
    clear() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

const EXTRACT_SYSTEM = "You answer a question using only the given web page content. Be precise and concise; quote exact values (numbers, names, versions). If the content does not contain the answer, say so.";
const EXTRACT_CHARS = 40_000;

/** Settle with the signal's reason as soon as it aborts; the abandoned work's later failure is swallowed. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const text = (value: string): ContentPart => ({ type: "text", text: value });

function shortArgs(args: Record<string, unknown>): string {
  const rendered = JSON.stringify(args);
  return rendered.length > 120 ? `${rendered.slice(0, 119)}…` : rendered;
}

export async function runTask(options: RunTaskOptions): Promise<TaskResult> {
  if (!options.goal.trim()) throw new Error("goal is empty");
  if (!options.cdpEndpoint && !options.connection) throw new Error("cdpEndpoint or connection is required");
  const model = typeof options.model === "string" ? createModel(options.model) : options.model;
  const secrets = options.secrets instanceof Secrets ? options.secrets : new Secrets(options.secrets ?? {});
  const uploads = new UploadPolicy(options.uploadDirs ?? []);
  const maxSteps = options.maxSteps ?? 25;
  const window = options.historyWindow ?? 3;
  const observationOptions = { maxChars: options.observationChars ?? 12_000, screenshot: options.screenshots ?? false };
  const maxActions = options.maxActionsPerStep ?? 6;
  const clock = pausableTimeout(options.timeoutMs ?? 600_000);
  const timeout = clock.signal;
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const steering = options.steering;
  const tools = taskTools({ uploads: uploads.enabled, ...(options.resultSchema ? { resultSchema: options.resultSchema } : {}) });
  const intro = taskIntro({ goal: options.goal, ...(options.startUrl ? { startUrl: options.startUrl } : {}), ...(options.resultSchema ? { resultSchema: options.resultSchema } : {}), secretNames: secrets.names, uploadDirs: uploads.directories, maxSteps });

  const steps: StepLog[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let browser: TaskBrowser | undefined;
  let lastUrl: string | undefined;

  const finish = (status: TaskStatus, summary: string, extra: Partial<TaskResult> = {}): TaskResult => ({
    status,
    summary: secrets.redact(summary),
    steps,
    usage,
    ...(lastUrl ? { url: lastUrl } : {}),
    ...(options.keepTab && browser ? { targetId: browser.active.targetId } : {}),
    ...secrets.redactValue(extra),
  });
  const addUsage = (stepUsage: TokenUsage, add: TokenUsage) => {
    stepUsage.inputTokens += add.inputTokens;
    stepUsage.outputTokens += add.outputTokens;
    usage.inputTokens += add.inputTokens;
    usage.outputTokens += add.outputTokens;
  };
  const record = (step: StepLog) => {
    steps.push(step);
    try { options.onStep?.(step); } catch { /* a logging callback must not break the task */ }
  };
  const observeNow = async (): Promise<{ observation: Observation; parts: ContentPart[] }> => {
    const observation = await abortable(observe(browser!, observationOptions, browser!.drainNotices()), signal);
    lastUrl = observation.url;
    const parts: ContentPart[] = [text(`Current page:\n${secrets.redact(observation.text)}`)];
    if (observation.screenshot) parts.push({ type: "image", mediaType: "image/jpeg", data: observation.screenshot });
    return { observation, parts };
  };

  try {
    browser = await abortable(TaskBrowser.open({
      ...(options.connection ? { connection: options.connection } : { cdpEndpoint: options.cdpEndpoint! }),
      ...(options.cdpHeaders ? { headers: options.cdpHeaders } : {}),
      ...(options.targetId ? { targetId: options.targetId } : {}),
    }), signal);
    const context: ActionContext = { browser, secrets, uploads };
    if (options.startUrl) await abortable(ACTIONS.navigate!(context, { url: options.startUrl }), signal);
    let current = await observeNow();
    let initial = current.parts;
    const history: HistoryStep[] = [];

    /** Wait at the steering checkpoint; its notes and a fresh observation follow the newest message. */
    const checkpoint = async () => {
      if (!steering) return;
      clock.pause();
      let resumed: Awaited<ReturnType<TaskSteering["checkpoint"]>>;
      try {
        resumed = await abortable(steering.checkpoint(signal), signal);
      } finally {
        clock.resume();
      }
      const { notes } = resumed;
      if (resumed.targetId && browser!.focus(resumed.targetId)) browser!.drainNotices();
      if (!notes.length) return;
      current = await observeNow();
      const added = [text(`Notes from the person supervising this task:\n${notes.map((note) => `- ${note}`).join("\n")}`), ...current.parts];
      const last = history.at(-1);
      if (!last) {
        initial = added;
      } else if (last.followUp.role === "user") {
        last.followUp.content = [...last.followUp.content.filter((part) => part.type === "text"), ...added];
      } else {
        const result = last.followUp.results.at(-1)!;
        result.content = [...result.content.filter((part) => part.type === "text"), ...added];
      }
    };

    for (let step = 1; step <= maxSteps; step += 1) {
      await checkpoint();
      const turn = steering?.turn();
      const started = Date.now();
      const stepUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let response: Awaited<ReturnType<ChatModel["complete"]>>;
      try {
        response = await model.complete({
          system: SYSTEM_PROMPT,
          messages: buildMessages(intro, initial, history, window),
          tools,
          maxTokens: options.maxTokens ?? 4_096,
          signal: turn ? AbortSignal.any([signal, turn]) : signal,
        });
      } catch (error) {
        // A turn cut short before the model answered uses no step.
        if (turn?.aborted && !signal.aborted) {
          step -= 1;
          continue;
        }
        throw error;
      }
      addUsage(stepUsage, response.usage);
      const acted = { url: current.observation.url, title: current.observation.title, ...(current.observation.captcha ? { captcha: current.observation.captcha } : {}) };
      const log: StepLog = { step, ...acted, thought: secrets.redact(response.text), actions: [], usage: stepUsage, durationMs: 0 };
      const assistant = { role: "assistant" as const, text: response.text, toolCalls: response.toolCalls };

      if (!response.toolCalls.length) {
        current = await observeNow();
        history.push({
          assistant,
          followUp: { role: "user", content: [text(`You did not call a tool. Every reply must call at least one tool (done, fail or needs_input to finish). Step ${step} of ${maxSteps} used.`), ...current.parts] },
          summary: `${step}. (no tool call)`,
        });
        record({ ...log, durationMs: Date.now() - started });
        continue;
      }

      const results: ToolResult[] = [];
      const actionCount = response.toolCalls.filter((call) => !TERMINAL_TOOLS.has(call.name)).length;
      let skipReason: string | undefined;
      let outcome: TaskResult | undefined;
      const respond = (call: ToolCall, output: string, ok: boolean) => {
        const redacted = secrets.redact(output);
        results.push({ toolCallId: call.id, name: call.name, content: [text(redacted)], ...(ok ? {} : { isError: true }) });
        const ref = call.arguments.ref;
        const target = typeof ref === "string" ? current.observation.targets.get(ref) : undefined;
        log.actions.push({ tool: call.name, args: secrets.redactValue(call.arguments), ok, output: redacted, ...(target ? { target: secrets.redact(target) } : {}) });
      };

      for (const [index, call] of response.toolCalls.entries()) {
        if (!skipReason && turn?.aborted) skipReason = "the turn was interrupted by the person supervising this task";
        if (skipReason || index >= maxActions) {
          respond(call, `not executed: ${skipReason ?? `at most ${maxActions} actions per step`}`, false);
          continue;
        }
        if (call.argumentsError) {
          respond(call, `error: ${call.argumentsError}`, false);
          skipReason = "an earlier call in this step failed";
          continue;
        }
        if (TERMINAL_TOOLS.has(call.name)) {
          if (actionCount > 0) {
            respond(call, `not accepted: call ${call.name} on its own, after you have seen the outcome of your actions`, false);
            continue;
          }
          const args = call.arguments;
          if (call.name === "done") {
            const problems = options.resultSchema ? validateSchema(args.result, options.resultSchema, "result") : args.result === undefined ? ["result: required"] : [];
            if (problems.length) {
              respond(call, `error: the result does not match the schema: ${problems.slice(0, 10).join("; ")}`, false);
              continue;
            }
            respond(call, "accepted", true);
            outcome ??= finish("done", typeof args.summary === "string" ? args.summary : "done", { result: args.result });
          } else if (call.name === "fail") {
            respond(call, "accepted", true);
            outcome ??= finish("failed", typeof args.reason === "string" ? args.reason : "the agent gave up");
          } else {
            const question = typeof args.question === "string" ? args.question : "the agent needs more input";
            respond(call, "accepted", true);
            outcome ??= finish("needs_input", question, { question });
          }
          continue;
        }
        const tab = browser.active;
        const navigationsBefore = tab.navigations;
        try {
          let output: string;
          if (call.name === "extract") {
            const question = typeof call.arguments.question === "string" ? call.arguments.question : "";
            if (!question) throw new Error("missing argument question");
            const content = secrets.redact(await abortable(pageText(browser, EXTRACT_CHARS), signal));
            const answer = await model.complete({
              system: EXTRACT_SYSTEM,
              messages: [{ role: "user", content: [text(`Question: ${question}\n\nPage: ${browser.active === tab ? current.observation.url : "(new tab)"}\n\nPage content:\n${content}`)] }],
              maxTokens: 2_000,
              signal: turn ? AbortSignal.any([signal, turn]) : signal,
            });
            addUsage(stepUsage, answer.usage);
            output = answer.text || "(no answer)";
          } else {
            const action = ACTIONS[call.name];
            if (!action) throw new Error(`unknown tool ${call.name}`);
            output = await abortable(action(context, call.arguments), signal);
          }
          respond(call, output, true);
          if (browser.active !== tab || tab.navigations !== navigationsBefore) skipReason = "the page changed; look at the new observation first";
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          respond(call, `error: ${errorMessage(error)}`, false);
          skipReason = "an earlier action in this step failed";
        }
      }

      if (outcome) {
        record({ ...log, durationMs: Date.now() - started });
        return outcome;
      }
      current = await observeNow();
      const last = results.at(-1)!;
      last.content.push(text(`Step ${step} of ${maxSteps} used.`), ...current.parts);
      history.push({
        assistant,
        followUp: { role: "tool", results },
        summary: `${step}. ${log.actions.map((action) => `${action.tool}${shortArgs(action.args)} → ${action.output.split("\n")[0]!.slice(0, 160)}`).join("; ")} (then at ${current.observation.url})`,
      });
      record({ ...log, durationMs: Date.now() - started });
    }
    return finish("step_limit", `Stopped after ${maxSteps} steps without finishing.`);
  } catch (error) {
    if (timeout.aborted) return finish("timeout", `Timed out after ${Math.round((options.timeoutMs ?? 600_000) / 1000)} s.`);
    if (options.signal?.aborted) return finish("failed", "Aborted.");
    return finish("failed", `Error: ${errorMessage(error)}`);
  } finally {
    clock.clear();
    // Only tabs this run opened are closed; an existing `targetId` tab never is.
    await browser?.close(options.keepTab === true).catch(() => undefined);
  }
}
