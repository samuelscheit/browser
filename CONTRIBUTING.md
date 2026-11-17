# Contributing

Thanks for helping. Bug reports, focused pull requests and documentation fixes are welcome; for a
larger change, open an issue first so the design can be agreed before you write it.

## Setup

Browser Fabric is a [Bun](https://bun.sh) + TypeScript monorepo (`apps/*`, `packages/*`, `workers/*`).
The pinned Bun version is in `package.json` (`packageManager`).

```sh
bun install --frozen-lockfile
bun run typecheck        # tsc over apps, packages, workers, scripts and tests
bun test                 # unit and contract tests (in-memory store, fake clock)
bun run check            # typecheck + tests + Dockerfile validation, as CI runs it
```

## Opt-in suites

| What | How |
| --- | --- |
| PostgreSQL store | `FABRIC_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bun test tests/postgres-store.integration.test.ts` (e.g. `docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`) |
| Schema | `PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=postgres ./scripts/validate-sql.sh` (needs `psql`, `createdb`) |
| Real browsers | `RUN_BROWSER_INTEGRATION=1 bun run test:integration` — needs a local Chromium or Chrome; set `FABRIC_TEST_CHROMIUM` to its executable when it is not on the default path |
| Compose stack | `cd deploy/compose && ./bootstrap-secrets.sh && cp .env.example .env && docker compose up -d --build`, then `bun run compose:smoke` |

The browser integration tests start their own browsers on free ports. They never attach to a
Chrome you are using.

## Conventions

- Keep the security boundaries in [docs/architecture.md](docs/architecture.md) intact: no secret
  value in durable state, logs or artifacts; no `DIRECT` egress; workers choose executables and flags,
  clients never do.
- Recipes, egress policies and challenge sets are immutable: change behavior with a new version.
  Deployment-specific entries belong in a catalog (docs/catalog.md), not in the built-ins.
- Add or update tests with every behavior change; prefer exercising the real scheduler, executor or
  gateway over mocks.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(scheduler): …`, `fix(egress-sidecar): …`).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
