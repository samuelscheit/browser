export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  #time: number;

  public constructor(initial: Date | string | number = Date.now()) {
    this.#time = initial instanceof Date ? initial.getTime() : typeof initial === "string" ? Date.parse(initial) : initial;
    if (!Number.isFinite(this.#time)) throw new Error("invalid fake clock time");
  }

  public now(): Date {
    return new Date(this.#time);
  }

  public advance(milliseconds: number): Date {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("clock can only advance by a non-negative finite duration");
    this.#time += milliseconds;
    return this.now();
  }

  public set(value: Date | string | number): void {
    const next = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
    if (!Number.isFinite(next)) throw new Error("invalid fake clock time");
    this.#time = next;
  }
}

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}

export function epochSeconds(clock: Clock): number {
  return Math.floor(clock.now().getTime() / 1000);
}
