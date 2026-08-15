import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "../../shared/text.js";

const slackChannelTypeSchema = z.enum(["im", "mpim", "group", "channel"]);

const targetSchema = z.object({
  version: z.literal(1),
  channel: z.string().min(1),
  channelType: slackChannelTypeSchema,
  threadTs: z.string().min(1).optional(),
});

export type SlackChannelType = z.infer<typeof slackChannelTypeSchema>;

export interface SlackDeliveryTarget {
  readonly channel: string;
  readonly channelType: SlackChannelType;
  readonly threadTs: string | undefined;
}

export function slackDeliveryTarget(
  channel: string,
  channelType: SlackChannelType,
  threadTs?: string,
): ProviderReference {
  return {
    provider: "slack",
    resource: "destination",
    id: encodeBase64UrlJson({
      version: 1,
      channel,
      channelType,
      ...(threadTs === undefined ? {} : { threadTs }),
    }),
  };
}

export function parseSlackDeliveryTarget(reference: ProviderReference): SlackDeliveryTarget {
  if (reference.provider !== "slack" || reference.resource !== "destination") {
    throw new Error("The delivery target does not belong to Slack");
  }
  const parsed = targetSchema.parse(decodeBase64UrlJson(reference.id));
  return {
    channel: parsed.channel,
    channelType: parsed.channelType,
    threadTs: parsed.threadTs,
  };
}

export function slackMessageReference(channel: string, ts: string): ProviderReference {
  return {
    provider: "slack",
    resource: "message",
    id: encodeBase64UrlJson({ version: 1, channel, ts }),
  };
}
