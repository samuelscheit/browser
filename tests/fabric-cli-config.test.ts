import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickPage } from "../apps/cli/src/actions";
import { browserRequest, parseDuration } from "../apps/cli/src/cli";
import { choosePort } from "../apps/cli/src/commands";
import { assertName, basicAuthorization, listStates, loadCredentials, normalizeApiUrl, normalizeUsername, readState, saveCredentials, writeState } from "../apps/cli/src/config";
import { chromeArguments, parseDevToolsActivePort } from "../apps/cli/src/local-backend";
import { DEFAULT_EGRESS, DEFAULT_RECIPE, sessionInput } from "../apps/cli/src/remote-backend";
import { agentIdentity, remoteRequest } from "./support/fabric-identity";

let home: string;
const previousHome = process.env.FABRIC_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fabric-cli-")); process.env.FABRIC_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.FABRIC_HOME; else process.env.FABRIC_HOME = previousHome; });

describe("credentials", () => {
  test("normalizes the API URL to its /v1 base", () => {
    expect(normalizeApiUrl("https://browser.example")).toBe("https://browser.example/v1");
    expect(normalizeApiUrl("https://browser.example/")).toBe("https://browser.example/v1");
    expect(normalizeApiUrl("https://browser.example/v1/")).toBe("https://browser.example/v1");
    expect(normalizeApiUrl("https://browser.example/fabric?x=1#y")).toBe("https://browser.example/fabric/v1");
    expect(normalizeApiUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(() => normalizeApiUrl("https://user:pw@browser.example")).toThrow(/must not contain credentials/);
    expect(() => normalizeApiUrl("ftp://browser.example")).toThrow(/http/);
    expect(() => normalizeApiUrl("browser.example")).toThrow(/not a valid URL/);
  });

  test("accepts bare principal names and principal IDs", () => {
    expect(normalizeUsername("agent")).toBe("principal_agent");
    expect(normalizeUsername(" principal_agent ")).toBe("principal_agent");
  });

  test("stores credentials owner-only and lets the environment override them", () => {
    const path = saveCredentials({ url: "https://browser.example/v1", username: "principal_agent", password: "stored" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadCredentials(home, {})).toEqual({ url: "https://browser.example/v1", username: "principal_agent", password: "stored" });
    expect(loadCredentials(home, { FABRIC_PASSWORD: "env", FABRIC_USERNAME: "other", FABRIC_URL: "https://other.example" }))
      .toEqual({ url: "https://other.example/v1", username: "principal_other", password: "env" });
    expect(() => loadCredentials(join(home, "missing"), {})).toThrow(/fabric login/);
    expect(basicAuthorization({ username: "principal_agent", password: "p:w" })).toBe(`Basic ${Buffer.from("principal_agent:p:w").toString("base64")}`);
  });
});

describe("browser requests", () => {
  const values = (extra: Record<string, unknown> = {}) => ({ ...extra }) as Parameters<typeof browserRequest>[0];

  test("defaults: remote on 9222 with the persistent profile, local on 9223", async () => {
    expect(await browserRequest(values())).toEqual({ name: "remote", mode: "remote", port: 9222, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false });
    expect(await browserRequest(values({ local: true, headless: true }))).toMatchObject({ name: "local", mode: "local", port: 9223, headless: true });
  });

  test("an extra named browser takes the next free port that no other browser claimed", async () => {
    writeState({ request: remoteRequest({ name: "other", port: 9224 }), pid: process.pid, startedAt: "", status: "ready", updatedAt: "" });
    expect(await choosePort("research", "remote")).toBe(9225);
    expect(await choosePort("research", "remote", 9500)).toBe(9500);
    expect(await choosePort("remote", "remote")).toBe(9222);
  });

  test("rejects options that do not apply to the chosen mode, and invalid values", async () => {
    await expect(browserRequest(values({ local: true, fresh: true }))).rejects.toThrow(/remote browsers only/);
    await expect(browserRequest(values({ headless: true }))).rejects.toThrow(/--local only/);
    await expect(browserRequest(values({ ttl: "5h" }))).rejects.toThrow(/between 1m and 4h/);
    await expect(browserRequest(values({ ttl: "30s" }))).rejects.toThrow(/between 1m and 4h/);
    await expect(browserRequest(values({ idle: "0" }))).rejects.toThrow(/--idle/);
    await expect(browserRequest(values({ port: "80" }))).rejects.toThrow(/--port/);
    await expect(browserRequest(values({ name: "Bad Name" }))).rejects.toThrow(/lowercase/);
  });

  test("durations accept hours, minutes and seconds", () => {
    expect(parseDuration(undefined, 7)).toBe(7);
    expect(parseDuration("4h", 0)).toBe(14_400);
    expect(parseDuration("90m", 0)).toBe(5_400);
    expect(parseDuration("600", 0)).toBe(600);
    expect(parseDuration("45s", 0)).toBe(45);
    expect(() => parseDuration("1.5h", 0)).toThrow(/invalid duration/);
    expect(() => parseDuration("-1", 0)).toThrow(/invalid duration/);
  });

  test("names are lowercase identifiers", () => {
    expect(assertName("research-2")).toBe("research-2");
    for (const bad of ["", "-x", "UPPER", "a/b", "x".repeat(64)]) expect(() => assertName(bad)).toThrow();
  });

  test("daemon state round-trips and lists", () => {
    const state = { request: remoteRequest(), pid: 123, startedAt: "a", status: "ready" as const, updatedAt: "b", sessionId: "browser-session_x" };
    writeState(state);
    expect(readState("remote")).toEqual(state);
    expect(listStates()).toEqual([state]);
    expect(statSync(join(home, "run", "remote.json")).mode & 0o777).toBe(0o600);
  });
});

describe("remote session defaults", () => {
  test("pick the only project, its interactive profile, the interactive recipe and eight CDP clients", () => {
    const input = sessionInput(agentIdentity(), remoteRequest({ ttlSeconds: 3600 }));
    expect(input).toMatchObject({
      project: "project_agent", runtime: "chromium-cdp", browserRecipeRef: DEFAULT_RECIPE, profileRef: "profile_agent",
      leaseMode: "interactive", egressPolicyRef: DEFAULT_EGRESS, artifactPolicyRef: "artifact-policy_standard-30-days@1",
      ttlSeconds: 3600, maxExternalConnections: 8, metadata: { client: "fabric-cli", name: "remote" },
    });
    expect(input.idempotencyKey).toMatch(/^fabric-cli-[0-9a-f-]{36}$/);
    expect(sessionInput(agentIdentity(), remoteRequest()).idempotencyKey).not.toBe(input.idempotencyKey);
  });

  test("--fresh drops the profile; explicit choices are validated against /v1/me", () => {
    expect(sessionInput(agentIdentity(), remoteRequest({ fresh: true })).profileRef).toBeUndefined();
    expect(sessionInput(agentIdentity(), remoteRequest({ egress: "egress_tor-egress@1" })).egressPolicyRef).toBe("egress_tor-egress@1" as never);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ profile: "profile_nope" }))).toThrow(/Unknown profile profile_nope. Available: profile_agent, profile_chat/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ recipe: "recipe_nope@1" }))).toThrow(/Unknown recipe/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ recipe: "recipe_reporting-reporting@1" }))).toThrow(/typed-job recipe/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ egress: "egress_nope@1" }))).toThrow(/Unknown egress policy egress_nope@1. Available: egress_direct-egress@1, egress_tor-egress@1/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ project: "project_chat" }))).toThrow(/no access to project_chat/);
  });

  test("a recipe for another profile family selects that family's profile, or none", () => {
    const identity = agentIdentity();
    identity.projects.push({ id: "project_chat", name: "CHAT" } as never);
    expect(sessionInput(identity, remoteRequest({ project: "project_chat", recipe: "recipe_chat-browser-controller@1" })).profileRef).toBe("profile_chat" as never);
    expect(sessionInput(identity, remoteRequest({ project: "project_chat" })).profileRef).toBeUndefined();
  });

  test("several projects require --project", () => {
    const identity = agentIdentity();
    identity.projects.push({ id: "project_chat", name: "CHAT" } as never);
    expect(() => sessionInput(identity, remoteRequest())).toThrow(/several projects \(project_agent, project_chat\); pass --project/);
  });
});

describe("local Chrome", () => {
  test("parses DevToolsActivePort and rejects partial or foreign content", () => {
    expect(parseDevToolsActivePort("53211\n/devtools/browser/abc-123\n")).toEqual({ port: 53211, path: "/devtools/browser/abc-123" });
    for (const bad of ["", "53211", "0\n/devtools/browser/x", "70000\n/devtools/browser/x", "x\n/devtools/browser/x", "53211\n/devtools/page/x"]) {
      expect(parseDevToolsActivePort(bad)).toBeUndefined();
    }
  });

  test("launches with its own profile, a loopback-only debugging port and optional headless mode", () => {
    const headful = chromeArguments("/p", false);
    expect(headful).toContain("--user-data-dir=/p");
    expect(headful).toContain("--remote-debugging-port=0");
    expect(headful).toContain("--remote-debugging-address=127.0.0.1");
    expect(headful.some((argument) => argument.startsWith("--headless"))).toBe(false);
    expect(chromeArguments("/p", true)).toContain("--headless=new");
  });
});

describe("tab selection", () => {
  const pages = [{ targetId: "AAA111", title: "a", url: "https://a" }, { targetId: "AAB222", title: "b", url: "https://b" }, { targetId: "CCC333", title: "c", url: "https://c" }];
  test("defaults to the most recently used page and accepts an index or an id prefix", () => {
    expect(pickPage(pages)?.targetId).toBe("AAA111");
    expect(pickPage(pages, "2")?.targetId).toBe("CCC333");
    expect(pickPage(pages, "ccc")?.targetId).toBe("CCC333");
    expect(pickPage(pages, "AAB")?.targetId).toBe("AAB222");
    expect(pickPage(pages, "9")).toBeUndefined();
    expect(pickPage(pages, "zzz")).toBeUndefined();
    expect(() => pickPage(pages, "AA")).toThrow(/ambiguous/);
    expect(pickPage([])).toBeUndefined();
  });
});
