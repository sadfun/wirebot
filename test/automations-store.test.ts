import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../src/automations/store.js";
import type {
  AutomationDefinition,
  AutomationNotification,
  AutomationRun,
} from "../src/automations/types.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("AutomationStore", () => {
  it("atomically claims a due occurrence only once and persists the advanced schedule", async () => {
    const { path, store } = await createStore();
    await store.putAutomation(automation());
    const run = runningRun("run-1");

    const claims = await Promise.all([
      store.claimRun({
        automationId: "automation-1",
        expectedNextRunAt: "2026-07-21T10:00:00Z",
        nextRunAt: "2026-07-21T11:00:00Z",
        run,
      }),
      store.claimRun({
        automationId: "automation-1",
        expectedNextRunAt: "2026-07-21T10:00:00Z",
        nextRunAt: "2026-07-21T11:00:00Z",
        run: runningRun("run-2"),
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
    expect(store.listRuns()).toHaveLength(1);

    const reloaded = new AutomationStore(path, new Logger("error"));
    await reloaded.load();
    expect(reloaded.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("recovers interrupted runs without replaying their claimed occurrence", async () => {
    const { store } = await createStore();
    await store.putAutomation(automation());
    await store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T10:00:00Z",
      nextRunAt: "2026-07-21T11:00:00Z",
      run: runningRun("run-1"),
    });

    const recovered = await store.recoverInterruptedRuns("2026-07-21T10:05:00Z");

    expect(recovered).toHaveLength(1);
    expect(store.getRun("run-1")).toMatchObject({
      status: "interrupted",
      finishedAt: "2026-07-21T10:05:00Z",
    });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
  });

  it("deletes an automation together with its runs and notifications", async () => {
    const { store } = await createStore();
    await store.putAutomation(automation());
    await store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T10:00:00Z",
      nextRunAt: "2026-07-21T11:00:00Z",
      run: runningRun("run-1"),
    });
    await store.putNotification(notification("notification-1", "run-1", "message-1"));

    await expect(store.deleteAutomation("automation-1")).resolves.toBe(true);

    expect(store.getAutomation("automation-1")).toBeUndefined();
    expect(store.listRuns()).toHaveLength(0);
    expect(store.listNotifications()).toHaveLength(0);
    await expect(store.deleteAutomation("automation-1")).resolves.toBe(false);
  });

  it("resolves any provider-owned message fragment back to its notification", async () => {
    const { store } = await createStore();
    const stored: AutomationNotification = {
      ...notification("notification-1", "run-1", "room:42:message:7"),
      publishedMessages: [
        { provider: "example", resource: "message", id: "room:42:message:7" },
        { provider: "example", resource: "message", id: "room:42:message:8" },
      ],
      body: "A long provider-split result",
    };
    await store.putNotification(stored);

    expect(
      store.findNotificationByPublishedMessage({
        provider: "example",
        resource: "message",
        id: "room:42:message:8",
      }),
    ).toEqual(stored);
  });

  it("prevents one provider message from identifying two notifications", async () => {
    const { store } = await createStore();
    const first = notification("notification-1", "run-1", "room:42:message:7");
    await store.putNotification(first);

    await expect(
      store.putNotification({
        ...first,
        id: "notification-2",
        runId: "run-2",
        body: "Second",
      }),
    ).rejects.toThrow("already associated");
  });

  it("bounds retained run and notification history per automation", async () => {
    const { store } = await createStore();
    const isoAt = (minutes: number) => new Date(Date.UTC(2026, 6, 21, 10, minutes)).toISOString();
    await store.putAutomation(automation({ nextRunAt: isoAt(0) }));
    for (let index = 0; index < 105; index += 1) {
      const runId = `run-${String(index).padStart(3, "0")}`;
      await store.claimRun({
        automationId: "automation-1",
        expectedNextRunAt: isoAt(index),
        nextRunAt: isoAt(index + 1),
        run: {
          ...runningRun(runId),
          scheduledFor: isoAt(index),
          startedAt: isoAt(index),
        },
      });
      await store.completeRun(runId, { status: "succeeded", finishedAt: isoAt(index) });
      await store.putNotification({
        ...notification(
          `notification-${String(index).padStart(3, "0")}`,
          runId,
          `message-${index}`,
        ),
        createdAt: isoAt(index),
        updatedAt: isoAt(index),
      });
    }

    expect(store.listRuns("automation-1")).toHaveLength(100);
    expect(store.listNotifications()).toHaveLength(100);
    expect(store.getRun("run-000")).toBeUndefined();
    expect(
      store.findNotificationByPublishedMessage({
        provider: "example",
        resource: "message",
        id: "message-0",
      }),
    ).toBeUndefined();
    expect(store.getRun("run-104")).toBeDefined();
  });

  it("migrates the pre-0.0.27 persisted format", async () => {
    const { path } = await createStore();
    const legacyAutomation = (id: string, overrides: Record<string, unknown>) => ({
      ...automation({ id }),
      threadId: undefined,
      kind: "cron",
      execution: { mode: "new-thread", cwd: "/workspace" },
      ...overrides,
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        automations: {
          "automation-1": legacyAutomation("automation-1", {
            kind: "heartbeat",
            execution: { mode: "existing-thread", threadId: "thread-9" },
          }),
          "automation-2": legacyAutomation("automation-2", { status: "deleted", nextRunAt: null }),
        },
        runs: {
          "run-1": { ...runningRun("run-1"), summary: "Done" },
          "run-2": { ...runningRun("run-2"), automationId: "automation-2" },
        },
        notifications: {
          "notification-1": {
            ...notification("notification-1", "run-1", "message-1"),
            status: "pending",
            target: { provider: "example", resource: "destination", id: "room-1" },
          },
        },
      }),
      "utf8",
    );
    const store = new AutomationStore(path, new Logger("error"));
    await store.load();

    expect(store.getAutomation("automation-1")).toMatchObject({ threadId: "thread-9" });
    expect(store.getAutomation("automation-2")).toBeUndefined();
    expect(store.getRun("run-1")).not.toHaveProperty("summary");
    expect(store.getRun("run-2")).toBeUndefined();
    expect(store.listNotifications()[0]).toMatchObject({
      status: "failed",
      error: "Wirebot restarted before notification delivery was confirmed.",
    });
  });

  it("fails closed instead of forgetting schedules when persisted state is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wirebot-automations-invalid-"));
    directories.push(directory);
    const path = join(directory, "automations.json");
    await writeFile(path, "{not valid json\n", "utf8");
    const store = new AutomationStore(path, new Logger("error"));

    await expect(store.load()).rejects.toThrow("Could not load automation state");
    await expect(readFile(path, "utf8")).resolves.toBe("{not valid json\n");
  });
});

async function createStore(): Promise<{ path: string; store: AutomationStore }> {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-automations-"));
  directories.push(directory);
  const path = join(directory, "automations.json");
  const store = new AutomationStore(path, new Logger("error"));
  await store.load();
  return { path, store };
}

function automation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: "automation-1",
    owner: { provider: "example", resource: "user", id: "user-1" },
    conversation: { provider: "example", resource: "conversation", id: "room-1" },
    deliveryTarget: { provider: "example", resource: "conversation", id: "room-1" },
    name: "Status",
    prompt: "Check the status",
    status: "active",
    schedule: {
      rrule: "FREQ=HOURLY",
      startAt: "2026-07-21T10:00:00Z",
      timeZone: "UTC",
    },
    threadId: null,
    notificationPolicy: "on-result",
    model: null,
    reasoningEffort: null,
    nextRunAt: "2026-07-21T10:00:00Z",
    lastRunAt: null,
    deferredUntil: null,
    deferralReason: null,
    createdAt: "2026-07-21T09:00:00Z",
    updatedAt: "2026-07-21T09:00:00Z",
    revision: 0,
    ...overrides,
  };
}

function runningRun(id: string): AutomationRun {
  return {
    id,
    automationId: "automation-1",
    scheduledFor: "2026-07-21T10:00:00Z",
    status: "running",
    startedAt: "2026-07-21T10:00:00Z",
    finishedAt: null,
    threadId: null,
    error: null,
  };
}

function notification(id: string, runId: string, messageId: string): AutomationNotification {
  return {
    id,
    automationId: "automation-1",
    runId,
    publishedMessages: [{ provider: "example", resource: "message", id: messageId }],
    sourceThreadId: "codex-thread-1",
    status: "delivered",
    title: "Status",
    body: "Completed",
    error: null,
    createdAt: "2026-07-21T10:01:00Z",
    updatedAt: "2026-07-21T10:01:00Z",
  };
}
