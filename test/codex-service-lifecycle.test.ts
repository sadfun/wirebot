import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodexAppServer,
  CodexAppServerExit,
  ExitListener,
  NotificationListener,
} from "../src/codex/rpc.js";
import { CodexService, type EffectiveCodexSettings } from "../src/codex/service.js";
import type { MessageResponder, OutboundStream } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { type Deferred, deferred } from "../src/shared/async.js";
import { BridgeError } from "../src/shared/errors.js";
import { Logger } from "../src/shared/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("CodexService lifecycle", () => {
  it("allows active turns to run for hours", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, service } = await testService();
      const output = responder();
      const run = service.runTurn("telegram:long", "telegram", "work", output.responder, true);
      await rpc.waitForRequests("turn/start", 1);

      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);

      expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
      expect(output.streams[0]?.fail).not.toHaveBeenCalled();
      rpc.completeNextTurn();
      await run;
      expect(output.streams[0]?.complete).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a Codex-initiated successor turn as its own chat message", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn(
      "telegram:successor",
      "telegram",
      "delegate",
      output.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 1);

    rpc.completeNextTurn();
    await run;
    expect(output.streams[0]?.complete).toHaveBeenCalledWith("Done.", []);

    rpc.startSuccessor("thread-1", "mailbox-turn");
    rpc.completeTurn("thread-1", "mailbox-turn", "completed", [agentMessage("Successor result")]);

    await vi.waitFor(() => {
      expect(output.streams[1]?.complete).toHaveBeenCalledWith("Successor result", []);
    });
    expect(output.streams[1]?.start).toHaveBeenCalled();
    expect(output.streams[0]?.fail).not.toHaveBeenCalled();
    expect(output.streams[1]?.fail).not.toHaveBeenCalled();
  });

  it("renders a successor announced before the original terminal notification", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn(
      "telegram:reordered-successor",
      "telegram",
      "delegate",
      output.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 1);

    rpc.startSuccessor("thread-1", "mailbox-turn");
    rpc.completeTurn("thread-1", "mailbox-turn", "completed", [agentMessage("Reordered result")]);
    rpc.completeNextTurn();
    await run;

    await vi.waitFor(() => {
      expect(output.streams[1]?.complete).toHaveBeenCalledWith("Reordered result", []);
    });
    expect(output.streams[0]?.complete).toHaveBeenCalledWith("Done.", []);
    expect(output.streams[0]?.fail).not.toHaveBeenCalled();
  });

  it("keeps the stop intent armed when Codex reports a different active turn", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn(
      "telegram:interrupt-mismatch",
      "telegram",
      "delegate",
      output.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 1);
    rpc.interruptActiveTurnId = "80432e00-b82b-4cbd-9de3-f4d846ace12c";

    // The interrupt for turn-1 is rejected because Codex already swapped in a
    // successor. Wirebot does not parse the error; the authoritative turn will
    // announce itself and the standing stop intent interrupts it then.
    await expect(service.interrupt("telegram:interrupt-mismatch")).resolves.toBe(true);
    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);

    rpc.startSuccessor("thread-1", "80432e00-b82b-4cbd-9de3-f4d846ace12c");
    await rpc.waitForRequests("turn/interrupt", 2);
    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")[1]).toEqual({
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "80432e00-b82b-4cbd-9de3-f4d846ace12c",
      },
    });

    rpc.completeNextTurn("interrupted");
    rpc.completeTurn("thread-1", "80432e00-b82b-4cbd-9de3-f4d846ace12c", "interrupted");
    await run;
    expect(output.streams[0]?.complete).toHaveBeenCalledWith("Stopped.", []);
  });

  it("interrupts the automatic successor instead of the stale original turn", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn(
      "telegram:successor-stop",
      "telegram",
      "delegate",
      output.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 1);

    rpc.completeNextTurn();
    await run;
    rpc.startSuccessor("thread-1", "mailbox-turn");

    await expect(service.interrupt("telegram:successor-stop")).resolves.toBe(true);
    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "mailbox-turn" },
      },
    ]);

    rpc.completeTurn("thread-1", "mailbox-turn", "interrupted");
  });

  it("propagates an earlier stop request to a successor turn", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn(
      "telegram:stop-chain",
      "telegram",
      "delegate",
      output.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 1);

    await expect(service.interrupt("telegram:stop-chain")).resolves.toBe(true);
    rpc.completeNextTurn("interrupted");
    rpc.startSuccessor("thread-1", "mailbox-turn");
    await rpc.waitForRequests("turn/interrupt", 2);

    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "mailbox-turn" },
      },
    ]);

    rpc.completeTurn("thread-1", "mailbox-turn", "interrupted");
    await run;
    expect(output.streams[0]?.complete).toHaveBeenCalledWith("Stopped.", []);
  });

  it("clears the stop intent when new work starts on the thread", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn("telegram:restart", "telegram", "work", output.responder, true);
    await rpc.waitForRequests("turn/start", 1);
    await expect(service.interrupt("telegram:restart")).resolves.toBe(true);
    rpc.completeNextTurn("interrupted");
    await run;

    const second = responder();
    const secondRun = service.runTurn(
      "telegram:restart",
      "telegram",
      "again",
      second.responder,
      true,
    );
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await secondRun;

    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
    expect(second.streams[0]?.complete).toHaveBeenCalledWith("Done.", []);
  });

  it("gates queued jobs while paused and drains only jobs that passed the gate", async () => {
    const { rpc, service } = await testService();
    const first = responder();
    const second = responder();
    const firstRun = service.runTurn("telegram:1", "telegram", "first", first.responder, true);
    await rpc.waitForRequests("turn/start", 1);

    const secondRun = service.runTurn("telegram:1", "telegram", "second", second.responder, true);
    service.pause();
    rpc.completeNextTurn();
    await service.waitForIdle();

    expect(rpc.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(second.streams[0]?.start).toHaveBeenCalledWith({
      summary: "Queued behind earlier work…",
      actions: [],
      plan: [],
    });

    service.resume();
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await Promise.all([firstRun, secondRun]);
    expect(second.streams[0]?.complete).toHaveBeenCalled();
  });

  it("counts work waiting for thread creation as non-idle", async () => {
    const { rpc, service } = await testService();
    const held = deferred<void>();
    rpc.threadStartGate = held;
    const run = service.runTurn("telegram:held", "telegram", "held", responder().responder, true);
    await rpc.waitForRequests("thread/start", 1);

    let idle = false;
    const waiting = service.waitForIdle().then(() => {
      idle = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(idle).toBe(false);

    held.resolve();
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await Promise.all([run, waiting]);
    expect(idle).toBe(true);
  });

  it("rejects an active completion and becomes idle when the transport exits", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn("telegram:exit", "telegram", "work", output.responder, true);
    await rpc.waitForRequests("turn/start", 1);

    rpc.emitExit();
    await Promise.all([run, service.waitForIdle()]);

    expect(output.streams[0]?.fail).toHaveBeenCalledWith("transport exited");
    expect(output.streams[0]?.fail).toHaveBeenCalledTimes(1);
  });

  it("reads live settings and skills per turn and resumes stored threads after an exit", async () => {
    let settings: EffectiveCodexSettings = {
      thread: { model: "thread-model-1", modelProvider: "provider-1", sandbox: "read-only" },
      turn: {
        model: "turn-model-1",
        effort: "medium",
        summary: "concise",
        personality: "friendly",
      },
    };
    const skillTexts: string[] = [];
    const { rpc, service } = await testService({
      effectiveSettings: () => settings,
      explicitSkillInputs: (text) => {
        skillTexts.push(text);
        return [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }];
      },
    });

    const firstRun = service.runTurn(
      "telegram:persistent",
      "telegram",
      "$review first",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await firstRun;

    const start = rpc.requests.find((request) => request.method === "thread/start");
    expect(start?.params).toMatchObject({
      model: "thread-model-1",
      modelProvider: "provider-1",
      sandbox: "read-only",
    });
    expect(rpc.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      model: "turn-model-1",
      effort: "medium",
      summary: "concise",
      personality: "friendly",
      input: [
        { type: "text", text: "$review first" },
        { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      ],
    });

    settings = {
      thread: { model: "thread-model-2", modelProvider: "provider-2" },
      turn: { model: "turn-model-2", effort: "high", personality: "pragmatic" },
    };
    rpc.emitExit();
    const secondRun = service.runTurn(
      "telegram:persistent",
      "telegram",
      "$review second",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await secondRun;

    const resume = rpc.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      threadId: "thread-1",
      model: "thread-model-2",
      modelProvider: "provider-2",
    });
    const turns = rpc.requests.filter((request) => request.method === "turn/start");
    expect(turns[1]?.params).toMatchObject({
      model: "turn-model-2",
      effort: "high",
      personality: "pragmatic",
    });
    expect(skillTexts).toEqual(["$review first", "$review second"]);
  });

  it("keeps a stored thread when resume fails because the transport is unavailable", async () => {
    const { rpc, service } = await testService();
    const firstRun = service.runTurn("telegram:stored", "telegram", "first", responder().responder);
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await firstRun;

    rpc.emitExit();
    rpc.resumeError = new BridgeError("not running", "CODEX_NOT_RUNNING");
    const failed = responder();
    await service.runTurn("telegram:stored", "telegram", "while down", failed.responder);
    expect(failed.streams[0]?.fail).toHaveBeenCalledWith("not running");

    rpc.resumeError = undefined;
    const resumed = service.runTurn(
      "telegram:stored",
      "telegram",
      "after restart",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await resumed;
    const resumeRequests = rpc.requests.filter((request) => request.method === "thread/resume");
    expect(resumeRequests).toHaveLength(2);
    expect(resumeRequests[1]?.params).toMatchObject({ threadId: "thread-1" });
  });
});

interface RpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingTurn {
  readonly threadId: string;
  readonly turnId: string;
}

class ControlledRpc {
  readonly requests: RpcRequest[] = [];
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #exitListeners = new Set<ExitListener>();
  readonly #pendingTurns: PendingTurn[] = [];
  #nextTurn = 1;
  public threadStartGate: Deferred<void> | undefined;
  public resumeError: BridgeError | undefined;
  public interruptActiveTurnId: string | undefined;

  public onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onExit(listener: ExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  public setServerRequestHandler(): void {}

  public async request<Result>(request: RpcRequest): Promise<Result> {
    this.requests.push(request);
    if (request.method === "thread/start") {
      await this.threadStartGate?.promise;
      return { thread: { id: "thread-1" } } as Result;
    }
    if (request.method === "thread/resume") {
      if (this.resumeError !== undefined) throw this.resumeError;
      const { threadId } = request.params as { readonly threadId: string };
      return { thread: { id: threadId } } as Result;
    }
    if (request.method === "turn/start") {
      const { threadId } = request.params as { readonly threadId: string };
      const turnId = `turn-${this.#nextTurn}`;
      this.#nextTurn += 1;
      this.#pendingTurns.push({ threadId, turnId });
      return { turn: { id: turnId } } as Result;
    }
    if (request.method === "turn/interrupt") {
      const { turnId } = request.params as { readonly turnId: string };
      if (this.interruptActiveTurnId !== undefined && turnId !== this.interruptActiveTurnId) {
        throw new BridgeError(
          `expected active turn id ${turnId} but found ${this.interruptActiveTurnId}`,
          "CODEX_RPC_ERROR",
        );
      }
      return {} as Result;
    }
    throw new Error(`Unexpected request ${request.method}`);
  }

  public async waitForRequests(method: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.requests.filter((request) => request.method === method)).toHaveLength(count);
    });
  }

  public completeNextTurn(status: Turn["status"] = "completed"): void {
    const pending = this.#pendingTurns.shift();
    if (pending === undefined) throw new Error("No pending turn");
    this.completeTurn(pending.threadId, pending.turnId, status);
  }

  public startSuccessor(threadId: string, turnId: string): void {
    this.notify({
      method: "turn/started",
      params: {
        threadId,
        turn: completedTurn(turnId, [], "inProgress"),
      },
    } as ServerNotification);
  }

  public completeTurn(
    threadId: string,
    turnId: string,
    status: Turn["status"],
    items: readonly ThreadItem[] = [],
  ): void {
    this.notify({
      method: "turn/completed",
      params: { threadId, turn: completedTurn(turnId, items, status) },
    } as ServerNotification);
  }

  public emitExit(): void {
    const error = new BridgeError("transport exited", "CODEX_EXITED");
    const exit = {
      error,
      expected: false,
      code: 1,
      signal: null,
    } satisfies CodexAppServerExit;
    for (const listener of this.#exitListeners) listener(exit);
  }

  private notify(notification: ServerNotification): void {
    for (const listener of this.#notificationListeners) listener(notification);
  }
}

function responder(): Readonly<{
  responder: MessageResponder;
  streams: readonly OutboundStream[];
}> {
  const streams: OutboundStream[] = [];
  return {
    streams,
    responder: {
      createStream: () => {
        const stream: OutboundStream = {
          start: vi.fn(async () => undefined),
          setProgress: vi.fn(),
          appendFinal: vi.fn(),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
        };
        streams.push(stream);
        return stream;
      },
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

function completedTurn(
  id: string,
  items: readonly ThreadItem[] = [],
  status: Turn["status"] = "completed",
): Turn {
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

async function testService(
  providers: ConstructorParameters<typeof CodexService>[8] = {},
): Promise<Readonly<{ rpc: ControlledRpc; service: CodexService }>> {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-codex-lifecycle-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  const generatedImages = join(directory, "generated-images");
  const outbound = join(directory, "outbound");
  await Promise.all([mkdir(workspace), mkdir(generatedImages), mkdir(outbound)]);
  const conversations = new ConversationStore(
    join(directory, "conversations.json"),
    new Logger("error"),
  );
  await conversations.load();
  const rpc = new ControlledRpc();
  const service = new CodexService(
    rpc as unknown as CodexAppServer,
    conversations,
    workspace,
    generatedImages,
    outbound,
    new Logger("error"),
    undefined,
    () => false,
    providers,
  );
  return { rpc, service };
}
