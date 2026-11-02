import type { ChallengeHandler } from "@browser-fabric/contracts";
import { CaptchaSolverError, type CaptchaSolverProvider, type CaptchaTask, type TokenCaptchaSolver } from "./types";

const providerForHandler: Partial<Record<ChallengeHandler["kind"], CaptchaSolverProvider>> = {
  dbc: "death-by-captcha",
  anticaptcha: "anticaptcha",
};

/**
 * Token solving is opt-in per recipe. Only an automatic DBC/AntiCaptcha handler in the recipe's challenge
 * set enables it; manual and fallback handlers never do. Order is the recipe's order.
 */
export function automaticCaptchaSolverProviders(handlers: readonly ChallengeHandler[] | undefined): CaptchaSolverProvider[] {
  const providers: CaptchaSolverProvider[] = [];
  for (const handler of handlers ?? []) {
    const provider = handler.mode === "automatic" ? providerForHandler[handler.kind] : undefined;
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

/**
 * Tries the enabled providers in the recipe's order and returns the first token. A canceled solve belongs
 * to the caller, so it is never retried through another paid provider.
 */
export function createTokenSolver(
  providers: readonly CaptchaSolverProvider[],
  solvers: Readonly<Partial<Record<CaptchaSolverProvider, TokenCaptchaSolver>>>,
): TokenCaptchaSolver | undefined {
  const available = providers.flatMap((provider) => {
    const solver = solvers[provider];
    return solver ? [solver] : [];
  });
  if (available.length === 0) return undefined;
  return {
    async solve(task: CaptchaTask, signal?: AbortSignal): Promise<string> {
      let failure: unknown;
      for (const solver of available) {
        try {
          return await solver.solve(task, signal);
        } catch (error) {
          if (error instanceof CaptchaSolverError && error.kind === "canceled") throw error;
          failure = error;
        }
      }
      throw failure instanceof CaptchaSolverError ? failure : new CaptchaSolverError("unavailable", "no CAPTCHA provider produced a token");
    },
  };
}
