import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type {
  ChoiceOption,
  MessageResponder,
  OutboundAttachment,
  OutboundMessage,
  OutboundStream,
  ProgressSnapshot,
  SendOptions,
} from "../../core/channel.js";
import type { Logger } from "../../shared/logger.js";
import { formatThinkingBlock, splitMessageText } from "../progress.js";

export const discordTextLimit = 2_000;
const discordChoiceTextLimit = 1_880;

export type DiscordActionRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

export interface DiscordPostOptions {
  readonly channelId: string;
  readonly content: string;
  readonly components?: readonly DiscordActionRow[];
  readonly replyToMessageId?: string;
}

export interface DiscordUpdateOptions {
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string;
  readonly components?: readonly DiscordActionRow[];
}

/** Narrow Discord messaging port; the implementation owns ping/embed suppression. */
export interface DiscordMessagingApi {
  postMessage(options: DiscordPostOptions): Promise<string>;
  updateMessage(options: DiscordUpdateOptions): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
}

export type DiscordChoiceRequester = (
  channelId: string,
  userId: string,
  prompt: string,
  options: readonly ChoiceOption[],
  signal?: AbortSignal,
) => Promise<string>;

/** Used by a deferred slash command to turn its acknowledgement into the first message. */
export type DiscordInitialReply = (
  content: string,
  components?: readonly DiscordActionRow[],
) => Promise<string>;

export async function publishDiscordMessage(
  api: DiscordMessagingApi,
  channelId: string,
  message: OutboundMessage,
  logger: Logger,
): Promise<readonly string[]> {
  const published: string[] = [];
  const content = withAttachmentNotices(message.text, message.attachments ?? []);
  for (const chunk of nonEmptyChunks(content)) {
    published.push(await api.postMessage({ channelId, content: chunk }));
  }
  const components = commandRows(message, logger);
  if (components.length > 0) {
    published.push(await api.postMessage({ channelId, content: "Choose an action", components }));
  }
  return published;
}

export class DiscordResponder implements MessageResponder {
  readonly #api: DiscordMessagingApi;
  readonly #channelId: string;
  readonly #userId: string;
  readonly #requestChoice: DiscordChoiceRequester;
  readonly #logger: Logger;
  readonly #replyToMessageId: string | undefined;
  readonly #initialReply: DiscordInitialReply | undefined;
  #firstReplyAvailable = true;

  public constructor(
    api: DiscordMessagingApi,
    channelId: string,
    userId: string,
    requestChoice: DiscordChoiceRequester,
    logger: Logger,
    replyToMessageId?: string,
    initialReply?: DiscordInitialReply,
  ) {
    this.#api = api;
    this.#channelId = channelId;
    this.#userId = userId;
    this.#requestChoice = requestChoice;
    this.#logger = logger;
    this.#replyToMessageId = replyToMessageId;
    this.#initialReply = initialReply;
  }

  public createStream(): OutboundStream {
    const first = this.takeFirstReply();
    return new DiscordReplyStream(
      this.#api,
      this.#channelId,
      this.#logger,
      first.replyToMessageId,
      first.initialReply,
    );
  }

  public async sendText(text: string, options?: SendOptions): Promise<void> {
    this.#logger.info("Discord reply", { chars: text.length });
    const chunks = nonEmptyChunks(text);
    const components = linkRows(options);
    const first = this.takeFirstReply();
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      if (index === 0 && first.initialReply !== undefined) {
        await first.initialReply(chunk, isLast ? components : undefined);
        continue;
      }
      await this.#api.postMessage({
        channelId: this.#channelId,
        content: chunk,
        ...(index === 0 && first.replyToMessageId !== undefined
          ? { replyToMessageId: first.replyToMessageId }
          : {}),
        ...(isLast && components !== undefined ? { components } : {}),
      });
    }
  }

  public async askChoice(
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.#requestChoice(this.#channelId, this.#userId, prompt, options, signal);
  }

  private takeFirstReply(): Readonly<{
    replyToMessageId: string | undefined;
    initialReply: DiscordInitialReply | undefined;
  }> {
    if (!this.#firstReplyAvailable) return { replyToMessageId: undefined, initialReply: undefined };
    this.#firstReplyAvailable = false;
    return {
      replyToMessageId: this.#replyToMessageId,
      initialReply: this.#initialReply,
    };
  }
}

export class DiscordReplyStream implements OutboundStream {
  static readonly #draftIntervalMs = 1_500;
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #finalText = "";
  #messageId: string | undefined;
  #starting: Promise<void> | undefined;
  #lastDraftAt = 0;
  #lastPublishedText = "";
  #draftDirty = false;
  #draftTimer: NodeJS.Timeout | undefined;
  #draftInFlight: Promise<void> | undefined;
  #closing = false;
  #completing: Promise<void> | undefined;
  #completed = false;
  #loggedActions = 0;
  #lastReasoning = "";
  readonly #api: DiscordMessagingApi;
  readonly #channelId: string;
  readonly #replyToMessageId: string | undefined;
  readonly #initialReply: DiscordInitialReply | undefined;
  readonly #logger: Logger;

  public constructor(
    api: DiscordMessagingApi,
    channelId: string,
    logger: Logger,
    replyToMessageId?: string,
    initialReply?: DiscordInitialReply,
  ) {
    this.#api = api;
    this.#channelId = channelId;
    this.#logger = logger;
    this.#replyToMessageId = replyToMessageId;
    this.#initialReply = initialReply;
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (this.#closing || this.#completed || this.#messageId !== undefined) return;
    if (this.#starting !== undefined) return await this.#starting;
    if (initialProgress !== undefined) this.#progress = initialProgress;
    const preview = this.preview();
    const post = (
      this.#initialReply === undefined
        ? this.#api.postMessage({
            channelId: this.#channelId,
            content: preview,
            ...(this.#replyToMessageId === undefined
              ? {}
              : { replyToMessageId: this.#replyToMessageId }),
          })
        : this.#initialReply(preview)
    )
      .then((messageId) => {
        this.#messageId = messageId;
        this.#lastDraftAt = Date.now();
        this.#lastPublishedText = preview;
        if (this.#draftDirty) this.scheduleDraft(true);
      })
      .catch((error: unknown) => {
        this.#logger.debug("Discord progress message could not be posted", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.#starting = post;
    await this.#api.sendTyping(this.#channelId).catch(() => undefined);
    try {
      await post;
    } finally {
      this.#starting = undefined;
    }
  }

  public setProgress(progress: ProgressSnapshot): void {
    if (this.#closing || this.#completed) return;
    for (const action of progress.actions.slice(this.#loggedActions)) {
      this.#logger.debug("Codex tool call", { action: action.label });
    }
    this.#loggedActions = Math.max(this.#loggedActions, progress.actions.length);
    const reasoning = (progress.summary ?? progress.message)?.trim();
    if (reasoning !== undefined && reasoning.length > 0 && reasoning !== this.#lastReasoning) {
      this.#lastReasoning = reasoning;
      this.#logger.debug("Codex reasoning", { text: truncateForLog(reasoning, 600) });
    }
    this.#progress = progress;
    this.scheduleDraft();
  }

  public appendFinal(delta: string): void {
    if (this.#closing || this.#completed) return;
    this.#finalText += delta;
    this.scheduleDraft();
  }

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    if (this.#completed) return;
    if (this.#completing !== undefined) return await this.#completing;
    this.#closing = true;
    const completion = this.finish(withAttachmentNotices(text, attachments));
    this.#completing = completion;
    try {
      await completion;
      this.#completed = true;
    } finally {
      if (this.#completing === completion) this.#completing = undefined;
      if (!this.#completed) this.#closing = false;
    }
  }

  public async fail(message: string): Promise<void> {
    await this.complete(`Codex error: ${message}`);
  }

  private async finish(text: string): Promise<void> {
    this.clearTimer();
    await this.#starting?.catch(() => undefined);
    await this.#draftInFlight?.catch(() => undefined);
    if (text.length > 0) this.#logger.info("Codex answer delivered", { chars: text.length });
    if (this.#messageId !== undefined) {
      await this.#api
        .updateMessage({
          channelId: this.#channelId,
          messageId: this.#messageId,
          content: formatThinkingBlock(this.#progress).slice(0, discordTextLimit),
        })
        .catch((error: unknown) => {
          this.#logger.debug("Discord progress freeze failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    let undelivered = 0;
    for (const chunk of nonEmptyChunks(text)) {
      try {
        await this.#api.postMessage({ channelId: this.#channelId, content: chunk });
      } catch (error) {
        undelivered += 1;
        this.#logger.warn("Discord final text delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (undelivered > 0) {
      await this.#api
        .postMessage({
          channelId: this.#channelId,
          content: `⚠️ ${undelivered} part${undelivered === 1 ? "" : "s"} of the reply could not be delivered.`,
        })
        .catch(() => undefined);
    }
  }

  private scheduleDraft(immediate = false): void {
    if (this.#closing || this.#completed) return;
    this.#draftDirty = true;
    if (this.#messageId === undefined || this.#draftInFlight !== undefined) return;
    const wait = immediate
      ? 0
      : Math.max(0, DiscordReplyStream.#draftIntervalMs - (Date.now() - this.#lastDraftAt));
    if (wait === 0) {
      this.startDraftUpdate();
      return;
    }
    if (this.#draftTimer !== undefined) return;
    this.#draftTimer = setTimeout(() => {
      this.#draftTimer = undefined;
      this.startDraftUpdate();
    }, wait);
    this.#draftTimer.unref();
  }

  private startDraftUpdate(): void {
    if (
      this.#closing ||
      this.#completed ||
      this.#messageId === undefined ||
      this.#draftInFlight !== undefined ||
      !this.#draftDirty
    ) {
      return;
    }
    this.#draftDirty = false;
    const update = this.flushDraft().catch((error: unknown) => {
      this.#logger.debug("Discord draft update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.#draftInFlight = update;
    void update.finally(() => {
      if (this.#draftInFlight === update) this.#draftInFlight = undefined;
      if (this.#draftDirty) this.scheduleDraft();
    });
  }

  private async flushDraft(): Promise<void> {
    const messageId = this.#messageId;
    if (this.#closing || this.#completed || messageId === undefined) return;
    const preview = this.preview();
    if (preview === this.#lastPublishedText) return;
    this.#lastDraftAt = Date.now();
    await this.#api.updateMessage({ channelId: this.#channelId, messageId, content: preview });
    this.#lastPublishedText = preview;
  }

  private preview(): string {
    const progress = formatThinkingBlock(this.#progress).slice(0, discordTextLimit - 3);
    if (this.#finalText.length === 0) return `${progress}\n\n▌`;
    const available = Math.max(0, discordTextLimit - progress.length - 3);
    return `${progress}\n\n${this.#finalText.slice(-available)}▌`;
  }

  private clearTimer(): void {
    if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
    this.#draftTimer = undefined;
    this.#draftDirty = false;
  }
}

export function choicePromptText(prompt: string, options: readonly ChoiceOption[]): string {
  const details = options
    .filter((option) => option.description !== undefined)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  const body = details.length === 0 ? prompt : `${prompt}\n\n${details}`;
  return body.length <= discordChoiceTextLimit
    ? body
    : `${body.slice(0, discordChoiceTextLimit - 1)}…`;
}

export function choiceRows(token: string, options: readonly ChoiceOption[]): DiscordActionRow[] {
  return chunkButtons(
    options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`wirebot_choice:${token}:${index}`)
        .setLabel(option.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    ),
  );
}

export function disabledChoiceRows(
  token: string,
  options: readonly ChoiceOption[],
): DiscordActionRow[] {
  return chunkButtons(
    options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`wirebot_choice:${token}:${index}`)
        .setLabel(option.label.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  );
}

export function decodeDiscordCommandId(
  customId: string,
): Readonly<{ name: string; args: string }> | undefined {
  if (!customId.startsWith("wirebot_cmd:")) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(customId.slice("wirebot_cmd:".length), "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const name = Reflect.get(parsed, "name");
    const args = Reflect.get(parsed, "args");
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(name)) return undefined;
    if (typeof args !== "string") return undefined;
    return { name, args };
  } catch {
    return undefined;
  }
}

function commandRows(message: OutboundMessage, logger: Logger): DiscordActionRow[] {
  const buttons: ButtonBuilder[] = [];
  for (const action of message.actions ?? []) {
    const encoded = Buffer.from(JSON.stringify(action.command), "utf8").toString("base64url");
    const customId = `wirebot_cmd:${encoded}`;
    if (customId.length > 100 || !/^[a-z][a-z0-9_]*$/u.test(action.command.name)) {
      logger.warn("Dropped a Discord command action", { command: action.command.name });
      continue;
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(action.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  }
  return chunkButtons(buttons);
}

function linkRows(options: SendOptions | undefined): readonly DiscordActionRow[] | undefined {
  const button = options?.button;
  if (button === undefined) return undefined;
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel(button.label.slice(0, 80))
        .setURL(button.url)
        .setStyle(ButtonStyle.Link),
    ),
  ];
}

function chunkButtons(buttons: readonly ButtonBuilder[]): DiscordActionRow[] {
  const rows: DiscordActionRow[] = [];
  for (let index = 0; index < Math.min(buttons.length, 25); index += 5) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...buttons.slice(index, index + 5),
      ),
    );
  }
  return rows;
}

function withAttachmentNotices(text: string, attachments: readonly OutboundAttachment[]): string {
  if (attachments.length === 0) return text;
  const notices = attachments.map(
    (attachment) =>
      `[File omitted: ${attachment.filename.replaceAll(/[\r\n]/gu, "_")} — Discord connector is text-only.]`,
  );
  return [text, ...notices].filter((part) => part.length > 0).join("\n\n");
}

function nonEmptyChunks(text: string): readonly string[] {
  return text.length === 0 ? [] : splitMessageText(text, discordTextLimit);
}

function truncateForLog(text: string, limit: number): string {
  const compact = text.trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}
