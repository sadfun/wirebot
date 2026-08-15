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
  SendOptions,
} from "../../core/channel.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { truncate } from "../../shared/text.js";
import { encodeCommandAction } from "../command-actions.js";
import { DraftReplyStream } from "../draft-stream.js";
import { splitMessageText } from "../progress.js";

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

export class DiscordReplyStream extends DraftReplyStream {
  readonly #api: DiscordMessagingApi;
  readonly #channelId: string;
  readonly #replyToMessageId: string | undefined;
  readonly #initialReply: DiscordInitialReply | undefined;

  public constructor(
    api: DiscordMessagingApi,
    channelId: string,
    logger: Logger,
    replyToMessageId?: string,
    initialReply?: DiscordInitialReply,
  ) {
    super(logger, "Discord", discordTextLimit);
    this.#api = api;
    this.#channelId = channelId;
    this.#replyToMessageId = replyToMessageId;
    this.#initialReply = initialReply;
  }

  protected async postInitial(content: string): Promise<string> {
    return this.#initialReply === undefined
      ? await this.#api.postMessage({
          channelId: this.#channelId,
          content,
          ...(this.#replyToMessageId === undefined
            ? {}
            : { replyToMessageId: this.#replyToMessageId }),
        })
      : await this.#initialReply(content);
  }

  protected async post(content: string): Promise<void> {
    await this.#api.postMessage({ channelId: this.#channelId, content });
  }

  protected async update(messageId: string, content: string): Promise<void> {
    await this.#api.updateMessage({ channelId: this.#channelId, messageId, content });
  }

  protected renderProgress(block: string): string {
    return block;
  }

  protected renderFinal(text: string): string {
    return text;
  }

  protected override prepareFinalText(
    text: string,
    attachments: readonly OutboundAttachment[],
  ): string {
    return withAttachmentNotices(text, attachments);
  }

  protected override async afterStartInitiated(): Promise<void> {
    await this.#api.sendTyping(this.#channelId).catch(() => undefined);
  }
}

export function choicePromptText(prompt: string, options: readonly ChoiceOption[]): string {
  const details = options
    .filter((option) => option.description !== undefined)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  const body = details.length === 0 ? prompt : `${prompt}\n\n${details}`;
  return truncate(body, discordChoiceTextLimit);
}

export function choiceRows(
  token: string,
  options: readonly ChoiceOption[],
  disabled = false,
): DiscordActionRow[] {
  return chunkButtons(
    options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`wirebot_choice:${token}:${index}`)
        .setLabel(option.label.slice(0, 80))
        .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
}

function commandRows(message: OutboundMessage, logger: Logger): DiscordActionRow[] {
  const buttons: ButtonBuilder[] = [];
  for (const action of message.actions ?? []) {
    // One unencodable action must not take down the whole delivery. Discord
    // caps a custom_id at 100 characters.
    let customId: string;
    try {
      customId = encodeCommandAction(action.command.name, action.command.args);
    } catch (error) {
      logger.warn("Dropped a Discord command action", {
        command: action.command.name,
        error: errorMessage(error),
      });
      continue;
    }
    if (customId.length > 100) {
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
