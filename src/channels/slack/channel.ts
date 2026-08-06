import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import type { SlackConfig } from "../../config/env.js";
import {
  botCommands,
  conversationScopedCommands,
  instanceAdminCommands,
} from "../../core/bridge.js";
import {
  type DeliveryReceipt,
  type InboundAttachment,
  type InboundMessage,
  type MessageHandler,
  type MessagingChannel,
  type OutboundMessage,
  type ProviderReference,
  registerChannelTraits,
} from "../../core/channel.js";
import { trimInsertionOrdered, trimInsertionOrderedMap } from "../../shared/collections.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { PendingChoices } from "../choices.js";
import { isWorkspaceMember } from "./authorization.js";
import { type CodexConfigAccess, SlackConfigUi, slackConfigActionPrefix } from "./config-ui.js";
import { downloadSlackFile, SlackFileDownloadError } from "./file.js";
import { escapeSlackEntities } from "./format.js";
import {
  describeSlackFile,
  formatThreadContext,
  normalizeSlackMessage,
  routeSlackMessage,
  type SlackMessageEvent,
  type SlackThreadMessage,
  slackAttachmentKind,
} from "./message.js";
import {
  parseSlackDeliveryTarget,
  slackDeliveryTarget,
  slackMessageReference,
} from "./references.js";
import {
  choicePromptText,
  decodeSlackCommandValue,
  publishSlackMessage,
  type SlackBlock,
  type SlackChoiceRequester,
  type SlackMessagingApi,
  SlackResponder,
} from "./reply.js";

export const slackSlashCommandHelp = botCommands
  .map((entry) => `\`/wirebot ${entry.command}\` — ${entry.help}`)
  .join("\n");

interface SocketEnvelope {
  readonly ack: (response?: unknown) => Promise<void>;
  readonly envelope_id?: string;
  readonly body?: unknown;
  readonly event?: unknown;
}

interface SlackSlashCommandPayload {
  readonly command?: string;
  readonly text?: string;
  readonly user_id?: string;
  readonly user_name?: string;
  readonly channel_id?: string;
  readonly channel_name?: string;
  readonly response_url?: string;
}

interface SlackBlockAction {
  readonly action_id?: string;
  readonly value?: string;
}

interface SlackInteractivePayload {
  readonly type?: string;
  readonly user?: { readonly id?: string };
  readonly channel?: { readonly id?: string };
  readonly message?: {
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly text?: string;
  };
  readonly actions?: readonly SlackBlockAction[];
}

interface SlackChoiceContext {
  readonly channel: string;
  readonly messageTs: string;
  readonly baseText: string;
}

const recentEventLimit = 500;
const engagedThreadLimit = 500;
const displayNameCacheLimit = 500;
const membershipCacheLimit = 1_000;
/** Deactivations and role changes must take effect without a restart. */
const membershipCacheTtlMs = 10 * 60 * 1_000;
const webhookTimeoutMs = 10_000;

/** Parse mention-stripped text before handing the provider-owned command to the bridge. */
function parseTextCommand(text: string): Readonly<{ name: string; args: string }> | undefined {
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:[ \t]+([^\r\n]*))?$/i.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name: name.toLowerCase(), args: match?.[2]?.trimStart() ?? "" };
}

export class SlackChannel implements MessagingChannel {
  public readonly name = "slack";
  readonly #web: WebClient;
  readonly #socket: SocketModeClient;
  readonly #api: SlackMessagingApi;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #allowAllWorkspaceMembers: boolean;
  readonly #adminUserIds: ReadonlySet<string> | undefined;
  readonly #configUi: SlackConfigUi | undefined;
  readonly #membership = new Map<string, Readonly<{ allowed: boolean; checkedAt: number }>>();
  #botTeamId: string | undefined;
  readonly #botToken: string;
  readonly #attachmentDirectory: string;
  readonly #logger: Logger;
  readonly #pendingChoices = new PendingChoices<SlackChoiceContext>(async (entry, status) => {
    await this.#api.updateMessage({
      channel: entry.context.channel,
      ts: entry.context.messageTs,
      text: `${entry.context.baseText}\n\n→ ${status}`,
      blocks: [],
    });
  });
  /** Threads the bot already answered in — first mentions there skip the history fetch. */
  readonly #engagedThreads = new Set<string>();
  readonly #recentEvents = new Set<string>();
  readonly #displayNames = new Map<string, string>();
  /**
   * Thread root → ts of the latest scheduled-run notification published there.
   * Slack replies in a thread reference only the root, so this restores the
   * notification message for reply-context lookups.
   */
  readonly #threadNotifications = new Map<string, string>();
  #handler: MessageHandler | undefined;
  #botUserId: string | undefined;

  public constructor(
    config: SlackConfig,
    attachmentDirectory: string,
    logger: Logger,
    configAccess?: CodexConfigAccess,
  ) {
    this.#botToken = config.botToken;
    this.#allowedUserIds = config.allowedUserIds;
    this.#allowAllWorkspaceMembers = config.allowAllWorkspaceMembers;
    this.#adminUserIds = config.adminUserIds;
    this.#attachmentDirectory = attachmentDirectory;
    this.#logger = logger;
    registerChannelTraits(this.name, {
      commandText: (command) => `/wirebot ${command}`,
      supportsFileDelivery: true,
    });
    this.#web = new WebClient(config.botToken, { logLevel: LogLevel.ERROR });
    this.#socket = new SocketModeClient({ appToken: config.appToken, logLevel: LogLevel.ERROR });
    this.#api = webMessagingApi(this.#web);
    this.#configUi =
      configAccess === undefined
        ? undefined
        : new SlackConfigUi(this.#api, configAccess, logger.child({ component: "slack-config" }));
    this.#socket.on("message", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleMessageEvent(envelope.event as SlackMessageEvent);
      });
    });
    this.#socket.on("slash_commands", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleSlashCommand(envelope.body as SlackSlashCommandPayload);
      });
    });
    this.#socket.on("interactive", (envelope: SocketEnvelope) => {
      void this.withAck(envelope, async () => {
        await this.handleInteractive(envelope.body as SlackInteractivePayload);
      });
    });
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    const auth = await this.#web.auth.test();
    if (auth.user_id === undefined) {
      throw new Error("Slack auth.test did not identify the bot user");
    }
    this.#botUserId = auth.user_id;
    this.#botTeamId = auth.team_id;
    if (this.#allowAllWorkspaceMembers && this.#botTeamId === undefined) {
      throw new Error("Slack auth.test did not identify the workspace for member authorization");
    }
    await this.#socket.start();
    this.#logger.info("Slack bot connected through Socket Mode", {
      botUserId: auth.user_id,
      team: auth.team ?? "unknown",
      authorization: this.#allowAllWorkspaceMembers ? "workspace-members" : "allowlist",
    });
  }

  public isAuthorized(principal: ProviderReference): boolean | Promise<boolean> {
    if (principal.provider !== this.name || principal.resource !== "user") return false;
    return this.isUserAllowed(principal.id);
  }

  private isUserAllowed(userId: string): boolean | Promise<boolean> {
    if (!this.#allowAllWorkspaceMembers) return this.#allowedUserIds.has(userId);
    const cached = this.#membership.get(userId);
    if (cached !== undefined && Date.now() - cached.checkedAt < membershipCacheTtlMs) {
      return cached.allowed;
    }
    return this.checkWorkspaceMembership(userId);
  }

  private isAdmin(userId: string): boolean {
    return this.#adminUserIds === undefined || this.#adminUserIds.has(userId);
  }

  private async dispatch(
    inbound: InboundMessage,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const handler = this.#handler;
    if (handler === undefined) return;
    // Mentions such as "@Wirebot /new" arrive as plain text. Parse them here
    // because the bridge deliberately trusts provider-owned command parsing.
    const command =
      inbound.command ??
      (inbound.attachments.length === 0 ? parseTextCommand(inbound.text) : undefined);
    this.#logger.info("Slack message received", {
      userId,
      userName: inbound.sender.displayName,
      conversation: inbound.address.key,
      ...(command === undefined ? {} : { command: command.name }),
      chars: inbound.text.length,
      attachments: inbound.attachments.length,
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
    await handler(
      command === undefined || inbound.command !== undefined
        ? inbound
        : {
            ...inbound,
            command,
          },
    );
  }

  private async checkWorkspaceMembership(userId: string): Promise<boolean> {
    const botTeamId = this.#botTeamId;
    if (botTeamId === undefined) return false;
    let allowed = false;
    try {
      const response = await this.#web.users.info({ user: userId });
      allowed = isWorkspaceMember(response.user, botTeamId);
      const profile = response.user?.profile;
      const name = firstNonEmpty(profile?.display_name, profile?.real_name, response.user?.name);
      if (name !== undefined) {
        if (this.#displayNames.size >= displayNameCacheLimit) this.#displayNames.clear();
        this.#displayNames.set(userId, name);
      }
    } catch (error) {
      // Fail closed: an unknown user (e.g. a Slack Connect outsider the bot
      // token cannot see) is not a workspace member.
      this.#logger.debug("Slack membership lookup failed", {
        userId,
        error: errorMessage(error),
      });
      return false;
    }
    this.#membership.delete(userId);
    this.#membership.set(userId, { allowed, checkedAt: Date.now() });
    while (this.#membership.size > membershipCacheLimit) {
      const oldest = this.#membership.keys().next().value;
      if (oldest === undefined) break;
      this.#membership.delete(oldest);
    }
    return allowed;
  }

  public async stop(): Promise<void> {
    await this.#socket.disconnect().catch((error: unknown) => {
      this.#logger.debug("Slack socket disconnect failed", { error: errorMessage(error) });
    });
    await this.#pendingChoices.declineAll("Request cancelled");
  }

  public async publish(
    targetReference: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const target = parseSlackDeliveryTarget(targetReference);
    const published = await publishSlackMessage(this.#api, target, message, this.#logger);
    const primary = published[0];
    if (target.threadTs !== undefined && primary !== undefined) {
      this.#threadNotifications.set(`${target.channel}:${target.threadTs}`, primary.ts);
      trimInsertionOrderedMap(this.#threadNotifications, engagedThreadLimit);
    }
    return {
      publishedMessages: published.map((entry) => slackMessageReference(entry.channel, entry.ts)),
    };
  }

  private async withAck(envelope: SocketEnvelope, work: () => Promise<void>): Promise<void> {
    // Slack retries unacknowledged envelopes after a few seconds, so always
    // acknowledge first and process afterwards.
    try {
      await envelope.ack();
    } catch (error) {
      this.#logger.debug("Slack envelope acknowledgement failed", {
        error: errorMessage(error),
      });
    }
    // A dropped connection can redeliver an envelope whose ack was lost;
    // slash commands and button clicks must not execute twice.
    const envelopeId = envelope.envelope_id;
    if (envelopeId !== undefined && this.wasRecentlyProcessed(`envelope:${envelopeId}`)) return;
    try {
      await work();
    } catch (error) {
      this.#logger.error("Slack event handling failed", error);
    }
  }

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    const handler = this.#handler;
    const botUserId = this.#botUserId;
    if (handler === undefined || botUserId === undefined) return;
    if (typeof event.channel !== "string" || typeof event.ts !== "string") return;
    if (this.wasRecentlyProcessed(`message:${event.channel}:${event.ts}`)) return;

    const route = routeSlackMessage(event, botUserId);
    const sender = event.user;
    if (route === undefined || sender === undefined) return;
    if (!(await this.isUserAllowed(sender))) {
      this.#logger.warn("Ignored Slack message from unauthorized user", { userId: sender });
      return;
    }

    const normalized = normalizeSlackMessage(event, botUserId);
    const directory = join(this.#attachmentDirectory, crypto.randomUUID());
    const attachments: InboundAttachment[] = [];
    const failures: string[] = [];
    for (const [index, file] of normalized.files.entries()) {
      const description = describeSlackFile(file);
      try {
        const path = await downloadSlackFile(file, {
          botToken: this.#botToken,
          directory,
          index,
        });
        attachments.push({ kind: slackAttachmentKind(file), path, description });
      } catch (error) {
        this.#logger.warn("Could not download Slack attachment", {
          messageTs: event.ts,
          description,
          error: errorMessage(error).replaceAll(this.#botToken, "<redacted>"),
        });
        const reason =
          error instanceof SlackFileDownloadError
            ? error.userMessage
            : "Slack could not provide the file";
        failures.push(`[${description} was not attached: ${reason}.]`);
      }
    }

    const caption = [normalized.text, ...failures].filter((part) => part.length > 0).join("\n\n");
    // A bare file upload has no text; describe the attachments so the message
    // still reaches Codex instead of being dropped after the download.
    const text =
      caption.length > 0
        ? caption
        : attachments.map((attachment) => `[Attached: ${attachment.description}]`).join("\n");
    if (text.length === 0) {
      if (normalized.files.length > 0) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }
    const threadKey = `${event.channel}:${route.conversationSuffix}`;
    const threadWasEngaged = this.#engagedThreads.has(threadKey);
    if (event.channel_type !== "im") {
      this.rememberEngagedThread(threadKey);
    }
    const contextualText = await this.withThreadContext(event, botUserId, threadWasEngaged, text);
    const senderName = await this.displayName(sender);
    const responder = new SlackResponder(
      this.#api,
      event.channel,
      route.replyThreadTs,
      sender,
      this.requestChoice,
      this.#logger.child({
        userId: sender,
        userName: senderName,
        conversation: `slack:${event.channel}:${route.conversationSuffix}`,
      }),
    );
    const inbound: InboundMessage = {
      id: event.ts,
      address: {
        channel: this.name,
        key: `slack:${event.channel}:${route.conversationSuffix}`,
        isPrivate: event.channel_type === "im",
        isGuest: false,
        deliveryTarget: slackDeliveryTarget(event.channel, event.channel_type, route.replyThreadTs),
      },
      reference: slackMessageReference(event.channel, event.ts),
      // Slack threads are flat: a reply references the thread root, not the
      // message being answered. When a scheduled-run notification lives in
      // this thread, point replyTo at it so its stored context resolves.
      ...(event.thread_ts === undefined || event.thread_ts === event.ts
        ? {}
        : {
            replyTo: slackMessageReference(
              event.channel,
              this.#threadNotifications.get(`${event.channel}:${event.thread_ts}`) ??
                event.thread_ts,
            ),
          }),
      sender: {
        id: sender,
        displayName: senderName,
      },
      text: contextualText,
      attachments,
      responder,
      ...(normalized.files.length === 0
        ? {}
        : {
            dispose: async (): Promise<void> => {
              await rm(directory, { recursive: true, force: true });
            },
          }),
    };
    try {
      await this.dispatch(inbound, event.channel, sender);
    } catch (error) {
      this.#logger.error("Slack message handler failed", error, { messageTs: inbound.id });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  /**
   * A first mention inside an existing thread calls the bot into a running
   * discussion; fetch the earlier messages so Codex sees what it is about.
   * Commands stay bare — a context prefix would defeat command parsing.
   */
  private async withThreadContext(
    event: SlackMessageEvent,
    botUserId: string,
    threadWasEngaged: boolean,
    text: string,
  ): Promise<string> {
    if (
      event.channel_type === "im" ||
      threadWasEngaged ||
      event.thread_ts === undefined ||
      event.thread_ts === event.ts ||
      event.text?.includes(`<@${botUserId}>`) !== true ||
      parseTextCommand(text) !== undefined
    ) {
      return text;
    }
    try {
      const replies = await this.#api.fetchThreadReplies(event.channel, event.thread_ts, 100);
      const uniqueUsers = [
        ...new Set(
          replies
            .map((message) => message.user)
            .filter((user): user is string => user !== undefined),
        ),
      ];
      const names = new Map<string, string>();
      for (const user of uniqueUsers) {
        names.set(user, user === botUserId ? "Wirebot (this bot)" : await this.displayName(user));
      }
      const context = formatThreadContext(replies, event.ts, (message) =>
        message.user !== undefined
          ? (names.get(message.user) ?? message.user)
          : message.bot_id !== undefined
            ? "bot"
            : "unknown",
      );
      if (context === undefined) return text;
      return `[Context — earlier messages in this Slack thread:]\n${context}\n[End of thread context]\n\n${text}`;
    } catch (error) {
      this.#logger.warn("Could not fetch Slack thread context", {
        threadTs: event.thread_ts,
        error: errorMessage(error),
      });
      return text;
    }
  }

  private async handleSlashCommand(payload: SlackSlashCommandPayload): Promise<void> {
    const handler = this.#handler;
    const userId = payload.user_id;
    const channelId = payload.channel_id;
    if (handler === undefined || userId === undefined || channelId === undefined) return;
    const respondEphemerally = async (text: string): Promise<void> => {
      await this.#api.postEphemeral({ channel: channelId, user: userId, text }).catch(async () => {
        await this.respondThroughWebhook(payload.response_url, text);
      });
    };
    if (!(await this.isUserAllowed(userId))) {
      this.#logger.warn("Ignored Slack slash command from unauthorized user", { userId });
      await this.respondThroughWebhook(
        payload.response_url,
        "You are not on this Wirebot instance's allow list.",
      );
      return;
    }

    const [first, ...restParts] = (payload.text ?? "").trim().split(/\s+/u);
    const name = (first ?? "").toLowerCase();
    if (name.length === 0 || name === "help" || !/^[a-z][a-z0-9_]*$/u.test(name)) {
      // The bridge's generic help lists bare /commands, which Slack reserves
      // for its own slash-command system; answer with Slack-shaped help.
      await respondEphemerally(`Wirebot commands:\n${slackSlashCommandHelp}`);
      return;
    }
    // Conversation IDs starting with D are direct messages; channel_name is
    // spoofable (a channel can literally be named "directmessage").
    const isDirect = channelId.startsWith("D");
    if (!isDirect && conversationScopedCommands.has(name)) {
      // In channels every thread is its own conversation, and a slash command
      // carries no thread information, so these commands cannot pick a target.
      await respondEphemerally(
        `In channels each thread is its own Codex conversation, so \`/wirebot ${name}\` cannot tell which one you mean. Mention the bot inside the thread instead (\`@Wirebot /${name}\`), or run it in a direct message with the bot.`,
      );
      return;
    }
    const command = { name, args: restParts.join(" ") };
    const commandSenderName = payload.user_name ?? (await this.displayName(userId));
    const responder = new SlackResponder(
      this.#api,
      channelId,
      undefined,
      userId,
      this.requestChoice,
      this.#logger.child({
        userId,
        userName: commandSenderName,
        conversation: `slack:${channelId}:main`,
      }),
      payload.response_url,
    );
    const inbound: InboundMessage = {
      id: `slash:${crypto.randomUUID()}`,
      address: {
        channel: this.name,
        key: `slack:${channelId}:main`,
        isPrivate: isDirect,
        isGuest: false,
      },
      sender: {
        id: userId,
        displayName: commandSenderName,
      },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    try {
      await this.dispatch(inbound, channelId, userId);
    } catch (error) {
      this.#logger.error("Slack slash command failed", error, { command: command.name });
      await respondEphemerally(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private async handleInteractive(payload: SlackInteractivePayload): Promise<void> {
    if (payload.type !== "block_actions") return;
    const action = payload.actions?.[0];
    const userId = payload.user?.id;
    const channelId = payload.channel?.id;
    const actionId = action?.action_id;
    if (action === undefined || actionId === undefined || userId === undefined) return;
    if (actionId === "wirebot_link") return;
    if (!(await this.isUserAllowed(userId))) {
      this.#logger.warn("Ignored Slack interaction from unauthorized user", { userId });
      return;
    }
    if (actionId.startsWith(slackConfigActionPrefix)) {
      const messageTs = payload.message?.ts;
      if (this.#configUi === undefined || channelId === undefined || messageTs === undefined) {
        return;
      }
      if (!this.isAdmin(userId)) {
        await this.#api
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: "Codex settings are limited to Wirebot admins.",
          })
          .catch(() => undefined);
        return;
      }
      await this.#configUi.handleAction(action.value ?? "", channelId, messageTs);
      return;
    }
    if (actionId.startsWith("wirebot_choice")) {
      await this.handleChoiceAction(action, userId, channelId);
      return;
    }
    if (actionId.startsWith("wirebot_cmd")) {
      await this.handleCommandAction(action, payload, userId, channelId);
    }
  }

  private async handleChoiceAction(
    action: SlackBlockAction,
    userId: string,
    channelId: string | undefined,
  ): Promise<void> {
    const match = /^([0-9a-f]{16}):(\d+)$/u.exec(action.value ?? "");
    const token = match?.[1];
    const index = Number(match?.[2]);
    if (token === undefined) return;
    const pending = this.#pendingChoices.get(token);
    if (pending === undefined || pending.userId !== userId) {
      if (channelId !== undefined) {
        await this.#api
          .postEphemeral({ channel: channelId, user: userId, text: "This choice has expired." })
          .catch(() => undefined);
      }
      return;
    }
    const selected = pending.options[index];
    if (selected === undefined) return;
    this.#pendingChoices.select(token, selected.id);
    await this.#api
      .updateMessage({
        channel: pending.context.channel,
        ts: pending.context.messageTs,
        text: `${pending.context.baseText}\n\n→ ${escapeSlackEntities(selected.label)}`,
        blocks: [],
      })
      .catch(() => undefined);
  }

  private async handleCommandAction(
    action: SlackBlockAction,
    payload: SlackInteractivePayload,
    userId: string,
    channelId: string | undefined,
  ): Promise<void> {
    const handler = this.#handler;
    const command = decodeSlackCommandValue(action.value ?? "");
    const messageTs = payload.message?.ts;
    if (handler === undefined || command === undefined || channelId === undefined) return;
    if (messageTs === undefined) return;
    // Conversation IDs starting with D are direct messages with the app.
    const isDirect = channelId.startsWith("D");
    const threadRoot = payload.message?.thread_ts ?? messageTs;
    const conversationSuffix = isDirect ? "main" : threadRoot;
    const replyThreadTs = isDirect ? undefined : threadRoot;
    if (!isDirect) this.rememberEngagedThread(`${channelId}:${conversationSuffix}`);
    const actorName = await this.displayName(userId);
    const responder = new SlackResponder(
      this.#api,
      channelId,
      replyThreadTs,
      userId,
      this.requestChoice,
      this.#logger.child({
        userId,
        userName: actorName,
        conversation: `slack:${channelId}:${conversationSuffix}`,
      }),
    );
    const inbound: InboundMessage = {
      id: `action:${crypto.randomUUID()}`,
      address: {
        channel: this.name,
        key: `slack:${channelId}:${conversationSuffix}`,
        isPrivate: isDirect,
        isGuest: false,
        deliveryTarget: slackDeliveryTarget(channelId, isDirect ? "im" : "channel", replyThreadTs),
      },
      reference: slackMessageReference(channelId, messageTs),
      sender: {
        id: userId,
        displayName: actorName,
      },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    try {
      await this.dispatch(inbound, channelId, userId);
    } catch (error) {
      this.#logger.error("Slack command action failed", error, { command: command.name });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private readonly requestChoice: SlackChoiceRequester = async (
    channel,
    threadTs,
    userId,
    prompt,
    options,
    signal,
  ): Promise<string> => {
    return await this.#pendingChoices.request(userId, options, signal, async (token) => {
      const baseText = choicePromptText(prompt, options);
      const blocks: readonly SlackBlock[] = [
        { type: "section", text: { type: "mrkdwn", text: baseText } },
        {
          type: "actions",
          elements: options.map((option, index) => ({
            type: "button" as const,
            text: { type: "plain_text" as const, text: option.label.slice(0, 75) },
            action_id: `wirebot_choice_${index}`,
            value: `${token}:${index}`,
          })),
        },
      ];
      const messageTs = await this.#api.postMessage({
        channel,
        text: baseText,
        blocks,
        ...(threadTs === undefined ? {} : { threadTs }),
      });
      return { channel, messageTs, baseText };
    });
  };

  private async displayName(userId: string): Promise<string> {
    const cached = this.#displayNames.get(userId);
    if (cached !== undefined) return cached;
    try {
      const response = await this.#web.users.info({ user: userId });
      const profile = response.user?.profile;
      const name =
        firstNonEmpty(profile?.display_name, profile?.real_name, response.user?.name) ?? userId;
      if (this.#displayNames.size >= displayNameCacheLimit) this.#displayNames.clear();
      this.#displayNames.set(userId, name);
      return name;
    } catch (error) {
      // A transient lookup failure must not pin the raw ID until a restart.
      this.#logger.debug("Slack user lookup failed", { userId, error: errorMessage(error) });
      return userId;
    }
  }

  private async respondThroughWebhook(url: string | undefined, text: string): Promise<void> {
    if (url === undefined) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
      signal: AbortSignal.timeout(webhookTimeoutMs),
    }).catch((error: unknown) => {
      this.#logger.debug("Slack response webhook failed", { error: errorMessage(error) });
    });
  }

  private wasRecentlyProcessed(key: string): boolean {
    if (this.#recentEvents.has(key)) return true;
    this.#recentEvents.add(key);
    trimInsertionOrdered(this.#recentEvents, recentEventLimit);
    return false;
  }

  private rememberEngagedThread(key: string): void {
    this.#engagedThreads.delete(key);
    this.#engagedThreads.add(key);
    trimInsertionOrdered(this.#engagedThreads, engagedThreadLimit);
  }
}

function webMessagingApi(web: WebClient): SlackMessagingApi {
  return {
    async postMessage(options) {
      const result = await web.chat.postMessage({
        channel: options.channel,
        text: options.text,
        unfurl_links: false,
        unfurl_media: false,
        ...(options.threadTs === undefined ? {} : { thread_ts: options.threadTs }),
        ...(options.blocks === undefined ? {} : { blocks: [...options.blocks] }),
      });
      if (result.ts === undefined) {
        throw new Error("Slack did not return a timestamp for the posted message");
      }
      return result.ts;
    },
    async updateMessage(options) {
      await web.chat.update({
        channel: options.channel,
        ts: options.ts,
        text: options.text,
        blocks: options.blocks === undefined ? [] : [...options.blocks],
      });
    },
    async uploadFile(options) {
      const contents = { file: options.path, filename: options.filename };
      if (options.threadTs === undefined) {
        await web.filesUploadV2({ ...contents, channel_id: options.channel });
      } else {
        await web.filesUploadV2({
          ...contents,
          channel_id: options.channel,
          thread_ts: options.threadTs,
        });
      }
    },
    async postEphemeral(options) {
      await web.chat.postEphemeral({
        channel: options.channel,
        user: options.user,
        text: options.text,
      });
    },
    async fetchThreadReplies(channel, threadTs, limit) {
      const messages: SlackThreadMessage[] = [];
      let cursor: string | undefined;
      do {
        const result = await web.conversations.replies({
          channel,
          ts: threadTs,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        messages.push(...((result.messages ?? []) as unknown as readonly SlackThreadMessage[]));
        const next = result.response_metadata?.next_cursor?.trim();
        cursor = next === undefined || next.length === 0 ? undefined : next;
      } while (cursor !== undefined);
      return messages.slice(-limit);
    },
  };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}
