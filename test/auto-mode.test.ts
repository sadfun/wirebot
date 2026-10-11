import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoModeRouter,
  explicitSpeed,
  fallbackDecision,
  settingsForDecision,
} from "../src/codex/auto-mode.js";
import type { ModelCapability } from "../src/codex/config-service.js";
import type { CodexAppServer, NotificationListener } from "../src/codex/rpc.js";
import type { RoutingDecision } from "../src/core/auto-routing.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import { WirebotSettingsStore } from "../src/core/settings-store.js";
import type { ReasoningEffort } from "../src/generated/codex/ReasoningEffort.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";
import { modelCatalog } from "./fixtures/model-catalog.js";
import { snapshot } from "./fixtures/web-app.js";

const logger = new Logger("error");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
const model: ModelCapability = {
  ...required(modelCatalog[0]),
  supportedReasoningEfforts: (["low", "medium", "high", "xhigh", "max", "ultra"] as const).map(
    (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
  ),
};
const message = (text: string): ThreadItem => ({
  type: "userMessage",
  id: crypto.randomUUID(),
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

async function fixture(timeoutMs = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-routing-test-"));
  directories.push(directory);
  const store = new ConversationStore(join(directory, "conversations.json"), logger);
  await store.set("chat", "main");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<NotificationListener>();
  const state = {
    enabled: true,
    account: "chatgpt",
    output: '{"task":"task","fast":false}',
    wait: false,
    legacy: false,
    fresh: false,
    stall: "",
    stalled: deferred<void>(),
    release: deferred<void>(),
    models: [model] as readonly ModelCapability[],
    history: [[message("Original request")], [message("More context")]] as ThreadItem[][],
  };
  const rpc = {
    onNotification: (listener: NotificationListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: () => () => {},
    async request(call: { method: string; params: Record<string, unknown> }) {
      calls.push(call);
      if (state.stall === call.method) {
        state.stalled.resolve();
        await state.release.promise;
      }
      switch (call.method) {
        case "thread/items/list": {
          if (state.legacy) throw new Error("thread/items/list is not supported yet");
          const page = Number(call.params.cursor ?? 0);
          return {
            data: state.history[page]?.map((item) => ({ item })) ?? [],
            nextCursor: page + 1 < state.history.length ? String(page + 1) : null,
          };
        }
        case "thread/read":
          if (state.fresh)
            throw new Error(
              "thread main is not materialized yet; includeTurns is unavailable before first user message",
            );
          return { thread: { turns: [{ itemsView: "full", items: state.history.flat() }] } };
        case "account/read":
          return { account: { type: state.account } };
        case "config/read":
          return {
            config: {
              mcp_servers: {
                external: { url: "https://example.test", enabled: true },
                wirebot: { url: "http://127.0.0.1:9999", enabled: true },
              },
            },
          };
        case "thread/start":
          return { thread: { id: "classifier" } };
        case "turn/start":
          return {
            turn: {
              id: "classification",
              status: state.wait ? "inProgress" : "completed",
              items: [{ type: "agentMessage", phase: "final_answer", text: state.output }],
            },
          };
        case "thread/unsubscribe":
        case "turn/interrupt":
          return {};
        default:
          throw new Error(`Unexpected RPC ${call.method}`);
      }
    },
  } as unknown as CodexAppServer;
  const router = new AutoModeRouter(
    rpc,
    {
      read: async () => {
        if (state.stall === "snapshot") {
          state.stalled.resolve();
          await state.release.promise;
        }
        return {
          ...snapshot,
          capabilities: { ...snapshot.capabilities, models: state.models },
        };
      },
    },
    store,
    () => state.enabled,
    logger,
    timeoutMs,
  );
  const route = (text: string, signal?: AbortSignal, threadId = "main", requestText?: string) =>
    router.route({
      conversationKey: "chat",
      threadId,
      model: model.model,
      text,
      ...(requestText === undefined ? {} : { requestText }),
      hasAttachments: false,
      ...(signal === undefined ? {} : { signal }),
    });
  const notify = (notification: ServerNotification) => {
    for (const listener of listeners) listener(notification);
  };
  return { directory, store, state, calls, listeners, route, notify };
}

test("auto effort matches task difficulty and explicit speed follows model entitlements", () => {
  const cases: [RoutingDecision["task"], ReasoningEffort][] = [
    ["simple", "low"],
    ["question", "medium"],
    ["task", "high"],
    ["complex", "xhigh"],
    ["research", "ultra"],
    ["bug_research", "ultra"],
  ];
  for (const [task, effort] of cases)
    expect(settingsForDecision({ task, fast: false }, model)).toEqual({
      effort,
      serviceTierForTurn: "default",
    });
  expect(settingsForDecision({ task: "research", fast: true }, model)).toEqual({
    effort: "ultra",
    serviceTierForTurn: "ultrafast",
  });
  expect(settingsForDecision({ task: "research", fast: true }, required(modelCatalog[2]))).toEqual({
    effort: "max",
    serviceTierForTurn: "priority",
  });
  expect(settingsForDecision({ task: "task", fast: true }, { ...model, serviceTiers: [] })).toEqual(
    { effort: "high", serviceTierForTurn: "default" },
  );
  expect(explicitSpeed("Optimize the fast mode in our app")).toBeUndefined();
  expect(explicitSpeed("Please answer quickly")).toBe(true);
  expect(explicitSpeed("Investigate thoroughly, no rush")).toBe(false);
  for (const text of [
    "don't be quick",
    "do not answer quickly",
    "don't use fast mode",
    "no need to use ultrafast",
  ])
    expect(explicitSpeed(text)).toBe(false);
  expect(explicitSpeed("Быстро: столица Франции")).toBe(true);
  expect(fallbackDecision("Как работают замыкания", false).task).toBe("question");
});

const classifierTurn: Turn = {
  id: "classification",
  rootTurnId: null,
  status: "inProgress",
  items: [],
  itemsView: "notLoaded",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
};

test("classification retains streamed agent text when completion has no items", async () => {
  const f = await fixture();
  f.state.wait = true;
  const result = f.route("Please investigate");
  while (!f.calls.some((call) => call.method === "turn/start")) await Bun.sleep(1);
  f.notify({
    method: "item/completed",
    params: {
      threadId: "classifier",
      turnId: "classification",
      item: {
        type: "agentMessage",
        id: "answer",
        phase: "final_answer",
        text: '{"task":"research","fast":false}',
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    },
  });
  f.notify({
    method: "turn/completed",
    params: { threadId: "classifier", turn: { ...classifierTurn, status: "completed" } },
  });
  expect(await result).toEqual({ effort: "ultra", serviceTierForTurn: "default" });
});

test("stop releases every startup wait and cleans up late thread and turn responses", async () => {
  for (const method of [
    "snapshot",
    "thread/items/list",
    "account/read",
    "config/read",
    "thread/start",
    "turn/start",
  ]) {
    const f = await fixture(5_000);
    f.state.stall = method;
    f.state.wait = true;
    const controller = new AbortController();
    const result = f.route("Debug this", controller.signal);
    await f.state.stalled.promise;
    if (method === "turn/start")
      f.notify({
        method: "turn/started",
        params: { threadId: "classifier", turn: classifierTurn },
      });
    controller.abort();
    expect(await Promise.race([result, Bun.sleep(200).then(() => "blocked")])).toEqual({});
    expect(f.store.routing("chat", "main")).toBeUndefined();
    if (method === "turn/start")
      expect(f.calls.some((call) => call.method === "turn/interrupt")).toBe(true);
    f.state.release.resolve();
    await Bun.sleep(5);
    if (method === "thread/start")
      expect(f.calls.some((call) => call.method === "thread/unsubscribe")).toBe(true);
    expect(f.listeners.size).toBe(0);
  }
});

test("the routing deadline includes history retrieval and does not launch a late classifier", async () => {
  const f = await fixture(20);
  f.state.stall = "thread/items/list";
  const result = f.route("Debug this");
  await f.state.stalled.promise;
  expect(await result).toEqual({ effort: "ultra", serviceTierForTurn: "default" });
  f.state.release.resolve();
  await Bun.sleep(5);
  expect(f.calls.some((call) => call.method === "thread/start")).toBe(false);
});

test("local routing uses the latest request while subscription classification keeps full Slack context", async () => {
  const f = await fixture();
  f.state.account = "apiKey";
  expect(await f.route("Earlier: debug this asap\n\nHello", undefined, "main", "Hello")).toEqual({
    effort: "low",
    serviceTierForTurn: "default",
  });
  f.state.account = "chatgpt";
  await f.route("Earlier: debug this asap\n\nHello", undefined, "main", "Hello");
  const input = required(f.calls.find((call) => call.method === "turn/start")).params.input as {
    text: string;
  }[];
  expect(JSON.parse(required(input[0]).text)).toMatchObject({
    request: "Earlier: debug this asap\n\nHello",
    latestRequest: "Hello",
  });
});

test("every turn reclassifies using every history page, without truncating the latest request", async () => {
  const f = await fixture();
  f.state.output = '{"task":"bug_research","fast":false}';
  expect(await f.route("Investigate the crash")).toEqual({
    effort: "ultra",
    serviceTierForTurn: "default",
  });
  f.state.output = '{"task":"simple","fast":true}';
  const longRequest = `${"A".repeat(13_000)} Answer quickly: what is 2+2?`;
  expect(await f.route(longRequest)).toEqual({ effort: "low", serviceTierForTurn: "ultrafast" });
  const turns = f.calls.filter((call) => call.method === "turn/start");
  expect(turns).toHaveLength(2);
  const input = required(turns[1]).params.input as { text: string }[];
  const payload = JSON.parse(required(input[0]).text);
  expect(payload.history).toEqual(f.state.history.flat());
  expect(payload.request).toBe(longRequest);
  expect(required(turns[1]).params).toMatchObject({
    model: "gpt-6.1-sol",
    effort: "low",
    serviceTier: "priority",
    outputSchema: { additionalProperties: false },
  });
  const classifier = required(f.calls.find((call) => call.method === "thread/start")).params;
  expect(classifier).toMatchObject({
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    selectedCapabilityRoots: [],
    dynamicTools: [],
    config: {
      mcp_servers: { external: { enabled: false }, wirebot: { enabled: false } },
      features: { shell_tool: false, apps: false, memories: false, multi_agent: false },
    },
  });
  expect(f.listeners.size).toBe(0);
  expect(await Bun.file(String(classifier.cwd)).exists()).toBe(false);
});

test("legacy Codex rollout history is hydrated in full", async () => {
  const f = await fixture();
  f.state.legacy = true;
  expect(await f.route("Implement this")).toEqual({
    effort: "high",
    serviceTierForTurn: "default",
  });
  expect(f.calls.find((call) => call.method === "thread/read")?.params).toEqual({
    threadId: "main",
    includeTurns: true,
  });
  const input = required(f.calls.find((call) => call.method === "turn/start")).params.input as {
    text: string;
  }[];
  expect(JSON.parse(required(input[0]).text).history).toEqual(f.state.history.flat());
});

test("the first message is classified before Codex materializes the rollout", async () => {
  const f = await fixture();
  f.state.legacy = true;
  f.state.fresh = true;
  f.state.output = '{"task":"question","fast":false}';
  expect(await f.route("Explain closures")).toEqual({
    effort: "medium",
    serviceTierForTurn: "default",
  });
  const input = required(f.calls.find((call) => call.method === "turn/start")).params.input as {
    text: string;
  }[];
  expect(JSON.parse(required(input[0]).text).history).toEqual([]);
});

test("invalid classifier output and API-key accounts fall back without API billing", async () => {
  const f = await fixture();
  f.state.output = '{"task":"simple","fast":true,"execute":"rm -rf"}';
  expect(await f.route("Deep research on this topic")).toEqual({
    effort: "ultra",
    serviceTierForTurn: "default",
  });
  f.calls.length = 0;
  f.state.account = "apiKey";
  expect(await f.route("Please answer quickly: hello")).toEqual({
    effort: "low",
    serviceTierForTurn: "ultrafast",
  });
  expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
  f.state.enabled = false;
  f.calls.length = 0;
  expect(await f.route("Debug this")).toEqual({});
  expect(f.calls).toHaveLength(0);
});

test("unsupported classifier capabilities use local routing without reading history", async () => {
  const f = await fixture();
  f.state.models = [
    {
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.filter(
        (option) => option.reasoningEffort !== "low",
      ),
    },
  ];
  expect(await f.route("Debug this")).toEqual({ effort: "ultra", serviceTierForTurn: "default" });
  expect(f.calls).toHaveLength(0);
});

test("classifier timeout interrupts and unloads its ephemeral thread", async () => {
  const f = await fixture(10);
  f.state.wait = true;
  expect(await f.route("Debug this")).toEqual({ effort: "ultra", serviceTierForTurn: "default" });
  expect(f.calls.slice(-2).map((call) => call.method)).toEqual([
    "turn/interrupt",
    "thread/unsubscribe",
  ]);
  expect(f.listeners.size).toBe(0);
});

test("stop cancels classification without saving a route", async () => {
  const f = await fixture(5_000);
  f.state.wait = true;
  const controller = new AbortController();
  const result = f.route("Debug this", controller.signal);
  while (!f.calls.some((call) => call.method === "turn/start")) await Bun.sleep(1);
  controller.abort();
  expect(await result).toEqual({});
  expect(f.store.routing("chat", "main")).toBeUndefined();
  expect(f.calls.some((call) => call.method === "turn/interrupt")).toBe(true);
});

test("new resets routing and history scope, and saved decisions are only an outage fallback", async () => {
  const f = await fixture();
  f.state.output = '{"task":"research","fast":false}';
  await f.route("Investigate this");
  const reloaded = new ConversationStore(join(f.directory, "conversations.json"), logger);
  await reloaded.load();
  expect(reloaded.routing("chat", "main")?.task).toBe("research");
  await f.store.delete("chat");
  await f.store.set("chat", "new-thread");
  f.state.history = [];
  f.state.output = '{"task":"simple","fast":false}';
  expect(await f.route("Hello", undefined, "new-thread")).toEqual({
    effort: "low",
    serviceTierForTurn: "default",
  });
  expect(f.store.routing("chat", "main")).toBeUndefined();
  expect(
    f.calls.filter((call) => call.method === "thread/items/list").at(-1)?.params.threadId,
  ).toBe("new-thread");
  const input = required(f.calls.filter((call) => call.method === "turn/start").at(-1)).params
    .input as {
    text: string;
  }[];
  expect(JSON.parse(required(input[0]).text).history).toEqual([]);
});

test("settings migrate old files and independent toggles preserve each other", async () => {
  const f = await fixture();
  const path = join(f.directory, "settings.json");
  await Bun.write(path, JSON.stringify({ version: 1, remoteClientContext: false }));
  const settings = new WirebotSettingsStore(path, logger);
  await settings.load();
  expect(settings.read()).toEqual({ remoteClientContext: false, autoMode: true });
  await settings.update({ autoMode: false });
  await settings.update({ remoteClientContext: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    version: 1,
    remoteClientContext: true,
    autoMode: false,
  });
});
