import { describe, expect, test } from "bun:test";
import { TaskBrowser } from "@browser-fabric/task-agent";
import { CdpConnection, type CdpTransport } from "@browser-fabric/worker-runtime";

type Command = { id: number; method: string; params?: Record<string, any>; sessionId?: string };

/**
 * A scripted browser-level CDP transport: it answers every command at once, except commands a test
 * holds, which answer only when released. That reproduces Chrome answering a popup's commands late
 * (another client holds the new tab with waitForDebuggerOnStart) while the popup is already gone.
 */
class ScriptedBrowser implements CdpTransport {
  readonly commands: Command[] = [];
  readonly #listeners = new Map<string, Set<(event: any) => void>>();
  readonly #held = new Map<string, Array<() => void>>();
  readonly #hold: (command: Command) => string | undefined;
  #closed = false;

  public constructor(hold: (command: Command) => string | undefined = () => undefined) {
    this.#hold = hold;
  }

  public get readyState(): number { return this.#closed ? 3 : 1; }

  public send(raw: string): void {
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
    const answer = () => this.#emit("message", { data: JSON.stringify({ id: command.id, result: this.#result(command) }) });
    const key = this.#hold(command);
    if (key === undefined) queueMicrotask(answer);
    else this.#held.set(key, [...(this.#held.get(key) ?? []), answer]);
  }

  /** Answers the commands held under `key`. */
  public release(key: string): void {
    for (const answer of this.#held.get(key) ?? []) answer();
    this.#held.delete(key);
  }

  public held(key: string): boolean {
    return (this.#held.get(key)?.length ?? 0) > 0;
  }

  public event(method: string, params: Record<string, unknown>): void {
    this.#emit("message", { data: JSON.stringify({ method, params }) });
  }

  public close(): void {
    this.#closed = true;
    this.#emit("close", {});
  }

  public addEventListener(type: string, callback: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: string, callback: (event: any) => void): void {
    this.#listeners.get(type)?.delete(callback);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of [...this.#listeners.get(type) ?? []]) listener(event);
  }

  #result(command: Command): Record<string, unknown> {
    switch (command.method) {
      case "Target.createTarget":
        return { targetId: "opener" };
      case "Target.attachToTarget":
        return { sessionId: `session:${command.params?.targetId}` };
      case "Target.closeTarget":
        queueMicrotask(() => this.event("Target.targetDestroyed", { targetId: command.params?.targetId }));
        return { success: true };
      default:
        return {};
    }
  }
}

async function openOn(transport: ScriptedBrowser): Promise<TaskBrowser> {
  const connection = await CdpConnection.connect({ endpoint: "ws://browser.test/devtools/browser/tabs", transportFactory: async () => transport });
  return TaskBrowser.open({ connection });
}

const popupCreated = (transport: ScriptedBrowser) => transport.event("Target.targetCreated", {
  targetInfo: { targetId: "popup", type: "page", url: "about:blank", openerId: "opener" },
});

const until = async (predicate: () => boolean) => {
  for (let tries = 0; !predicate(); tries++) {
    if (tries > 200) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
};

describe("task browser popups", () => {
  test("a popup that stays open becomes the active tab, with a notice", async () => {
    const transport = new ScriptedBrowser();
    const browser = await openOn(transport);
    popupCreated(transport);
    await browser.settle().catch(() => undefined);
    expect(browser.active.targetId).toBe("popup");
    expect(browser.drainNotices()).toEqual(["A new tab opened and is now the active tab."]);
    await browser.close(false);
  });

  test("a popup destroyed while its page domain is being enabled never becomes the active tab", async () => {
    // A target=_blank link to a download: the download is intercepted and the empty tab closed,
    // and Page.enable answers only after the tab is gone.
    const transport = new ScriptedBrowser((command) => command.method === "Page.enable" && command.sessionId === "session:popup" ? "popup-enable" : undefined);
    const browser = await openOn(transport);
    popupCreated(transport);
    await until(() => transport.held("popup-enable"));
    transport.event("Target.targetDestroyed", { targetId: "popup" });
    transport.release("popup-enable");
    await browser.settle().catch(() => undefined);

    expect(browser.active.targetId).toBe("opener");
    expect(browser.active.closed).toBe(false);
    expect(browser.drainNotices()).toEqual([]);
    await browser.close(false);
    // Only the opener is left to close; the dead popup is not tracked.
    expect(transport.commands.filter((command) => command.method === "Target.closeTarget").map((command) => command.params?.targetId)).toEqual(["opener"]);
  });

  test("a popup destroyed before Chrome answered the attach is never registered or activated", async () => {
    const transport = new ScriptedBrowser((command) => command.method === "Target.attachToTarget" && command.params?.targetId === "popup" ? "popup-attach" : undefined);
    const browser = await openOn(transport);
    popupCreated(transport);
    await until(() => transport.held("popup-attach"));
    transport.event("Target.targetDestroyed", { targetId: "popup" });
    transport.release("popup-attach");
    await browser.settle().catch(() => undefined);

    expect(browser.active.targetId).toBe("opener");
    expect(browser.drainNotices()).toEqual([]);
    // The dead popup's session is never used.
    expect(transport.commands.some((command) => command.sessionId === "session:popup")).toBe(false);
    await browser.close(false);
    expect(transport.commands.filter((command) => command.method === "Target.closeTarget").map((command) => command.params?.targetId)).toEqual(["opener"]);
  });

  test("the active tab closing after a popup was activated still falls back to the opener", async () => {
    const transport = new ScriptedBrowser();
    const browser = await openOn(transport);
    popupCreated(transport);
    await browser.settle().catch(() => undefined);
    expect(browser.active.targetId).toBe("popup");
    browser.drainNotices();
    transport.event("Target.targetDestroyed", { targetId: "popup" });
    expect(browser.active.targetId).toBe("opener");
    expect(browser.drainNotices()).toEqual(["The active tab closed; switched to the previous tab."]);
    await browser.close(false);
  });

  test("opening fails, instead of handing out a dead tab, when the tab is destroyed while being attached", async () => {
    const transport = new ScriptedBrowser((command) => command.method === "Target.attachToTarget" ? "attach" : undefined);
    const opening = openOn(transport);
    await until(() => transport.held("attach"));
    transport.event("Target.targetDestroyed", { targetId: "opener" });
    transport.release("attach");
    await expect(opening).rejects.toThrow(/closed while it was being attached/);
  });
});
