import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserScheduler, CapabilitySigner, FabricCatalogError, InMemoryFabricStore, loadFabricCatalog, parseFabricCatalog } from "@browser-fabric/control-plane";
import { builtInEgressPolicies, internalEgressProxyUrl } from "@browser-fabric/policy";
import { TEST_PRINCIPAL, TEST_PROJECT, makeProfile, makeWorker } from "@browser-fabric/testkit";
import type { Worker } from "@browser-fabric/contracts";

const exampleCatalogPath = new URL("../deploy/compose/catalog.example.json", import.meta.url);

const recipe = (overrides: Record<string, unknown> = {}) => ({ name: "site-de", runtime: "chromium-cdp", profileFamily: "default", mode: "headless", access: "raw_cdp", ...overrides });
const policy = (overrides: Record<string, unknown> = {}) => ({
  name: "pool-b",
  routes: { document: { kind: "proxy", proxyRef: "pool-b", protocol: "socks5h" } },
  sidecar: { listener: { id: "pool-b", port: 11020 } },
  ...overrides,
});

describe("deployment catalog", () => {
  test("the published example parses and only extends the built-ins", async () => {
    const catalog = parseFabricCatalog(await Bun.file(exampleCatalogPath).json());
    expect(catalog.projects).toEqual([{ id: "project_research", name: "Research" }] as never);
    expect(catalog.challengeSets.map((set) => set.ref)).toEqual(["challenge_solver-anticaptcha-only@1"] as never);
    expect(catalog.egressPolicies.map((entry) => entry.ref)).toEqual(["egress_proxy-static-direct@1"] as never);
    const [chromiumDe] = catalog.recipes;
    expect(chromiumDe?.ref).toBe("recipe_chromium-de@1" as never);
    expect(chromiumDe?.launch).toMatchObject({ locale: "de-DE", timezone: "Europe/Berlin", viewport: { width: 1366, height: 768 }, sharedMemoryMiB: 512 });
    expect(chromiumDe?.immutableHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("an empty document means built-ins only, and a missing file name loads nothing", async () => {
    expect(parseFabricCatalog({ version: 1 })).toEqual({ recipes: [], egressPolicies: [], challengeSets: [], projects: [] });
    expect(await loadFabricCatalog("")).toEqual({ recipes: [], egressPolicies: [], challengeSets: [], projects: [] });
  });

  test("the hash pins every launch-relevant field, so a changed recipe needs a new version", () => {
    const base = parseFabricCatalog({ version: 1, recipes: [recipe()] }).recipes[0]!;
    const changed = parseFabricCatalog({ version: 1, recipes: [recipe({ launch: { locale: "fr-FR" } })] }).recipes[0]!;
    expect(changed.ref).toBe(base.ref);
    expect(changed.immutableHash).not.toBe(base.immutableHash);
    expect(parseFabricCatalog({ version: 1, recipes: [recipe({ version: 2 })] }).recipes[0]!.ref).toBe("recipe_site-de@2" as never);
  });

  test.each([
    [{ version: 2 }, /version must be 1/],
    [{ version: 1, extra: true }, /catalog.extra is not a known field/],
    [{ version: 1, recipes: [recipe({ name: "Bad Name" })] }, /recipes\[0\].name is invalid/],
    [{ version: 1, recipes: [recipe({ runtime: "selenium" })] }, /runtime must be one of/],
    [{ version: 1, recipes: [recipe({ name: "chromium-cdp" })] }, /recipe_chromium-cdp@1 is built in/],
    [{ version: 1, recipes: [recipe(), recipe()] }, /declared twice/],
    [{ version: 1, recipes: [recipe({ access: "typed_job" })] }, /typedOperations is required/],
    [{ version: 1, recipes: [recipe({ typedOperations: [] })] }, /only allowed for a typed_job recipe/],
    [{ version: 1, recipes: [recipe({ access: "typed_job", typedOperations: [{ name: "op", requiredFields: ["url"], allowedFields: [] }] })] }, /allowedFields must include required field url/],
    [{ version: 1, recipes: [recipe({ challengeHandlerSetRef: "challenge_missing@1" })] }, /unknown challenge handler set challenge_missing@1/],
    [{ version: 1, recipes: [recipe({ launch: { launchFlags: ["--remote-debugging-port=1"] } })] }, /runtime-owned flag --remote-debugging-port/],
    [{ version: 1, recipes: [recipe({ launch: { launchFlags: ["--proxy-server=http://x"] } })] }, /runtime-owned flag --proxy-server/],
    [{ version: 1, recipes: [recipe({ launch: { launchFlags: ["--no-sandbox"] } })] }, /runtime-owned flag --no-sandbox/],
    [{ version: 1, recipes: [recipe({ launch: { viewport: { width: 10, height: 10 } } })] }, /viewport.width must be an integer/],
    [{ version: 1, egressPolicies: [policy({ routes: {} })] }, /must route at least one traffic class/],
    [{ version: 1, egressPolicies: [policy({ routes: { carrier_pigeon: { kind: "direct" } } })] }, /routes key must be one of/],
    [{ version: 1, egressPolicies: [policy({ sidecar: { listener: { id: "pool-b", port: 80 } } })] }, /port must be an integer from 1024/],
    [{ version: 1, egressPolicies: [policy({ name: "direct" })] }, /egress_direct@1 is built in/],
    [{ version: 1, egressPolicies: [policy({ directExceptionHostnames: ["*.example.com"] })] }, /directExceptionHostnames\[0\] is invalid/],
    [{ version: 1, egressPolicies: [policy({ routes: { document: { kind: "proxy", proxyRef: "pool-b", protocol: "ftp" } } })] }, /protocol must be one of/],
    [{ version: 1, challengeSets: [{ name: "x", handlers: [] }] }, /handlers must not be empty/],
    [{ version: 1, challengeSets: [{ name: "x", handlers: [{ id: "a", kind: "selenium", mode: "automatic" }] }] }, /kind must be one of/],
    [{ version: 1, challengeSets: [{ name: "x", handlers: [{ id: "a", kind: "dbc", mode: "automatic", configuration: { nested: { a: 1 } } }] }] }, /must be a string, number or boolean/],
    [{ version: 1, projects: [{ id: "research", name: "Research" }] }, /projects\[0\].id is invalid/],
  ])("rejects an invalid catalog: %j", (document, message) => {
    expect(() => parseFabricCatalog(document)).toThrow(FabricCatalogError);
    expect(() => parseFabricCatalog(document)).toThrow(message);
  });

  test("a catalog recipe may use a catalog challenge set", () => {
    const catalog = parseFabricCatalog({
      version: 1,
      challengeSets: [{ name: "manual-only", handlers: [{ id: "human", kind: "manual-handoff", mode: "manual" }] }],
      recipes: [recipe({ challengeHandlerSetRef: "challenge_manual-only@1" })],
    });
    expect(catalog.recipes[0]?.challengeHandlerSetRef).toBe("challenge_manual-only@1");
  });

  test("loading reports unreadable and malformed files without echoing their content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fabric-catalog-"));
    await expect(loadFabricCatalog(join(directory, "missing.json"))).rejects.toThrow(/cannot read .*ENOENT/);
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{ secret-looking garbage");
    await expect(loadFabricCatalog(malformed)).rejects.toThrow(/is not valid JSON/);
    await expect(loadFabricCatalog(malformed)).rejects.not.toThrow(/garbage/);
    const valid = join(directory, "catalog.json");
    await writeFile(valid, JSON.stringify({ version: 1, recipes: [recipe()] }));
    expect((await loadFabricCatalog(valid)).recipes.map((entry) => entry.ref)).toEqual(["recipe_site-de@1"] as never);
  });

  test("a scheduler serves catalog recipes, policies and projects next to the built-ins", async () => {
    const catalog = parseFabricCatalog({
      version: 1,
      projects: [{ id: "project_research", name: "Research" }],
      egressPolicies: [policy({ constraints: { preserveProxyAffinity: true } })],
      recipes: [recipe()],
    });
    const store = new InMemoryFabricStore();
    const scheduler = new BrowserScheduler({ store, catalog, capabilitySigner: new CapabilitySigner({ secret: "01234567890123456789012345678901", gatewayBaseUrl: "wss://fabric.test" }) });
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [{ ...TEST_PRINCIPAL, projectGrants: [TEST_PROJECT, "project_research" as never] }] });
    const state = await store.snapshot();
    expect(state.projects.get("project_research" as never)?.name).toBe("Research");
    expect(state.recipes.has("recipe_site-de@1" as never)).toBe(true);
    expect(state.recipes.has("recipe_chromium-cdp@1" as never)).toBe(true);
    const catalogPolicy = state.egressPolicies.get("egress_pool-b@1" as never)!;
    expect(internalEgressProxyUrl(catalogPolicy)).toBe("http://fabric-egress-sidecar:11020");
    for (const builtIn of builtInEgressPolicies) expect(state.egressPolicies.has(builtIn.ref)).toBe(true);

    // A restart with the same catalog keeps the existing project untouched.
    const createdAt = state.projects.get("project_research" as never)!.createdAt;
    await scheduler.bootstrap();
    expect((await store.snapshot()).projects.get("project_research" as never)?.createdAt).toBe(createdAt);

    const worker = makeWorker({
      id: "worker_research" as Worker["id"],
      capabilities: { runtimeFamilies: ["chromium-cdp"], recipeRefs: ["recipe_site-de@1" as never], browserVersions: {}, supportsInteractive: false, supportedProfileFamilies: ["default"] },
    });
    await scheduler.registerWorker(worker, TEST_PRINCIPAL);
    const profile = await scheduler.createProfile(makeProfile(worker, { ref: "profile_research" as never, ownerProject: "project_research" as never, grants: ["project_research" as never] }), TEST_PRINCIPAL);
    const session = await scheduler.createBrowserSession({
      project: "project_research" as never,
      idempotencyKey: "catalog-session",
      runtime: "chromium-cdp",
      browserRecipeRef: "recipe_site-de@1" as never,
      profileRef: profile.ref,
      leaseMode: "writer",
      egressPolicyRef: "egress_pool-b@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    expect(assignment?.session?.id).toBe(session.id);
    expect(assignment?.recipe.ref).toBe("recipe_site-de@1" as never);
    expect(assignment?.egressPolicy.ref).toBe("egress_pool-b@1" as never);
    expect(assignment?.challengeHandlerSet).toBeUndefined();
  });
});
