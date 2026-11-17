#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { evaluate, goto, screenshot, tabs } from "./actions";
import { choosePort, describeState, down, endpointUrl, liveState, mcp, MCP_SERVERS, up } from "./commands";
import { assertName, listStates, loadCredentials, normalizeApiUrl, normalizeUsername, saveCredentials, type BrowserMode, type BrowserRequest } from "./config";
import { runDaemon } from "./daemon";
import { fetchIdentity } from "./remote-backend";

export const HELP = `fabric — a CDP browser for agents: your own Chrome, or remote (Browser Fabric) on request

Start a browser (idempotent; reuses a running one) and print its endpoint:
  fabric up                  your everyday Chrome, real profile, shared with you → http://127.0.0.1:9222
  fabric up --profile <name> a separate Chrome fabric starts (~/.config/fabric/profiles/<name>)
  fabric up --headless       the same, headless (profile "agent" unless --profile)
  fabric up --remote         remote browser with the persistent agent profile → http://127.0.0.1:9223
  fabric up --remote --fresh remote browser without the persistent profile (throwaway)

Your own Chrome (Chrome 144+), once: open chrome://inspect/#remote-debugging and enable it
(fabric opens that page when it is off). Chrome then asks "Allow remote debugging?" each time
fabric connects: click Allow. fabric keeps that one connection for every client until
\`fabric down\` or until Chrome quits; down only detaches, it never quits Chrome or closes tabs.

Drive it from any CDP client:
  Playwright   chromium.connectOverCDP("http://127.0.0.1:9222")
  Puppeteer    puppeteer.connect({ browserURL: "http://127.0.0.1:9222" })
  MCP          fabric mcp [--remote] [--server playwright|devtools]   (stdio MCP server)
  Live view    fabric view   (watch and take over: click, type, switch tabs)

Quick actions (start the browser when needed; they use the agent tab last used, never your own
tabs unless --tab picks one):
  fabric goto <url>          navigate the agent tab (a new one if none), wait for load, print url and title
  fabric shot [file.png]     screenshot (--full for the whole page)
  fabric eval <expression>   evaluate JavaScript in the page and print the JSON result
  fabric tabs                list tabs, agent tabs marked * (use with --tab <index|id>)

Manage:
  fabric status              running browsers          fabric down [name|--all]   stop
  fabric login --url <https://host> --username <principal>   (password on stdin)
  fabric whoami              principal, projects, profiles and recipes you can use

Options for up/mcp/actions:
  --remote  --name <name>  --port <port>  --profile <ref|dir>  --fresh  --project <id>
  --recipe <ref>  --egress <ref>  --ttl <4h|90m|seconds>  --idle <minutes>  --headless
  --chrome <path> (with --profile/--headless)  --tab <index|id>  --full  --json
The remote browser is released after --idle minutes (default 10) without a client and restarts
on the next connection; logins in the persistent profile survive, open tabs do not.`;

const options = {
  remote: { type: "boolean" },
  name: { type: "string" },
  port: { type: "string" },
  profile: { type: "string" },
  fresh: { type: "boolean" },
  project: { type: "string" },
  recipe: { type: "string" },
  egress: { type: "string" },
  ttl: { type: "string" },
  idle: { type: "string" },
  headless: { type: "boolean" },
  chrome: { type: "string" },
  tab: { type: "string" },
  full: { type: "boolean" },
  json: { type: "boolean" },
  all: { type: "boolean" },
  server: { type: "string" },
  url: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export function parseDuration(raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined) return fallbackSeconds;
  const match = /^(\d+)(h|m|s)?$/.exec(raw.trim());
  if (!match) throw new Error(`invalid duration ${JSON.stringify(raw)}; use 4h, 90m or seconds`);
  const value = Number(match[1]);
  return match[2] === "h" ? value * 3600 : match[2] === "m" ? value * 60 : value;
}

function integer(raw: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

type Values = ReturnType<typeof parse>["values"];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

const modeOf = (values: Values): BrowserMode => values.remote ? "remote" : "local";
/** Each mode's default browser is named after the mode, so `--remote` alone selects it. */
const nameOf = (values: Values, positional?: string): string => positional ?? values.name ?? modeOf(values);

export async function browserRequest(values: Values): Promise<BrowserRequest> {
  const mode = modeOf(values);
  if (mode === "local" && (values.fresh || values.project || values.recipe || values.egress)) throw new Error("--fresh, --project, --recipe and --egress need --remote");
  if (mode === "remote" && (values.headless || values.chrome)) throw new Error("--headless and --chrome apply to the local browser only");
  if (mode === "local" && values.chrome && !values.profile && !values.headless) throw new Error("--chrome needs --profile or --headless: your own Chrome is used as it runs");
  // A headless browser cannot be the user's own Chrome: it gets a fabric profile.
  const profile = values.profile ?? (mode === "local" && values.headless ? "agent" : undefined);
  const name = assertName(nameOf(values));
  const ttlSeconds = parseDuration(values.ttl, 4 * 3600);
  if (ttlSeconds < 60 || ttlSeconds > 14_400) throw new Error("--ttl must be between 1m and 4h");
  return {
    name,
    mode,
    port: await choosePort(name, mode, integer(values.port, "port", 1024, 65_535)),
    ...(profile ? { profile } : {}),
    fresh: values.fresh ?? false,
    ...(values.project ? { project: values.project } : {}),
    ...(values.recipe ? { recipe: values.recipe } : {}),
    ...(values.egress ? { egress: values.egress } : {}),
    ttlSeconds,
    idleMinutes: integer(values.idle, "idle", 1, 240) ?? 10,
    headless: values.headless ?? false,
    ...(values.chrome ? { chrome: values.chrome } : {}),
  };
}

/** Actions reuse the named browser, or start one with default settings. */
async function actionPort(values: Values): Promise<number> {
  const running = liveState(nameOf(values));
  if (running && (running.status === "ready" || running.status === "idle")) return running.request.port;
  return (await up(await browserRequest(values))).request.port;
}

function print(values: Values, human: string, machine: unknown): void {
  console.log(values.json ? JSON.stringify(machine, null, 2) : human);
}

async function readPassword(values: Values): Promise<string> {
  if (values.password) return values.password;
  if (process.stdin.isTTY) {
    const entered = prompt("Fabric password:");
    if (!entered) throw new Error("no password entered");
    return entered.trim();
  }
  const piped = (await Bun.stdin.text()).trim();
  if (!piped) throw new Error("pipe the password on stdin, e.g. fabric login --url … --username … < password-file");
  return piped;
}

export async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  if (command === "__daemon") return runDaemon(JSON.parse(rest[0]!) as BrowserRequest, rest[1] === "warm");
  const separator = rest.indexOf("--");
  const { values, positionals } = parse(separator === -1 ? rest : rest.slice(0, separator));
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);
  if (values.help || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "up": {
      const state = await up(await browserRequest(values));
      print(values, describeState(state), { ...state, endpoint: endpointUrl(state.request.port) });
      return;
    }
    case "down": {
      const names = values.all ? listStates().map((state) => state.request.name) : [nameOf(values, positionals[0])];
      for (const name of names) console.log(await down(name) ? `stopped ${name}` : `${name} is not running`);
      return;
    }
    case "status":
    case "ls": {
      const states = listStates().map((state) => liveState(state.request.name)).filter((state) => state !== undefined);
      print(values, states.length ? states.map(describeState).join("\n\n") : "no browser running; start one with `fabric up` (local) or `fabric up --remote`", states);
      return;
    }
    case "view": {
      const port = await actionPort({ ...values, name: positionals[0] ?? values.name });
      const url = `${endpointUrl(port)}/`;
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
      console.log(url);
      return;
    }
    case "goto": {
      const url = positionals[0];
      if (!url) throw new Error("usage: fabric goto <url>");
      const result = await goto(await actionPort(values), /^[a-z]+:/i.test(url) ? url : `https://${url}`, { ...(values.tab ? { tab: values.tab } : {}) });
      print(values, `${result.title}\n${result.url}`, result);
      return;
    }
    case "shot":
    case "screenshot": {
      const path = await screenshot(await actionPort(values), { ...(values.tab ? { tab: values.tab } : {}), ...(positionals[0] ? { path: positionals[0] } : {}), fullPage: values.full ?? false });
      print(values, path, { path });
      return;
    }
    case "eval": {
      const expression = positionals.join(" ");
      if (!expression) throw new Error("usage: fabric eval <expression>");
      const value = await evaluate(await actionPort(values), expression, { ...(values.tab ? { tab: values.tab } : {}) });
      console.log(typeof value === "string" && !values.json ? value : JSON.stringify(value, null, 2));
      return;
    }
    case "tabs": {
      const pages = await tabs(await actionPort(values));
      print(values, pages.map((page, index) => `${index}${page.agentTab ? "*" : " "} ${page.targetId.slice(0, 8)}  ${page.title || "(untitled)"}\n    ${page.url}`).join("\n") || "no tabs", pages);
      return;
    }
    case "mcp": {
      const server = (values.server ?? "playwright") as keyof typeof MCP_SERVERS;
      if (!(server in MCP_SERVERS)) throw new Error(`--server must be one of ${Object.keys(MCP_SERVERS).join(", ")}`);
      await mcp(await browserRequest(values), server, passthrough);
      return;
    }
    case "login": {
      if (!values.url || !values.username) throw new Error("usage: fabric login --url <https://host> --username <principal> (password on stdin)");
      const credentials = { url: normalizeApiUrl(values.url), username: normalizeUsername(values.username), password: await readPassword(values) };
      const identity = await fetchIdentity(credentials);
      const path = saveCredentials(credentials);
      console.log(`logged in as ${identity.principal} (${identity.projects.map((project) => project.id).join(", ")}); saved ${path}`);
      return;
    }
    case "whoami": {
      const identity = await fetchIdentity(loadCredentials());
      print(values, [
        `principal  ${identity.principal} (${identity.roles.join(", ")})`,
        `projects   ${identity.projects.map((project) => project.id).join(", ")}`,
        `profiles   ${identity.profiles.map((profile) => `${profile.ref} [${profile.profileFamily}]`).join(", ") || "none"}`,
        `recipes    ${identity.recipes.filter((recipe) => recipe.access === "raw_cdp").map((recipe) => recipe.ref).join(", ")}`,
        `egress     ${identity.egressPolicies.join(", ")}`,
      ].join("\n"), identity);
      return;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(command)}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`fabric: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
