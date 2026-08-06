import type { ChoiceOption } from "../core/channel.js";
import { type Deferred, deferred } from "../shared/async.js";

const choiceTimeoutMs = 5 * 60 * 1_000;

export interface PendingChoiceEntry<TContext> {
  readonly token: string;
  readonly userId: string;
  readonly options: readonly ChoiceOption[];
  readonly context: TContext;
}

interface PendingChoiceState<TContext> extends PendingChoiceEntry<TContext> {
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
}

type DeclineHandler<TContext> = (
  entry: PendingChoiceEntry<TContext>,
  status: string,
) => Promise<void>;

/**
 * Channel-agnostic bookkeeping for interactive choice prompts: token issuing,
 * the expiry timer, abort-signal wiring, and resolve-once semantics. The
 * connector posts the prompt (`post`) with its channel's buttons and withdraws
 * it again in `onDecline`; `context` carries whatever the connector needs to
 * find the prompt message later.
 */
export class PendingChoices<TContext> {
  readonly #entries = new Map<string, PendingChoiceState<TContext>>();
  readonly #onDecline: DeclineHandler<TContext>;

  public constructor(onDecline: DeclineHandler<TContext>) {
    this.#onDecline = onDecline;
  }

  /**
   * Post a choice prompt and wait for the selected option id. Resolves with
   * "decline" when the prompt expires, the signal aborts, or the channel
   * shuts down.
   */
  public async request(
    userId: string,
    options: readonly ChoiceOption[],
    signal: AbortSignal | undefined,
    post: (token: string) => Promise<TContext>,
  ): Promise<string> {
    const isAborted = (): boolean => signal?.aborted === true;
    if (options.length === 0 || isAborted()) return "decline";
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const context = await post(token);
    const result = deferred<string>();
    const timer = setTimeout(() => {
      void this.decline(token, "Request expired");
    }, choiceTimeoutMs);
    timer.unref();
    this.#entries.set(token, { token, userId, options, context, result, timer });
    const onAbort = (): void => {
      void this.decline(token, "Request cancelled");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) onAbort();
    try {
      return await result.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  public get(token: string): PendingChoiceEntry<TContext> | undefined {
    return this.#entries.get(token);
  }

  /** Settle a prompt with the user's selection; cancels the expiry timer. */
  public select(token: string, optionId: string): void {
    this.take(token)?.result.resolve(optionId);
  }

  /** Settle a prompt as declined and let the connector withdraw it. */
  public async decline(token: string, status: string): Promise<void> {
    const entry = this.take(token);
    if (entry === undefined) return;
    entry.result.resolve("decline");
    try {
      await this.#onDecline(entry, status);
    } catch {
      // Withdrawing the prompt message is best-effort.
    }
  }

  /** Decline every outstanding prompt, e.g. on channel shutdown. */
  public async declineAll(status: string): Promise<void> {
    await Promise.allSettled(
      [...this.#entries.keys()].map(async (token) => await this.decline(token, status)),
    );
  }

  private take(token: string): PendingChoiceState<TContext> | undefined {
    const entry = this.#entries.get(token);
    if (entry === undefined) return undefined;
    this.#entries.delete(token);
    clearTimeout(entry.timer);
    return entry;
  }
}
