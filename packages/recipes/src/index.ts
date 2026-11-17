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

export interface RecipeDefinitionInput {
  name: string;
  version?: number;
  runtime: RuntimeFamily;
  profileFamily: string;
  mode: BrowserRecipe["mode"];
  access: RecipeAccess;
  challengeHandlerSetRef?: string;
  typedOperations?: readonly TypedOperationSpec[];
  maxAttempts?: number;
  /** Overrides of the default launch settings (viewport, locale, flags, ...). */
  launch?: Partial<BrowserRecipe["launch"]>;
  /** Container image for this recipe; the worker manager may still pin its own per-runtime image. */
  browserImage?: string;
}

/** Build an immutable recipe; its hash covers every launch- and access-relevant field. */
export function makeRecipe(input: RecipeDefinitionInput): RecipeDefinition {
  const version = input.version ?? 1;
  const launch: BrowserRecipe["launch"] = {
    viewport: { width: 1440, height: 1024 },
    locale: "en-US",
    timezone: "UTC",
    launchFlags: ["--disable-background-networking", "--disable-dev-shm-usage"],
    extensions: [],
    initScripts: [],
    sharedMemoryMiB: input.mode === "interactive" ? 1024 : 512,
    downloadsEnabled: true,
    ...input.launch
  };
  const base = {
    name: input.name,
    version,
    runtime: input.runtime,
    profileFamily: input.profileFamily,
    mode: input.mode,
    access: input.access,
    challengeHandlerSetRef: input.challengeHandlerSetRef,
    typedOperations: input.typedOperations,
    maxAttempts: input.maxAttempts ?? 1,
    launch,
    browserImage: input.browserImage
  };
  return {
    ref: `recipe_${input.name}@${version}` as RecipeRef,
    family: input.name,
    version,
    runtime: input.runtime,
    immutableHash: `sha256:${createHash("sha256").update(canonicalJson(base)).digest("hex")}`,
    browserImage: input.browserImage ?? "browser-fabric-browser:local",
    browserVersion: "chromium-pinned",
    mode: input.mode,
    profileFamily: input.profileFamily,
    requiredCapabilities: [input.runtime, input.profileFamily, ...(input.mode === "interactive" ? ["interactive-ui"] : [])],
    launch,
    artifactDefaults: ["screenshot", "mhtml", "trace"],
    createdAt,
    access: input.access,
    ...(input.challengeHandlerSetRef === undefined ? {} : { challengeHandlerSetRef: input.challengeHandlerSetRef }),
    ...(input.typedOperations === undefined ? {} : { typedOperations: input.typedOperations }),
    maxAttempts: input.maxAttempts ?? 1
  };
}

/**
 * Built-in recipes: Fabric's Chrome, headful on a private X display (live view and takeover work,
 * and sites see an ordinary desktop browser) or headless. Both use the `default` profile family,
 * so one profile serves either. Deployments add their own through the catalog file. Both enable the
 * captcha-solver challenge set; it solves only through providers whose credential is configured.
 */
export const builtInRecipes: readonly RecipeDefinition[] = [
  makeRecipe({ name: "chrome", runtime: "chrome", profileFamily: "default", mode: "interactive", access: "raw_cdp", challengeHandlerSetRef: "challenge_captcha-solver@1" }),
  makeRecipe({ name: "chrome-headless", runtime: "chrome", profileFamily: "default", mode: "headless", access: "raw_cdp", challengeHandlerSetRef: "challenge_captcha-solver@1" })
];

export const standardArtifactPolicies: readonly ArtifactPolicy[] = [
  {
    ref: "artifact-policy_standard-30-days@1" as ArtifactPolicy["ref"],
    retentionDays: 30,
    allowedKinds: ["screenshot", "mhtml", "trace", "har", "download", "video", "log"],
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
