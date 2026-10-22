import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FabricError } from "@browser-fabric/contracts";
import { ArtifactCollector, MemoryObjectStore } from "@browser-fabric/control-plane";
import { builtInEgressPolicies } from "@browser-fabric/policy";
import { defaultRuntimeRegistry } from "@browser-fabric/worker-runtime";
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
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "artifact-session", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct-egress@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
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
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "artifact-clock-skew", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct-egress@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
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
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "runtime", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_direct-egress@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const runtime = defaultRuntimeRegistry().get("rebrowser-puppeteer");
    const spec = runtime.buildSpec(assignment!, context.worker, builtInEgressPolicies.find((policy) => policy.family === "direct-egress")!);
    expect(spec.security).toEqual({ dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false });
    expect(spec.volumes[0]?.target).toBe("/fabric/profile");
    expect(spec.command.some((arg) => arg.includes("remote-debugging-port"))).toBe(true);
    expect(spec.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", "/usr/bin/chromium"]);
    expect(spec.command).toContain("--remote-debugging-address=127.0.0.1");
    expect(spec.command).toContain("--remote-debugging-port=9222");
    expect(spec.cdpBind).toEqual({ host: "private-overlay", port: 9223 });
    expect(spec.turnstileGuardian).toMatchObject({
      enabled: true,
      pollIntervalMs: 1_000,
      challengeTimeoutMs: 12_000,
      maxClickAttempts: 5,
    });
    expect(Object.keys(spec.environment).some((key) => /PASSWORD|TOKEN|COOKIE|SECRET/i.test(key))).toBe(false);
  });

  test("SocialApi attaches to a separately managed Chromium CDP browser", async () => {
    const context = await bootstrapTestScheduler();
    const profile = await context.scheduler.createProfile({ ...context.profile, ref: "profile_social" as never, profileFamily: "social", volumeName: "profile-volume" }, TEST_PRINCIPAL);
    const job = await context.scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "social-native", recipeRef: "recipe_social-insights@1" as never, operation: { operation: "collect_insights", username: "creator" }, profileRef: profile.ref, egressPolicyRef: "egress_social-proxy-fallback@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const spec = defaultRuntimeRegistry().get("playwright-social").buildSpec(assignment!, context.worker, builtInEgressPolicies.find((policy) => policy.family === "social-proxy-fallback")!);
    expect(spec.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", "/usr/bin/chromium"]);
    expect(spec.command).toContain("--remote-debugging-port=9222");
    expect(spec.command).toContain("--user-data-dir=/fabric/profile/chromium");
    expect(spec.cdpBind.port).toBe(9223);
    expect(spec.turnstileGuardian?.enabled).toBe(true);
    expect(job.status).toBe("queued");
  });

  test("an explicitly interactive managed worker receives a private Xvfb browser lease", async () => {
    const { scheduler } = createTestScheduler({ maxActiveBrowserLeases: 1 });
    await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
    const worker = makeWorker({
      id: "worker_managed_chat" as never,
      isLocal: false,
      capacity: 1,
      mediaCapacity: 0,
      volumeNames: ["profile_chat"],
      capabilities: {
        runtimeFamilies: ["chromium-cdp"],
        recipeRefs: ["recipe_chat-browser-controller@1" as never],
        browserVersions: { chromium: "pinned" },
        supportsInteractive: true,
        supportsCompanionCompanion: false,
        supportedProfileFamilies: ["chat"],
      },
    });
    await scheduler.registerWorker(worker, TEST_PRINCIPAL);
    const profile = await scheduler.createProfile(makeProfile(worker, {
      ref: "profile_chat" as never,
      profileFamily: "chat",
      volumeName: "profile_chat",
    }), TEST_PRINCIPAL);
    await scheduler.createBrowserSession({
      project: TEST_PROJECT,
      idempotencyKey: "managed-interactive-chat",
      runtime: "chromium-cdp",
      browserRecipeRef: "recipe_chat-browser-controller@1" as never,
      profileRef: profile.ref,
      leaseMode: "interactive",
      egressPolicyRef: "egress_tor-egress@1" as never,
      artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
      ttlSeconds: 600,
    }, TEST_PRINCIPAL);
    const [assignment] = await scheduler.dispatch();
    expect(assignment?.lease?.workerId).toBe(worker.id);
    const spec = defaultRuntimeRegistry().get("chromium-cdp").buildSpec(
      assignment!,
      worker,
      builtInEgressPolicies.find((policy) => policy.ref === "egress_tor-egress@1")!,
    );
    expect(spec.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", "/usr/bin/chromium"]);
    expect(spec.command).toContain("--start-maximized");
    expect(spec.command).toContain("--disable-setuid-sandbox");
    expect(spec.command).not.toContain("--no-sandbox");
    expect(spec.cdpBind).toEqual({ host: "private-overlay", port: 9223 });
  });

  test("media relay validates immutable-source ranges, public URLs, and content types", async () => {
    const { MediaRelay } = await import("../workers/media-relay/src/index");
    const policy = builtInEgressPolicies.find((candidate) => candidate.family === "media-proxy-affinity")!;
    const seen: RequestInit[] = [];
    const relay = new MediaRelay(policy, async (_url, init) => {
      seen.push(init ?? {});
      return new Response(new Uint8Array([7, 8, 9, 10, 11, 12]), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 4-9/10",
          "content-length": "6",
        },
      });
    });
    const result = await relay.fetch({
      resourceUrl: "https://media.example/segment.ts",
      provider: "CDN-A",
      expectedContentTypes: ["video/mp4"],
      requestHeaders: { accept: "*/*", origin: "https://media.example", referer: "https://media.example/watch", "user-agent": "Fabric fixture" },
      range: { start: 4, end: 9 },
    });
    expect(result.status).toBe(206);
    expect(new Headers(seen[0]?.headers).get("range")).toBe("bytes=4-9");
    expect(new Headers(seen[0]?.headers).get("origin")).toBe("https://media.example");
    expect(new Headers(seen[0]?.headers).get("referer")).toBe("https://media.example/watch");
    expect(new Headers(seen[0]?.headers).get("cookie")).toBeNull();
    await expect(relay.fetch({ resourceUrl: "file:///tmp/secret", provider: "CDN-A" })).rejects.toThrow();
    await expect(relay.fetch({ resourceUrl: "https://127.0.0.1/segment.ts", provider: "CDN-A" })).rejects.toThrow();
    await expect(relay.fetch({ resourceUrl: "https://media.example/segment.ts", provider: "CDN-A", range: { start: -1 } })).rejects.toThrow();
    await expect(relay.fetch({ resourceUrl: "https://media.example/segment.ts", provider: "CDN-A", expectedContentTypes: ["application/vnd.apple.mpegurl"] })).rejects.toThrow(/unexpected content type/);

    const redirected: string[] = [];
    const redirectRelay = new MediaRelay(policy, async (url, init) => {
      redirected.push(url);
      expect(init?.redirect).toBe("manual");
      if (redirected.length === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.example/video.mp4" } });
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/mp4" } });
    });
    await expect(redirectRelay.fetch({ resourceUrl: "https://media.example/start", provider: "CDN-A" })).resolves.toMatchObject({ status: 200 });
    expect(redirected).toEqual(["https://media.example/start", "https://cdn.example/video.mp4"]);

    const privateRedirectRelay = new MediaRelay(policy, async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(privateRedirectRelay.fetch({ resourceUrl: "https://media.example/start", provider: "CDN-A" })).rejects.toThrow(/public provider host/);
    const ignoredRangeRelay = new MediaRelay(policy, async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/mp4" } }));
    await expect(ignoredRangeRelay.fetch({ resourceUrl: "https://media.example/video.mp4", provider: "CDN-A", range: { start: 0, end: 0 } })).rejects.toThrow(/ignored the requested byte range/);
  });
});
