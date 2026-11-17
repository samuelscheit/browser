import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const roots = ["apps", "workers", "deploy"];
const dockerfiles: string[] = [];

async function collect(directory: string): Promise<void> {
  const absolute = join(root, directory);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) await collect(child);
    else if (entry.isFile() && entry.name.endsWith("Dockerfile")) dockerfiles.push(child);
  }
}

for (const directory of roots) await collect(directory);
if (dockerfiles.length === 0) throw new Error("no Fabric Dockerfiles were found");

const basePattern = /^\s*FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+[^\s]+)?\s*$/gim;
const digestPattern = /@sha256:[a-f0-9]{64}$/i;
let fromCount = 0;

for (const file of dockerfiles.sort()) {
  const text = await readFile(join(root, file), "utf8");
  const bases = [...text.matchAll(basePattern)].map((match) => match[1]!);
  if (bases.length === 0) throw new Error(`${file} contains no FROM instruction`);
  for (const base of bases) {
    fromCount += 1;
    if (!digestPattern.test(base)) throw new Error(`${file} has a mutable Docker base image: ${base}`);
    if (base.includes(":latest")) throw new Error(`${file} has a latest Docker base image: ${base}`);
  }
  if (file === "workers/chrome/Dockerfile") {
    if (!/\bxvfb\b/.test(text) || !/\bxauth\b/.test(text) || !/\bchromium-sandbox\b/.test(text) || !text.includes("deploy/compose/chromium-launch.sh")) {
      throw new Error("managed Chromium image must include the private Xvfb, Chromium sandbox, and reviewed launcher runtimes for interactive leases");
    }
    if (/\bsocat\b/.test(text)) throw new Error("managed Chromium image must use the reviewed Fabric CDP bridge, not a generic socket forwarder");
    // The browser is the security boundary: both architectures install an exact, verifiable build.
    if (!/^ARG CHROME_VERSION=\d+\.\d+\.\d+\.\d+-\d+$/m.test(text) || !/^ARG CHROME_SHA256=[a-f0-9]{64}$/m.test(text) || !text.includes('sha256sum -c -')) {
      throw new Error("the amd64 browser must be an exact Google Chrome build verified by SHA-256");
    }
    if (!/^ARG CHROMIUM_VERSION=\S+$/m.test(text) || !/"chromium=\$\{CHROMIUM_VERSION\}"/.test(text)) {
      throw new Error("the arm64 browser must be an exact Debian Chromium version");
    }
    if (!/^ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m.test(text) || !text.includes("snapshot.debian.org/archive/")) {
      throw new Error("the browser image must resolve packages from one dated Debian snapshot");
    }
  }
}

const privateCdpBridge = await readFile(join(root, "apps/cdp-private-bridge/src/index.ts"), "utf8");
for (const required of ["127.0.0.1", 'headers: { host: "localhost" }', "server.listen(normalized.listenPort, normalized.bindAddress)"]) {
  if (!privateCdpBridge.includes(required)) throw new Error("private CDP bridge must keep Chromium loopback-only and bind only its reviewed private address");
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { packageManager?: unknown };
if (packageJson.packageManager !== "bun@1.4.0") throw new Error("packageManager must match the verified Bun Docker base (bun@1.4.0)");
const dockerIgnore = await readFile(join(root, ".dockerignore"), "utf8");
for (const expected of [".git", ".env", ".env.*", "node_modules", "**/node_modules", "deploy/compose/secrets"]) {
  if (!dockerIgnore.split(/\r?\n/).includes(expected)) throw new Error(`.dockerignore must exclude ${expected}`);
}

console.log(`Dockerfile validation passed (${dockerfiles.length} Dockerfiles, ${fromCount} digest-pinned bases)`);
