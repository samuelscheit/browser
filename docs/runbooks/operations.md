# Operations runbook

## Capacity

`FABRIC_MAX_ACTIVE_BROWSER_LEASES` caps concurrent browser leases across the deployment (default four, at most eight); each managed worker additionally serves at most four, and a federated local worker exactly one. If capacity is saturated, inspect queue age and worker health rather than raising the cap.

A ready session holds its slot only while a CDP client uses it: one that no client connects to, or whose last client left, is released after `FABRIC_CDP_CLIENT_GRACE_SECONDS` (default 60). The CDP client relay cancels a session whose client disconnects, or whose readiness wait times out, before it connects, so queued and allocating sessions of abandoned clients do not wait for their TTL either.

## Worker failure

A missed heartbeat after 30 seconds marks a worker offline. Sessions are timed out and released. Running jobs are requeued only while their immutable recipe retry budget and TTL permit; durable profiles remain affine to the failed worker until an explicit verified relocation.

## Secret incident

If a secret appears in a log or artifact, revoke the source credential, quarantine the worker, delete the exposed artifact, inspect callback destinations, and rotate mTLS/capability credentials. Never add a redaction workaround while leaving the source persistence path intact.

## Input broker outage

The encrypted input broker is intentionally non-durable. If it is unavailable, jobs remain
`awaiting_input`; do not replace it with PostgreSQL, the object store, a queue with disk persistence, or a
plaintext fallback. Restore the broker, verify its mTLS certificate and memory-only policy, then
ask the application to resubmit the envelope. Expired envelopes are discarded and must be
re-entered by the user/application.

Each worker must also register a unique RSA input-encryption public key. Keep the corresponding
private key only in that worker's secret/configuration; never reuse one worker's private key on a
different runtime. The application encrypts input to the public key returned with its input
request, and the worker decrypts after one-time retrieval.

## Upgrading across `002_state_journal.sql`

The delta journal (`fabric_state_deltas`) is incompatible with pre-journal control-plane binaries that only read and write `fabric_state_snapshots`. Never run old and new control-plane versions against the same database concurrently: stop API, scheduler, worker-manager, and gateway services together before starting the new version.

## Artifact retention

Artifacts are immutable and receive a 30-day expiration. Object-store lifecycle deletion is authoritative; database cleanup removes expired metadata. Signed read URLs are short-lived (maximum 15 minutes).
