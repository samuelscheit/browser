import { describe, expect, test } from "bun:test";
import type { Principal } from "@browser-fabric/contracts";
import { principalFromEdgeHeaders } from "./application-auth";

const principal: Principal = {
  id: "principal_example" as Principal["id"],
  displayName: "Example application",
  projectGrants: ["project_example" as Principal["projectGrants"][number]],
  roles: ["project_operator"],
  certificateFingerprint: "edge-authenticated-subject",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("password-authenticated Fabric edge identity", () => {
  test("resolves only the edge-injected principal ID", () => {
    const request = new Request("https://fabric/v1/workers", {
      headers: {
        "x-fabric-edge-authenticated": "true",
        "x-fabric-principal": "principal_example",
        "x-fabric-cert-fingerprint": "attacker-controlled",
      },
    });
    expect(principalFromEdgeHeaders(request, [principal])).toEqual(principal);
  });

  test("rejects missing, malformed, and ambiguous edge identity", () => {
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers"), [principal])).toBeUndefined();
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers", { headers: { "x-fabric-edge-authenticated": "true", "x-fabric-principal": "principal_example/other" } }), [principal])).toBeUndefined();
    expect(principalFromEdgeHeaders(new Request("https://fabric/v1/workers", { headers: { "x-fabric-edge-authenticated": "true", "x-fabric-principal": "principal_example" } }), [principal, { ...principal, displayName: "duplicate" }])).toBeUndefined();
  });
});
