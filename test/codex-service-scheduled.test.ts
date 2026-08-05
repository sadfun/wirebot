import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodexAppServer,
  ExitListener,
  NotificationListener,
  ServerRequestHandler,
} from "../src/codex/rpc.js";
import { CodexService } from "../src/codex/service.js";
import type { MessageResponder, OutboundStream } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ServerRequest } from "../src/generated/codex/ServerRequest.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { type Deferred, deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("CodexService scheduled execution", () => {
  it("registers the automation tool and handles calls with server-derived context", async () => {
    const { service, rpc } = await fixture();
    const execute = vi.fn(async () => ({ created: true, id: "automation-1" }));
    service.registerDynamicTool({
      spec: {
        type: "function",
        name: "automation_update",
        description: "Manage schedules",
        inputSchema: { type: "object" },
      },
      execute,
    });
    rpc.callDynamicTool = true;
    const output = responder();

    await service.runTurn(
      "telegram:42:0",
      "telegram",
      "schedule this",
      output.responder,
      false,
      [],
      {
        owner: { provider: "telegram", resource: "user", id: "7" },
        deliveryTarget: { provider: "telegram", resource: "destination", id: "opaque" },
      },
    );

    expect(rpc.requests.find((request) => request.method === "thread/start")?.params).toMatchObject(
      {
        dynamicTools: [{ type: "function", name: "automation_update" }],
      },
    );
    expect(execute).toHaveBeenCalledWith(
      { mode: "view" },
      expect.objectContaining({
        conversationKey: "telegram:42:0",
        connector: "telegram",
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        owner: { provider: "telegram", resource: "user", id: "7" },
      }),
    );
    expect(rpc.replies[0]).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining("automation-1") }],
    });
  });

  it("keeps detached scheduled threads out of the active conversation mapping", async () => {
    const { service, rpc, conversations } = await fixture();
    await conversations.set("telegram:42:0", "thread-current");
    rpc.finalText = JSON.stringify({ notify: true, title: "Result", message: "Done" });

    const result = await service.runScheduledTurn({
      conversationKey: "telegram:42:0",
      connector: "telegram",
      prompt: "Run unattended",
      thread: { mode: "new", developerInstructions: "Scheduled instructions" },
      invocation: {
        owner: { provider: "telegram", resource: "user", id: "7" },
        automationId: "automation-1",
      },
      model: "gpt-test",
      reasoningEffort: "high",
      outputSchema: { type: "object" },
    });

    expect(conversations.get("telegram:42:0")).toBe("thread-current");
    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      rawText: rpc.finalText,
    });
    expect(rpc.requests.find((request) => request.method === "thread/start")?.params).toMatchObject(
      {
        ephemeral: false,
        threadSource: "automation",
        developerInstructions: "Scheduled instructions",
      },
    );
    expect(rpc.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      model: "gpt-test",
      effort: "high",
      outputSchema: { type: "object" },
    });
    await result.dispose();
  });

  it("abandons a pending approval when Codex resolves the server request", async () => {
    const { service, rpc } = await fixture();
    rpc.approvalRequest = true;
    let observedSignal: AbortSignal | undefined;
    const output = responder();
    const withApproval: MessageResponder = {
      ...output.responder,
      askChoice: vi.fn(
        async (_prompt: string, _options, signal?: AbortSignal) =>
          await new Promise<string>((resolve) => {
            observedSignal = signal;
            signal?.addEventListener("abort", () => resolve("abandoned"), { once: true });
          }),
      ),
    };

    await service.runTurn("telegram:42:0", "telegram", "work", withApproval, true);

    expect(observedSignal?.aborted).toBe(true);
    expect(rpc.replies[0]).toMatchObject({ decision: "decline" });
  });

  it("ignores late deltas from another turn on the same thread", async () => {
    const { service, rpc } = await fixture();
    rpc.emitWrongTurnDelta = true;
    const output = responder();

    await service.runTurn("telegram:42:0", "telegram", "work", output.responder, true);

    expect(output.stream.appendFinal).not.toHaveBeenCalledWith("stale output");
    expect(output.stream.complete).toHaveBeenCalledWith("Finished.", []);
  });

  it("holds the conversation lane atomically while switching tasks", async () => {
    const { service, rpc, conversations } = await fixture();
    await conversations.set("telegram:42:0", "thread-current");
    const resumeGate = deferred<void>();
    rpc.resumeGate = resumeGate;

    const activating = service.activateConversationThread(
      "telegram:42:0",
      "telegram",
      "thread-scheduled",
    );
    await vi.waitFor(() => {
      expect(rpc.requests.some((request) => request.method === "thread/resume")).toBe(true);
    });

    const output = responder();
    const userTurn = service.runTurn(
      "telegram:42:0",
      "telegram",
      "continue here",
      output.responder,
    );
    await vi.waitFor(() => {
      expect(output.stream.start).toHaveBeenCalledWith({
        summary: "Queued behind earlier work…",
        actions: [],
        plan: [],
      });
    });
    await expect(
      service.activateConversationThread("telegram:42:0", "telegram", "thread-other"),
    ).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });

    resumeGate.resolve();
    await expect(activating).resolves.toBe(true);
    await userTurn;

    expect(conversations.get("telegram:42:0")).toBe("thread-scheduled");
    expect(
      rpc.requests.find(
        (request) =>
          request.method === "turn/start" &&
          (request.params as { threadId?: string }).threadId === "thread-scheduled",
      ),
    ).toBeDefined();
  });
});

interface RpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

class FakeRpc {
  public readonly requests: RpcRequest[] = [];
  public readonly replies: unknown[] = [];
  public finalText = "Finished.";
  public callDynamicTool = false;
  public approvalRequest = false;
  public emitWrongTurnDelta = false;
  public resumeGate: Deferred<void> | undefined;
  readonly #listeners = new Set<NotificationListener>();
  #handler: ServerRequestHandler | undefined;
  #nextThread = 1;
  #nextTurn = 1;

  public onNotification(listener: NotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onExit(_listener: ExitListener): () => void {
    return () => undefined;
  }

  public setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#handler = handler;
  }

  public async reply(_id: unknown, result: unknown): Promise<void> {
    this.replies.push(result);
  }

  public async replyError(): Promise<void> {}

  public async request<Result>(request: RpcRequest): Promise<Result> {
    this.requests.push(request);
    if (request.method === "thread/start") {
      const threadId = `thread-${this.#nextThread++}`;
      return { thread: { id: threadId } } as Result;
    }
    if (request.method === "thread/resume") {
      const threadId = (request.params as { threadId: string }).threadId;
      await this.resumeGate?.promise;
      return { thread: { id: threadId } } as Result;
    }
    if (request.method === "turn/start") {
      const threadId = (request.params as { threadId: string }).threadId;
      const turnId = `turn-${this.#nextTurn++}`;
      queueMicrotask(() => void this.finishTurn(threadId, turnId));
      return { turn: { id: turnId } } as Result;
    }
    throw new Error(`Unexpected request ${request.method}`);
  }

  private async finishTurn(threadId: string, turnId: string): Promise<void> {
    this.notify({
      method: "turn/started",
      params: { threadId, turn: completedTurn(turnId, [], "inProgress") },
    } as ServerNotification);
    if (this.callDynamicTool) {
      await this.#handler?.({
        method: "item/tool/call",
        id: 99,
        params: {
          threadId,
          turnId,
          callId: "call-1",
          namespace: null,
          tool: "automation_update",
          arguments: { mode: "view" },
        },
      } as ServerRequest);
    }
    if (this.approvalRequest) {
      const handled = this.#handler?.({
        method: "item/commandExecution/requestApproval",
        id: 7,
        params: { threadId, turnId, itemId: "call-1", command: "rm -rf ./scratch", reason: null },
      } as unknown as ServerRequest);
      // Give the bridge time to surface the prompt, then resolve it server-side.
      await new Promise((resolve) => setImmediate(resolve));
      this.notify({
        method: "serverRequest/resolved",
        params: { threadId, requestId: 7 },
      } as ServerNotification);
      await handled;
    }
    if (this.emitWrongTurnDelta) {
      this.notify({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: "turn-stale", itemId: "message-stale", delta: "stale output" },
      } as ServerNotification);
    }
    const item = agentMessage(this.finalText);
    this.notify({
      method: "item/completed",
      params: { threadId, turnId, item, completedAtMs: Date.now() },
    } as ServerNotification);
    this.notify({
      method: "turn/completed",
      params: { threadId, turn: completedTurn(turnId, [item], "completed") },
    } as ServerNotification);
  }

  private notify(notification: ServerNotification): void {
    for (const listener of this.#listeners) listener(notification);
  }
}

function responder(): Readonly<{ responder: MessageResponder; stream: OutboundStream }> {
  const stream: OutboundStream = {
    start: vi.fn(async () => undefined),
    setProgress: vi.fn(),
    appendFinal: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  return {
    stream,
    responder: {
      createStream: () => stream,
      sendText: vi.fn(async () => undefined),
      askChoice: vi.fn(async () => "decline"),
    },
  };
}

function agentMessage(text: string): ThreadItem {
  return {
    type: "agentMessage",
    id: "message-1",
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function completedTurn(id: string, items: readonly ThreadItem[], status: Turn["status"]): Turn {
  return {
    id,
    items: [...items],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-codex-scheduled-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const generated = join(directory, "generated");
  const outbound = join(directory, "outbound");
  await Promise.all([mkdir(workspace), mkdir(generated), mkdir(outbound)]);
  const conversations = new ConversationStore(
    join(directory, "conversations.json"),
    new Logger("error"),
  );
  await conversations.load();
  const rpc = new FakeRpc();
  const service = new CodexService(
    rpc as unknown as CodexAppServer,
    conversations,
    workspace,
    generated,
    outbound,
    new Logger("error"),
    undefined,
    () => false,
  );
  return { service, rpc, conversations };
}
