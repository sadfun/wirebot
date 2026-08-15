import { basename } from "node:path";
import type {
  ChoiceOption,
  MessageResponder,
  OutboundAttachment,
  OutboundMessage,
  OutboundStream,
  SendOptions,
} from "../../core/channel.js";
import type { Logger } from "../../shared/logger.js";
import { encodeCommandAction } from "../command-actions.js";
import { DraftReplyStream } from "../draft-stream.js";
import { splitMessageText } from "../progress.js";
import { escapeSlackEntities, markdownToMrkdwn } from "./format.js";
import type { SlackThreadMessage } from "./message.js";
import type { SlackDeliveryTarget } from "./references.js";

/**
 * Slack's documented ceiling is 40k characters, but chat.update and
 * chat.postMessage reject far shorter payloads with msg_too_long in practice
 * (observed at 12k on 2026-07-28). 3,900 stays under the reliable 4k mark and
 * matches what Slack renders without collapsing.
 */
export const slackTextLimit = 3_900;

const webhookTimeoutMs = 10_000;

export type SlackBlock =
  | {
      readonly type: "section";
      readonly text: { readonly type: "mrkdwn"; readonly text: string };
    }
  | { readonly type: "actions"; readonly elements: readonly SlackButtonElement[] };

export interface SlackButtonElement {
  readonly type: "button";
  readonly text: { readonly type: "plain_text"; readonly text: string };
  readonly action_id: string;
  readonly value?: string;
  readonly url?: string;
}

export interface SlackPostOptions {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly blocks?: readonly SlackBlock[];
}

export interface SlackUpdateOptions {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly blocks?: readonly SlackBlock[];
}

export interface SlackUploadOptions {
  readonly channel: string;
  readonly threadTs?: string;
  readonly path: string;
  readonly filename: string;
}

export interface SlackEphemeralOptions {
  readonly channel: string;
  readonly user: string;
  readonly text: string;
}

/** Narrow messaging port over the Slack Web API, easy to fake in tests. */
export interface SlackMessagingApi {
  postMessage(options: SlackPostOptions): Promise<string>;
  updateMessage(options: SlackUpdateOptions): Promise<void>;
  uploadFile(options: SlackUploadOptions): Promise<void>;
  postEphemeral(options: SlackEphemeralOptions): Promise<void>;
  fetchThreadReplies(
    channel: string,
    threadTs: string,
    limit: number,
  ): Promise<readonly SlackThreadMessage[]>;
}

export type SlackChoiceRequester = (
  channel: string,
  threadTs: string | undefined,
  userId: string,
  prompt: string,
  options: readonly ChoiceOption[],
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Render an approval prompt for a Slack section block. The prompt and option
 * details are Codex-controlled free text, so Slack entities are escaped —
 * otherwise `<command>` fragments vanish and `<!channel>` would ping everyone.
 */
export function choicePromptText(prompt: string, options: readonly ChoiceOption[]): string {
  const details = options
    .filter((option) => option.description !== undefined)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  const body = escapeSlackEntities(details.length === 0 ? prompt : `${prompt}\n\n${details}`);
  return body.length <= 3_000 ? body : `${body.slice(0, 2_999)}…`;
}

function encodeSlackCommandValue(name: string, args: string): string {
  const value = encodeCommandAction(name, args);
  if (Buffer.byteLength(value, "utf8") > 2_000) {
    throw new Error("Provider command action exceeds Slack's button value limit");
  }
  return value;
}

function urlButtonBlocks(options: SendOptions | undefined): readonly SlackBlock[] | undefined {
  const button = options?.button;
  if (button === undefined) return undefined;
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: button.label.slice(0, 75) },
          action_id: "wirebot_link",
          url: button.url,
        },
      ],
    },
  ];
}

function commandButtonBlocks(
  message: OutboundMessage,
  logger: Logger,
): readonly SlackBlock[] | undefined {
  const actions = message.actions;
  if (actions === undefined || actions.length === 0) return undefined;
  // One unencodable action must not take down the whole delivery.
  const elements: SlackButtonElement[] = [];
  for (const [index, action] of actions.entries()) {
    try {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: action.label.slice(0, 75) },
        action_id: `wirebot_cmd_${index}`,
        value: encodeSlackCommandValue(action.command.name, action.command.args),
      });
    } catch (error) {
      logger.warn("Dropped a Slack command action", {
        command: action.command.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (elements.length === 0) return undefined;
  return [{ type: "actions", elements }];
}

interface ThreadOption {
  readonly threadTs?: string;
}

function threadOption(threadTs: string | undefined): ThreadOption {
  return threadTs === undefined ? {} : { threadTs };
}

export async function publishSlackMessage(
  api: SlackMessagingApi,
  target: SlackDeliveryTarget,
  message: OutboundMessage,
  logger: Logger,
): Promise<readonly Readonly<{ channel: string; ts: string }>[]> {
  const published: { channel: string; ts: string }[] = [];
  const thread = threadOption(target.threadTs);
  for (const chunk of splitMessageText(markdownToMrkdwn(message.text), slackTextLimit)) {
    const ts = await api.postMessage({ channel: target.channel, text: chunk, ...thread });
    published.push({ channel: target.channel, ts });
  }
  const blocks = commandButtonBlocks(message, logger);
  if (blocks !== undefined) {
    const ts = await api.postMessage({
      channel: target.channel,
      text: "Choose an action",
      blocks,
      ...thread,
    });
    published.push({ channel: target.channel, ts });
  }
  const attachmentTimestamps = await sendSlackAttachments(
    api,
    target.channel,
    target.threadTs,
    message.attachments ?? [],
    logger,
  );
  published.push(...attachmentTimestamps.map((ts) => ({ channel: target.channel, ts })));
  return published;
}

export class SlackResponder implements MessageResponder {
  readonly #api: SlackMessagingApi;
  readonly #channel: string;
  readonly #threadTs: string | undefined;
  readonly #userId: string;
  readonly #requestChoice: SlackChoiceRequester;
  readonly #logger: Logger;
  readonly #fallbackWebhookUrl: string | undefined;

  public constructor(
    api: SlackMessagingApi,
    channel: string,
    threadTs: string | undefined,
    userId: string,
    requestChoice: SlackChoiceRequester,
    logger: Logger,
    fallbackWebhookUrl?: string,
  ) {
    this.#api = api;
    this.#channel = channel;
    this.#threadTs = threadTs;
    this.#userId = userId;
    this.#requestChoice = requestChoice;
    this.#logger = logger;
    this.#fallbackWebhookUrl = fallbackWebhookUrl;
  }

  public createStream(): OutboundStream {
    return new SlackReplyStream(this.#api, this.#channel, this.#threadTs, this.#logger);
  }

  public async sendText(text: string, options?: SendOptions): Promise<void> {
    this.#logger.info("Slack reply", { chars: text.length });
    const chunks = splitMessageText(markdownToMrkdwn(text), slackTextLimit);
    let posted = 0;
    try {
      for (const chunk of chunks) {
        await this.#api.postMessage({
          channel: this.#channel,
          text: chunk,
          ...threadOption(this.#threadTs),
        });
        posted += 1;
      }
    } catch (error) {
      if (this.#fallbackWebhookUrl === undefined) throw error;
      // Slash commands can arrive from channels the bot is not a member of;
      // their response webhook still accepts an ephemeral reply. Deliver only
      // what has not already been posted.
      await this.respondThroughWebhook(chunks.slice(posted).join("\n\n"));
      return;
    }
    const blocks = urlButtonBlocks(options);
    if (blocks !== undefined) {
      const label = options?.button?.label ?? "Open";
      await this.#api.postMessage({
        channel: this.#channel,
        text: label,
        blocks,
        ...threadOption(this.#threadTs),
      });
    }
  }

  public async askChoice(
    prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.#requestChoice(
      this.#channel,
      this.#threadTs,
      this.#userId,
      prompt,
      options,
      signal,
    );
  }

  private async respondThroughWebhook(text: string): Promise<void> {
    const url = this.#fallbackWebhookUrl;
    if (url === undefined) return;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: text.slice(0, slackTextLimit) }),
      signal: AbortSignal.timeout(webhookTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Slack's response webhook returned HTTP ${response.status}`);
    }
  }
}

export class SlackReplyStream extends DraftReplyStream {
  readonly #api: SlackMessagingApi;
  readonly #channel: string;
  readonly #threadTs: string | undefined;

  public constructor(
    api: SlackMessagingApi,
    channel: string,
    threadTs: string | undefined,
    logger: Logger,
  ) {
    super(logger, "Slack", slackTextLimit);
    this.#api = api;
    this.#channel = channel;
    this.#threadTs = threadTs;
  }

  protected async postInitial(content: string): Promise<string> {
    return await this.#api.postMessage({
      channel: this.#channel,
      text: content,
      ...threadOption(this.#threadTs),
    });
  }

  protected async post(content: string): Promise<void> {
    await this.#api.postMessage({
      channel: this.#channel,
      text: content,
      ...threadOption(this.#threadTs),
    });
  }

  protected async update(messageTs: string, content: string): Promise<void> {
    await this.#api.updateMessage({ channel: this.#channel, ts: messageTs, text: content });
  }

  // Escaping matters even in previews: `<command>` fragments would vanish and
  // `<!channel>` would ping everyone.
  protected renderProgress(block: string): string {
    return escapeSlackEntities(block);
  }

  protected renderFinal(text: string): string {
    return markdownToMrkdwn(text);
  }

  protected override async finishExtras(attachments: readonly OutboundAttachment[]): Promise<void> {
    await sendSlackAttachments(this.#api, this.#channel, this.#threadTs, attachments, this.logger);
  }
}

async function sendSlackAttachments(
  api: SlackMessagingApi,
  channel: string,
  threadTs: string | undefined,
  attachments: readonly OutboundAttachment[],
  logger: Logger,
): Promise<readonly string[]> {
  const timestamps: string[] = [];
  const failed: string[] = [];
  for (const attachment of attachments) {
    const filename = safeAttachmentName(attachment.filename);
    try {
      await api.uploadFile({
        channel,
        path: attachment.path,
        filename,
        ...threadOption(threadTs),
      });
    } catch (error) {
      failed.push(filename);
      logger.warn("Slack attachment upload failed", {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed.length === 0) return timestamps;

  const notice = escapeSlackEntities(
    `Could not send ${failed.join(", ")} as ${failed.length === 1 ? "an attachment" : "attachments"}.`,
  );
  try {
    const ts = await api.postMessage({ channel, text: notice, ...threadOption(threadTs) });
    timestamps.push(ts);
  } catch (error) {
    logger.warn("Slack attachment failure notice could not be sent", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return timestamps;
}

function safeAttachmentName(path: string): string {
  return basename(path).replace(/[\r\n]/g, "_") || "attachment";
}
