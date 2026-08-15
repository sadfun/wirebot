/**
 * Coalesces streaming updates into at most one in-flight flush per interval:
 * `schedule` marks the latest content dirty, and the flush callback runs once
 * the interval elapses and any previous flush has settled.
 */
export class DraftThrottle {
  readonly #intervalMs: number;
  readonly #flush: () => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #immediateAfterFlush: () => boolean;
  #lastFlushAt = 0;
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;

  public constructor(
    intervalMs: number,
    flush: () => Promise<void>,
    options: {
      readonly onError?: (error: unknown) => void;
      /** Whether a pending update may skip the interval once a flush settles. */
      readonly immediateAfterFlush?: () => boolean;
    } = {},
  ) {
    this.#intervalMs = intervalMs;
    this.#flush = flush;
    this.#onError = options.onError;
    this.#immediateAfterFlush = options.immediateAfterFlush ?? ((): boolean => false);
  }

  public get dirty(): boolean {
    return this.#dirty;
  }

  public markDirty(): void {
    this.#dirty = true;
  }

  /** Record an out-of-band publish so the next flush waits a full interval. */
  public touch(): void {
    this.#lastFlushAt = Date.now();
  }

  public schedule(immediate = false): void {
    this.#dirty = true;
    if (this.#inFlight !== undefined) return;
    const wait = immediate ? 0 : Math.max(0, this.#intervalMs - (Date.now() - this.#lastFlushAt));
    if (wait === 0) {
      this.startFlush();
      return;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.startFlush();
    }, wait);
    this.#timer.unref();
  }

  public clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#dirty = false;
  }

  public async settle(): Promise<void> {
    await this.#inFlight?.catch(() => undefined);
  }

  private startFlush(): void {
    if (this.#inFlight !== undefined || !this.#dirty) return;
    this.#dirty = false;
    this.#lastFlushAt = Date.now();
    const update = this.#flush().catch((error: unknown) => this.#onError?.(error));
    this.#inFlight = update;
    void update.finally(() => {
      if (this.#inFlight === update) this.#inFlight = undefined;
      if (this.#dirty) this.schedule(this.#immediateAfterFlush());
    });
  }
}
