import { describe, expect, it } from "bun:test";
import {
  parseSlackDeliveryTarget,
  parseSlackMessageReference,
  slackDeliveryTarget,
  slackMessageReference,
} from "../src/channels/slack/references.js";

describe("slack delivery targets", () => {
  it("round-trips a threaded channel target", () => {
    const reference = slackDeliveryTarget("C123", "channel", "1700000000.000100");
    expect(reference.provider).toBe("slack");
    expect(reference.resource).toBe("destination");
    expect(parseSlackDeliveryTarget(reference)).toEqual({
      channel: "C123",
      channelType: "channel",
      threadTs: "1700000000.000100",
    });
  });

  it("round-trips an unthreaded direct-message target", () => {
    const reference = slackDeliveryTarget("D555", "im");
    expect(parseSlackDeliveryTarget(reference)).toEqual({
      channel: "D555",
      channelType: "im",
      threadTs: undefined,
    });
  });

  it("rejects references from other providers", () => {
    const foreign = { provider: "telegram", resource: "destination", id: "x" } as const;
    expect(() => parseSlackDeliveryTarget(foreign)).toThrow(/does not belong to Slack/);
  });
});

describe("slack message references", () => {
  it("round-trips channel and ts", () => {
    const reference = slackMessageReference("C9", "1700000000.000200");
    expect(parseSlackMessageReference(reference)).toEqual({
      channel: "C9",
      ts: "1700000000.000200",
    });
  });

  it("rejects delivery targets", () => {
    const target = slackDeliveryTarget("C9", "channel");
    expect(() => parseSlackMessageReference(target)).toThrow(/does not belong to Slack/);
  });
});
