# Browser Fabric documentation

Browser Fabric is a browser control plane. It owns process lifecycle, profile/volume affinity,
leases, scheduling, browser-level CDP capabilities, egress policy, challenge handling, artifacts
and worker health. Applications keep their business workflows and call the control
plane through the API or the typed clients.

- [Architecture](architecture.md): services, the browser runtime, allocation, CDP relay, guardian
- [Catalog](catalog.md): add recipes, egress policies, challenge sets and projects without code
- [Agents and the `fabric` CLI](agents.md)
- [Self-hosting with Docker Compose](../deploy/compose/README.md)
- [Operations runbook](runbooks/operations.md), [ADRs](adr/)

**Agents and people who just need a browser:** use the `fabric` CLI ([`agents.md`](agents.md)).
`fabric up` (your own everyday Chrome) or `fabric up --remote` (a Fabric browser) prints a plain
`http://127.0.0.1:<port>` CDP endpoint for Playwright, Puppeteer or an MCP, plus a live view.

## Global CAPTCHA guardian

Every Fabric-owned **Chromium** process starts a process-level CAPTCHA guardian before its lease is
marked ready (managed Docker Compose browsers, federated local browsers, and the CLI's local
browser). The guardian uses a second browser-level CDP connection, watches every page/tab—including
dynamically created tabs—and runs [llm-captcha](https://github.com/samuelscheit/llm-captcha)'s CDP
solver on each one. It is independent of the application's Puppeteer, Playwright, Patchright, or
raw-CDP connection, so every site's challenges are handled without an application-specific loop.

llm-captcha recognizes the challenges in every frame (out-of-process frames and closed shadow roots
included) from declarative adapters: checkboxes (Cloudflare Turnstile, reCAPTCHA v2, hCaptcha, …),
image grids, sliders (DataDome, GeeTest, Tencent, Aliyun, …), press-and-hold and proof-of-work
interstitials. It answers with trusted CDP input: human-like mouse tracks, drags and focus emulation.
Checkboxes, sliders and press-and-hold need no model; image and text challenges ask the deployment's
vision model. The page's top document publishes the state
(`<html data-captcha-state="solving|solved|failed" data-captcha-detail="…">`), so an agent waits while
it reads `solving`.

- **Model:** `claude-opus-5-5` through Fabric's AI gateway's Anthropic Messages API
  (`FABRIC_LLM_CAPTCHA_BASE_URL`, default `https://ollama.samuelscheit.com/v1`;
  `FABRIC_LLM_CAPTCHA_MODEL`). The key is the Docker secret `llm_captcha_api_key`
  (`FABRIC_LLM_CAPTCHA_API_KEY_FILE`), read by the worker manager (or local agent) only; it never
  enters a browser and is never logged. Without a key, model challenges end `failed`.
- **Egress:** model requests leave through the egress sidecar's `captcha-solver` listener, which admits
  only the solver hostnames.
- **Bounds:** at most one solve session per page at a time; pages are independent. A session that
  fails is final for its page document (no paid loops) until a top-level navigation; a session that
  errors after asking the model counts as failed. After `solved` the page stays watched, since a later
  step can show a new challenge. Navigation, page close and guardian stop abort a session, and its
  remaining input never reaches the page.
- **Knobs:** `FABRIC_CAPTCHA_POLL_INTERVAL_MS` (default 1 s), `FABRIC_CAPTCHA_SOLVE_TIMEOUT_MS`
  (3 min per session) and `FABRIC_CAPTCHA_MAX_ROUNDS` (8 model rounds, slides or holds per challenge).
  There is no disable switch.
- **Logging:** page origins, adapter ids, llm-captcha's short outcome and stable error classes only.

If the guardian's own CDP channel dies, the owning executor reports the browser as unhealthy instead
of exposing an unguarded ready lease.

## reCAPTCHA v2 token fallback

llm-captcha alone is not enough for reCAPTCHA v2. Measured live on the production egress with
`claude-opus-5-5`, it passed Turnstile 5/5 but reCAPTCHA v2 forms only 0–2/5: its image-grid answers
were wrong, on one site it ended `idle` ("no challenge found") with the widget under a cookie banner,
and once it ended `solved` with an empty `g-recaptcha-response`. The guardian therefore buys reCAPTCHA
v2 tokens from Death by Captcha or Anti-Captcha as a permanent second path.

- **Trigger:** after every llm-captcha session, the guardian probes the top document (from its own
  isolated world) for a visible, rendered reCAPTCHA v2 checkbox widget (not the invisible variant)
  whose response field is still empty, whatever the session concluded. After `failed` it buys at
  once; after `idle` or a token-less `solved` it first gives the widget a 5-second grace (it may still
  be loading, or its token arriving), with the page kept at `solving`.
- **Gate:** only when the recipe's challenge handler set contains an **automatic** `dbc` or
  `anticaptcha` handler **and** the deployment configured that provider's credential. The built-in
  browser recipes use `challenge_captcha-solver@1`; a catalog recipe that must never spend provider
  credit uses `challenge_guardian@1`.
- **State:** a reCAPTCHA reads `solved` only once a token is in its response field; otherwise the page
  reads `failed` with the reason (llm-captcha's, `recaptcha: widget not reached`, or
  `recaptcha: solved without a response token`, plus the provider's failure class).
- **Injection:** the token fills the response field in the guardian's isolated world, then the
  widget's own `data-callback` runs in the main world, so the page sees what a human solve produces.
- **Bounds:** one token per page document; a provider failure is final for that document, and a
  navigation starts over. A canceled solve is never retried through a second provider; the overall
  deadline is two minutes per token.
- **Credentials and egress:** provider keys are Docker secrets mounted only into the worker manager;
  their API traffic uses the same `captcha-solver` sidecar listener (`dbcapi.me`, `anti-captcha.com`).
  Sitekeys, tokens, provider bodies and credentials are never logged.

## External CDP client limits

Browser sessions accept one external CDP client by default. A session may request up to
`maxExternalConnections: 8` (`MAX_EXTERNAL_CDP_CONNECTIONS`) when independent clients share the same
isolated browser—for example a passive network recorder attached before a browser-agent framework,
or an agent's MCP, scripts, live view and keep-alive connection. Chromium serves many DevTools
clients natively and every client already holds the session's full raw-CDP authority, so the limit
bounds resources, not privilege. The value is persisted and enforced by PostgreSQL; values outside
1–8 are rejected by the public contract, and opting one session in does not widen any other session.
A session is released 60 seconds after its last external client disconnects.

## Browser capacity

`FABRIC_MAX_ACTIVE_BROWSER_LEASES` caps concurrent browser leases across the deployment (default
4, at most `MAX_ACTIVE_BROWSER_LEASES` = 8, enforced by the scheduler and the `fabric_capacity`
check). Each managed worker additionally limits its own browsers (`capacity`, 0–4, with per-browser
`resourceLimits`); an idle worker is resized, or given further catalog recipes, by changing it in the
provisioning manifest (deploy/compose regenerates it with `bootstrap-secrets.sh`). Every
Fabric service validates the cap at startup, so a value outside 1–8 stops the stack from booting.

## Stopping browsers keeps their profile

Fabric closes Chromium through CDP `Browser.close` before it signals the process or stops the
container (Docker executor, local supervisor and the `fabric` CLI alike). SIGTERM makes Chromium
skip its cookie flush (cookies are written about every 30 seconds), which used to drop logins made
shortly before a session was released.

## Discovering what a principal may use

`GET /v1/me` returns the caller's projects, the profiles it may lease, the recipes a registered
worker serves (with their `raw_cdp`/`typed_job` access), and the egress and artifact policy refs.
Clients use it to pick valid refs instead of reading deployment files.

## Application principals

Each application authenticates at the edge with HTTP Basic: the username is its principal ID
(`principal_<name>`), the password is the file `secrets/principals/<name>` of the Compose
deployment. The edge derives one account per file, so adding a principal is:

```sh
cd deploy/compose
FABRIC_PRINCIPALS="admin <name>" ./bootstrap-secrets.sh   # adds the password and the manifest entry
docker compose up -d --force-recreate fabric-provisioner fabric-edge
```

A rejected credential gets a 401 whose body explains the username format.

## Local development

See [CONTRIBUTING.md](../CONTRIBUTING.md). The default test suite uses an in-memory store and a
fake clock; PostgreSQL, browser and Compose checks are opt-in.

## Runtime entrypoints

| Component | Entry point | Responsibility |
| --- | --- | --- |
| API | `apps/api/src/server.ts` | Basic-authenticated control-plane API |
| Scheduler | `apps/scheduler/src/index.ts` | FIFO dispatch, recovery, callbacks |
| CDP gateway | `apps/cdp-gateway/src/server.ts` | per-session browser-level WSS relay |
| CDP client relay | `apps/cdp-client-relay/src/server.ts` | private application-side password bridge for CDP clients that cannot attach an Authorization header to upgrades |
| Worker manager | `apps/worker-manager/src/server.ts` | worker registration, mailbox, assignment claims |
| Encrypted input broker | `apps/input-broker/src/index.ts` | transient ciphertext-only input handoff |
| Local agent | `apps/local-agent/src/index.ts` | outbound-only interactive worker |
| Agent CLI | `apps/cli/src/cli.ts` (`fabric`) | per-user loopback CDP endpoint, live view and MCP for a remote session or local Chrome |
| Egress sidecar | `apps/egress-sidecar/src/server.ts` | fail-closed PAC and per-policy proxy listeners |

## Security boundary

Raw CDP is full authority over the selected browser profile. It is scoped by project/profile/worker/expiration capability and protected by per-principal Basic authentication at ingress; it is not origin-restricted. Internal service connections still use origin mTLS. Workers run with bounded resources and no Docker socket, host-home mount, repository mount, or application-secret mount. Secret values enter only through an active lease's ephemeral input channel and are wiped after one-time consumption.
