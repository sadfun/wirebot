import type { OutboundAttachment, OutboundStream, ProgressSnapshot } from "../core/channel.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { truncate } from "../shared/text.js";
import { CompletionGuard } from "./completion-guard.js";
import { DraftThrottle } from "./draft-throttle.js";
import { formatThinkingBlock, splitMessageText } from "./progress.js";

/**
 * Channel-agnostic streaming reply: one editable message that starts as
 * progress and is replaced by the final answer. Edits are throttled to one
 * per interval. Connectors supply the transport (post/update) and the
 * channel-specific text rendering; all draft/lifecycle state lives here.
 */
export abstract class DraftReplyStream implements OutboundStream {
  static readonly #draftIntervalMs = 1_500;
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #messageId: string | undefined;
  #starting: Promise<void> | undefined;
  #lastPublishedText = "";
  readonly #lifecycle = new CompletionGuard();
  readonly #throttle = new DraftThrottle(
    DraftReplyStream.#draftIntervalMs,
    async () => await this.flushDraft(),
    {
      onError: (error: unknown) => {
        this.logger.debug(`${this.#channelLabel} draft update failed`, {
          error: errorMessage(error),
        });
      },
    },
  );
  #loggedActions = 0;
  #lastReasoning = "";
  readonly #channelLabel: string;
  readonly #textLimit: number;
  protected readonly logger: Logger;

  protected constructor(logger: Logger, channelLabel: string, textLimit: number) {
    this.logger = logger;
    this.#channelLabel = channelLabel;
    this.#textLimit = textLimit;
  }

  /** Post the progress message and return its channel-native message id. */
  protected abstract postInitial(content: string): Promise<string>;

  /** Post a follow-up message in the same conversation. */
  protected abstract post(content: string): Promise<void>;

  /** Edit the progress message in place. */
  protected abstract update(messageId: string, content: string): Promise<void>;

  /** Adapt the rendered thinking block for the channel (e.g. entity escaping). */
  protected abstract renderProgress(block: string): string;

  /** Convert final markdown into the channel's message format. */
  protected abstract renderFinal(text: string): string;

  /** Fold attachment information into the final text (default: unchanged). */
  protected prepareFinalText(text: string, _attachments: readonly OutboundAttachment[]): string {
    return text;
  }

  /** Runs once the initial post is in flight, before it is awaited. */
  protected afterStartInitiated(): Promise<void> {
    return Promise.resolve();
  }

  /** Deliver attachments after the final text (default: nothing to send). */
  protected finishExtras(_attachments: readonly OutboundAttachment[]): Promise<void> {
    return Promise.resolve();
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (this.#lifecycle.closed || this.#messageId !== undefined) return;
    if (this.#starting !== undefined) return await this.#starting;
    if (initialProgress !== undefined) this.#progress = initialProgress;
    const preview = this.preview();
    const post = this.postInitial(preview)
      .then((messageId) => {
        this.#messageId = messageId;
        this.#throttle.touch();
        this.#lastPublishedText = preview;
        if (this.#throttle.dirty) this.scheduleDraft(true);
      })
      .catch((error: unknown) => {
        this.logger.debug(`${this.#channelLabel} progress message could not be posted`, {
          error: errorMessage(error),
        });
      });
    this.#starting = post;
    await this.afterStartInitiated();
    try {
      await post;
    } finally {
      this.#starting = undefined;
    }
  }

  public setProgress(progress: ProgressSnapshot): void {
    if (this.#lifecycle.closed) return;
    // Mirror the run into stdout: every tool call once, and reasoning
    // summaries as they change.
    for (const action of progress.actions.slice(this.#loggedActions)) {
      this.logger.debug("Codex tool call", { action: action.label });
    }
    this.#loggedActions = Math.max(this.#loggedActions, progress.actions.length);
    const reasoning = (progress.summary ?? progress.message)?.trim();
    if (reasoning !== undefined && reasoning.length > 0 && reasoning !== this.#lastReasoning) {
      this.#lastReasoning = reasoning;
      this.logger.debug("Codex reasoning", { text: truncate(reasoning, 600) });
    }
    this.#progress = progress;
    this.scheduleDraft();
  }

  public appendFinal(_delta: string): void {
    // Keep the editable message as an unambiguous progress placeholder until
    // complete() can replace it with the authoritative final text. If a
    // streamed preview were published first and the final edit failed, the
    // delivery fallback would leave that stale preview beside the full answer.
  }

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    await this.#lifecycle.run(
      async () => await this.finish(this.prepareFinalText(text, attachments), attachments),
    );
  }

  public async fail(message: string): Promise<void> {
    await this.complete(`Codex error: ${message}`);
  }

  private async finish(text: string, attachments: readonly OutboundAttachment[]): Promise<void> {
    this.#throttle.clear();
    await this.#starting?.catch(() => undefined);
    await this.#throttle.settle();
    if (text.length > 0) {
      this.logger.info("Codex answer delivered", { chars: text.length });
    }
    const chunks =
      text.length === 0 ? [] : splitMessageText(this.renderFinal(text), this.#textLimit);
    const [first, ...remaining] = chunks;
    let chunksToPost = chunks;
    if (this.#messageId !== undefined) {
      const replacement =
        first ?? this.renderProgress(formatThinkingBlock(this.#progress)).slice(0, this.#textLimit);
      if (replacement !== this.#lastPublishedText) {
        try {
          await this.update(this.#messageId, replacement);
          chunksToPost = remaining;
        } catch (error) {
          this.logger.debug(`${this.#channelLabel} final replacement failed`, {
            error: errorMessage(error),
          });
        }
      } else {
        chunksToPost = remaining;
      }
    }
    let undelivered = 0;
    for (const chunk of chunksToPost) {
      try {
        await this.post(chunk);
      } catch (error) {
        undelivered += 1;
        this.logger.warn(`${this.#channelLabel} final text delivery failed`, {
          error: errorMessage(error),
        });
      }
    }
    if (undelivered > 0) {
      await this.post(
        `⚠️ ${undelivered} part${undelivered === 1 ? "" : "s"} of the reply could not be delivered.`,
      ).catch(() => undefined);
    }
    await this.finishExtras(attachments);
  }

  private scheduleDraft(immediate = false): void {
    if (this.#lifecycle.closed) return;
    if (this.#messageId === undefined) {
      // No progress message yet; start() re-schedules once it is posted.
      this.#throttle.markDirty();
      return;
    }
    this.#throttle.schedule(immediate);
  }

  private async flushDraft(): Promise<void> {
    const messageId = this.#messageId;
    if (this.#lifecycle.closed || messageId === undefined) return;
    const preview = this.preview();
    if (preview === this.#lastPublishedText) return;
    await this.update(messageId, preview);
    this.#lastPublishedText = preview;
  }

  private preview(): string {
    return this.renderProgress(formatThinkingBlock(this.#progress)).slice(0, this.#textLimit);
  }
}
