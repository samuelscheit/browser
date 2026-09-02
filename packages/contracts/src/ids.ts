/** Opaque identifiers prevent callers from accidentally substituting a profile ID for a session ID. */
export type OpaqueId<Prefix extends string> = string & { readonly __opaquePrefix: Prefix };

export type ProjectId = OpaqueId<"project">;
export type PrincipalId = OpaqueId<"principal">;
export type WorkerId = OpaqueId<"worker">;
export type RecipeRef = OpaqueId<"recipe">;
export type EgressPolicyRef = OpaqueId<"egress-policy">;
export type ArtifactPolicyRef = OpaqueId<"artifact-policy">;
export type ChallengeHandlerSetRef = OpaqueId<"challenge-handler-set">;
export type ProfileRef = OpaqueId<"profile">;
export type BrowserSessionId = OpaqueId<"browser-session">;
export type BrowserLeaseId = OpaqueId<"browser-lease">;
export type JobId = OpaqueId<"job">;
export type AttemptId = OpaqueId<"attempt">;
export type EventId = OpaqueId<"event">;
export type ArtifactId = OpaqueId<"artifact">;
export type InputRequestId = OpaqueId<"input-request">;
export type AuditEventId = OpaqueId<"audit-event">;
export type IdempotencyRecordId = OpaqueId<"idempotency">;
export type VolumeGenerationId = OpaqueId<"volume-generation">;
export type CloneId = OpaqueId<"clone">;

export function createId<Prefix extends string>(prefix: Prefix): OpaqueId<Prefix> {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` as OpaqueId<Prefix>;
}

export function isOpaqueId<Prefix extends string>(value: unknown, prefix: Prefix): value is OpaqueId<Prefix> {
  return typeof value === "string" && value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}
