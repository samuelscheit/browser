# Self-hosting Browser Fabric with Docker Compose

One host runs the whole platform: PostgreSQL, an S3-compatible object store (RustFS), the API, the
scheduler, the CDP gateway, the media playback gateway, the worker manager, the encrypted input
broker, the egress sidecar, the Caddy edge and one worker agent per runtime. Optional profiles add a
Tor client (`tor`) and an OpenTelemetry collector (`observability`).

Requirements: Docker Engine 24+ with Compose v2 (Docker Desktop works), `openssl` 1.1.1+ / 3.x and
`jq` for the bootstrap. Plan for a few GB of RAM for the services plus about 1 GB per concurrent
browser.

## Start

```sh
cd deploy/compose
./bootstrap-secrets.sh                  # certificates, keys, passwords, provisioning manifest
cp .env.example .env                    # adjust URLs, port and capacity
docker compose up -d --build            # add `--profile tor` for the Tor egress policy
bun ../../scripts/compose-smoke.ts      # end-to-end check through the edge
```

The smoke test leases a Chromium over raw CDP through the edge, navigates to `https://example.com/`
through the egress sidecar and releases the browser. `--egress egress_tor@1 --page
https://check.torproject.org/` checks the Tor route.

The edge listens on `http://127.0.0.1:18086`. The API is under `/v1`; the admin password is
`secrets/principals/admin`:

```sh
curl -u "principal_admin:$(cat secrets/principals/admin)" http://127.0.0.1:18086/v1/me
```

## Exposing it

The edge speaks plain HTTP on loopback. CDP capability and playback URLs are bearer secrets, so a
deployment reachable from other machines must put TLS in front of it — a reverse proxy (Caddy,
nginx, Traefik) or a tunnel — and set the public URLs in `.env`:

```sh
FABRIC_GATEWAY_BASE_URL=wss://fabric.example.com
FABRIC_MEDIA_PLAYBACK_BASE_URL=https://fabric.example.com/v1/media-playback
```

The control plane refuses `ws://`/`http://` base URLs for anything but a loopback host.

## What the bootstrap creates

`bootstrap-secrets.sh` is idempotent: it creates only missing files, so a rerun never rotates an
identity the database already trusts, and it always rebuilds the provisioning manifest.

| Path in `secrets/` | Purpose |
| --- | --- |
| `.ca/` | CA private keys (never mounted into a container) |
| `fabric_*_cert`, `fabric_*_key`, `*_ca` | mTLS between edge and origins, workers and manager, services and input broker |
| `fabric_assignment_*_key` | Ed25519 key that signs worker assignments |
| `fabric_media_playback_*_key` | Ed25519 key for playback capabilities |
| `media_worker_input_*_key` | RSA key the playback worker decrypts sources with |
| `*_worker_enrollment` | per-worker enrollment tokens (the manifest stores only their hash) |
| `principals/<name>` | password of `principal_<name>` (one file per principal) |
| `workers/<name>.json` | worker configs: defaults plus the catalog recipes each worker serves |
| `fabric_provision_manifest` | projects, principals, workers and profiles the provisioner registers |
| `egress_proxy_upstreams` | upstream proxy URL(s) for `egress_proxy@1`, one per line, tried in order (empty: fails closed) |
| `deathbycaptcha_*`, `anticaptcha_client_key` | optional solver credentials (empty: provider disabled) |

Environment knobs of the bootstrap: `FABRIC_PRINCIPALS` (default `admin`; `FABRIC_ADMIN_PRINCIPAL`,
default `admin`, gets `fabric_admin`, every other principal `project_operator`),
`FABRIC_DEFAULT_PROJECT_ID`/`_NAME`, `FABRIC_SECRETS_DIR`, `FABRIC_CATALOG_PATH`. All principals are
granted the default project.

## Common changes

- **Another principal:** `FABRIC_PRINCIPALS="admin ci" ./bootstrap-secrets.sh`, then
  `docker compose up -d --force-recreate fabric-provisioner fabric-edge`.
- **An upstream proxy:** write `http://user:pass@proxy.example:8080` (several lines are tried in order) to
  `secrets/egress_proxy_upstreams`, then `docker compose restart fabric-egress-sidecar`.
- **CAPTCHA token solving:** write the provider credential files, then
  `docker compose restart fabric-worker-manager`.
- **Recipes, egress policies, challenge sets, projects:** edit `catalog.json` — see
  [docs/catalog.md](../../docs/catalog.md).
- **Capacity:** `FABRIC_MAX_ACTIVE_BROWSER_LEASES` (1–8) in `.env`; per-worker `capacity` in
  `workers/*/config/worker.json` (0–4), applied with `./bootstrap-secrets.sh` and a recreate.

## Security notes

- Only `fabric-edge` publishes a port. Every other service is on internal networks; browser
  containers reach the internet only through the egress sidecar, whose PAC never contains `DIRECT`.
- `fabric-worker-manager` mounts the Docker socket — it is root-equivalent on the host. Run the
  stack on a host dedicated to it.
- Browser containers run as an unprivileged user, read-only, with `no-new-privileges`, without the
  Docker socket or any application secret, and with Chromium's user-namespace sandbox enabled by
  [`chromium-userns-seccomp.json`](chromium-userns-seccomp.json), which additionally allows
  `clone`/`clone3`/`unshare`/`setns`/`chroot` for that sandbox.
- Back up `secrets/` and the `browser-fabric-postgres-data` volume together; the database trusts
  the certificates and token hashes in that directory.

## Files

| File | Purpose |
| --- | --- |
| `compose.yml` | the stack |
| `bootstrap-secrets.sh` | secret bundle, worker configs and provisioning manifest |
| `Caddyfile`, `caddy.Dockerfile`, `caddy-entrypoint.sh` | the edge: Basic auth per principal, mTLS to origins |
| `egress-sidecar.json`, `egress-sidecar.Dockerfile` | egress listeners and per-policy PAC rules |
| `tor.Dockerfile`, `torrc` | optional Tor client |
| `object-store-init.sh` | bucket, 30-day lifecycle and a bucket-scoped Fabric identity in RustFS |
| `chromium-launch.sh`, `chromium-userns-seccomp.json` | managed Chromium launcher and its seccomp profile |
| `catalog.example.json`, `provision-manifest.example.json` | documented examples |
