import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CdpConnection } from "@browser-fabric/worker-runtime";

/** `agentTab`: created by a fabric client (or a popup of one), not one of the user's own tabs. */
export interface PageTarget { targetId: string; title: string; url: string; agentTab: boolean }

/** Pages in the endpoint's most-recently-used order, so "the current tab" is the one last created, navigated or activated. */
export async function listPages(port: number): Promise<PageTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`fabric endpoint /json/list returned HTTP ${response.status}: ${await response.text()}`);
  const targets = await response.json() as { id: string; type: string; title: string; url: string; agentTab?: boolean }[];
  return targets
    .filter((target) => target.type === "page" && !target.url.startsWith("devtools://"))
    .map((target) => ({ targetId: target.id, title: target.title, url: target.url, agentTab: target.agentTab === true }));
}

/**
 * `--tab` accepts a list index, or a target id (prefix). Without it, the most recently used agent
 * tab: in the user's own Chrome an action must not take over the tab the user is working in, so
 * with no agent tab the caller opens a new one.
 */
export function pickPage(pages: readonly PageTarget[], tab?: string): PageTarget | undefined {
  if (tab === undefined) return pages.find((page) => page.agentTab);
  if (/^\d+$/.test(tab)) return pages[Number(tab)];
  const matches = pages.filter((page) => page.targetId.toLowerCase().startsWith(tab.toLowerCase()));
  if (matches.length > 1) throw new Error(`tab ${tab} is ambiguous`);
  return matches[0];
}

async function withConnection<T>(port: number, run: (connection: CdpConnection) => Promise<T>): Promise<T> {
  const connection = await CdpConnection.connect({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 90_000 });
  try {
    return await run(connection);
  } finally {
    connection.close();
  }
}

async function withPage<T>(port: number, tab: string | undefined, run: (connection: CdpConnection, sessionId: string) => Promise<T>): Promise<T> {
  const page = pickPage(await listPages(port), tab);
  return withConnection(port, async (connection) => {
    if (!page && tab !== undefined) throw new Error(`no tab ${tab}; run \`fabric tabs\``);
    const targetId = page?.targetId ?? (await connection.send("Target.createTarget", { url: "about:blank" })).targetId as string;
    // An explicitly chosen tab becomes the current one (and the visible one in a headful browser).
    if (tab !== undefined) await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`);
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    return run(connection, sessionId);
  });
}

function waitForEvent(connection: CdpConnection, sessionId: string, method: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`${method} did not fire within ${timeoutMs / 1000} s`)); }, timeoutMs);
    const unsubscribe = connection.onMessage((message) => {
      if (message.method === method && message.sessionId === sessionId) {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise();
      }
    });
  });
}

async function pageSummary(connection: CdpConnection, sessionId: string): Promise<{ url: string; title: string }> {
  const { result } = await connection.send("Runtime.evaluate", { expression: "({ url: location.href, title: document.title })", returnByValue: true }, sessionId);
  return result.value as { url: string; title: string };
}

export async function goto(port: number, url: string, options: { tab?: string; timeoutMs?: number } = {}) {
  return withPage(port, options.tab, async (connection, sessionId) => {
    await connection.send("Page.enable", {}, sessionId);
    const loaded = waitForEvent(connection, sessionId, "Page.loadEventFired", options.timeoutMs ?? 30_000);
    loaded.catch(() => undefined);
    const navigation = await connection.send("Page.navigate", { url }, sessionId, options.timeoutMs ?? 30_000) as { loaderId?: string; errorText?: string };
    if (navigation.errorText) throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
    // A same-document navigation (hash change) has no loader and fires no load event.
    if (navigation.loaderId) await loaded;
    return pageSummary(connection, sessionId);
  });
}

export async function screenshot(port: number, options: { tab?: string; path?: string; fullPage?: boolean } = {}): Promise<string> {
  return withPage(port, options.tab, async (connection, sessionId) => {
    const clip = options.fullPage
      ? await connection.send("Page.getLayoutMetrics", {}, sessionId).then(({ cssContentSize }) => ({ x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 }))
      : undefined;
    const { data } = await connection.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId, 60_000) as { data: string };
    const path = resolve(options.path ?? `fabric-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  });
}

export async function evaluate(port: number, expression: string, options: { tab?: string } = {}): Promise<unknown> {
  return withPage(port, options.tab, async (connection, sessionId) => {
    const { result, exceptionDetails } = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId, 60_000);
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value === undefined ? result.description ?? result.type : result.value;
  });
}

export const tabs = listPages;
