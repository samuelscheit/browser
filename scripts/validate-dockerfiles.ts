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
  if (file === "workers/playwright-social/Dockerfile") {
    if (!text.includes("requirements.lock") || !text.includes("pip install --no-cache-dir -r requirements.lock")) {
      throw new Error("native Social image must install the resolved requirements.lock");
    }
    if (/\bplaywright\s+install\b|\bwebkit\b/i.test(text)) {
      throw new Error("Social image must be a Chromium CDP client and must not install a browser engine");
    }
  }
  if (file === "workers/chromium-cdp/Dockerfile") {
    if (!/\bxvfb\b/.test(text) || !/\bxauth\b/.test(text) || !/\bchromium-sandbox\b/.test(text) || !text.includes("deploy/compose/chromium-launch.sh")) {
      throw new Error("managed Chromium image must include the private Xvfb, Chromium sandbox, and reviewed launcher runtimes for interactive leases");
    }
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { packageManager?: unknown };
if (packageJson.packageManager !== "bun@1.4.0") throw new Error("packageManager must match the verified Bun Docker base (bun@1.4.0)");
const requirements = await readFile(join(root, "workers/playwright-social/requirements.txt"), "utf8");
if (requirements.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#") && !/^[A-Za-z0-9_.-]+==[^\s]+$/.test(line.trim()))) {
  throw new Error("workers/playwright-social/requirements.txt must contain exact dependency pins");
}
const socialServer = await readFile(join(root, "workers/playwright-social/src/server.py"), "utf8");
if (!socialServer.includes("ssl.create_default_context") || !socialServer.includes("trust_env=False")) {
  throw new Error("Social worker must use an explicit mTLS SSL context and bypass ambient proxy variables");
}
const dockerIgnore = await readFile(join(root, ".dockerignore"), "utf8");
for (const expected of [".git", ".env", ".env.*", "node_modules", "**/node_modules", "__pycache__"]) {
  if (!dockerIgnore.split(/\r?\n/).includes(expected)) throw new Error(`.dockerignore must exclude ${expected}`);
}

console.log(`Dockerfile validation passed (${dockerfiles.length} Dockerfiles, ${fromCount} digest-pinned bases)`);
