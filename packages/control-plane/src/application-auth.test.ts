import { describe, expect, test } from "bun:test";
import type { Principal } from "@browser-fabric/contracts";
import { principalFromEdgeHeaders } from "./application-auth";

const principal: Principal = {
  id: "principal_chat" as Principal["id"],
  displayName: "Chat UI",
  projectGrants: ["project_chat" as Principal["projectGrants"][number]],
  roles: ["project_operator"],
  certificateFingerprint: "legacy-internal-subject",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("password-authenticated Fabric edge identity", () => {
  test("resolves only the edge-injected principal ID", () => {
    const request = new Request("https://fabric/v1/workers", {
      headers: {
        "x-fabric-edge-authenticated": "true",
        "x-fabric-principal": "principal_chat",
        "x-fabric-cert-fingerprint": "attacker-controlled",
      },
    });
    expect(principalFromEdgeHeaders(request, [principal])).toEqual(principal);
  });

  test("rejects missing, malformed, and ambiguous edge identity", () => {
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers"), [principal])).toBeUndefined();
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers", { headers: { "x-fabric-edge-authenticated": "true", "x-fabric-principal": "principal_chat/other" } }), [principal])).toBeUndefined();
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers", { headers: { "x-fabric-edge-authenticated": "true", "x-fabric-principal": "principal_chat" } }), [principal, { ...principal, displayName: "duplicate" }])).toBeUndefined();
  });
});
