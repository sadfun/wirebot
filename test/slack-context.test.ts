import { expect, test } from "bun:test";
import { SlackChannel } from "../src/channels/slack/channel.js";
import { formatThreadContext, type SlackMessageEvent } from "../src/channels/slack/message.js";
import { Logger } from "../src/shared/logger.js";

test("full Slack thread context retains old messages and excludes the triggering and future messages", () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({
    ts: `${index + 1}.000`,
    user: "user",
    text: `${index}: ${"context ".repeat(20)}`,
  }));
  const context = formatThreadContext(messages, "150.000", () => "User", Number.POSITIVE_INFINITY);
  expect(context).toContain("User: 0:");
  expect(context).toContain("User: 148:");
  expect(context).not.toContain("User: 149:");
  expect(context).not.toContain("messages omitted");
});

test("Slack DMs never rehydrate pre-reset channel history", async () => {
  const channel = new SlackChannel(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["user"]),
      allowAllWorkspaceMembers: false,
    },
    "/tmp/unused",
    new Logger("error"),
  );
  // This path must return directly; the client has no credentials or network stubs.
  const internal = channel as unknown as {
    withThreadContext(event: SlackMessageEvent, botUserId: string, text: string): Promise<string>;
  };
  try {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "DM",
      channel_type: "im",
      user: "user",
      ts: "100.000",
      text: "Hello after new",
    };
    expect(await internal.withThreadContext(event, "bot", "Hello after new")).toBe(
      "Hello after new",
    );
    expect(
      await internal.withThreadContext(
        { ...event, channel_type: "channel", thread_ts: "1.000" },
        "bot",
        "/new",
      ),
    ).toBe("/new");
  } finally {
    await channel.stop();
  }
});
