import { formatBytes } from "../../shared/text.js";
import { mrkdwnToPlainText } from "./format.js";

/** Subset of a Slack file object relevant to attachment handling. */
export interface SlackFile {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly size?: number;
  readonly mode?: string;
  readonly subtype?: string;
  readonly url_private?: string;
  readonly url_private_download?: string;
}

/** Subset of a Slack Events API `message` event relevant to the bridge. */
export interface SlackMessageEvent {
  readonly type: "message";
  readonly subtype?: string;
  readonly channel: string;
  readonly channel_type: "im" | "channel" | "group" | "mpim";
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFile[];
}

export interface SlackIncomingRoute {
  /** Stable per-conversation suffix: `main` for DMs, the thread root ts elsewhere. */
  readonly conversationSuffix: string;
  /** Thread to reply into; undefined keeps DM replies unthreaded. */
  readonly replyThreadTs: string | undefined;
}

const handledSubtypes = new Set([undefined, "file_share", "thread_broadcast"]);

/**
 * Decide whether and where to handle a message event.
 *
 * DMs are always handled. In channels and group DMs every message for the
 * bot needs an explicit mention — including follow-ups in a thread it
 * already answered in — so human discussion in the thread stays untouched.
 */
export function routeSlackMessage(
  event: SlackMessageEvent,
  botUserId: string,
): SlackIncomingRoute | undefined {
  if (!handledSubtypes.has(event.subtype)) return undefined;
  if (event.bot_id !== undefined || event.user === undefined || event.user === botUserId) {
    return undefined;
  }
  if (event.channel_type === "im") {
    return { conversationSuffix: "main", replyThreadTs: undefined };
  }
  if (event.text?.includes(`<@${botUserId}>`) !== true) return undefined;
  const threadRoot = event.thread_ts ?? event.ts;
  return { conversationSuffix: threadRoot, replyThreadTs: threadRoot };
}

/** Words that act as commands without a leading slash, in mentions and DMs alike. */
const bareCommandWords: ReadonlySet<string> = new Set(["new"]);

/**
 * Parse a command out of mention-stripped Slack text: `/name args` (Slack
 * only swallows a leading slash in the composer, so mentions carry it through)
 * or a bare command word such as `new`. Provider-owned parsing — the bridge
 * trusts `InboundMessage.command`.
 */
export function parseSlackCommand(
  text: string,
): Readonly<{ name: string; args: string }> | undefined {
  const trimmed = text.trim();
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:[ \t]+([^\r\n]*))?$/i.exec(trimmed);
  const name = match?.[1];
  if (name !== undefined) return { name: name.toLowerCase(), args: match?.[2]?.trimStart() ?? "" };
  const bare = /^([a-z]+)[.!]?$/i.exec(trimmed)?.[1]?.toLowerCase();
  if (bare !== undefined && bareCommandWords.has(bare)) return { name: bare, args: "" };
  return undefined;
}

export interface NormalizedSlackMessage {
  readonly text: string;
  readonly files: readonly SlackFile[];
}

export function normalizeSlackMessage(
  event: SlackMessageEvent,
  botUserId: string,
): NormalizedSlackMessage {
  const withoutBotMention = (event.text ?? "")
    .replaceAll(`<@${botUserId}>`, " ")
    .replaceAll(/[ \t]{2,}/gu, " ");
  return {
    text: mrkdwnToPlainText(withoutBotMention).trim(),
    files: event.files ?? [],
  };
}

/** Subset of a `conversations.replies` entry relevant to thread context. */
export interface SlackThreadMessage {
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts: string;
  readonly files?: readonly SlackFile[];
}

/**
 * Render the earlier messages of a thread as context for Codex, oldest first.
 * The triggering message itself is excluded, as is everything from `beforeTs`
 * on when given; when the thread exceeds the character budget the oldest
 * messages are dropped.
 */
export function formatThreadContext(
  messages: readonly SlackThreadMessage[],
  triggerTs: string,
  nameOf: (message: SlackThreadMessage) => string,
  characterBudget = 8_000,
  beforeTs?: string,
): string | undefined {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.ts === triggerTs) continue;
    if (beforeTs !== undefined && Number(message.ts) >= Number(beforeTs)) continue;
    const text = mrkdwnToPlainText(message.text ?? "").trim();
    const attachments = (message.files ?? [])
      .map((file) => `[attached: ${file.name ?? file.title ?? "file"}]`)
      .join(" ");
    const body = [text, attachments].filter((part) => part.length > 0).join(" ");
    if (body.length === 0) continue;
    lines.push(`${nameOf(message)}: ${body}`);
  }
  if (lines.length === 0) return undefined;
  let dropped = 0;
  while (lines.length > 1 && lines.join("\n").length > characterBudget) {
    lines.shift();
    dropped += 1;
  }
  const parts = dropped === 0 ? lines : [`[${dropped} earlier messages omitted]`, ...lines];
  return parts.join("\n");
}

export function describeSlackFile(file: SlackFile): string {
  const name = file.name ?? file.title ?? "attachment";
  const metadata = [
    file.mimetype,
    file.size === undefined ? undefined : formatBytes(file.size),
  ].filter((value): value is string => value !== undefined);
  return metadata.length === 0 ? name : `${name} (${metadata.join(", ")})`;
}

export function slackAttachmentKind(file: SlackFile): "image" | "file" | "voice" {
  if (file.subtype === "slack_audio") return "voice";
  const mimetype = file.mimetype ?? "";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "voice";
  return "file";
}
