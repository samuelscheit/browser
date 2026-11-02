import { readFile } from "node:fs/promises";
import {
  createAntiCaptchaSolver,
  createDeathByCaptchaSolver,
  createTokenSolver,
  automaticCaptchaSolverProviders,
  proxiedSolverFetch,
  type CaptchaSolverProvider,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import type { ChallengeHandler } from "@browser-fabric/contracts";

/** Configuration the manager reads from Docker secret mounts. Values are never placed in a browser. */
export interface CaptchaSolverSecrets {
  /** Reviewed sidecar listener that admits only the solver provider hostnames. */
  providerProxyUrl: string;
  deathByCaptchaUsername?: string;
  deathByCaptchaPassword?: string;
  antiCaptchaClientKey?: string;
}

/**
 * Reads one optional secret. A missing file, an empty file, or a comment-only placeholder (the bootstrap's
 * "not-yet-provisioned" marker) means the provider is not configured, never a credential.
 */
export async function readOptionalSecret(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = raw.trim();
  if (value.length === 0 || value.startsWith("#")) return undefined;
  return value;
}

/** Builds the per-recipe solver selector. Providers without credentials are simply absent. */
export function captchaTokenSolverFor(secrets: CaptchaSolverSecrets): (handlers: readonly ChallengeHandler[] | undefined) => TokenCaptchaSolver | undefined {
  const fetch = proxiedSolverFetch(secrets.providerProxyUrl);
  const solvers: Partial<Record<CaptchaSolverProvider, TokenCaptchaSolver>> = {};
  if (secrets.deathByCaptchaUsername && secrets.deathByCaptchaPassword) {
    solvers["death-by-captcha"] = createDeathByCaptchaSolver({
      credentials: { username: secrets.deathByCaptchaUsername, password: secrets.deathByCaptchaPassword },
      fetch,
    });
  }
  if (secrets.antiCaptchaClientKey) {
    solvers.anticaptcha = createAntiCaptchaSolver({ clientKey: secrets.antiCaptchaClientKey, fetch });
  }
  return (handlers) => createTokenSolver(automaticCaptchaSolverProviders(handlers), solvers);
}
