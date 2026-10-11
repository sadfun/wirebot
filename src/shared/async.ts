import { BridgeError } from "./errors.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  if (resolve === undefined || reject === undefined) {
    throw new BridgeError("Failed to create deferred promise", "DEFERRED_INIT_FAILED");
  }
  return { promise, resolve, reject };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BridgeError(message, "TIMEOUT")), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Cancel the wait without abandoning rejection handling for the underlying work. */
export function withAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    start().then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  public isBusy(key: string): boolean {
    return this.#tails.has(key);
  }

  /**
   * Reserve an idle key without waiting. Work submitted through `run` after
   * this succeeds waits until the returned lease is released.
   */
  public tryAcquire(key: string): Readonly<{ release: () => void }> | undefined {
    if (this.#tails.has(key)) return undefined;
    let releasePromise: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releasePromise = resolve;
    });
    this.#tails.set(key, current);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        releasePromise?.();
        if (this.#tails.get(key) === current) this.#tails.delete(key);
      },
    };
  }

  public async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release?.();
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    }
  }
}

export async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
