import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FabricError } from "@browser-fabric/contracts";
import { ArtifactCollector, MemoryObjectStore } from "@browser-fabric/control-plane";
import { builtInEgressPolicies } from "@browser-fabric/policy";
import { defaultRuntimeRegistry, FABRIC_BROWSER_EXECUTABLE, withFabricDisabledFeatures } from "@browser-fabric/worker-runtime";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, createTestScheduler, makeProfile, makeWorker } from "@browser-fabric/testkit";

describe("artifacts and worker isolation", () => {
  test("object store is immutable and signed URLs are bounded", async () => {
    const store = new MemoryObjectStore();
    const body = new TextEncoder().encode("fixture");
    const sha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const object = await store.put({ key: "projects/project_test/artifacts/a/log/fixture", body, contentType: "text/plain", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(object.sha256).toBe(sha);
    await expect(store.put({ key: object.key, body: new TextEncoder().encode("changed"), contentType: "text/plain", expiresAt: object.expiresAt })).rejects.toThrow(FabricError);
    expect(await store.signedReadUrl(object.key, 60)).toContain("sig=");
    await expect(store.signedReadUrl(object.key, 901)).rejects.toThrow(/TTL/);
  });

  test("artifact collector writes bytes then a matching immutable record", async () => {
    const context = await bootstrapTestScheduler();
    const objectStore = new MemoryObjectStore();
    const collector = new ArtifactCollector({ scheduler: context.scheduler, objectStore });
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "artifact-session", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const artifact = await collector.capture({ project: TEST_PROJECT, sessionId: session.id as never, kind: "screenshot", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]), policy: { ref: "artifact-policy_standard-30-days@1" as never, retentionDays: 30, allowedKinds: ["screenshot"], createdAt: new Date().toISOString() } });
    expect(artifact.objectKey).toContain("projects/project_test/artifacts");
    expect((await objectStore.head(artifact.objectKey)).sha256).toBe(artifact.sha256);
  });

  test("accepts a verified immutable object from a healthy sibling with bounded clock skew", async () => {
    const context = await bootstrapTestScheduler();
    const objectStore = new MemoryObjectStore(undefined, () => new Date(context.clock.now().getTime() + 2 * 60_000));
    const collector = new ArtifactCollector({
      scheduler: context.scheduler,
      objectStore,
      // Simulate the replica that performed the object write being two minutes ahead. The
      // scheduler attaches the storage-verified expiry without treating harmless NTP skew as an
      // attempt to extend 30-day retention.
      clock: () => new Date(context.clock.now().getTime() + 2 * 60_000),
    });
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "artifact-clock-skew", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const artifact = await collector.capture({
      project: TEST_PROJECT,
      sessionId: session.id,
      kind: "screenshot",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      policy: await context.scheduler.getArtifactPolicy("artifact-policy_standard-30-days@1" as never, TEST_PRINCIPAL),
      actor: TEST_PRINCIPAL,
    });
    expect(new Date(artifact.expiresAt).getTime()).toBe(context.clock.now().getTime() + 30 * 86_400_000 + 2 * 60_000);
  });

  test("runtime specs cannot mount secrets or host resources", async () => {
    const context = await bootstrapTestScheduler();
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "runtime", runtime: "chrome", browserRecipeRef: "recipe_chrome-headless@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const runtime = defaultRuntimeRegistry().get("chrome");
    const spec = runtime.buildSpec(assignment!, context.worker, builtInEgressPolicies.find((policy) => policy.family === "direct")!);
    expect(spec.security).toEqual({ dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false });
    expect(spec.volumes[0]?.target).toBe("/fabric/profile");
    expect(spec.command.some((arg) => arg.includes("remote-debugging-port"))).toBe(true);
    expect(spec.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", FABRIC_BROWSER_EXECUTABLE]);
    expect(spec.command).toContain("--remote-debugging-address=127.0.0.1");
    expect(spec.command).toContain("--remote-debugging-port=9222");
    expect(spec.cdpBind).toEqual({ host: "private-overlay", port: 9223 });
    expect(spec.captchaGuardian).toEqual({ enabled: true, pollIntervalMs: 1_000, solveTimeoutMs: 180_000, maxRounds: 8 });
    expect(Object.keys(spec.environment).some((key) => /PASSWORD|TOKEN|COOKIE|SECRET/i.test(key))).toBe(false);
  });

  test("an explicitly interactive managed worker receives a private Xvfb browser lease", async () => {
    const { scheduler } = createTestScheduler({ maxActiveBrowserLeases: 1 });
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    const worker = makeWorker({
      id: "worker_managed_interactive" as never,
      isLocal: false,
      capacity: 1,
      volumeNames: ["profile_example_interactive"],
      capabilities: {
        runtimeFamilies: ["chrome"],
        recipeRefs: ["recipe_chrome@1" as never],
        browserVersions: { chromium: "pinned" },
        supportsInteractive: true,
        supportedProfileFamilies: ["default"],
      },
    });
    await scheduler.registerWorker(worker, TEST_PRINCIPAL);
    const profile = await scheduler.createProfile(makeProfile(worker, {
      ref: "profile_example_interactive" as never,
      profileFamily: "default",
      volumeName: "profile_example_interactive",
    }), TEST_PRINCIPAL);
    await scheduler.createBrowserSession({
      project: TEST_PROJECT,
      idempotencyKey: "managed-interactive",
      runtime: "chrome",
      browserRecipeRef: "recipe_chrome@1" as never,
      profileRef: profile.ref,
      leaseMode: "interactive",
      egressPolicyRef: "egress_tor@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    expect(assignment?.lease?.workerId).toBe(worker.id);
    const spec = defaultRuntimeRegistry().get("chrome").buildSpec(
      assignment!,
      worker,
      builtInEgressPolicies.find((policy) => policy.ref === "egress_tor@1")!,
    );
    expect(spec.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", FABRIC_BROWSER_EXECUTABLE]);
    expect(spec.command).toContain("--start-maximized");
    expect(spec.command).toContain("--use-angle=swiftshader");
    expect(spec.command).toContain("--enable-unsafe-swiftshader");
    expect(spec.command).toContain("--no-first-run");
    expect(spec.command).toContain("--disable-setuid-sandbox");
    expect(spec.command).not.toContain("--no-sandbox");
    expect(spec.cdpBind).toEqual({ host: "private-overlay", port: 9223 });
    // Chrome 157+ would otherwise block plain-http pages (net::ERR_BLOCKED_BY_CLIENT): exactly one switch carries it.
    expect(spec.command.filter((arg) => arg.startsWith("--disable-features="))).toEqual(["--disable-features=HttpsFirstBalancedModeAutoEnable"]);
  });

  test("a recipe's own --disable-features is merged into Fabric's, never a second switch Chrome would ignore", () => {
    expect(withFabricDisabledFeatures(["--disable-dev-shm-usage"])).toEqual(["--disable-dev-shm-usage", "--disable-features=HttpsFirstBalancedModeAutoEnable"]);
    expect(withFabricDisabledFeatures(["--disable-features=Translate, AutofillServerCommunication", "--lang=de", "--disable-features=Translate"]))
      .toEqual(["--lang=de", "--disable-features=HttpsFirstBalancedModeAutoEnable,Translate,AutofillServerCommunication"]);
    expect(withFabricDisabledFeatures(["--disable-features=HttpsFirstBalancedModeAutoEnable"])).toEqual(["--disable-features=HttpsFirstBalancedModeAutoEnable"]);
  });

});
