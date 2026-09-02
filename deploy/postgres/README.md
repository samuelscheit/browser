# Fabric PostgreSQL

Apply migrations in lexical order with a migration runner (`001_initial.sql`, then `002_indexes_and_retention.sql`).
The schema is intentionally explicit: no table stores secret values. Ephemeral input values exist only in a worker-memory vault and are wiped on consumption, cancellation, timeout, or crash.

The scheduler must acquire row locks (`SELECT ... FOR UPDATE`) on the global capacity row (represented by the active lease count), the selected worker, and the selected profile before inserting a lease. The partial unique index `one_active_writer_per_profile` is the final race-proof guard.
