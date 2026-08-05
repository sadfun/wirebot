import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileTelegramMenuButton,
  TelegramChannel,
  telegramMenuButton,
} from "../src/channels/telegram/channel.js";
import {
  parseTelegramDeliveryTarget,
  telegramDeliveryTarget,
  telegramMessageReference,
} from "../src/channels/telegram/references.js";
import { decodeCommandCallback, publishTelegramMessage } from "../src/channels/telegram/reply.js";
import type { TelegramReplyRoute } from "../src/channels/telegram/route.js";
import { Logger } from "../src/shared/logger.js";

describe("Telegram scheduled delivery", () => {
  it("pins the settings Mini App to the bot menu", () => {
    expect(telegramMenuButton("https://wirebot.example/miniapp")).toEqual({
      type: "web_app",
      text: "Settings",
      web_app: { url: "https://wirebot.example/miniapp" },
    });
  });

  it("restores the commands menu when the Mini App is unavailable", () => {
    expect(telegramMenuButton(undefined)).toEqual({ type: "commands" });
  });

  it("overwrites chat-specific menu buttons that would mask the Mini App default", async () => {
    const expected = telegramMenuButton("https://wirebot.example/miniapp");
    const setChatMenuButton = vi.fn(
      async (_parameters: {
        chat_id?: number;
        menu_button?: ReturnType<typeof telegramMenuButton>;
      }) => true as const,
    );
    const getChatMenuButton = vi.fn(async (_parameters: { chat_id?: number }) => expected);

    await reconcileTelegramMenuButton(
      { setChatMenuButton, getChatMenuButton } as unknown as Pick<
        Api,
        "getChatMenuButton" | "setChatMenuButton"
      >,
      new Set([42, 7]),
      "https://wirebot.example/miniapp",
      new Logger("error"),
    );

    expect(setChatMenuButton.mock.calls.map(([parameters]) => parameters)).toEqual([
      { menu_button: expected },
      { chat_id: 7, menu_button: expected },
      { chat_id: 42, menu_button: expected },
    ]);
    expect(getChatMenuButton.mock.calls.map(([parameters]) => parameters)).toEqual([
      {},
      { chat_id: 7 },
      { chat_id: 42 },
    ]);
  });

  it("continues reconciling other menu-button scopes after a Telegram API failure", async () => {
    const expected = telegramMenuButton("https://wirebot.example/miniapp");
    const setChatMenuButton = vi.fn(async (parameters: { chat_id?: number }) => {
      if (parameters.chat_id === 7) throw new Error("chat not found");
      return true as const;
    });
    const getChatMenuButton = vi.fn(async (_parameters: { chat_id?: number }) => expected);

    await reconcileTelegramMenuButton(
      { setChatMenuButton, getChatMenuButton } as unknown as Pick<
        Api,
        "getChatMenuButton" | "setChatMenuButton"
      >,
      new Set([7, 42]),
      "https://wirebot.example/miniapp",
      new Logger("error"),
    );

    expect(setChatMenuButton.mock.calls.map(([parameters]) => parameters.chat_id)).toEqual([
      undefined,
      7,
      42,
    ]);
    expect(getChatMenuButton.mock.calls.map(([parameters]) => parameters.chat_id)).toEqual([
      undefined,
      42,
    ]);
  });

  it("keeps provider routing details inside opaque versioned references", () => {
    const route = topicRoute(19);
    const target = telegramDeliveryTarget(42, route);
    const message = telegramMessageReference(42, 91);

    expect(target).toMatchObject({ provider: "telegram", resource: "destination" });
    expect(parseTelegramDeliveryTarget(target)).toEqual({
      chatId: 42,
      destination: { kind: "topic", messageThreadId: 19 },
    });
    expect(message).toMatchObject({ provider: "telegram", resource: "message" });
  });

  it("delivers scheduled notifications as one rich-markdown message with command actions", async () => {
    const sendRichMessage = vi.fn(
      async (_chatId: number, _content: unknown, _options: Record<string, unknown>) => ({
        message_id: 9,
      }),
    );
    const runId = "17d08466-a7c6-4410-b8e0-e9a207ef0919";

    const messageIds = await publishTelegramMessage(
      { sendRichMessage } as unknown as Api,
      42,
      topicRoute(19),
      {
        text: "Done",
        actions: [{ label: "Continue this run", command: { name: "continue", args: runId } }],
      },
      new Logger("error"),
    );

    expect(messageIds).toEqual([9]);
    expect(sendRichMessage).toHaveBeenCalledWith(
      42,
      { markdown: "Done" },
      {
        message_thread_id: 19,
        reply_markup: {
          inline_keyboard: [[{ text: "Continue this run", callback_data: `tx:continue:${runId}` }]],
        },
      },
    );
  });

  it("returns every split message and encodes durable command actions", async () => {
    let nextMessageId = 10;
    const sendRichMessage = vi.fn(async () => {
      throw new Error("rich messages unavailable");
    });
    const sendMessage = vi.fn(
      async (_chatId: number, _text: string, _options: Record<string, unknown>) => ({
        message_id: nextMessageId++,
      }),
    );
    const runId = "17d08466-a7c6-4410-b8e0-e9a207ef0919";

    const messageIds = await publishTelegramMessage(
      { sendRichMessage, sendMessage } as unknown as Api,
      42,
      topicRoute(19),
      {
        text: "x".repeat(5_000),
        actions: [{ label: "Continue this run", command: { name: "continue", args: runId } }],
      },
      new Logger("error"),
    );

    expect(messageIds).toEqual([10, 11]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ message_thread_id: 19 });
    const lastOptions = sendMessage.mock.calls[1]?.[2];
    expect(lastOptions).toMatchObject({
      message_thread_id: 19,
      reply_markup: {
        inline_keyboard: [[{ text: "Continue this run", callback_data: `tx:continue:${runId}` }]],
      },
    });
    expect(decodeCommandCallback(`tx:continue:${runId}`)).toEqual({
      name: "continue",
      args: runId,
    });
  });

  it("re-checks persisted provider principals against the current allowlist", () => {
    const channel = new TelegramChannel(
      "123:test",
      "https://api.telegram.org",
      new Set([7]),
      30,
      "/tmp/wirebot-test-attachments",
      new Logger("error"),
    );

    expect(channel.isAuthorized({ provider: "telegram", resource: "user", id: "7" })).toBe(true);
    expect(channel.isAuthorized({ provider: "telegram", resource: "user", id: "8" })).toBe(false);
    expect(channel.isAuthorized({ provider: "telegram", resource: "message", id: "7" })).toBe(
      false,
    );
  });
});

function topicRoute(messageThreadId: number): TelegramReplyRoute {
  return { destination: { kind: "topic", messageThreadId } };
}
