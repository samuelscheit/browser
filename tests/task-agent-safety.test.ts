import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets, UploadPolicy, validateSchema, type ChatMessage } from "@browser-fabric/task-agent";
import { parseChord } from "../packages/task-agent/src/keys";
import { buildMessages, SYSTEM_PROMPT, taskTools, type HistoryStep } from "../packages/task-agent/src/prompt";
import { parseTimeout } from "../packages/task-agent/src/cli";
import { functionSource } from "../packages/task-agent/src/browser";

describe("secrets", () => {
  const secrets = new Secrets({ PASSWORD: "hunter2-long", PASSWORD_HINT: "hunter2", PIN: "12" });

  test("resolves placeholders only at typing time and rejects unknown names", () => {
    expect(secrets.resolve("{{secret:PASSWORD}}")).toBe("hunter2-long");
    expect(secrets.resolve("user {{secret:PIN}}/{{secret:PASSWORD_HINT}}")).toBe("user 12/hunter2");
    expect(() => secrets.resolve("{{secret:API_KEY}}")).toThrow("unknown secret {{secret:API_KEY}}; available: {{secret:PASSWORD}}, {{secret:PASSWORD_HINT}}, {{secret:PIN}}");
    expect(secrets.resolve("no placeholders")).toBe("no placeholders");
    expect(secrets.hasPlaceholder("x {{secret:PIN}}")).toBe(true);
    expect(secrets.hasPlaceholder("{{secret:}}")).toBe(false);
  });

  test("redacts every occurrence, the longest secret first, in nested values", () => {
    expect(secrets.redact("pw hunter2-long and hint hunter2 hunter2")).toBe("pw {{secret:PASSWORD}} and hint {{secret:PASSWORD_HINT}} {{secret:PASSWORD_HINT}}");
    // Too-short values are not redacted (they would mangle ordinary text); they are still typeable.
    expect(secrets.redact("page 12 of 20")).toBe("page 12 of 20");
    expect(secrets.redactValue({ a: ["hunter2-long", 3, null], b: { c: "x hunter2" } })).toEqual({ a: ["{{secret:PASSWORD}}", 3, null], b: { c: "x {{secret:PASSWORD_HINT}}" } });
  });

  test("come from FABRIC_SECRET_* variables only", () => {
    const fromEnv = Secrets.fromEnvironment({ FABRIC_SECRET_TOKEN: "abc123", ANTHROPIC_API_KEY: "sk-ant", FABRIC_SECRET_EMPTY: "" });
    expect(fromEnv.names).toEqual(["TOKEN"]);
    expect(() => fromEnv.resolve("{{secret:ANTHROPIC_API_KEY}}")).toThrow("unknown secret");
  });

  test("names are restricted", () => {
    expect(() => new Secrets({ "bad name": "x" })).toThrow("must match");
  });
});

describe("upload allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "task-agent-uploads-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  mkdirSync(join(allowed, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(allowed, "cv.pdf"), "pdf");
  writeFileSync(join(allowed, "nested", "photo.jpg"), "jpg");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(allowed, "link-out.txt"));
  symlinkSync(outside, join(allowed, "dir-link"));
  const policy = new UploadPolicy([allowed]);

  test("allows regular files inside the directory, relative or absolute", () => {
    expect(policy.check("cv.pdf")).toEndWith("/allowed/cv.pdf");
    expect(policy.check(join(allowed, "nested", "photo.jpg"))).toEndWith("/allowed/nested/photo.jpg");
    expect(policy.check("nested/../cv.pdf")).toEndWith("/allowed/cv.pdf");
  });

  test("refuses traversal, symlink escapes, directories, missing files and absolute paths outside", () => {
    expect(() => policy.check("../outside/secret.txt")).toThrow("outside the allowed directories");
    expect(() => policy.check(join(outside, "secret.txt"))).toThrow("outside the allowed directories");
    expect(() => policy.check("link-out.txt")).toThrow("outside the allowed directories");
    expect(() => policy.check("dir-link/secret.txt")).toThrow("outside the allowed directories");
    expect(() => policy.check("nested")).toThrow("not a regular file");
    expect(() => policy.check(".")).toThrow("outside the allowed directories");
    expect(() => policy.check("missing.pdf")).toThrow("does not exist");
    expect(() => policy.check("/etc/passwd")).toThrow("outside the allowed directories");
  });

  test("is disabled without directories and rejects non-directories", () => {
    expect(new UploadPolicy().enabled).toBe(false);
    expect(() => new UploadPolicy().check("cv.pdf")).toThrow("file uploads are disabled");
    expect(() => new UploadPolicy([join(allowed, "cv.pdf")])).toThrow("is not a directory");
    expect(() => new UploadPolicy([join(root, "nope")])).toThrow();
  });

  test("cleanup", () => rmSync(root, { recursive: true, force: true }));
});

describe("result schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0 },
      sku: { type: "string", pattern: "^[A-Z]{2}-\\d{3}$" },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      currency: { enum: ["USD", "EUR"] },
      note: { type: ["string", "null"] },
    },
    required: ["name", "price", "sku"],
    additionalProperties: false,
  };

  test("accepts a matching value", () => {
    expect(validateSchema({ name: "Red Widget", price: 42.5, sku: "RW-042", tags: ["a"], currency: "USD", note: null }, schema)).toEqual([]);
    expect(validateSchema(3, { type: "number" })).toEqual([]);
    expect(validateSchema("anything", {})).toEqual([]);
  });

  test("reports every problem with its path", () => {
    expect(validateSchema({ name: "", price: -1, sku: "rw42", tags: ["a", 1, "c"], currency: "GBP", extra: true }, schema).sort()).toEqual([
      "$.currency: must be one of [\"USD\",\"EUR\"]",
      "$.extra: not allowed",
      "$.name: shorter than 1",
      "$.price: below 0",
      "$.sku: does not match ^[A-Z]{2}-\\d{3}$",
      "$.tags: more than 2 items",
      "$.tags[1]: expected string, got integer",
    ].sort());
    expect(validateSchema({}, schema)).toEqual(["$.name: required", "$.price: required", "$.sku: required"]);
    expect(validateSchema("x", schema)).toEqual(["$: expected object, got string"]);
    expect(validateSchema(1.5, { type: "integer" })).toEqual(["$: expected integer, got number"]);
  });

  test("anyOf, oneOf, allOf and const", () => {
    expect(validateSchema("a", { anyOf: [{ type: "number" }, { type: "string" }] })).toEqual([]);
    expect(validateSchema(true, { anyOf: [{ type: "number" }, { type: "string" }] })).toHaveLength(1);
    expect(validateSchema(5, { oneOf: [{ type: "number" }, { type: "integer" }] })).toEqual(["$: must match exactly one of the oneOf schemas"]);
    expect(validateSchema(5, { allOf: [{ minimum: 1 }, { maximum: 3 }] })).toEqual(["$: above 3"]);
    expect(validateSchema("x", { const: "y" })).toEqual(["$: must equal \"y\""]);
  });
});

describe("prompt history", () => {
  const step = (index: number, withImage: boolean): HistoryStep => ({
    assistant: { role: "assistant", text: "", toolCalls: [{ id: `c${index}`, name: "click", arguments: { ref: `e${index}` } }] },
    followUp: { role: "tool", results: [{ toolCallId: `c${index}`, name: "click", content: [{ type: "text", text: `obs ${index}` }, ...(withImage ? [{ type: "image" as const, mediaType: "image/jpeg" as const, data: `img${index}` }] : [])] }] },
    summary: `${index}. click e${index}`,
  });
  const initial = [{ type: "text" as const, text: "initial page" }, { type: "image" as const, mediaType: "image/jpeg" as const, data: "img0" }];
  const images = (messages: ChatMessage[]) => JSON.stringify(messages).match(/img\d/g) ?? [];

  test("the first request carries the initial observation with its screenshot", () => {
    const messages = buildMessages("Task: x", initial, [], 3);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "Task: x" }, ...initial] }]);
  });

  test("keeps the last N steps in full, summarizes older ones, and only the newest screenshot", () => {
    const history = [1, 2, 3, 4, 5].map((index) => step(index, true));
    const messages = buildMessages("Task: x", initial, history, 2);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "Task: x" }, { type: "text", text: "Earlier steps (summarized):\n1. click e1\n2. click e2\n3. click e3" }] });
    expect(messages.slice(1).map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(images(messages)).toEqual(["img5"]);
    expect(JSON.stringify(messages)).not.toContain("initial page");
  });

  test("while step 1 is in the window, the initial observation stays (without its screenshot)", () => {
    const messages = buildMessages("Task: x", initial, [step(1, true), step(2, true)], 3);
    expect(JSON.stringify(messages[0])).toContain("initial page");
    expect(images(messages)).toEqual(["img2"]);
  });
});

describe("tools", () => {
  test("done takes the caller's result schema; upload exists only with an allowlist", () => {
    const schema = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
    const tools = taskTools({ resultSchema: schema, uploads: false });
    expect(tools.find((tool) => tool.name === "done")!.parameters).toMatchObject({ properties: { result: schema }, required: ["result", "summary"] });
    expect(tools.map((tool) => tool.name)).not.toContain("upload");
    expect(taskTools({ uploads: true }).map((tool) => tool.name)).toContain("upload");
    for (const tool of tools) expect(tool.parameters).toMatchObject({ type: "object" });
  });

  test("CAPTCHAs are left to the browser's guardian: no drag tool, wait while solving, report a failure", () => {
    const names = taskTools({ uploads: true }).map((tool) => tool.name);
    expect(names).not.toContain("drag");
    expect(names.indexOf("upload")).toBe(names.indexOf("scroll") - 1);
    expect(taskTools({ uploads: false }).find((tool) => tool.name === "wait")!.description).toContain("Returns early when a CAPTCHA being solved ends solved or failed");
    expect(SYSTEM_PROMPT).not.toContain("CAPTCHA solution");
    expect(SYSTEM_PROMPT).toContain("While it reads solving, call wait");
    expect(SYSTEM_PROMPT).toContain("On failed, call fail and report the CAPTCHA failure");
  });
});

describe("keys", () => {
  test("named keys, characters and chords", () => {
    expect(parseChord("Enter")).toEqual({ modifiers: 0, modifierKeys: [], key: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" } });
    expect(parseChord("Esc").key.key).toBe("Escape");
    expect(parseChord("a").key).toEqual({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    const selectAll = parseChord("Control+a");
    expect(selectAll.modifiers).toBe(2);
    expect(selectAll.key.text).toBeUndefined();
    expect(parseChord("Shift+a").key).toMatchObject({ key: "A", text: "A" });
    expect(parseChord("Ctrl+Shift+Tab").modifiers).toBe(10);
    expect(parseChord("+").key.text).toBe("+");
    expect(() => parseChord("Hyper+a")).toThrow("unknown modifier");
    expect(() => parseChord("Launch")).toThrow("unknown key");
  });
});

describe("cli helpers", () => {
  test("timeouts", () => {
    expect(parseTimeout(undefined)).toBe(600_000);
    expect(parseTimeout("90")).toBe(90_000);
    expect(parseTimeout("2m")).toBe(120_000);
    expect(parseTimeout("1h")).toBe(3_600_000);
    expect(() => parseTimeout("5h")).toThrow("between");
    expect(() => parseTimeout("soon")).toThrow("invalid --timeout");
  });

  test("page functions serialize as function expressions", () => {
    const shorthand = { probe(this: Element) { return 1; } }.probe;
    expect(functionSource(shorthand)).toStartWith("function probe(");
    expect(functionSource(function (this: Element) { return 1; })).toStartWith("function");
    expect(functionSource(function named() { return 1; })).toStartWith("function named");
    expect(functionSource(() => 1)).toStartWith("()");
    expect(functionSource(async () => 1)).toStartWith("async");
  });
});
