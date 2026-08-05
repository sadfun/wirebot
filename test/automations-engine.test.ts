import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledRunsEngine } from "../src/automations/engine.js";
import { AutomationStore } from "../src/automations/store.js";
import type { AutomationDefinition, AutomationRun } from "../src/automations/types.js";
import type {
  CodexDynamicTool,
  CodexDynamicToolContext,
  CodexService,
  ScheduledTurnRequest,
} from "../src/codex/service.js";
import type {
  DeliveryReceipt,
  MessageHandler,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../src/core/channel.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("ScheduledRunsEngine", () => {
  it("binds model-created schedules to server-derived provider context", async () => {
    const fixture = await createFixture();
    const context = toolContext();
    const operation = {
      mode: "create",
      kind: "heartbeat",
      name: "Build monitor",
      prompt: "Check whether the build is healthy.",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      time_zone: "UTC",
    } as const;

    const first = await fixture.codex.tool?.execute(operation, context);
    const second = await fixture.codex.tool?.execute(operation, context);
    const automations = fixture.store.listAutomations();

    expect(first).toMatchObject({ created: true, automation: { kind: "heartbeat" } });
    expect(second).toMatchObject({ created: false });
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({
      owner: context.owner,
      conversation: { provider: "telegram", resource: "conversation", id: "telegram:42:0" },
      deliveryTarget: context.deliveryTarget,
      threadId: "thread-current",
      nextRunAt: "2026-07-21T09:00:00.000Z",
    });

    const automationId = automations[0]?.id;
    if (automationId === undefined) throw new Error("Expected an automation");
    await expect(
      readFile(
        join(fixture.workspace, ".wirebot", "automations", automationId, "memory.md"),
        "utf8",
      ),
    ).resolves.toContain("# Automation memory");
    const otherConversation = { ...context, conversationKey: "telegram:99:0" };
    await expect(
      fixture.codex.tool?.execute({ mode: "view", id: automationId }, otherConversation),
    ).rejects.toThrow("Automation not found");
    await expect(
      fixture.codex.tool?.execute({ mode: "delete", id: automationId }, otherConversation),
    ).rejects.toThrow("Automation not found");
    const { deliveryTarget: _deliveryTarget, ...withoutDelivery } = context;
    await expect(fixture.codex.tool?.execute(operation, withoutDelivery)).rejects.toThrow(
      "cannot receive scheduled results",
    );

    await fixture.codex.tool?.execute({ mode: "delete", id: automationId }, context);
    expect(fixture.store.getAutomation(automationId)).toBeUndefined();
    expect(fixture.store.listAutomations()).toHaveLength(0);
  });

  it("runs a due cron in a detached thread and records every provider message", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    fixture.codex.backgroundResult = JSON.stringify({
      notify: true,
      title: "Build failed",
      message: "The migration step failed.",
    });
    fixture.codex.unavailableAttachments = ["migration.log"];

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.listRuns()[0]?.status).toBe("succeeded");
    });
    await fixture.engine.stop();

    expect(fixture.codex.scheduledRequests).toHaveLength(1);
    expect(fixture.codex.scheduledRequests[0]).toMatchObject({
      conversationKey: "telegram:42:0",
      thread: { mode: "new" },
      invocation: {
        owner: ownerReference,
        deliveryTarget,
        automationId: "automation-1",
      },
    });
    expect(fixture.channel.publish).toHaveBeenCalledOnce();
    const outbound = fixture.channel.publish.mock.calls[0]?.[1];
    expect(outbound?.text).toContain("Build failed");
    expect(outbound?.text).toContain("Could not attach migration.log.");
    expect(outbound?.text).not.toContain('"notify":true');
    expect(outbound?.actions?.[0]?.command).toEqual({
      name: "continue",
      args: expect.any(String),
    });
    const notification = fixture.store.listNotifications()[0];
    expect(notification).toMatchObject({
      status: "delivered",
      sourceThreadId: "thread-scheduled",
      publishedMessages: [messageReference("101"), messageReference("102")],
    });

    const context = await fixture.engine.contextForReply(
      messageReference("102"),
      ownerReference,
      conversationReference,
    );
    expect(context?.["wirebot.scheduled-result"]?.value).toContain("The migration step failed.");
    const runId = fixture.store.listRuns()[0]?.id;
    expect(runId).toBeDefined();
    const continued = await fixture.engine.continueRun(
      ownerReference,
      conversationReference,
      runId as string,
    );
    expect(continued).toEqual({ automationName: "Build monitor", changed: true });
    expect(fixture.codex.activateConversationThread).toHaveBeenCalledWith(
      "telegram:42:0",
      "telegram",
      "thread-scheduled",
    );
  });

  it("suppresses an uneventful heartbeat without publishing it", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation({
      ...dueAutomation(),
      id: "heartbeat-1",
      threadId: "thread-current",
      notificationPolicy: "on-result",
    });
    fixture.codex.backgroundResult = JSON.stringify({
      notify: false,
      title: "No change",
      message: "Everything is still healthy.",
    });

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.listRuns()[0]?.status).toBe("succeeded");
    });
    await fixture.engine.stop();

    expect(fixture.channel.publish).not.toHaveBeenCalled();
    expect(fixture.store.listNotifications()[0]?.status).toBe("suppressed");
  });

  it("can continue from a persisted notification before run finalization", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    await fixture.store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T08:00:00.000Z",
      nextRunAt: "2026-07-21T09:00:00.000Z",
      run: runningRun("run-pending", "2026-07-21T08:00:00.000Z"),
    });
    await fixture.store.putNotification({
      id: "notification-pending",
      automationId: "automation-1",
      runId: "run-pending",
      publishedMessages: [],
      sourceThreadId: "thread-persisted-before-delivery",
      status: "delivered",
      title: "Build monitor",
      body: "A result",
      error: null,
      createdAt: "2026-07-21T08:31:00.000Z",
      updatedAt: "2026-07-21T08:31:00.000Z",
    });

    await expect(
      fixture.engine.continueRun(ownerReference, conversationReference, "run-pending"),
    ).resolves.toEqual({ automationName: "Build monitor", changed: true });
    expect(fixture.codex.activateConversationThread).toHaveBeenCalledWith(
      "telegram:42:0",
      "telegram",
      "thread-persisted-before-delivery",
    );
  });

  it("pauses persisted schedules whose provider owner is no longer authorized", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    fixture.channel.authorized = false;

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.getAutomation("automation-1")).toMatchObject({
        status: "paused",
        nextRunAt: null,
        deferralReason: "The messaging provider no longer authorizes this schedule's owner.",
      });
    });
    await fixture.engine.stop();

    expect(fixture.codex.scheduledRequests).toHaveLength(0);
    expect(fixture.channel.publish).not.toHaveBeenCalled();
  });

  it("coalesces missed occurrences and respects maximum concurrency", async () => {
    let id = 0;
    const fixture = await createFixture({
      now: () => new Date("2026-07-21T10:00:00Z"),
      maxConcurrency: 2,
      createId: () => {
        id += 1;
        return `run-${id}`;
      },
    });
    await Promise.all([
      fixture.store.putAutomation(hourlyAutomation("automation-1", "2026-07-21T07:00:00Z")),
      fixture.store.putAutomation(hourlyAutomation("automation-2", "2026-07-21T08:00:00Z")),
      fixture.store.putAutomation(hourlyAutomation("automation-3", "2026-07-21T09:00:00Z")),
    ]);
    const completions = [deferred<void>(), deferred<void>(), deferred<void>()];
    fixture.codex.backgroundResult = suppressedResult;
    fixture.codex.onScheduledTurn = async (_request, index) => {
      await completions[index]?.promise;
    };

    await fixture.engine.tick();
    await vi.waitFor(() => {
      expect(fixture.codex.scheduledRequests).toHaveLength(2);
    });

    expect(fixture.engine.activeCount).toBe(2);
    expect(fixture.store.listRuns()).toHaveLength(2);
    expect(fixture.store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00.000Z");
    expect(fixture.store.getAutomation("automation-2")?.nextRunAt).toBe("2026-07-21T11:00:00.000Z");
    expect(fixture.store.getAutomation("automation-3")?.nextRunAt).toBe("2026-07-21T09:00:00Z");

    completions[0]?.resolve();
    completions[1]?.resolve();
    await fixture.engine.waitForIdle();
    await fixture.engine.tick();
    await vi.waitFor(() => {
      expect(fixture.codex.scheduledRequests).toHaveLength(3);
    });
    completions[2]?.resolve();
    await fixture.engine.stop();
  });

  it("defers without claiming when the foreground conversation is busy", async () => {
    const fixture = await createFixture({
      now: () => new Date("2026-07-21T10:00:00Z"),
      deferralMs: 45_000,
    });
    await fixture.store.putAutomation(hourlyAutomation("automation-1", "2026-07-21T10:00:00Z"));
    fixture.codex.backgroundDecision = { acquired: false, reason: "A user turn is active." };

    await fixture.engine.tick();

    expect(fixture.codex.scheduledRequests).toHaveLength(0);
    expect(fixture.store.listRuns()).toHaveLength(0);
    expect(fixture.store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: "2026-07-21T10:00:00Z",
      deferredUntil: "2026-07-21T10:00:45.000Z",
      deferralReason: "A user turn is active.",
    });
  });

  it("marks stale running records interrupted before scheduling resumes", async () => {
    const fixture = await createFixture({ now: () => new Date("2026-07-21T10:05:00Z") });
    await fixture.store.putAutomation(hourlyAutomation("automation-1", "2026-07-21T10:00:00Z"));
    await fixture.store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T10:00:00Z",
      nextRunAt: "2026-07-21T11:00:00Z",
      run: runningRun("old-run", "2026-07-21T10:00:00Z"),
    });

    await fixture.engine.start();
    await fixture.engine.stop();

    expect(fixture.store.getRun("old-run")).toMatchObject({
      status: "interrupted",
      finishedAt: "2026-07-21T10:05:00.000Z",
      error: "Wirebot restarted before the scheduled run completed.",
    });
    expect(fixture.codex.scheduledRequests).toHaveLength(0);
    expect(fixture.store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
  });

  it("records failures, delivers them, and releases the conversation lease", async () => {
    const fixture = await createFixture({
      now: () => new Date("2026-07-21T10:00:00Z"),
      createId: () => "failed-run",
    });
    await fixture.store.putAutomation(hourlyAutomation("automation-1", "2026-07-21T10:00:00Z"));
    fixture.codex.onScheduledTurn = () => {
      throw new Error("Codex stopped");
    };

    await fixture.engine.tick();
    await fixture.engine.waitForIdle();

    expect(fixture.store.getRun("failed-run")).toMatchObject({
      status: "failed",
      error: "Codex stopped",
    });
    expect(fixture.codex.release).toHaveBeenCalledOnce();
    expect(fixture.channel.publish.mock.calls[0]?.[1]?.text).toContain(
      "Scheduled run failed: Codex stopped",
    );
    expect(fixture.store.listNotifications()[0]).toMatchObject({
      status: "delivered",
      sourceThreadId: null,
    });
  });

  it("marks an in-flight run interrupted during shutdown", async () => {
    const fixture = await createFixture({
      now: () => new Date("2026-07-21T10:00:00Z"),
      createId: () => "interrupted-run",
    });
    await fixture.store.putAutomation(hourlyAutomation("automation-1", "2026-07-21T10:00:00Z"));
    const completion = deferred<void>();
    fixture.codex.onScheduledTurn = async () => {
      await completion.promise;
    };

    await fixture.engine.tick();
    // The rejection may only fire once the run awaits the fake turn.
    await vi.waitFor(() => {
      expect(fixture.codex.scheduledRequests).toHaveLength(1);
    });
    const stopping = fixture.engine.stop();
    completion.reject(new Error("Codex turn was interrupted"));
    await stopping;

    expect(fixture.store.getRun("interrupted-run")).toMatchObject({
      status: "interrupted",
      error: "Wirebot stopped before the scheduled run completed.",
    });
    expect(fixture.channel.publish).not.toHaveBeenCalled();
  });
});

const suppressedResult = JSON.stringify({ notify: false, title: "", message: "No change." });

class FakeCodex {
  public tool: CodexDynamicTool | undefined;
  public backgroundResult = "";
  public readonly scheduledRequests: ScheduledTurnRequest[] = [];
  public readonly activateConversationThread = vi.fn(async () => true);
  public readonly interruptScheduledTurns = vi.fn(async () => undefined);
  public unavailableAttachments: readonly string[] = [];
  public readonly release = vi.fn();
  public backgroundDecision:
    | { acquired: true; release: () => void }
    | { acquired: false; reason: string; retryAt?: Date }
    | undefined;
  public onScheduledTurn:
    | ((request: ScheduledTurnRequest, index: number) => void | Promise<void>)
    | undefined;

  public registerDynamicTool(tool: CodexDynamicTool): void {
    this.tool = tool;
  }

  public tryAcquireBackground(): ReturnType<CodexService["tryAcquireBackground"]> {
    const decision = this.backgroundDecision ?? { acquired: true, release: this.release };
    return decision as ReturnType<CodexService["tryAcquireBackground"]>;
  }

  public async runScheduledTurn(request: ScheduledTurnRequest) {
    const index = this.scheduledRequests.length;
    this.scheduledRequests.push(request);
    await this.onScheduledTurn?.(request, index);
    return {
      threadId: "thread-scheduled",
      turnId: "turn-scheduled",
      rawText: this.backgroundResult,
      text:
        this.unavailableAttachments.length === 0
          ? this.backgroundResult
          : `Could not attach ${this.unavailableAttachments.join(", ")}.\n\n${this.backgroundResult}`,
      attachments: [],
      unavailableAttachments: this.unavailableAttachments,
      dispose: vi.fn(async () => undefined),
    };
  }
}

class FakeChannel implements MessagingChannel {
  public readonly name = "telegram";
  public readonly publish = vi.fn(
    async (_target: ProviderReference, _message: OutboundMessage): Promise<DeliveryReceipt> => ({
      publishedMessages: [messageReference("101"), messageReference("102")],
    }),
  );
  public authorized = true;

  public isAuthorized(_principal: ProviderReference): boolean {
    return this.authorized;
  }

  public async start(_handler: MessageHandler): Promise<void> {}
  public async stop(): Promise<void> {}
}

interface FixtureOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxConcurrency?: number;
  readonly deferralMs?: number;
}

async function createFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-automation-engine-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new AutomationStore(join(directory, "automations.json"), new Logger("error"));
  await store.load();
  const codex = new FakeCodex();
  const channel = new FakeChannel();
  const engine = new ScheduledRunsEngine({
    store,
    codex: codex as unknown as CodexService,
    channels: [channel],
    workspace,
    logger: new Logger("error"),
    now: options.now ?? (() => new Date("2026-07-21T08:30:00.000Z")),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.deferralMs === undefined ? {} : { deferralMs: options.deferralMs }),
  });
  return { store, codex, channel, engine, workspace };
}

const ownerReference: ProviderReference = {
  provider: "telegram",
  resource: "user",
  id: "7",
};

const deliveryTarget: ProviderReference = {
  provider: "telegram",
  resource: "destination",
  id: "opaque-target",
};

const conversationReference: ProviderReference = {
  provider: "telegram",
  resource: "conversation",
  id: "telegram:42:0",
};

function messageReference(id: string): ProviderReference {
  return { provider: "telegram", resource: "message", id };
}

function toolContext(): CodexDynamicToolContext {
  return {
    conversationKey: "telegram:42:0",
    connector: "telegram",
    threadId: "thread-current",
    turnId: "turn-current",
    callId: "call-create-1",
    owner: ownerReference,
    deliveryTarget,
  };
}

function dueAutomation(): AutomationDefinition {
  return {
    id: "automation-1",
    owner: ownerReference,
    conversation: conversationReference,
    deliveryTarget,
    name: "Build monitor",
    prompt: "Check the build.",
    status: "active",
    schedule: {
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      startAt: "2026-07-20T09:00:00.000Z",
      timeZone: "UTC",
    },
    threadId: null,
    notificationPolicy: "always",
    model: null,
    reasoningEffort: null,
    nextRunAt: "2026-07-21T08:00:00.000Z",
    lastRunAt: null,
    deferredUntil: null,
    deferralReason: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    revision: 0,
  };
}

function hourlyAutomation(id: string, nextRunAt: string): AutomationDefinition {
  return {
    ...dueAutomation(),
    id,
    name: id,
    schedule: { rrule: "FREQ=HOURLY", startAt: nextRunAt, timeZone: "UTC" },
    notificationPolicy: "on-result",
    nextRunAt,
    createdAt: nextRunAt,
    updatedAt: nextRunAt,
  };
}

function runningRun(id: string, scheduledFor: string): AutomationRun {
  return {
    id,
    automationId: "automation-1",
    scheduledFor,
    status: "running",
    startedAt: scheduledFor,
    finishedAt: null,
    threadId: null,
    error: null,
  };
}
