import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FabricError } from "@browser-fabric/contracts";
import { ArtifactCollector, MemoryObjectStore } from "@browser-fabric/control-plane";
import { builtInEgressPolicies } from "@browser-fabric/policy";
import { defaultRuntimeRegistry, NativeSocialRuntime } from "@browser-fabric/worker-runtime";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler } from "@browser-fabric/testkit";

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
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "artifact-session", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_reporting-residential@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const artifact = await collector.capture({ project: TEST_PROJECT, sessionId: session.id as never, kind: "screenshot", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]), policy: { ref: "artifact-policy_standard-30-days@1" as never, retentionDays: 30, allowedKinds: ["screenshot"], createdAt: new Date().toISOString() } });
    expect(artifact.objectKey).toContain("projects/project_test/artifacts");
    expect((await objectStore.head(artifact.objectKey)).sha256).toBe(artifact.sha256);
  });

  test("runtime specs cannot mount secrets or host resources", async () => {
    const context = await bootstrapTestScheduler();
    const session = await context.scheduler.createBrowserSession({ project: TEST_PROJECT, idempotencyKey: "runtime", runtime: "rebrowser-puppeteer", browserRecipeRef: "recipe_rebrowser-reporting@1" as never, profileRef: context.profile.ref, leaseMode: "writer", egressPolicyRef: "egress_reporting-residential@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never, ttlSeconds: 600 }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const runtime = defaultRuntimeRegistry().get("rebrowser-puppeteer");
    const spec = runtime.buildSpec(assignment!, context.worker, builtInEgressPolicies.find((policy) => policy.family === "reporting-residential")!);
    expect(spec.security).toEqual({ dockerSocketMounted: false, hostHomeMounted: false, repositoryMounted: false, applicationSecretsMounted: false });
    expect(spec.volumes[0]?.target).toBe("/fabric/profile");
    expect(spec.command.some((arg) => arg.includes("remote-debugging-port"))).toBe(true);
    expect(Object.keys(spec.environment).some((key) => /PASSWORD|TOKEN|COOKIE|SECRET/i.test(key))).toBe(false);
  });

  test("SocialApi remains a native Playwright worker instead of being coerced into CDP", async () => {
    const context = await bootstrapTestScheduler();
    const profile = await context.scheduler.createProfile({ ...context.profile, ref: "profile_social" as never, profileFamily: "social", volumeName: "profile-volume" }, TEST_PRINCIPAL);
    const job = await context.scheduler.createJob({ project: TEST_PROJECT, idempotencyKey: "social-native", recipeRef: "recipe_social-insights@1" as never, operation: { operation: "collect_insights", username: "creator" }, profileRef: profile.ref, egressPolicyRef: "egress_social-proxy-fallback@1" as never, artifactPolicyRef: "artifact-policy_standard-30-days@1" as never }, TEST_PRINCIPAL);
    const [assignment] = await context.scheduler.dispatch();
    const spec = new NativeSocialRuntime().buildSpec(assignment!, context.worker, builtInEgressPolicies.find((policy) => policy.family === "social-proxy-fallback")!);
    expect(spec.command).toEqual(["python", "-m", "browser_fabric_social_worker"]);
    expect(spec.command.join(" ")).not.toContain("chromium");
    expect(spec.cdpBind.port).toBe(0);
    expect(job.status).toBe("queued");
  });

  test("media relay validates ranges and URL scheme", async () => {
    const { MediaRelay } = await import("../workers/media-relay/src/index");
    const policy = builtInEgressPolicies.find((candidate) => candidate.family === "media-proxy-affinity")!;
    const relay = new MediaRelay(policy, async (_url, init) => new Response(new Uint8Array([7, 8]), { status: 206, headers: { "content-type": "video/mp4", "x-range": new Headers(init?.headers).get("range") ?? "" } }));
    const result = await relay.fetch({ manifestUrl: "https://media.example/segment.ts", provider: "CDN-A", range: { start: 4, end: 9 } });
    expect(result.status).toBe(206);
    await expect(relay.fetch({ manifestUrl: "file:///tmp/secret", provider: "CDN-A" })).rejects.toThrow();
    await expect(relay.fetch({ manifestUrl: "https://media.example/segment.ts", provider: "CDN-A", range: { start: -1 } })).rejects.toThrow();
  });
});
