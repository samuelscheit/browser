import { Mutex } from "./mutex";
import { cloneState, emptyFabricState, type FabricState } from "./state";

export interface FabricStore {
  transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T>;
  read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T>;
  snapshot(): Promise<FabricState>;
}

/** In-process store used by development and tests. Transactions use copy-on-write drafts. */
export class InMemoryFabricStore implements FabricStore {
  #state: FabricState;
  readonly #mutex = new Mutex();

  public constructor(initial?: FabricState) {
    this.#state = cloneState(initial ?? emptyFabricState());
  }

  public async transact<T>(operation: (draft: FabricState) => T | Promise<T>): Promise<T> {
    return this.#mutex.run(async () => {
      const draft = cloneState(this.#state);
      const result = await operation(draft);
      this.#state = draft;
      return result;
    });
  }

  public async read<T>(operation: (snapshot: FabricState) => T | Promise<T>): Promise<T> {
    return this.#mutex.run(async () => operation(cloneState(this.#state)));
  }

  public async snapshot(): Promise<FabricState> {
    return this.read((snapshot) => snapshot);
  }
}
