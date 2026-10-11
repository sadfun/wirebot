import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexAppServer,
  NotificationListener,
  ServerRequestHandler,
} from "../src/codex/rpc.js";
import { CodexService } from "../src/codex/service.js";
import { silentStream } from "../src/codex/thread-session.js";
import type { ChoiceOption, MessageResponder } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { RequestId } from "../src/generated/codex/RequestId.js";
import type { McpServerElicitationRequestParams } from "../src/generated/codex/v2/McpServerElicitationRequestParams.js";
import type { McpServerElicitationRequestResponse } from "../src/generated/codex/v2/McpServerElicitationRequestResponse.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

test("MCP approvals use the active user's choices and preserve Codex's approval scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-approvals-"));
  const logger = new Logger("error");
  const listeners: NotificationListener[] = [];
  let handleRequest: ServerRequestHandler = async () => {
    throw new Error("Server request handler not installed");
  };
  const replies = new Map<RequestId, McpServerElicitationRequestResponse>();
  let started = deferred<Turn>();
  let nextTurn = 0;
  const rpc = {
    onNotification: (listener: NotificationListener) => {
      listeners.push(listener);
      return () => {};
    },
    onExit: () => () => {},
    setServerRequestHandler: (handler: ServerRequestHandler) => {
      handleRequest = handler;
    },
    reply: async (id: RequestId, response: McpServerElicitationRequestResponse) => {
      replies.set(id, response);
    },
    request: async ({ method }: { method: string }) => {
      if (method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method !== "turn/start") throw new Error(`Unexpected RPC: ${method}`);
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
      for (const listener of listeners)
        listener({ method: "turn/started", params: { threadId: "thread", turn } });
      started.resolve(turn);
      return { turn };
    },
  } as unknown as CodexAppServer;
  const service = new CodexService(
    rpc,
    new ConversationStore(join(directory, "conversations.json"), logger),
    directory,
    directory,
    directory,
    logger,
  );
  let decision = "once";
  const prompts: { text: string; options: readonly ChoiceOption[] }[] = [];
  const waiting = deferred<void>();
  const responder: MessageResponder = {
    createStream: () => silentStream,
    sendText: async () => {},
    askChoice: async (text, options, signal) => {
      prompts.push({ text, options });
      if (decision !== "pending") return decision;
      if (signal === undefined) throw new Error("Approval cancellation signal is missing");
      return await new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("decline"), { once: true });
        waiting.resolve();
      });
    },
  };
  const run = service.runTurn("chat", "telegram", "Hello", responder, false, [], {});
  const turn = await started.promise;
  const metadata = {
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    tool_description: "Update an issue.",
    tool_params: { issue: 42 },
  };
  const params: McpServerElicitationRequestParams = {
    threadId: "thread",
    turnId: turn.id,
    serverName: "external",
    mode: "form",
    message: 'Allow tool "update_issue"?',
    _meta: metadata,
    requestedSchema: { type: "object", properties: {} },
  };
  let requestId = 0;
  const request = async (overrides: Partial<McpServerElicitationRequestParams> = {}) => {
    const id = ++requestId;
    await handleRequest({
      id,
      method: "mcpServer/elicitation/request",
      params: { ...params, ...overrides } as McpServerElicitationRequestParams,
    });
    return replies.get(id);
  };
  const declined = { action: "decline", content: null, _meta: null };
  const complete = (current: Turn) => {
    for (const listener of listeners)
      listener({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { ...current, status: "completed" },
        },
      });
  };
  try {
    expect(await request()).toEqual({ action: "accept", content: {}, _meta: null });
    expect(prompts[0]?.text).toContain("MCP server: external");
    expect(prompts[0]?.text).toContain("Update an issue.");
    expect(prompts[0]?.text).toContain('"issue": 42');
    expect(prompts[0]?.options.map(({ id }) => id)).toEqual(["once", "session", "decline"]);
    decision = "session";
    expect(await request()).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "session" },
    });
    decision = "decline";
    expect(await request()).toEqual(declined);
    decision = "once";
    expect(await request({ _meta: { ...metadata, persist: [] } })).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
    expect(prompts.at(-1)?.options.map(({ id }) => id)).toEqual(["once", "decline"]);
    decision = "session";
    expect(await request({ _meta: { ...metadata, persist: [] } })).toEqual(declined);

    const promptCount = prompts.length;
    for (const overrides of [
      { turnId: null },
      { turnId: "stale" },
      { threadId: "other" },
      { _meta: null },
      { _meta: [] },
      { _meta: { codex_approval_kind: "other" } },
      {
        requestedSchema: {
          type: "object" as const,
          properties: { name: { type: "string" as const } },
        },
      },
      { mode: "url" as const, url: "https://example.com/login", elicitationId: "login" },
    ])
      expect(await request(overrides)).toEqual(declined);
    expect(prompts).toHaveLength(promptCount);

    decision = "pending";
    const pending = request();
    await waiting.promise;
    for (const listener of listeners)
      listener({ method: "serverRequest/resolved", params: { threadId: "thread", requestId } });
    expect(await pending).toEqual(declined);

    complete(turn);
    await run;
    const afterCompletion = prompts.length;
    expect(await request()).toEqual(declined);
    expect(prompts).toHaveLength(afterCompletion);
    started = deferred<Turn>();
    const scheduled = service.runScheduledTurn({
      conversationKey: "chat",
      connector: "telegram",
      prompt: "Background work",
      thread: { mode: "existing", threadId: "thread" },
      invocation: {},
    });
    const unattended = await started.promise;
    expect(await request({ turnId: unattended.id })).toEqual(declined);
    expect(prompts).toHaveLength(afterCompletion);
    complete(unattended);
    await (await scheduled).dispose();
  } finally {
    complete(turn);
    await run;
    await rm(directory, { recursive: true, force: true });
  }
});
