import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]+)\}\}/g;
/** Shorter values would redact ordinary words and digits all over the logs. */
const MIN_REDACTED_LENGTH = 3;

/**
 * Secrets the model may type without ever seeing them. The model writes `{{secret:NAME}}`; the
 * value is substituted only when the text is typed into the page, and every occurrence of a
 * value in what the model or the logs see is replaced with its placeholder again.
 */
export class Secrets {
  readonly #values: ReadonlyMap<string, string>;
  readonly #byLength: readonly [string, string][];

  public constructor(values: Readonly<Record<string, string>> = {}) {
    for (const name of Object.keys(values)) if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`secret name ${JSON.stringify(name)} must match [A-Za-z0-9_]+`);
    this.#values = new Map(Object.entries(values).filter(([, value]) => value.length > 0));
    // Longest first, so a secret containing another is redacted whole.
    this.#byLength = [...this.#values].filter(([, value]) => value.length >= MIN_REDACTED_LENGTH).sort((left, right) => right[1].length - left[1].length);
  }

  /** Secrets from `FABRIC_SECRET_<NAME>` environment variables, as `{{secret:NAME}}`. */
  public static fromEnvironment(env: Record<string, string | undefined> = process.env): Secrets {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (key.startsWith("FABRIC_SECRET_") && value) values[key.slice("FABRIC_SECRET_".length)] = value;
    return new Secrets(values);
  }

  public get names(): string[] {
    return [...this.#values.keys()];
  }

  public hasPlaceholder(text: string): boolean {
    return new RegExp(PLACEHOLDER.source).test(text);
  }

  /** Substitute placeholders; an unknown name is an error rather than literal text in a form. */
  public resolve(text: string): string {
    return text.replace(PLACEHOLDER, (_match, name: string) => {
      const value = this.#values.get(name);
      if (value === undefined) throw new Error(`unknown secret {{secret:${name}}}; available: ${this.names.map((known) => `{{secret:${known}}}`).join(", ") || "none"}`);
      return value;
    });
  }

  public redact(text: string): string {
    let redacted = text;
    for (const [name, value] of this.#byLength) redacted = redacted.split(value).join(`{{secret:${name}}}`);
    return redacted;
  }

  /** Redact every string inside a JSON-like value. */
  public redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactValue(item)])) as T;
    return value;
  }
}

/**
 * Files the agent may upload: regular files under one of the allowed directories, after
 * resolving symlinks (so a link inside the directory cannot point outside it).
 */
export class UploadPolicy {
  readonly #roots: string[];

  public constructor(directories: readonly string[] = []) {
    this.#roots = directories.map((directory) => {
      const real = realpathSync(resolve(directory));
      if (!statSync(real).isDirectory()) throw new Error(`upload directory ${directory} is not a directory`);
      return real;
    });
  }

  public get enabled(): boolean {
    return this.#roots.length > 0;
  }

  public get directories(): readonly string[] {
    return this.#roots;
  }

  /** The real path of an allowed file, or an error explaining the refusal. */
  public check(path: string): string {
    if (!this.enabled) throw new Error("file uploads are disabled (no upload directory is allowed)");
    // Relative paths are relative to the first allowed directory, never to the process cwd.
    const candidate = isAbsolute(path) ? path : resolve(this.#roots[0]!, path);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new Error(`upload file ${path} does not exist`);
    }
    const inside = this.#roots.some((root) => {
      const rel = relative(root, real);
      return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
    });
    if (!inside) throw new Error(`upload file ${path} is outside the allowed directories`);
    if (!statSync(real).isFile()) throw new Error(`upload path ${path} is not a regular file`);
    return real;
  }
}

export type JsonSchema = Record<string, unknown>;

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/**
 * Validate a value against the JSON Schema subset result schemas use: type (incl. unions), enum,
 * const, properties/required/additionalProperties, items, min/max(Length|Items), minimum/maximum,
 * pattern, anyOf/oneOf/allOf. Returns the problems found; empty means valid. Unknown keywords
 * are ignored rather than rejected.
 */
export function validateSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
  if (types && !types.some((type) => matchesType(value, type))) return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === "object") value.forEach((item, index) => errors.push(...validateSchema(item, schema.items as JsonSchema, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) if (!(key in record)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) errors.push(...validateSchema(item, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validateSchema(item, schema.additionalProperties as JsonSchema, `${path}.${key}`));
    }
  }
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf as JsonSchema[]) errors.push(...validateSchema(value, part, path));
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    const passing = (schema[keyword] as JsonSchema[]).filter((part) => validateSchema(value, part, path).length === 0).length;
    if (keyword === "anyOf" ? passing === 0 : passing !== 1) errors.push(`${path}: must match ${keyword === "anyOf" ? "at least one" : "exactly one"} of the ${keyword} schemas`);
  }
  return errors;
}
