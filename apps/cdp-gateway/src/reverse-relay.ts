/**
 * In-memory reverse CDP relay registry.
 *
 * Federated/local workers cannot expose an inbound browser port. They open one
 * outbound WebSocket per claimed lease to the gateway; the registry hands that
 * socket to the authenticated external CDP connection. The socket carries raw
 * browser-level CDP frames only—there is no command parser or host tunnel.
 */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface Waiter {
  resolve(socket: RelaySocket): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReverseCdpRelayRegistry {
  readonly #sockets = new Map<string, RelaySocket>();
  readonly #waiters = new Map<string, Waiter[]>();

  public register(key: string, socket: RelaySocket): void {
    if (!key || socket.readyState === CLOSING || socket.readyState === CLOSED) throw new Error("reverse CDP relay socket is not usable");
    const previous = this.#sockets.get(key);
    if (previous && previous !== socket) previous.close(1012, "relay replaced");
    this.#sockets.set(key, socket);
    const waiters = this.#waiters.get(key);
    if (waiters) {
      this.#waiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(socket);
      }
    }
    const remove = () => this.remove(key, socket);
    socket.addEventListener("close", remove, { once: true });
    socket.addEventListener("error", remove, { once: true });
  }

  public remove(key: string, socket?: RelaySocket): void {
    if (!socket || this.#sockets.get(key) === socket) this.#sockets.delete(key);
    if (!socket) {
      const waiters = this.#waiters.get(key) ?? [];
      this.#waiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("reverse CDP relay was removed"));
      }
    }
  }

  public get(key: string): RelaySocket | undefined {
    const socket = this.#sockets.get(key);
    return socket && socket.readyState === OPEN ? socket : undefined;
  }

  public async waitFor(key: string, timeoutMs = 15_000): Promise<RelaySocket> {
    const current = this.get(key);
    if (current) return current;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("reverse CDP relay timeout is outside bounds");
    return new Promise<RelaySocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.#waiters.get(key) ?? [];
        this.#waiters.set(key, waiters.filter((candidate) => candidate.resolve !== resolve));
        reject(new Error("local worker CDP relay did not connect before the deadline"));
      }, timeoutMs);
      const waiters = this.#waiters.get(key) ?? [];
      waiters.push({ resolve, reject, timer });
      this.#waiters.set(key, waiters);
    });
  }

  public size(): number { return this.#sockets.size; }
  public clear(): void {
    for (const socket of this.#sockets.values()) socket.close(1001, "gateway stopping");
    this.#sockets.clear();
    for (const key of this.#waiters.keys()) this.remove(key);
  }
}

export { OPEN as RELAY_OPEN, CLOSING as RELAY_CLOSING, CLOSED as RELAY_CLOSED };
