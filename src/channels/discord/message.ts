import { type Message, MessageType } from "discord.js";
import { compactTruncate } from "../../shared/text.js";

export interface DiscordIncomingRoute {
  readonly isPrivate: boolean;
  readonly explicitMention: boolean;
  readonly replyToBot: boolean;
}

/**
 * Accept DMs, direct mentions, replies to Wirebot, and ordinary follow-ups in
 * threads created by Wirebot. Other guild traffic stays untouched.
 */
export function routeDiscordMessage(
  message: Message,
  botUserId: string,
): DiscordIncomingRoute | undefined {
  if (
    message.channel.isVoiceBased() ||
    message.author.bot ||
    message.webhookId !== null ||
    message.system ||
    (message.type !== MessageType.Default && message.type !== MessageType.Reply)
  ) {
    return undefined;
  }
  const isPrivate = message.channel.isDMBased();
  const explicitMention = message.mentions.users.has(botUserId);
  const replyToBot = message.mentions.repliedUser?.id === botUserId;
  const botOwnedThread = message.channel.isThread() && message.channel.ownerId === botUserId;
  if (!isPrivate && !explicitMention && !replyToBot && !botOwnedThread) return undefined;
  return { isPrivate, explicitMention, replyToBot };
}

export function parseDiscordCommand(
  text: string,
): Readonly<{ name: string; args: string }> | undefined {
  const match = /^[/!]([a-z][a-z0-9_]*)(?:[ \t]+([^\r\n]*))?$/iu.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name: name.toLowerCase(), args: match?.[2]?.trimStart() ?? "" };
}

export function normalizeDiscordMessage(message: Message, botUserId: string): string {
  const content = discordTextContent(message, botUserId);
  const media = discordMediaDescriptions(message);
  if (media.length === 0) return content;
  const notice = media.map((item) => `[Discord text-only media omitted: ${item}]`).join("\n");
  return content.length === 0 ? notice : `${content}\n\n${notice}`;
}

export function discordTextContent(message: Message, botUserId: string): string {
  const direct = cleanDiscordText(message.content, botUserId);
  const forwarded = [...message.messageSnapshots.values()]
    .map((snapshot) => cleanDiscordText(snapshot.content, botUserId))
    .filter((content) => content.length > 0)
    .map((content) => `[Forwarded Discord message]\n${content}`);
  return [direct, ...forwarded].filter((content) => content.length > 0).join("\n\n");
}

export function hasDiscordMedia(message: Message): boolean {
  return (
    hasMedia(message) ||
    [...message.messageSnapshots.values()].some((snapshot) => hasMedia(snapshot))
  );
}

export function discordDisplayName(message: Message): string {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

/** Render older messages in a Discord thread, dropping the oldest to stay bounded. */
export function formatDiscordThreadContext(
  messages: readonly Message[],
  triggerId: string,
  botUserId: string,
  characterBudget = 8_000,
): string | undefined {
  const lines = messages
    .filter((message) => message.id !== triggerId && !message.system && message.webhookId === null)
    .map((message) => {
      const body = normalizeDiscordMessage(message, botUserId);
      return body.length === 0 ? "" : `${discordDisplayName(message)}: ${body}`;
    })
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  let dropped = 0;
  while (lines.length > 1 && lines.join("\n").length > characterBudget) {
    lines.shift();
    dropped += 1;
  }
  return (dropped === 0 ? lines : [`[${dropped} earlier messages omitted]`, ...lines]).join("\n");
}

export function discordThreadName(text: string): string {
  const firstLine =
    text
      .split("\n", 1)[0]
      ?.replaceAll(/[*_`~]/gu, "")
      .trim() ?? "";
  const subject = firstLine.length === 0 ? "New task" : compactTruncate(firstLine, 80);
  return compactTruncate(`Wirebot — ${subject}`, 100);
}

function discordMediaDescriptions(message: Message): readonly string[] {
  const direct = mediaDescriptions(message);
  const forwarded = [...message.messageSnapshots.values()].flatMap((snapshot) =>
    mediaDescriptions(snapshot).map((description) => `forwarded ${description}`),
  );
  return [...direct, ...forwarded];
}

function mediaDescriptions(
  message: Pick<Message, "attachments" | "poll" | "stickers">,
): readonly string[] {
  const attachments = [...message.attachments.values()].map((attachment) => {
    const metadata = [attachment.contentType ?? undefined, formatBytes(attachment.size)].filter(
      (value): value is string => value !== undefined,
    );
    return `${attachment.name}${metadata.length === 0 ? "" : ` (${metadata.join(", ")})`}`;
  });
  const stickers = [...message.stickers.values()].map((sticker) => `sticker ${sticker.name}`);
  const poll = message.poll?.question.text;
  return [...attachments, ...stickers, ...(poll === undefined ? [] : [`poll: ${poll}`])];
}

function hasMedia(message: Pick<Message, "attachments" | "poll" | "stickers">): boolean {
  return message.attachments.size > 0 || message.stickers.size > 0 || message.poll !== null;
}

function cleanDiscordText(content: string, botUserId: string): string {
  return content
    .replaceAll(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "gu"), " ")
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round((bytes / (1_024 * 1_024)) * 10) / 10} MB`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
