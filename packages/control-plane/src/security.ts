import { FabricError } from "@browser-fabric/contracts";

const sensitiveKey = /(password|passphrase|secret|token|cookie|credential|authorization|proxy(?:_?url)?|otp|msToken|api[_-]?key)/i;
const sensitiveQueryKey = /(password|passphrase|secret|token|cookie|credential|authorization|proxy|otp|msToken|api[_-]?key|signature|sig|code|state)/i;
const authorizationValue = /(?:^|\s)(?:bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{8,}/i;

/**
 * A secret can be hidden in a value even when its enclosing field looks harmless (`url`,
 * `callback`, or `metadata`). Treat embedded userinfo, signed/token query parameters, and
 * authorization header values as secret material before they can reach a durable projection.
 */
function assertNoSensitiveString(value: string, path: string): void {
  if (authorizationValue.test(value)) {
    throw new FabricError("secret_rejected", `${path} contains authorization material that cannot be persisted`, 400);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.username || url.password) {
    throw new FabricError("secret_rejected", `${path} contains URL credentials that cannot be persisted`, 400);
  }
  for (const key of url.searchParams.keys()) {
    if (sensitiveQueryKey.test(key)) {
      throw new FabricError("secret_rejected", `${path} contains a credential-bearing URL query parameter`, 400);
    }
  }
}

/** Recursively reject secret bytes from durable control-plane payloads. */
export function assertDurablePayload(value: unknown, path = "payload"): asserts value is Record<string, string | number | boolean | null> {
  if (typeof value === "string") {
    assertNoSensitiveString(value, path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertDurablePayload(item, `${path}[${index}]`);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key) && !key.endsWith("Ref")) {
      throw new FabricError("secret_rejected", `${path}.${key} cannot be persisted; use an ephemeral input request`, 400);
    }
    if (typeof item === "string") assertNoSensitiveString(item, `${path}.${key}`);
    else if (item !== null && typeof item === "object") assertDurablePayload(item, `${path}.${key}`);
  }
}

export function safeFailureReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : "worker failure";
  // Never echo values that look like credentials or long opaque secret material.
  return text
    .replace(/([?&](?:token|password|secret|key|otp|cookie)=[^&\s]+)/gi, "$1=[redacted]")
    .replace(/\b(password|passphrase|secret|token|cookie|credential|authorization|otp|msToken|api[_-]?key)(\s*[:=])\s*([^\s,;}]+)/gi, (_match, key: string, delimiter: string) => `${key}${delimiter}[redacted]`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(basic|digest)\s+[A-Za-z0-9+/=._~-]+/gi, (_match, scheme: string) => `${scheme} [redacted]`)
    .slice(0, 1_000);
}

export function scalarMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FabricError("validation_failed", "metadata must be an object", 400);
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key) && !key.endsWith("Ref")) throw new FabricError("secret_rejected", `metadata.${key} cannot contain secret material`, 400);
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) throw new FabricError("validation_failed", `metadata.${key} must be scalar`, 400);
    if (typeof item === "string") assertNoSensitiveString(item, `metadata.${key}`);
    result[key] = item as string | number | boolean | null;
  }
  return result;
}
