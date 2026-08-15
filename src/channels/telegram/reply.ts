import { extname } from "node:path";
import { type Api, InputFile } from "grammy";
import type { Chat, InlineKeyboardMarkup, InputRichMessageWithoutUpload } from "grammy/types";
import type {
  ChoiceOption,
  MessageResponder,
  OutboundAttachment,
  OutboundMessage,
  OutboundStream,
  ProgressSnapshot,
  SendOptions,
} from "../../core/channel.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { truncate } from "../../shared/text.js";
import { encodeCommandAction } from "../command-actions.js";
import { CompletionGuard } from "../completion-guard.js";
import { DraftThrottle } from "../draft-throttle.js";
import { formatThinkingBlock, splitMessageText } from "../progress.js";
import { safeFileName } from "./message.js";
import type { TelegramReplyRoute } from "./route.js";

export type ChoiceRequester = (
  chat: Chat,
  route: TelegramReplyRoute,
  userId: number,
  prompt: string,
  options: readonly ChoiceOption[],
  signal?: AbortSignal,
) => Promise<string>;

interface TelegramSendParameters {
  readonly message_thread_id?: number;
  readonly direct_messages_topic_id?: number;
  readonly reply_parameters?: { readonly message_id: number };
}

export function telegramSendParameters(route: TelegramReplyRoute): TelegramSendParameters {
  const destination = route.destination;
  switch (destination.kind) {
    case "topic":
      return { message_thread_id: destination.messageThreadId };
    case "directMessagesTopic":
      return { direct_messages_topic_id: destination.directMessagesTopicId };
    case "genericThread":
      return { reply_parameters: { message_id: destination.replyToMessageId } };
    case "chat":
      return {};
  }
}

function activityParameters(route: TelegramReplyRoute): Readonly<{ message_thread_id?: number }> {
  switch (route.destination.kind) {
    case "topic":
      return { message_thread_id: route.destination.messageThreadId };
    case "genericThread":
      return { message_thread_id: route.destination.replyToMessageId };
    case "chat":
    case "directMessagesTopic":
      return {};
  }
}

function keyboard(options: SendOptions | undefined): InlineKeyboardMarkup | undefined {
  const button = options?.button;
  if (button === undefined) return undefined;
  return {
    inline_keyboard: [
      [
        button.kind === "webApp"
          ? { text: button.label, web_app: { url: button.url } }
          : { text: button.label, url: button.url },
      ],
    ],
  };
}

function commandKeyboard(
  message: OutboundMessage,
  logger: Logger,
): InlineKeyboardMarkup | undefined {
  const actions = message.actions;
  if (actions === undefined || actions.length === 0) return undefined;
  // The only producer is the scheduled-run notification ("continue" plus a
  // UUID, ~48 bytes), comfortably inside Telegram's 64-byte callback-data cap.
  const rows = actions.flatMap((action) => {
    try {
      return [
        [
          {
            text: action.label.slice(0, 64),
            callback_data: encodeCommandAction(action.command.name, action.command.args),
          },
        ],
      ];
    } catch (error) {
      logger.warn("Dropped a Telegram command action", {
        command: action.command.name,
        error: errorMessage(error),
      });
      return [];
    }
  });
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

/**
 * Deliver a complete message: a rich-markdown attempt with a chunked
 * plain-text fallback, the optional action keyboard, then attachments.
 */
export async function publishTelegramMessage(
  api: Api,
  chatId: number,
  route: TelegramReplyRoute,
  message: OutboundMessage,
  logger: Logger,
): Promise<readonly number[]> {
  const messageIds: number[] = [];
  if (message.text.length > 0) {
    const textIds = await sendFinalText(
      api,
      chatId,
      route,
      message.text,
      commandKeyboard(message, logger),
      logger,
    );
    messageIds.push(...textIds);
  }
  const attachmentIds = await sendTelegramAttachments(
    api,
    chatId,
    route,
    message.attachments ?? [],
    logger,
  );
  messageIds.push(...attachmentIds);
  return messageIds;
}

async function sendFinalText(
  api: Api,
  chatId: number,
  route: TelegramReplyRoute,
  text: string,
  replyMarkup: InlineKeyboardMarkup | undefined,
  logger: Logger,
): Promise<readonly number[]> {
  const markup = replyMarkup === undefined ? {} : { reply_markup: replyMarkup };
  try {
    const sent = await api.sendRichMessage(
      chatId,
      { markdown: text },
      { ...telegramSendParameters(route), ...markup },
    );
    return [sent.message_id];
  } catch (error) {
    logger.debug("Rich Telegram message failed; using plain chunks", {
      error: errorMessage(error),
    });
  }
  const messageIds: number[] = [];
  const chunks = splitTelegramText(text);
  for (const [index, chunk] of chunks.entries()) {
    const sent = await api.sendMessage(chatId, chunk, {
      ...telegramSendParameters(route),
      ...(index === chunks.length - 1 ? markup : {}),
    });
    messageIds.push(sent.message_id);
  }
  return messageIds;
}

export class TelegramResponder implements MessageResponder {
  readonly #api: Api;
  readonly #chat: Chat;
  readonly #route: TelegramReplyRoute;
  readonly #userId: number;
  readonly #requestChoice: ChoiceRequester;
  readonly #logger: Logger;

  public constructor(
    api: Api,
    chat: Chat,
    route: TelegramReplyRoute,
    userId: number,
    requestChoice: ChoiceRequester,
    logger: Logger,
  ) {
    this.#api = api;
    this.#chat = chat;
    this.#route = route;
    this.#userId = userId;
    this.#requestChoice = requestChoice;
    this.#logger = logger;
  }

  public createStream(): OutboundStream {
    return new TelegramReplyStream(this.#api, this.#chat, this.#route, this.#logger);
  }

  public async sendText(text: string, options?: SendOptions): Promise<void> {
    const replyMarkup = keyboard(options);
    if (replyMarkup !== undefined) {
      await this.#api.sendMessage(this.#chat.id, truncateTelegramText(text), {
        ...telegramSendParameters(this.#route),
        reply_markup: replyMarkup,
      });
      return;
    }
    for (const chunk of splitTelegramText(text)) {
      await this.#api.sendMessage(this.#chat.id, chunk, telegramSendParameters(this.#route));
    }
  }

  public async askChoice(
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.#requestChoice(
      this.#chat,
      this.#route,
      this.#userId,
      prompt,
      options,
      signal,
    );
  }
}

interface TelegramGuestMessage {
  readonly inlineMessageId: string;
  readonly text: string;
}

export class TelegramGuestResponder implements MessageResponder {
  #answer: TelegramGuestMessage | undefined;
  #answering: Promise<TelegramGuestMessage> | undefined;
  readonly #api: Api;
  readonly #guestQueryId: string;

  public constructor(api: Api, guestQueryId: string) {
    this.#api = api;
    this.#guestQueryId = guestQueryId;
  }

  public createStream(): OutboundStream {
    return new TelegramGuestReplyStream(this);
  }

  public async sendText(text: string): Promise<void> {
    const existing = this.#answering === undefined ? this.#answer : await this.#answering;
    if (existing === undefined) {
      await this.answer(text);
      return;
    }
    // Telegram accepts a single answer per guest query, so follow-up text
    // (for example a bridge error) is appended to the inline message.
    const combined = `${existing.text}\n\n${text}`;
    this.#answer = {
      inlineMessageId: existing.inlineMessageId,
      text: await this.edit(existing.inlineMessageId, combined),
    };
  }

  public async askChoice(_prompt: string, _options: readonly ChoiceOption[]): Promise<string> {
    return "decline";
  }

  public async answer(text: string): Promise<TelegramGuestMessage> {
    if (this.#answer !== undefined) return this.#answer;
    if (this.#answering !== undefined) return await this.#answering;
    this.#answering = this.sendAnswer(text).then((answer) => {
      this.#answer = answer;
      return answer;
    });
    try {
      return await this.#answering;
    } finally {
      this.#answering = undefined;
    }
  }

  public async edit(inlineMessageId: string, text: string): Promise<string> {
    const richText = text.slice(0, 8_000);
    try {
      await this.#api.editMessageTextInline(inlineMessageId, {
        markdown: richText,
      });
      return richText;
    } catch {
      const plainText = truncateTelegramText(text);
      await this.#api.editMessageTextInline(inlineMessageId, plainText);
      return plainText;
    }
  }

  private async sendAnswer(text: string): Promise<TelegramGuestMessage> {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const richText = text.slice(0, 8_000);
    const result = {
      type: "article" as const,
      id,
      title: "Codex",
      input_message_content: { rich_message: { markdown: richText } },
    };
    try {
      const sent = await this.#api.answerGuestQuery(this.#guestQueryId, result);
      return {
        inlineMessageId: sent.inline_message_id,
        text: richText,
      };
    } catch {
      const plainText = truncateTelegramText(text);
      const sent = await this.#api.answerGuestQuery(this.#guestQueryId, {
        type: "article",
        id,
        title: "Codex",
        input_message_content: { message_text: plainText },
      });
      return {
        inlineMessageId: sent.inline_message_id,
        text: plainText,
      };
    }
  }
}

class TelegramGuestReplyStream implements OutboundStream {
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #finalText = "";
  #inlineMessageId: string | undefined;
  #lastPublishedText = "";
  readonly #lifecycle = new CompletionGuard();
  readonly #responder: TelegramGuestResponder;
  readonly #throttle = new DraftThrottle(1_000, async () => await this.flushDraft());

  public constructor(responder: TelegramGuestResponder) {
    this.#responder = responder;
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (this.#lifecycle.closed || this.#inlineMessageId !== undefined) return;
    if (initialProgress !== undefined) this.#progress = initialProgress;
    const preview = this.preview();
    const answer = await this.#responder.answer(preview);
    this.#inlineMessageId = answer.inlineMessageId;
    this.#throttle.touch();
    this.#lastPublishedText = answer.text;
    if (this.#throttle.dirty) this.scheduleDraft(true);
  }

  public setProgress(progress: ProgressSnapshot): void {
    if (this.#lifecycle.closed) return;
    this.#progress = progress;
    this.scheduleDraft();
  }

  public appendFinal(delta: string): void {
    if (this.#lifecycle.closed) return;
    this.#finalText += delta;
    this.scheduleDraft();
  }

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    await this.#lifecycle.run(async () => await this.finish(text, attachments));
  }

  public async fail(message: string): Promise<void> {
    await this.complete(`Codex error: ${message}`);
  }

  private async finish(text: string, attachments: readonly OutboundAttachment[]): Promise<void> {
    this.#throttle.clear();
    await this.#throttle.settle();
    const attachmentNote =
      attachments.length === 0
        ? ""
        : `Generated files can only be attached in a direct chat with this bot: ${attachments
            .map((attachment) => safeFileName(attachment.filename, "attachment"))
            .join(", ")}${text.length === 0 ? "" : "\n\n"}`;
    const finalText = attachmentNote + text;
    if (this.#inlineMessageId === undefined) {
      const answer = await this.#responder.answer(finalText);
      this.#inlineMessageId = answer.inlineMessageId;
      this.#lastPublishedText = answer.text;
      return;
    }
    if (finalText !== this.#lastPublishedText) {
      this.#lastPublishedText = await this.#responder.edit(this.#inlineMessageId, finalText);
    }
  }

  private scheduleDraft(immediate = false): void {
    if (this.#lifecycle.closed) return;
    if (this.#inlineMessageId === undefined) {
      // No inline message yet; start() re-schedules once the query is answered.
      this.#throttle.markDirty();
      return;
    }
    this.#throttle.schedule(immediate);
  }

  private async flushDraft(): Promise<void> {
    const inlineMessageId = this.#inlineMessageId;
    if (this.#lifecycle.closed || inlineMessageId === undefined) return;
    const preview = this.preview();
    if (preview === this.#lastPublishedText) return;
    this.#lastPublishedText = await this.#responder.edit(inlineMessageId, preview);
  }

  private preview(): string {
    const progress = formatThinkingBlock(this.#progress);
    if (this.#finalText.length === 0) return `${progress}\n\n▌`;
    const available = Math.max(0, 8_000 - progress.length - 3);
    const finalText = available === 0 ? "" : this.#finalText.slice(-available);
    return `${progress}\n\n${finalText}▌`;
  }
}

class TelegramReplyStream implements OutboundStream {
  readonly #draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #finalText = "";
  #draftMode: "rich" | "plain" | "none";
  #hasPublishedContent = false;
  #typingTimer: NodeJS.Timeout | undefined;
  readonly #lifecycle = new CompletionGuard();
  readonly #api: Api;
  readonly #chat: Chat;
  readonly #route: TelegramReplyRoute;
  readonly #logger: Logger;
  readonly #throttle = new DraftThrottle(250, async () => await this.flushDraft(), {
    onError: (error: unknown) => {
      this.#logger.debug("Telegram draft update failed", {
        error: errorMessage(error),
      });
    },
    immediateAfterFlush: (): boolean => !this.#hasPublishedContent,
  });

  public constructor(api: Api, chat: Chat, route: TelegramReplyRoute, logger: Logger) {
    this.#api = api;
    this.#chat = chat;
    this.#route = route;
    this.#logger = logger;
    this.#draftMode =
      chat.type === "private" && route.destination.kind !== "directMessagesTopic" ? "rich" : "none";
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (initialProgress !== undefined) this.#progress = initialProgress;
    if (this.#draftMode === "none") {
      this.startTyping();
      return;
    }
    this.#throttle.schedule(true);
    await this.#throttle.settle();
  }

  public setProgress(progress: ProgressSnapshot): void {
    this.#progress = progress;
    this.scheduleDraft(!this.#hasPublishedContent);
  }

  public appendFinal(delta: string): void {
    this.#finalText += delta;
    this.scheduleDraft(!this.#hasPublishedContent);
  }

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    await this.#lifecycle.run(async () => {
      this.clearTimers();
      await this.#throttle.settle();
      if (text.length > 0) {
        try {
          await sendFinalText(this.#api, this.#chat.id, this.#route, text, undefined, this.#logger);
        } catch (error) {
          this.#logger.warn("Telegram final text delivery failed", {
            error: errorMessage(error),
          });
        }
      }
      await sendTelegramAttachments(
        this.#api,
        this.#chat.id,
        this.#route,
        attachments,
        this.#logger,
      );
    });
  }

  public async fail(message: string): Promise<void> {
    await this.complete(`Codex error: ${message}`);
  }

  private scheduleDraft(immediate = false): void {
    if (this.#lifecycle.closed || this.#draftMode === "none") return;
    this.#throttle.schedule(immediate);
  }

  private async flushDraft(): Promise<void> {
    if (this.#lifecycle.closed || this.#draftMode === "none") return;
    if (this.#draftMode === "rich") {
      const richMessage: InputRichMessageWithoutUpload = {
        blocks: [
          {
            type: "thinking",
            text: formatThinkingBlock(this.#progress),
          },
          ...(this.#finalText.length === 0
            ? []
            : [{ type: "paragraph" as const, text: this.#finalText.slice(-8_000) }]),
        ],
      };
      try {
        await this.#api.sendRichMessageDraft(this.#chat.id, this.#draftId, richMessage, {
          ...activityParameters(this.#route),
        });
        this.#hasPublishedContent ||= this.hasContent();
        return;
      } catch {
        this.#draftMode = "plain";
      }
    }

    try {
      const preview = (this.#finalText || formatThinkingBlock(this.#progress)).slice(-4_096);
      await this.#api.sendMessageDraft(this.#chat.id, this.#draftId, preview, {
        ...activityParameters(this.#route),
      });
      this.#hasPublishedContent ||= this.hasContent();
    } catch {
      this.#draftMode = "none";
      this.startTyping();
    }
  }

  private hasContent(): boolean {
    return (
      this.#finalText.length > 0 ||
      this.#progress.summary !== undefined ||
      this.#progress.message !== undefined ||
      this.#progress.actions.length > 0 ||
      this.#progress.plan.length > 0
    );
  }

  private startTyping(): void {
    if (this.#route.destination.kind === "directMessagesTopic") return;
    const send = (): void => {
      void this.#api
        .sendChatAction(this.#chat.id, "typing", { ...activityParameters(this.#route) })
        .catch(() => undefined);
    };
    send();
    if (this.#typingTimer === undefined) {
      this.#typingTimer = setInterval(send, 4_000);
      this.#typingTimer.unref();
    }
  }

  private clearTimers(): void {
    this.#throttle.clear();
    if (this.#typingTimer !== undefined) clearInterval(this.#typingTimer);
    this.#typingTimer = undefined;
  }
}

async function sendTelegramAttachments(
  api: Api,
  chatId: number,
  route: TelegramReplyRoute,
  attachments: readonly OutboundAttachment[],
  logger: Logger,
): Promise<readonly number[]> {
  const messageIds: number[] = [];
  const failed: string[] = [];
  for (const attachment of attachments) {
    const messageId = await sendTelegramAttachment(api, chatId, route, attachment, logger);
    if (messageId === undefined) failed.push(safeFileName(attachment.filename, "attachment"));
    else messageIds.push(messageId);
  }
  if (failed.length === 0) return messageIds;

  const message = `Could not send ${failed.join(", ")} as ${failed.length === 1 ? "an attachment" : "attachments"}.`;
  try {
    for (const chunk of splitTelegramText(message)) {
      const sent = await api.sendMessage(chatId, chunk, telegramSendParameters(route));
      messageIds.push(sent.message_id);
    }
  } catch (error) {
    logger.warn("Telegram attachment failure notice could not be sent", {
      error: errorMessage(error),
    });
  }
  return messageIds;
}

async function sendTelegramAttachment(
  api: Api,
  chatId: number,
  route: TelegramReplyRoute,
  attachment: OutboundAttachment,
  logger: Logger,
): Promise<number | undefined> {
  const filename = safeFileName(attachment.filename, "attachment");
  const input = (): InputFile => new InputFile(attachment.path, filename);
  const params = telegramSendParameters(route);
  const kind = telegramAttachmentKind(attachment.path);

  try {
    switch (kind) {
      case "photo":
        return (await api.sendPhoto(chatId, input(), params)).message_id;
      case "animation":
        return (await api.sendAnimation(chatId, input(), params)).message_id;
      case "video":
        return (await api.sendVideo(chatId, input(), params)).message_id;
      case "audio":
        return (await api.sendAudio(chatId, input(), params)).message_id;
      case "document":
        return (await api.sendDocument(chatId, input(), params)).message_id;
    }
  } catch (error) {
    let uploadError = error;
    if (kind !== "document") {
      logger.debug("Native Telegram attachment failed; using document", {
        filename,
        error: errorMessage(error),
      });
      try {
        return (await api.sendDocument(chatId, input(), params)).message_id;
      } catch (fallbackError) {
        uploadError = fallbackError;
      }
    }
    logger.warn("Telegram attachment upload failed", {
      filename,
      error: errorMessage(uploadError),
    });
  }
  return undefined;
}

type TelegramAttachmentKind = "photo" | "animation" | "video" | "audio" | "document";

function telegramAttachmentKind(path: string): TelegramAttachmentKind {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
    case ".png":
      return "photo";
    case ".gif":
      return "animation";
    case ".mp4":
      return "video";
    case ".mp3":
    case ".m4a":
      return "audio";
    default:
      return "document";
  }
}

export function splitTelegramText(text: string, limit = 4_096): readonly string[] {
  return splitMessageText(text, limit);
}

function truncateTelegramText(text: string, limit = 4_096): string {
  return truncate(text, limit);
}
