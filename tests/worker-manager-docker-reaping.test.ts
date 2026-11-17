import { afterAll, describe, expect, test } from "bun:test";
import { ChildProcessDockerCommand, DockerContainerExecutor } from "../apps/worker-manager/src/docker-container-executor";

/**
 * Restart recovery against a real Docker daemon: two Fabric deployments share the host (an old
 * and a new stack side by side), and a manager reaps only its own leftover lease browsers.
 * Containers are only created, never started: `container ls --all` lists them all the same.
 */
const docker = new ChildProcessDockerCommand();
const available = await docker.run(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 }).then((result) => result.exitCode === 0, () => false);
// The volume helper image the Compose deployment pins.
const IMAGE = "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const run = crypto.randomUUID().slice(0, 8);
const mine = `reap-${run}-a`;
const theirs = `reap-${run}-b`;
const created: string[] = [];

async function container(name: string, labels: Record<string, string>): Promise<string> {
  const args = ["container", "create", "--name", name, "--label", "com.browser-fabric.managed=true", "--label", "com.browser-fabric.kind=browser"];
  for (const [key, value] of Object.entries(labels)) args.push("--label", `com.browser-fabric.${key}=${value}`);
  const result = await docker.run([...args, IMAGE, "true"], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`docker container create failed: ${result.stderr}`);
  created.push(name);
  return name;
}

async function existing(): Promise<string[]> {
  const listed = await docker.run(["container", "ls", "--all", "--filter", `name=fabric-browser-${run}`, "--format", "{{.Names}}"], { timeoutMs: 20_000 });
  return listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

afterAll(async () => {
  for (const name of created) await docker.run(["container", "rm", "--force", name], { timeoutMs: 20_000 });
});

describe.skipIf(!available)("worker-manager restart recovery on a shared Docker host", () => {
  test("reaps only its own deployment's lease browsers", async () => {
    const pulled = await docker.run(["image", "pull", "--quiet", IMAGE], { timeoutMs: 300_000 });
    if (pulled.exitCode !== 0) throw new Error(`docker image pull failed: ${pulled.stderr}`);
    const own = await container(`fabric-browser-${run}-own-lease`, { deployment: mine, "worker-id": "worker_a", "lease-id": "browser-lease_a1" });
    await container(`fabric-browser-${run}-other-lease`, { deployment: theirs, "worker-id": "worker_a", "lease-id": "browser-lease_b1" });
    // A browser created before deployments were labelled belongs to whichever stack made it: no one reaps it.
    await container(`fabric-browser-${run}-unlabelled-lease`, { "worker-id": "worker_a", "lease-id": "browser-lease_old" });
    // Not a lease browser (a job's): restart recovery is about leases only.
    await container(`fabric-browser-${run}-own-job`, { deployment: mine, "worker-id": "worker_a", "job-id": "job_a1" });

    const executor = new DockerContainerExecutor({ command: docker, deploymentId: mine, requireImmutableImages: false });
    expect(await executor.stopUntrackedBrowserContainers()).toEqual([own]);
    expect(await existing()).toEqual([
      `fabric-browser-${run}-other-lease`,
      `fabric-browser-${run}-own-job`,
      `fabric-browser-${run}-unlabelled-lease`,
    ]);

    // The other deployment's manager, restarting too, reaps its own and nothing else.
    const other = new DockerContainerExecutor({ command: docker, deploymentId: theirs, requireImmutableImages: false });
    expect(await other.stopUntrackedBrowserContainers()).toEqual([`fabric-browser-${run}-other-lease`]);
    expect(await existing()).toEqual([`fabric-browser-${run}-own-job`, `fabric-browser-${run}-unlabelled-lease`]);
  }, 360_000);
});
