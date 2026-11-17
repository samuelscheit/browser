import { createHash } from "node:crypto";
import {
  canonicalJson,
  FabricError,
  type ChallengeHandler,
  type ChallengeHandlerSet,
  type EgressPolicy,
  type EgressPolicyRef,
  type EgressRoute,
  type TrafficClass,
  trafficClasses
} from "@browser-fabric/contracts";

const now = () => new Date().toISOString();

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface PolicyDefinition {
  name: string;
  version?: number;
  routes: Partial<Record<TrafficClass, EgressRoute>>;
}

/** Build an immutable egress policy; its hash covers its name, version and routes. */
export function makeEgressPolicy(definition: PolicyDefinition): EgressPolicy {
  const version = definition.version ?? 1;
  const { name, routes } = definition;
  return {
    ref: `egress_${name}@${version}` as EgressPolicyRef,
    family: name,
    version,
    immutableHash: hash({ name, version, routes }),
    routes,
    createdAt: now()
  };
}

const allRoutes = (route: EgressRoute) => Object.fromEntries(trafficClasses.map((trafficClass) => [trafficClass, route])) as Partial<Record<TrafficClass, EgressRoute>>;

/**
 * Built-in policies, each served by the egress sidecar listener of the same name. A deployment adds
 * its own (another proxy pool, static assets direct, per-host exceptions) through the catalog file
 * and a matching sidecar entry, never through code.
 */
export const builtInEgressPolicies: readonly EgressPolicy[] = [
  makeEgressPolicy({ name: "direct", routes: allRoutes({ kind: "direct", retryThroughProxy: false }) }),
  // The upstream proxy URL (or an ordered list) lives only in the sidecar's secret file.
  makeEgressPolicy({ name: "proxy", routes: allRoutes({ kind: "proxy", proxyRef: "default", protocol: "http", remoteDns: true }) }),
  makeEgressPolicy({
    name: "tor",
    routes: Object.fromEntries((["document", "api", "websocket", "static_asset", "browser_download"] as TrafficClass[])
      .map((trafficClass) => [trafficClass, { kind: "tor", poolRef: "default", remoteDns: true }]))
  })
];

export interface ChallengeSetDefinition {
  name: string;
  version?: number;
  handlers: readonly ChallengeHandler[];
}

export function makeChallengeSet(definition: ChallengeSetDefinition): ChallengeHandlerSet {
  const version = definition.version ?? 1;
  return {
    ref: `challenge_${definition.name}@${version}` as ChallengeHandlerSet["ref"],
    family: definition.name,
    version,
    immutableHash: `sha256:${hash({ name: definition.name, version, handlers: definition.handlers })}`,
    handlers: definition.handlers,
    createdAt: now()
  };
}

const guardianHandler: ChallengeHandler = { id: "guardian", kind: "guardian", mode: "automatic", configuration: { turnstile: true, datadome: true } };

/**
 * `guardian` documents the process-level Turnstile/DataDome guardian every Fabric Chromium carries.
 * `captcha-solver` additionally enables token solving (reCAPTCHA v2/hCaptcha) through each provider
 * whose credential the deployment configured; without a credential no provider is ever called.
 */
export const builtInChallengeSets: readonly ChallengeHandlerSet[] = [
  makeChallengeSet({ name: "guardian", handlers: [guardianHandler] }),
  makeChallengeSet({
    name: "captcha-solver",
    handlers: [
      guardianHandler,
      { id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: { provider: "death-by-captcha" } },
      { id: "anticaptcha", kind: "anticaptcha", mode: "automatic", configuration: { provider: "anticaptcha" } }
    ]
  }),
  makeChallengeSet({ name: "manual-handoff", handlers: [guardianHandler, { id: "manual-handoff", kind: "manual-handoff", mode: "manual", configuration: { resumeRequired: true } }] })
];

export interface ChallengePlan {
  handler: ChallengeHandler;
  action: "run_automatic" | "pause_for_manual" | "try_fallback";
}

export function planChallenge(set: ChallengeHandlerSet, kind: ChallengeHandler["kind"]): ChallengePlan {
  const handler = set.handlers.find((candidate) => candidate.kind === kind);
  if (!handler) throw new FabricError("validation_failed", `challenge handler ${kind} is not enabled by ${set.family}@${set.version}`, 400);
  return {
    handler,
    action: handler.mode === "manual" ? "pause_for_manual" : handler.mode === "fallback" ? "try_fallback" : "run_automatic"
  };
}

export interface ChallengeExecutionContext {
  sessionId: string;
  project: string;
  handler: ChallengeHandler;
  attempt: number;
  signal?: AbortSignal;
  /** Values are requested through Fabric's ephemeral input channel by the adapter. */
  requestInput?(field: string, fieldType: "password" | "otp" | "captcha_provider_credential" | "proxy_credential" | "form_value"): Promise<string>;
}

export type ChallengeOutcome =
  | { status: "solved"; handlerId: string; attempts: number }
  | { status: "blocked_challenge"; handlerId: string; reason: string; attempts: number }
  | { status: "awaiting_manual"; handlerId: string; reason: string; attempts: number }
  | { status: "auth_required"; handlerId: string; reason: string; attempts: number };

export interface ChallengeHandlerExecutor {
  automatic(context: ChallengeExecutionContext): Promise<"solved" | "retry" | "blocked_challenge" | "auth_required">;
  manual(context: ChallengeExecutionContext): Promise<"resumed" | "cancelled" | "expired">;
  fallback(context: ChallengeExecutionContext): Promise<"solved" | "retry" | "blocked_challenge" | "auth_required">;
}

/**
 * Executes only handlers explicitly present in a versioned set. There is intentionally no
 * catch-all selector/clicker: unknown challenges are blocked and surfaced to the application.
 */
export class ChallengeCoordinator {
  readonly #executor: ChallengeHandlerExecutor;
  readonly #maxAttempts: number;
  public constructor(executor: ChallengeHandlerExecutor, maxAttempts = 3) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("challenge maxAttempts must be between 1 and 10");
    this.#executor = executor;
    this.#maxAttempts = maxAttempts;
  }

  public async run(set: ChallengeHandlerSet, kind: ChallengeHandler["kind"], base: Omit<ChallengeExecutionContext, "handler" | "attempt">): Promise<ChallengeOutcome> {
    let plan: ChallengePlan;
    try {
      plan = planChallenge(set, kind);
    } catch (error) {
      return { status: "blocked_challenge", handlerId: `unknown:${kind}`, reason: error instanceof Error ? error.message : "challenge handler is not enabled", attempts: 0 };
    }
    if (plan.action === "pause_for_manual") {
      const outcome = await this.#executor.manual({ ...base, handler: plan.handler, attempt: 1 });
      if (outcome === "resumed") return { status: "solved", handlerId: plan.handler.id, attempts: 1 };
      if (outcome === "cancelled") return { status: "auth_required", handlerId: plan.handler.id, reason: "manual authentication was cancelled", attempts: 1 };
      return { status: "awaiting_manual", handlerId: plan.handler.id, reason: "manual authentication did not resume before its deadline", attempts: 1 };
    }
    let attempts = 0;
    for (attempts = 1; attempts <= this.#maxAttempts; attempts += 1) {
      const result = plan.action === "try_fallback"
        ? await this.#executor.fallback({ ...base, handler: plan.handler, attempt: attempts })
        : await this.#executor.automatic({ ...base, handler: plan.handler, attempt: attempts });
      if (result === "solved") return { status: "solved", handlerId: plan.handler.id, attempts };
      if (result === "blocked_challenge") return { status: "blocked_challenge", handlerId: plan.handler.id, reason: "handler reported an unsolved challenge", attempts };
      if (result === "auth_required") return { status: "auth_required", handlerId: plan.handler.id, reason: "handler requires application authentication", attempts };
    }
    return { status: "blocked_challenge", handlerId: plan.handler.id, reason: `handler exhausted ${this.#maxAttempts} bounded attempts`, attempts: this.#maxAttempts };
  }
}
export * from "./sidecar";
