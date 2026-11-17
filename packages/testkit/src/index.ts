import { createId, runtimeFamilies, type Principal, type Profile, type ProjectId, type Worker } from "@browser-fabric/contracts";
import { BrowserScheduler, FakeClock, InMemoryFabricStore, CapabilitySigner, MemoryEphemeralInputVault, parseFabricCatalog } from "@browser-fabric/control-plane";
import { builtInRecipes } from "@browser-fabric/recipes";

/**
 * The catalog test schedulers load: a typed browser recipe (recipe_example-fetch@1), a raw recipe
 * without token solving (recipe_example-guardian-only@1) and two
 * policies that exercise listener selection (egress_example-affinity@1 with a direct-exception
 * host, egress_example-static-direct@1 with direct static assets).
 */
export const exampleCatalogDocument = {
  version: 1,
  recipes: [
    {
      name: "example-fetch",
      runtime: "chromium-cdp",
      profileFamily: "default",
      mode: "headless",
      access: "typed_job",
      challengeHandlerSetRef: "challenge_captcha-solver@1",
      typedOperations: [{ name: "fetch_page", requiredFields: ["url"], allowedFields: ["url", "serialized", "cookieJarRef"], secretInputFields: ["cookie"] }],
      maxAttempts: 2,
    },
    { name: "example-guardian-only", runtime: "chromium-cdp", profileFamily: "default", mode: "headless", access: "raw_cdp", challengeHandlerSetRef: "challenge_guardian@1" },
  ],
  egressPolicies: [
    {
      name: "example-affinity",
      routes: {
        ...Object.fromEntries(["document", "api", "websocket", "static_asset", "provider_handshake", "media_manifest", "media_key", "media_segment", "media_range"].map((trafficClass) => [trafficClass, { kind: "proxy", proxyRef: "affinity", protocol: "socks5h" }])),
        direct_exception: { kind: "direct" },
      },
      constraints: { preserveProxyAffinity: true, allowDirectMediaRelay: true },
      sidecar: { listener: { id: "affinity", port: 11010 }, directListener: { id: "direct", port: 11000 } },
      directExceptionHostnames: ["direct.example"],
    },
    {
      name: "example-static-direct",
      routes: {
        document: { kind: "proxy", proxyRef: "upstream", protocol: "https" },
        api: { kind: "proxy", proxyRef: "upstream", protocol: "https" },
        websocket: { kind: "proxy", proxyRef: "upstream", protocol: "https" },
        browser_download: { kind: "proxy", proxyRef: "upstream", protocol: "https" },
        static_asset: { kind: "direct" },
        direct_exception: { kind: "direct" },
      },
      constraints: { preserveProxyAffinity: true, disableServiceWorkersInProxyMode: true },
      sidecar: { listener: { id: "proxy", port: 11001 }, directListener: { id: "direct", port: 11000 } },
    },
  ],
} as const;

export const exampleCatalog = parseFabricCatalog(exampleCatalogDocument);

export const TEST_PROJECT = "project_test" as ProjectId;
export const TEST_PRINCIPAL: Principal = {
  id: "principal_test" as Principal["id"],
  displayName: "test principal",
  projectGrants: [TEST_PROJECT],
  roles: ["fabric_admin", "project_admin", "project_operator"],
  certificateFingerprint: "test-principal-cert",
  createdAt: "2026-01-01T00:00:00.000Z"
};

export function makeWorker(overrides: Partial<Worker> = {}): Worker {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: (overrides.id ?? createId("worker")) as Worker["id"],
    certificateFingerprint: overrides.certificateFingerprint ?? `cert-${crypto.randomUUID()}`,
    ...(overrides.enrollmentTokenHash === undefined ? {} : { enrollmentTokenHash: overrides.enrollmentTokenHash }),
    ...(overrides.inputEncryptionPublicKeyPem === undefined ? {} : { inputEncryptionPublicKeyPem: overrides.inputEncryptionPublicKeyPem }),
    endpoint: overrides.endpoint ?? "https://worker.internal",
    cdpRelayEndpoint: overrides.cdpRelayEndpoint ?? "wss://worker.internal/cdp",
    ...(overrides.mediaPlaybackEndpoint === undefined ? { mediaPlaybackEndpoint: "http://media-worker.internal:8084" } : { mediaPlaybackEndpoint: overrides.mediaPlaybackEndpoint }),
    capabilities: overrides.capabilities ?? {
      runtimeFamilies: [...runtimeFamilies],
      recipeRefs: [...builtInRecipes, ...exampleCatalog.recipes].map((recipe) => recipe.ref),
      browserVersions: { chromium: "stable" },
      supportsInteractive: overrides.isLocal ?? false,
      supportedProfileFamilies: ["default", "interactive", "media"]
    },
    capacity: overrides.capacity ?? (overrides.isLocal ? 1 : 3),
    activeLeases: overrides.activeLeases ?? 0,
    mediaCapacity: overrides.mediaCapacity ?? 8,
    activeMediaTasks: overrides.activeMediaTasks ?? 0,
    health: overrides.health ?? "healthy",
    isLocal: overrides.isLocal ?? false,
    volumeNames: overrides.volumeNames ?? ["profile-volume", "profile-volume-g1", "profile-volume-g2"],
    resourceLimits: overrides.resourceLimits ?? { maxBrowserLeases: 3, cpuMilli: 2_000, memoryMiB: 4_096, pids: 512, shmMiB: 1_024, temporaryStorageMiB: 4_096 },
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now
  };
}

export function makeProfile(worker: Worker, overrides: Partial<Profile> = {}): Profile {
  return {
    ref: (overrides.ref ?? createId("profile")) as Profile["ref"],
    ownerProject: overrides.ownerProject ?? TEST_PROJECT,
    grants: overrides.grants ?? [TEST_PROJECT],
    workerId: worker.id,
    volumeName: overrides.volumeName ?? worker.volumeNames[0] ?? "profile-volume",
    profileFamily: overrides.profileFamily ?? "default",
    volumeGeneration: overrides.volumeGeneration ?? 1,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z"
  };
}

export function createTestScheduler(options: { clock?: FakeClock; maxActiveBrowserLeases?: number } = {}): { scheduler: BrowserScheduler; clock: FakeClock; store: InMemoryFabricStore; worker: Worker } {
  const clock = options.clock ?? new FakeClock("2026-01-01T00:00:00.000Z");
  const store = new InMemoryFabricStore();
  const signer = new CapabilitySigner({ secret: "01234567890123456789012345678901", clock, gatewayBaseUrl: "wss://fabric.test" });
  const scheduler = new BrowserScheduler({ store, clock, capabilitySigner: signer, catalog: exampleCatalog, ephemeralInputVault: new MemoryEphemeralInputVault(() => clock.now()), allowPlaintextEphemeralInputs: true, ...(options.maxActiveBrowserLeases === undefined ? {} : { maxActiveBrowserLeases: options.maxActiveBrowserLeases }) });
  const worker = makeWorker({ id: "worker_test" as Worker["id"] });
  return { scheduler, clock, store, worker };
}

export async function bootstrapTestScheduler(options: { localWorker?: boolean } = {}) {
  const context = createTestScheduler();
  await context.scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
  const worker = options.localWorker ? makeWorker({ id: "worker_local" as Worker["id"], isLocal: true, capacity: 1, mediaCapacity: 0, volumeNames: ["profile-volume"] }) : context.worker;
  await context.scheduler.registerWorker(worker);
  const profile = makeProfile(worker);
  await context.scheduler.createProfile(profile);
  return { ...context, worker, profile };
}
