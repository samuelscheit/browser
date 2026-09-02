# ADR 0001: managed raw CDP plus typed recipes

## Decision

Expose two integration layers: a managed browser-level CDP WebSocket for trusted clients and typed, versioned recipe jobs for workflows needing normalized retries, challenge states, identity checks, approvals, or artifact guarantees.

## Consequences

- Existing Puppeteer, Rebrowser, Playwright connectOverCDP, Companion cdp-connect, and direct DevTools clients remain usable.
- Raw CDP is intentionally treated as full profile authority; origin-restriction claims would be misleading.
- Workers—not clients—choose executable, launch flags, placement, networking, and resource limits.
- WebKit/SocialApi remains a native worker and is not forced through CDP.
