import type { Principal, PrincipalId } from "@browser-fabric/contracts";

/**
 * Identity asserted by the Fabric edge after it has authenticated a caller's
 * Basic credential. The edge-to-origin connection is still protected by the
 * private origin mTLS boundary; this header is never accepted from an
 * application-facing request directly.
 */
export const FABRIC_EDGE_AUTHENTICATED_HEADER = "x-fabric-edge-authenticated";
export const FABRIC_PRINCIPAL_HEADER = "x-fabric-principal";

const principalIdPattern = /^principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Resolve the principal selected by the trusted edge, rejecting forged or malformed headers. */
export function principalFromEdgeHeaders(request: Request, principals: Iterable<Principal>): Principal | undefined {
  if (request.headers.get(FABRIC_EDGE_AUTHENTICATED_HEADER) !== "true") return undefined;
  const id = request.headers.get(FABRIC_PRINCIPAL_HEADER)?.trim();
  if (!id || !principalIdPattern.test(id)) return undefined;
  const matches = [...principals].filter((principal) => principal.id === id);
  // A duplicated principal ID is a corrupted deployment state. Do not choose
  // one arbitrarily when that happens.
  return matches.length === 1 ? structuredClone(matches[0]!) : undefined;
}

export function isPrincipalId(value: string): value is PrincipalId {
  return principalIdPattern.test(value);
}
