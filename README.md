# Browser Fabric

Browser Fabric is self-hosted browser infrastructure for automation and AI agents. It hands out
real Chrome browsers as leased sessions behind a plain CDP endpoint — so Playwright, Patchright,
Puppeteer, MCP servers and agent frameworks work unchanged — and takes care of everything around
them: scheduling and capacity, persistent profiles, network egress policy, challenge handling,
artifacts, and an audited, multi-tenant control plane.

It runs in two shapes:

- **Locally, for one person and their agents:** the `fabric` CLI attaches to *your everyday
  Chrome* (or a separate Chrome) and serves it on `http://127.0.0.1:9222` to any number of CDP
  clients at once, with a live view to watch and take over.
- **Self-hosted, for teams and services:** a Docker Compose stack runs the control plane and
  launches one hardened, sandboxed Chrome container per lease — headful on a private display or
  headless — reachable through an authenticated CDP gateway.

## Features

- **Real Chrome, your driver** — Google Chrome stable (amd64) or Debian Chromium (arm64), pinned
  to exact builds. Bring Playwright, Patchright, Puppeteer, Rebrowser or raw CDP; the browser is the
  same for all of them.
- **Raw CDP sessions** — `POST /v1/browser-sessions` returns a short-lived, capability-scoped
  WebSocket; up to eight clients may share one browser. `recipe_chrome@1` is headful on a private
  X display (live view and takeover), `recipe_chrome-headless@1` headless.
- **Typed jobs** — versioned recipes with retries, normalized challenge/manual/auth states and
  just-in-time encrypted input requests, so passwords, OTPs and cookies never land in job payloads.
- **Profiles** — persistent browser profiles on worker-local volumes with exclusive writer leases,
  disposable clones and verified relocation. The browser is closed through CDP so logins survive.
- **Egress policy** — every browser reaches the internet only through an egress sidecar and a
  fail-closed PAC: direct, upstream proxy (or an ordered proxy list), Tor, per-host and static-asset
  exceptions.
- **Turnstile and DataDome guardian** — a process-level companion in every Fabric browser clicks
  Cloudflare Turnstile checkboxes and slides DataDome's slider with bounded, human-like gestures,
  independent of the client that drives the page.
- **CAPTCHA token solvers** — opt-in reCAPTCHA v2 solving through Death by Captcha or Anti-Captcha,
  per recipe, with provider keys that never enter a browser.
- **Consistent fingerprint** — a GPU-less server browser reports an ordinary desktop GPU instead of
  SwiftShader, keeps WebGL when headful, and presents a normal Chrome User-Agent when headless.
- **Artifacts** — immutable screenshots, traces, HARs and downloads in S3-compatible storage with
  30-day retention and short-lived signed URLs.
- **Catalog** — add your own recipes, egress policies, challenge sets and projects in one JSON file,
  no code change ([docs/catalog.md](docs/catalog.md)).
- **Task agent** — `fabric task "<goal>"` lets a small LLM agent (Anthropic or any OpenAI-compatible
  model) drive the browser in its own tab until the goal is done and returns a result, optionally
  matching a JSON Schema ([packages/task-agent](packages/task-agent/README.md)).
- **Clients** — TypeScript (`packages/client-ts`) and Python (`packages/client-python`), plus an
  [OpenAPI spec](packages/contracts/openapi/browser-fabric.openapi.yaml).

## Quickstart: your own Chrome for your agents

Requirements: [Bun](https://bun.sh) and Chrome 144 or newer.

```sh
git clone https://github.com/samuelscheit/browser.git browser-fabric && cd browser-fabric
bun install
ln -sf "$PWD/apps/cli/src/cli.ts" ~/.bun/bin/fabric
fabric up
```

The first time, `fabric up` opens `chrome://inspect/#remote-debugging`: enable remote debugging
there (Chrome remembers it). Chrome then asks **“Allow remote debugging?”** once per `fabric up`;
click **Allow**. From then on every client shares that one connection:

```js
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");        // Playwright
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" }); // Puppeteer
```

```sh
fabric goto example.com        # quick actions use an agent tab, never the tab you work in
fabric shot page.png --full
fabric view                    # live view: watch, click, type, take over
fabric down                    # detaches; never quits Chrome or closes your tabs
```

Prefer an isolated browser? `fabric up --profile research` starts a separate Chrome with its own
profile; `--headless` runs it headless.

### MCP

`fabric mcp` is a stdio MCP server ([Playwright MCP](https://github.com/microsoft/playwright-mcp) by
default, `--server devtools` for [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp))
attached to the same browser:

```sh
claude mcp add --scope user fabric -- fabric mcp
```

```json
{ "mcpServers": { "fabric": { "command": "fabric", "args": ["mcp"] } } }
```

### Web agents

Any agent framework that accepts a CDP URL (browser-use, Stagehand, LangChain browser tools, your
own Playwright code) can use `http://127.0.0.1:9222` — or, with `fabric up --remote`, a browser of
your self-hosted deployment with the same loopback address. See [docs/agents.md](docs/agents.md).

### Tasks in natural language

```sh
export ANTHROPIC_API_KEY=…   # or OPENAI_API_KEY (+ OPENAI_BASE_URL for any compatible server)
fabric task "find the latest release version of bun" \
  --url https://github.com/oven-sh/bun/releases --model anthropic/claude-sonnet-4-5
```

The agent opens its own tab, reads an indexed snapshot of the page, clicks and types with trusted
input, and stops at a step limit and timeout. Secrets reach the page only as `{{secret:NAME}}`
placeholders filled from `FABRIC_SECRET_NAME` at typing time; uploads are limited to directories
you allow with `--upload-dir`.

## Self-hosting

```sh
cd deploy/compose
./bootstrap-secrets.sh          # certificates, keys, passwords, provisioning manifest
cp .env.example .env
docker compose up -d --build
bun ../../scripts/compose-smoke.ts
```

The stack — PostgreSQL, RustFS object storage, API, scheduler, CDP gateway, worker manager, egress
sidecar, optional Tor, and a Caddy edge — listens on `127.0.0.1:18086`. Put TLS in front of it
before exposing it. Details, configuration and security notes: [deploy/compose/README.md](deploy/compose/README.md).

```sh
curl -u "principal_admin:$(cat deploy/compose/secrets/principals/admin)" http://127.0.0.1:18086/v1/me
fabric login --url http://127.0.0.1:18086 --username admin < deploy/compose/secrets/principals/admin
fabric up --remote                     # an interactive browser of your deployment
```

## Architecture

```text
clients ─► edge (Basic auth per principal) ─► API ─┬─► scheduler ─► PostgreSQL
                                          └─► CDP gateway ◄─┐   └─► object store (S3)
                                                            │
                    worker manager (Docker) ─► one Chrome container per lease ─► egress sidecar ─► internet
                                                 + Turnstile/DataDome guardian      (PAC, proxy, Tor)
```

- [docs/architecture.md](docs/architecture.md) — services, the browser runtime, allocation, CDP relay, guardian
- [docs/README.md](docs/README.md) — features in depth: guardian, solvers, capacity, principals
- [docs/catalog.md](docs/catalog.md) — recipes, egress policies, challenge sets, projects
- [docs/agents.md](docs/agents.md) — the `fabric` CLI
- [docs/adr](docs/adr) — design decisions

## Responsible use

Browser Fabric automates real browsers, and some of its features — the Turnstile/DataDome guardian,
CAPTCHA solvers, fingerprint consistency, proxy and Tor egress — affect how websites see automated
traffic. They exist for legitimate automation: your own accounts and services, testing and
monitoring of sites you operate or are authorized to test, accessibility, archiving and research
that the site permits.

- Only automate websites and accounts you are allowed to. Read and follow each site's terms of
  service and `robots.txt`, and respect rate limits — throttle your agents.
- Do not use this software to bypass access controls you are not authorized to bypass, to create
  accounts or content at scale against a site's rules, to scrape personal data unlawfully, to commit
  fraud, or to attack or overload any service.
- Comply with the laws that apply to you and to the sites you access (computer misuse, data
  protection, copyright).

You are solely responsible for how you use Browser Fabric. The software is provided as is, without
warranty (see the license).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
