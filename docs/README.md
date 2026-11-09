# Browser Fabric

Browser Fabric is the shared browser control plane described in [`/PLAN.md`](../PLAN.md). It owns process lifecycle, profile/volume affinity, leases, scheduling, browser-level CDP capabilities, egress policy, challenge orchestration, artifacts, Companion transport, and worker health. Domain applications remain responsible for business workflows and call the control plane through the typed clients.

**Agents and people who just need a browser:** use the `fabric` CLI ([`agents.md`](agents.md)).
`fabric up` (Chrome on this machine) or `fabric up --remote` (a Fabric browser) prints a plain
`http://127.0.0.1:<port>` CDP endpoint for Playwright, Puppeteer or an MCP, plus a live view.

## Global Cloudflare Turnstile guardian

Every Fabric-owned **Chromium** process starts a process-level Turnstile guardian before its lease
is marked ready (managed Docker Compose browsers, federated local browsers, and the manager-owned Chromium
used by the Social client). The guardian uses a second browser-level CDP connection, watches every
page/tab—including dynamically created tabs and Turnstile frames hidden in closed shadow roots—and
performs the same bounded, jittered trusted mouse gesture used by the former Media flow. It is
independent of the application's Puppeteer, Playwright, Patchright, or raw-CDP connection, so the
behavior is automatically active for arbitrary sites using Cloudflare Turnstile rather than being
an application-specific recipe loop.

The Turnstile clicker recognizes only explicit Cloudflare Turnstile signals and visible
`challenges.cloudflare.com` Turnstile frames, and it never writes site forms. Each challenge has
bounded time and click attempts; an unresolved challenge remains available for the
application/manual workflow. Token-solving CAPTCHAs use the separate, recipe-gated path described
in the CAPTCHA token section below. If the guardian's own CDP channel dies, the owning executor reports the
browser as unhealthy instead of exposing an unguarded ready lease. Media-relay jobs do not start a
browser and therefore do not receive this companion.

The only deployment knobs are bounded timing values (`FABRIC_TURNSTILE_POLL_INTERVAL_MS`,
`FABRIC_TURNSTILE_CHALLENGE_TIMEOUT_MS`, and `FABRIC_TURNSTILE_MAX_CLICK_ATTEMPTS`). There is no
disable switch: omitting them uses the reviewed defaults (1 second, 12 seconds, and five clicks).

## CAPTCHA token solving

Token CAPTCHAs are solved by a recipe-gated companion, not by the Turnstile clicker. A browser solves
only when its recipe's challenge handler set contains an **automatic** `dbc` or `anticaptcha` handler.
Manual, fallback, and unrelated recipes never spend provider credit.

- **Supported widget:** Google reCAPTCHA v2 checkboxes (Death by Captcha token type 4, AntiCaptcha
  `RecaptchaV2TaskProxyless`). hCaptcha is not solved: neither provider's public documentation names a
  hCaptcha task for this path, so it fails closed as `unsupported` rather than guessing.
- **Where it runs:** the guardian detects the widget's sitekey in its isolated world, asks the solver
  for one token, fills the page's response field in that isolated world, then calls the widget's own
  `data-callback` in the main world. The page's callback therefore sees the same token a human solve
  would produce.
- **Credentials:** provider keys are Docker secrets mounted only into the worker manager. Browser
  containers and the egress sidecar never receive them. An empty or `#`-prefixed secret file means the
  provider is not configured.
- **Egress:** solver API traffic leaves through the `captcha-solver` sidecar listener (port 11008),
  which admits only the `dbcapi.me` and `anti-captcha.com` hostnames.
- **Bounds:** one paid solve per page document. A failed solve is not retried on later polls, and a
  navigation resets the budget. A canceled solve is never retried through a second provider. The
  overall deadline is two minutes per token.
- **Logging:** only the widget kind, the page origin, and a stable failure class are logged. Sitekeys,
  tokens, provider bodies, and credentials are never logged.

## External CDP client limits

Browser sessions accept one external CDP client by default. A session may request up to
`maxExternalConnections: 8` (`MAX_EXTERNAL_CDP_CONNECTIONS`) when independent clients share the same
isolated browser—for example a passive network recorder attached before a Companion automation client,
or an agent's MCP, scripts, live view and keep-alive connection. Chromium serves many DevTools
clients natively and every client already holds the session's full raw-CDP authority, so the limit
bounds resources, not privilege. The value is persisted and enforced by PostgreSQL; values outside
1–8 are rejected by the public contract, and opting one session in does not widen any other session.
A session is released 60 seconds after its last external client disconnects.

## Browser capacity

`FABRIC_MAX_ACTIVE_BROWSER_LEASES` caps concurrent browser leases across the deployment (default
4, at most `MAX_ACTIVE_BROWSER_LEASES` = 8, enforced by the scheduler and the `fabric_capacity`
check). Each worker additionally limits its own browsers (`capacity`, 1–3, with per-browser
`resourceLimits`); an idle worker is resized by changing it in the provisioning manifest. Every
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
(`principal_<name>`), the password is the Docker secret `fabric_api_password_<name>`. The edge
derives one account per mounted secret, so adding a principal means:

1. add `<name>` to `deploy/compose/ensure-application-passwords.sh` and run it on the host,
2. declare `fabric_api_password_<name>` in the Compose file and mount it into `fabric-edge`
   (`bun run validate:deployment` checks both),
3. add the principal (and its project/profiles) to the provisioning manifest.

A rejected credential gets a 401 whose body explains the username format.

## Local development

```sh
bun install --frozen-lockfile
bun run check
```

The default test suite uses an in-memory store and fake clock. PostgreSQL and MinIO adapters are exercised through contract boundaries; production startup uses `apps/api/src/server.ts` and `packages/control-plane/src/runtime.ts`.

## Runtime entrypoints

| Component | Entry point | Responsibility |
| --- | --- | --- |
| API | `apps/api/src/server.ts` | Basic-authenticated control-plane API and authorized media-playback capability issuer |
| Scheduler | `apps/scheduler/src/index.ts` | FIFO dispatch, recovery, callbacks |
| CDP gateway | `apps/cdp-gateway/src/server.ts` | per-session browser-level WSS relay |
| CDP client relay | `apps/cdp-client-relay/src/server.ts` | private application-side password bridge for CDP clients that cannot attach an Authorization header to upgrades |
| Media playback gateway | `apps/media-playback-gateway/src/server.ts` | opaque Ed25519 HLS/direct-MP4 capability relay to private media workers |
| Worker manager | `apps/worker-manager/src/server.ts` | worker registration, mailbox, assignment claims |
| Encrypted input broker | `apps/input-broker/src/index.ts` | transient ciphertext-only input handoff |
| Local agent | `apps/local-agent/src/index.ts` | outbound-only interactive worker |
| Agent CLI | `apps/cli/src/cli.ts` (`fabric`) | per-user loopback CDP endpoint, live view and MCP for a remote session or local Chrome |
| Companion adapter | `apps/companion-adapter/src/index.ts` | session-scoped Companion lifecycle |

`media-relay` and `media-playback` never create a browser lease. The former is a bounded immutable
artifact fetch. The latter supports persistent HLS/direct-MP4 player traffic through an encrypted,
attempt-bound signed source handoff; provider URLs, cookies, and header context do not become job
payloads, manifests, environment variables, artifacts, events, logs, or public playback URLs.

## Security boundary

Raw CDP is full authority over the selected browser profile. It is scoped by project/profile/worker/expiration capability and protected by per-principal Basic authentication at ingress; it is not origin-restricted. Internal service connections still use origin mTLS. Workers run with bounded resources and no Docker socket, host-home mount, repository mount, or application-secret mount. Secret values enter only through an active lease's ephemeral input channel and are wiped after one-time consumption.
