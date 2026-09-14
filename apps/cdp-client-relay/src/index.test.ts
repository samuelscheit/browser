import { expect, test } from "bun:test";

import { fabricSessionUrl, parseCdpSessionRoute, relayConfigFromEnvironment } from "./index";

test("the client relay accepts only an opaque Fabric browser-session path", () => {
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc")).toEqual({ sessionId: "browser-session_abc" });
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc?cap=opaque")).toBeUndefined();
  expect(parseCdpSessionRoute("/v1/cdp/browser-session_abc/extra")).toBeUndefined();
  expect(parseCdpSessionRoute("/v1/worker-relay/worker_x/browser-lease_y")).toBeUndefined();
});

test("the client relay always looks up the fixed Fabric API session", () => {
  const route = parseCdpSessionRoute("/v1/cdp/browser-session_abc")!;
  expect(fabricSessionUrl({ apiBaseUrl: "https://fabric.internal.example/v1" } as never, route))
    .toBe("https://fabric.internal.example/v1/browser-sessions/browser-session_abc");
});

test("relay configuration refuses unreadable mTLS material before it can serve a connection", () => {
  expect(() => relayConfigFromEnvironment({
    FABRIC_API_URL: "https://fabric.example/v1/other",
    FABRIC_CDP_RELAY_CLIENT_CERT_FILE: "/missing/cert",
    FABRIC_CDP_RELAY_CLIENT_KEY_FILE: "/missing/key",
    FABRIC_CDP_RELAY_CLIENT_CA_FILE: "/missing/ca",
    FABRIC_PROJECT: "project_reporting",
    FABRIC_PRINCIPAL: "principal_reporting",
    FABRIC_CERT_FINGERPRINT: "fingerprint",
  })).toThrow("FABRIC_CDP_RELAY_CLIENT_CERT_FILE");
});
