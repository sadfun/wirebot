import { describe, expect, it } from "bun:test";
import {
  describeSlackFile,
  formatThreadContext,
  normalizeSlackMessage,
  routeSlackMessage,
  type SlackMessageEvent,
  type SlackThreadMessage,
  slackAttachmentKind,
} from "../src/channels/slack/message.js";

const botUserId = "U0BOT";

function event(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1700000000.000100",
    ...overrides,
  };
}

describe("routeSlackMessage", () => {
  it("always handles direct messages without threading", () => {
    const route = routeSlackMessage(event({ channel_type: "im", channel: "D1" }), botUserId);
    expect(route).toEqual({ conversationSuffix: "main", replyThreadTs: undefined });
  });

  it("requires a mention in channels", () => {
    expect(routeSlackMessage(event({}), botUserId)).toBeUndefined();
    const route = routeSlackMessage(event({ text: `<@${botUserId}> hi` }), botUserId);
    expect(route).toEqual({
      conversationSuffix: "1700000000.000100",
      replyThreadTs: "1700000000.000100",
    });
  });

  it("keys threaded mentions by the thread root", () => {
    const route = routeSlackMessage(
      event({ text: `<@${botUserId}> continue`, thread_ts: "1699.5", ts: "1700.9" }),
      botUserId,
    );
    expect(route).toEqual({ conversationSuffix: "1699.5", replyThreadTs: "1699.5" });
  });

  it("ignores thread replies without a mention", () => {
    expect(
      routeSlackMessage(event({ thread_ts: "1699.5", ts: "1700.9" }), botUserId),
    ).toBeUndefined();
  });

  it("ignores bot echoes and unsupported subtypes", () => {
    expect(
      routeSlackMessage(event({ channel_type: "im", bot_id: "B1" }), botUserId),
    ).toBeUndefined();
    expect(
      routeSlackMessage(event({ channel_type: "im", user: botUserId }), botUserId),
    ).toBeUndefined();
    expect(
      routeSlackMessage(event({ channel_type: "im", subtype: "message_changed" }), botUserId),
    ).toBeUndefined();
    const { user: _ignored, ...anonymous } = event({ channel_type: "im" });
    expect(routeSlackMessage(anonymous, botUserId)).toBeUndefined();
  });

  it("handles file_share and thread_broadcast subtypes", () => {
    expect(
      routeSlackMessage(event({ channel_type: "im", subtype: "file_share" }), botUserId),
    ).toBeDefined();
    expect(
      routeSlackMessage(
        event({ text: `<@${botUserId}> x`, subtype: "thread_broadcast" }),
        botUserId,
      ),
    ).toBeDefined();
  });
});

describe("normalizeSlackMessage", () => {
  it("strips the bot mention and decodes mrkdwn", () => {
    const normalized = normalizeSlackMessage(
      event({ text: `<@${botUserId}> check <https://example.com|this> &amp; more` }),
      botUserId,
    );
    expect(normalized.text).toBe("check this (https://example.com) & more");
  });

  it("keeps other user mentions readable", () => {
    const normalized = normalizeSlackMessage(event({ text: "ask <@U999>" }), botUserId);
    expect(normalized.text).toBe("ask @U999");
  });
});

describe("formatThreadContext", () => {
  const nameOf = (message: SlackThreadMessage): string => message.user ?? "bot";

  it("renders earlier messages and excludes the trigger", () => {
    const context = formatThreadContext(
      [
        { ts: "1", user: "U1", text: "refund request from &lt;user&gt;" },
        {
          ts: "2",
          user: "U2",
          text: "checking mixpanel",
          files: [{ id: "F1", name: "report.csv" }],
        },
        { ts: "3", user: "U3", text: "<@U0BOT> collect the facts" },
      ],
      "3",
      nameOf,
    );
    expect(context).toBe(
      "U1: refund request from <user>\nU2: checking mixpanel [attached: report.csv]",
    );
  });

  it("returns undefined when nothing besides the trigger exists", () => {
    expect(formatThreadContext([{ ts: "3", user: "U1", text: "hi" }], "3", nameOf)).toBeUndefined();
  });

  it("drops the oldest messages over the character budget", () => {
    const messages: SlackThreadMessage[] = [
      { ts: "1", user: "U1", text: "x".repeat(80) },
      { ts: "2", user: "U2", text: "y".repeat(80) },
      { ts: "3", user: "U3", text: "z".repeat(80) },
    ];
    const context = formatThreadContext(messages, "9", nameOf, 200);
    expect(context).toContain("[1 earlier messages omitted]");
    expect(context).not.toContain("x".repeat(80));
    expect(context).toContain("z".repeat(80));
  });
});

describe("slack file helpers", () => {
  it("classifies attachment kinds", () => {
    expect(slackAttachmentKind({ id: "F1", mimetype: "image/png" })).toBe("image");
    expect(slackAttachmentKind({ id: "F2", subtype: "slack_audio", mimetype: "audio/mp4" })).toBe(
      "voice",
    );
    expect(slackAttachmentKind({ id: "F3", mimetype: "audio/mpeg" })).toBe("voice");
    expect(slackAttachmentKind({ id: "F4", mimetype: "application/pdf" })).toBe("file");
    expect(slackAttachmentKind({ id: "F5" })).toBe("file");
  });

  it("describes files with metadata", () => {
    expect(
      describeSlackFile({ id: "F1", name: "report.pdf", mimetype: "application/pdf", size: 2_048 }),
    ).toBe("report.pdf (application/pdf, 2 KB)");
    expect(describeSlackFile({ id: "F2" })).toBe("attachment");
  });
});
