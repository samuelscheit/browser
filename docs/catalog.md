# Deployment catalog

Browser Fabric ships a small set of built-in recipes, egress policies and challenge handler sets.
A deployment adds its own — and projects — in one JSON file, without changing code. Every process
that builds a scheduler (API, scheduler, CDP gateway, media gateway, worker manager, provisioner)
reads the file named by `FABRIC_CATALOG_FILE` at startup, validates it completely, and refuses to
start on any error. No file (or `{ "version": 1 }`) means built-ins only.

In [`deploy/compose`](../deploy/compose/README.md) the file is `deploy/compose/catalog.json`
(created empty by `bootstrap-secrets.sh`; `FABRIC_CATALOG_PATH` points elsewhere). A complete example
is [`deploy/compose/catalog.example.json`](../deploy/compose/catalog.example.json).

## Built-ins

| Kind | Ref | What it is |
| --- | --- | --- |
| Recipe | `recipe_chromium-cdp@1` | headless Chromium, raw CDP, profile family `default` |
| Recipe | `recipe_interactive-chromium@1` | headful Chromium on a private X display (live view, takeover), family `interactive` |
| Recipe | `recipe_patchright@1` | Chromium for the Patchright runtime, raw CDP, family `default` |
| Recipe | `recipe_rebrowser-puppeteer@1` | Chromium for the Rebrowser Puppeteer runtime, raw CDP, family `default` |
| Recipe | `recipe_media-relay@1` | one-shot immutable media artifact relay (typed job `relay`) |
| Recipe | `recipe_media-playback@1` | persistent signed HLS/MP4 playback (typed job `playback`) |
| Egress | `egress_direct@1` | every traffic class through the sidecar's `direct` listener |
| Egress | `egress_proxy@1` | every traffic class through the `proxy` listener (upstream URL/pool in a secret) |
| Egress | `egress_tor@1` | documents, APIs, assets and downloads through Tor (`--profile tor`) |
| Challenge set | `challenge_guardian@1` | the Turnstile/DataDome guardian only; never spends solver credit |
| Challenge set | `challenge_captcha-solver@1` | guardian plus reCAPTCHA v2 token solving through Death by Captcha and Anti-Captcha, each only if its credential is configured |
| Challenge set | `challenge_manual-handoff@1` | guardian plus a manual handoff (`awaiting_manual`) |

The built-in browser recipes use `challenge_captcha-solver@1`. Every Fabric Chromium runs the
guardian regardless of its recipe.

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
        "static_asset": { "kind": "direct" },
        "direct_exception": { "kind": "direct" }
      },
      "constraints": { "preserveProxyAffinity": true, "disableServiceWorkersInProxyMode": true },
      "sidecar": {
        "listener": { "id": "proxy", "port": 11001 },       // non-direct routes
        "directListener": { "id": "direct", "port": 11000 } // direct routes and exception hosts
      },
      "directExceptionHostnames": ["cdn.example.com"],      // suffixes that bypass the proxy
      "proxyFallbackRefs": ["primary", "secondary"]         // optional ordered fallback
    }
  ],
  "recipes": [
    {
      "name": "chromium-de",                     // ref recipe_chromium-de@1
      "runtime": "chromium-cdp",                 // chromium-cdp | patchright | rebrowser-puppeteer | media-relay | media-playback
      "profileFamily": "default",
      "mode": "headless",                        // headless | headful | interactive
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
  `browser_download`, `media_manifest`, `media_key`, `media_segment`, `media_range`,
  `provider_handshake`, `captcha_solver`, `direct_exception`. Routes are `direct`
  (`retryThroughProxy`), `proxy` (`proxyRef`, `protocol`, `remoteDns`), `tor` or `block`
  (`reason`). `sidecar` names the egress sidecar listeners that native workers (the media relay) use;
  browsers select listeners through the sidecar's PAC.
- **challengeSets**: handler kinds are `guardian`, `dbc`, `anticaptcha`, `manual-handoff`; modes are
  `automatic`, `manual`, `fallback`. Token solving is enabled only by an automatic `dbc` or
  `anticaptcha` handler.
- **projects**: created once on first start; a restart never rewrites an existing project.

## Egress policies need a sidecar entry

The control plane decides which policy a session uses; the egress sidecar enforces it. A catalog
policy therefore also needs an entry in the sidecar config (`deploy/compose/egress-sidecar.json`,
or the file named by `FABRIC_EGRESS_CONFIG_PATH`): its `ref`, its `defaultListenerId` and, when
some requests must take another listener, `rules`:

```json
{
  "ref": "egress_proxy-static-direct@1",
  "defaultListenerId": "proxy",
  "rules": [
    { "listenerId": "direct", "pathExtensions": [".css", ".js", ".png", ".woff2"] },
    { "listenerId": "direct", "hostnameSuffixes": ["cdn.example.com"] }
  ]
}
```

A new listener (for example a second proxy pool) is added to the sidecar's `listeners` with its own
port and an `upstreamSecretFile` under `/run/secrets/`, then referenced from the policy's `sidecar`.
The PAC the sidecar generates never contains `DIRECT`: a missing listener fails closed.

## Applying a catalog change (Compose)

```sh
cd deploy/compose
$EDITOR catalog.json
./bootstrap-secrets.sh                 # adds catalog recipes to the workers that serve their runtime
docker compose up -d --force-recreate  # services reload the catalog; the provisioner reconfigures idle workers
```

`bootstrap-secrets.sh` regenerates the provisioning manifest and the worker configs: every catalog
recipe is offered by each worker whose runtime matches (interactive recipes only by interactive
workers), together with its profile family. The provisioner applies that as an idle-only worker
reconfiguration; a worker that holds an active lease refuses it until the lease ends. Durable
profiles for a new profile family are added to the provisioning step and to the
`fabric-volume-bootstrap` service in `compose.yml`.

`typed_job` browser recipes need an executor that runs their operation (see
`packages/recipes/src/runner.ts`); raw-CDP recipes need nothing beyond the catalog entry.
