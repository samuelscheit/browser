import { describe, expect, test } from "bun:test";
import type { BrowserProcessSpec, Executor } from "../apps/worker-manager/src";
import { DockerContainerExecutor, type DockerCommand } from "../apps/worker-manager/src/docker-container-executor";
import { LeasedBrowserProvisioner } from "../apps/worker-manager/src/leased-browser-provisioner";
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

async function claimedSocialAssignment() {
  const context = await bootstrapTestScheduler();
  const profile = await context.scheduler.createProfile({
    ...context.profile,
    ref: "profile_social_managed" as never,
    profileFamily: "social",
    volumeName: "profile-volume",
  }, TEST_PRINCIPAL);
  const job = await context.scheduler.createJob({
    project: TEST_PROJECT,
    idempotencyKey: `managed-social-${crypto.randomUUID()}`,
    recipeRef: "recipe_social-insights@1" as never,
    operation: { operation: "collect_insights", username: "creator" },
    profileRef: profile.ref,
    egressPolicyRef: "egress_social-proxy-fallback@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
  }, TEST_PRINCIPAL);
  const [allocated] = await context.scheduler.dispatch();
  const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
  const assignment = await context.scheduler.claimAssignment(context.worker.id, allocated!.lease!.id, undefined, actor);
  return { ...context, actor, assignment, job };
}

describe("managed browser guardians", () => {
  test("does not report a Docker browser ready until its guardian is running, and guardian loss fails liveness", async () => {
    const { worker, assignment } = await claimedSocialAssignment();
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
      requireImmutableImages: false,
      browserSeccompProfile: "/etc/compose/browser-fabric-seccomp/chromium-userns.json",
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
    expect(command.calls[0]).toContain("seccomp=/etc/compose/browser-fabric-seccomp/chromium-userns.json");
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
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes(started.processId))).toBe(true);
  });

  test("removes a newly created container when its mandatory guardian cannot start", async () => {
    const { worker, assignment } = await claimedSocialAssignment();
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
      requireImmutableImages: false,
    });

    await expect(executor.start(buildBrowserProcessSpec(worker, assignment))).rejects.toThrow("guardian CDP connection failed");

    const create = command.calls.find((args) => args[0] === "container" && args[1] === "create")!;
    const containerName = create[create.indexOf("--name") + 1]!;
    expect(command.calls.some((args) => args[0] === "container" && args[1] === "rm" && args.includes(containerName))).toBe(true);
  });

  test("fails closed rather than resolving browser CDP through an invalid worker-network address", async () => {
    const { worker, assignment } = await claimedSocialAssignment();
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

test("the Social worker receives one manager-owned Chromium endpoint and reconciliation stops it when the guardian/browser dies", async () => {
  const { scheduler, worker, actor, assignment, job } = await claimedSocialAssignment();
  let starts = 0;
  let running = true;
  const stopped: string[] = [];
  const executor: Executor = {
    start: async (spec: BrowserProcessSpec) => {
      starts += 1;
      expect(spec.assignment.recipe.runtime).toBe("playwright-social");
      expect(spec.container.command.slice(0, 2)).toEqual(["/usr/local/bin/fabric-chromium-launch", "/usr/bin/chromium"]);
      expect(spec.container.turnstileGuardian?.enabled).toBe(true);
      return { processId: "fabric-browser-social", cdpBrowserEndpoint: "http://fabric-browser-social:9223" };
    },
    stop: async (processId) => { stopped.push(processId); },
    isRunning: () => running,
  };
  const endpointResolutions: string[] = [];
  const provisioner = new LeasedBrowserProvisioner({
    scheduler,
    executor,
    resolveBrowserEndpoint: async (endpoint) => {
      endpointResolutions.push(endpoint);
      return "ws://fabric-browser-social:9223/devtools/browser/opaque";
    },
  });

  const first = await provisioner.start(worker.id, assignment.lease!.id, actor);
  const second = await provisioner.start(worker.id, assignment.lease!.id, actor);

  expect(first).toEqual(second);
  expect(first.cdpBrowserEndpoint).toBe("ws://fabric-browser-social:9223/devtools/browser/opaque");
  expect(endpointResolutions).toEqual(["http://fabric-browser-social:9223"]);
  expect(starts).toBe(1);
  expect((await scheduler.store.snapshot()).leases.get(assignment.lease!.id)?.startedAt).toBeDefined();

  running = false;
  await provisioner.reconcile();

  expect(stopped).toEqual(["fabric-browser-social"]);
  expect(provisioner.active()).toEqual([]);
  expect((await scheduler.getJob(job.id, TEST_PRINCIPAL)).status).toBe("queued");
});

test("only the claimed Social worker with its enrollment proof can provision or release its managed browser", async () => {
  const { scheduler } = createTestScheduler();
  await scheduler.bootstrap({ projects: [{ id: TEST_PROJECT, name: "Test" }], principals: [TEST_PRINCIPAL] });
  const enrollment = "social-provisioner-enrollment-token-at-least-24-bytes";
  const worker = makeWorker({
    id: "worker_social_provisioner" as never,
    enrollmentTokenHash: workerEnrollmentTokenHash(enrollment),
    capabilities: {
      ...makeWorker().capabilities,
      runtimeFamilies: ["playwright-social"],
      recipeRefs: ["recipe_social-insights@1" as never],
      supportedProfileFamilies: ["social"],
    },
  });
  await scheduler.registerWorker(worker, TEST_PRINCIPAL);
  const profile = await scheduler.createProfile(makeProfile(worker, {
    ref: "profile_social_route" as never,
    profileFamily: "social",
    volumeName: "profile-volume",
  }), TEST_PRINCIPAL);
  const job = await scheduler.createJob({
    project: TEST_PROJECT,
    idempotencyKey: "social-provisioner-route",
    recipeRef: "recipe_social-insights@1" as never,
    operation: { operation: "collect_insights", username: "creator" },
    profileRef: profile.ref,
    egressPolicyRef: "egress_social-proxy-fallback@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
  }, TEST_PRINCIPAL);
  const [allocated] = await scheduler.dispatch();
  const workerActor = { ...TEST_PRINCIPAL, certificateFingerprint: worker.certificateFingerprint };
  const claimed = await scheduler.claimAssignment(worker.id, allocated!.lease!.id, undefined, workerActor);
  let starts = 0;
  const executor: Executor = {
    start: async () => {
      starts += 1;
      return { processId: "fabric-browser-route", cdpBrowserEndpoint: "ws://fabric-browser-route:9223/devtools/browser/opaque" };
    },
    stop: async () => undefined,
  };
  const provisioner = new LeasedBrowserProvisioner({ scheduler, executor });
  const fetchManager = createWorkerManagerFetch({ scheduler, assignmentSigner: AssignmentSigner.generate(), leasedBrowsers: provisioner });
  const baseHeaders = {
    "x-fabric-mtls-verified": "true",
    "x-fabric-worker-cert-fingerprint": worker.certificateFingerprint,
  };
  const browserPath = `https://manager/v1/workers/${worker.id}/leases/${claimed.lease!.id}/browser`;

  const denied = await fetchManager(new Request(browserPath, { method: "POST", headers: baseHeaders }));
  expect(denied.status).toBe(401);
  expect(starts).toBe(0);

  const created = await fetchManager(new Request(browserPath, {
    method: "POST",
    headers: { ...baseHeaders, "x-fabric-worker-enrollment": enrollment },
  }));
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ processId: "fabric-browser-route", cdpBrowserEndpoint: "ws://fabric-browser-route:9223/devtools/browser/opaque" });
  expect(starts).toBe(1);

  const released = await fetchManager(new Request(browserPath, {
    method: "DELETE",
    headers: { ...baseHeaders, "x-fabric-worker-enrollment": enrollment },
  }));
  expect(released.status).toBe(204);
  expect((await scheduler.getJob(job.id, TEST_PRINCIPAL)).status).toBe("running");
});

test("Social jobs cannot fall back to an anonymous disposable browser profile", async () => {
  const { scheduler } = await claimedSocialAssignment();
  await expect(scheduler.createJob({
    project: TEST_PROJECT,
    idempotencyKey: "social-profile-required",
    recipeRef: "recipe_social-insights@1" as never,
    operation: { operation: "collect_insights", username: "creator" },
    egressPolicyRef: "egress_social-proxy-fallback@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
  }, TEST_PRINCIPAL)).rejects.toThrow("persistent Chromium profile");
});

test("a restarted manager fails an untracked Social browser lease instead of running without a guardian", async () => {
  const { scheduler, worker, actor, assignment, job } = await claimedSocialAssignment();
  await scheduler.markLeaseStarted(assignment.lease!.id, worker.id, actor);
  const executor: Executor = {
    start: async () => ({ processId: "unused", cdpBrowserEndpoint: "ws://unused:9222/devtools/browser/unused" }),
    stop: async () => undefined,
  };
  // A newly constructed provisioner has no process-local guardian handle for this already-started
  // lease, exactly as after a worker-manager restart.
  const restarted = new LeasedBrowserProvisioner({ scheduler, executor });

  await restarted.failUntrackedLeases();

  expect(restarted.active()).toEqual([]);
  expect((await scheduler.getJob(job.id, TEST_PRINCIPAL)).status).toBe("queued");
  expect((await scheduler.store.snapshot()).leases.get(assignment.lease!.id)?.status).toBe("released");
});

test("a restarted manager also fails an untracked generic CDP lease", async () => {
  const context = await bootstrapTestScheduler();
  const session = await context.scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: "untracked-generic-browser",
    runtime: "rebrowser-puppeteer",
    browserRecipeRef: "recipe_rebrowser-reporting@1" as never,
    profileRef: context.profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct-egress@1" as never,
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
    browserRecipeRef: "recipe_rebrowser-reporting@1" as never,
    profileRef: context.profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct-egress@1" as never,
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

test("an in-flight Social browser provision is not mistaken for an unguarded orphan, and shutdown waits to stop it", async () => {
  const { scheduler, worker, actor, assignment } = await claimedSocialAssignment();
  let releaseStart!: () => void;
  let enteredStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
  const stopped: string[] = [];
  const executor: Executor = {
    start: async () => {
      enteredStart();
      await startGate;
      return { processId: "fabric-browser-in-flight", cdpBrowserEndpoint: "ws://fabric-browser-in-flight:9223/devtools/browser/opaque" };
    },
    stop: async (processId) => { stopped.push(processId); },
  };
  const provisioner = new LeasedBrowserProvisioner({ scheduler, executor });
  const provisioning = provisioner.start(worker.id, assignment.lease!.id, actor);
  await entered;

  await provisioner.reconcile();
  expect((await scheduler.store.snapshot()).leases.get(assignment.lease!.id)?.status).toBe("active");

  const shutdown = provisioner.stopAll();
  releaseStart();
  await provisioning;
  await shutdown;

  expect(stopped).toEqual(["fabric-browser-in-flight"]);
  expect(provisioner.active()).toEqual([]);
});
