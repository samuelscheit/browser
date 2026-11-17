# Browser Fabric architecture

```text
                 clients (Basic credential per principal; TLS in front of the edge)
                           |
                      fabric-edge (Caddy)
             +-------------+--------------+
             |                            |
        fabric-api                  fabric-cdp-gateway
             |                            |
             +---- fabric-control (internal) ----+
                           |
        +------------------+--------------------+
        |                  |                    |
  fabric-scheduler   fabric-worker-manager   fabric-input-broker
        |            (Docker socket: creates     (ciphertext only)
  fabric-postgres     one container per lease)
        |                  |
 fabric-object-store       +--> Chrome containers -----> fabric-egress-sidecar --> internet
     (RustFS, S3)              (fabric-workers network)   (PAC + listeners; Tor optional)
```

The services, their networks and secrets are defined in [`deploy/compose/compose.yml`](../deploy/compose/compose.yml).
Every origin speaks mTLS to the edge; workers authenticate to the manager with per-worker client
certificates plus an enrollment token. Browser containers never reach the control network.

## One browser runtime

Fabric runs one browser: Google Chrome stable on amd64 and Debian Chromium on arm64, from one image
whose build picks by architecture and pins both exactly (`workers/chrome/Dockerfile`). Clients bring
their own driver — Playwright, Patchright, Puppeteer, Rebrowser or raw CDP — over the session's CDP
endpoint. Stealth patches of drivers such as Patchright live in the client library; the server side
is the same real browser for all of them.

## Built-ins and the deployment catalog

Recipes, egress policies and challenge handler sets are immutable, versioned values. The platform
ships a small generic set (headful and headless Chrome over raw CDP; direct/proxy/Tor egress;
guardian, captcha-solver and manual-handoff challenge sets). A
deployment adds its own, plus projects, in a JSON catalog loaded by every process at startup
([`catalog.md`](catalog.md)). Workers, principals and durable profiles come from the provisioning
manifest the Compose bootstrap generates.

## Allocation transaction

1. Validate project grant, immutable recipe, egress policy, artifact policy, profile family, and lease mode.
2. Lock global capacity, candidate worker, and profile writer row in the durable implementation.
3. Select FIFO work only among healthy, capability-compatible workers. A profile writer/interactive lease is exclusive; clone leases use a disposable volume.
4. Insert a lease and assignment attempt, increment worker/global counters, and append an ordered event in one transaction.
5. Issue a short-lived HMAC capability scoped to session/project/profile/worker. The capability URL is delivered to the client only after allocation.
6. Worker claims the signed assignment. An unclaimed lease is returned to the queue after the bounded claim timeout.

## CDP relay

The gateway authenticates the capability before accepting a WebSocket upgrade. Once accepted it forwards complete WebSocket frames between the client and worker-local browser endpoint. It never parses or exposes a command-level HTTP proxy. One external connection is allowed by default (a session may opt into up to eight), with a 60-second reconnect grace period.

## Browser-level Turnstile guardian

Each Fabric-owned Chromium process has two independent CDP clients:

```text
application (Puppeteer / Playwright / Patchright / raw CDP)
                         |
                         v
                Fabric Chromium browser
                         ^
                         |
         process-level Turnstile guardian
```

The guardian is created by the Docker executor or local Chromium supervisor **before** readiness is
published. It discovers page targets, attaches a separate flattened CDP session per page, and polls
for explicit Cloudflare Turnstile evidence. It locates `challenges.cloudflare.com` Turnstile frames
through both normal DOM observation and the CDP frame tree (which covers closed shadow roots), then
issues bounded `Input.dispatchMouseEvent` movement/press/release gestures. A lost guardian CDP
connection makes the executor's liveness probe fail; a manager restart removes an untracked browser
rather than silently continuing without its guardian. Every container and volume a manager creates
carries its deployment (`com.browser-fabric.deployment`, the Compose project name), and a restart
removes only its own deployment's browsers, so two stacks can share a Docker host.

The clicker is a local input helper for visible Cloudflare Turnstile. It does not export or log
cookies, page/form payloads, or external solver API data. After the configured bounded attempts or
timeout it stops clicking and leaves the browser usable for the normal application/manual path.
Token-solving CAPTCHAs follow the separate recipe-gated path described in
[`docs/README.md`](README.md#captcha-token-solving): one paid solve per page document, with provider
keys kept in the worker manager and never in a browser or the egress sidecar.

## Durable versus ephemeral data

PostgreSQL stores metadata, state transitions, hashes, and references only. The S3-compatible object store stores immutable artifacts with a 30-day lifecycle. Passwords, OTPs, CAPTCHA credentials, proxy credentials, cookies, and transient form values are held in a worker-process memory vault for one request and never appear in rows, object metadata, events, traces, screenshots, callbacks, or error strings. The private input broker can buffer only an authenticated, end-to-end encrypted envelope; it has no decryption key, runs one replica, and deletes the envelope on worker retrieval or expiry.
