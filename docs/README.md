# Browser Fabric

Browser Fabric is the shared browser control plane described in [`/PLAN.md`](../PLAN.md). It owns process lifecycle, profile/volume affinity, leases, scheduling, browser-level CDP capabilities, egress policy, challenge orchestration, artifacts, Companion transport, and worker health. Domain applications remain responsible for business workflows and call the control plane through the typed clients.

## Global Cloudflare Turnstile guardian

Every Fabric-owned **Chromium** process starts a process-level Turnstile guardian before its lease
is marked ready (managed Docker Compose browsers, federated local browsers, and the manager-owned Chromium
used by the Social client). The guardian uses a second browser-level CDP connection, watches every
page/tab—including dynamically created tabs and Turnstile frames hidden in closed shadow roots—and
performs the same bounded, jittered trusted mouse gesture used by the former Media flow. It is
independent of the application's Puppeteer, Playwright, Patchright, or raw-CDP connection, so the
behavior is automatically active for arbitrary sites using Cloudflare Turnstile rather than being
an application-specific recipe loop.

The guardian is deliberately **not** a universal CAPTCHA solver: it only recognizes explicit
Cloudflare Turnstile signals and visible `challenges.cloudflare.com` Turnstile frames. It never calls
Death by Captcha/AntiCaptcha, fabricates/exports/logs response tokens, or writes site forms. Each
challenge has bounded time and click attempts; an unresolved challenge remains available for the
application/manual workflow. If the guardian's own CDP channel dies, the owning executor reports the
browser as unhealthy instead of exposing an unguarded ready lease. Media-relay jobs do not start a
browser and therefore do not receive this companion.

The only deployment knobs are bounded timing values (`FABRIC_TURNSTILE_POLL_INTERVAL_MS`,
`FABRIC_TURNSTILE_CHALLENGE_TIMEOUT_MS`, and `FABRIC_TURNSTILE_MAX_CLICK_ATTEMPTS`). There is no
disable switch: omitting them uses the reviewed defaults (1 second, 12 seconds, and five clicks).

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
| Companion adapter | `apps/companion-adapter/src/index.ts` | session-scoped Companion lifecycle |

`media-relay` and `media-playback` never create a browser lease. The former is a bounded immutable
artifact fetch. The latter supports persistent HLS/direct-MP4 player traffic through an encrypted,
attempt-bound signed source handoff; provider URLs, cookies, and header context do not become job
payloads, manifests, environment variables, artifacts, events, logs, or public playback URLs.

## Security boundary

Raw CDP is full authority over the selected browser profile. It is scoped by project/profile/worker/expiration capability and protected by per-principal Basic authentication at ingress; it is not origin-restricted. Internal service connections still use origin mTLS. Workers run with bounded resources and no Docker socket, host-home mount, repository mount, or application-secret mount. Secret values enter only through an active lease's ephemeral input channel and are wiped after one-time consumption.
