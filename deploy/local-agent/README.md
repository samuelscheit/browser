# Local interactive worker

The federated worker is an outbound-only process. It is intended for the operator's Mac and is
not a Docker service on `fabric-host`.

1. Provision `workers/local-interactive/config/worker.json` in the Fabric control plane with the
   actual certificate fingerprint, profile grants, and named profile-volume mappings.
2. Store the client certificate/key, worker CA, assignment public key, and enrollment token outside
   the repository.
3. Start a loopback-only Fabric egress sidecar **before** the agent. Copy
   `egress-config.example.json` outside the repository, reference an owner-only proxy-secret file,
   and use the actual reviewed Signup/CHAT policy endpoints. Do not place proxy userinfo in the
   worker configuration or environment.

```sh
FABRIC_EGRESS_LOCAL_MODE=1 \
FABRIC_EGRESS_BIND_HOST=127.0.0.1 \
FABRIC_EGRESS_PAC_HOST=127.0.0.1 \
FABRIC_EGRESS_CONFIG=/absolute/path/to/local-egress.json \
bun apps/egress-sidecar/src/server.ts
```

4. Start the agent from the Browser Fabric checkout with:

```sh
FABRIC_WORKER_CONFIG_FILE=/absolute/path/to/worker.json \
FABRIC_WORKER_MANAGER_URL=https://fabric.internal.example \
FABRIC_CDP_RELAY_URL=wss://fabric.internal.example/v1/worker-relay/{workerId}/{leaseId} \
FABRIC_EGRESS_PAC_BASE_URL=http://127.0.0.1:8080 \
FABRIC_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
FABRIC_LOCAL_PROFILE_ROOT="$HOME/Library/Application Support/BrowserFabric/profiles" \
FABRIC_WORKER_CLIENT_CERT_FILE=/absolute/path/client.crt \
FABRIC_WORKER_CLIENT_KEY_FILE=/absolute/path/client.key \
FABRIC_WORKER_CLIENT_CA_FILE=/absolute/path/worker-ca.crt \
FABRIC_ASSIGNMENT_PUBLIC_KEY_FILE=/absolute/path/assignment-public.pem \
FABRIC_WORKER_ENROLLMENT_TOKEN_FILE=/absolute/path/enrollment-token \
bun apps/local-agent/src/server.ts
```

The agent maps Fabric named volume names to directories beneath `FABRIC_LOCAL_PROFILE_ROOT`; it
never accepts inbound shell or browser commands. Keep the profile root owner-only and back it up
using the profile-volume runbook before relocating or revoking a profile.

The local executor checks the PAC before each browser launch and refuses a PAC containing `DIRECT`.
This is intentional: a local browser has host egress, so a missing sidecar must fail a lease rather
than silently bypass the selected Fabric policy.
