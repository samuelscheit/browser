import { readFile } from "node:fs/promises";
import {
  challengeHandlerKinds,
  runtimeFamilies,
  trafficClasses,
  type BrowserRecipe,
  type ChallengeHandler,
  type ChallengeHandlerSet,
  type EgressPolicy,
  type EgressRoute,
  type ProjectId,
  type RuntimeFamily,
  type TrafficClass,
} from "@browser-fabric/contracts";
import { builtInChallengeSets, builtInEgressPolicies, makeChallengeSet, makeEgressPolicy } from "@browser-fabric/policy";
import { builtInRecipes, makeRecipe, type RecipeDefinition, type TypedOperationSpec } from "@browser-fabric/recipes";

/**
 * A deployment's own recipes, egress policies, challenge handler sets and projects, loaded at startup
 * from the JSON file named by FABRIC_CATALOG_FILE (format: docs/catalog.md). Every process that builds
 * a scheduler loads the same file, so API, gateway, scheduler and worker manager agree on every ref.
 * Catalog entries extend the built-ins; they can never replace one.
 */
export interface FabricCatalog {
  recipes: readonly RecipeDefinition[];
  egressPolicies: readonly EgressPolicy[];
  challengeSets: readonly ChallengeHandlerSet[];
  projects: readonly { id: ProjectId; name: string }[];
}

export const emptyFabricCatalog: FabricCatalog = { recipes: [], egressPolicies: [], challengeSets: [], projects: [] };

export class FabricCatalogError extends Error {
  public constructor(message: string) {
    super(`Fabric catalog: ${message}`);
    this.name = "FabricCatalogError";
  }
}

function fail(message: string): never {
  throw new FabricCatalogError(message);
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Json;
}

function onlyKeys(value: Json, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key} is not a known field`);
}

function string(value: unknown, path: string, pattern?: RegExp, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail(`${path} must be a string of 1 to ${max} characters`);
  if (pattern && !pattern.test(value)) fail(`${path} is invalid`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${path} must be an integer from ${min} to ${max}`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${path} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${path} must be an array of at most ${max} entries`);
  return value;
}

function strings(value: unknown, path: string, max: number, pattern?: RegExp): string[] {
  return array(value, path, max).map((entry, index) => string(entry, `${path}[${index}]`, pattern, 1024));
}

function optional<T>(raw: Json, key: string, parse: (value: unknown) => T): T | undefined {
  return raw[key] === undefined ? undefined : parse(raw[key]);
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const fieldPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const proxyRefPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

function typedOperation(value: unknown, path: string): TypedOperationSpec {
  const raw = object(value, path);
  onlyKeys(raw, path, ["name", "requiredFields", "allowedFields", "secretInputFields"]);
  const operation = {
    name: string(raw.name, `${path}.name`, /^[a-z][a-z0-9_]{0,63}$/),
    requiredFields: strings(raw.requiredFields, `${path}.requiredFields`, 32, fieldPattern),
    allowedFields: strings(raw.allowedFields, `${path}.allowedFields`, 32, fieldPattern),
    secretInputFields: strings(raw.secretInputFields ?? [], `${path}.secretInputFields`, 16, fieldPattern),
  };
  for (const field of operation.requiredFields) if (!operation.allowedFields.includes(field)) fail(`${path}.allowedFields must include required field ${field}`);
  return operation;
}

function launch(value: unknown, path: string): Partial<BrowserRecipe["launch"]> {
  const raw = object(value, path);
  onlyKeys(raw, path, ["viewport", "locale", "timezone", "userAgent", "launchFlags", "extensions", "initScripts", "disableServiceWorkers", "sharedMemoryMiB", "downloadsEnabled"]);
  const viewport = optional(raw, "viewport", (entry) => {
    const viewportRaw = object(entry, `${path}.viewport`);
    onlyKeys(viewportRaw, `${path}.viewport`, ["width", "height"]);
    return { width: integer(viewportRaw.width, `${path}.viewport.width`, 320, 7680), height: integer(viewportRaw.height, `${path}.viewport.height`, 240, 4320) };
  });
  const launchFlags = optional(raw, "launchFlags", (entry) => strings(entry, `${path}.launchFlags`, 64, /^--[a-z0-9][a-z0-9-]*(=.*)?$/));
  // Flags that would move the browser's ownership, debugging or routing boundary are appended by the
  // runtime after the recipe's flags; refuse them here so a catalog never even appears to set them.
  const reserved = /^--(remote-debugging|user-data-dir|proxy-|no-proxy-server|disable-web-security|no-sandbox|disable-setuid-sandbox)/;
  for (const flag of launchFlags ?? []) if (reserved.test(flag)) fail(`${path}.launchFlags must not contain the runtime-owned flag ${flag.split("=")[0]}`);
  const result: Partial<BrowserRecipe["launch"]> = {};
  if (viewport) result.viewport = viewport;
  if (raw.locale !== undefined) result.locale = string(raw.locale, `${path}.locale`, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 35);
  if (raw.timezone !== undefined) result.timezone = string(raw.timezone, `${path}.timezone`, /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/, 64);
  if (raw.userAgent !== undefined) result.userAgent = string(raw.userAgent, `${path}.userAgent`, /^[\x20-\x7e]+$/, 512);
  if (launchFlags) result.launchFlags = launchFlags;
  if (raw.extensions !== undefined) result.extensions = strings(raw.extensions, `${path}.extensions`, 16);
  if (raw.initScripts !== undefined) result.initScripts = strings(raw.initScripts, `${path}.initScripts`, 16);
  if (raw.disableServiceWorkers !== undefined) result.disableServiceWorkers = boolean(raw.disableServiceWorkers, `${path}.disableServiceWorkers`);
  if (raw.sharedMemoryMiB !== undefined) result.sharedMemoryMiB = integer(raw.sharedMemoryMiB, `${path}.sharedMemoryMiB`, 64, 8192);
  if (raw.downloadsEnabled !== undefined) result.downloadsEnabled = boolean(raw.downloadsEnabled, `${path}.downloadsEnabled`);
  return result;
}

function recipe(value: unknown, path: string): RecipeDefinition {
  const raw = object(value, path);
  onlyKeys(raw, path, ["name", "version", "runtime", "profileFamily", "mode", "access", "challengeHandlerSetRef", "typedOperations", "maxAttempts", "launch", "browserImage"]);
  const access = oneOf(raw.access, `${path}.access`, ["raw_cdp", "typed_job"] as const);
  const typedOperations = optional(raw, "typedOperations", (entry) => array(entry, `${path}.typedOperations`, 16).map((operation, index) => typedOperation(operation, `${path}.typedOperations[${index}]`)));
  if (access === "typed_job" && !typedOperations?.length) fail(`${path}.typedOperations is required for a typed_job recipe`);
  if (access === "raw_cdp" && typedOperations !== undefined) fail(`${path}.typedOperations is only allowed for a typed_job recipe`);
  const challengeHandlerSetRef = optional(raw, "challengeHandlerSetRef", (entry) => string(entry, `${path}.challengeHandlerSetRef`, /^challenge_[a-z0-9][a-z0-9-]{0,62}@\d{1,4}$/));
  const maxAttempts = optional(raw, "maxAttempts", (entry) => integer(entry, `${path}.maxAttempts`, 1, 10));
  const launchOverrides = optional(raw, "launch", (entry) => launch(entry, `${path}.launch`));
  const browserImage = optional(raw, "browserImage", (entry) => string(entry, `${path}.browserImage`, /^[a-z0-9][a-z0-9._/:@-]{0,254}$/));
  return makeRecipe({
    name: string(raw.name, `${path}.name`, namePattern),
    ...(raw.version === undefined ? {} : { version: integer(raw.version, `${path}.version`, 1, 9999) }),
    runtime: oneOf(raw.runtime, `${path}.runtime`, runtimeFamilies) as RuntimeFamily,
    profileFamily: string(raw.profileFamily, `${path}.profileFamily`, namePattern),
    mode: oneOf(raw.mode, `${path}.mode`, ["headless", "interactive"] as const),
    access,
    ...(challengeHandlerSetRef === undefined ? {} : { challengeHandlerSetRef }),
    ...(typedOperations === undefined ? {} : { typedOperations }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(launchOverrides === undefined ? {} : { launch: launchOverrides }),
    ...(browserImage === undefined ? {} : { browserImage }),
  });
}

function route(value: unknown, path: string): EgressRoute {
  const raw = object(value, path);
  const kind = oneOf(raw.kind, `${path}.kind`, ["direct", "proxy", "tor", "block"] as const);
  if (kind === "direct") {
    onlyKeys(raw, path, ["kind", "retryThroughProxy"]);
    return { kind, retryThroughProxy: raw.retryThroughProxy === undefined ? false : boolean(raw.retryThroughProxy, `${path}.retryThroughProxy`) };
  }
  if (kind === "proxy") {
    onlyKeys(raw, path, ["kind", "proxyRef", "protocol", "remoteDns"]);
    return {
      kind,
      proxyRef: string(raw.proxyRef, `${path}.proxyRef`, proxyRefPattern),
      protocol: oneOf(raw.protocol, `${path}.protocol`, ["http", "https", "socks4", "socks5", "socks5h"] as const),
      remoteDns: raw.remoteDns === undefined ? true : boolean(raw.remoteDns, `${path}.remoteDns`),
    };
  }
  if (kind === "tor") {
    onlyKeys(raw, path, ["kind", "poolRef"]);
    return { kind, poolRef: raw.poolRef === undefined ? "default" : string(raw.poolRef, `${path}.poolRef`, proxyRefPattern), remoteDns: true };
  }
  onlyKeys(raw, path, ["kind", "reason"]);
  return { kind, reason: string(raw.reason, `${path}.reason`, undefined, 256) };
}

function egressPolicy(value: unknown, path: string): EgressPolicy {
  const raw = object(value, path);
  onlyKeys(raw, path, ["name", "version", "routes"]);
  const routesRaw = object(raw.routes, `${path}.routes`);
  const routes: Partial<Record<TrafficClass, EgressRoute>> = {};
  for (const [trafficClass, entry] of Object.entries(routesRaw)) {
    routes[oneOf(trafficClass, `${path}.routes key`, trafficClasses)] = route(entry, `${path}.routes.${trafficClass}`);
  }
  if (Object.keys(routes).length === 0) fail(`${path}.routes must route at least one traffic class`);
  return makeEgressPolicy({
    name: string(raw.name, `${path}.name`, namePattern),
    ...(raw.version === undefined ? {} : { version: integer(raw.version, `${path}.version`, 1, 9999) }),
    routes,
  });
}

function challengeHandler(value: unknown, path: string): ChallengeHandler {
  const raw = object(value, path);
  onlyKeys(raw, path, ["id", "kind", "mode", "configuration"]);
  const configurationRaw = object(raw.configuration ?? {}, `${path}.configuration`);
  const configuration: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(configurationRaw)) {
    if (!fieldPattern.test(key)) fail(`${path}.configuration.${key} is not a valid key`);
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") fail(`${path}.configuration.${key} must be a string, number or boolean`);
    configuration[key] = entry;
  }
  return {
    id: string(raw.id, `${path}.id`, namePattern),
    kind: oneOf(raw.kind, `${path}.kind`, challengeHandlerKinds),
    mode: oneOf(raw.mode, `${path}.mode`, ["automatic", "manual", "fallback"] as const),
    configuration,
  };
}

function challengeSet(value: unknown, path: string): ChallengeHandlerSet {
  const raw = object(value, path);
  onlyKeys(raw, path, ["name", "version", "handlers"]);
  const handlers = array(raw.handlers, `${path}.handlers`, 16).map((entry, index) => challengeHandler(entry, `${path}.handlers[${index}]`));
  if (handlers.length === 0) fail(`${path}.handlers must not be empty`);
  if (new Set(handlers.map((handler) => handler.id)).size !== handlers.length) fail(`${path}.handlers ids must be unique`);
  return makeChallengeSet({
    name: string(raw.name, `${path}.name`, namePattern),
    ...(raw.version === undefined ? {} : { version: integer(raw.version, `${path}.version`, 1, 9999) }),
    handlers,
  });
}

function project(value: unknown, path: string): { id: ProjectId; name: string } {
  const raw = object(value, path);
  onlyKeys(raw, path, ["id", "name"]);
  return { id: string(raw.id, `${path}.id`, /^project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) as ProjectId, name: string(raw.name, `${path}.name`, undefined, 255) };
}

function assertUnique(refs: readonly string[], builtIns: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (builtIns.includes(ref)) fail(`${kind} ${ref} is built in; publish a new name or version instead of replacing it`);
    if (seen.has(ref)) fail(`${kind} ${ref} is declared twice`);
    seen.add(ref);
  }
}

/** Parse and validate a catalog document. Every reference is checked before any process uses it. */
export function parseFabricCatalog(value: unknown): FabricCatalog {
  const raw = object(value, "catalog");
  onlyKeys(raw, "catalog", ["$schema", "version", "recipes", "egressPolicies", "challengeSets", "projects"]);
  if (raw.version !== 1) fail("catalog.version must be 1");
  const catalog: FabricCatalog = {
    recipes: array(raw.recipes ?? [], "catalog.recipes", 256).map((entry, index) => recipe(entry, `catalog.recipes[${index}]`)),
    egressPolicies: array(raw.egressPolicies ?? [], "catalog.egressPolicies", 128).map((entry, index) => egressPolicy(entry, `catalog.egressPolicies[${index}]`)),
    challengeSets: array(raw.challengeSets ?? [], "catalog.challengeSets", 128).map((entry, index) => challengeSet(entry, `catalog.challengeSets[${index}]`)),
    projects: array(raw.projects ?? [], "catalog.projects", 128).map((entry, index) => project(entry, `catalog.projects[${index}]`)),
  };
  assertUnique(catalog.recipes.map((entry) => entry.ref), builtInRecipes.map((entry) => entry.ref), "recipe");
  assertUnique(catalog.egressPolicies.map((entry) => entry.ref), builtInEgressPolicies.map((entry) => entry.ref), "egress policy");
  assertUnique(catalog.challengeSets.map((entry) => entry.ref), builtInChallengeSets.map((entry) => entry.ref), "challenge handler set");
  assertUnique(catalog.projects.map((entry) => entry.id), [], "project");
  const challengeRefs = new Set<string>([...builtInChallengeSets, ...catalog.challengeSets].map((entry) => entry.ref));
  for (const entry of catalog.recipes) {
    if (entry.challengeHandlerSetRef && !challengeRefs.has(entry.challengeHandlerSetRef)) fail(`recipe ${entry.ref} references the unknown challenge handler set ${entry.challengeHandlerSetRef}`);
  }
  return catalog;
}

/** Read the catalog file; no path means the deployment uses the built-ins only. */
export async function loadFabricCatalog(path: string | undefined = process.env.FABRIC_CATALOG_FILE): Promise<FabricCatalog> {
  const file = path?.trim();
  if (!file) return emptyFabricCatalog;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    fail(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${file} is not valid JSON`);
  }
  return parseFabricCatalog(parsed);
}
