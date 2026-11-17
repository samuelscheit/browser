/**
 * Cloudflare Turnstile: one Media-style trusted click on the checkbox at the
 * left of the widget iframe, after a short eased approach.
 */
import type { ChallengeBudgetPolicy, ChallengeFrameBox, ChallengeHandler } from "./challenge-handlers";
import { approachSteps, dispatchMouseSteps, jitter, type MouseStep, type RandomSource } from "./trusted-mouse";
import { isTurnstileFrameUrl } from "./turnstile-guardian-observation";

/** The checkbox sits near the widget's left edge, vertically centered. */
export function turnstileClickSteps(box: ChallengeFrameBox, random: RandomSource = Math.random): MouseStep[] {
  const x = Math.max(1, box.x + Math.min(Math.max(2, box.width / 2), Math.max(2, Math.min(30, box.width - 2))));
  const y = Math.max(1, box.y + Math.min(Math.max(2, box.height / 2), Math.max(2, box.height - 2)));
  const approach = approachSteps({ x: jitter(x, 2, random), y: jitter(y, 2, random) }, random);
  approach[approach.length - 1]!.delayMs = 40;
  const click = { x: jitter(x, 1, random), y: jitter(y, 1, random) };
  return [
    ...approach,
    { type: "mousePressed", ...click, buttons: 1, delayMs: 55 },
    { type: "mouseReleased", ...click, buttons: 0, delayMs: 0 },
  ];
}

export function turnstileClickHandler(budget: { maxAttempts: number; timeoutMs: number }): ChallengeHandler {
  // Turnstile tolerates repeated clicks; it simply re-runs its check.
  const policy: ChallengeBudgetPolicy = { ...budget, firstAttemptDelayMs: 0, retryDelayMs: 0 };
  return {
    kind: "turnstile",
    actionEvent: "clicked",
    policy,
    matchesFrameUrl: isTurnstileFrameUrl,
    async act(context, box) {
      await dispatchMouseSteps(context.send, context.pageSessionId, turnstileClickSteps(box));
      return "acted";
    },
  };
}
