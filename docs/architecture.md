# Browser Fabric architecture

```text
                 clients (Basic credential per principal; TLS in front of the edge)
                           |
                      fabric-edge (Caddy)
             +-------------+--------------+--------------------------+
             |                            |                          |
        fabric-api                  fabric-cdp-gateway      fabric-media-playback-gateway
             |                            |                          |
             +---------------- fabric-control (internal) ------------+
                           |
        +------------------+--------------------+
        |                  |                    |
  fabric-scheduler   fabric-worker-manager   fabric-input-broker
        |            (Docker socket: creates     (ciphertext only)
  fabric-postgres     one container per lease)
        |                  |
 fabric-object-store       +--> browser / media containers --> fabric-egress-sidecar --> internet
     (RustFS, S3)                 (fabric-workers network)        (PAC + listeners; Tor optional)
```

The services, their networks and secrets are defined in [`deploy/compose/compose.yml`](../deploy/compose/compose.yml).
Every origin speaks mTLS to the edge; workers authenticate to the manager with per-worker client
certificates plus an enrollment token. Browser containers never reach the control network.

## Built-ins and the deployment catalog

Recipes, egress policies and challenge handler sets are immutable, versioned values. The platform
ships a small generic set (raw CDP for each browser runtime, an interactive Chromium, the media
recipes; direct/proxy/Tor egress; guardian, captcha-solver and manual-handoff challenge sets). A
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
rather than silently continuing without its guardian.

The clicker is a local input helper for visible Cloudflare Turnstile. It does not export or log
cookies, page/form payloads, or external solver API data. After the configured bounded attempts or
timeout it stops clicking and leaves the browser usable for the normal application/manual path.
Token-solving CAPTCHAs follow the separate recipe-gated path described in
[`docs/README.md`](README.md#captcha-token-solving): one paid solve per page document, with provider
keys kept in the worker manager and never in a browser or the egress sidecar.

## Durable versus ephemeral data

PostgreSQL stores metadata, state transitions, hashes, and references only. The S3-compatible object store stores immutable artifacts with a 30-day lifecycle. Passwords, OTPs, CAPTCHA credentials, proxy credentials, cookies, and transient form values are held in a worker-process memory vault for one request and never appear in rows, object metadata, events, traces, screenshots, callbacks, or error strings. The private input broker can buffer only an authenticated, end-to-end encrypted envelope; it has no decryption key, runs one replica, and deletes the envelope on worker retrieval or expiry.

## Immutable media relay

```text
application -> authenticated artifact upload -> relay-mode media_manifest artifact
                                                  |
                                                  v
                                         manager resolves/validates
                                                  |
                              short-lived result capability + source descriptor
                                                  |
                                                  v
media worker -> Fabric egress sidecar -> provider response -> private manager receiver
                                                           |
                                                           v
                                             immutable object-store artifact + verified job result
```

A media job stores only the manifest artifact reference and an optional byte range. It cannot store
an arbitrary `manifestUrl`, signed provider URL, proxy credential, or object-store key. The manager
validates the manifest ownership, public target, allowed MIME types, requested range, and artifact
policy before launching the non-browser relay. Redirects are manually bounded and revalidated.
Provider bytes stream directly from the relay to the manager's private capability-bound receiver;
the relay logs only a receipt and has neither object-store credentials nor a public listener. The manager
re-reads the immutable artifact metadata before it marks the job succeeded. A reserved artifact
expiry survives manager restart so an exact retry cannot mutate an existing object key.

## Persistent signed media playback

The bounded immutable-object relay above deliberately does **not** accept signed provider URLs,
cookies, or long-lived HLS playback state. Those values must not be weakened into the durable media
manifest just to support a player. Persistent playback instead has a separate, attempt-bound path:

```text
application (resolves a provider page, e.g. in a Fabric browser session)
  |
  v
playback-mode manifest: credential-free anchor + operator-reviewed host suffixes
  |
  v
media-playback job allocated to one media-capacity worker
  |
  +--> worker requests `media_source` input for exact job / worker / attempt
              |
              v
      application encrypts signed URL + allowed headers + host-only cookie
      directly to that worker's RSA public key
              |
              v
      ciphertext-only broker -> worker process memory -> private HLS/MP4 relay
                                                         |
                                           Ed25519 opaque capability
                                                         |
                                                         v
                                   media-playback gateway -> any HLS/MP4 player
```

The `media-playback` runtime consumes `mediaCapacity`, not a browser lease. Its durable manifest
contains neither provider-signed query data nor request headers, cookies, output controls, or a
provider-discovered host list. The application supplies the actual source only after the assigned
worker asks for it. That source is encrypted for the exact worker, one-shot consumed, and never
written to PostgreSQL, the object store, task environment, events, logs, or public result URLs.

The public gateway receives only the Ed25519 verification key; the API issuer retains the private
key. A capability binds the job, worker, attempt, nonce, and expiry, but contains no provider
details. The gateway forwards only the player's `Range` header to the private worker endpoint.
For HLS, playlists, variants, audio renditions, keys, initialization fragments, and segments are
rewritten to opaque Fabric resource URLs. For direct MP4, exact provider `206` / `Content-Range`
semantics are checked before bytes are streamed onward.

Every redirect is bounded and checked against the immutable operator-reviewed hostname suffix set.
Provider cookies are treated as host-only because a raw `Cookie` header has no Domain/Path
attributes.

### Egress affinity

Some providers bind a signed URL to the IP address that resolved it. The media source may carry an
opaque `egressAffinityKey`; the worker presents it to the egress sidecar as proxy Basic
credentials (`fabric:<key>`), and the sidecar pins every connection with that key to the same
upstream of the listener (for example one exit of a proxy pool). The key is consumed and stripped by
the sidecar and is never forwarded. Which listener playback uses is a deployment setting
(`FABRIC_MEDIA_EGRESS_PROXY_URL`); hosts listed in `FABRIC_MEDIA_DIRECT_EXCEPTION_SUFFIXES` leave
through the direct listener instead. One-shot relays take the same routing from their job's egress
policy (`sidecar.listener`, `sidecar.directListener`, `directExceptionHostnames`).
