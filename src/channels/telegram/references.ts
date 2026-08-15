import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "../../shared/text.js";
import type { TelegramDestination, TelegramReplyRoute } from "./route.js";

/**
 * Durable conversation key for a Telegram chat. `suffix` narrows the chat to a
 * topic or thread; "0" is the plain private/group chat (see route.ts).
 */
export function telegramConversationKey(chatId: number, suffix: string): string {
  return `telegram:${chatId}:${suffix}`;
}

const telegramDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat") }),
  z.object({ kind: z.literal("topic"), messageThreadId: z.number().int() }),
  z.object({
    kind: z.literal("directMessagesTopic"),
    directMessagesTopicId: z.number().int(),
  }),
  z.object({ kind: z.literal("genericThread"), replyToMessageId: z.number().int() }),
]);

const targetSchema = z.object({
  version: z.literal(1),
  chatId: z.number().int().safe(),
  destination: telegramDestinationSchema,
});

export function telegramDeliveryTarget(
  chatId: number,
  route: TelegramReplyRoute,
): ProviderReference {
  return {
    provider: "telegram",
    resource: "destination",
    id: encodeBase64UrlJson({
      version: 1,
      chatId,
      destination: route.destination,
    }),
  };
}

export function parseTelegramDeliveryTarget(
  reference: ProviderReference,
): Readonly<{ chatId: number; destination: TelegramDestination }> {
  if (reference.provider !== "telegram" || reference.resource !== "destination") {
    throw new Error("The delivery target does not belong to Telegram");
  }
  const parsed = targetSchema.parse(decodeBase64UrlJson(reference.id));
  return { chatId: parsed.chatId, destination: parsed.destination };
}

export function telegramMessageReference(chatId: number, messageId: number): ProviderReference {
  return {
    provider: "telegram",
    resource: "message",
    id: encodeBase64UrlJson({ version: 1, chatId, messageId }),
  };
}
