import { describe, expect, test } from "bun:test";
import type { BrowserProcessSpec, Executor } from "../apps/worker-manager/src";
import { DockerContainerExecutor, type DockerCommand } from "../apps/worker-manager/src/docker-container-executor";
import { buildBrowserProcessSpec } from "../apps/worker-manager/src";
import { createWorkerManagerFetch } from "../apps/worker-manager/src/server";
import { ManagedWorkerController } from "../apps/worker-manager/src/controller";
import type { TurnstileGuardianFactory, TurnstileGuardianHandle, TurnstileGuardianSnapshot } from "@browser-fabric/worker-runtime";
import { AssignmentSigner, workerEnrollmentTokenHash } from "@browser-fabric/control-plane";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, createTestScheduler, makeProfile, makeWorker } from "@browser-fabric/testkit";

class RecordingDockerCommand implements DockerCommand {
  public readonly calls: string[][] = [];

  public async run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push([...args]);
    if (args[0] === "container" && args[1] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
      return { exitCode: 0, stdout: "{\"browser-fabric-workers\":{\"IPAddress\":\"172.30.0.44\"}}\n", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") return { exitCode: 0, stdout: "true\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeGuardian implements TurnstileGuardianHandle {
  public starts = 0;
  public stops = 0;
  public running = true;

  public get snapshot(): TurnstileGuardianSnapshot {
    return { running: this.running, attachedPages: 0, checks: 0, clickAttempts: 0 };
  }

  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<void> { this.stops += 1; this.running = false; }
}

async function claimedBrowserAssignment() {
  const context = await bootstrapTestScheduler();
  const session = await context.scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: `managed-browser-${crypto.randomUUID()}`,
    runtime: "chromium-cdp",
    browserRecipeRef: "recipe_chromium-cdp@1" as never,
    profileRef: context.profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, TEST_PRINCIPAL);
  const [allocated] = await context.scheduler.dispatch();
  const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
  const assignment = await context.scheduler.claimAssignment(context.worker.id, allocated!.lease!.id, undefined, actor);
  return { ...context, actor, assignment, session };
}

describe("managed browser guardians", () => {
  test("does not report a Docker browser ready until its guardian is running, and guardian loss fails liveness", async () => {
    const { worker, assignment } = await claimedBrowserAssignment();
    const command = new RecordingDockerCommand();
    const guardian = new FakeGuardian();
    const factoryInputs: Array<{ endpoint: string; enabled: boolean }> = [];
    const guardianFactory: TurnstileGuardianFactory = ({ endpoint, spec }) => {
      factoryInputs.push({ endpoint, enabled: spec.enabled });
      return guardian;
    };
    const executor = new DockerContainerExecutor({
      command,
      fetch: async (input) => {
        expect(String(input)).toBe("http://172.30.0.44:9223/json/version");
        return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/managed" }));
      },
      turnstileGuardianFactory: guardianFactory,
      closeBrowser: async (endpoint) => { command.calls.push(["cdp", "Browser.close", endpoint]); return true; },
      requireImmutableImages: false,
      browserSeccompProfile: "/etc/browser-fabric/chromium-userns-seccomp.json",
      requireBrowserSeccompProfile: true,
    });
    const spec = buildBrowserProcessSpec(worker, assignment);

    const started = await executor.start(spec);

    expect(guardian.starts).toBe(1);
    expect(started.cdpBrowserEndpoint).toBeDefined();
    expect(started.cdpBrowserEndpoint).toContain(":9223");
    expect(factoryInputs).toEqual([{ endpoint: started.cdpBrowserEndpoint!, enabled: true }]);
    expect(command.calls[0]?.slice(0, 2)).toEqual(["container", "create"]);
    expect(command.calls[0]).toContain("--network");
    expect(command.calls[0]).toContain("browser-fabric-workers");
    expect(command.calls[0]).not.toContain("--publish");
    expect(command.calls[0]).toContain("--cap-drop");
    expect(command.calls[0]).toContain("--security-opt");
    expect(command.calls[0]).toContain("seccomp=/etc/browser-fabric/chromium-userns-seccomp.json");
    expect(command.calls[0]).toContain("/tmp:rw,noexec,nosuid,nodev,size=1073741824,mode=1777");
    expect(command.calls[0]).toContain("/tmp/.X11-unix:rw,nosuid,nodev,size=1048576,mode=1777");
    expect(command.calls[0]).toContain("--remote-debugging-address=127.0.0.1");
    expect(command.calls[0]).toContain("--remote-debugging-port=9222");
    expect(command.calls[0]?.find((argument) => argument.includes("destination=/fabric/profile"))).toContain("destination=/fabric/profile");
    expect(command.calls[0]?.some((argument) => argument.includes("destination=/fabric/profile,rw"))).toBe(false);
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}"))).toBe(true);
    expect(await executor.isRunning(started.processId)).toBe(true);

    guardian.running = false;
    expect(await executor.isRunning(started.processId)).toBe(false);

    await executor.stop(started.processId);
    expect(guardian.stops).toBe(1);
    // Chromium closes through CDP (flushing cookies to the profile) before Docker signals it.
    const closeIndex = command.calls.findIndex((args) => args[0] === "cdp");
    const stopIndex = command.calls.findIndex((args) => args[0] === "container" && args[1] === "stop" && args.includes(started.processId));
    expect(command.calls[closeIndex]).toEqual(["cdp", "Browser.close", started.cdpBrowserEndpoint!]);
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(stopIndex);
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes(started.processId))).toBe(true);
    // A second stop does not close the (already gone) browser again.
    await executor.stop(started.processId);
    expect(command.calls.filter((args) => args[0] === "cdp")).toHaveLength(1);
  });

  test("re-owns a cloned profile for the unprivileged browser after copying from a root-owned source", async () => {
    const { worker, assignment } = await claimedBrowserAssignment();
    const command = new RecordingDockerCommand();
    const originalRun = command.run.bind(command);
    command.run = async (args) => {
      if (args[0] === "volume" && args[1] === "inspect") {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "true|true\n", stderr: "" };
      }
      // Volume helpers are polled until they report a clean exit.
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.State.Status}}|{{.State.ExitCode}}")) {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "exited|0\n", stderr: "" };
      }
      return originalRun(args);
    };
    const executor = new DockerContainerExecutor({
      command,
      fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/managed" })),
      turnstileGuardianFactory: () => new FakeGuardian(),
      requireImmutableImages: false,
    });
    const cloned = {
      ...assignment,
      clone: { id: "clone_test", sourceProfileRef: assignment.profile!.ref, workerId: worker.id, volumeName: "profile-clone-test", createdForLease: assignment.lease!.id, status: "creating", createdAt: new Date().toISOString() },
    } as typeof assignment;

    await executor.start(buildBrowserProcessSpec(worker, cloned));

    const helperScripts = command.calls
      .filter((args) => args[0] === "container" && args[1] === "create" && args.includes("--cap-add"))
      .map((args) => ({ kind: args.find((arg) => arg.startsWith("com.browser-fabric.kind="))!, script: args.at(-1)! }));
    const copy = helperScripts.find(({ kind }) => kind.endsWith("profile-clone"))!;
    // cp -a preserves the source's (root) ownership, so the copy must end by re-owning to the browser user.
    expect(copy.script).toMatch(/cp -a \/source\/\. \/destination\/; chown -R 10001:10001 \/destination$/);
    expect(helperScripts.find(({ kind }) => kind.endsWith("profile-initialize"))!.script).toContain("chown -R 10001:10001 /volume");
  });

  test("removes a newly created container when its mandatory guardian cannot start", async () => {
    const { worker, assignment } = await claimedBrowserAssignment();
    const command = new RecordingDockerCommand();
    const guardianFactory: TurnstileGuardianFactory = () => ({
      snapshot: { running: false, attachedPages: 0, checks: 0, clickAttempts: 0 },
      start: async () => { throw new Error("guardian CDP connection failed"); },
      stop: async () => undefined,
    });
    const executor = new DockerContainerExecutor({
      command,
      fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/managed" })),
      turnstileGuardianFactory: guardianFactory,
      // An unreachable browser cannot close itself; Docker removal still follows.
      closeBrowser: async () => false,
      requireImmutableImages: false,
    });

    await expect(executor.start(buildBrowserProcessSpec(worker, assignment))).rejects.toThrow("guardian CDP connection failed");

    const create = command.calls.find((args) => args[0] === "container" && args[1] === "create")!;
    const containerName = create[create.indexOf("--name") + 1]!;
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes(containerName))).toBe(true);
  });

  test("fails closed rather than resolving browser CDP through an invalid worker-network address", async () => {
    const { worker, assignment } = await claimedBrowserAssignment();
    const command = new RecordingDockerCommand();
    const originalRun = command.run.bind(command);
    command.run = async (args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "{\"browser-fabric-workers\":{\"IPAddress\":\"127.0.0.1\"}}\n", stderr: "" };
      }
      return originalRun(args);
    };
    const executor = new DockerContainerExecutor({
      command,
      fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/managed" })),
      requireImmutableImages: false,
    });

    await expect(executor.start(buildBrowserProcessSpec(worker, assignment))).rejects.toThrow("browser has no valid private worker-network address");

    const created = command.calls.find((args) => args[0] === "container" && args[1] === "create")!;
    const containerName = created[created.indexOf("--name") + 1]!;
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes(containerName))).toBe(true);
  });

  test("fails closed when production browser sandbox configuration is missing or unapproved", async () => {
    expect(() => new DockerContainerExecutor({
      command: new RecordingDockerCommand(),
      requireBrowserSeccompProfile: true,
    })).toThrow("seccomp profile is required");
    expect(() => new DockerContainerExecutor({
      command: new RecordingDockerCommand(),
      browserSeccompProfile: "/tmp/attacker.json",
    })).toThrow("seccomp profile path is not approved");
  });

  test("removes browser containers left by a manager process that did not own their guardian", async () => {
    const command = new RecordingDockerCommand();
    const originalRun = command.run.bind(command);
    command.run = async (args) => {
      if (args[0] === "container" && args[1] === "ls") {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "fabric-browser-old-lease\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{ index .Config.Labels \"com.browser-fabric.worker-id\" }}|{{ index .Config.Labels \"com.browser-fabric.temporary-volumes\" }}")) {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "worker_test|temporary-profile\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.State.Status}}|{{.State.ExitCode}}")) {
        command.calls.push([...args]);
        return { exitCode: 0, stdout: "exited|0\n", stderr: "" };
      }
      return originalRun(args);
    };
    const executor = new DockerContainerExecutor({ command, requireImmutableImages: false });

    await expect(executor.stopUntrackedBrowserContainers()).resolves.toEqual(["fabric-browser-old-lease"]);

    expect(command.calls[0]).toEqual(["container", "ls", "--all", "--filter", "label=com.browser-fabric.lease-id", "--format", "{{.Names}}"]);
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes("fabric-browser-old-lease"))).toBe(true);
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "inspect")).toBe(true);
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "create" && args.some((arg) => arg.includes("temporary-profile")))).toBe(true);
  });
});

test("a restarted manager also fails an untracked generic CDP lease", async () => {
  const context = await bootstrapTestScheduler();
  const session = await context.scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: "untracked-generic-browser",
    runtime: "rebrowser-puppeteer",
    browserRecipeRef: "recipe_rebrowser-puppeteer@1" as never,
    profileRef: context.profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, TEST_PRINCIPAL);
  const [assignment] = await context.scheduler.dispatch();
  const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
  await context.scheduler.claimAssignment(context.worker.id, assignment!.lease!.id, undefined, actor);
  await context.scheduler.markLeaseStarted(assignment!.lease!.id, context.worker.id, actor);
  const controller = new ManagedWorkerController({
    scheduler: context.scheduler,
    browserExecutor: { start: async () => ({ processId: "unused" }), stop: async () => undefined },
  });

  await expect(controller.failUntrackedBrowserLeases()).resolves.toBe(1);

  expect((await context.scheduler.getSession(session.id, TEST_PRINCIPAL)).status).toBe("failed");
  expect((await context.scheduler.store.snapshot()).leases.get(assignment!.lease!.id)?.status).toBe("released");
});

test("a restarted manager releases a claimed generic lease that never reached browser readiness", async () => {
  const context = await bootstrapTestScheduler();
  const session = await context.scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: "untracked-generic-startup",
    runtime: "rebrowser-puppeteer",
    browserRecipeRef: "recipe_rebrowser-puppeteer@1" as never,
    profileRef: context.profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, TEST_PRINCIPAL);
  const [assignment] = await context.scheduler.dispatch();
  const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
  await context.scheduler.claimAssignment(context.worker.id, assignment!.lease!.id, undefined, actor);
  const controller = new ManagedWorkerController({
    scheduler: context.scheduler,
    browserExecutor: { start: async () => ({ processId: "unused" }), stop: async () => undefined },
  });

  await expect(controller.failUntrackedBrowserLeases()).resolves.toBe(1);

  expect((await context.scheduler.getSession(session.id, TEST_PRINCIPAL)).status).toBe("failed");
  expect((await context.scheduler.store.snapshot()).leases.get(assignment!.lease!.id)?.status).toBe("released");
});
