# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/samuelscheit/browser/security/advisories/new)**
(Security → Advisories → Report a vulnerability). Do not open a public issue, pull request or
discussion for a security problem.

Include what you found, how to reproduce it (a minimal request sequence, configuration or test is
ideal), the affected component (for example the edge, the CDP gateway, the worker manager, the
egress sidecar or the `fabric` CLI) and the impact you expect. You will get an acknowledgement
within a few days and a fix or a coordinated disclosure date once the report is confirmed.

## Scope

In scope: anything that lets a caller exceed its principal's grants (another project's sessions,
profiles, artifacts or events), reach the control network or the host from a browser container,
bypass the egress policy (a `DIRECT` route, a private target), read a secret value from durable
state, logs or artifacts, forge or replay a CDP or assignment capability, or
attack the loopback endpoint of the `fabric` CLI from a web page.

Out of scope: the documented authority model itself. A raw CDP connection has full authority over
its browser and profile; the worker manager holds the Docker socket and is root-equivalent on its
host; anyone who can run code as the CLI's user can drive that user's browser.

## Supported versions

Fixes land on `main`. Run a current checkout and re-run `deploy/compose/bootstrap-secrets.sh` and
`docker compose up -d --build` after updating.
