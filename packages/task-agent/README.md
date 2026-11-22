# @browser-fabric/task-agent

A small browser task agent: give it a goal in natural language and a Chromium CDP endpoint, and an
LLM drives the browser (clicks, typing, navigation, uploads) until the goal is done. It returns a
structured result, optionally validated against a JSON Schema, and a log of every step.

It has no dependencies beyond Bun and the repository's CDP client, talks to Anthropic Messages or any
OpenAI-compatible chat-completions API with plain `fetch`, and works against any browser-level CDP
endpoint: `fabric up`, a Fabric remote browser, or a Chromium you started with
`--remote-debugging-port`. From the shell it is `fabric task` (see [docs/agents.md](../../docs/agents.md)).

```ts
import { runTask } from "@browser-fabric/task-agent";

const result = await runTask({
  cdpEndpoint: "http://127.0.0.1:9222",
  goal: "Find the latest release version of bun",
  startUrl: "https://github.com/oven-sh/bun",
  resultSchema: { type: "object", properties: { version: { type: "string" } }, required: ["version"] },
  model: "anthropic/claude-sonnet-4-5",          // or a ChatModel instance
  onStep: (step) => console.error(step.step, step.actions.map((action) => action.tool)),
});
// { status: "done", result: { version: "1.4.4" }, summary: "…", steps: [...], usage: {...} }
```

## API

`runTask(options): Promise<TaskResult>` never throws for task failures; it returns a status.

| Option | Default | |
| --- | --- | --- |
| `cdpEndpoint` / `connection` | — | Browser-level endpoint (`http(s)://host:port` or `ws(s)://…/devtools/browser/…`), or an open `CdpConnection` (left open). `cdpHeaders` for an authenticated websocket. |
| `goal`, `startUrl` | — | The task, and an optional first page. |
| `resultSchema` | text | JSON Schema the `done` result must match; a mismatch is sent back to the model to fix. |
| `model` | — | `anthropic/<id>` or `openai/<id>` (keys from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, endpoints from `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`), or any `ChatModel`. |
| `maxSteps` | 25 | Model turns before `step_limit`. |
| `timeoutMs` | 600000 | Wall-clock limit before `timeout`; also cancels a model call in flight. |
| `signal` | — | Abort from outside (`failed`, "Aborted."). |
| `secrets` | none | Values for `{{secret:NAME}}` placeholders (`Secrets.fromEnvironment()` reads `FABRIC_SECRET_<NAME>`). |
| `uploadDirs` | none | Directories files may be uploaded from; uploads are disabled without one. |
| `screenshots` | false | Attach a JPEG of the viewport to each observation (vision models). |
| `keepTab` / `targetId` | false / — | Keep the tab open at the end and return its id; continue in an existing tab (never closed). |
| `historyWindow` | 3 | Steps kept in full in the prompt; older ones become one-line summaries. |
| `observationChars` | 12000 | Character budget of one observation (~3k tokens). |
| `maxActionsPerStep` | 6 | Actions executed from one model reply. |
| `onStep` | — | Called with each `StepLog` as it completes. |

`TaskResult`: `status` (`done`, `failed`, `needs_input`, `step_limit`, `timeout`), `result` (for
`done`), `summary`, `question` (for `needs_input`), `steps` (`StepLog[]`: url, title, the model's text,
each action with redacted arguments, success and output, token usage, duration), `url`, `targetId`
(with `keepTab`) and total `usage`.

Lower-level pieces are exported too: `TaskBrowser` (tab and frame sessions), `observe()`, `ACTIONS`,
`AnthropicModel` / `OpenAiModel` / `createModel()`, `Secrets`, `UploadPolicy`, `validateSchema()`.

## How it works

**Its own tab.** The agent creates a tab with `Target.createTarget` and closes it (and any popups it
opened) at the end. Popups (`target=_blank`, `window.open`) become the active tab; when one closes,
the agent returns to the previous tab. JavaScript dialogs are accepted (prompts dismissed) and
reported to the model, and native file choosers are intercepted (in out-of-process frames too):
`upload` answers the one its click opens, any other is closed without files and reported.

**Observation.** Each step the agent reads every frame of the tab: same-process frames through the
page's own session, out-of-process iframes (cross-site, via `Target.setAutoAttach`) through theirs,
nested ones included. In each frame a script runs in an isolated world (invisible to page scripts;
no `Runtime.enable`) and lists the visible interactive elements, walking open shadow roots:

```
[e9] link "Sign in" → /login?return_to=…
[e34] searchbox "Find a release"
[e3] combobox "Country" value="Germany" options="Choose… | Germany | France"
-- frame f2 (cross-origin) https://pay.example/widget
[f2e1] button "Pay now"
```

Roles, accessible names (aria-labelledby, aria-label, `<label>`, placeholder, text, alt/title),
values (passwords masked), states (checked, disabled, required, expanded, focused, …), select
options and link targets. Hidden elements are left out: `display:none`, `visibility:hidden`,
`opacity:0`, zero size, `inert`, off to the side. Checkboxes styled through their `<label>`,
`cursor:pointer` click targets and scroll containers are included. Refs stay the same while the
document lives, so the model can batch actions. When the budget is exceeded, the elements closest
to the visible area are kept and the rest counted ("327 more not shown"). The observation also has
the URL, title, scroll position, an excerpt of the page text, and notices (dialogs, new tabs).
When the browser's CAPTCHA guardian saw a challenge on the page, a `Captcha:` line shows its state
from `<html data-captcha-state data-captcha-detail>`: `solving (tencent-slider)`, `solved` or
`failed: <detail>`. The agent never solves a CAPTCHA widget itself: it waits while one is solving
and reports a failure. Only a page's own distorted-text or arithmetic CAPTCHA may be typed.

**Actions** (the model's tools): `navigate` (http/https only), `back`, `click`, `type` (replace or
append, optional Enter), `select` (native `<select>`), `press` (keys and chords), `scroll` (page or
inside an element), `upload` (to a file input, or to the control that opens one: an "Add file"
button or a drop area, which it clicks and whose file chooser it answers; a file input styled out of
sight is listed by its visible label or the area holding it), `wait` (for text or time; returns early when a CAPTCHA being solved
ends solved or failed), `extract` (answers a question from the
whole page text in a separate model call), and the terminal `done`, `fail` and `needs_input`.
Clicks are trusted input: the element is scrolled into view (and its frames in their parents), its
center taken from `DOM.getContentQuads` plus the offsets of out-of-process frames, a hit test
refuses a click that something else (a cookie banner) would receive, and `Input.dispatchMouseEvent`
presses there. Text goes in with `Input.insertText` after a trusted click; date, time, color and
range inputs get their value set as a picker would. After the actions of a reply the agent waits for
navigation and a quiet DOM, then observes again. A batch stops at the first error or page change;
`done` is accepted only on its own, after the model has seen the outcome of its actions.

**Prompt.** A short system prompt and the tools are sent unchanged each step (cached by Anthropic).
The history keeps the last `historyWindow` steps in full and earlier ones as one-line summaries;
only the newest observation carries a screenshot.

## Safety

- **Secrets** are typed only as `{{secret:NAME}}`. The value is substituted at typing time and
  replaced by its placeholder in everything the model reads, the step log and the result, even when
  a page echoes it back. Only explicitly provided secrets resolve (`FABRIC_SECRET_*` from the CLI),
  never arbitrary environment variables. Values shorter than three characters are typed but not
  redacted.
- **Uploads** must resolve, after symlinks, to a regular file inside an allowed directory.
- **Bounds**: steps, wall-clock time (including a model call in flight), observation size, actions
  per reply and output tokens per turn. Model calls retry on 429, 5xx, 529 and network errors with
  backoff, honoring `Retry-After`.
- Page text is data: the system prompt tells the model to ignore instructions found on pages. That
  reduces but does not eliminate prompt injection; give the agent a browser profile and secrets
  scoped to the task.

## Limitations

- Closed shadow roots are not read (open ones are), and canvas-only UIs show no elements; a vision
  model with `screenshots` sees them but can only act through refs.
- Out-of-process frames report their elements' distance relative to their own viewport, not the
  page's.
- Uploads name files on the machine running the agent; with a remote browser, the file must exist at
  the same path where the browser runs.
- `needs_input` ends the run; continue with a second run in the kept tab (`keepTab`, `targetId`).
- Keyboard shortcuts that the OS handles (for example Cmd+A on macOS) are sent as key events only;
  use `type` with `clear` instead of select-all chords.

## Tests

`tests/task-agent-*.test.ts`: provider adapters and retries against mocked HTTP, secrets, uploads and
schema validation, observation and actions against a real headless Chromium (throwaway profile,
cross-site frames through `--host-resolver-rules`), an end-to-end run with a scripted model, and the
CLI through a fake OpenAI-compatible server. Browser tests use `$FABRIC_TEST_CHROMIUM`, Playwright's
Chromium or a system Chrome, and are skipped when none is found.
