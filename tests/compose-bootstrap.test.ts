import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserScheduler, parseFabricCatalog } from "@browser-fabric/control-plane";
import { parseProvisionManifest, provisionManifest } from "../apps/worker-manager/src/provision-fabric";
import { parseWorkerRegistration } from "../apps/worker-manager/src/protocol";

const script = new URL("../deploy/compose/bootstrap-secrets.sh", import.meta.url).pathname;
const available = Bun.which("openssl") !== null && Bun.which("jq") !== null;

async function bootstrap(secretsDir: string, catalogPath: string, principals = "admin"): Promise<void> {
  const run = Bun.spawn(["bash", script], {
    env: { ...process.env, FABRIC_SECRETS_DIR: secretsDir, FABRIC_CATALOG_PATH: catalogPath, FABRIC_PRINCIPALS: principals },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  if (code !== 0) throw new Error(`bootstrap-secrets.sh failed: ${stderr}`);
}

describe.skipIf(!available)("deploy/compose bootstrap-secrets.sh", () => {
  test("generates a provisionable manifest whose workers match the configs their agents load, and reruns without rotating identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fabric-compose-"));
    const secrets = join(directory, "secrets");
    const catalogPath = join(directory, "catalog.json");
    const catalogDocument = await Bun.file(new URL("../deploy/compose/catalog.example.json", import.meta.url)).json();
    await writeFile(catalogPath, JSON.stringify(catalogDocument));

    await bootstrap(secrets, catalogPath, "admin ci");
    const manifest = parseProvisionManifest(JSON.parse(await readFile(join(secrets, "fabric_provision_manifest"), "utf8")));
    expect(manifest.bootstrapAdminId).toBe("principal_admin" as never);
    expect(manifest.principals.map((principal) => [principal.id, principal.roles])).toEqual([
      ["principal_admin", ["fabric_admin", "project_admin"]],
      ["principal_ci", ["project_operator"]],
    ] as never);
    expect(manifest.workers.map((worker) => worker.id)).toEqual(["worker_chrome"] as never);
    // The catalog's interactive Chrome recipe joins the built-ins on the one Chrome worker.
    expect([...manifest.workers[0]!.capabilities.recipeRefs].sort()).toEqual(["recipe_chrome-de@1", "recipe_chrome-headless@1", "recipe_chrome@1"] as never);
    expect(manifest.profiles.map((profile) => [profile.ref, profile.workerId, profile.profileFamily])).toEqual([["profile_default", "worker_chrome", "default"]] as never);
    expect(JSON.stringify(manifest)).not.toMatch(/PRIVATE KEY/);

    // Every agent's generated config must register as exactly its provisioned worker.
    const runtime = { scheduler: new BrowserScheduler({ catalog: parseFabricCatalog(catalogDocument) }) };
    await runtime.scheduler.bootstrap();
    await provisionManifest(runtime, manifest);
    for (const [name, worker] of [["chrome", "worker_chrome"]] as const) {
      const config = JSON.parse(await readFile(join(secrets, "workers", `${name}.json`), "utf8"));
      const enrollment = (await readFile(join(secrets, `${name}_worker_enrollment`), "utf8")).trim();
      const registration = parseWorkerRegistration(config, config.certificateFingerprint);
      expect(registration.id).toBe(worker as never);
      await expect(runtime.scheduler.refreshWorkerRegistration(registration, config.certificateFingerprint, enrollment)).resolves.toMatchObject({ id: worker, health: "healthy" });
    }

    // Principal passwords are one file per principal, the CA keys never sit next to mounted secrets.
    expect((await readdir(join(secrets, "principals"))).sort()).toEqual(["admin", "ci"]);
    expect((await readFile(join(secrets, "principals", "admin"), "utf8")).length).toBe(64);
    expect((await readdir(secrets)).some((file) => file.endsWith("ca.key"))).toBe(false);
    expect((await stat(join(secrets, ".ca"))).mode & 0o777).toBe(0o700);

    const before = await readFile(join(secrets, "fabric_provision_manifest"), "utf8");
    const password = await readFile(join(secrets, "principals", "admin"), "utf8");
    await bootstrap(secrets, catalogPath, "admin ci");
    expect(await readFile(join(secrets, "fabric_provision_manifest"), "utf8")).toBe(before);
    expect(await readFile(join(secrets, "principals", "admin"), "utf8")).toBe(password);
    expect((await provisionManifest(runtime, parseProvisionManifest(JSON.parse(before)))).workersToCreate).toEqual([]);
  }, 180_000);

  test("refuses a principal list without the admin and an invalid principal name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fabric-compose-"));
    await expect(bootstrap(join(directory, "a"), join(directory, "catalog.json"), "ci")).rejects.toThrow(/must include the admin principal/);
    await expect(bootstrap(join(directory, "b"), join(directory, "catalog.json"), "admin bad/name")).rejects.toThrow(/principal name 'bad\/name' is invalid/);
  });
});
