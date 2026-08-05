import { z } from "zod";
import { sameReference } from "../core/channel.js";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";
import {
  type AutomationDefinition,
  type AutomationNotification,
  type AutomationRun,
  type AutomationRunCompletion,
  automationDefinitionSchema,
  automationNotificationSchema,
  automationRunSchema,
  type ProviderReference,
} from "./types.js";

const storedStateSchema = z.preprocess(
  migrateStoredState,
  z.strictObject({
    version: z.literal(1),
    automations: z.record(z.string(), automationDefinitionSchema),
    runs: z.record(z.string(), automationRunSchema),
    notifications: z.record(z.string(), automationNotificationSchema),
  }),
);

type StoredState = z.infer<typeof storedStateSchema>;
const maximumRunsPerAutomation = 100;
const maximumNotificationsPerAutomation = 100;

export interface AutomationRunClaim {
  readonly automationId: string;
  readonly expectedNextRunAt: string;
  readonly nextRunAt: string | null;
  readonly run: AutomationRun;
}

export interface AutomationDeferral {
  readonly automationId: string;
  readonly expectedNextRunAt: string;
  readonly retryAt: string;
  readonly reason: string;
  readonly updatedAt: string;
}

function emptyState(): StoredState {
  return { version: 1, automations: {}, runs: {}, notifications: {} };
}

export class AutomationStore extends JsonStore<StoredState> {
  public constructor(path: string, logger: Logger) {
    super(
      path,
      storedStateSchema,
      emptyState(),
      logger,
      "Could not load automation state",
      "throw",
    );
  }

  public getAutomation(id: string): AutomationDefinition | undefined {
    return clone(this.state.automations[id]);
  }

  public listAutomations(): AutomationDefinition[] {
    return Object.values(this.state.automations)
      .map((automation) => clone(automation))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public listDueAutomations(at: string): AutomationDefinition[] {
    const timestamp = Date.parse(at);
    return Object.values(this.state.automations)
      .filter((automation) => {
        if (automation.status !== "active" || automation.nextRunAt === null) return false;
        if (Date.parse(automation.nextRunAt) > timestamp) return false;
        return (
          automation.deferredUntil === null || Date.parse(automation.deferredUntil) <= timestamp
        );
      })
      .map((automation) => clone(automation))
      .sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""));
  }

  public async putAutomation(automation: AutomationDefinition): Promise<AutomationDefinition> {
    return await this.mutate((draft) => {
      draft.automations[automation.id] = automation;
      return automation;
    });
  }

  public async updateAutomation(
    id: string,
    update: (current: AutomationDefinition) => AutomationDefinition,
  ): Promise<AutomationDefinition | undefined> {
    return await this.mutate((draft) => {
      const current = draft.automations[id];
      if (current === undefined) return undefined;
      const updated = update(current);
      if (updated.id !== id) throw new Error("An automation update cannot change its id");
      draft.automations[id] = updated;
      return updated;
    });
  }

  /** Removes the automation along with all of its runs and notifications. */
  public async deleteAutomation(id: string): Promise<boolean> {
    return await this.mutate((draft) => {
      if (draft.automations[id] === undefined) return false;
      delete draft.automations[id];
      for (const [runId, run] of Object.entries(draft.runs)) {
        if (run.automationId === id) delete draft.runs[runId];
      }
      for (const [notificationId, notification] of Object.entries(draft.notifications)) {
        if (notification.automationId === id) delete draft.notifications[notificationId];
      }
      return true;
    });
  }

  /** Atomically advances a schedule and creates its running record. */
  public async claimRun(claim: AutomationRunClaim): Promise<boolean> {
    const run = claim.run;
    if (run.status !== "running" || run.automationId !== claim.automationId) {
      throw new Error("A claimed run must be running and belong to the claimed automation");
    }

    return await this.mutate((draft) => {
      const automation = draft.automations[claim.automationId];
      if (
        automation === undefined ||
        automation.status !== "active" ||
        automation.nextRunAt !== claim.expectedNextRunAt ||
        draft.runs[run.id] !== undefined
      ) {
        return false;
      }

      draft.automations[automation.id] = {
        ...automation,
        status: claim.nextRunAt === null ? "paused" : automation.status,
        nextRunAt: claim.nextRunAt,
        lastRunAt: run.startedAt,
        deferredUntil: null,
        deferralReason: null,
        updatedAt: run.startedAt,
        revision: automation.revision + 1,
      };
      draft.runs[run.id] = run;
      pruneAutomationHistory(draft, automation.id);
      return true;
    });
  }

  public async deferAutomation(deferral: AutomationDeferral): Promise<boolean> {
    return await this.mutate((draft) => {
      const automation = draft.automations[deferral.automationId];
      if (
        automation === undefined ||
        automation.status !== "active" ||
        automation.nextRunAt !== deferral.expectedNextRunAt
      ) {
        return false;
      }
      draft.automations[automation.id] = {
        ...automation,
        deferredUntil: deferral.retryAt,
        deferralReason: deferral.reason,
        updatedAt: deferral.updatedAt,
        revision: automation.revision + 1,
      };
      return true;
    });
  }

  public getRun(id: string): AutomationRun | undefined {
    return clone(this.state.runs[id]);
  }

  public listRuns(automationId?: string): AutomationRun[] {
    return Object.values(this.state.runs)
      .filter((run) => automationId === undefined || run.automationId === automationId)
      .map((run) => clone(run))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async completeRun(id: string, completion: AutomationRunCompletion): Promise<boolean> {
    return await this.mutate((draft) => {
      const run = draft.runs[id];
      if (run === undefined || run.status !== "running") return false;
      draft.runs[id] = {
        ...run,
        status: completion.status,
        finishedAt: completion.finishedAt,
        threadId: completion.threadId ?? run.threadId,
        error: completion.error ?? null,
      };
      pruneAutomationHistory(draft, run.automationId);
      return true;
    });
  }

  public async recoverInterruptedRuns(at: string): Promise<AutomationRun[]> {
    return await this.mutate((draft) => {
      const recovered: AutomationRun[] = [];
      for (const [id, run] of Object.entries(draft.runs)) {
        if (run.status !== "running") continue;
        const interrupted: AutomationRun = {
          ...run,
          status: "interrupted",
          finishedAt: at,
          error: "Wirebot restarted before the scheduled run completed.",
        };
        draft.runs[id] = interrupted;
        recovered.push(interrupted);
      }
      return recovered;
    });
  }

  public listNotifications(runId?: string): AutomationNotification[] {
    return Object.values(this.state.notifications)
      .filter((notification) => runId === undefined || notification.runId === runId)
      .map((notification) => clone(notification))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public findNotificationByPublishedMessage(
    reference: ProviderReference,
  ): AutomationNotification | undefined {
    const notification = Object.values(this.state.notifications).find((candidate) =>
      candidate.publishedMessages.some((message) => sameReference(message, reference)),
    );
    return clone(notification);
  }

  public async putNotification(
    notification: AutomationNotification,
  ): Promise<AutomationNotification> {
    return await this.mutate((draft) => {
      for (const message of notification.publishedMessages) {
        const owner = Object.values(draft.notifications).find(
          (candidate) =>
            candidate.id !== notification.id &&
            candidate.publishedMessages.some((existing) => sameReference(existing, message)),
        );
        if (owner !== undefined) {
          throw new Error(`Published message is already associated with notification ${owner.id}`);
        }
      }
      draft.notifications[notification.id] = notification;
      pruneAutomationHistory(draft, notification.automationId);
      return notification;
    });
  }

  /**
   * Runs a synchronous mutation against a private draft and persists it. The
   * persisted copy is re-cloned so state never aliases caller-held objects.
   */
  private async mutate<T>(operation: (draft: StoredState) => T): Promise<T> {
    const draft = clone(this.state);
    const result = operation(draft);
    await this.persist(clone(draft));
    return result;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pruneAutomationHistory(draft: StoredState, automationId: string): void {
  const runs = Object.values(draft.runs)
    .filter((run) => run.automationId === automationId)
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
  const keptRunIds = new Set<string>();
  for (const run of runs) {
    if (run.status === "running" || keptRunIds.size < maximumRunsPerAutomation) {
      keptRunIds.add(run.id);
    }
  }
  for (const run of runs) {
    if (keptRunIds.has(run.id)) continue;
    delete draft.runs[run.id];
    for (const [notificationId, notification] of Object.entries(draft.notifications)) {
      if (notification.runId === run.id) delete draft.notifications[notificationId];
    }
  }

  const notifications = Object.values(draft.notifications)
    .filter((notification) => notification.automationId === automationId)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  for (const notification of notifications.slice(maximumNotificationsPerAutomation)) {
    delete draft.notifications[notification.id];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One-shot upgrade of pre-0.0.27 persisted state: `kind`/`execution` fold into
 * `threadId`, soft-delete tombstones disappear with their history, and retired
 * bookkeeping fields (`run.summary`, `notification.target`, "pending") drop.
 * Delete once no deployment predates 0.0.27.
 */
function migrateStoredState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.automations)) return value;
  const automations: Record<string, unknown> = {};
  const deleted = new Set<string>();
  for (const [id, entry] of Object.entries(value.automations)) {
    if (!isRecord(entry)) {
      automations[id] = entry;
      continue;
    }
    const { kind: _kind, execution, ...rest } = entry;
    if (rest.status === "deleted") {
      deleted.add(id);
      continue;
    }
    if (rest.threadId === undefined) {
      rest.threadId =
        isRecord(execution) && typeof execution.threadId === "string" ? execution.threadId : null;
    }
    automations[id] = rest;
  }
  const runs: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(isRecord(value.runs) ? value.runs : {})) {
    if (!isRecord(entry)) {
      runs[id] = entry;
      continue;
    }
    if (deleted.has(String(entry.automationId))) continue;
    const { summary: _summary, ...rest } = entry;
    runs[id] = rest;
  }
  const notifications: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(
    isRecord(value.notifications) ? value.notifications : {},
  )) {
    if (!isRecord(entry)) {
      notifications[id] = entry;
      continue;
    }
    if (deleted.has(String(entry.automationId))) continue;
    const { target: _target, ...rest } = entry;
    if (rest.status === "pending") {
      rest.status = "failed";
      rest.error ??= "Wirebot restarted before notification delivery was confirmed.";
    }
    notifications[id] = rest;
  }
  return { ...value, automations, runs, notifications };
}
