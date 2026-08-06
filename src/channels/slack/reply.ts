import { basename } from "node:path";
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

export function decodeSlackCommandValue(
  value: string,
): Readonly<{ name: string; args: string }> | undefined {
  const match = /^tx:([a-z][a-z0-9_]*):(.*)$/u.exec(value);
  const name = match?.[1];
  const args = match?.[2];
  return name === undefined || args === undefined ? undefined : { name, args };
}

function encodeSlackCommandValue(name: string, args: string): string {
  if (
    !/^[a-z][a-z0-9_]*$/u.test(name) ||
    [...args].some((character) => character === ":" || character.charCodeAt(0) < 32)
  ) {
    throw new Error("Provider command action is not safe for a Slack button value");
  }
  const value = `tx:${name}:${args}`;
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

export function truncateForLog(text: string, limit = 1_500): string {
  const compact = text.trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
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
  readonly #fetch: typeof globalThis.fetch;

  public constructor(
    api: SlackMessagingApi,
    channel: string,
    threadTs: string | undefined,
    userId: string,
    requestChoice: SlackChoiceRequester,
    logger: Logger,
    fallbackWebhookUrl?: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#api = api;
    this.#channel = channel;
    this.#threadTs = threadTs;
    this.#userId = userId;
    this.#requestChoice = requestChoice;
    this.#logger = logger;
    this.#fallbackWebhookUrl = fallbackWebhookUrl;
    this.#fetch = fetchImplementation;
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
    const response = await this.#fetch(url, {
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

export class SlackReplyStream implements OutboundStream {
  static readonly #draftIntervalMs = 1_500;
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #finalText = "";
  #messageTs: string | undefined;
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
  readonly #api: SlackMessagingApi;
  readonly #channel: string;
  readonly #threadTs: string | undefined;
  readonly #logger: Logger;

  public constructor(
    api: SlackMessagingApi,
    channel: string,
    threadTs: string | undefined,
    logger: Logger,
  ) {
    this.#api = api;
    this.#channel = channel;
    this.#threadTs = threadTs;
    this.#logger = logger;
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (this.#closing || this.#completed || this.#messageTs !== undefined) return;
    if (this.#starting !== undefined) return await this.#starting;
    if (initialProgress !== undefined) this.#progress = initialProgress;
    const preview = this.preview();
    const post = this.#api
      .postMessage({
        channel: this.#channel,
        text: preview,
        ...threadOption(this.#threadTs),
      })
      .then((ts) => {
        this.#messageTs = ts;
        this.#lastDraftAt = Date.now();
        this.#lastPublishedText = preview;
        if (this.#draftDirty) this.scheduleDraft(true);
      })
      .catch((error: unknown) => {
        this.#logger.debug("Slack progress message could not be posted", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.#starting = post;
    try {
      await post;
    } finally {
      this.#starting = undefined;
    }
  }

  public setProgress(progress: ProgressSnapshot): void {
    if (this.#closing || this.#completed) return;
    // Mirror the run into stdout: every tool call once, and reasoning
    // summaries as they change.
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
    const completion = this.finish(text, attachments);
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

  private async finish(text: string, attachments: readonly OutboundAttachment[]): Promise<void> {
    this.clearTimer();
    await this.#starting?.catch(() => undefined);
    await this.#draftInFlight?.catch(() => undefined);
    if (text.length > 0) {
      this.#logger.info("Codex answer delivered", {
        chars: text.length,
      });
    }
    const chunks =
      text.length === 0 ? [] : splitMessageText(markdownToMrkdwn(text), slackTextLimit);
    // Freeze the progress message without the streaming cursor. The answer
    // itself arrives as separate messages below: a silent edit of the
    // thinking message never notifies anyone, and a failed edit must not
    // take the answer down with it.
    if (this.#messageTs !== undefined) {
      await this.#api
        .updateMessage({
          channel: this.#channel,
          ts: this.#messageTs,
          text: escapeSlackEntities(formatThinkingBlock(this.#progress)).slice(0, slackTextLimit),
        })
        .catch((error: unknown) => {
          this.#logger.debug("Slack progress freeze failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    let undelivered = 0;
    for (const chunk of chunks) {
      try {
        await this.#api.postMessage({
          channel: this.#channel,
          text: chunk,
          ...threadOption(this.#threadTs),
        });
      } catch (error) {
        undelivered += 1;
        this.#logger.warn("Slack final text delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (undelivered > 0) {
      await this.#api
        .postMessage({
          channel: this.#channel,
          text: `⚠️ ${undelivered} part${undelivered === 1 ? "" : "s"} of the reply could not be delivered.`,
          ...threadOption(this.#threadTs),
        })
        .catch(() => undefined);
    }
    await sendSlackAttachments(this.#api, this.#channel, this.#threadTs, attachments, this.#logger);
  }

  private scheduleDraft(immediate = false): void {
    if (this.#closing || this.#completed) return;
    this.#draftDirty = true;
    if (this.#messageTs === undefined || this.#draftInFlight !== undefined) return;

    const wait = immediate
      ? 0
      : Math.max(0, SlackReplyStream.#draftIntervalMs - (Date.now() - this.#lastDraftAt));
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
      this.#messageTs === undefined ||
      this.#draftInFlight !== undefined ||
      !this.#draftDirty
    ) {
      return;
    }

    this.#draftDirty = false;
    const update = this.flushDraft().catch((error: unknown) => {
      this.#logger.debug("Slack draft update failed", {
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
    const messageTs = this.#messageTs;
    if (this.#closing || this.#completed || messageTs === undefined) return;
    const preview = this.preview();
    if (preview === this.#lastPublishedText) return;
    this.#lastDraftAt = Date.now();
    await this.#api.updateMessage({ channel: this.#channel, ts: messageTs, text: preview });
    this.#lastPublishedText = preview;
  }

  private preview(): string {
    // Entity escaping can expand the progress block past the message limit,
    // so clamp it before budgeting the final-text tail.
    const progress = escapeSlackEntities(formatThinkingBlock(this.#progress)).slice(
      0,
      slackTextLimit - 3,
    );
    if (this.#finalText.length === 0) return `${progress}\n\n▌`;
    const available = Math.max(0, slackTextLimit - progress.length - 3);
    const finalText = available === 0 ? "" : markdownToMrkdwn(this.#finalText).slice(-available);
    return `${progress}\n\n${finalText}▌`;
  }

  private clearTimer(): void {
    if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
    this.#draftTimer = undefined;
    this.#draftDirty = false;
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
