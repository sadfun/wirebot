import { describe, expect, test } from "bun:test";
import { DiscordChannel } from "../src/channels/discord/channel.js";
import { SlackChannel } from "../src/channels/slack/channel.js";
import { TelegramChannel } from "../src/channels/telegram/channel.js";
import { Logger } from "../src/shared/logger.js";

const logger = new Logger("error");
describe("Connector browser admin policy", () => {
  for (const provider of ["discord", "slack"] as const) {
    test(`${provider} requires both ordinary access and the configured admin list`, async () => {
      for (const adminUserIds of [undefined, new Set(["admin", "outsider"])]) {
        const config = {
          botToken: "test-bot-token",
          allowedUserIds: new Set(["admin", "member"]),
          adminUserIds,
        };
        const channel =
          provider === "discord"
            ? new DiscordChannel(config, logger)
            : new SlackChannel(
                {
                  ...config,
                  botToken: "xoxb-test",
                  appToken: "xapp-test",
                  allowAllWorkspaceMembers: false,
                },
                "/tmp/unused",
                logger,
              );
        try {
          expect(await channel.isAuthorizedAdmin({ provider, resource: "user", id: "admin" })).toBe(
            true,
          );
          expect(
            await channel.isAuthorizedAdmin({ provider, resource: "user", id: "member" }),
          ).toBe(adminUserIds === undefined);
          expect(
            await channel.isAuthorizedAdmin({ provider, resource: "user", id: "outsider" }),
          ).toBe(false);
          expect(
            await channel.isAuthorizedAdmin({
              provider: "telegram",
              resource: "user",
              id: "admin",
            }),
          ).toBe(false);
        } finally {
          await channel.stop();
        }
      }
    });
  }
  test("Telegram treats each allowlisted user as an admin", async () => {
    const channel = new TelegramChannel(
      "123456:TEST_BOT_TOKEN",
      "https://api.telegram.org",
      new Set([42]),
      30,
      "/tmp/unused",
      logger,
    );
    try {
      expect(
        await channel.isAuthorizedAdmin({ provider: "telegram", resource: "user", id: "42" }),
      ).toBe(true);
      expect(
        await channel.isAuthorizedAdmin({ provider: "telegram", resource: "user", id: "43" }),
      ).toBe(false);
    } finally {
      await channel.stop();
    }
  });
});
