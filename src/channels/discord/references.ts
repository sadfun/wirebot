import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "../../shared/text.js";

const snowflake = z.string().regex(/^\d{15,20}$/u);

const destinationSchema = z.object({
  version: z.literal(1),
  channelId: snowflake,
});

export function discordDeliveryTarget(channelId: string): ProviderReference {
  return {
    provider: "discord",
    resource: "destination",
    id: encodeBase64UrlJson({ version: 1, channelId }),
  };
}

export function parseDiscordDeliveryTarget(reference: ProviderReference): string {
  if (reference.provider !== "discord" || reference.resource !== "destination") {
    throw new Error("The delivery target does not belong to Discord");
  }
  return destinationSchema.parse(decodeBase64UrlJson(reference.id)).channelId;
}

export function discordMessageReference(channelId: string, messageId: string): ProviderReference {
  return {
    provider: "discord",
    resource: "message",
    id: encodeBase64UrlJson({ version: 1, channelId, messageId }),
  };
}
