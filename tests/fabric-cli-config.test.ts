import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickPage } from "../apps/cli/src/actions";
import { browserRequest, nameOf, parseDuration, resolveActionBrowser } from "../apps/cli/src/cli";
import { choosePort, up } from "../apps/cli/src/commands";
import { assertName, basicAuthorization, listStates, loadCredentials, normalizeApiUrl, normalizeUsername, readState, saveCredentials, writeState, type BrowserRequest, type DaemonState } from "../apps/cli/src/config";
import { parseDevToolsActivePort } from "../apps/cli/src/devtools-active-port";
import { chromeArguments } from "../apps/cli/src/launched-chrome-backend";
import { defaultEgress, defaultRecipe, fetchIdentity, sessionInput } from "../apps/cli/src/remote-backend";
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
  const localRequest = (overrides: Partial<BrowserRequest> = {}): BrowserRequest => ({
    name: "local", mode: "local", port: 9222, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false, ...overrides,
  });
  const runningState = (request: BrowserRequest, overrides: Partial<DaemonState> = {}): DaemonState => ({
    request, pid: process.pid, startedAt: "2026-01-01T00:00:00Z", status: "ready", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  });

  test("defaults: everyday Chrome as local:9222; --profile and --headless get their own names and ports; --remote gets remote:9223", async () => {
    expect(await browserRequest(values())).toEqual({ name: "local", mode: "local", port: 9222, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false });
    // Headless cannot be the user's own Chrome: it gets fabric's "agent" profile and browser name.
    const headless = await browserRequest(values({ headless: true }));
    expect(headless).toMatchObject({ name: "agent", mode: "local", headless: true, profile: "agent" });
    expect(headless.port).toBeGreaterThanOrEqual(9224);
    // --profile X without --name defaults the browser name to X so it runs alongside "local".
    const research = await browserRequest(values({ profile: "research" }));
    expect(research).toMatchObject({ name: "research", mode: "local", profile: "research", headless: false });
    expect(research.port).toBeGreaterThanOrEqual(9224);
    const sbReport = await browserRequest(values({ headless: true, profile: "sb-report" }));
    expect(sbReport).toMatchObject({ name: "sb-report", mode: "local", profile: "sb-report", headless: true });
    expect(sbReport.port).toBeGreaterThanOrEqual(9224);
    // Explicit --name overrides the profile-derived default (including --name local).
    expect(await browserRequest(values({ profile: "sb-report", name: "custom" }))).toMatchObject({ name: "custom", mode: "local", profile: "sb-report", headless: false });
    expect(await browserRequest(values({ headless: true, name: "local" }))).toMatchObject({ name: "local", mode: "local", port: 9222, headless: true, profile: "agent" });
    // Remote defaults.
    expect(await browserRequest(values({ remote: true }))).toEqual({ name: "remote", mode: "remote", port: 9223, fresh: false, ttlSeconds: 14_400, idleMinutes: 10, headless: false });
    const remoteProfile = await browserRequest(values({ remote: true, profile: "profile_example_kiosk" }));
    expect(remoteProfile).toMatchObject({ name: "profile_example_kiosk", mode: "remote", profile: "profile_example_kiosk" });
    expect(remoteProfile.port).toBeGreaterThanOrEqual(9224);
    expect(await browserRequest(values({ remote: true, profile: "profile_example_kiosk", name: "kiosk" }))).toMatchObject({ name: "kiosk", mode: "remote", profile: "profile_example_kiosk" });
    expect(await browserRequest(values({ remote: true, fresh: true, name: "scratch" }))).toMatchObject({ name: "scratch", mode: "remote", fresh: true });
    expect(nameOf(values({ profile: "sb-report" }))).toBe("sb-report");
    expect(nameOf(values({ profile: "sb-report" }), "override")).toBe("override");
  });

  test("an extra named browser takes the next free port, and an already-running browser keeps its port", async () => {
    writeState(runningState(remoteRequest({ name: "other", port: 9224 })));
    expect(await choosePort("research", "remote")).toBe(9225);
    expect(await choosePort("research", "local")).toBe(9225);
    expect(await choosePort("other", "remote")).toBe(9224);
    expect(await choosePort("research", "remote", 9500)).toBe(9500);
    expect(await choosePort("other", "remote", 9500)).toBe(9500);
    expect(await choosePort("local", "local")).toBe(9222);
    expect(await choosePort("remote", "remote")).toBe(9223);
    // Repeating `fabric up --profile sb-report` without --port keeps its running port (idempotent).
    writeState(runningState(localRequest({ name: "sb-report", profile: "sb-report", headless: true, port: 9226 })));
    expect((await browserRequest(values({ headless: true, profile: "sb-report" }))).port).toBe(9226);
  });

  test("up reuses an identical running browser, rejects differing settings, and rejects duplicate local profile usage", async () => {
    const sbReq = localRequest({ name: "sb-report", profile: "sb-report", headless: true, port: 9226 });
    const existing = runningState(sbReq);
    writeState(existing);
    // Same settings: idempotent reuse.
    expect(await up(sbReq)).toEqual(existing);
    // Different settings under the same name (headful vs headless, different port, different chrome).
    await expect(up({ ...sbReq, headless: false })).rejects.toThrow(/already running with other settings/);
    await expect(up({ ...sbReq, port: 9299 })).rejects.toThrow(/already running with other settings/);
    await expect(up({ ...sbReq, chrome: "/other/chrome" })).rejects.toThrow(/already running with other settings/);
    // Different browser name attempting to reuse the same local profile directory.
    await expect(up(localRequest({ name: "custom", profile: "sb-report", headless: true, port: 9227 })))
      .rejects.toThrow(/profile "sb-report" is already in use by browser "sb-report"/);
  });

  test("rejects options that do not apply to the chosen mode, and invalid values", async () => {
    for (const remoteOnly of [{ fresh: true }, { project: "project_agent" }, { recipe: "recipe_x@1" }, { egress: "egress_x@1" }]) {
      await expect(browserRequest(values(remoteOnly))).rejects.toThrow(/need --remote/);
    }
    await expect(browserRequest(values({ remote: true, headless: true }))).rejects.toThrow(/local browser only/);
    await expect(browserRequest(values({ remote: true, chrome: "/x" }))).rejects.toThrow(/local browser only/);
    await expect(browserRequest(values({ chrome: "/x" }))).rejects.toThrow(/--chrome needs --profile or --headless/);
    expect(await browserRequest(values({ chrome: "/x", profile: "p" }))).toMatchObject({ chrome: "/x", profile: "p", name: "p" });
    await expect(browserRequest(values({ ttl: "5h" }))).rejects.toThrow(/between 1m and 4h/);
    await expect(browserRequest(values({ ttl: "30s" }))).rejects.toThrow(/between 1m and 4h/);
    await expect(browserRequest(values({ idle: "0" }))).rejects.toThrow(/--idle/);
    await expect(browserRequest(values({ port: "80" }))).rejects.toThrow(/--port/);
    await expect(browserRequest(values({ name: "Bad Name" }))).rejects.toThrow(/lowercase/);
    await expect(browserRequest(values({ profile: "../evil", name: "ok" }))).rejects.toThrow(/local profile/);
    await expect(browserRequest(values({ profile: "Bad Profile" }))).rejects.toThrow(/local profile/);
    await expect(browserRequest(values({ remote: true, profile: "profile.dot" }))).rejects.toThrow(/pass --name/);
    expect(await browserRequest(values({ remote: true, profile: "profile.dot", name: "ok" }))).toMatchObject({ name: "ok", profile: "profile.dot" });
  });

  test("quick actions with explicit --profile, --name or --headless require that browser and never fall back to local", () => {
    const everyday = runningState(localRequest());
    writeState(everyday);

    // Explicit targets that are not running must fail, never fall back to "local".
    expect(() => resolveActionBrowser(values({ profile: "sb-report" }))).toThrow(/browser "sb-report" is not running.*fabric up --profile sb-report/);
    expect(() => resolveActionBrowser(values({ name: "sb-report" }))).toThrow(/browser "sb-report" is not running.*fabric up --profile sb-report/);
    expect(() => resolveActionBrowser(values({ headless: true }))).toThrow(/browser "agent" is not running.*fabric up --headless/);
    expect(() => resolveActionBrowser(values({ name: "custom", profile: "sb-report" }))).toThrow(/browser "custom" is not running.*fabric up --profile sb-report --name custom/);

    // A failed daemon state is surfaced in the error instead of falling back.
    writeState({
      request: localRequest({ name: "broken", profile: "broken", headless: true, port: 9228 }),
      pid: 999_999,
      startedAt: "",
      status: "failed",
      error: "Chrome not found",
      updatedAt: "",
    });
    expect(() => resolveActionBrowser(values({ profile: "broken" }))).toThrow(/last startup failed: Chrome not found/);

    // Once running, --profile and --name resolve it (even without repeating --headless).
    const sb = runningState(localRequest({ name: "sb-report", profile: "sb-report", headless: true, port: 9224 }));
    writeState(sb);
    expect(resolveActionBrowser(values({ profile: "sb-report" }))).toEqual(sb);
    expect(resolveActionBrowser(values({ profile: "sb-report", headless: true }))).toEqual(sb);
    expect(resolveActionBrowser(values({ name: "sb-report" }))).toEqual(sb);
    expect(resolveActionBrowser(values({ name: "local" }))).toEqual(everyday);

    // Explicit --name + --profile checks compatibility.
    expect(() => resolveActionBrowser(values({ name: "sb-report", profile: "other" }))).toThrow(/running with profile "sb-report", not profile "other"/);
    expect(() => resolveActionBrowser(values({ name: "local", profile: "sb-report" }))).toThrow(/everyday Chrome \(no profile\), not profile "sb-report"/);
    expect(() => resolveActionBrowser(values({ name: "sb-report", remote: true }))).toThrow(/running in local mode, not remote/);
    expect(() => resolveActionBrowser(values({ name: "local", headless: true }))).toThrow(/running headful, not headless/);

    // A browser started with `--profile X --name custom` is found via `--profile X` too.
    const custom = runningState(localRequest({ name: "custom", profile: "custom-prof", headless: false, port: 9225 }));
    writeState(custom);
    expect(resolveActionBrowser(values({ profile: "custom-prof" }))).toEqual(custom);
    expect(() => resolveActionBrowser(values({ profile: "custom-prof", headless: true }))).toThrow(/running headful, not headless/);

    // A named remote browser can be targeted with `--name` alone (as documented) or with `--remote --name`.
    const remoteWork = runningState(remoteRequest({ name: "research", port: 9226 }));
    writeState(remoteWork);
    expect(resolveActionBrowser(values({ name: "research" }))).toEqual(remoteWork);
    expect(resolveActionBrowser(values({ remote: true, name: "research" }))).toEqual(remoteWork);

    // An idle (lazy) browser is reusable.
    const lazy = runningState(localRequest({ name: "lazy", profile: "agent", headless: true, port: 9227 }), { status: "idle" });
    writeState(lazy);
    expect(resolveActionBrowser(values({ name: "lazy" }))).toEqual(lazy);
  });

  test("quick actions without --name/--profile use the sole running browser for that mode, start default when none runs, or fail on ambiguity", () => {
    // Nothing running -> undefined (caller starts mode default).
    expect(resolveActionBrowser(values())).toBeUndefined();
    expect(resolveActionBrowser(values({ remote: true }))).toBeUndefined();
    // Explicit --name local when nothing is running still fails instead of silently starting.
    expect(() => resolveActionBrowser(values({ name: "local" }))).toThrow(/browser "local" is not running.*`fabric up`/);

    // Sole isolated local browser running -> bare action uses it instead of starting everyday Chrome.
    const sb = runningState(localRequest({ name: "sb-report", profile: "sb-report", headless: true, port: 9224 }));
    writeState(sb);
    expect(resolveActionBrowser(values())).toEqual(sb);
    expect(resolveActionBrowser(values({ remote: true }))).toBeUndefined();

    // Local + remote running together: each mode has exactly 1 candidate, no ambiguity.
    const remote = runningState(remoteRequest());
    writeState(remote);
    expect(resolveActionBrowser(values())).toEqual(sb);
    expect(resolveActionBrowser(values({ remote: true }))).toEqual(remote);

    // Everyday Chrome + isolated profile both running: bare local action refuses to guess.
    writeState(runningState(localRequest()));
    expect(() => resolveActionBrowser(values())).toThrow(/several local browsers are running \(local, sb-report\); pass --name <name> or --profile <profile>/);
    // Remote mode still has only 1 candidate.
    expect(resolveActionBrowser(values({ remote: true }))).toEqual(remote);

    // Two remote browsers running: bare --remote action refuses to guess.
    writeState(runningState(remoteRequest({ name: "scratch", port: 9225 })));
    expect(() => resolveActionBrowser(values({ remote: true }))).toThrow(/several remote browsers are running \(remote, scratch\); pass --name <name>/);
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
    expect(assertName("profile_example_kiosk")).toBe("profile_example_kiosk");
    for (const bad of ["", "-x", "_x", "UPPER", "a/b", "x".repeat(64)]) expect(() => assertName(bad)).toThrow();
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
      project: "project_agent", runtime: "chrome", browserRecipeRef: "recipe_chrome@1", profileRef: "profile_agent",
      leaseMode: "interactive", egressPolicyRef: "egress_direct@1", artifactPolicyRef: "artifact-policy_standard-30-days@1",
      ttlSeconds: 3600, maxExternalConnections: 8, metadata: { client: "fabric-cli", name: "remote" },
    });
    expect(input.idempotencyKey).toMatch(/^fabric-cli-[0-9a-f-]{36}$/);
    expect(sessionInput(agentIdentity(), remoteRequest()).idempotencyKey).not.toBe(input.idempotencyKey);
  });

  test("--fresh drops the profile; explicit choices are validated against /v1/me", () => {
    expect(sessionInput(agentIdentity(), remoteRequest({ fresh: true })).profileRef).toBeUndefined();
    expect(sessionInput(agentIdentity(), remoteRequest({ egress: "egress_tor@1" })).egressPolicyRef).toBe("egress_tor@1" as never);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ profile: "profile_nope" }))).toThrow(/Unknown profile profile_nope. Available: profile_agent, profile_example_kiosk/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ recipe: "recipe_nope@1" }))).toThrow(/Unknown recipe/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ recipe: "recipe_example-fetch@1" }))).toThrow(/typed-job recipe/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ egress: "egress_nope@1" }))).toThrow(/Unknown egress policy egress_nope@1. Available: egress_direct@1, egress_tor@1/);
    expect(() => sessionInput(agentIdentity(), remoteRequest({ project: "project_example" }))).toThrow(/no access to project_example/);
  });

  test("a recipe for another profile family selects that family's profile, or none", () => {
    const identity = agentIdentity();
    identity.projects.push({ id: "project_example", name: "Example" } as never);
    expect(sessionInput(identity, remoteRequest({ project: "project_example", recipe: "recipe_example-kiosk@1" })).profileRef).toBe("profile_example_kiosk" as never);
    expect(sessionInput(identity, remoteRequest({ project: "project_example" })).profileRef).toBeUndefined();
  });

  test("defaults follow the catalog, not hardcoded refs", () => {
    const renamed = agentIdentity();
    renamed.recipes = [
      { ref: "recipe_chrome-headless@2", runtime: "chrome", mode: "headless", access: "raw_cdp", profileFamily: "default" },
      { ref: "recipe_chrome@2", runtime: "chrome", mode: "interactive", access: "raw_cdp", profileFamily: "default" },
      { ref: "recipe_chrome@10", runtime: "chrome", mode: "interactive", access: "raw_cdp", profileFamily: "default" },
    ] as never;
    renamed.egressPolicies = ["egress_tor@1", "egress_direct@3", "egress_direct@12"] as never;
    expect(defaultRecipe(renamed)).toBe("recipe_chrome@10");
    expect(defaultEgress(renamed)).toBe("egress_direct@12");
    expect(sessionInput(renamed, remoteRequest())).toMatchObject({ browserRecipeRef: "recipe_chrome@10", egressPolicyRef: "egress_direct@12" });
  });

  test("a catalog without an interactive recipe or a direct egress fails listing what exists; explicit flags win", () => {
    const identity = agentIdentity();
    identity.recipes = identity.recipes.filter((item) => item.mode !== "interactive");
    expect(() => sessionInput(identity, remoteRequest())).toThrow(/No interactive browser recipe.*pass --recipe. Available: recipe_example-fetch@1/);
    identity.recipes = [{ ref: "recipe_chrome-headless@1", runtime: "chrome", mode: "headless", access: "raw_cdp", profileFamily: "default" }] as never;
    expect(sessionInput(identity, remoteRequest({ recipe: "recipe_chrome-headless@1" })).browserRecipeRef).toBe("recipe_chrome-headless@1" as never);
    identity.egressPolicies = ["egress_tor@1", "egress_other@1"] as never;
    expect(() => defaultEgress(identity)).toThrow(/pass --egress. Available: egress_tor@1, egress_other@1/);
    identity.egressPolicies = [] as never;
    expect(() => defaultEgress(identity)).toThrow(/Available: none/);
    identity.egressPolicies = ["egress_tor@1"] as never;
    expect(defaultEgress(identity)).toBe("egress_tor@1");
  });

  test("an unreachable Fabric rejects instead of guessing defaults", async () => {
    await expect(fetchIdentity({ url: "http://127.0.0.1:1/v1", username: "principal_agent", password: "x" })).rejects.toThrow();
  });

  test("several projects require --project", () => {
    const identity = agentIdentity();
    identity.projects.push({ id: "project_example", name: "Example" } as never);
    expect(() => sessionInput(identity, remoteRequest())).toThrow(/several projects \(project_agent, project_example\); pass --project/);
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
  const pages = [
    { targetId: "USR000", title: "the user's own tab", url: "https://mail", agentTab: false },
    { targetId: "AAA111", title: "a", url: "https://a", agentTab: true },
    { targetId: "AAB222", title: "b", url: "https://b", agentTab: false },
    { targetId: "CCC333", title: "c", url: "https://c", agentTab: true },
  ];
  test("defaults to the most recently used agent tab, never the user's, and accepts an index or an id prefix", () => {
    expect(pickPage(pages)?.targetId).toBe("AAA111");
    expect(pickPage(pages.filter((page) => !page.agentTab))).toBeUndefined();
    expect(pickPage(pages, "0")?.targetId).toBe("USR000");
    expect(pickPage(pages, "3")?.targetId).toBe("CCC333");
    expect(pickPage(pages, "ccc")?.targetId).toBe("CCC333");
    expect(pickPage(pages, "AAB")?.targetId).toBe("AAB222");
    expect(pickPage(pages, "9")).toBeUndefined();
    expect(pickPage(pages, "zzz")).toBeUndefined();
    expect(() => pickPage(pages, "AA")).toThrow(/ambiguous/);
    expect(pickPage([])).toBeUndefined();
  });
});
