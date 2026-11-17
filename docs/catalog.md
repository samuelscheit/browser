# Deployment catalog

Browser Fabric ships a small set of built-in recipes, egress policies and challenge handler sets.
A deployment adds its own — and projects — in one JSON file, without changing code. Every process
that builds a scheduler (API, scheduler, CDP gateway, worker manager, provisioner)
reads the file named by `FABRIC_CATALOG_FILE` at startup, validates it completely, and refuses to
start on any error. No file (or `{ "version": 1 }`) means built-ins only.

In [`deploy/compose`](../deploy/compose/README.md) the file is `deploy/compose/catalog.json`
(created empty by `bootstrap-secrets.sh`; `FABRIC_CATALOG_PATH` points elsewhere). A complete example
is [`deploy/compose/catalog.example.json`](../deploy/compose/catalog.example.json).

## Built-ins

| Kind | Ref | What it is |
| --- | --- | --- |
| Recipe | `recipe_chrome@1` | headful Chrome on a private X display (live view, takeover); mode `interactive`, profile family `default` |
| Recipe | `recipe_chrome-headless@1` | headless Chrome; profile family `default` |
| Egress | `egress_direct@1` | every traffic class through the sidecar's `direct` listener |
| Egress | `egress_proxy@1` | every traffic class through the `proxy` listener (upstream URL/pool in a secret) |
| Egress | `egress_tor@1` | documents, APIs, assets and downloads through Tor (`--profile tor`) |
| Challenge set | `challenge_guardian@1` | the Turnstile/DataDome guardian only; never spends solver credit |
| Challenge set | `challenge_captcha-solver@1` | guardian plus reCAPTCHA v2 token solving through Death by Captcha and Anti-Captcha, each only if its credential is configured |
| Challenge set | `challenge_manual-handoff@1` | guardian plus a manual handoff (`awaiting_manual`) |

Fabric has one browser runtime, `chrome`: Google Chrome stable on amd64 hosts, Debian Chromium on
arm64 hosts (Google publishes no Linux arm64 Chrome). Clients choose their own driver —
Playwright, Patchright, Puppeteer, Rebrowser or raw CDP — over the session's CDP endpoint; the
driver is never a server-side runtime. Both recipes use the `default` profile family, so one profile
serves either, and both use `challenge_captcha-solver@1`. Every Fabric browser runs the guardian
regardless of its recipe.

## Format

```jsonc
{
  "version": 1,
  "projects": [{ "id": "project_research", "name": "Research" }],
  "challengeSets": [
    {
      "name": "solver-anticaptcha-only",          // ref challenge_solver-anticaptcha-only@1
      "version": 1,                              // optional, default 1
      "handlers": [
        { "id": "guardian", "kind": "guardian", "mode": "automatic", "configuration": { "turnstile": true } },
        { "id": "anticaptcha", "kind": "anticaptcha", "mode": "automatic" }
      ]
    }
  ],
  "egressPolicies": [
    {
      "name": "proxy-static-direct",              // ref egress_proxy-static-direct@1
      "routes": {                                // per traffic class; a missing class is blocked
        "document": { "kind": "proxy", "proxyRef": "default", "protocol": "http" },
        "static_asset": { "kind": "direct" }
      }
    }
  ],
  "recipes": [
    {
      "name": "chrome-de",                       // ref recipe_chrome-de@1
      "runtime": "chrome",                       // the one browser runtime
      "profileFamily": "default",
      "mode": "interactive",                     // interactive (headful, live view) | headless
      "access": "raw_cdp",                       // raw_cdp | typed_job
      "challengeHandlerSetRef": "challenge_solver-anticaptcha-only@1",
      "launch": { "locale": "de-DE", "timezone": "Europe/Berlin", "viewport": { "width": 1366, "height": 768 } }
    }
  ]
}
```

(The real file is plain JSON; the comments above are explanations only.)

### Fields

- **names** are lowercase `a-z0-9-` (at most 63 characters); the ref is `<prefix>_<name>@<version>`.
  A catalog entry can never replace a built-in or be declared twice. Entries are immutable: a changed
  recipe needs a new `version` (its ref changes), because its hash covers every launch-relevant field.
- **recipes**: `typedOperations` (`name`, `requiredFields`, `allowedFields`, `secretInputFields`) is
  required for `typed_job` and refused for `raw_cdp`. `launch` may set `viewport`, `locale`,
  `timezone`, `userAgent`, `launchFlags`, `extensions`, `initScripts`, `disableServiceWorkers`,
  `sharedMemoryMiB`, `downloadsEnabled`. Flags that own the browser boundary
  (`--remote-debugging-*`, `--user-data-dir`, `--proxy-*`, `--no-sandbox`, …) are refused; the
  runtime sets them. `challengeHandlerSetRef` must name a built-in or catalog set.
- **egressPolicies**: traffic classes are `document`, `api`, `websocket`, `static_asset`,
  `browser_download`, `captcha_solver`, `direct_exception`. Routes are `direct`
  (`retryThroughProxy`), `proxy` (`proxyRef`, `protocol`, `remoteDns`), `tor` or `block`
  (`reason`). The routes declare the policy; the egress sidecar's per-policy PAC enforces it (next
  section).
- **challengeSets**: handler kinds are `guardian`, `dbc`, `anticaptcha`, `manual-handoff`; modes are
  `automatic`, `manual`, `fallback`. Token solving is enabled only by an automatic `dbc` or
  `anticaptcha` handler.
- **projects**: created once on first start; a restart never rewrites an existing project.

## Egress policies need a sidecar entry

The control plane decides which policy a session uses; the egress sidecar enforces it through the
PAC it serves to that browser. A catalog policy therefore also needs an entry in the sidecar config (`deploy/compose/egress-sidecar.json`,
or the file named by `FABRIC_EGRESS_CONFIG_PATH`): its `ref`, its `defaultListenerId` and, when
some requests must take another listener, `rules`:

```json
{
  "ref": "egress_proxy-static-direct@1",
  "defaultListenerId": "proxy",
  "rules": [
    { "listenerId": "direct", "pathExtensions": [".css", ".js", ".png", ".woff2"] },
    { "listenerId": "direct", "hostnameSuffixes": ["static.example.com"] }
  ]
}
```

A new listener (for example a second proxy pool) is added to the sidecar's `listeners` with its own
port and an `upstreamSecretFile` under `/run/secrets/` (mounted into `fabric-egress-sidecar`), then
named as a policy's `defaultListenerId` or in its `rules`. The PAC the sidecar generates never contains `DIRECT`: a missing listener fails closed.

## Applying a catalog change (Compose)

```sh
cd deploy/compose
$EDITOR catalog.json
./bootstrap-secrets.sh                 # adds catalog recipes to the workers that serve their runtime
docker compose up -d --force-recreate  # services reload the catalog; the provisioner reconfigures idle workers
```

`bootstrap-secrets.sh` regenerates the provisioning manifest and the worker config: every catalog
recipe is offered by the Chrome worker, together with its profile family. The provisioner applies that as an idle-only worker
reconfiguration; a worker that holds an active lease refuses it until the lease ends. Durable
profiles for a new profile family are added to the provisioning step and to the
`fabric-volume-bootstrap` service in `compose.yml`; the same idle-only reconfiguration adds their
volume to an existing worker. A volume leaves a worker only once no profile, clone, volume
generation or unfinished lease uses it.

`typed_job` browser recipes need an executor that runs their operation (see
`packages/recipes/src/runner.ts`); raw-CDP recipes need nothing beyond the catalog entry.
