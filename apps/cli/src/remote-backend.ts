import { randomUUID } from "node:crypto";
import { BrowserFabricClient } from "@browser-fabric/client";
import { MAX_EXTERNAL_CDP_CONNECTIONS, type BrowserSessionCreateInput, type BrowserSessionResponse, type PrincipalCapabilities } from "@browser-fabric/contracts";
import { CdpConnection } from "@browser-fabric/worker-runtime";
import type { BrowserBackend } from "./backend";
import { basicAuthorization, type BrowserRequest, type Credentials } from "./config";

export const DEFAULT_RECIPE = "recipe_interactive-chromium@1";
export const DEFAULT_EGRESS = "egress_direct-egress@1";
const TERMINAL = new Set(["released", "cancelled", "failed", "timed_out"]);

export function fabricClient(credentials: Credentials): BrowserFabricClient {
  return new BrowserFabricClient({ baseUrl: credentials.url, headers: { authorization: basicAuthorization(credentials) } });
}

export async function fetchIdentity(credentials: Credentials): Promise<PrincipalCapabilities> {
  const response = await fetch(`${credentials.url}/me`, { headers: { accept: "application/json", authorization: basicAuthorization(credentials) } });
  if (response.status === 401) throw new Error(`Fabric rejected ${credentials.username}: wrong password, or the username is not a principal ID (they look like principal_agent).`);
  if (!response.ok) throw new Error(`Fabric GET /v1/me returned HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as PrincipalCapabilities;
}

/**
 * Pick what an agent almost always wants: its only project, that project's persistent interactive
 * profile (unless `--fresh`), and the interactive Chromium recipe. Every choice can be overridden.
 */
export function sessionInput(identity: PrincipalCapabilities, request: BrowserRequest): BrowserSessionCreateInput {
  const project = request.project ?? (identity.projects.length === 1 ? identity.projects[0]!.id : undefined);
  if (!project) throw new Error(`${identity.principal} can use several projects (${identity.projects.map((item) => item.id).join(", ")}); pass --project.`);
  if (!identity.projects.some((item) => item.id === project)) throw new Error(`${identity.principal} has no access to ${project}.`);
  const recipe = request.recipe ?? DEFAULT_RECIPE;
  const recipeDefinition = identity.recipes.find((item) => item.ref === recipe);
  if (!recipeDefinition) throw new Error(`Unknown recipe ${recipe}. Available: ${identity.recipes.map((item) => item.ref).join(", ")}`);
  if (recipeDefinition.access !== "raw_cdp") throw new Error(`${recipe} is a typed-job recipe; fabric needs a raw CDP recipe.`);
  const profile = request.fresh ? undefined : request.profile ?? identity.profiles.find((item) =>
    item.status === "active" && item.profileFamily === recipeDefinition.profileFamily && (item.ownerProject === project || item.grants.some((grant) => grant === project)))?.ref;
  if (profile && !identity.profiles.some((item) => item.ref === profile)) throw new Error(`Unknown profile ${profile}. Available: ${identity.profiles.map((item) => item.ref).join(", ") || "none"}`);
  const egress = request.egress ?? DEFAULT_EGRESS;
  if (!identity.egressPolicies.some((policy) => policy === egress)) throw new Error(`Unknown egress policy ${egress}. Available: ${identity.egressPolicies.join(", ")}`);
  const artifactPolicy = identity.artifactPolicies[0];
  if (!artifactPolicy) throw new Error("Fabric reports no artifact policy");
  type Input = BrowserSessionCreateInput;
  return {
    project: project as Input["project"],
    idempotencyKey: `fabric-cli-${randomUUID()}`,
    runtime: recipeDefinition.runtime as Input["runtime"],
    browserRecipeRef: recipe as Input["browserRecipeRef"],
    ...(profile ? { profileRef: profile as NonNullable<Input["profileRef"]> } : {}),
    leaseMode: recipeDefinition.mode === "interactive" ? "interactive" : "writer",
    egressPolicyRef: egress as Input["egressPolicyRef"],
    artifactPolicyRef: artifactPolicy as Input["artifactPolicyRef"],
    ttlSeconds: request.ttlSeconds,
    maxExternalConnections: MAX_EXTERNAL_CDP_CONNECTIONS,
    metadata: { client: "fabric-cli", name: request.name },
  };
}

export interface RemoteBackendOptions {
  credentials: Credentials;
  request: BrowserRequest;
  /** How long a session may stay queued before the CLI explains why instead of hanging. */
  queueTimeoutMs?: number;
  log?: (message: string) => void;
  onSession?: (sessionId: string | undefined) => void;
}

export class RemoteBackend implements BrowserBackend {
  readonly #options: RemoteBackendOptions;
  readonly #client: BrowserFabricClient;
  readonly #authorization: string;
  #session?: BrowserSessionResponse;
  #profile?: string;
  #starting?: Promise<BrowserSessionResponse>;

  public constructor(options: RemoteBackendOptions) {
    this.#options = options;
    this.#client = fabricClient(options.credentials);
    this.#authorization = basicAuthorization(options.credentials);
  }

  public describe() {
    return {
      ...(this.#session ? { sessionId: this.#session.id } : {}),
      ...(this.#profile ? { profile: this.#profile } : {}),
      detail: this.#session ? `remote session ${this.#session.id}${this.#profile ? ` (profile ${this.#profile})` : " (fresh profile)"}` : "remote browser released while idle; the next client starts one",
    };
  }

  public async connect(): Promise<CdpConnection> {
    const { url, headers } = await this.endpoint();
    return CdpConnection.connect({ endpoint: url, headers, timeoutMs: 30_000 });
  }

  /** The session's authenticated browser websocket, starting a session when none runs. */
  public async endpoint(): Promise<{ url: string; headers: Record<string, string> }> {
    // A fresh read per connection: the CDP capability inside the endpoint is short-lived.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.#ensureSession();
      const current = await this.#client.browserSessions.get(session.id);
      if (typeof current.cdpEndpoint === "string" && (current.status === "ready" || current.status === "active")) {
        return { url: current.cdpEndpoint, headers: { authorization: this.#authorization } };
      }
      this.#forget();
    }
    throw new Error("Fabric session ended while connecting");
  }

  public async suspend(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#forget();
    await this.#client.browserSessions.release(session.id).catch(() => undefined);
    this.#options.log?.(`released session ${session.id}`);
  }

  public async close(): Promise<void> {
    await this.suspend();
  }

  #forget(): void {
    this.#session = undefined;
    this.#options.onSession?.(undefined);
  }

  async #ensureSession(): Promise<BrowserSessionResponse> {
    if (this.#session) return this.#session;
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<BrowserSessionResponse> {
    const identity = await fetchIdentity(this.#options.credentials);
    const input = sessionInput(identity, this.#options.request);
    this.#profile = input.profileRef;
    const created = await this.#client.browserSessions.create(input);
    this.#options.log?.(`created session ${created.id} (${input.browserRecipeRef}, ${input.profileRef ?? "fresh profile"})`);
    const queueTimeoutMs = this.#options.queueTimeoutMs ?? 60_000;
    let ready: BrowserSessionResponse;
    try {
      ready = await this.#client.waitForBrowserSession(created.id, { timeoutMs: queueTimeoutMs, maxPollIntervalMs: 1_000 });
    } catch (error) {
      await this.#client.browserSessions.cancel(created.id).catch(() => undefined);
      throw new Error(
        `No remote browser became ready within ${Math.round(queueTimeoutMs / 1000)} s. `
        + (input.profileRef
          ? `The profile ${input.profileRef} is used by one session at a time and may be held by another machine, or every browser slot is busy. `
          : "Every browser slot may be busy. ")
        + `Try \`fabric up --remote --fresh\` or the local browser (\`fabric up\`). (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (TERMINAL.has(ready.status)) {
      const events = await this.#client.browserSessions.events(created.id).catch(() => []);
      throw new Error(`Fabric session ${created.id} ended as ${ready.status}: ${JSON.stringify(events.at(-1) ?? {})}`);
    }
    this.#session = ready;
    this.#options.onSession?.(ready.id);
    return ready;
  }
}
