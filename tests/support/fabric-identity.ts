import type { PrincipalCapabilities } from "@browser-fabric/contracts";
import type { BrowserRequest } from "../../apps/cli/src/config";

export const agentIdentity = (): PrincipalCapabilities => ({
  principal: "principal_agent",
  roles: ["project_operator"],
  projects: [{ id: "project_agent", name: "Agent" }],
  profiles: [
    { ref: "profile_agent", ownerProject: "project_agent", grants: ["project_agent"], profileFamily: "interactive", status: "active" },
    { ref: "profile_chat", ownerProject: "project_chat", grants: ["project_chat"], profileFamily: "chat", status: "active" },
  ],
  recipes: [
    { ref: "recipe_interactive-chromium@1", runtime: "chromium-cdp", mode: "interactive", access: "raw_cdp", profileFamily: "interactive" },
    { ref: "recipe_chat-browser-controller@1", runtime: "chromium-cdp", mode: "interactive", access: "raw_cdp", profileFamily: "chat" },
    { ref: "recipe_reporting-reporting@1", runtime: "rebrowser-puppeteer", mode: "headless", access: "typed_job", profileFamily: "reporting-reporting" },
  ],
  egressPolicies: ["egress_direct-egress@1", "egress_tor-egress@1"],
  artifactPolicies: ["artifact-policy_standard-30-days@1"],
}) as unknown as PrincipalCapabilities;

export const remoteRequest = (overrides: Partial<BrowserRequest> = {}): BrowserRequest => ({
  name: "remote", mode: "remote", port: 9222, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false, ...overrides,
});
