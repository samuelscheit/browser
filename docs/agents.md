# Browsers for agents: the `fabric` CLI

`fabric` gives an agent (or a person) a real Chromium it can script **and** drive interactively,
behind one stable, unauthenticated loopback address that every CDP tool understands:

| Command | Browser | Endpoint |
| --- | --- | --- |
| `fabric up` | **Your everyday Chrome** with your real profile: agents share your logins, and you see what they do (default, named `local`) | `http://127.0.0.1:9222` |
| `fabric up --profile <name>` | A separate Chrome fabric starts, profile in `~/.config/fabric/profiles/<name>`, named `<name>` (runs alongside `local`) | `http://127.0.0.1:9224+` |
| `fabric up --headless` | The same, headless (profile and browser name `agent` unless `--profile` / `--name`) | `http://127.0.0.1:9224+` |
| `fabric up --remote` | Remote Fabric browser from your deployment, with a persistent profile (logins survive, named `remote`) | `http://127.0.0.1:9223` |
| `fabric up --remote --fresh` | Remote Fabric browser with a throwaway profile | `http://127.0.0.1:9223` |

Every command (`up`, `mcp`, `goto`, `shot`, `eval`, `tabs`, `view`, `down`) uses the local browser
unless it gets `--remote`.

`fabric up` is idempotent: run it before every task. A running browser with the same settings is
reused, so several agents share one browser (each with its own CDP connection and tabs) instead of
fighting over the persistent profile.

## Your own Chrome (the default)

Chrome ignores `--remote-debugging-port` on the everyday profile since Chrome 136, so fabric never
restarts Chrome with flags. It uses Chrome's own switch (Chrome 144+) instead:

1. **Once:** open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging. If it
   is off, `fabric up` opens that page for you and waits (up to 3 minutes) until you enable it.
   Chrome remembers the setting. If Chrome is not running, fabric starts it the normal way
   (`open -a "Google Chrome"`).
2. **Each time fabric connects:** Chrome asks “Allow remote debugging?”. Click **Allow**. `fabric up`
   prints a reminder and waits up to 3 minutes. Declining fails with “declined”, and no answer fails
   with “unanswered”. Neither is retried automatically, because every retry would be another
   prompt. While connected, Chrome shows its “controlled by automated test software” banner.

Chrome asks once per WebSocket, so the fabric daemon opens exactly **one** connection to Chrome and
multiplexes every client over it: Playwright, Puppeteer, both MCP servers, the live view, the quick
actions and the CAPTCHA guardian. After the first Allow, nothing prompts again until `fabric down`
or until Chrome quits. If Chrome quits, the next client reconnects once, which means one new Allow.
Chrome's toggle server has no `/json/*` and no page sockets; fabric serves both itself on `:9222`.

What fabric does in your Chrome:

- `fabric down` (and every client that leaves) only **detaches**. It never quits Chrome, and it
  never closes your tabs.
- Each client gets its own sessions. One client's `setAutoAttach`, target events and sessions never
  reach another client. A client's `Browser.close` closes only the tabs and contexts that client
  created; `Browser.crash` is refused. Browser-wide settings a client made, such as download
  behaviour, permission overrides and browser-level `Fetch`, are undone when it leaves.
- Tabs an agent opens (and popups they open) are **agent tabs** (`agentTab: true` in `/json/list`,
  `*` in `fabric tabs`). The quick actions (`goto`, `eval`, `shot`) use the most recent agent tab
  and open a new one when there is none, so they never take over the tab you are working in.
  `--tab` can still pick any tab.
- The CAPTCHA guardian watches **agent tabs only** (and their out-of-process frames). It runs over the
  same connection, so it adds no prompt.
- Playwright (`connectOverCDP`) redirects downloads of the whole browser into its temp folder while
  it is connected. fabric restores Chrome's default when the last client that changed it leaves.

## Setup (once per machine)

```sh
ln -sf "$PWD/apps/cli/src/cli.ts" ~/.bun/bin/fabric      # from this checkout; needs bun on PATH
fabric whoami                                            # local mode needs no login

# Only for --remote: a principal of your deployment (deploy/compose). The password of
# principal_<name> is the file deploy/compose/secrets/principals/<name> on the Fabric host.
fabric login --url https://fabric.example.com --username agent < /path/to/agent-password
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

Quick actions act on the **current agent tab** (the one most recently created, navigated or
activated; `--tab <index|id>` picks another and makes it current). Pass `--profile <name>` or
`--name <name>` to target a specific running browser — if that browser is not running, the action
fails instead of falling back to your everyday Chrome. Without `--name` or `--profile`, a quick
action uses the sole running browser for that mode, starts the default browser if none is running,
or asks you to pass `--name` / `--profile` when several browsers are running:

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
claude mcp add --scope user fabric -- fabric mcp                     # your own Chrome
claude mcp add --scope user fabric-remote -- fabric mcp --remote     # remote browser
```

Arguments after `--` go to the MCP server, e.g. `fabric mcp -- --caps vision`.

The MCP server only starts the endpoint; the browser itself starts on the first browser tool call,
so a Claude session that never browses causes no Allow prompt and holds no remote browser.

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
  (about 5 s). Logins in the persistent profile survive; open tabs do not. A local Chrome stays
  connected until `fabric down`. Your own Chrome is then detached, and a Chrome fabric started is
  quit.
- **TTL:** a remote session lives at most `--ttl` (default and maximum 4 h); the next client then
  gets a new one.
- **Capacity:** a deployment runs at most `FABRIC_MAX_ACTIVE_BROWSER_LEASES` browsers, and each
  headful browser needs a free worker slot. When none is free,
  `fabric up --remote` explains it after 60 s; use `--fresh` (does not wait for the persistent
  profile) or the local browser.
- A persistent profile (for example `profile_default` of deploy/compose) is used by one session at a time. If another machine holds it,
  `fabric up --remote` says so; `fabric up --remote --fresh` or the local browser always work.
- Every endpoint uses one upstream connection however many clients it serves, so a remote
  session's limit of eight CDP clients is never the bottleneck.
- CAPTCHAs are solved automatically in every mode (in your own Chrome, only in agent tabs) by the
  same llm-captcha guardian every Fabric browser runs. Locally it has no model, so it solves
  checkboxes (Turnstile, reCAPTCHA), sliders and press-and-hold; a remote browser also solves image
  and text challenges. Before acting on a page, wait while `<html data-captcha-state>` reads `solving`.

## Security

The endpoint binds to `127.0.0.1` only and, like Chrome's own DevTools server, rejects requests
whose `Host` is not a loopback address of the endpoint (DNS rebinding) and WebSocket upgrades from
any web origin other than the live view itself or `devtools://devtools`. Anyone who can run code as
your user can drive the browser, exactly as with `--remote-debugging-port`.

## Several browsers

`--profile <name>` automatically names the browser `<name>` and gives it a free port from 9224, so
`fabric up --headless --profile research` runs alongside your everyday Chrome (`local` on `:9222`)
without needing `--name`; target it with `fabric goto example.com --profile research` (or
`--name research`) and stop it with `fabric down research` (or `fabric down --profile research`).
`--name <name>` also runs additional browsers side by side, e.g.
`fabric up --remote --fresh --name research` and `fabric goto example.com --name research`.

## Using the API directly

Everything the CLI does is plain Fabric API: `GET /v1/me` lists the projects, profiles, recipes and
policies the caller may use, `POST /v1/browser-sessions` (with an `Idempotency-Key` header) starts a
session, and its `cdpEndpoint` accepts a browser-level CDP WebSocket with the same Basic credential.
The Basic username is the principal ID, e.g. `principal_agent`. `fabric up --remote` defaults to
the catalog's interactive (headful) recipe, its `direct` egress and the matching profile `GET /v1/me` offers;
`--project`, `--profile`, `--recipe` and `--egress` select others.
