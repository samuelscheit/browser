# Browsers for agents: the `fabric` CLI

`fabric` gives an agent (or a person) a real Chromium it can script **and** drive interactively,
behind one stable, unauthenticated loopback address that every CDP tool understands:

| Command | Browser | Endpoint |
| --- | --- | --- |
| `fabric up` | Chrome on this machine, own profile in `~/.config/fabric/profiles/agent`, visible window (default) | `http://127.0.0.1:9222` |
| `fabric up --remote` | Remote Fabric browser on fabric-host with the persistent agent profile (logins survive) | `http://127.0.0.1:9223` |
| `fabric up --remote --fresh` | Remote Fabric browser with a throwaway profile | `http://127.0.0.1:9223` |

Every command (`up`, `mcp`, `goto`, `shot`, `eval`, `tabs`, `view`, `down`) uses the local browser
unless it gets `--remote`.

`fabric up` is idempotent: run it before every task. A running browser with the same settings is
reused, so several agents share one browser (each with its own CDP connection and tabs) instead of
fighting over the persistent profile.

## Setup (once per machine)

```sh
ln -sf "$PWD/apps/cli/src/cli.ts" ~/.bun/bin/fabric      # from this checkout; needs bun on PATH
ssh fabric-host cat /etc/compose/browser-fabric-secrets/fabric_api_password_agent \
  | fabric login --url https://fabric.example.com --username agent
fabric whoami
```

Credentials live in `~/.config/fabric/credentials.json` (mode 600). `FABRIC_URL`, `FABRIC_USERNAME`
and `FABRIC_PASSWORD` override it. The local browser needs no credentials; only `--remote` does.

## Driving the browser

```js
// Playwright
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
// Puppeteer
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
```

Quick actions (they start the browser when needed and act on the **current tab**, the one most
recently created, navigated or activated; `--tab <index|id>` picks another and makes it current):

```sh
fabric goto news.ycombinator.com        # waits for load, prints title and URL
fabric eval 'document.title'            # JSON result; --json for machine output
fabric shot page.png --full             # full-page screenshot
fabric tabs                             # list tabs
```

### MCP

`fabric mcp` is a stdio MCP server: it makes sure the browser runs, then hands over to
[Playwright MCP](https://github.com/microsoft/playwright-mcp) (default) or
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`--server devtools`),
both attached to the same browser:

```sh
claude mcp add --scope user fabric -- fabric mcp                     # local Chrome
claude mcp add --scope user fabric-remote -- fabric mcp --remote     # remote browser
```

Arguments after `--` go to the MCP server, e.g. `fabric mcp -- --caps vision`.

The MCP server only starts the endpoint; the browser itself starts on the first browser tool call,
so a Claude session that never browses opens no Chrome window and holds no remote browser.

### Live view: watch and take over

`fabric view` opens `http://127.0.0.1:<port>/` in your browser: the current tab streamed live, with
tabs, an address bar, back/forward/reload, mouse, wheel, keyboard and paste forwarded to the page.
Use it to solve a login or a CAPTCHA by hand, then let the agent continue. New tabs an agent opens
are followed automatically. For full DevTools on a remote tab, open the `devtoolsFrontendUrl` from
`http://127.0.0.1:9223/json/list` in Chrome.

### Tasks in natural language: `fabric task`

`fabric task` hands a goal to a small LLM agent that drives the same browser (its own tab) until the
task is done, and prints the result. It works with Anthropic models and with any OpenAI-compatible
chat-completions server.

```sh
export ANTHROPIC_API_KEY=…                       # or OPENAI_API_KEY (+ OPENAI_BASE_URL)
fabric task "find the latest release version of bun" --url https://github.com/oven-sh/bun \
  --model anthropic/claude-sonnet-4-5
FABRIC_SECRET_PASSWORD=… fabric task "sign in as alice and download the March invoice" \
  --url https://billing.example --schema invoice.schema.json --upload-dir ~/invoices --json
```

- `--schema <file>` makes the result a JSON value that matches the JSON Schema; without it the
  result is text. `--json` prints the whole result with every step.
- The agent sees `{{secret:NAME}}` placeholders for `FABRIC_SECRET_<NAME>` variables, never their
  values. A value is inserted only when it is typed into the page, and is redacted wherever it would
  appear in what the model reads, in the step log and in the result.
- When it needs something it does not have (a one-time code, a missing password), it stops with
  status `needs_input` (exit code 2) and a question. `--keep-tab` keeps the tab open, and
  `--target <id>` continues in it; `fabric view` lets you do the step by hand in between.
- Limits: `--max-steps` (default 25) model turns and `--timeout` (default 10m) wall-clock time.
  Uploads are refused unless the file is inside an `--upload-dir`.

The agent is the [`@browser-fabric/task-agent`](../packages/task-agent/README.md) library; call
`runTask()` from code for the same thing with an `onStep` callback.

## Lifecycle and limits

- The endpoint is served by a small background daemon (`fabric status`, logs in
  `~/.config/fabric/run/<name>.log`). `fabric down [name|--all]` stops it and releases the browser.
- **Idle release:** after `--idle` minutes (default 10) without any CDP client the remote browser is
  released, so it never blocks shared capacity. The next client starts a new one automatically
  (about 5 s). Logins in the persistent profile survive; open tabs do not. A local Chrome keeps
  running until `fabric down`.
- **TTL:** a remote session lives at most `--ttl` (default and maximum 4 h); the next client then
  gets a new one.
- **Capacity:** fabric-host runs at most three interactive Chromium browsers (shared with CHAT) and six
  browsers in total. When none is free, `fabric up --remote` explains it after 60 s; use `--fresh`
  (does not wait for the persistent profile) or the local browser.
- The persistent `profile_agent` is used by one session at a time. If another machine holds it,
  `fabric up --remote` says so; `fabric up --remote --fresh` or the local browser always work.
- One remote session accepts up to eight CDP clients (an MCP, scripts, the live view and the
  daemon's keep-alive connection share it).
- Turnstile checkboxes are clicked automatically in both modes (the same guardian every Fabric
  browser runs).

## Security

The endpoint binds to `127.0.0.1` only and, like Chrome's own DevTools server, rejects requests
whose `Host` is not a loopback address of the endpoint (DNS rebinding) and WebSocket upgrades from
any web origin other than the live view itself or `devtools://devtools`. Anyone who can run code as
your user can drive the browser, exactly as with `--remote-debugging-port`.

## Several browsers

`--name <name>` runs additional browsers side by side (they get ports from 9224), e.g.
`fabric up --remote --fresh --name research` and `fabric goto example.com --name research`.

## Using the API directly

Everything the CLI does is plain Fabric API: `GET /v1/me` lists the projects, profiles, recipes and
policies the caller may use, `POST /v1/browser-sessions` (with an `Idempotency-Key` header) starts a
session, and its `cdpEndpoint` accepts a browser-level CDP WebSocket with the same Basic credential.
The Basic username is the principal ID, e.g. `principal_agent`.
