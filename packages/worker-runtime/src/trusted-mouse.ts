/**
 * Trusted mouse input for challenge handlers. Every gesture is a plan of steps in top-level
 * page coordinates, dispatched through Input.dispatchMouseEvent on the page session, which
 * the browser routes to whichever (out-of-process) frame is under the pointer.
 */
import type { CdpSend } from "./challenge-handlers";
import { sleep } from "./turnstile-guardian-observation";

export interface MousePoint {
  x: number;
  y: number;
}

export interface MouseStep extends MousePoint {
  type: "mouseMoved" | "mousePressed" | "mouseReleased";
  /** Left button held after this step: 1 while pressed or dragging, 0 otherwise. */
  buttons: 0 | 1;
  /** Pause after this step. */
  delayMs: number;
}

export type RandomSource = () => number;

export function between(random: RandomSource, min: number, max: number): number {
  return min + (max - min) * random();
}

export function jitter(value: number, range = 2, random: RandomSource = Math.random): number {
  return value + between(random, -range, range);
}

/** Smoothstep easing: slow start, fast middle, slow end, as a hand moves toward a target. */
export function smoothstep(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}

/** Hover moves from a nearby point onto `to`, ending exactly on it. */
export function approachSteps(to: MousePoint, random: RandomSource = Math.random, options: { steps?: number; delayMs?: [number, number] } = {}): MouseStep[] {
  const from = { x: Math.max(1, to.x - between(random, 70, 105)), y: Math.max(1, to.y - between(random, 25, 50)) };
  const steps = options.steps ?? 12;
  const [minDelay, maxDelay] = options.delayMs ?? [12, 12];
  const result: MouseStep[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const eased = smoothstep(step / steps);
    const last = step === steps;
    result.push({
      type: "mouseMoved",
      x: last ? to.x : jitter(from.x + (to.x - from.x) * eased, 2, random),
      y: last ? to.y : jitter(from.y + (to.y - from.y) * eased, 2, random),
      buttons: 0,
      delayMs: between(random, minDelay, maxDelay),
    });
  }
  return result;
}

/**
 * Runs `gesture` while the given sessions' documents report focus. A person dragging a widget
 * always has its document focused; a background browser window does not, and an out-of-process
 * frame needs the emulation on its own session. Each session's emulation is turned off again.
 */
export async function withEmulatedFocus<T>(send: CdpSend, sessionIds: readonly string[], gesture: () => Promise<T>): Promise<T> {
  for (const sessionId of sessionIds) await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => undefined);
  try {
    return await gesture();
  } finally {
    for (const sessionId of sessionIds) await send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId).catch(() => undefined);
  }
}

export async function dispatchMouseSteps(send: CdpSend, sessionId: string, steps: readonly MouseStep[]): Promise<void> {
  for (const step of steps) {
    const button = step.type === "mouseMoved" && step.buttons === 0 ? "none" : "left";
    await send("Input.dispatchMouseEvent", {
      type: step.type,
      x: step.x,
      y: step.y,
      button,
      buttons: step.buttons,
      ...(step.type === "mouseMoved" ? {} : { clickCount: 1 }),
      timestamp: Date.now() / 1_000,
    }, sessionId);
    if (step.delayMs > 0) await sleep(step.delayMs);
  }
}
