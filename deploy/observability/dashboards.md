# Required dashboards and alerts

- **Capacity:** active browser leases (global hard cap 4), per-worker active/capacity, queue age by recipe/runtime.
- **Lifecycle:** sessions/jobs by state, timeout/cancellation rate, reconnect-grace releases, orphaned leases.
- **Workers:** heartbeat age, crash/restart count, CPU/memory/PID/shm/temp usage, profile affinity errors.
- **Egress/challenges:** policy route decisions, blocked direct retries, challenge outcomes by versioned handler set (never record secret values).
- **Artifacts:** bytes by project/kind, expiry backlog, object-store errors, signed URL issuance.

Alert when global capacity is saturated for 5 minutes, a worker heartbeat is older than 30 seconds, an active lease is past expiry, or any unauthorized CDP upgrade is observed.
