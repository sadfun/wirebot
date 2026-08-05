import { join } from "node:path";
import { type RunnerHandle, run } from "@grammyjs/runner";
import { type Api, Bot } from "grammy";
import type {
  BotCommand,
  CallbackQuery,
  Chat,
  MenuButton,
  Message,
  Update,
  User,
} from "grammy/types";
import { botCommands } from "../../core/bridge.js";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundAttachment,
  InboundCommand,
  InboundMessage,
  MessageHandler,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../../core/channel.js";
import { type Deferred, deferred } from "../../shared/async.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { downloadTelegramFile, TelegramFileDownloadError } from "./file.js";
import {
  describeTelegramFile,
  isTelegramTopicLifecycleMessage,
  normalizeTelegramMessage,
} from "./message.js";
import {
  parseTelegramDeliveryTarget,
  telegramDeliveryTarget,
  telegramMessageReference,
} from "./references.js";
import {
  type ChoiceRequester,
  decodeCommandCallback,
  publishTelegramMessage,
  TelegramGuestResponder,
  TelegramResponder,
  telegramSendParameters,
} from "./reply.js";
import {
  matchTelegramCommand,
  routeTelegramMessage,
  type TelegramIncomingRoute,
  type TelegramReplyRoute,
} from "./route.js";

interface PendingChoice {
  readonly userId: number;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
  readonly chatId: number;
  readonly messageId: number;
}

interface GuestUpdateWithReferences extends Update {
  readonly reference_messages?: readonly Message[];
}

interface GuestMessageWithReferences extends Message {
  readonly reference_messages?: readonly Message[];
}

export const telegramBotCommands: readonly BotCommand[] = botCommands.map((entry) => ({
  command: entry.command,
  description: entry.menuDescription,
}));

export interface TelegramChannelOptions {
  /** Narrow E2E-only exception; ordinary bot senders remain denied by default. */
  readonly allowedBotUserIds?: ReadonlySet<number>;
}

export function telegramMenuButton(miniAppUrl: string | undefined): MenuButton {
  if (miniAppUrl === undefined) {
    return { type: "commands" };
  }
  return {
    type: "web_app",
    text: "Settings",
    web_app: { url: miniAppUrl },
  };
}

type TelegramMenuButtonApi = Pick<Api, "getChatMenuButton" | "setChatMenuButton">;

function menuButtonsMatch(actual: MenuButton, expected: MenuButton): boolean {
  if (actual.type !== expected.type) return false;
  if (actual.type !== "web_app" || expected.type !== "web_app") return true;
  return actual.text === expected.text && actual.web_app.url === expected.web_app.url;
}

export async function reconcileTelegramMenuButton(
  api: TelegramMenuButtonApi,
  allowedUserIds: ReadonlySet<number>,
  miniAppUrl: string | undefined,
  logger: Logger,
): Promise<void> {
  const menuButton = telegramMenuButton(miniAppUrl);
  const chatIds = [...allowedUserIds].toSorted((left, right) => left - right);
  const scopes: readonly (number | undefined)[] = [undefined, ...chatIds];
  let configuredScopes = 0;

  for (const chatId of scopes) {
    const parameters =
      chatId === undefined
        ? { menu_button: menuButton }
        : { chat_id: chatId, menu_button: menuButton };
    try {
      await api.setChatMenuButton(parameters);
      const actual = await api.getChatMenuButton(chatId === undefined ? {} : { chat_id: chatId });
      if (!menuButtonsMatch(actual, menuButton)) {
        logger.warn("Telegram returned an unexpected menu button after registration", {
          scope: chatId === undefined ? "default" : "private-chat",
          ...(chatId === undefined ? {} : { chatId }),
          expectedType: menuButton.type,
          actualType: actual.type,
        });
        continue;
      }
      configuredScopes += 1;
    } catch (error) {
      logger.warn("Could not register the Telegram Mini App menu button", {
        scope: chatId === undefined ? "default" : "private-chat",
        ...(chatId === undefined ? {} : { chatId }),
        error: errorMessage(error),
      });
    }
  }

  logger.info("Telegram menu button registration reconciled", {
    miniAppEnabled: miniAppUrl !== undefined,
    configuredScopes,
    totalScopes: scopes.length,
  });
}

export class TelegramChannel implements MessagingChannel {
  public readonly name = "telegram";
  readonly #bot: Bot;
  readonly #allowedUserIds: ReadonlySet<number>;
  readonly #pollTimeout: number;
  readonly #apiRoot: string;
  readonly #token: string;
  readonly #attachmentDirectory: string;
  readonly #logger: Logger;
  readonly #miniAppUrl: string | undefined;
  readonly #allowedBotUserIds: ReadonlySet<number>;
  readonly #pendingChoices = new Map<string, PendingChoice>();
  #handler: MessageHandler | undefined;
  #runner: RunnerHandle | undefined;
  #botUsername: string | undefined;

  public constructor(
    token: string,
    apiRoot: string,
    allowedUserIds: ReadonlySet<number>,
    pollTimeout: number,
    attachmentDirectory: string,
    logger: Logger,
    miniAppUrl?: string,
    options: TelegramChannelOptions = {},
  ) {
    this.#token = token;
    this.#apiRoot = apiRoot;
    this.#allowedUserIds = allowedUserIds;
    this.#pollTimeout = pollTimeout;
    this.#attachmentDirectory = attachmentDirectory;
    this.#logger = logger;
    this.#miniAppUrl = miniAppUrl;
    this.#allowedBotUserIds = options.allowedBotUserIds ?? new Set();
    this.#bot = new Bot(token, { client: { apiRoot } });
    this.#bot.on("message", async (context) => {
      await this.handleMessage(context.message, false, context.api);
    });
    this.#bot.on("guest_message", async (context) => {
      const update = context.update as GuestUpdateWithReferences;
      const guestMessage = context.guestMessage as GuestMessageWithReferences;
      await this.handleMessage(
        guestMessage,
        true,
        context.api,
        update.reference_messages ?? guestMessage.reference_messages,
      );
    });
    this.#bot.on("callback_query:data", async (context) => {
      await this.handleCallback(context.callbackQuery, context.api);
    });
    this.#bot.catch((error) => {
      this.#logger.error("Telegram middleware failed", error.error, {
        updateId: error.ctx.update.update_id,
      });
    });
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    await this.#bot.init();
    const bot = this.#bot.botInfo;
    this.#botUsername = bot.username;
    this.#logger.info("Telegram bot connected through grammY", {
      username: bot.username,
      guestMode: bot.supports_guest_queries ?? false,
    });
    await this.#bot.api.setMyCommands(telegramBotCommands).catch((error: unknown) => {
      this.#logger.warn("Could not register Telegram commands", { error: errorMessage(error) });
    });
    await reconcileTelegramMenuButton(
      this.#bot.api,
      this.#allowedUserIds,
      this.#miniAppUrl,
      this.#logger,
    );

    this.#runner = run(this.#bot, {
      runner: {
        fetch: {
          timeout: this.#pollTimeout,
          allowed_updates: ["message", "guest_message", "callback_query"],
        },
        retryInterval: "exponential",
        silent: true,
      },
    });
  }

  public isAuthorized(principal: ProviderReference): boolean {
    if (principal.provider !== this.name || principal.resource !== "user") return false;
    if (!/^\d+$/u.test(principal.id)) return false;
    const userId = Number(principal.id);
    return Number.isSafeInteger(userId) && this.#allowedUserIds.has(userId);
  }

  public async stop(): Promise<void> {
    await this.#runner?.stop();
    for (const choice of this.#pendingChoices.values()) {
      clearTimeout(choice.timer);
      choice.result.resolve("decline");
    }
    this.#pendingChoices.clear();
  }

  public async publish(
    targetReference: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const target = parseTelegramDeliveryTarget(targetReference);
    const route: TelegramReplyRoute = { destination: target.destination };
    const messageIds = await publishTelegramMessage(
      this.#bot.api,
      target.chatId,
      route,
      message,
      this.#logger,
    );
    return {
      publishedMessages: messageIds.map((messageId) =>
        telegramMessageReference(target.chatId, messageId),
      ),
    };
  }

  private async handleMessage(
    message: Message,
    guest: boolean,
    api: Api,
    referenceMessages: readonly Message[] = [],
  ): Promise<void> {
    const sender = message.from;
    const handler = this.#handler;
    if (sender === undefined || handler === undefined) return;
    if (sender.is_bot && !this.#allowedBotUserIds.has(sender.id)) {
      this.#logger.debug("Ignored Telegram message from bot sender", { userId: sender.id });
      return;
    }
    if (!this.#allowedUserIds.has(sender.id)) {
      this.#logger.warn("Ignored Telegram message from unauthorized user", { userId: sender.id });
      return;
    }
    this.#logger.debug("Accepted Telegram message", {
      userId: sender.id,
      isBot: sender.is_bot,
      chatId: message.chat.id,
      messageId: message.message_id,
    });
    if (isTelegramTopicLifecycleMessage(message)) return;

    const guestQueryId = message.guest_query_id;
    if (guest && guestQueryId === undefined) return;
    const incomingRoute = guest ? undefined : routeTelegramMessage(message);
    if (!guest && incomingRoute === undefined) {
      this.#logger.warn("Ignored unroutable Telegram direct message", {
        chatId: message.chat.id,
        messageId: message.message_id,
      });
      return;
    }
    const commandMatch = matchTelegramCommand(message, this.#botUsername);
    if (commandMatch.kind === "otherBot") return;
    const command = commandMatch.kind === "command" ? commandMatch.command : undefined;
    const normalized =
      command !== undefined
        ? { text: message.text?.trim() ?? "", files: [] }
        : normalizeTelegramMessage(message, referenceMessages);
    const directory = join(this.#attachmentDirectory, crypto.randomUUID());
    const attachments: InboundAttachment[] = [];
    const failures: string[] = [];
    for (const [index, file] of normalized.files.entries()) {
      const description = describeTelegramFile(file);
      try {
        const path = await downloadTelegramFile(file, {
          api,
          apiRoot: this.#apiRoot,
          botToken: this.#token,
          directory,
          index,
        });
        attachments.push({
          kind: file.nativeImage ? "image" : file.voiceMessage === true ? "voice" : "file",
          path,
          description,
        });
      } catch (error) {
        this.#logger.warn("Could not download Telegram attachment", {
          messageId: message.message_id,
          description,
          error: errorMessage(error).replaceAll(this.#token, "<redacted>"),
        });
        const reason =
          error instanceof TelegramFileDownloadError
            ? error.userMessage
            : "Telegram could not download it; the cloud Bot API's 20 MB limit may apply";
        failures.push(`[${description} was not attached: ${reason}.]`);
      }
    }
    const text = [normalized.text, ...failures].filter((part) => part.length > 0).join("\n\n");
    if (guest) {
      const normalizedText = this.stripGuestMention(text);
      if (normalizedText.length === 0 || guestQueryId === undefined) return;
      const responder = new TelegramGuestResponder(api, guestQueryId);
      await this.invoke({
        id: `guest:${guestQueryId}`,
        address: {
          channel: this.name,
          key: `telegram:guest:${guestQueryId}`,
          isPrivate: message.chat.type === "private",
          isGuest: true,
        },
        sender: senderIdentity(sender),
        text: normalizedText,
        ...(command === undefined ? {} : { command }),
        attachments,
        responder,
      });
      return;
    }
    if (text.length === 0 || incomingRoute === undefined) return;
    await this.dispatch(api, message, incomingRoute, sender, String(message.message_id), {
      text,
      ...(command === undefined ? {} : { command }),
      attachments,
      replyToMessageId: message.reply_to_message?.message_id,
    });
  }

  private async dispatch(
    api: Api,
    message: Message,
    incomingRoute: TelegramIncomingRoute,
    from: User,
    inboundId: string,
    content: {
      readonly text: string;
      readonly command?: InboundCommand;
      readonly attachments: readonly InboundAttachment[];
      readonly replyToMessageId?: number | undefined;
    },
  ): Promise<void> {
    const responder = new TelegramResponder(
      api,
      message.chat,
      incomingRoute.reply,
      from.id,
      this.requestChoice,
      this.#logger,
    );
    await this.invoke({
      id: inboundId,
      address: {
        channel: this.name,
        key: `telegram:${message.chat.id}:${incomingRoute.conversationSuffix}`,
        isPrivate: message.chat.type === "private",
        isGuest: false,
        deliveryTarget: telegramDeliveryTarget(message.chat.id, incomingRoute.reply),
      },
      reference: telegramMessageReference(message.chat.id, message.message_id),
      ...(content.replyToMessageId === undefined
        ? {}
        : { replyTo: telegramMessageReference(message.chat.id, content.replyToMessageId) }),
      sender: senderIdentity(from),
      text: content.text,
      ...(content.command === undefined ? {} : { command: content.command }),
      attachments: content.attachments,
      responder,
    });
  }

  private async invoke(inbound: InboundMessage): Promise<void> {
    const handler = this.#handler;
    if (handler === undefined) return;
    try {
      await handler(inbound);
    } catch (error) {
      this.#logger.error("Telegram message handler failed", error, { messageId: inbound.id });
      await inbound.responder
        .sendText(`Bridge error: ${errorMessage(error)}`)
        .catch(() => undefined);
    }
  }

  private readonly requestChoice: ChoiceRequester = async (
    chat: Chat,
    route: TelegramReplyRoute,
    userId: number,
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> => {
    if (options.length === 0 || signal?.aborted === true) return "decline";
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const details = options
      .filter((option) => option.description !== undefined)
      .map((option) => `${option.label}: ${option.description}`)
      .join("\n");
    const body = details.length === 0 ? prompt : `${prompt}\n\n${details}`;
    const sent = await this.#bot.api.sendMessage(
      chat.id,
      body.length <= 4_096 ? body : `${body.slice(0, 4_095)}…`,
      {
        ...telegramSendParameters(route),
        reply_markup: {
          inline_keyboard: options.map((option, index) => [
            {
              text: option.label.slice(0, 64),
              callback_data: `cb:${token}:${index}`,
            },
          ]),
        },
      },
    );
    const result = deferred<string>();
    const timer = setTimeout(
      () => {
        this.#pendingChoices.delete(token);
        result.resolve("decline");
      },
      5 * 60 * 1_000,
    );
    timer.unref();
    this.#pendingChoices.set(token, {
      userId,
      options,
      result,
      timer,
      chatId: chat.id,
      messageId: sent.message_id,
    });
    const onAbort = (): void => {
      const pending = this.#pendingChoices.get(token);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pendingChoices.delete(token);
      pending.result.resolve("decline");
      void this.clearChoiceKeyboard(this.#bot.api, pending).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await result.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  private async handleCallback(query: CallbackQuery, api: Api): Promise<void> {
    if (!this.#allowedUserIds.has(query.from.id) || query.data === undefined) return;
    const command = decodeCommandCallback(query.data);
    if (command !== undefined) {
      await this.handleCommandCallback(query, command, api);
      return;
    }
    const match = /^cb:([0-9a-f]{16}):(\d+)$/.exec(query.data);
    if (match === null) return;
    const token = match[1];
    const index = Number(match[2]);
    if (token === undefined) return;
    const pending = this.#pendingChoices.get(token);
    if (pending === undefined || pending.userId !== query.from.id) {
      await api.answerCallbackQuery(query.id, { text: "This choice has expired." });
      return;
    }
    const selected = pending.options[index];
    if (selected === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingChoices.delete(token);
    pending.result.resolve(selected.id);
    await Promise.allSettled([
      api.answerCallbackQuery(query.id, { text: selected.label.slice(0, 200) }),
      this.clearChoiceKeyboard(api, pending),
    ]);
  }

  private async clearChoiceKeyboard(api: Api, pending: PendingChoice): Promise<void> {
    await api.editMessageReplyMarkup(pending.chatId, pending.messageId, {
      reply_markup: { inline_keyboard: [] },
    });
  }

  private async handleCommandCallback(
    query: CallbackQuery,
    command: InboundCommand,
    api: Api,
  ): Promise<void> {
    const message = query.message;
    if (this.#handler === undefined || message === undefined || !("date" in message)) {
      await api.answerCallbackQuery(query.id, { text: "This action is unavailable." });
      return;
    }
    const incomingRoute = routeTelegramMessage(message);
    if (incomingRoute === undefined) {
      await api.answerCallbackQuery(query.id, { text: "This action is unavailable." });
      return;
    }
    await api.answerCallbackQuery(query.id, { text: "Opening scheduled run…" });
    await this.dispatch(api, message, incomingRoute, query.from, `callback:${query.id}`, {
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
    });
  }

  private stripGuestMention(text: string): string {
    const username = this.#botUsername;
    if (username === undefined) return text;
    return text.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
  }
}

function senderIdentity(user: User): Readonly<{ id: string; displayName: string }> {
  return {
    id: String(user.id),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" "),
  };
}
