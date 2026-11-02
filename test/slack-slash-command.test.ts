import { describe, expect, mock, spyOn, test } from "bun:test";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ScheduledRunsEngine } from "../src/automations/engine.js";
import { SlackChannel } from "../src/channels/slack/channel.js";
import { parseSlackDeliveryTarget } from "../src/channels/slack/references.js";
import type { CodexService } from "../src/codex/service.js";
import { CodexBridge } from "../src/core/bridge.js";
import type { InboundMessage, SendOptions } from "../src/core/channel.js";
import { BrowserAuth } from "../src/miniapp/browser-auth.js";
import { Logger } from "../src/shared/logger.js";

describe("Slack slash-command browser sign-in", () => {
  for (const command of ["web", "config"]) {
    for (const channelId of ["D123", "C123"]) {
      test(`/wirebot ${command} in ${channelId}`, async () => {
        const apiCall = spyOn(WebClient.prototype, "apiCall").mockResolvedValue({
          ok: true,
          user_id: "bot",
          team_id: "team",
        });
        const start = spyOn(SocketModeClient.prototype, "start").mockResolvedValue({ ok: true });
        const logger = new Logger("error");
        const channel = new SlackChannel(
          {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            allowedUserIds: new Set(["admin"]),
            allowAllWorkspaceMembers: false,
          },
          "/tmp/unused",
          logger,
        );
        const auth = new BrowserAuth((owner) => channel.isAuthorizedAdmin(owner));
        const issue = spyOn(auth, "issue");
        const sendText = mock(async (_text: string, _options?: SendOptions) => {});
        const bridge = new CodexBridge(
          { onLoginCompleted: () => () => {} } as unknown as CodexService,
          "https://wirebot.example",
          logger,
          {
            status: () => {
              throw new Error("unused");
            },
            reload: async () => {},
            restart: async () => {},
          },
          {} as ScheduledRunsEngine,
          auth,
        );
        const handleMessage = mock(async (message: InboundMessage) => {
          spyOn(message.responder, "sendText").mockImplementation(sendText);
          await bridge.handleMessage(message);
        });
        try {
          await channel.start(handleMessage);
          // biome-ignore lint/complexity/useLiteralKeys: Exercise the private handler without a live Slack socket.
          await channel["handleSlashCommand"]({
            command: "/wirebot",
            text: command,
            user_id: "admin",
            user_name: "Admin",
            channel_id: channelId,
            // A channel name must not make a public channel look private.
            channel_name: "directmessage",
          });
          expect(handleMessage).toHaveBeenCalledTimes(1);
          const target = handleMessage.mock.calls[0]?.[0].address.deliveryTarget;
          expect(target).toBeDefined();
          if (target === undefined) throw new Error("Missing Slack delivery target");
          expect(parseSlackDeliveryTarget(target)).toEqual({
            channel: channelId,
            channelType: channelId.startsWith("D") ? "im" : "channel",
            threadTs: undefined,
          });
          if (channelId.startsWith("D")) {
            expect(issue).toHaveBeenCalledTimes(1);
            const button = sendText.mock.calls[0]?.[1]?.button;
            expect(button?.url).toMatch(/^https:\/\/wirebot.example\/app#login=[A-Za-z0-9_-]{43}$/);
            const token = new URL(button?.url ?? "").hash.slice("#login=".length);
            const principal = await auth.authenticate(await auth.exchange(token));
            expect(principal.owner).toEqual({ provider: "slack", resource: "user", id: "admin" });
            expect(principal.conversation).toEqual({
              provider: "slack",
              resource: "conversation",
              id: `slack:${channelId}:main`,
            });
            expect(principal.deliveryTarget).toEqual(target);
          } else {
            expect(issue).not.toHaveBeenCalled();
            expect(sendText).toHaveBeenCalledTimes(1);
            expect(sendText.mock.calls[0]?.[1]?.button).toBeUndefined();
          }
        } finally {
          await channel.stop();
          apiCall.mockRestore();
          start.mockRestore();
        }
      });
    }
  }
});
