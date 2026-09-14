import { createHash } from "node:crypto";
import { canonicalJson, FabricError, type ArtifactPolicy, type BrowserRecipe, type RecipeRef, type RuntimeFamily } from "@browser-fabric/contracts";

export type RecipeAccess = "raw_cdp" | "typed_job";

export interface TypedOperationSpec {
  name: string;
  requiredFields: readonly string[];
  allowedFields: readonly string[];
  /** Typed jobs do not accept secret values; they request them just in time through Fabric input requests. */
  secretInputFields: readonly string[];
}

export interface RecipeDefinition extends BrowserRecipe {
  access: RecipeAccess;
  challengeHandlerSetRef?: string;
  typedOperations?: readonly TypedOperationSpec[];
  maxAttempts: number;
}

const createdAt = "2026-09-02T00:00:00.000Z";
const recipeRef = (name: string): RecipeRef => `recipe_${name}@1` as RecipeRef;

function makeRecipe(
  name: string,
  runtime: RuntimeFamily,
  profileFamily: string,
  mode: BrowserRecipe["mode"],
  access: RecipeAccess,
  options: Partial<Pick<RecipeDefinition, "challengeHandlerSetRef" | "typedOperations" | "maxAttempts" | "allowedCompanionConnections">> = {}
): RecipeDefinition {
  const base = {
    name,
    runtime,
    profileFamily,
    mode,
    access,
    challengeHandlerSetRef: options.challengeHandlerSetRef,
    typedOperations: options.typedOperations,
    maxAttempts: options.maxAttempts ?? 1
  };
  return {
    ref: recipeRef(name),
    family: name,
    version: 1,
    runtime,
    immutableHash: `sha256:${createHash("sha256").update(canonicalJson(base)).digest("hex")}`,
    // Every browser recipe describes the separately managed Chromium process. The Python Social
    // worker is an application client and is deployed independently from this browser image.
    browserImage: `ghcr.io/browser-fabric/${runtime === "playwright-social" ? "chromium-cdp" : runtime}:1`,
    browserVersion: "chromium-pinned",
    mode,
    profileFamily,
    requiredCapabilities: [runtime, profileFamily, ...(mode === "interactive" ? ["interactive-ui"] : [])],
    allowedCompanionConnections: options.allowedCompanionConnections ?? ["none"],
    launch: {
      viewport: { width: 1440, height: 1024 },
      locale: "en-US",
      timezone: "UTC",
      launchFlags: ["--disable-background-networking", "--disable-dev-shm-usage"],
      extensions: [],
      initScripts: [],
      ...(name === "signup-direct-assets" ? { disableServiceWorkers: true } : {}),
      sharedMemoryMiB: mode === "interactive" ? 1024 : 512,
      downloadsEnabled: true
    },
    artifactDefaults: ["screenshot", "mhtml", "trace"],
    createdAt,
    access,
    ...(options.challengeHandlerSetRef === undefined ? {} : { challengeHandlerSetRef: options.challengeHandlerSetRef }),
    ...(options.typedOperations === undefined ? {} : { typedOperations: options.typedOperations }),
    maxAttempts: options.maxAttempts ?? 1
  };
}

const pfpOperation: TypedOperationSpec = {
  name: "update_avatar",
  requiredFields: ["manifestRef", "avatarArtifactRef", "approvedBy"],
  // The target identity, URL, and mutation instructions belong to the immutable Companion manifest.
  // Do not expose caller-controlled expectedAccount/dryRun fields: the former could approve a
  // different account and the latter previously looked safe while still starting a real task.
  allowedFields: ["manifestRef", "avatarArtifactRef", "approvedBy"],
  secretInputFields: ["password", "otp"]
};

const signupOperation: TypedOperationSpec = {
  name: "signup",
  requiredFields: ["signupConfigRef"],
  allowedFields: ["signupConfigRef", "freshProfile", "postSignupActionRef"],
  secretInputFields: ["password", "otp", "phoneVerification"]
};

export const builtInRecipes: readonly RecipeDefinition[] = [
  makeRecipe("rebrowser-reporting", "rebrowser-puppeteer", "reporting-reporting", "headless", "raw_cdp", {
    challengeHandlerSetRef: "challenge_reporting@1",
    allowedCompanionConnections: ["companion", "none"]
  }),
  makeRecipe("patchright-news", "patchright", "news-browser", "headless", "raw_cdp", {
    challengeHandlerSetRef: "challenge_news@1"
  }),
  makeRecipe("patchright-media", "patchright", "media", "headless", "raw_cdp"),
  makeRecipe("playwright-social", "playwright-social", "social", "headless", "typed_job", {
    challengeHandlerSetRef: "challenge-social-fallback@1",
    typedOperations: [{ name: "collect_insights", requiredFields: ["username"], allowedFields: ["username", "includeVideos", "cookieStateRef", "authStateRef", "maxVideos"], secretInputFields: ["msToken", "cookie"] }],
    maxAttempts: 3
  }),
  makeRecipe("companion-cdp", "companion", "avatar-account", "headful", "typed_job", {
    challengeHandlerSetRef: "challenge-avatar-manual@1",
    allowedCompanionConnections: ["companion", "file-input-bridge"],
    typedOperations: [pfpOperation],
    maxAttempts: 1
  }),
  makeRecipe("chat-browser-controller", "chromium-cdp", "chat", "interactive", "raw_cdp", {
    challengeHandlerSetRef: "challenge_chat-interactive@1"
  }),
  makeRecipe("interactive-chromium", "chromium-cdp", "interactive", "interactive", "raw_cdp"),
  makeRecipe("account-signup", "patchright", "account-signup", "interactive", "typed_job", {
    challengeHandlerSetRef: "challenge-signup-manual@1",
    typedOperations: [signupOperation],
    maxAttempts: 2
  }),
  // The Signup/Account adapter uses this raw-CDP variant when it needs to keep its existing
  // Patchright page-level workflow. The typed signup recipe remains the preferred path for
  // centrally orchestrated retries and manual handoff.
  makeRecipe("interactive-patchright", "patchright", "account-signup", "interactive", "raw_cdp", {
    challengeHandlerSetRef: "challenge-signup-manual@1"
  }),
  makeRecipe("reporting-reporting", "rebrowser-puppeteer", "reporting-reporting", "headless", "typed_job", {
    challengeHandlerSetRef: "challenge_reporting@1",
    typedOperations: [{ name: "submit_report", requiredFields: ["provider", "evidenceArtifactRefs"], allowedFields: ["provider", "evidenceArtifactRefs", "reportRef"], secretInputFields: ["providerCredential", "captchaCredential"] }],
    maxAttempts: 2,
    allowedCompanionConnections: ["companion", "none"]
  }),
  makeRecipe("news-browser-fetch", "patchright", "news-browser", "headless", "typed_job", {
    challengeHandlerSetRef: "challenge_news@1",
    typedOperations: [{ name: "fetch_news", requiredFields: ["url"], allowedFields: ["url", "serialized", "cookieJarRef"], secretInputFields: ["cookie"] }],
    maxAttempts: 2
  }),
  makeRecipe("social-insights", "playwright-social", "social", "headless", "typed_job", {
    challengeHandlerSetRef: "challenge-social-fallback@1",
    typedOperations: [{ name: "collect_insights", requiredFields: ["username"], allowedFields: ["username", "includeVideos", "authStateRef", "maxVideos"], secretInputFields: ["msToken", "cookie"] }],
    maxAttempts: 3
  }),
  makeRecipe("profile-update-companion", "companion", "avatar-account", "headful", "typed_job", {
    challengeHandlerSetRef: "challenge-avatar-manual@1",
    typedOperations: [pfpOperation],
    maxAttempts: 1,
    allowedCompanionConnections: ["companion", "file-input-bridge"]
  }),
  makeRecipe("media-resolution", "patchright", "media", "headless", "typed_job", {
    typedOperations: [{ name: "resolve", requiredFields: ["url"], allowedFields: ["url", "providerHint"], secretInputFields: [] }],
    maxAttempts: 2
  }),
  makeRecipe("media-media", "media-relay", "media", "headless", "typed_job", {
    typedOperations: [{ name: "relay", requiredFields: ["manifestRef"], allowedFields: ["manifestRef", "range"], secretInputFields: [] }],
    // The artifact handoff is immutable/idempotent, so one infrastructure retry is safe after a
    // manager/worker failure without creating a second playback object.
    maxAttempts: 2
  }),
  // Streaming playback is deliberately separate from the bounded immutable artifact relay. A
  // Media provider's signed URL/cookie bundle arrives only through an encrypted one-shot input
  // request after this media attempt has been assigned; it is never accepted in the durable job.
  makeRecipe("media-playback", "media-playback", "media", "headless", "typed_job", {
    typedOperations: [{ name: "playback", requiredFields: ["manifestRef"], allowedFields: ["manifestRef"], secretInputFields: ["media_source"] }],
    maxAttempts: 2
  })
];

export const standardArtifactPolicies: readonly ArtifactPolicy[] = [
  {
    ref: "artifact-policy_standard-30-days@1" as ArtifactPolicy["ref"],
    retentionDays: 30,
    allowedKinds: ["screenshot", "mhtml", "trace", "har", "download", "video", "log", "media_manifest"],
    createdAt
  }
];

export class RecipeRegistry {
  readonly #recipes = new Map<RecipeRef, RecipeDefinition>();
  readonly #artifactPolicies = new Map<ArtifactPolicy["ref"], ArtifactPolicy>();

  public constructor(recipes: readonly RecipeDefinition[] = builtInRecipes, artifactPolicies: readonly ArtifactPolicy[] = standardArtifactPolicies) {
    for (const recipe of recipes) this.register(recipe);
    for (const policy of artifactPolicies) this.registerArtifactPolicy(policy);
  }

  public register(recipe: RecipeDefinition): void {
    const existing = this.#recipes.get(recipe.ref);
    if (existing && existing.immutableHash !== recipe.immutableHash) {
      throw new Error(`recipe ${recipe.ref} is immutable; publish a new version instead of replacing it`);
    }
    const parsedRef = /^recipe_(.+)@(\d+)$/.exec(recipe.ref);
    if (!parsedRef || parsedRef[1] !== recipe.family || Number(parsedRef[2]) !== recipe.version) throw new Error(`recipe reference ${recipe.ref} does not match its immutable family/version`);
    this.#recipes.set(recipe.ref, structuredClone(recipe));
  }

  public registerArtifactPolicy(policy: ArtifactPolicy): void {
    const existing = this.#artifactPolicies.get(policy.ref);
    if (existing && JSON.stringify(existing) !== JSON.stringify(policy)) {
      throw new Error(`artifact policy ${policy.ref} is immutable`);
    }
    if (policy.retentionDays !== 30) throw new Error("Browser Fabric artifact retention is locked to 30 days");
    this.#artifactPolicies.set(policy.ref, structuredClone(policy));
  }

  public get(ref: RecipeRef): RecipeDefinition {
    const recipe = this.#recipes.get(ref);
    if (!recipe) throw new FabricError("not_found", `recipe ${ref} was not found`, 404);
    return structuredClone(recipe);
  }

  public getArtifactPolicy(ref: ArtifactPolicy["ref"]): ArtifactPolicy {
    const policy = this.#artifactPolicies.get(ref);
    if (!policy) throw new FabricError("not_found", `artifact policy ${ref} was not found`, 404);
    return structuredClone(policy);
  }

  public list(): readonly RecipeDefinition[] {
    return [...this.#recipes.values()].map((item) => structuredClone(item));
  }
}

const secretKey = /(password|passphrase|secret|token|cookie|credential|authorization|proxy(?:_?url)?|otp|api[_-]?key)/i;

/** Prevent accidental durable secret placement in job operation payloads. */
export function assertOperationContainsNoSecrets(value: unknown, path = "operation"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertOperationContainsNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (secretKey.test(key) && !key.endsWith("Ref")) {
        throw new FabricError("secret_rejected", `${path}.${key} must be supplied through an ephemeral input request, not stored in a job`, 400);
      }
      assertOperationContainsNoSecrets(child, `${path}.${key}`);
    }
  }
}

export function validateTypedOperation(recipe: RecipeDefinition, operation: Record<string, unknown>): void {
  if (recipe.access !== "typed_job" || !recipe.typedOperations?.length) {
    throw new FabricError("validation_failed", `${recipe.ref} does not accept typed jobs`, 400);
  }
  assertOperationContainsNoSecrets(operation);
  const operationName = operation.operation;
  if (typeof operationName !== "string") {
    throw new FabricError("validation_failed", "typed operation requires an operation name", 400);
  }
  const spec = recipe.typedOperations.find((candidate) => candidate.name === operationName);
  if (!spec) throw new FabricError("validation_failed", `${operationName} is not exposed by ${recipe.ref}`, 400);
  for (const field of spec.requiredFields) {
    if (operation[field] === undefined || operation[field] === null || operation[field] === "") {
      throw new FabricError("validation_failed", `operation.${field} is required`, 400);
    }
  }
  for (const field of Object.keys(operation)) {
    if (field !== "operation" && !spec.allowedFields.includes(field)) {
      throw new FabricError("validation_failed", `operation.${field} is not permitted by ${recipe.ref}`, 400);
    }
  }
}
export * from "./runner";
export * from "./adapters";
