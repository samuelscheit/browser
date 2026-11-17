import type { PrincipalCapabilities } from "@browser-fabric/contracts";
import type { BrowserRequest } from "../../apps/cli/src/config";

export const agentIdentity = (): PrincipalCapabilities => ({
  principal: "principal_agent",
  roles: ["project_operator"],
  projects: [{ id: "project_agent", name: "Agent" }],
  profiles: [
    { ref: "profile_agent", ownerProject: "project_agent", grants: ["project_agent"], profileFamily: "interactive", status: "active" },
    { ref: "profile_example_kiosk", ownerProject: "project_example", grants: ["project_example"], profileFamily: "kiosk", status: "active" },
  ],
  recipes: [
    { ref: "recipe_interactive-chromium@1", runtime: "chromium-cdp", mode: "interactive", access: "raw_cdp", profileFamily: "interactive" },
    { ref: "recipe_example-kiosk@1", runtime: "chromium-cdp", mode: "interactive", access: "raw_cdp", profileFamily: "kiosk" },
    { ref: "recipe_example-fetch@1", runtime: "chromium-cdp", mode: "headless", access: "typed_job", profileFamily: "default" },
  ],
  egressPolicies: ["egress_direct@1", "egress_tor@1"],
  artifactPolicies: ["artifact-policy_standard-30-days@1"],
}) as unknown as PrincipalCapabilities;

export const remoteRequest = (overrides: Partial<BrowserRequest> = {}): BrowserRequest => ({
  name: "remote", mode: "remote", port: 9222, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false, ...overrides,
});
