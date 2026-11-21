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

## Browser-level CAPTCHA guardian

Each Fabric-owned Chromium process has two independent CDP clients:

```text
application (Puppeteer / Playwright / Patchright / raw CDP)
                         |
                         v
                Fabric Chromium browser
                         ^
                         |
          process-level CAPTCHA guardian (llm-captcha)
```

The guardian is created by the Docker executor or local Chromium supervisor **before** readiness is
published. It discovers page targets, attaches a separate flattened CDP session per page (installing
the GPU identity there), and runs llm-captcha's solver on each page: one session at a time per page,
with one solver driver per page document so its isolated worlds are injected once. Out-of-process
challenge frames are reached through frame sessions the guardian attaches in flat mode on its own
connection and releases on navigation or page close. A failed session is final for its document; a
navigation, page close or stop aborts a running session, and its remaining input is refused before it
reaches the browser. A visible reCAPTCHA v2 widget still without a response after a session gets one
provider token per document when the recipe enables a provider (see
[`docs/README.md`](README.md#recaptcha-v2-token-fallback) for why). The guardian, not llm-captcha,
publishes `failed` on the page, and only once no fallback is still to run.

A lost guardian CDP connection makes the executor's liveness probe fail; a manager restart removes an
untracked browser rather than silently continuing without its guardian. Every container and volume a
manager creates carries its deployment (`com.browser-fabric.deployment`, the Compose project name), and
a restart removes only its own deployment's browsers, so two stacks can share a Docker host.

The guardian does not export or log cookies or page/form payloads. The model key and the token
provider keys stay in the worker manager; model and provider requests leave through the egress
sidecar's `captcha-solver` listener, never from a browser.

## Durable versus ephemeral data

PostgreSQL stores metadata, state transitions, hashes, and references only. The S3-compatible object store stores immutable artifacts with a 30-day lifecycle. Passwords, OTPs, CAPTCHA credentials, proxy credentials, cookies, and transient form values are held in a worker-process memory vault for one request and never appear in rows, object metadata, events, traces, screenshots, callbacks, or error strings. The private input broker can buffer only an authenticated, end-to-end encrypted envelope; it has no decryption key, runs one replica, and deletes the envelope on worker retrieval or expiry.
