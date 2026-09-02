/** A tiny async mutex used to make scheduler state transitions serializable in-process. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  public async run<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
