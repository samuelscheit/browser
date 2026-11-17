import { describe, expect, test } from "bun:test";
import type { PrincipalCapabilities, Principal, ProjectId, Worker } from "@browser-fabric/contracts";
import { TEST_PRINCIPAL, TEST_PROJECT, createTestScheduler, makeProfile, makeWorker } from "@browser-fabric/testkit";
import { createApiFetch } from "../apps/api/src/index";

const AGENT_PROJECT = "project_agent" as ProjectId;
const OTHER_PROJECT = "project_other" as ProjectId;
const AGENT: Principal = {
  id: "principal_agent" as Principal["id"],
  displayName: "Agents",
  projectGrants: [AGENT_PROJECT],
  roles: ["project_operator"],
  certificateFingerprint: "agent-cert",
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function setup() {
  const context = createTestScheduler();
  await context.scheduler.bootstrap({
    projects: [{ id: TEST_PROJECT, name: "Test" }, { id: AGENT_PROJECT, name: "Agent" }, { id: OTHER_PROJECT, name: "Other" }],
    principals: [TEST_PRINCIPAL, AGENT],
  });
  // Only two recipes are served by a registered worker; the rest exist but cannot run.
  const worker = makeWorker({
    id: "worker_chromium" as Worker["id"],
    capabilities: {
      runtimeFamilies: ["chrome", "chrome"],
      recipeRefs: ["recipe_chrome@1", "recipe_example-fetch@1"] as unknown as Worker["capabilities"]["recipeRefs"],
      browserVersions: { chromium: "stable" },
      supportsInteractive: true,
      supportedProfileFamilies: ["default"],
    },
    volumeNames: ["v-agent", "v-old", "v-other", "v-shared"],
  });
  await context.scheduler.registerWorker(worker);
  await context.scheduler.createProfile(makeProfile(worker, { ref: "profile_agent" as never, ownerProject: AGENT_PROJECT, grants: [AGENT_PROJECT], volumeName: "v-agent", profileFamily: "default" }));
  await context.scheduler.createProfile(makeProfile(worker, { ref: "profile_old" as never, ownerProject: AGENT_PROJECT, grants: [AGENT_PROJECT], volumeName: "v-old", profileFamily: "default", status: "revoked" }));
  await context.scheduler.createProfile(makeProfile(worker, { ref: "profile_other" as never, ownerProject: OTHER_PROJECT, grants: [OTHER_PROJECT], volumeName: "v-other" }));
  await context.scheduler.createProfile(makeProfile(worker, { ref: "profile_shared" as never, ownerProject: OTHER_PROJECT, grants: [OTHER_PROJECT, AGENT_PROJECT], volumeName: "v-shared" }));
  return context;
}

const me = async (principal: Principal | undefined, scheduler: Awaited<ReturnType<typeof setup>>["scheduler"]) =>
  createApiFetch({ scheduler, authenticate: () => principal })(new Request("https://fabric.test/v1/me"));

describe("GET /v1/me", () => {
  test("a project operator sees only its projects, usable profiles and served recipes", async () => {
    const { scheduler } = await setup();
    const response = await me(AGENT, scheduler);
    expect(response.status).toBe(200);
    const body = await response.json() as PrincipalCapabilities;
    expect(body.principal).toBe(AGENT.id);
    expect(body.roles).toEqual(["project_operator"]);
    expect(body.projects).toEqual([{ id: AGENT_PROJECT, name: "Agent" }]);
    // Owned and granted profiles; neither a revoked one nor another project's private one.
    expect(body.profiles.map((profile) => profile.ref)).toEqual(["profile_agent", "profile_shared"] as never);
    expect(body.profiles[0]).toEqual({ ref: "profile_agent", ownerProject: AGENT_PROJECT, grants: [AGENT_PROJECT], profileFamily: "default", status: "active" } as never);
    expect(body.recipes).toEqual([
      { ref: "recipe_chrome@1", runtime: "chrome", mode: "interactive", access: "raw_cdp", profileFamily: "default" },
      { ref: "recipe_example-fetch@1", runtime: "chrome", mode: "headless", access: "typed_job", profileFamily: "default" },
    ] as never);
    expect(body.egressPolicies).toContain("egress_direct@1" as never);
    expect([...body.egressPolicies].sort()).toEqual(body.egressPolicies);
    expect(body.artifactPolicies).toEqual(["artifact-policy_standard-30-days@1"] as never);
  });

  test("a fabric admin sees every active project and their profiles", async () => {
    const { scheduler } = await setup();
    const body = await (await me(TEST_PRINCIPAL, scheduler)).json() as PrincipalCapabilities;
    expect(body.projects.map((project) => project.id)).toEqual([AGENT_PROJECT, OTHER_PROJECT, TEST_PROJECT]);
    expect(body.profiles.map((profile) => profile.ref)).toEqual(["profile_agent", "profile_other", "profile_shared"] as never);
  });

  test("rejects unauthenticated callers and principals whose identity does not match the registry", async () => {
    const { scheduler } = await setup();
    expect((await me(undefined, scheduler)).status).toBe(401);
    const forged = await me({ ...AGENT, certificateFingerprint: "someone-else" }, scheduler);
    expect(forged.status).toBeGreaterThanOrEqual(401);
    expect(forged.status).toBeLessThanOrEqual(403);
  });

  test("only GET is routed", async () => {
    const { scheduler } = await setup();
    const response = await createApiFetch({ scheduler, authenticate: () => AGENT })(new Request("https://fabric.test/v1/me", { method: "POST" }));
    expect(response.status).toBe(404);
  });
});
