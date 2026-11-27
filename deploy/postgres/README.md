# Fabric PostgreSQL

Every Fabric process applies the numbered `*.sql` files in this directory in lexical order on boot,
so each statement is idempotent. `001_schema.sql` is the complete schema; a later change adds a new
numbered file rather than editing a released one. `scripts/validate-sql.sh` checks the schema against
a real server.

The schema intentionally contains no column for a secret value. Ephemeral input values exist only in a
worker-memory vault or the encrypted input broker and are wiped on consumption, cancellation, timeout
or crash.

Control-plane processes share one hot state through a journal: every transaction appends a small
delta to `fabric_state_deltas`, and every 200th also writes a full checkpoint to
`fabric_state_snapshots` (older checkpoints and deltas from before the previous checkpoint are
deleted in the same transaction). A process compares its cached sequence with the journal head
before each read and replays only the deltas it lacks; a restart loads the latest checkpoint and the
deltas after it. Finished sessions and jobs leave the hot state after an hour (at most 1,000 of each
stay) and remain queryable in the normalized tables.

The scheduler serializes every state change. The global capacity row (`fabric_capacity`) bounds active
browser leases, and the partial unique index `one_active_writer_per_profile` is the final race-proof
guard against two writers on one profile.
