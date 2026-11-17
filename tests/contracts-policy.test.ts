import { describe, expect, test } from "bun:test";
import { FabricError, MAX_EXTERNAL_CDP_CONNECTIONS, parseBrowserSessionCreate, parseJobCreate, parseMediaManifest } from "@browser-fabric/contracts";
import { assertDurablePayload, scalarMetadata } from "@browser-fabric/control-plane";
import { builtInEgressPolicies, classifyTraffic, compileEgressManifest, decideEgress, makeEgressPolicy, parseProxyUrl, planChallenge } from "@browser-fabric/policy";
import { exampleCatalog } from "@browser-fabric/testkit";
import { builtInChallengeSets } from "@browser-fabric/policy";
import { RecipeRegistry, assertOperationContainsNoSecrets, builtInRecipes, validateTypedOperation } from "@browser-fabric/recipes";

describe("contracts and immutable policies", () => {
  test("parses versioned opaque IDs and defaults session TTL", () => {
    const request = parseBrowserSessionCreate({
      project: "project_test",
      idempotencyKey: "request-1",
      runtime: "rebrowser-puppeteer",
      browserRecipeRef: "recipe_rebrowser-puppeteer@1",
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

  test("accepts every required egress family and preserves direct-asset no-retry", () => {
    expect(builtInEgressPolicies.map((policy) => policy.ref)).toEqual(["egress_direct@1", "egress_proxy@1", "egress_tor@1"] as never);
    expect(decideEgress(builtInEgressPolicies[2]!, { trafficClass: "document", hostname: "example.test" }).route.kind).toBe("tor");
    expect(decideEgress(builtInEgressPolicies[2]!, { trafficClass: "media_segment", hostname: "example.test" }).route.kind).toBe("block");
    const staticDirect = exampleCatalog.egressPolicies.find((policy) => policy.family === "example-static-direct")!;
    expect(decideEgress(staticDirect, { trafficClass: "static_asset", hostname: "cdn.example", isRetry: false }).route.kind).toBe("direct");
    expect(decideEgress(staticDirect, { trafficClass: "static_asset", hostname: "cdn.example", isRetry: true }).route.kind).toBe("block");
    expect(decideEgress(staticDirect, { trafficClass: "api", hostname: "api.example" }).route.kind).toBe("proxy");
    expect(compileEgressManifest(staticDirect, ["socks5h://user:pass@proxy.example:1080"]).proxyDescriptors[0]?.remoteDns).toBe(true);
  });

  test("supports proxy protocols, classification, and challenge opt-in", () => {
    for (const protocol of ["http", "https", "socks4", "socks5", "socks5h"] as const) {
      const parsed = parseProxyUrl(`${protocol}://user:p%40ss@example.test:1234`);
      expect(parsed.descriptor.protocol).toBe(protocol);
      expect(parsed.credential?.password).toBe("p@ss");
    }
    expect(() => parseProxyUrl("ftp://example.test")).toThrow();
    expect(classifyTraffic("https://cdn.example/video.m3u8").trafficClass).toBe("media_manifest");
    expect(classifyTraffic("https://cdn.example/file.ts").trafficClass).toBe("media_segment");
    expect(classifyTraffic("https://example.test/api/graphql").trafficClass).toBe("api");
    const set = builtInChallengeSets.find((candidate) => candidate.family === "manual-handoff")!;
    expect(planChallenge(set, "manual-handoff").action).toBe("pause_for_manual");
  });

  test("rejects secret values and unknown typed fields", () => {
    expect(() => assertOperationContainsNoSecrets({ password: "raw-secret" })).toThrow(/ephemeral/);
    const recipe = new RecipeRegistry([...builtInRecipes, ...exampleCatalog.recipes]).get("recipe_example-fetch@1" as never);
    validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", cookieJarRef: "artifact_1" });
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", selector: "//bad" })).toThrow(/not permitted/);
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page" })).toThrow(/operation.url is required/);
    expect(() => validateTypedOperation(recipe, { operation: "screenshot", url: "https://site.example" })).toThrow(/not exposed/);
    expect(() => validateTypedOperation(recipe, { operation: "fetch_page", url: "https://site.example", cookie: "raw" })).toThrow(/ephemeral/);
    const raw = new RecipeRegistry().get("recipe_chromium-cdp@1" as never);
    expect(() => validateTypedOperation(raw, { operation: "fetch_page", url: "https://site.example" })).toThrow(/does not accept typed jobs/);
    expect(builtInRecipes.map((entry) => entry.ref)).toEqual([
      "recipe_chromium-cdp@1", "recipe_interactive-chromium@1", "recipe_patchright@1", "recipe_rebrowser-puppeteer@1", "recipe_media-relay@1", "recipe_media-playback@1",
    ] as never);
  });

  test("media manifests permit only bounded non-secret playback context", () => {
    const manifest = parseMediaManifest({
      version: 1,
      mode: "relay",
      provider: "Example provider",
      url: "https://media.example/video.mp4",
      artifactKind: "video",
      requestHeaders: {
        accept: "*/*",
        origin: "https://provider.example",
        referer: "https://provider.example/watch",
        "user-agent": "Fabric fixture",
      },
    });
    expect(manifest.mode).toBe("relay");
    if (manifest.mode !== "relay") throw new Error("fixture must parse as a relay manifest");
    expect(manifest.requestHeaders).toEqual({
      accept: "*/*",
      origin: "https://provider.example",
      referer: "https://provider.example/watch",
      "user-agent": "Fabric fixture",
    });
    expect(() => parseMediaManifest({ ...manifest, requestHeaders: { cookie: "must-not-persist" } })).toThrow(/not permitted/);
    expect(() => parseMediaManifest({ ...manifest, requestHeaders: { authorization: "Bearer opaque" } })).toThrow(/not permitted/);
    expect(() => parseMediaManifest({ ...manifest, requestHeaders: { origin: "https://user:pass@provider.example" } })).toThrow(/credential-free/);
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

test("policy-enforced fetch never lets callers override route selection", async () => {
  const { PolicyEnforcedFetcher } = await import("@browser-fabric/policy");
  const policy = exampleCatalog.egressPolicies.find((candidate) => candidate.family === "example-static-direct")!;
  const calls: string[] = [];
  const fetcher = new PolicyEnforcedFetcher({
    policy,
    directFetch: async (url) => { calls.push(`direct:${url}`); return new Response("asset", { status: 200 }); },
    proxyTransport: { fetch: async (url, _init, proxy) => { calls.push(`proxy:${proxy.protocol}:${url}`); return new Response("api", { status: 200 }); } },
    proxyUrls: ["https://proxy.example:8443"]
  });
  await fetcher.fetch("https://cdn.example/static.js");
  await fetcher.fetch("https://api.example/auth/token");
  expect(calls[0]).toMatch(/^direct:/);
  expect(calls[1]).toMatch(/^proxy:https:/);
  const blocked = new PolicyEnforcedFetcher({ policy, directFetch: async () => { throw new Error("must not be called"); } });
  await expect(blocked.fetch("https://cdn.example/static.js", {}, { isRetry: true })).rejects.toThrow(/blocked/);
});

test("direct-exception hosts bypass the proxy and the proxy fallback order is explicit", async () => {
  const { PolicyEnforcedFetcher } = await import("@browser-fabric/policy");
  const affinity = exampleCatalog.egressPolicies.find((candidate) => candidate.family === "example-affinity")!;
  const affinityCalls: string[] = [];
  const affinityFetcher = new PolicyEnforcedFetcher({
    policy: affinity,
    directFetch: async (url) => { affinityCalls.push(`direct:${url}`); return new Response("ok"); },
    proxyTransport: { fetch: async (url) => { affinityCalls.push(`proxy:${url}`); throw new Error("proxy down"); } },
    proxyUrls: ["socks5h://proxy.example:1080"]
  });
  await affinityFetcher.fetch("https://cdn.direct.example/path");
  expect(affinityCalls[0]).toMatch(/^direct:/);
  // A lookalike suffix is not an exception: it stays on the proxy route.
  await expect(affinityFetcher.fetch("https://notdirect.example/path")).rejects.toThrow(/proxy down/);

  const pool = makeEgressPolicy({
    name: "example-pool",
    routes: { api: { kind: "proxy", proxyRef: "primary", protocol: "https", remoteDns: true } },
    constraints: { preserveProxyAffinity: false, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: false },
    sidecar: { listener: { id: "proxy", port: 11001 } },
    proxyFallbackRefs: ["primary", "secondary"],
  });
  const attempts: string[] = [];
  const poolFetcher = new PolicyEnforcedFetcher({
    policy: pool,
    proxyTransport: { fetch: async (url, _init, _proxy, credential) => { attempts.push(credential?.username ?? "none"); if (attempts.length === 1) throw new Error("primary down"); return new Response("ok"); } },
    proxyUrls: ["https://proxy-a.example:8443", "https://proxy-b.example:8443"],
    proxyCredentials: new Map([["primary", { username: "primary", password: "a" }], ["secondary", { username: "secondary", password: "b" }]])
  });
  expect((await poolFetcher.fetch("https://site.example/api/data")).status).toBe(200);
  expect(attempts).toEqual(["primary", "secondary"]);
});
