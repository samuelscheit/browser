import { describe, expect, test } from "bun:test";
import { DockerContainerExecutor, type DockerCommand } from "../apps/worker-manager/src/docker-container-executor";
import { buildBrowserProcessSpec, captchaTokenSolverFor } from "../apps/worker-manager/src";
import type { TurnstileGuardianFactory, TurnstileGuardianHandle, TurnstileGuardianSnapshot, TokenCaptchaSolver } from "@browser-fabric/worker-runtime";
import { GenericBrowserRuntime } from "@browser-fabric/worker-runtime";
import { TEST_PRINCIPAL, TEST_PROJECT, bootstrapTestScheduler, makeProfile, makeWorker } from "@browser-fabric/testkit";
import type { ChallengeHandler } from "@browser-fabric/contracts";

class RecordingDockerCommand implements DockerCommand {
  public async run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (args[0] === "container" && args[1] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
      return { exitCode: 0, stdout: "{\"browser-fabric-workers\":{\"IPAddress\":\"172.30.0.44\"}}\n", stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") return { exitCode: 0, stdout: "true\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeGuardian implements TurnstileGuardianHandle {
  public running = true;
  public get snapshot(): TurnstileGuardianSnapshot { return { running: this.running, attachedPages: 0, checks: 0, clickAttempts: 0 }; }
  public async start(): Promise<void> { /* ready */ }
  public async stop(): Promise<void> { this.running = false; }
}

const dbcSolver: TokenCaptchaSolver = { solve: async () => `03AFcWeA${"x".repeat(56)}` };

/** Runs a real assignment through the executor and reports which solver, if any, its guardian received. */
async function guardianSolverFor(recipe: { ref: string; runtime: string; profileFamily: string }) {
  const context = await bootstrapTestScheduler();
  // Reuse the bootstrap worker's own volume so the profile is valid for its affine worker.
  const profile = await context.scheduler.createProfile(makeProfile(context.worker, {
    ref: `profile_${recipe.profileFamily}_wiring` as never,
    profileFamily: recipe.profileFamily,
  }), TEST_PRINCIPAL);
  await context.scheduler.createBrowserSession({
    project: TEST_PROJECT,
    idempotencyKey: `solver-wiring-${crypto.randomUUID()}`,
    runtime: recipe.runtime as never,
    browserRecipeRef: recipe.ref as never,
    profileRef: profile.ref,
    leaseMode: "writer",
    egressPolicyRef: "egress_direct-egress@1" as never,
    artifactPolicyRef: "artifact-policy_standard-30-days@1" as never,
    ttlSeconds: 600,
  }, TEST_PRINCIPAL);
  const [allocated] = await context.scheduler.dispatch();
  const actor = { ...TEST_PRINCIPAL, certificateFingerprint: context.worker.certificateFingerprint };
  const assignment = await context.scheduler.claimAssignment(context.worker.id, allocated!.lease!.id, undefined, actor);
  // The worker advertises the recipe's profile family, as a deployment's worker config does for its own recipes.
  const worker = makeWorker({
    id: context.worker.id,
    certificateFingerprint: context.worker.certificateFingerprint,
    capabilities: {
      ...context.worker.capabilities,
      supportedProfileFamilies: [...new Set([...context.worker.capabilities.supportedProfileFamilies, recipe.profileFamily])],
    },
  });

  const seen: Array<TokenCaptchaSolver | undefined> = [];
  const guardianFactory: TurnstileGuardianFactory = ({ tokenSolver }) => {
    seen.push(tokenSolver);
    return new FakeGuardian();
  };
  const selector = captchaTokenSolverFor({ providerProxyUrl: "http://fabric-egress-sidecar:11008", deathByCaptchaUsername: "u", deathByCaptchaPassword: "p" });
  const spec = buildBrowserProcessSpec(worker, assignment, [], new Map([[recipe.runtime, new GenericBrowserRuntime(recipe.runtime)]]));
  const executor = new DockerContainerExecutor({
    command: new RecordingDockerCommand(),
    fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/managed" })),
    turnstileGuardianFactory: guardianFactory,
    requireImmutableImages: false,
    browserSeccompProfile: "/etc/compose/browser-fabric-seccomp/chromium-userns.json",
    requireBrowserSeccompProfile: true,
    tokenSolverFor: selector,
  });
  await executor.start(spec);
  return { solver: seen[0], handlers: assignment.challengeHandlerSet?.handlers };
}

describe("token solver wiring from the signed recipe to the guardian", () => {
  test("a reporting recipe whose challenge set enables automatic DBC gets a solver in its guardian", async () => {
    const { solver, handlers } = await guardianSolverFor({ ref: "recipe_rebrowser-reporting@1", runtime: "rebrowser-puppeteer", profileFamily: "reporting-reporting" });
    expect(handlers?.some((handler: ChallengeHandler) => handler.kind === "dbc" && handler.mode === "automatic")).toBe(true);
    expect(solver).toBeDefined();
  });

  test("the signed assignment carries the challenge set the scheduler resolved from the recipe", async () => {
    const { handlers } = await guardianSolverFor({ ref: "recipe_rebrowser-reporting@1", runtime: "rebrowser-puppeteer", profileFamily: "reporting-reporting" });
    expect(handlers).toBeDefined();
    expect(handlers!.map((handler: ChallengeHandler) => handler.id)).toContain("death-by-captcha");
  });

  test("a provider with no credentials yields no solver even when the recipe enables it", () => {
    const select = captchaTokenSolverFor({ providerProxyUrl: "http://fabric-egress-sidecar:11008" });
    expect(select([{ id: "death-by-captcha", kind: "dbc", mode: "automatic", configuration: {} }])).toBeUndefined();
  });
});
