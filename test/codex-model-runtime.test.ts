import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRoutingRequest, AutoTurnSettings } from "../src/codex/auto-mode.js";
import type { CodexAppServer, NotificationListener } from "../src/codex/rpc.js";
import { CodexRuntimeService } from "../src/codex/runtime-service.js";
import { CodexService } from "../src/codex/service.js";
import { silentStream } from "../src/codex/thread-session.js";
import type { MessageResponder } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

test("hot-reloaded model and speed reach new and existing turns with partial-answer support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-model-runtime-"));
  const logger = new Logger("error");
  const listeners: NotificationListener[] = [];
  const requests: { method: string; params?: unknown }[] = [];
  let config = {
    model: "gpt-6.1-sol" as string | null,
    service_tier: "ultrafast" as string | null,
    model_reasoning_effort: "ultra" as string | null,
  };
  let started = deferred<Turn>();
  let autoSettings: AutoTurnSettings = {};
  let pendingRouting: ReturnType<typeof deferred<AutoTurnSettings>> | undefined;
  let routingStarted = deferred<void>();
  let count = 0;
  const routingRequests: AutoRoutingRequest[] = [];
  const skillRequests: string[] = [];
  let transcriptionFails = false;
  const notify = (notification: ServerNotification) => {
    for (const listener of listeners) listener(notification);
  };
  const rpc = {
    onNotification: (listener: NotificationListener) => {
      listeners.push(listener);
      return () => {};
    },
    onExit: () => () => {},
    setServerRequestHandler: () => {},
    async request(message: { method: string; params?: unknown }) {
      requests.push(message);
      switch (message.method) {
        case "config/read":
          return { config: { ...config, model_provider: "openai" }, layers: [] };
        case "skills/list":
          return { data: [] };
        case "config/mcpServer/reload":
          return {};
        case "account/read":
          return { account: null, requiresOpenaiAuth: false };
        case "thread/start":
          return { thread: { id: "thread" }, model: config.model ?? "gpt-6.1-sol" };
        case "turn/start": {
          const turn: Turn = {
            id: `turn-${++count}`,
            rootTurnId: null,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          };
          notify({ method: "turn/started", params: { threadId: "thread", turn } });
          started.resolve(turn);
          return { turn };
        }
        default:
          throw new Error(`Unexpected RPC: ${message.method}`);
      }
    },
  } as unknown as CodexAppServer;
  const service = new CodexService(
    rpc,
    new ConversationStore(join(directory, "conversations.json"), logger),
    directory,
    directory,
    directory,
    logger,
    {
      transcribe: async () => {
        if (transcriptionFails) throw new Error("Transcription unavailable");
        return "Use $voice-skill to summarize this.";
      },
    },
    () => false,
    {
      effectiveSettings: () => runtime.settings(),
      explicitSkillInputs: (text) => {
        skillRequests.push(text);
        return [];
      },
      autoRouting: async (request) => {
        routingRequests.push(request);
        routingStarted.resolve();
        return pendingRouting === undefined ? autoSettings : await pendingRouting.promise;
      },
      defaultReasoningEffort: async (model) => (model === "gpt-6-luna" ? "medium" : "high"),
    },
  );
  const runtime = new CodexRuntimeService({
    rpc,
    codex: service,
    configService: { invalidateCapabilities: () => {} },
    workspace: directory,
    logger,
  });
  const delivered: string[] = [];
  const streamed: string[] = [];
  const responder: MessageResponder = {
    createStream: () => ({
      ...silentStream,
      appendFinal: (text) => {
        streamed.push(text);
      },
      complete: async (text) => {
        delivered.push(text);
      },
    }),
    sendText: async () => {},
    askChoice: async () => "decline",
  };
  try {
    expect((await runtime.start()).state).toBe("ready");
    for (const speed of ["ultrafast", null]) {
      if (speed === null) {
        config = { model: "gpt-6-luna", service_tier: null, model_reasoning_effort: "max" };
        expect((await runtime.afterConfigWrite()).state).toBe("ready");
      }
      started = deferred<Turn>();
      const run = service.runTurn("chat", "slack", "Hello", responder, false, [], {});
      const turn = await started.promise;
      const items: ThreadItem[] = [];
      for (const phase of ["partial_answer", "final_answer"] as const) {
        const item: ThreadItem = {
          type: "agentMessage",
          id: phase,
          text: "",
          phase,
          memoryCitation: null,
          delivery: null,
          questions: null,
        };
        notify({ method: "item/started", params: { threadId: "thread", turnId: turn.id, item } });
        const text = phase === "partial_answer" ? "An interim answer" : "The final answer";
        notify({
          method: "item/agentMessage/delta",
          params: { threadId: "thread", turnId: turn.id, itemId: item.id, delta: text },
        });
        item.text = text;
        items.push(item);
        notify({ method: "item/completed", params: { threadId: "thread", turnId: turn.id, item } });
      }
      notify({
        method: "turn/completed",
        params: { threadId: "thread", turn: { ...turn, status: "completed", items } },
      });
      await run;
    }
    expect(
      requests
        .filter((request) => request.method === "thread/start")
        .map((request) => request.params),
    ).toMatchObject([{ model: "gpt-6.1-sol", serviceTier: "ultrafast" }]);
    expect(
      requests
        .filter((request) => request.method === "turn/start")
        .map((request) => request.params),
    ).toMatchObject([
      { model: "gpt-6.1-sol", serviceTier: "ultrafast", effort: "ultra" },
      { model: "gpt-6-luna", serviceTier: null, effort: "max" },
    ]);
    expect(streamed).toContain("An interim answer");
    expect(delivered).toEqual(["The final answer", "The final answer"]);

    // Auto only overrides effort/speed; the user's selected model still reaches Codex.
    autoSettings = { effort: "max", serviceTierForTurn: "priority" };
    started = deferred<Turn>();
    const automatic = service.runTurn("chat", "slack", "Investigate quickly", responder);
    const automaticTurn = await started.promise;
    expect(
      requests.filter((request) => request.method === "turn/start").at(-1)?.params,
    ).toMatchObject({
      model: "gpt-6-luna",
      effort: "max",
      serviceTier: null,
      serviceTierForTurn: "priority",
    });
    notify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { ...automaticTurn, status: "completed" } },
    });
    await automatic;

    // The server preserves model/effort for null turn/start fields. A loaded
    // model-specific thread must use its own capabilities and restore defaults.
    config = { model: null, service_tier: null, model_reasoning_effort: null };
    await runtime.afterConfigWrite();
    autoSettings = {};
    started = deferred<Turn>();
    const manual = service.runTurn("chat", "slack", "Hello", responder);
    const manualTurn = await started.promise;
    expect(routingRequests.at(-1)?.model).toBe("gpt-6-luna");
    expect(
      requests.filter((request) => request.method === "turn/start").at(-1)?.params,
    ).toMatchObject({ model: null, effort: "medium", serviceTier: null });
    notify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { ...manualTurn, status: "completed" } },
    });
    await manual;
    started = deferred<Turn>();
    const scheduled = service.runScheduledTurn({
      conversationKey: "chat",
      connector: "slack",
      prompt: "Check status",
      thread: { mode: "existing", threadId: "thread" },
      invocation: {},
    });
    const scheduledTurn = await started.promise;
    expect(
      requests.filter((request) => request.method === "turn/start").at(-1)?.params,
    ).toMatchObject({ effort: "medium", serviceTier: null });
    notify({
      method: "turn/completed",
      params: { threadId: "thread", turn: { ...scheduledTurn, status: "completed" } },
    });
    await (await scheduled).dispose();

    pendingRouting = deferred<AutoTurnSettings>();
    routingStarted = deferred<void>();
    const stopped = service.runTurn("chat", "slack", "Research more", responder);
    await routingStarted.promise;
    expect(await service.interrupt("chat")).toBe(true);
    pendingRouting.resolve({ effort: "ultra", serviceTierForTurn: "default" });
    await stopped;
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(5);
    expect(delivered.at(-1)).toBe("Stopped.");

    // History remains context, while routing and skill selection use the current
    // request, including either its voice transcript or the transcription notice.
    pendingRouting = undefined;
    const requestText = "Summarize this using $current-skill.";
    const context = "Earlier message: debug this urgently using $old-skill.";
    for (const mode of ["text", "voice", "failed-voice"] as const) {
      transcriptionFails = mode === "failed-voice";
      const addition =
        mode === "text"
          ? ""
          : mode === "voice"
            ? "\n\nVoice message transcript:\nUse $voice-skill to summarize this."
            : "\n\nNote: voice transcription is unavailable, so the voice message is forwarded untranscribed as an audio file.";
      const text = `${context}\n\n${requestText}`;
      started = deferred<Turn>();
      const contextual = service.runTurn(
        "chat",
        "slack",
        text,
        responder,
        false,
        mode === "text"
          ? []
          : [{ kind: "voice", path: join(directory, "voice.ogg"), description: "Voice message" }],
        {},
        false,
        requestText,
      );
      const contextualTurn = await started.promise;
      expect(skillRequests.at(-1)).toBe(requestText + addition);
      expect(routingRequests.at(-1)).toMatchObject({
        text: text + addition,
        requestText: requestText + addition,
      });
      expect(
        requests.filter((request) => request.method === "turn/start").at(-1)?.params,
      ).toMatchObject({
        input: [{ type: "text", text: expect.stringContaining(text + addition) }],
      });
      notify({
        method: "turn/completed",
        params: { threadId: "thread", turn: { ...contextualTurn, status: "completed" } },
      });
      await contextual;
    }
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
