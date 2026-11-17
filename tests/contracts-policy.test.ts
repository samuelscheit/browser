import { describe, expect, test } from "bun:test";
import { FabricError, MAX_EXTERNAL_CDP_CONNECTIONS, parseBrowserSessionCreate, parseJobCreate } from "@browser-fabric/contracts";
import { assertDurablePayload, scalarMetadata } from "@browser-fabric/control-plane";
import { builtInEgressPolicies, makeEgressPolicy, planChallenge } from "@browser-fabric/policy";
import { exampleCatalog } from "@browser-fabric/testkit";
import { builtInChallengeSets } from "@browser-fabric/policy";
import { RecipeRegistry, assertOperationContainsNoSecrets, builtInRecipes, validateTypedOperation } from "@browser-fabric/recipes";

describe("contracts and immutable policies", () => {
  test("parses versioned opaque IDs and defaults session TTL", () => {
    const request = parseBrowserSessionCreate({
      project: "project_test",
      idempotencyKey: "request-1",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome-headless@1",
      profileRef: "profile_reporting",
      leaseMode: "writer",
      egressPolicyRef: "egress_direct@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1"
    });
    expect(request.ttlSeconds).toBe(1800);
    expect(request.maxExternalConnections).toBe(1);
    expect(parseBrowserSessionCreate({ ...request, maxExternalConnections: 2 }).maxExternalConnections).toBe(2);
    expect(parseBrowserSessionCreate({ ...request, maxExternalConnections: MAX_EXTERNAL_CDP_CONNECTIONS }).maxExternalConnections).toBe(8);
    for (const invalid of [0, MAX_EXTERNAL_CDP_CONNECTIONS + 1, 2.5, "2", null]) {
      expect(() => parseBrowserSessionCreate({ ...request, maxExternalConnections: invalid })).toThrow(/maxExternalConnections/);
    }
    expect(() => parseBrowserSessionCreate({ ...request, project: "test" })).toThrow(FabricError);
    expect(() => parseJobCreate({ project: "project_test", idempotencyKey: "j", recipeRef: "recipe_example-fetch@1", operation: {}, egressPolicyRef: "egress_proxy@1", artifactPolicyRef: "artifact-policy_standard-30-days@1", callback: { url: "http://insecure" } })).toThrow(/HTTPS/);
  });

  test("built-in egress policies are immutable values with exact refs and routes", () => {
    expect(builtInEgressPolicies.map((policy) => policy.ref)).toEqual(["egress_direct@1", "egress_proxy@1", "egress_tor@1"] as never);
    const [direct, proxy, tor] = builtInEgressPolicies;
    expect(direct!.routes.document).toEqual({ kind: "direct", retryThroughProxy: false });
    expect(proxy!.routes.static_asset).toMatchObject({ kind: "proxy", proxyRef: "default" });
    expect(tor!.routes.document).toEqual({ kind: "tor", poolRef: "default", remoteDns: true });
    // Tor does not route token-solver traffic: solver API calls take the dedicated sidecar listener.
    expect(tor!.routes.captcha_solver).toBeUndefined();
    expect(makeEgressPolicy({ name: "proxy", routes: proxy!.routes }).immutableHash).toBe(proxy!.immutableHash);
    expect(makeEgressPolicy({ name: "proxy", version: 2, routes: proxy!.routes }).ref).toBe("egress_proxy@2" as never);
    expect(makeEgressPolicy({ name: "proxy", routes: { document: { kind: "direct", retryThroughProxy: false } } }).immutableHash).not.toBe(proxy!.immutableHash);
  });

  test("challenge sets plan only the handlers they enable", () => {
    const set = builtInChallengeSets.find((candidate) => candidate.family === "manual-handoff")!;
    expect(planChallenge(set, "manual-handoff").action).toBe("pause_for_manual");
    expect(planChallenge(set, "guardian").action).toBe("run_automatic");
    expect(() => planChallenge(set, "dbc")).toThrow(/not enabled/);
    expect(builtInChallengeSets.map((candidate) => candidate.ref)).toEqual(["challenge_guardian@1", "challenge_captcha-solver@1", "challenge_manual-handoff@1"] as never);
  });

  test("rejects secret values and unknown typed fields", () => {
    expect(() => assertOperationContainsNoSecrets({ password: "raw-secret" })).toThrow(/ephemeral/);
    const recipe = new RecipeRegistry([...builtInRecipes, ...exampleCatalog.recipes]).get("recipe_example-fetch@1" as never);
    validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", cookieJarRef: "artifact_1" });
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", selector: "//bad" })).toThrow(/not permitted/);
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page" })).toThrow(/operation.url is required/);
    expect(() => validateTypedOperation(recipe, { operation: "screenshot", url: "https://site.example" })).toThrow(/not exposed/);
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", cookie: "raw" })).toThrow(/ephemeral/);
    const raw = new RecipeRegistry().get("recipe_chrome-headless@1" as never);
    expect(() => validateTypedOperation(raw, { operation: "fetch_page", url: "https://site.example" })).toThrow(/does not accept typed jobs/);
    expect(builtInRecipes.map((entry) => [entry.ref, entry.runtime, entry.mode])).toEqual([
      ["recipe_chrome@1", "chrome", "interactive"],
      ["recipe_chrome-headless@1", "chrome", "headless"],
    ] as never);
  });

  test("rejects credential-bearing URLs and authorization values from durable fields", () => {
    expect(() => assertDurablePayload({ sourceUrl: "https://user:password@example.test/file" })).toThrow(/URL credentials/);
    expect(() => assertDurablePayload({ sourceUrl: "https://example.test/file?X-Amz-Signature=opaque" })).toThrow(/query parameter/);
    expect(() => assertDurablePayload({ description: "Bearer opaque-access-token-value" })).toThrow(/authorization material/);
    expect(() => scalarMetadata({ callbackUrl: "https://example.test/hook?token=opaque" })).toThrow(/query parameter/);
    expect(() => parseJobCreate({
      project: "project_test",
      idempotencyKey: "callback-secret-url",
      recipeRef: "recipe_example-fetch@1",
      operation: { operation: "fetch_page", url: "https://site.example" },
      egressPolicyRef: "egress_proxy@1",
      artifactPolicyRef: "artifact-policy_standard-30-days@1",
      callback: { url: "https://app.example/hook?signature=opaque" },
    })).toThrow(/credential material/);
  });
});
