import {
  type AnyThreadChannel,
  type ButtonInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { DiscordConfig } from "../../config/env.js";
import {
  botCommands,
  conversationScopedCommands,
  instanceAdminCommands,
} from "../../core/bridge.js";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundMessage,
  MessageHandler,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../../core/channel.js";
import { type Deferred, deferred } from "../../shared/async.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { type CodexConfigAccess, DiscordConfigUi, discordConfigActionPrefix } from "./config-ui.js";
import {
  discordDisplayName,
  discordTextContent,
  discordThreadName,
  formatDiscordThreadContext,
  hasDiscordMedia,
  normalizeDiscordMessage,
  parseDiscordCommand,
  routeDiscordMessage,
} from "./message.js";
import {
  discordDeliveryTarget,
  discordMessageReference,
  parseDiscordDeliveryTarget,
} from "./references.js";
import {
  choicePromptText,
  choiceRows,
  type DiscordMessagingApi,
  DiscordResponder,
  decodeDiscordCommandId,
  disabledChoiceRows,
  publishDiscordMessage,
} from "./reply.js";

interface PendingChoice {
  readonly userId: string;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
  readonly channelId: string;
  readonly messageId: string;
  readonly baseText: string;
  readonly token: string;
}

interface DiscordReplyRoute {
  readonly channelId: string;
  readonly replyToMessageId?: string;
}

const recentEventLimit = 1_000;
const engagedThreadLimit = 500;
const choiceTimeoutMs = 5 * 60 * 1_000;

export class DiscordChannel implements MessagingChannel {
  public readonly name = "discord";
  readonly #client: Client;
  readonly #api: DiscordMessagingApi;
  readonly #botToken: string;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #adminUserIds: ReadonlySet<string> | undefined;
  readonly #logger: Logger;
  readonly #configUi: DiscordConfigUi | undefined;
  readonly #pendingChoices = new Map<string, PendingChoice>();
  readonly #recentEvents = new Set<string>();
  readonly #engagedThreads = new Set<string>();
  #handler: MessageHandler | undefined;
  #botUserId: string | undefined;

  public constructor(config: DiscordConfig, logger: Logger, configAccess?: CodexConfigAccess) {
    this.#botToken = config.botToken;
    this.#allowedUserIds = config.allowedUserIds;
    this.#adminUserIds = config.adminUserIds;
    this.#logger = logger;
    this.#client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false,
    });
    this.#api = discordMessagingApi(this.#client);
    this.#configUi =
      configAccess === undefined
        ? undefined
        : new DiscordConfigUi(
            this.#api,
            configAccess,
            logger.child({ component: "discord-config" }),
          );
    this.#client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.#logger.error("Discord message handling failed", error, { messageId: message.id });
      });
    });
    this.#client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch(async (error: unknown) => {
        this.#logger.error("Discord interaction handling failed", error, {
          interactionId: interaction.id,
        });
        await this.replyInteractionError(interaction, error);
      });
    });
    this.#client.on(Events.Error, (error) => {
      this.#logger.error("Discord client error", error);
    });
    this.#client.on(Events.ShardError, (error, shardId) => {
      this.#logger.error("Discord gateway shard error", error, { shardId });
    });
    this.#client.on(Events.Warn, (warning) => {
      this.#logger.debug("Discord client warning", { warning });
    });
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    const ready = new Promise<Client<true>>((resolve) => {
      this.#client.once(Events.ClientReady, resolve);
    });
    await this.#client.login(this.#botToken);
    const client = this.#client.isReady() ? this.#client : await ready;
    this.#botUserId = client.user.id;
    await this.registerCommands(client).catch((error: unknown) => {
      this.#logger.warn("Could not register Discord application commands", {
        error: errorMessage(error),
      });
    });
    this.#logger.info("Discord bot connected", {
      botUserId: client.user.id,
      botName: client.user.username,
      guilds: client.guilds.cache.size,
      authorization: "allowlist",
    });
  }

  public isAuthorized(principal: ProviderReference): boolean {
    return (
      principal.provider === this.name &&
      principal.resource === "user" &&
      this.#allowedUserIds.has(principal.id)
    );
  }

  public async publish(
    targetReference: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const channelId = parseDiscordDeliveryTarget(targetReference);
    const messageIds = await publishDiscordMessage(this.#api, channelId, message, this.#logger);
    return {
      publishedMessages: messageIds.map((messageId) =>
        discordMessageReference(channelId, messageId),
      ),
    };
  }

  public async stop(): Promise<void> {
    this.#handler = undefined;
    const pending = [...this.#pendingChoices.values()];
    this.#pendingChoices.clear();
    for (const choice of pending) {
      clearTimeout(choice.timer);
      choice.result.resolve("decline");
    }
    await Promise.allSettled(
      pending.map(async (choice) => {
        await this.finishChoice(choice, "Request cancelled");
      }),
    );
    await this.#client.destroy();
  }

  private async registerCommands(client: Client<true>): Promise<void> {
    const command = new SlashCommandBuilder()
      .setName("wirebot")
      .setDescription("Talk to and manage Wirebot");
    for (const entry of botCommands) {
      command.addSubcommand((subcommand) =>
        subcommand.setName(entry.command).setDescription(entry.menuDescription),
      );
    }
    const commandData = command.toJSON();
    const existing = (await client.application.commands.fetch()).find(
      (applicationCommand) => applicationCommand.name === commandData.name,
    );
    if (existing === undefined) await client.application.commands.create(commandData);
    else await client.application.commands.edit(existing.id, commandData);
  }

  private async handleMessage(message: Message): Promise<void> {
    const handler = this.#handler;
    const botUserId = this.#botUserId;
    if (handler === undefined || botUserId === undefined) return;
    if (this.wasRecentlyProcessed(`message:${message.channelId}:${message.id}`)) return;
    const route = routeDiscordMessage(message, botUserId);
    if (route === undefined) return;
    const userId = message.author.id;
    if (!this.#allowedUserIds.has(userId)) {
      this.#logger.warn("Ignored Discord message from unauthorized user", { userId });
      return;
    }

    const rawText = discordTextContent(message, botUserId);
    const displayName = discordDisplayName(message);
    if (rawText.length === 0 && hasDiscordMedia(message)) {
      const responder = this.responder(message.channelId, userId, message.id, displayName);
      await responder.sendText(
        "This Discord connector is text-only. Add a text description or paste the relevant content into your message.",
      );
      return;
    }

    const command = parseDiscordCommand(rawText);
    const replyRoute = await this.replyChannel(message, command?.name);
    if (replyRoute === undefined) return;
    const responder = this.responder(
      replyRoute.channelId,
      userId,
      replyRoute.replyToMessageId,
      displayName,
    );
    const baseText = normalizeDiscordMessage(message, botUserId);
    if (baseText.length === 0) return;
    const text = await this.withThreadContext(message, botUserId, command, baseText);
    const inbound: InboundMessage = {
      id: message.id,
      address: {
        channel: this.name,
        key: `discord:${replyRoute.channelId}`,
        isPrivate: route.isPrivate,
        isGuest: false,
        deliveryTarget: discordDeliveryTarget(replyRoute.channelId),
      },
      reference: discordMessageReference(message.channelId, message.id),
      ...(message.reference?.messageId === undefined
        ? {}
        : {
            replyTo: discordMessageReference(
              message.reference.channelId,
              message.reference.messageId,
            ),
          }),
      sender: { id: userId, displayName },
      text,
      ...(command === undefined ? {} : { command }),
      attachments: [],
      responder,
    };
    await this.dispatch(inbound, userId, replyRoute.channelId);
  }

  private async replyChannel(
    message: Message,
    commandName: string | undefined,
  ): Promise<DiscordReplyRoute | undefined> {
    if (!message.inGuild()) {
      return { channelId: message.channelId, replyToMessageId: message.id };
    }
    if (message.channel.isThread()) {
      if (!this.canSendInThread(message.channel)) {
        await this.notifyThreadRequired(message);
        return undefined;
      }
      return { channelId: message.channelId, replyToMessageId: message.id };
    }
    if (commandName !== undefined && instanceAdminCommands.has(commandName)) {
      return { channelId: message.channelId, replyToMessageId: message.id };
    }
    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.GuildAnnouncement
    ) {
      await this.notifyThreadRequired(message);
      return undefined;
    }
    try {
      const existing = message.thread;
      if (existing === null) {
        const clientUser = this.#client.user;
        const permissions = clientUser === null ? null : message.channel.permissionsFor(clientUser);
        if (
          permissions?.has([
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.SendMessagesInThreads,
          ]) !== true
        ) {
          await this.notifyThreadRequired(message);
          return undefined;
        }
      }
      const thread =
        existing ??
        (await message.startThread({
          name: discordThreadName(discordTextContent(message, this.#botUserId ?? "")),
          reason: "Keep this Wirebot task isolated from the surrounding channel",
        }));
      if (!this.canSendInThread(thread)) {
        await this.notifyThreadRequired(message);
        return undefined;
      }
      this.rememberEngagedThread(thread.id);
      return { channelId: thread.id };
    } catch (error) {
      this.#logger.warn("Could not create an isolated Discord thread", {
        channelId: message.channelId,
        error: errorMessage(error),
      });
      await this.notifyThreadRequired(message);
      return undefined;
    }
  }

  private canSendInThread(thread: AnyThreadChannel): boolean {
    return thread.sendable;
  }

  private async notifyThreadRequired(message: Message): Promise<void> {
    const content =
      "I need a usable Discord thread to keep Codex tasks isolated. Grant Create Public Threads and Send Messages in Threads, or mention me inside an unlocked thread where I can reply.";
    const privateThread =
      message.channel.isThread() && message.channel.type === ChannelType.PrivateThread;
    const target =
      message.channel.isThread() && !privateThread ? message.channel.parent : undefined;
    const send = privateThread
      ? message.author.send({
          content: `I can't answer in that private thread. ${content}`,
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressEmbeds,
        })
      : target?.isTextBased() === true && !target.isVoiceBased() && target.isSendable()
        ? target.send({
            content: `I can't answer in <#${message.channelId}>. ${content}`,
            allowedMentions: { parse: [], repliedUser: false },
            flags: MessageFlags.SuppressEmbeds,
          })
        : message.reply({
            content,
            allowedMentions: { parse: [], repliedUser: false },
            flags: MessageFlags.SuppressEmbeds,
          });
    await send
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#logger.warn("Could not deliver Discord thread permission guidance", {
          channelId: message.channelId,
          error: errorMessage(error),
        });
      });
  }

  private async withThreadContext(
    message: Message,
    botUserId: string,
    command: Readonly<{ name: string; args: string }> | undefined,
    text: string,
  ): Promise<string> {
    if (
      !message.channel.isThread() ||
      message.channel.ownerId === botUserId ||
      this.#engagedThreads.has(message.channelId) ||
      command !== undefined
    ) {
      return text;
    }
    try {
      const history = await message.channel.messages.fetch({ before: message.id, limit: 100 });
      this.rememberEngagedThread(message.channelId);
      const context = formatDiscordThreadContext(
        [...history.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp),
        message.id,
        botUserId,
      );
      return context === undefined
        ? text
        : `[Context — earlier messages in this Discord thread:]\n${context}\n[End of thread context]\n\n${text}`;
    } catch (error) {
      this.#logger.warn("Could not fetch Discord thread context", {
        channelId: message.channelId,
        error: errorMessage(error),
      });
      return text;
    }
  }

  private async dispatch(
    inbound: InboundMessage,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const handler = this.#handler;
    if (handler === undefined) return;
    const command = inbound.command;
    this.#logger.info("Discord message received", {
      userId,
      userName: inbound.sender.displayName,
      conversation: inbound.address.key,
      ...(command === undefined ? {} : { command: command.name }),
      chars: inbound.text.length,
    });
    if (command !== undefined && instanceAdminCommands.has(command.name) && !this.isAdmin(userId)) {
      await inbound.responder.sendText(
        "This command changes Wirebot for everyone using it and is limited to its admins.",
      );
      return;
    }
    if (command?.name === "config" && this.#configUi !== undefined) {
      if (!inbound.address.isPrivate) {
        await inbound.responder.sendText("Open Codex settings in a direct message with the bot.");
        return;
      }
      await this.#configUi.open(channelId);
      return;
    }
    try {
      await handler(inbound);
    } catch (error) {
      this.#logger.error("Discord message handler failed", error, { messageId: inbound.id });
      await inbound.responder
        .sendText(`Bridge error: ${errorMessage(error)}`)
        .catch(() => undefined);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (this.wasRecentlyProcessed(`interaction:${interaction.id}`)) return;
    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
      return;
    }
    if (interaction.isButton()) {
      await this.handleButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) await this.handleSelect(interaction);
  }

  private async replyInteractionError(interaction: Interaction, error: unknown): Promise<void> {
    if (!interaction.isRepliable()) return;
    const content = `Bridge error: ${errorMessage(error)}`.slice(0, 2_000);
    if (interaction.isMessageComponent()) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: [] }).catch(() => undefined);
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== "wirebot") return;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    if (channelId === null) return;
    if (!this.#allowedUserIds.has(userId)) {
      await interaction.reply({
        content: "You are not on this Wirebot instance's allow list.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const name = interaction.options.getSubcommand();
    if (instanceAdminCommands.has(name) && !this.isAdmin(userId)) {
      await interaction.reply({
        content: "This command changes Wirebot for everyone using it and is limited to its admins.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isPrivate = interaction.channel?.isDMBased() === true;
    const isThread = interaction.channel?.isThread() === true;
    if (!isPrivate && !isThread && conversationScopedCommands.has(name)) {
      await interaction.reply({
        content:
          "In servers each Discord thread is its own Codex conversation. Run this command in a Wirebot thread or a direct message.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (name === "config" && this.#configUi !== undefined) {
      if (!isPrivate) {
        await interaction.reply({
          content: "Open Codex settings in a direct message with the bot.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.#configUi.open(channelId);
      await interaction.editReply("Opened Codex settings below.");
      return;
    }

    await interaction.deferReply();
    const command = { name, args: "" };
    const initialReply = async (
      content: string,
      components?: Parameters<DiscordMessagingApi["postMessage"]>[0]["components"],
    ): Promise<string> => {
      const sent = await interaction.editReply({
        content,
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds,
        ...(components === undefined ? {} : { components }),
      });
      return sent.id;
    };
    const responder = new DiscordResponder(
      this.#api,
      channelId,
      userId,
      this.requestChoice,
      this.#logger.child({
        userId,
        userName: interaction.user.globalName ?? interaction.user.username,
        conversation: `discord:${channelId}`,
      }),
      undefined,
      initialReply,
    );
    const inbound: InboundMessage = {
      id: `command:${interaction.id}`,
      address: {
        channel: this.name,
        key: `discord:${channelId}`,
        isPrivate,
        isGuest: false,
        deliveryTarget: discordDeliveryTarget(channelId),
      },
      sender: {
        id: userId,
        displayName: interaction.user.globalName ?? interaction.user.username,
      },
      text: `/wirebot ${name}`,
      command,
      attachments: [],
      responder,
    };
    await this.dispatch(inbound, userId, channelId);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    if (interaction.customId.startsWith("wirebot_choice:")) {
      await this.handleChoice(interaction);
      return;
    }
    if (interaction.customId === `${discordConfigActionPrefix}:back`) {
      if (!(await this.requireConfigAdmin(interaction))) return;
      await this.#configUi?.showOverview(interaction.channelId, interaction.message.id);
      return;
    }
    const command = decodeDiscordCommandId(interaction.customId);
    if (command !== undefined) await this.handleCommandButton(interaction, command);
  }

  private async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!interaction.customId.startsWith(`${discordConfigActionPrefix}:`)) return;
    await interaction.deferUpdate();
    if (!(await this.requireConfigAdmin(interaction))) return;
    const selected = interaction.values[0];
    if (selected === undefined) return;
    if (interaction.customId === `${discordConfigActionPrefix}:field`) {
      await this.#configUi?.handleField(interaction.channelId, interaction.message.id, selected);
      return;
    }
    const field = interaction.customId.slice(`${discordConfigActionPrefix}:value:`.length);
    await this.#configUi?.handleValue(
      interaction.channelId,
      interaction.message.id,
      field,
      selected,
    );
  }

  private async handleChoice(interaction: ButtonInteraction): Promise<void> {
    const match = /^wirebot_choice:([0-9a-f]{16}):(\d+)$/u.exec(interaction.customId);
    const token = match?.[1];
    const index = Number(match?.[2]);
    const pending = token === undefined ? undefined : this.#pendingChoices.get(token);
    if (pending === undefined || pending.userId !== interaction.user.id) {
      await interaction
        .followUp({ content: "This choice has expired.", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }
    const selected = pending.options[index];
    if (selected === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingChoices.delete(pending.token);
    pending.result.resolve(selected.id);
    await this.#api
      .updateMessage({
        channelId: pending.channelId,
        messageId: pending.messageId,
        content: `${pending.baseText}\n\n→ ${selected.label}`.slice(0, 2_000),
        components: [],
      })
      .catch(() => undefined);
  }

  private async handleCommandButton(
    interaction: ButtonInteraction,
    command: Readonly<{ name: string; args: string }>,
  ): Promise<void> {
    const handler = this.#handler;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    if (handler === undefined) return;
    if (!this.#allowedUserIds.has(userId)) {
      await interaction
        .followUp({
          content: "You are not on this Wirebot instance's allow list.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }
    if (instanceAdminCommands.has(command.name) && !this.isAdmin(userId)) {
      await interaction
        .followUp({
          content:
            "This command changes Wirebot for everyone using it and is limited to its admins.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }
    await this.#api
      .updateMessage({
        channelId,
        messageId: interaction.message.id,
        content: interaction.message.content,
        components: [],
      })
      .catch(() => undefined);
    const isPrivate = interaction.channel?.isDMBased() === true;
    const displayName = interaction.user.globalName ?? interaction.user.username;
    const responder = this.responder(channelId, userId, interaction.message.id, displayName);
    const inbound: InboundMessage = {
      id: `action:${interaction.id}`,
      address: {
        channel: this.name,
        key: `discord:${channelId}`,
        isPrivate,
        isGuest: false,
        deliveryTarget: discordDeliveryTarget(channelId),
      },
      reference: discordMessageReference(channelId, interaction.message.id),
      sender: { id: userId, displayName },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    await this.dispatch(inbound, userId, channelId);
  }

  private async requireConfigAdmin(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<boolean> {
    const allowed =
      interaction.channel?.isDMBased() === true &&
      this.#allowedUserIds.has(interaction.user.id) &&
      this.isAdmin(interaction.user.id);
    if (!allowed) {
      await interaction
        .followUp({
          content: "Codex settings are available to Wirebot admins in direct messages.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
    return allowed;
  }

  private readonly requestChoice = async (
    channelId: string,
    userId: string,
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> => {
    const isAborted = (): boolean => signal?.aborted === true;
    if (options.length === 0 || isAborted()) return "decline";
    const visibleOptions = options.slice(0, 25);
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const baseText = choicePromptText(prompt, visibleOptions);
    const messageId = await this.#api.postMessage({
      channelId,
      content: baseText,
      components: choiceRows(token, visibleOptions),
    });
    const result = deferred<string>();
    const timer = setTimeout(() => {
      const pending = this.#pendingChoices.get(token);
      if (pending === undefined) return;
      this.#pendingChoices.delete(token);
      pending.result.resolve("decline");
      void this.finishChoice(pending, "Request expired");
    }, choiceTimeoutMs);
    timer.unref();
    const pending: PendingChoice = {
      userId,
      options: visibleOptions,
      result,
      timer,
      channelId,
      messageId,
      baseText,
      token,
    };
    this.#pendingChoices.set(token, pending);
    const onAbort = (): void => {
      const active = this.#pendingChoices.get(token);
      if (active === undefined) return;
      clearTimeout(active.timer);
      this.#pendingChoices.delete(token);
      active.result.resolve("decline");
      void this.finishChoice(active, "Request cancelled");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) onAbort();
    try {
      return await result.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  private async finishChoice(choice: PendingChoice, status: string): Promise<void> {
    await this.#api
      .updateMessage({
        channelId: choice.channelId,
        messageId: choice.messageId,
        content: `${choice.baseText}\n\n→ ${status}`.slice(0, 2_000),
        components: disabledChoiceRows(choice.token, choice.options),
      })
      .catch(() => undefined);
  }

  private responder(
    channelId: string,
    userId: string,
    replyToMessageId: string | undefined,
    displayName: string,
  ): DiscordResponder {
    return new DiscordResponder(
      this.#api,
      channelId,
      userId,
      this.requestChoice,
      this.#logger.child({
        userId,
        userName: displayName,
        conversation: `discord:${channelId}`,
      }),
      replyToMessageId,
    );
  }

  private isAdmin(userId: string): boolean {
    return this.#adminUserIds === undefined || this.#adminUserIds.has(userId);
  }

  private wasRecentlyProcessed(key: string): boolean {
    if (this.#recentEvents.has(key)) return true;
    this.#recentEvents.add(key);
    while (this.#recentEvents.size > recentEventLimit) {
      const oldest = this.#recentEvents.values().next().value;
      if (oldest === undefined) break;
      this.#recentEvents.delete(oldest);
    }
    return false;
  }

  private rememberEngagedThread(threadId: string): void {
    this.#engagedThreads.delete(threadId);
    this.#engagedThreads.add(threadId);
    while (this.#engagedThreads.size > engagedThreadLimit) {
      const oldest = this.#engagedThreads.values().next().value;
      if (oldest === undefined) break;
      this.#engagedThreads.delete(oldest);
    }
  }
}

function discordMessagingApi(client: Client): DiscordMessagingApi {
  const channel = async (channelId: string) => {
    const resolved = await client.channels.fetch(channelId);
    if (
      resolved === null ||
      !resolved.isTextBased() ||
      resolved.isVoiceBased() ||
      !resolved.isSendable()
    ) {
      throw new Error(`Discord channel ${channelId} is not text-sendable`);
    }
    return resolved;
  };
  return {
    postMessage: async (options) => {
      const target = await channel(options.channelId);
      const sent = await target.send({
        content: options.content,
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds,
        ...(options.components === undefined ? {} : { components: options.components }),
        ...(options.replyToMessageId === undefined
          ? {}
          : {
              reply: {
                messageReference: options.replyToMessageId,
                failIfNotExists: false,
              },
            }),
      });
      return sent.id;
    },
    updateMessage: async (options) => {
      const target = await channel(options.channelId);
      const message = await target.messages.fetch(options.messageId);
      await message.edit({
        content: options.content,
        allowedMentions: { parse: [], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds,
        ...(options.components === undefined ? {} : { components: options.components }),
      });
    },
    sendTyping: async (channelId) => {
      const target = await channel(channelId);
      await target.sendTyping();
    },
  };
}
