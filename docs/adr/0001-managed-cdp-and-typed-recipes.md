# ADR 0001: managed raw CDP plus typed recipes

## Decision

Expose two integration layers: a managed browser-level CDP WebSocket for trusted clients and typed, versioned recipe jobs for workflows needing normalized retries, challenge states, input handoff, or artifact guarantees.

## Consequences

- Existing Puppeteer, Rebrowser, Playwright `connectOverCDP`, browser-agent frameworks and direct DevTools clients remain usable unchanged.
- Raw CDP is intentionally treated as full profile authority; origin-restriction claims would be misleading.
- Workers—not clients—choose executable, launch flags, placement, networking, and resource limits.
- Recipes, egress policies and challenge handler sets are immutable and versioned. Deployments add their own through the catalog file (`docs/catalog.md`) instead of patching built-ins.
