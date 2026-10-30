import { createHash } from "node:crypto";
import {
  canonicalJson,
  createId,
  FabricError,
  type ChallengeHandler,
  type ChallengeHandlerSet,
  type EgressPolicy,
  type EgressPolicyRef,
  type EgressRoute,
  type RuntimeFamily,
  type TrafficClass
} from "@browser-fabric/contracts";

/** A proxy descriptor deliberately excludes credential bytes. */
export interface ProxyDescriptor {
  protocol: "http" | "https" | "socks4" | "socks5" | "socks5h";
  host: string;
  port: number;
  username?: string;
  remoteDns: boolean;
}

export interface EphemeralProxyCredential {
  username?: string;
  password: string;
}

export interface ClassifiedRequest {
  trafficClass: TrafficClass;
  hostname: string;
  method?: string;
  isRetry?: boolean;
}

export interface EgressDecision {
  route: EgressRoute;
  /** Direct-asset rules explicitly forbid fallback through a proxy. */
  allowRetry: boolean;
}

const now = () => new Date().toISOString();

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function ref(name: string): EgressPolicyRef {
  return `egress_${name}@1` as EgressPolicyRef;
}

const direct = (retryThroughProxy = false): EgressRoute => ({ kind: "direct", retryThroughProxy });
const proxy = (proxyRef: string, protocol: "http" | "https" | "socks4" | "socks5" | "socks5h", remoteDns: boolean): EgressRoute => ({
  kind: "proxy",
  proxyRef,
  protocol,
  remoteDns
});

function makePolicy(
  name: string,
  routes: Partial<Record<TrafficClass, EgressRoute>>,
  constraints: EgressPolicy["constraints"],
  options: Pick<EgressPolicy, "proxyFallbackRefs" | "directExceptionHostnames" | "affinityKey"> = {}
): EgressPolicy {
  const body = { name, routes, constraints, version: 1, options };
  return {
    ref: ref(name),
    family: name,
    version: 1,
    immutableHash: hash(body),
    routes,
    constraints,
    ...(options.proxyFallbackRefs === undefined ? {} : { proxyFallbackRefs: options.proxyFallbackRefs }),
    ...(options.directExceptionHostnames === undefined ? {} : { directExceptionHostnames: options.directExceptionHostnames }),
    ...(options.affinityKey === undefined ? {} : { affinityKey: options.affinityKey }),
    createdAt: now()
  };
}

/** Immutable built-in policies required by the migration plan. */
export const builtInEgressPolicies: readonly EgressPolicy[] = [
  makePolicy(
    "signup-direct-assets",
    {
      document: proxy("signup-application", "https", true),
      api: proxy("signup-application", "https", true),
      websocket: proxy("signup-application", "https", true),
      static_asset: direct(false),
      browser_download: proxy("signup-application", "https", true),
      captcha_solver: proxy("signup-application", "https", true),
      direct_exception: direct(false)
    },
    { preserveProxyAffinity: true, disableServiceWorkersInProxyMode: true, allowDirectMediaRelay: false }
  ),
  makePolicy(
    "media-proxy-affinity",
    {
      document: proxy("media", "socks5h", true),
      api: proxy("media", "socks5h", true),
      websocket: proxy("media", "socks5h", true),
      static_asset: proxy("media", "socks5h", true),
      provider_handshake: proxy("media", "socks5h", true),
      media_manifest: proxy("media", "socks5h", true),
      media_key: proxy("media", "socks5h", true),
      media_segment: proxy("media", "socks5h", true),
      media_range: proxy("media", "socks5h", true),
      direct_exception: direct(false)
    },
    { preserveProxyAffinity: true, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: true },
    // These are exact reviewed provider suffixes, not loose labels. `cdn-a` and `cdn-b`
    // alone do not match the production hosts and would silently route the documented exception
    // through the affinity proxy instead of direct egress.
    { directExceptionHostnames: ["cdn-a.example", "cdn-b.example"], affinityKey: "media-provider-session" }
  ),
  makePolicy(
    "social-proxy-fallback",
    {
      document: proxy("social-primary", "https", true),
      api: proxy("social-primary", "https", true),
      websocket: proxy("social-primary", "https", true),
      static_asset: proxy("social-primary", "https", true),
      provider_handshake: proxy("social-primary", "https", true),
      captcha_solver: proxy("social-solver", "https", true)
    },
    { preserveProxyAffinity: false, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: false },
    { proxyFallbackRefs: ["social-primary", "social-secondary", "social-direct"] }
  ),
  makePolicy(
    "tor-egress",
    {
      document: { kind: "tor", poolRef: "default", remoteDns: true },
      api: { kind: "tor", poolRef: "default", remoteDns: true },
      websocket: { kind: "tor", poolRef: "default", remoteDns: true },
      static_asset: { kind: "tor", poolRef: "default", remoteDns: true },
      browser_download: { kind: "tor", poolRef: "default", remoteDns: true }
    },
    { preserveProxyAffinity: true, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: false }
  ),
  // Reporting pages that cloak by visitor IP send Tor and datacenter exits to a decoy.
  // This route leaves through the operator's own residential connection (a VPN
  // exit node), so it is used only after a capture shows cloaking.
  makePolicy(
    "home-exit",
    {
      document: proxy("home-exit", "socks5h", true),
      api: proxy("home-exit", "socks5h", true),
      websocket: proxy("home-exit", "socks5h", true),
      static_asset: proxy("home-exit", "socks5h", true),
      browser_download: proxy("home-exit", "socks5h", true)
    },
    { preserveProxyAffinity: true, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: false }
  ),
  makePolicy(
    "direct-egress",
    Object.fromEntries(([
      "document",
      "api",
      "websocket",
      "static_asset",
      "browser_download",
      "media_manifest",
      "media_key",
      "media_segment",
      "media_range",
      "provider_handshake",
      "captcha_solver",
      "direct_exception"
    ] as TrafficClass[]).map((trafficClass) => [trafficClass, direct(true)])),
    { preserveProxyAffinity: false, disableServiceWorkersInProxyMode: false, allowDirectMediaRelay: true }
  )
];

export const builtInChallengeSets: readonly ChallengeHandlerSet[] = [
  {
    ref: "challenge_reporting@1" as ChallengeHandlerSet["ref"],
    family: "reporting",
    version: 1,
    immutableHash: "challenge-reporting-v1",
    handlers: [
      { id: "cloudflare-rebrowser", kind: "cloudflare", mode: "automatic", configuration: { strategy: "rebrowser" } },
      { id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: { extension: true, api: true } },
      { id: "anticaptcha-recaptcha", kind: "anticaptcha", mode: "automatic", configuration: { provider: "anticaptcha" } }
    ],
    createdAt: now()
  },
  {
    ref: "challenge_news@1" as ChallengeHandlerSet["ref"],
    family: "news",
    version: 1,
    immutableHash: "challenge-news-v1",
    handlers: [{ id: "news-anticaptcha", kind: "anticaptcha", mode: "automatic", configuration: { provider: "anticaptcha" } }],
    createdAt: now()
  },
  {
    ref: "challenge_chat-interactive@1" as ChallengeHandlerSet["ref"],
    family: "chat-interactive",
    version: 1,
    immutableHash: "challenge-chat-interactive-v1",
    handlers: [{ id: "authenticated-turnstile", kind: "interactive-turnstile", mode: "manual", configuration: { observationBoundary: "dom-only" } }],
    createdAt: now()
  },
  {
    ref: "challenge-avatar-manual@1" as ChallengeHandlerSet["ref"],
    family: "avatar-manual",
    version: 1,
    immutableHash: "challenge-avatar-manual-v1",
    handlers: [{ id: "manual-auth", kind: "manual-handoff", mode: "manual", configuration: { resumeRequired: true } }],
    createdAt: now()
  },
  {
    ref: "challenge-signup-manual@1" as ChallengeHandlerSet["ref"],
    family: "signup-manual",
    version: 1,
    immutableHash: "challenge-signup-manual-v1",
    handlers: [{ id: "security-account-selection", kind: "manual-handoff", mode: "manual", configuration: { visible: true } }],
    createdAt: now()
  },
  {
    ref: "challenge-social-fallback@1" as ChallengeHandlerSet["ref"],
    family: "social-fallback",
    version: 1,
    immutableHash: "challenge-social-fallback-v1",
    handlers: [{ id: "social-strategy-fallback", kind: "social-fallback", mode: "fallback", configuration: { preserveOrder: true } }],
    createdAt: now()
  }
];

export function parseProxyUrl(raw: string): { descriptor: ProxyDescriptor; credential?: EphemeralProxyCredential } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("proxy URL is invalid");
  }
  const protocol = parsed.protocol.slice(0, -1);
  if (!["http", "https", "socks4", "socks5", "socks5h"].includes(protocol)) {
    throw new Error("proxy protocol must be HTTP, HTTPS, SOCKS4, SOCKS5, or SOCKS5H");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("proxy URL must not contain a path, query, or fragment");
  if (!parsed.hostname || /[^a-zA-Z0-9.:[\]-]/.test(parsed.hostname)) throw new Error("proxy hostname is invalid");
  const port = Number(parsed.port || (protocol.startsWith("socks") ? 1080 : 8080));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("proxy port is invalid");
  const descriptor: ProxyDescriptor = {
    protocol: protocol as ProxyDescriptor["protocol"],
    host: parsed.hostname,
    port,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    remoteDns: protocol === "socks5h"
  };
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  return password === undefined ? { descriptor } : { descriptor, credential: { password, ...(descriptor.username === undefined ? {} : { username: descriptor.username }) } };
}

export function classifyTraffic(url: string, hints: Partial<Pick<ClassifiedRequest, "trafficClass" | "method">> = {}): ClassifiedRequest {
  const parsed = new URL(url);
  if (hints.trafficClass) return { trafficClass: hints.trafficClass, hostname: parsed.hostname, ...(hints.method ? { method: hints.method } : {}) };
  const path = parsed.pathname.toLowerCase();
  if (/\.m3u8$|manifest/.test(path)) return { trafficClass: "media_manifest", hostname: parsed.hostname };
  if (/\.key$|\/\.license/.test(path)) return { trafficClass: "media_key", hostname: parsed.hostname };
  if (/\.ts$|\.m4s$|segment/.test(path)) return { trafficClass: "media_segment", hostname: parsed.hostname };
  if (/api|graphql|oauth|token|auth/.test(path)) return { trafficClass: "api", hostname: parsed.hostname };
  if (/\.zip$|\.mp4$|\.pdf$/.test(path)) return { trafficClass: "browser_download", hostname: parsed.hostname };
  if (/\.js$|\.css$|\.png$|\.jpg$|\.woff2?$/.test(path)) return { trafficClass: "static_asset", hostname: parsed.hostname };
  return { trafficClass: "document", hostname: parsed.hostname };
}

export function decideEgress(policy: EgressPolicy, request: ClassifiedRequest): EgressDecision {
  const exception = policy.directExceptionHostnames?.some((suffix) => request.hostname === suffix || request.hostname.endsWith(`.${suffix}`));
  const route = exception ? direct(false) : policy.routes[request.trafficClass] ?? { kind: "block", reason: `traffic class ${request.trafficClass} is not allowed by ${policy.family}` };
  if (route.kind === "direct" && request.isRetry && !route.retryThroughProxy) {
    return { route: { kind: "block", reason: "direct asset retries through proxy are disabled by policy" }, allowRetry: false };
  }
  return { route, allowRetry: route.kind !== "direct" || route.retryThroughProxy };
}

export interface EgressManifest {
  policyRef: EgressPolicyRef;
  routes: Readonly<Partial<Record<TrafficClass, EgressRoute>>>;
  proxyDescriptors: readonly ProxyDescriptor[];
  noDirectRetryTrafficClasses: readonly TrafficClass[];
}

export function compileEgressManifest(policy: EgressPolicy, proxyUrls: readonly string[] = []): EgressManifest {
  const parsed = proxyUrls.map(parseProxyUrl);
  return {
    policyRef: policy.ref,
    routes: policy.routes,
    proxyDescriptors: parsed.map(({ descriptor }) => descriptor),
    noDirectRetryTrafficClasses: Object.entries(policy.routes)
      .filter(([, route]) => route?.kind === "direct" && !route.retryThroughProxy)
      .map(([kind]) => kind as TrafficClass)
  };
}

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

export function assertRuntimePolicyCompatibility(runtime: RuntimeFamily, policy: EgressPolicy): void {
  if ((runtime === "media-relay" || runtime === "media-playback") && !policy.constraints.allowDirectMediaRelay) {
    throw new Error(`${runtime} cannot use ${policy.family}: direct media relay is disabled`);
  }
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
export * from "./enforced-fetch";
export * from "./sidecar";
