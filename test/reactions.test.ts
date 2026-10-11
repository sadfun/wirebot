import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, DiscoverResult, ListToolsResult } from "@modelcontextprotocol/server";
import { Collection } from "discord.js";
import {
  reactToDiscordMessage,
  reactToSlackMessage,
  reactToTelegramMessage,
  slackReaction,
  unicodeReaction,
} from "../src/channels/reactions.js";
import type { CodexAppServer, NotificationListener } from "../src/codex/rpc.js";
import { CodexService } from "../src/codex/service.js";
import { silentStream } from "../src/codex/thread-session.js";
import { CodexBridge } from "../src/core/bridge.js";
import type { InboundMessage } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { WirebotMcpServer } from "../src/mcp/server.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

const logger = new Logger("error");
const version = "2026-07-28";

describe("Message reactions", () => {
  test("converts shortcodes, presentation variants, and skin tones without changing the emoji", () => {
    for (const name of [":thumbsup:", ":+1:"]) expect(unicodeReaction(name)).toBe("👍");
    expect(unicodeReaction(":heart:")).toBe("❤️");
    expect(unicodeReaction(":thumbsup::skin-tone-4:")).toBe("👍🏽");
    expect(slackReaction("👍🏽")).toBe("+1::skin-tone-4");
    expect(slackReaction("❤️")).toBe("heart");
    expect(slackReaction("❤")).toBe("heart");
    expect(slackReaction(":party_blob:")).toBe("party_blob");
    expect(unicodeReaction("👨‍💻")).toBe("👨‍💻");
    for (const invalid of ["", "hello", ":unknown_reaction:", "👍👍", "hi 👍", "::"]) {
      expect(() => unicodeReaction(invalid)).toThrow();
    }
  });

  test("uses provider APIs, handles duplicates, and preserves provider failures", async () => {
    const telegram: unknown[][] = [];
    const api = {
      setMessageReaction: async (...args: unknown[]) => {
        telegram.push(args);
        return true;
      },
    };
    await reactToTelegramMessage(api, -123, 42, ":heart:");
    expect(telegram[0]).toEqual([-123, 42, [{ type: "emoji", emoji: "❤" }]]);
    await reactToTelegramMessage(api, -123, 43, ":custom_emoji_123456789:");
    expect(telegram[1]).toEqual([
      -123,
      43,
      [{ type: "custom_emoji", custom_emoji_id: "123456789" }],
    ]);
    await reactToTelegramMessage(api, -123, 44, ":100:");
    expect(telegram[2]).toEqual([-123, 44, [{ type: "emoji", emoji: "💯" }]]);

    const slack: unknown[] = [];
    const web = {
      reactions: {
        add: async (args: unknown) => {
          slack.push(args);
          return {};
        },
      },
    };
    await reactToSlackMessage(web, "C123", "100.123456", "👍🏽");
    expect(slack[0]).toEqual({ channel: "C123", timestamp: "100.123456", name: "+1::skin-tone-4" });
    web.reactions.add = async () => {
      throw { data: { error: "already_reacted" } };
    };
    await reactToSlackMessage(web, "C123", "100.123456", ":thumbsup:");
    const denied = new Error("missing_scope");
    web.reactions.add = async () => {
      throw denied;
    };
    await expect(reactToSlackMessage(web, "C123", "100.123456", "👍")).rejects.toBe(denied);
    api.setMessageReaction = async () => {
      throw new Error("REACTION_INVALID");
    };
    await expect(reactToTelegramMessage(api, -123, 42, "👍")).rejects.toThrow("REACTION_INVALID");

    const discord: string[] = [];
    const message = {
      react: async (emoji: string) => {
        discord.push(emoji);
      },
      guild: {
        emojis: {
          fetch: async () =>
            new Collection([
              ["123456789012345678", { name: "party_blob", id: "123456789012345678" }],
            ]),
        },
      },
    };
    await reactToDiscordMessage(message, ":thumbsup:");
    await reactToDiscordMessage(message, ":party_blob:");
    await reactToDiscordMessage(message, "<a:party_blob:123456789012345678>");
    expect(discord).toEqual(["👍", "123456789012345678", "<a:party_blob:123456789012345678>"]);
    await expect(reactToDiscordMessage(message, ":missing:")).rejects.toThrow("No unique Discord");
  });

  test("MCP routes concurrent and queued turns, rejects stale calls, and adds no prompt context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wirebot-reactions-"));
    const listeners: NotificationListener[] = [];
    const starts = new Map(
      ["first", "second", "other", "silent", "scheduled"].map((text) => [
        text,
        deferred<{ threadId: string; turn: Turn; params: Record<string, unknown> }>(),
      ]),
    );
    const startOf = (text: string) => {
      const started = starts.get(text);
      if (started === undefined) throw new Error(`Unexpected turn input: ${text}`);
      return started;
    };
    let nextThread = 0;
    let nextTurn = 0;
    const rpc = {
      onNotification: (listener: NotificationListener) => {
        listeners.push(listener);
        return () => {};
      },
      onExit: () => () => {},
      setServerRequestHandler: () => {},
      request: async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
        if (method === "account/read") return { account: null, requiresOpenaiAuth: false };
        if (method === "thread/start") return { thread: { id: `thread-${++nextThread}` } };
        if (method === "turn/start") {
          const turn: Turn = {
            id: `turn-${++nextTurn}`,
            rootTurnId: null,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          };
          const threadId = String(params.threadId);
          for (const listener of listeners)
            listener({ method: "turn/started", params: { threadId, turn } });
          const input = params.input as [{ text: string }];
          startOf(input[0].text).resolve({ threadId, turn, params });
          return { turn };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    } as unknown as CodexAppServer;
    const service = new CodexService(
      rpc,
      new ConversationStore(join(directory, "conversations.json"), logger),
      directory,
      directory,
      directory,
      logger,
      undefined,
      () => false,
    );
    const bridge = new CodexBridge(
      service,
      undefined,
      logger,
      {} as never,
      { contextForReply: async () => undefined } as never,
    );
    const server = new WirebotMcpServer(service.reactToLastMessage.bind(service), logger);
    const connection = await server.start();
    const authorizations = { Authorization: `Bearer ${connection.token}` };
    const request = async <Result = CallToolResult>(
      method: string,
      params: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(connection.url, {
        method: "POST",
        headers: {
          ...authorizations,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": version,
          "Mcp-Method": method,
          ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": version,
              "io.modelcontextprotocol/clientCapabilities": {},
              ...(params._meta as object),
            },
          },
        }),
      });
      return { response, body: (await response.json()) as { result: Result } };
    };
    const react = (threadId: string, turnId: string, reaction = "👍") =>
      request("tools/call", {
        name: "react_to_last_message",
        arguments: { reaction },
        _meta: { "x-codex-turn-metadata": { thread_id: threadId, turn_id: turnId } },
      });
    const reactions: string[] = [];
    const replies = new Map<string, string>();
    const message = (text: string, key: string): InboundMessage => ({
      id: text,
      address: { channel: "telegram", key, isPrivate: true, isGuest: false },
      sender: { id: "42", displayName: "User" },
      text,
      attachments: [],
      isAdmin: true,
      react: async (reaction) => {
        reactions.push(`${text}:${reaction}`);
      },
      responder: {
        createStream: () => ({
          ...silentStream,
          complete: async (reply) => {
            replies.set(text, reply);
          },
        }),
        sendText: async () => {},
        askChoice: async () => "decline",
      },
    });
    const complete = (started: { threadId: string; turn: Turn }) => {
      for (const listener of listeners)
        listener({
          method: "turn/completed",
          params: { threadId: started.threadId, turn: { ...started.turn, status: "completed" } },
        });
    };
    try {
      const discovery = await request<DiscoverResult>("server/discover");
      expect(discovery.response.status).toBe(200);
      expect(discovery.body.result.supportedVersions).toEqual([version]);
      expect(discovery.body.result._meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
        name: "wirebot",
      });
      expect(discovery.response.headers.get("Mcp-Session-Id")).toBeNull();
      const tools = await request<ListToolsResult>("tools/list");
      expect(tools.body.result.tools).toHaveLength(1);
      expect(tools.body.result.tools[0].name).toBe("react_to_last_message");
      expect(Object.keys(tools.body.result.tools[0].inputSchema.properties)).toEqual(["reaction"]);

      expect((await fetch(connection.url)).status).toBe(401);
      const oversized = await fetch(connection.url, {
        method: "POST",
        headers: authorizations,
        body: " ".repeat(40_000),
      });
      expect(oversized.status).toBe(413);
      const legacy = await fetch(connection.url, {
        method: "POST",
        headers: {
          ...authorizations,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy", version: "1" },
          },
        }),
      });
      expect(legacy.status).toBe(400);
      expect(
        (
          await fetch(connection.url, {
            headers: { ...authorizations, Origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(connection.url, { headers: { ...authorizations, Host: "evil.example" } }))
          .status,
      ).toBe(403);
      expect(
        (await request("tools/list", {}, { "Mcp-Method": "tools/call" })).response.status,
      ).toBe(400);
      const missingMetadata = await request("tools/call", {
        name: "react_to_last_message",
        arguments: { reaction: "👍" },
      });
      expect(missingMetadata.body.result.isError).toBe(true);

      const firstRun = bridge.handleMessage(message("first", "chat-a"));
      const first = await startOf("first").promise;
      const secondRun = bridge.handleMessage(message("second", "chat-a"));
      const otherRun = bridge.handleMessage(message("other", "chat-b"));
      const other = await startOf("other").promise;
      expect(first.params.input).toEqual([{ type: "text", text: "first", text_elements: [] }]);
      expect(first.params.additionalContext).toBeUndefined();
      const results = await Promise.all([
        react(first.threadId, first.turn.id),
        react(other.threadId, other.turn.id, ":heart:"),
      ]);
      expect(results.every(({ body }) => !body.result.isError)).toBe(true);
      expect(reactions.sort()).toEqual(["first:👍", "other::heart:"].sort());
      expect((await react(first.threadId, other.turn.id)).body.result.isError).toBe(true);
      expect((await react(first.threadId, first.turn.id, "")).body.result.isError).toBe(true);

      complete(first);
      await firstRun;
      expect(replies.get("first")).toBe("");
      const second = await startOf("second").promise;
      expect((await react(first.threadId, first.turn.id)).body.result.isError).toBe(true);
      expect((await react(second.threadId, second.turn.id)).body.result.isError).not.toBe(true);
      expect(reactions).toContain("second:👍");
      complete(second);
      complete(other);
      await Promise.all([secondRun, otherRun]);

      const silentRun = bridge.handleMessage(message("silent", "chat-a"));
      complete(await startOf("silent").promise);
      await silentRun;
      expect(replies.get("silent")).toBe("");

      const scheduledRun = service.runScheduledTurn({
        conversationKey: "chat-a",
        connector: "telegram",
        prompt: "scheduled",
        thread: { mode: "existing", threadId: first.threadId },
        invocation: {},
      });
      const scheduled = await startOf("scheduled").promise;
      expect((await react(scheduled.threadId, scheduled.turn.id)).body.result.isError).toBe(true);
      complete(scheduled);
      await (await scheduledRun).dispose();
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
