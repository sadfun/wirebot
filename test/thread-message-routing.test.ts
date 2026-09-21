import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServer, NotificationListener } from "../src/codex/rpc.js";
import { CodexService } from "../src/codex/service.js";
import { silentStream } from "../src/codex/thread-session.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

test("external messages resume their bound thread without replacing the thread selected by /new", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-routing-"));
  const logger = new Logger("error");
  const store = new ConversationStore(join(directory, "conversations.json"), logger);
  await store.load();
  await store.set("chat", "thread-B");
  const listeners: NotificationListener[] = [];
  const requests: { method: string; params?: { threadId?: string } }[] = [];
  const started = deferred<Turn>();
  const rpc = {
    onNotification: (listener: NotificationListener) => {
      listeners.push(listener);
      return () => {};
    },
    onExit: () => () => {},
    setServerRequestHandler: () => {},
    request: async (request: { method: string; params?: { threadId?: string } }) => {
      requests.push(request);
      if (request.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (request.method === "thread/resume") return { thread: { id: request.params?.threadId } };
      if (request.method !== "turn/start") throw new Error(`Unexpected RPC: ${request.method}`);
      const turn: Turn = {
        id: "turn",
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      for (const listener of listeners)
        listener({ method: "turn/started", params: { threadId: "thread-A", turn } });
      started.resolve(turn);
      return { turn };
    },
  } as unknown as CodexAppServer;
  const service = new CodexService(rpc, store, directory, directory, directory, logger);
  let authorized = false;
  try {
    const run = service.runTurn(
      "chat",
      "telegram",
      "External result",
      {
        createStream: () => silentStream,
        sendText: async () => {},
        askChoice: async () => "decline",
      },
      false,
      [],
      { externalMessage: true },
      false,
      {
        threadId: "thread-A",
        authorize: async () => {
          authorized = true;
        },
      },
    );
    const turn = await started.promise;
    expect(authorized).toBe(true);
    expect(requests.find((request) => request.method === "thread/resume")?.params?.threadId).toBe(
      "thread-A",
    );
    expect(requests.find((request) => request.method === "turn/start")?.params?.threadId).toBe(
      "thread-A",
    );
    for (const listener of listeners)
      listener({
        method: "turn/completed",
        params: { threadId: "thread-A", turn: { ...turn, status: "completed" } },
      });
    await run;
    expect(store.get("chat")).toBe("thread-B");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
