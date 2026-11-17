import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS, observe, Secrets, TaskBrowser, UploadPolicy, type ActionContext } from "@browser-fabric/task-agent";
import { chromiumExecutable as executable, launchChromium, type TestChromium } from "./support/chromium";
import { startFixtureSite, type FixtureSite } from "./support/task-agent-fixtures";

let chromium: TestChromium;
let site: FixtureSite;
let browser: TaskBrowser | undefined;
const uploadRoot = mkdtempSync(join(tmpdir(), "task-agent-upload-"));
writeFileSync(join(uploadRoot, "resume.txt"), "hello upload");
const outsideFile = join(mkdtempSync(join(tmpdir(), "task-agent-outside-")), "secret.txt");
writeFileSync(outsideFile, "nope");

beforeAll(async () => {
  if (!executable) return;
  chromium = await launchChromium(executable);
  site = startFixtureSite();
});
afterAll(async () => {
  await chromium?.close();
  site?.stop();
  rmSync(uploadRoot, { recursive: true, force: true });
});
afterEach(async () => {
  await browser?.close(false);
  browser = undefined;
});

async function open(path: string, secrets: Record<string, string> = {}): Promise<ActionContext> {
  browser = await TaskBrowser.open({ cdpEndpoint: chromium.endpoint });
  const context: ActionContext = { browser, secrets: new Secrets(secrets), uploads: new UploadPolicy([uploadRoot]) };
  await ACTIONS.navigate!(context, { url: `${site.origin}${path}` });
  return context;
}

const look = (context: ActionContext, maxChars = 12_000) => observe(context.browser, { maxChars, screenshot: false });

/** Ref of the element whose line in the observation matches. */
function ref(observation: { text: string }, pattern: RegExp | string): string {
  const line = observation.text.split("\n").find((candidate) => typeof pattern === "string" ? candidate.includes(pattern) : pattern.test(candidate));
  const match = line && /^\[((?:f\d+)?e\d+)\]/.exec(line);
  if (!match) throw new Error(`no element matching ${pattern} in:\n${observation.text}`);
  return match[1]!;
}

async function pageLog(context: ActionContext): Promise<string> {
  const world = await context.browser.mainWorld(context.browser.active);
  return context.browser.evaluate<string>(context.browser.active.sessionId, world, "document.getElementById('log')?.textContent ?? ''");
}

const elementLines = (text: string) => text.split("\n").filter((line) => /^\[(f\d+)?e\d+\]/.test(line));

describe.skipIf(!executable)("observation (real Chromium)", () => {
  test("lists visible interactive elements with roles, names, values and states; hidden ones are excluded", async () => {
    const context = await open("/form");
    const observation = await look(context);
    expect(observation.url).toBe(`${site.origin}/form`);
    expect(observation.title).toBe("Form");
    expect(elementLines(observation.text).map((line) => line.replace(/^\[e\d+\] /, "").replace(/\(\d+ screens away\)/, "(N screens away)"))).toEqual([
      "textbox \"Email address\" type=email required",
      "textbox \"Password\" type=password",
      "combobox \"Country\" value=\"Choose…\" options=\"Choose… | Germany | France\"",
      "textbox \"Nickname\"",
      "textbox \"Biography\" value=\"Hello\"",
      "textbox \"Birthday\" type=date",
      "checkbox \"Accept terms\" unchecked",
      "textbox \"Notes\"",
      "button \"Disabled action\" disabled",
      "button \"Save\"",
      "link \"Help\" → /form#help",
      "link \"upvote\" → /form#up",
      "clickable \"Clickable div\"",
      "button \"Wrapped button\"",
      "button \"Inside display contents\"",
      "button \"Far below\" (N screens away)",
    ]);
    for (const hidden of ["Hidden display", "Hidden visibility", "Hidden attribute", "Zero size", "Transparent", "Inert button", "Offscreen left"]) {
      expect(elementLines(observation.text).join("\n")).not.toContain(hidden);
    }
    expect(observation.text).toContain("Scroll: showing 0-");
    expect(observation.text).toContain("(more below)");
    expect(observation.text).toContain("Page text (excerpt):\nAccount form");
  });

  test("refs stay stable across snapshots of the same document and go stale after navigation", async () => {
    const context = await open("/form");
    const first = await look(context);
    const save = ref(first, "\"Save\"");
    await ACTIONS.type!(context, { ref: ref(first, "Nickname"), text: "neo" });
    const second = await look(context);
    expect(ref(second, "\"Save\"")).toBe(save);
    expect(second.text).toContain("textbox \"Nickname\" value=\"neo\" focused");
    await ACTIONS.navigate!(context, { url: `${site.origin}/counter` });
    await expect(ACTIONS.click!(context, { ref: save })).rejects.toThrow(`ref ${save} no longer exists`);
    await expect(ACTIONS.click!(context, { ref: "button-1" })).rejects.toThrow("invalid ref");
  });

  test("reaches into open shadow roots, nested ones included", async () => {
    const context = await open("/shadow");
    const observation = await look(context);
    expect(elementLines(observation.text).map((line) => line.replace(/^\[e\d+\] /, ""))).toEqual(["textbox \"Shadow input\"", "button \"Shadow button\"", "button \"Nested shadow button\""]);
    await ACTIONS.type!(context, { ref: ref(observation, "Shadow input"), text: "from agent" });
    await ACTIONS.click!(context, { ref: ref(observation, "\"Shadow button\"") });
    await ACTIONS.click!(context, { ref: ref(observation, "Nested shadow button") });
    expect(await pageLog(context)).toBe("shadow clicked from agent\nnested shadow clicked\n");
  });

  test("covers same-site frames, cross-site OOPIFs and a frame nested in an OOPIF; clicks land in each", async () => {
    const context = await open("/frames");
    const observation = await look(context);
    expect(observation.frameCount).toBe(5);
    expect(observation.text).toContain(`-- frame f1 ${site.origin}/frame-inner?name=same "Inner same"`);
    expect(observation.text).toContain(`-- frame f2 (cross-origin) ${site.otherOrigin}/frame-inner?name=cross&nest=1`);
    expect(observation.text).toContain(`-- frame f3 ${site.otherOrigin}/frame-inner?name=cross-nested`);
    expect(observation.text).toContain(`-- frame f4 (cross-origin) ${site.otherOrigin}/frame-inner?name=below`);
    for (const name of ["same", "cross", "cross-nested", "below"]) {
      await ACTIONS.type!(context, { ref: ref(observation, `textbox "${name} field"`), text: `typed ${name}` });
      await ACTIONS.click!(context, { ref: ref(observation, `button "${name} button"`) });
    }
    const after = await look(context);
    for (const name of ["same", "cross", "cross-nested", "below"]) {
      // The button reports event.isTrusted: real input, not a synthetic DOM event.
      expect(after.text).toContain(`button "${name} clicked true"`);
      expect(after.text).toContain(`textbox "${name} field" value="typed ${name}"`);
    }
  });

  test("a huge page stays within the budget, keeping what is near the viewport", async () => {
    const context = await open("/huge");
    const started = performance.now();
    const observation = await look(context, 6_000);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(observation.text.length).toBeLessThan(6_500);
    expect(observation.text).toContain("button \"Item button 0\"");
    expect(observation.text).not.toContain("Item button 3999");
    expect(observation.omittedElements).toBeGreaterThan(3_000);
    expect(observation.text).toMatch(/Interactive elements \(\d+, \d+ more not shown: scroll or use extract\)/);
    expect(observation.text).toContain("…");
  });

  test("a screenshot is attached when asked", async () => {
    const context = await open("/counter");
    const observation = await observe(context.browser, { maxChars: 4_000, screenshot: true });
    expect(Buffer.from(observation.screenshot!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe.skipIf(!executable)("actions (real Chromium)", () => {
  test("click is trusted, refuses covered elements unless forced, and reports navigation", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    expect(await ACTIONS.click!(context, { ref: ref(observation, "\"Count\"") })).toBe(`clicked ${ref(observation, "\"Count\"")}`);
    await ACTIONS.click!(context, { ref: ref(observation, "\"Count\"") });
    expect(await pageLog(context)).toBe("click trusted=true n=1\nclick trusted=true n=2\n");
    const covered = ref(observation, "\"Covered\"");
    await expect(ACTIONS.click!(context, { ref: covered })).rejects.toThrow("the element is covered by <div> \"Cookie banner\"");
    expect(await pageLog(context)).not.toContain("covered clicked");
    await ACTIONS.click!(context, { ref: covered, force: true });
    expect(await pageLog(context)).not.toContain("covered clicked"); // the banner took the click, as it would for a person
    const result = await ACTIONS.click!(context, { ref: ref(observation, "Go to form") });
    expect(result).toContain("the page navigated");
    expect((await look(context)).url).toBe(`${site.origin}/form`);
  });

  test("type replaces content, handles date, contenteditable and secrets; select and checkbox labels work; submit sends the form", async () => {
    const context = await open("/form", { PASSWORD: "s3cret-value" });
    const observation = await look(context);
    expect(await ACTIONS.type!(context, { ref: ref(observation, "Email address"), text: "neo@example.com" })).toContain("its value is now \"neo@example.com\"");
    const bio = ref(observation, "Biography");
    await ACTIONS.type!(context, { ref: bio, text: "replaced" });
    await ACTIONS.type!(context, { ref: bio, text: " and appended", clear: false });
    expect(await ACTIONS.type!(context, { ref: ref(observation, "Password"), text: "{{secret:PASSWORD}}" })).toBe(`typed into ${ref(observation, "Password")}; its value is now (secret entered)`);
    await expect(ACTIONS.type!(context, { ref: ref(observation, "Password"), text: "{{secret:OTHER}}" })).rejects.toThrow("unknown secret");
    expect(await ACTIONS.type!(context, { ref: ref(observation, "Birthday"), text: "2001-02-03" })).toContain("\"2001-02-03\"");
    await expect(ACTIONS.type!(context, { ref: ref(observation, "Birthday"), text: "03.02.2001" })).rejects.toThrow("the field rejected the value (check its format); it is still \"2001-02-03\"");
    await ACTIONS.type!(context, { ref: ref(observation, "Notes"), text: "rich text" });
    const country = ref(observation, "Country");
    expect(await ACTIONS.select!(context, { ref: country, value: "france" })).toBe(`selected "France" in ${country}`);
    expect(await ACTIONS.select!(context, { ref: country, value: "de" })).toBe(`selected "Germany" in ${country}`);
    await expect(ACTIONS.select!(context, { ref: country, value: "Spain" })).rejects.toThrow("no matching option for [\"Spain\"]; options: Choose… | Germany | France");
    await expect(ACTIONS.select!(context, { ref: bio, value: "x" })).rejects.toThrow("not a native <select>");
    await expect(ACTIONS.type!(context, { ref: ref(observation, "\"Save\""), text: "x" })).rejects.toThrow("is not a text field");
    await ACTIONS.click!(context, { ref: ref(observation, "Accept terms") });

    const filled = await look(context);
    expect(filled.text).toContain("textbox \"Biography\" value=\"replaced and appended\"");
    expect(filled.text).toContain("textbox \"Password\" value=\"••••••\" type=password");
    expect(filled.text).toContain("textbox \"Notes\" value=\"rich text\"");
    expect(filled.text).toContain("checkbox \"Accept terms\" checked");
    expect(filled.text).not.toContain("s3cret-value");

    await ACTIONS.type!(context, { ref: ref(observation, "Nickname"), text: "neo", submit: true });
    expect(await pageLog(context)).toBe("submitted email=neo%40example.com&password=s3cret-value&country=de&nick=neo&bio=replaced+and+appended&birthday=2001-02-03&terms=on\n");
  });

  test("press sends trusted keys and chords to the focused element", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    await ACTIONS.click!(context, { ref: ref(observation, "\"Keys\"") });
    await ACTIONS.press!(context, { key: "a" });
    await ACTIONS.press!(context, { key: "Shift+b" });
    await ACTIONS.press!(context, { key: "Control+Enter" });
    expect(await pageLog(context)).toBe([
      "key a ctrl=false shift=false trusted=true",
      "key Shift ctrl=false shift=true trusted=true",
      "key B ctrl=false shift=true trusted=true",
      "key Control ctrl=true shift=false trusted=true",
      "key Enter ctrl=true shift=false trusted=true",
      "",
    ].join("\n"));
    expect((await look(context)).text).toContain("textbox \"Keys\" value=\"aB\" focused");
    await expect(ACTIONS.press!(context, { key: "Hyper+x" })).rejects.toThrow("unknown modifier");
  });

  test("scroll moves the page or a scrollable element", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    expect(await ACTIONS.scroll!(context, { direction: "down", amount: 1 })).toMatch(/^scrolled down; page now shows [1-9]\d*-\d+px of \d+px$/);
    await ACTIONS.scroll!(context, { direction: "up", amount: 5 });
    expect((await look(context)).text).toContain("Scroll: showing 0-");
    await ACTIONS.scroll!(context, { direction: "down", ref: ref(observation, "scrollable \"Scrollable box\"") });
    const world = await context.browser.mainWorld(context.browser.active);
    expect(await context.browser.evaluate<number>(context.browser.active.sessionId, world, "document.getElementById('scroller').scrollTop")).toBeGreaterThan(0);
    await expect(ACTIONS.scroll!(context, { direction: "sideways" })).rejects.toThrow("direction must be");
  });

  test("upload attaches only allowlisted files", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    const input = ref(observation, "file-input \"Attachment\"");
    expect(await ACTIONS.upload!(context, { ref: input, path: "resume.txt" })).toBe(`attached resume.txt to ${input}`);
    expect(await pageLog(context)).toBe("files resume.txt:12\n");
    await expect(ACTIONS.upload!(context, { ref: input, path: outsideFile })).rejects.toThrow("outside the allowed directories");
    await expect(ACTIONS.upload!(context, { ref: input, path: "../etc/passwd" })).rejects.toThrow();
    await expect(ACTIONS.upload!(context, { ref: ref(observation, "\"Count\""), path: "resume.txt" })).rejects.toThrow("is not a file input");
    const disabled: ActionContext = { ...context, uploads: new UploadPolicy() };
    await expect(ACTIONS.upload!(disabled, { ref: input, path: "resume.txt" })).rejects.toThrow("file uploads are disabled");
    expect((await look(context)).text).toContain("file-input \"Attachment\" value=\"resume.txt\"");
  });

  test("wait for text, and time out when it never comes", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    await ACTIONS.click!(context, { ref: ref(observation, "Load later") });
    expect(await ACTIONS.wait!(context, { text: "late content arrived", seconds: 5 })).toBe("the text \"late content arrived\" is on the page");
    const started = Date.now();
    await expect(ACTIONS.wait!(context, { text: "never", seconds: 1 })).rejects.toThrow("did not appear within 1s");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("navigate allows only http(s); back returns", async () => {
    const context = await open("/counter");
    expect(await ACTIONS.navigate!(context, { url: `${site.origin}/form` })).toBe(`opened ${site.origin}/form`);
    expect(await ACTIONS.back!(context, {})).toBe(`went back to ${site.origin}/counter`);
    expect((await look(context)).url).toBe(`${site.origin}/counter`);
    await expect(ACTIONS.navigate!(context, { url: "javascript:alert(1)" })).rejects.toThrow("only http(s) URLs");
    await expect(ACTIONS.navigate!(context, { url: "file:///etc/passwd" })).rejects.toThrow("only http(s) URLs");
    await expect(ACTIONS.navigate!(context, { url: "http://unresolvable.invalid/" })).rejects.toThrow("navigation failed: net::");
    // A bare host gets https://.
    await expect(ACTIONS.navigate!(context, { url: "unresolvable.invalid" })).rejects.toThrow("navigation failed");
  });

  test("a popup becomes the active tab; when it closes the opener is active again", async () => {
    const context = await open("/counter");
    const opener = context.browser.active;
    const observation = await look(context);
    expect(await ACTIONS.click!(context, { ref: ref(observation, "Open popup") })).toContain("a new tab is now active");
    const popup = await observe(context.browser, { maxChars: 4_000, screenshot: false }, context.browser.drainNotices());
    expect(popup.url).toBe(`${site.origin}/popup-target`);
    expect(popup.text).toContain("Notice: A new tab opened and is now the active tab.");
    await ACTIONS.click!(context, { ref: ref(popup, "Close me") });
    await Bun.sleep(300);
    expect(context.browser.active).toBe(opener);
    expect(context.browser.drainNotices()).toContain("The active tab closed; switched to the previous tab.");
  });

  test("dialogs are handled and reported", async () => {
    const context = await open("/counter");
    const observation = await look(context);
    await ACTIONS.click!(context, { ref: ref(observation, "\"Delete\"") });
    expect(await pageLog(context)).toBe("confirmed\n");
    expect(context.browser.drainNotices()).toEqual(["A confirm dialog said \"Really delete?\"; it was accepted."]);
  });

  test("close() closes the tabs it opened, keeps them when asked, and never closes a reused tab", async () => {
    const targets = async () => (await (await fetch(`${chromium.endpoint}/json/list`)).json() as { id: string; type: string }[]).filter((target) => target.type === "page").map((target) => target.id);
    const first = await TaskBrowser.open({ cdpEndpoint: chromium.endpoint });
    const id = first.active.targetId;
    expect(await targets()).toContain(id);
    await first.close(true);
    expect(await targets()).toContain(id);
    const reused = await TaskBrowser.open({ cdpEndpoint: chromium.endpoint, targetId: id });
    expect(reused.active.owned).toBe(false);
    await reused.close(false);
    expect(await targets()).toContain(id);
    const owned = await TaskBrowser.open({ cdpEndpoint: chromium.endpoint });
    const ownedId = owned.active.targetId;
    await owned.close(false);
    await Bun.sleep(200);
    expect(await targets()).not.toContain(ownedId);
    await fetch(`${chromium.endpoint}/json/close/${id}`);
  });
});
