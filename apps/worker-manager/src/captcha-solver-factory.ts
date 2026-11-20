import { readFile } from "node:fs/promises";
import {
  createAntiCaptchaSolver,
  createCaptchaGuardianFactory,
  createDeathByCaptchaSolver,
  createTokenSolver,
  automaticCaptchaSolverProviders,
  llmCaptchaModels,
  proxiedFetch,
  type CaptchaGuardianFactory,
  type CaptchaModels,
  type CaptchaSolverProvider,
  type SolverFetch,
  type TokenCaptchaSolver,
} from "@browser-fabric/worker-runtime";
import type { ChallengeHandler } from "@browser-fabric/contracts";

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

/** reCAPTCHA token provider credentials from Docker secret mounts. Values are never placed in a browser. */
export interface TokenProviderSecrets {
  deathByCaptchaUsername?: string;
  deathByCaptchaPassword?: string;
  antiCaptchaClientKey?: string;
}

/**
 * Builds the per-recipe selector of the guardian's reCAPTCHA token fallback. Providers without
 * credentials are simply absent.
 */
export function captchaTokenSolverFor(secrets: TokenProviderSecrets, fetch: SolverFetch): (handlers: readonly ChallengeHandler[] | undefined) => TokenCaptchaSolver | undefined {
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

export interface CaptchaSolving {
  /** The configured vision model; empty without a key. */
  models: CaptchaModels;
  /** Guardians that ask the configured model; without a key, only model-free challenges are solved. */
  captchaGuardianFactory: CaptchaGuardianFactory;
  tokenSolverFor: (handlers: readonly ChallengeHandler[] | undefined) => TokenCaptchaSolver | undefined;
}

/**
 * CAPTCHA solving of an owner process (worker-manager, local agent), configured from secret files and
 * environment. Model and token provider requests all leave through the egress sidecar listener at
 * `proxyUrl`, which admits only their hostnames.
 */
export async function captchaSolvingFromEnvironment(proxyUrl: string, env: Record<string, string | undefined> = process.env): Promise<CaptchaSolving> {
  const fetch = proxiedFetch(proxyUrl);
  const models = llmCaptchaModels({
    apiKey: await readOptionalSecret(env.FABRIC_LLM_CAPTCHA_API_KEY_FILE),
    baseURL: env.FABRIC_LLM_CAPTCHA_BASE_URL,
    model: env.FABRIC_LLM_CAPTCHA_MODEL,
    fetch,
  });
  return {
    models,
    captchaGuardianFactory: createCaptchaGuardianFactory({ models }),
    tokenSolverFor: captchaTokenSolverFor({
      deathByCaptchaUsername: await readOptionalSecret(env.FABRIC_DEATHBYCAPTCHA_USERNAME_FILE),
      deathByCaptchaPassword: await readOptionalSecret(env.FABRIC_DEATHBYCAPTCHA_PASSWORD_FILE),
      antiCaptchaClientKey: await readOptionalSecret(env.FABRIC_ANTICAPTCHA_CLIENT_KEY_FILE),
    }, fetch),
  };
}
