# Browser Fabric

Browser Fabric is the shared browser control plane described in [`/PLAN.md`](../PLAN.md). It owns process lifecycle, profile/volume affinity, leases, scheduling, browser-level CDP capabilities, egress policy, challenge orchestration, artifacts, Companion transport, and worker health. Domain applications remain responsible for business workflows and call the control plane through the typed clients.

## Local development

```sh
bun install --frozen-lockfile
bun run check
```

The default test suite uses an in-memory store and fake clock. PostgreSQL and MinIO adapters are exercised through contract boundaries; production startup uses `apps/api/src/server.ts` and `packages/control-plane/src/runtime.ts`.

## Runtime entrypoints

| Component | Entry point | Responsibility |
| --- | --- | --- |
| API | `apps/api/src/server.ts` | mTLS-authenticated control-plane HTTP API |
| Scheduler | `apps/scheduler/src/index.ts` | FIFO dispatch, recovery, callbacks |
| CDP gateway | `apps/cdp-gateway/src/server.ts` | per-session browser-level WSS relay |
| Worker manager | `apps/worker-manager/src/server.ts` | worker registration, mailbox, assignment claims |
| Encrypted input broker | `apps/input-broker/src/index.ts` | transient ciphertext-only input handoff |
| Local agent | `apps/local-agent/src/index.ts` | outbound-only interactive worker |
| Companion adapter | `apps/companion-adapter/src/index.ts` | session-scoped Companion lifecycle |

## Security boundary

Raw CDP is full authority over the selected browser profile. It is scoped by project/profile/worker/expiration capability and protected by mTLS at ingress; it is not origin-restricted. Workers run with bounded resources and no Docker socket, host-home mount, repository mount, or application-secret mount. Secret values enter only through an active lease's ephemeral input channel and are wiped after one-time consumption.
