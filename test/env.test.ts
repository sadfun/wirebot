import { describe, expect, it } from "bun:test";
import { loadAppConfig } from "../src/config/env.js";

const telegram = {
  TELEGRAM_BOT_TOKEN: "12345678901234567890:token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 9001",
};

const slack = {
  SLACK_BOT_TOKEN: "xoxb-123",
  SLACK_APP_TOKEN: "xapp-1-A1-123-abc",
  SLACK_ALLOWED_USER_IDS: "U0123ABC",
};

describe("loadAppConfig connectors", () => {
  it("parses Telegram and leaves Slack disabled", () => {
    const config = loadAppConfig(telegram);
    expect([...(config.telegram?.allowedUserIds ?? [])]).toEqual([42, 9001]);
    expect(config.slack).toBeUndefined();
  });

  it("supports Slack-only operation", () => {
    const config = loadAppConfig(slack);
    expect(config.telegram).toBeUndefined();
    expect(config.slack).toMatchObject({
      botToken: slack.SLACK_BOT_TOKEN,
      appToken: slack.SLACK_APP_TOKEN,
      allowAllWorkspaceMembers: false,
    });
  });

  it("supports both connectors", () => {
    const config = loadAppConfig({ ...telegram, ...slack });
    expect(config.telegram).toBeDefined();
    expect(config.slack).toBeDefined();
  });

  it("supports all regular Slack workspace members and an admin allowlist", () => {
    const config = loadAppConfig({
      ...slack,
      SLACK_ALLOWED_USER_IDS: "*",
      SLACK_ADMIN_USER_IDS: "u0admin0aaa, W0ADMIN0BBB",
    });
    expect(config.slack?.allowAllWorkspaceMembers).toBe(true);
    expect([...(config.slack?.allowedUserIds ?? ["sentinel"])]).toEqual([]);
    expect([...(config.slack?.adminUserIds ?? [])]).toEqual(["U0ADMIN0AAA", "W0ADMIN0BBB"]);
  });

  it("rejects missing and partial connector groups", () => {
    expect(() => loadAppConfig({})).toThrow(/at least one connector/);
    expect(() => loadAppConfig({ TELEGRAM_BOT_TOKEN: telegram.TELEGRAM_BOT_TOKEN })).toThrow(
      /set together/,
    );
    expect(() => loadAppConfig({ ...telegram, SLACK_BOT_TOKEN: slack.SLACK_BOT_TOKEN })).toThrow(
      /set together/,
    );
  });

  it("rejects malformed Slack authorization and tokens", () => {
    expect(() => loadAppConfig({ ...slack, SLACK_ALLOWED_USER_IDS: "*,U0123ABC" })).toThrow();
    expect(() => loadAppConfig({ ...slack, SLACK_ALLOWED_USER_IDS: "not-a-user" })).toThrow();
    expect(() => loadAppConfig({ ...slack, SLACK_BOT_TOKEN: "xoxp-user-token" })).toThrow();
    expect(() => loadAppConfig({ ...telegram, SLACK_ADMIN_USER_IDS: "U0ADMIN0AAA" })).toThrow(
      /requires the Slack connector/,
    );
  });
});
