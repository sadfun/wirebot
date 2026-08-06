import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";

const slackChannelTypeSchema = z.enum(["im", "mpim", "group", "channel"]);

const targetSchema = z.object({
  version: z.literal(1),
  channel: z.string().min(1),
  channelType: slackChannelTypeSchema,
  threadTs: z.string().min(1).optional(),
});

const messageSchema = z.object({
  version: z.literal(1),
  channel: z.string().min(1),
  ts: z.string().min(1),
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
    id: encodeReference({
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
  const parsed = targetSchema.parse(decodeReference(reference.id));
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
    id: encodeReference({ version: 1, channel, ts }),
  };
}

export function parseSlackMessageReference(
  reference: ProviderReference,
): Readonly<{ channel: string; ts: string }> {
  if (reference.provider !== "slack" || reference.resource !== "message") {
    throw new Error("The message reference does not belong to Slack");
  }
  const parsed = messageSchema.parse(decodeReference(reference.id));
  return { channel: parsed.channel, ts: parsed.ts };
}

function encodeReference(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeReference(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
