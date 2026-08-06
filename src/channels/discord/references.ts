import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import { decodeBase64UrlJson } from "../../shared/text.js";

const snowflake = z.string().regex(/^\d{15,22}$/u);

const destinationSchema = z.object({
  version: z.literal(1),
  channelId: snowflake,
});

const messageSchema = z.object({
  version: z.literal(1),
  channelId: snowflake,
  messageId: snowflake,
});

export function discordDeliveryTarget(channelId: string): ProviderReference {
  return {
    provider: "discord",
    resource: "destination",
    id: encodeReference({ version: 1, channelId }),
  };
}

export function parseDiscordDeliveryTarget(reference: ProviderReference): string {
  if (reference.provider !== "discord" || reference.resource !== "destination") {
    throw new Error("The delivery target does not belong to Discord");
  }
  return destinationSchema.parse(decodeReference(reference.id)).channelId;
}

export function discordMessageReference(channelId: string, messageId: string): ProviderReference {
  return {
    provider: "discord",
    resource: "message",
    id: encodeReference({ version: 1, channelId, messageId }),
  };
}

export function parseDiscordMessageReference(
  reference: ProviderReference,
): Readonly<{ channelId: string; messageId: string }> {
  if (reference.provider !== "discord" || reference.resource !== "message") {
    throw new Error("The message reference does not belong to Discord");
  }
  return messageSchema.parse(decodeReference(reference.id));
}

function encodeReference(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeReference(value: string): unknown {
  return decodeBase64UrlJson(value);
}
