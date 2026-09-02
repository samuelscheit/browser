# Browser Fabric architecture

```text
                 Cloudflare Access + mTLS
                           |
             +-------------+--------------+
             |                            |
       fabric-api                    cdp-gateway
             |                            |
             +---------- fabric-control --+
                           |
        +------------------+------------------+
        |                  |                  |
   scheduler         worker-manager       companion-adapter
        |                  |                  |
 fabric-postgres   input-broker -> workers fabric-companion
        |                  |                  |
   fabric-minio   egress sidecars + volumes  companion DB
```

## Allocation transaction

1. Validate project grant, immutable recipe, egress policy, artifact policy, profile family, and lease mode.
2. Lock global capacity, candidate worker, and profile writer row in the durable implementation.
3. Select FIFO work only among healthy, capability-compatible workers. A profile writer/interactive lease is exclusive; clone leases use a disposable volume.
4. Insert a lease and assignment attempt, increment worker/global counters, and append an ordered event in one transaction.
5. Issue a short-lived HMAC capability scoped to session/project/profile/worker. The capability URL is delivered to the client only after allocation.
6. Worker claims the signed assignment. An unclaimed lease is returned to the queue after the bounded claim timeout.

## CDP relay

The gateway authenticates the capability before accepting a WebSocket upgrade. Once accepted it forwards complete WebSocket frames between the client and worker-local browser endpoint. It never parses or exposes a command-level HTTP proxy. One external connection is allowed, with a 60-second reconnect grace period.

## Durable versus ephemeral data

PostgreSQL stores metadata, state transitions, hashes, and references only. MinIO stores immutable artifacts with a 30-day lifecycle. Passwords, OTPs, CAPTCHA credentials, proxy credentials, cookies, and transient form values are held in a worker-process memory vault for one request and never appear in rows, object metadata, events, traces, screenshots, callbacks, or error strings. The private input broker can buffer only an authenticated, end-to-end encrypted envelope; it has no decryption key, runs one replica, and deletes the envelope on worker retrieval or expiry.
