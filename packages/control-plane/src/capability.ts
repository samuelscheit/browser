import { createHmac, timingSafeEqual } from "node:crypto";
import { FabricError, type BrowserSessionId, type CdpCapabilityClaims, type ProfileRef, type ProjectId, type WorkerId } from "@browser-fabric/contracts";
import { epochSeconds, type Clock, SystemClock } from "./clock";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new FabricError("capability_invalid", "CDP capability is malformed", 401);
  }
}

export interface CapabilitySignerOptions {
  secret: string | Uint8Array;
  clock?: Clock;
  gatewayBaseUrl?: string;
}

/** HMAC capability scoped to one session, project, profile and worker. */
export class CapabilitySigner {
  readonly #secret: string | Uint8Array;
  readonly #clock: Clock;
  readonly #gatewayBaseUrl: string;

  public constructor(options: CapabilitySignerOptions) {
    if (typeof options.secret === "string" ? options.secret.length < 32 : options.secret.byteLength < 32) {
      throw new Error("capability secret must be at least 256 bits");
    }
    this.#secret = options.secret;
    this.#clock = options.clock ?? new SystemClock();
    const gatewayBaseUrl = (options.gatewayBaseUrl ?? "wss://fabric.example.invalid").replace(/\/$/, "");
    if (!/^wss:\/\//.test(gatewayBaseUrl)) throw new Error("gatewayBaseUrl must use wss://");
    this.#gatewayBaseUrl = gatewayBaseUrl;
  }

  public issue(input: {
    sessionId: BrowserSessionId;
    project: ProjectId;
    profileRef?: ProfileRef;
    workerId: WorkerId;
    ttlSeconds: number;
  }): { token: string; expiresAt: string; endpoint: string } {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3_600) {
      throw new FabricError("validation_failed", "capability TTL must be between 1 and 3600 seconds", 400);
    }
    const exp = epochSeconds(this.#clock) + input.ttlSeconds;
    const claims: CdpCapabilityClaims = {
      version: 1,
      sessionId: input.sessionId,
      project: input.project,
      ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
      workerId: input.workerId,
      expiresAt: exp,
      nonce: crypto.randomUUID()
    };
    const header = encode({ alg: "HS256", typ: "FABRIC-CDP" });
    const payload = encode(claims);
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", this.#secret).update(body).digest("base64url");
    const token = `${body}.${signature}`;
    return { token, expiresAt: new Date(exp * 1000).toISOString(), endpoint: `${this.#gatewayBaseUrl}/v1/cdp/${encodeURIComponent(input.sessionId)}?cap=${encodeURIComponent(token)}` };
  }

  public verify(token: string, expected?: Partial<Pick<CdpCapabilityClaims, "sessionId" | "project" | "profileRef" | "workerId">>): CdpCapabilityClaims {
    if (typeof token !== "string") throw new FabricError("capability_invalid", "CDP capability is missing", 401);
    const parts = token.split(".");
    if (parts.length !== 3) throw new FabricError("capability_invalid", "CDP capability is malformed", 401);
    const [header, payload, signature] = parts as [string, string, string];
    const body = `${header}.${payload}`;
    const actual = createHmac("sha256", this.#secret).update(body).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw new FabricError("capability_invalid", "CDP capability signature is malformed", 401);
    }
    if (actual.length !== supplied.length || !timingSafeEqual(actual, supplied)) {
      throw new FabricError("capability_invalid", "CDP capability signature is invalid", 401);
    }
    const claims = decode<CdpCapabilityClaims>(payload);
    if (claims.version !== 1 || !claims.sessionId || !claims.project || !claims.workerId || !claims.nonce) {
      throw new FabricError("capability_invalid", "CDP capability claims are invalid", 401);
    }
    if (claims.expiresAt <= epochSeconds(this.#clock)) throw new FabricError("capability_expired", "CDP capability has expired", 401);
    for (const [key, expectedValue] of Object.entries(expected ?? {})) {
      if (expectedValue !== undefined && claims[key as keyof CdpCapabilityClaims] !== expectedValue) {
        throw new FabricError("capability_invalid", "CDP capability is not scoped to this session", 401);
      }
    }
    return claims;
  }
}
