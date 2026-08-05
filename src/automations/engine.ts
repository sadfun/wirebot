import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ApplicationContext } from "../codex/rpc.js";
import type {
  CodexDynamicTool,
  CodexDynamicToolContext,
  CodexService,
  CodexTurnResult,
} from "../codex/service.js";
import {
  type DeliveryReceipt,
  type MessagingChannel,
  type OutboundMessage,
  type ProviderReference,
  sameReference,
} from "../core/channel.js";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { nextOccurrence } from "./recurrence.js";
import type { AutomationStore } from "./store.js";
import type { AutomationDefinition, AutomationNotification, AutomationRun } from "./types.js";

const reasoningEffortSchema = z.string().trim().min(1).max(100).nullable().optional();
const notificationPolicySchema = z.enum(["always", "on-result", "never"]);
const maximumAutomationsPerConversation = 100;
const maximumResultLength = 20_000;
const rruleDescription =
  "One bounded RRULE line using FREQ=MINUTELY, HOURLY, DAILY, or WEEKLY; no DTSTART.";

const viewOperationSchema = z.strictObject({
  mode: z.literal("view"),
  id: z.string().trim().min(1).max(256).optional(),
});

const createOperationSchema = z.strictObject({
  mode: z.literal("create"),
  kind: z.enum(["cron", "heartbeat"]),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  rrule: z.string().trim().min(1).max(4_096).describe(rruleDescription),
  time_zone: z.string().trim().min(1).max(128).optional(),
  notification_policy: notificationPolicySchema.optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoning_effort: reasoningEffortSchema,
});

const updateOperationSchema = z.strictObject({
  mode: z.literal("update"),
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  rrule: z.string().trim().min(1).max(4_096).describe(rruleDescription).optional(),
  time_zone: z.string().trim().min(1).max(128).optional(),
  status: z.enum(["active", "paused"]).optional(),
  notification_policy: notificationPolicySchema.optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoning_effort: reasoningEffortSchema,
});

const deleteOperationSchema = z.strictObject({
  mode: z.literal("delete"),
  id: z.string().trim().min(1).max(256),
});

const miniAppCreateScheduleSchema = createOperationSchema.omit({ mode: true, kind: true }).extend({
  idempotency_key: z.string().trim().min(1).max(128),
});

const miniAppUpdateScheduleSchema = updateOperationSchema
  .omit({ mode: true, id: true })
  .extend({ expected_revision: z.number().int().nonnegative() })
  .refine(
    (operation) =>
      operation.name !== undefined ||
      operation.prompt !== undefined ||
      operation.rrule !== undefined ||
      operation.time_zone !== undefined ||
      operation.status !== undefined ||
      operation.notification_policy !== undefined ||
      operation.model !== undefined ||
      operation.reasoning_effort !== undefined,
    { message: "At least one schedule change is required" },
  );

const automationOperationSchema = z.discriminatedUnion("mode", [
  viewOperationSchema,
  createOperationSchema,
  updateOperationSchema,
  deleteOperationSchema,
]);

const scheduledResultSchema = z.strictObject({
  notify: z.boolean().describe("Whether this result is important enough to notify the user."),
  title: z.string().trim().max(500),
  message: z.string().trim().max(maximumResultLength),
});

const scheduledResultJsonSchema = toolJsonSchema(scheduledResultSchema);

export interface ManagedSchedule {
  readonly id: string;
  readonly kind: "cron" | "heartbeat";
  readonly name: string;
  readonly prompt: string;
  readonly status: "active" | "paused";
  readonly rrule: string;
  readonly time_zone: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly notification_policy: "always" | "on-result" | "never";
  readonly model: string | null;
  readonly reasoning_effort: string | null;
  readonly deferral_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

export class AutomationManagementError extends Error {
  public override readonly name = "AutomationManagementError";
  public readonly code: "conflict" | "invalid" | "not_found";

  public constructor(code: "conflict" | "invalid" | "not_found", message: string) {
    super(message);
    this.code = code;
  }
}

const automationUpdateSpec = {
  type: "function",
  name: "automation_update",
  description: `Manage Wirebot scheduled runs. Use this whenever the user asks to schedule, repeat, monitor, remind, follow up later, list schedules, pause, resume, change, or delete a scheduled task. Use kind "heartbeat" to revisit this same Codex thread; use "cron" for a fresh persistent thread on every run. Wirebot accepts a bounded RFC 5545 RRULE subset: MINUTELY with INTERVAL; HOURLY with optional BYMINUTE; DAILY or WEEKLY with optional BYMINUTE, BYHOUR, and BYDAY; plus UNTIL, and WKST for WEEKLY. Use one line, no DTSTART, and keep BY lists small. New schedules and unfiltered lists bind to the current conversation; an existing schedule explicitly identified by id can be viewed, updated, or deleted from any conversation owned by the same authenticated user. Do not invent owners, destinations, or thread IDs.`,
  inputSchema: toolJsonSchema(automationOperationSchema),
} as const satisfies CodexDynamicTool["spec"];

export interface ScheduledRunsEngineOptions {
  readonly store: AutomationStore;
  readonly codex: CodexService;
  readonly channels: readonly MessagingChannel[];
  readonly workspace: string;
  readonly logger: Logger;
  /** Test seams; production relies on the defaults. */
  readonly pollIntervalMs?: number;
  readonly deferralMs?: number;
  readonly maxConcurrency?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

type LaneDecision =
  | { readonly acquired: true; readonly release: () => void }
  | {
      readonly acquired: false;
      readonly pause?: boolean;
      readonly reason: string;
      readonly retryAt?: Date;
    };

export class ScheduledRunsEngine {
  readonly #store: AutomationStore;
  readonly #codex: CodexService;
  readonly #channels: ReadonlyMap<string, MessagingChannel>;
  readonly #workspace: string;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #deferralMs: number;
  readonly #maxConcurrency: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #inFlight = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #tickInProgress: Promise<void> | undefined;
  #initialized = false;
  #stopping = false;

  public constructor(options: ScheduledRunsEngineOptions) {
    this.#store = options.store;
    this.#codex = options.codex;
    this.#channels = new Map(options.channels.map((channel) => [channel.name, channel]));
    this.#workspace = options.workspace;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.#deferralMs = options.deferralMs ?? 30_000;
    this.#maxConcurrency = options.maxConcurrency ?? 3;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#codex.registerDynamicTool({
      spec: automationUpdateSpec,
      execute: async (argumentsValue, context) => await this.executeTool(argumentsValue, context),
    });
  }

  public get activeCount(): number {
    return this.#inFlight.size;
  }

  public async start(): Promise<void> {
    if (this.#timer !== undefined) return;
    if (this.#stopping) throw new Error("Cannot restart a stopped scheduled-runs engine");
    await this.tick();
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.#logger.error("Scheduled-runs tick failed", error);
      });
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  /** Claims and launches due work; completion continues asynchronously. */
  public async tick(): Promise<void> {
    if (this.#stopping) return;
    await this.ensureInitialized();
    if (this.#tickInProgress !== undefined) return await this.#tickInProgress;
    const operation = this.runTick();
    this.#tickInProgress = operation;
    try {
      await operation;
    } finally {
      if (this.#tickInProgress === operation) this.#tickInProgress = undefined;
    }
  }

  public async waitForIdle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight.values()]);
    }
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const drained = (async (): Promise<void> => {
      if (this.#tickInProgress !== undefined) await this.#tickInProgress;
      await this.waitForIdle();
    })();
    await this.#codex.interruptScheduledTurns();
    await drained;
  }

  public listForConversation(
    owner: ProviderReference,
    conversation: ProviderReference,
  ): readonly (AutomationDefinition & { readonly kind: "cron" | "heartbeat" })[] {
    return this.#store
      .listAutomations()
      .filter(
        (automation) =>
          sameReference(automation.owner, owner) &&
          sameReference(automation.conversation, conversation),
      )
      .map((automation) => ({ ...automation, kind: automationKind(automation) }));
  }

  /** Lists every schedule owned by a user, including schedules created in other conversations. */
  public listForOwner(owner: ProviderReference): readonly ManagedSchedule[] {
    return this.#store
      .listAutomations()
      .filter((automation) => sameReference(automation.owner, owner))
      .map(summarizeAutomation);
  }

  /** Creates a fresh-task schedule from the authenticated Mini App. */
  public async createForOwner(
    owner: ProviderReference,
    conversation: ProviderReference,
    deliveryTarget: ProviderReference,
    input: unknown,
  ): Promise<Readonly<{ created: boolean; schedule: ManagedSchedule }>> {
    const { idempotency_key: idempotencyKey, ...values } = miniAppCreateScheduleSchema.parse(input);
    const operation = createOperationSchema.parse({
      mode: "create",
      kind: "cron",
      ...values,
    });
    const id = stableAutomationId("miniapp", owner.provider, owner.id, idempotencyKey);
    const result = await this.createAutomation(operation, {
      id,
      owner,
      conversation,
      deliveryTarget,
      threadId: null,
    });
    return { created: result.created, schedule: summarizeAutomation(result.automation) };
  }

  /** Updates an owned schedule with optimistic revision protection. */
  public async updateForOwner(
    owner: ProviderReference,
    id: string,
    input: unknown,
  ): Promise<ManagedSchedule> {
    const { expected_revision: expectedRevision, ...changes } =
      miniAppUpdateScheduleSchema.parse(input);
    const operation = updateOperationSchema.parse({ mode: "update", id, ...changes });
    const updated = await this.updateAutomation(operation, owner, undefined, expectedRevision);
    return summarizeAutomation(updated);
  }

  /** Permanently deletes an owned schedule and its retained run history. */
  public async deleteForOwner(owner: ProviderReference, id: string): Promise<void> {
    this.requireOwnedAutomation(id, owner);
    if (!(await this.#store.deleteAutomation(id))) {
      throw new AutomationManagementError("not_found", "Schedule not found");
    }
  }

  public async contextForReply(
    replyTo: ProviderReference | undefined,
    owner: ProviderReference,
    conversation: ProviderReference,
  ): Promise<ApplicationContext | undefined> {
    if (replyTo === undefined) return undefined;
    const notification = this.#store.findNotificationByPublishedMessage(replyTo);
    if (notification === undefined) return undefined;
    const automation = this.#store.getAutomation(notification.automationId);
    if (
      automation === undefined ||
      !sameReference(automation.owner, owner) ||
      !sameReference(automation.conversation, conversation)
    ) {
      return undefined;
    }
    return {
      "wirebot.scheduled-result": {
        kind: "application",
        value: `The user is replying to a Wirebot scheduled-run notification. The quoted provider message may be truncated; this is the complete stored result. Do not imply that another Codex thread is the current thread.\n\nAutomation: ${automation.name}\nRun ID: ${notification.runId}\nSource thread: ${notification.sourceThreadId ?? "unavailable"}\nTitle: ${notification.title ?? automation.name}\nResult:\n${notification.body ?? "(no result text)"}`,
      },
    };
  }

  public async continueRun(
    owner: ProviderReference,
    conversation: ProviderReference,
    runId: string,
  ): Promise<Readonly<{ automationName: string; changed: boolean }>> {
    const run = this.#store.getRun(runId);
    if (run === undefined) throw new Error("Scheduled run not found");
    const automation = this.requireAccessibleAutomation(run.automationId, owner, conversation);
    const sourceThreadId =
      run.threadId ??
      this.#store
        .listNotifications(run.id)
        .find((notification) => notification.sourceThreadId !== null)?.sourceThreadId;
    if (sourceThreadId === undefined || sourceThreadId === null) {
      throw new Error("The scheduled run has no resumable Codex task");
    }
    const changed = await this.#codex.activateConversationThread(
      conversation.id,
      conversation.provider,
      sourceThreadId,
    );
    return { automationName: automation.name, changed };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    const recovered = await this.#store.recoverInterruptedRuns(this.currentDate().toISOString());
    if (recovered.length > 0) {
      this.#logger.warn("Recovered interrupted scheduled runs", { count: recovered.length });
    }
    this.#initialized = true;
  }

  private async runTick(): Promise<void> {
    const now = this.currentDate();
    let capacity = this.#maxConcurrency - this.#inFlight.size;
    if (capacity <= 0) return;

    for (const automation of this.#store.listDueAutomations(now.toISOString())) {
      if (capacity <= 0) break;
      if (this.#inFlight.has(automation.id) || automation.nextRunAt === null) continue;

      const decision = await this.acquireLane(automation, now);
      if (!decision.acquired) {
        if (decision.pause === true) {
          await this.pauseDeniedAutomation(automation, now, decision.reason);
        } else {
          await this.#store.deferAutomation({
            automationId: automation.id,
            expectedNextRunAt: automation.nextRunAt,
            retryAt: validRetryAt(decision.retryAt, now, this.#deferralMs).toISOString(),
            reason: decision.reason,
            updatedAt: now.toISOString(),
          });
        }
        continue;
      }

      let nextRunAt: Date | null;
      try {
        // Calculating from now deliberately coalesces all missed occurrences.
        nextRunAt = nextOccurrence(automation.schedule, now);
      } catch (error) {
        this.releaseLane(decision.release);
        await this.pauseInvalidSchedule(automation, now, error);
        continue;
      }

      const run: AutomationRun = {
        id: this.#createId(),
        automationId: automation.id,
        scheduledFor: automation.nextRunAt,
        status: "running",
        startedAt: now.toISOString(),
        finishedAt: null,
        threadId: null,
        error: null,
      };
      const claimed = await this.#store.claimRun({
        automationId: automation.id,
        expectedNextRunAt: automation.nextRunAt,
        nextRunAt: nextRunAt?.toISOString() ?? null,
        run,
      });
      if (!claimed) {
        this.releaseLane(decision.release);
        continue;
      }

      this.launch(automation, run, decision.release);
      capacity -= 1;
    }
  }

  /**
   * The engine owns foreground priority: a run may only start while the owner
   * stays authorized and no user turn holds the conversation.
   */
  private async acquireLane(automation: AutomationDefinition, now: Date): Promise<LaneDecision> {
    try {
      const channel = this.#channels.get(automation.owner.provider);
      if (channel === undefined || !(await channel.isAuthorized(automation.owner))) {
        return {
          acquired: false,
          pause: true,
          reason: "The messaging provider no longer authorizes this schedule's owner.",
        };
      }
      const decision = this.#codex.tryAcquireBackground(automation.conversation.id);
      return decision.acquired
        ? { acquired: true, release: decision.release }
        : { acquired: false, reason: decision.reason, retryAt: decision.retryAt };
    } catch (error) {
      this.#logger.warn("Could not acquire a scheduled-run conversation lease", {
        automationId: automation.id,
        error: errorMessage(error),
      });
      return {
        acquired: false,
        reason: "The conversation lane could not be acquired.",
        retryAt: new Date(now.getTime() + this.#deferralMs),
      };
    }
  }

  private launch(automation: AutomationDefinition, run: AutomationRun, release: () => void): void {
    const execution = this.execute(automation, run, release);
    this.#inFlight.set(automation.id, execution);
    void execution
      .finally(() => {
        if (this.#inFlight.get(automation.id) === execution) this.#inFlight.delete(automation.id);
      })
      .catch((error: unknown) => {
        this.#logger.error("Scheduled-run finalization failed", error, {
          automationId: automation.id,
          runId: run.id,
        });
      });
  }

  private async execute(
    automation: AutomationDefinition,
    run: AutomationRun,
    release: () => void,
  ): Promise<void> {
    let completion:
      | { readonly status: "succeeded"; readonly threadId: string }
      | { readonly status: "failed" | "interrupted"; readonly error: string };
    try {
      completion = { status: "succeeded", threadId: await this.runAutomation(automation, run) };
    } catch (error) {
      completion = {
        status: this.#stopping ? "interrupted" : "failed",
        error: this.#stopping
          ? "Wirebot stopped before the scheduled run completed."
          : errorMessage(error),
      };
      if (!this.#stopping) {
        this.#logger.error("Scheduled run failed", error, {
          automationId: automation.id,
          runId: run.id,
        });
      }
    }

    try {
      await this.#store.completeRun(run.id, {
        ...completion,
        finishedAt: this.currentDate().toISOString(),
      });
    } catch (error) {
      this.#logger.error("Could not persist scheduled-run completion", error, {
        automationId: automation.id,
        runId: run.id,
      });
    } finally {
      this.releaseLane(release);
    }
  }

  private async pauseInvalidSchedule(
    automation: AutomationDefinition,
    now: Date,
    error: unknown,
  ): Promise<void> {
    const message = `Invalid recurrence: ${errorMessage(error)}`;
    await this.#store.updateAutomation(automation.id, (current) => {
      if (current.revision !== automation.revision || current.nextRunAt !== automation.nextRunAt) {
        return current;
      }
      return {
        ...current,
        status: "paused",
        deferredUntil: null,
        deferralReason: message,
        updatedAt: now.toISOString(),
        revision: current.revision + 1,
      };
    });
    this.#logger.error("Paused automation with an invalid schedule", error, {
      automationId: automation.id,
    });
  }

  private async pauseDeniedAutomation(
    automation: AutomationDefinition,
    now: Date,
    reason: string,
  ): Promise<void> {
    await this.#store.updateAutomation(automation.id, (current) => {
      if (current.revision !== automation.revision || current.nextRunAt !== automation.nextRunAt) {
        return current;
      }
      return {
        ...current,
        status: "paused",
        nextRunAt: null,
        deferredUntil: null,
        deferralReason: reason,
        updatedAt: now.toISOString(),
        revision: current.revision + 1,
      };
    });
    this.#logger.warn("Paused an unauthorized scheduled run", {
      automationId: automation.id,
      reason,
    });
  }

  private releaseLane(release: () => void): void {
    try {
      release();
    } catch (error) {
      this.#logger.error("Could not release a scheduled-run conversation lease", error);
    }
  }

  private async createAutomation(
    operation: z.infer<typeof createOperationSchema>,
    binding: Readonly<{
      id: string;
      owner: ProviderReference;
      conversation: ProviderReference;
      deliveryTarget: ProviderReference;
      threadId: string | null;
    }>,
  ): Promise<Readonly<{ created: boolean; automation: AutomationDefinition }>> {
    const existing = this.#store.getAutomation(binding.id);
    if (existing !== undefined) {
      if (
        !sameReference(existing.owner, binding.owner) ||
        !sameReference(existing.conversation, binding.conversation)
      ) {
        throw new Error("Automation ID collision");
      }
      await this.ensureMemoryFile(existing.id);
      return { created: false, automation: existing };
    }
    if (
      this.listForConversation(binding.owner, binding.conversation).length >=
      maximumAutomationsPerConversation
    ) {
      throw new AutomationManagementError(
        "invalid",
        `This conversation already has ${maximumAutomationsPerConversation} scheduled runs`,
      );
    }
    const now = this.currentDate();
    const timeZone = operation.time_zone ?? localTimeZone();
    const startAt = new Date(Math.ceil(now.getTime() / 60_000) * 60_000).toISOString();
    const schedule = { rrule: operation.rrule, startAt, timeZone };
    const nextRunAt = nextOccurrence(schedule, now);
    if (nextRunAt === null) {
      throw new AutomationManagementError("invalid", "The schedule has no future occurrence");
    }
    const automation: AutomationDefinition = {
      id: binding.id,
      owner: binding.owner,
      conversation: binding.conversation,
      deliveryTarget: binding.deliveryTarget,
      name: operation.name,
      prompt: operation.prompt,
      status: "active",
      schedule,
      threadId: binding.threadId,
      notificationPolicy:
        operation.notification_policy ?? (operation.kind === "heartbeat" ? "on-result" : "always"),
      model: operation.model ?? null,
      reasoningEffort: operation.reasoning_effort ?? null,
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      deferredUntil: null,
      deferralReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 0,
    };
    await this.ensureMemoryFile(automation.id);
    await this.#store.putAutomation(automation);
    return { created: true, automation };
  }

  private async updateAutomation(
    operation: z.infer<typeof updateOperationSchema>,
    owner: ProviderReference,
    conversation?: ProviderReference,
    expectedRevision?: number,
  ): Promise<AutomationDefinition> {
    if (conversation === undefined) this.requireOwnedAutomation(operation.id, owner);
    else this.requireAccessibleAutomation(operation.id, owner, conversation);
    const now = this.currentDate();
    const updated = await this.#store.updateAutomation(operation.id, (current) => {
      const accessible =
        sameReference(current.owner, owner) &&
        (conversation === undefined || sameReference(current.conversation, conversation));
      if (!accessible) {
        throw new AutomationManagementError("not_found", "Schedule not found");
      }
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new AutomationManagementError(
          "conflict",
          "This schedule changed since you opened it. Refresh and try again.",
        );
      }
      const schedule = {
        ...current.schedule,
        ...(operation.rrule === undefined ? {} : { rrule: operation.rrule }),
        ...(operation.time_zone === undefined ? {} : { timeZone: operation.time_zone }),
      };
      const status = operation.status ?? current.status;
      const candidateNextRunAt = nextOccurrence(schedule, now);
      if (status === "active" && candidateNextRunAt === null) {
        throw new AutomationManagementError(
          "invalid",
          "The updated schedule has no future occurrence",
        );
      }
      return {
        ...current,
        ...(operation.name === undefined ? {} : { name: operation.name }),
        ...(operation.prompt === undefined ? {} : { prompt: operation.prompt }),
        ...(operation.notification_policy === undefined
          ? {}
          : { notificationPolicy: operation.notification_policy }),
        ...(operation.model === undefined ? {} : { model: operation.model }),
        ...(operation.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: operation.reasoning_effort }),
        schedule,
        status,
        nextRunAt: status === "paused" ? null : (candidateNextRunAt?.toISOString() ?? null),
        deferredUntil: null,
        deferralReason: null,
        updatedAt: now.toISOString(),
        revision: current.revision + 1,
      };
    });
    if (updated === undefined) {
      throw new AutomationManagementError("not_found", "Schedule not found");
    }
    return updated;
  }

  private async executeTool(
    argumentsValue: unknown,
    context: CodexDynamicToolContext,
  ): Promise<unknown> {
    const operation = automationOperationSchema.parse(argumentsValue);
    const owner = context.owner;
    if (owner === undefined) throw new Error("Scheduled runs require an authenticated user");
    const conversation = conversationReference(context.connector, context.conversationKey);
    switch (operation.mode) {
      case "view": {
        if (operation.id !== undefined) {
          return summarizeAutomation(this.requireOwnedAutomation(operation.id, owner));
        }
        return {
          automations: this.listForConversation(owner, conversation).map(summarizeAutomation),
        };
      }
      case "create": {
        if (context.deliveryTarget === undefined) {
          throw new Error("This messaging session cannot receive scheduled results");
        }
        const id = stableAutomationId(context.threadId, context.callId);
        const result = await this.createAutomation(operation, {
          id,
          owner,
          conversation,
          deliveryTarget: context.deliveryTarget,
          threadId: operation.kind === "heartbeat" ? context.threadId : null,
        });
        return {
          created: result.created,
          automation: summarizeAutomation(result.automation),
        };
      }
      case "update": {
        const updated = await this.updateAutomation(operation, owner);
        return { updated: true, automation: summarizeAutomation(updated) };
      }
      case "delete": {
        this.requireOwnedAutomation(operation.id, owner);
        await this.#store.deleteAutomation(operation.id);
        return { deleted: true, id: operation.id };
      }
    }
  }

  private async runAutomation(
    automation: AutomationDefinition,
    run: AutomationRun,
  ): Promise<string> {
    let result: CodexTurnResult | undefined;
    try {
      const memoryPath = await this.ensureMemoryFile(automation.id);
      const prompt = scheduledPrompt(automation, run, memoryPath, this.currentDate());
      result = await this.#codex.runScheduledTurn({
        conversationKey: automation.conversation.id,
        connector: automation.conversation.provider,
        prompt,
        thread:
          automation.threadId === null
            ? { mode: "new", developerInstructions: scheduledDeveloperInstructions(memoryPath) }
            : { mode: "existing", threadId: automation.threadId },
        invocation: {
          owner: automation.owner,
          deliveryTarget: automation.deliveryTarget,
          automationId: automation.id,
        },
        ...(automation.model === null ? {} : { model: automation.model }),
        ...(automation.reasoningEffort === null
          ? {}
          : { reasoningEffort: automation.reasoningEffort }),
        outputSchema: scheduledResultJsonSchema,
      });
      const parsed = parseScheduledResult(result.rawText);
      await this.deliver(automation, run, {
        notify: notificationDecision(automation, parsed.notify),
        title: parsed.title || automation.name,
        body: appendUnavailableAttachmentWarning(parsed.message, result.unavailableAttachments),
        sourceThreadId: result.threadId,
        attachments: result.attachments,
      });
      return result.threadId;
    } catch (error) {
      if (!this.#stopping) {
        await this.deliver(automation, run, {
          notify: true,
          title: automation.name,
          body: truncate(`Scheduled run failed: ${errorMessage(error)}`, maximumResultLength),
          sourceThreadId: null,
        }).catch((deliveryError: unknown) => {
          this.#logger.error("Could not deliver scheduled-run failure", deliveryError, {
            automationId: automation.id,
            runId: run.id,
          });
        });
      }
      throw error;
    } finally {
      await result?.dispose();
    }
  }

  /** Records the run's notification exactly once, with its final outcome. */
  private async deliver(
    automation: AutomationDefinition,
    run: AutomationRun,
    result: Readonly<{
      notify: boolean;
      title: string;
      body: string;
      sourceThreadId: string | null;
      attachments?: OutboundMessage["attachments"];
    }>,
  ): Promise<void> {
    const record = (
      status: AutomationNotification["status"],
      outcome: Partial<Pick<AutomationNotification, "publishedMessages" | "error">> = {},
    ): AutomationNotification => {
      const now = this.currentDate().toISOString();
      return {
        id: crypto.randomUUID(),
        automationId: automation.id,
        runId: run.id,
        publishedMessages: [],
        sourceThreadId: result.sourceThreadId,
        status,
        title: result.title,
        body: result.body,
        error: null,
        createdAt: now,
        updatedAt: now,
        ...outcome,
      };
    };
    if (!result.notify) {
      await this.#store.putNotification(record("suppressed"));
      return;
    }
    try {
      const receipt = await this.publish(automation.deliveryTarget, {
        text: notificationText(result.title, result.body),
        ...(result.attachments === undefined ? {} : { attachments: result.attachments }),
        ...(result.sourceThreadId === null
          ? {}
          : {
              actions: [
                { label: "Continue this run", command: { name: "continue", args: run.id } },
              ],
            }),
      });
      await this.#store.putNotification(
        record("delivered", { publishedMessages: receipt.publishedMessages }),
      );
    } catch (error) {
      await this.#store.putNotification(record("failed", { error: errorMessage(error) }));
      this.#logger.warn("Scheduled result could not be delivered", {
        automationId: automation.id,
        runId: run.id,
        error: errorMessage(error),
      });
    }
  }

  private async publish(
    target: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const channel = this.#channels.get(target.provider);
    if (channel === undefined) throw new Error(`No messaging provider for ${target.provider}`);
    return await channel.publish(target, message);
  }

  private requireAccessibleAutomation(
    id: string,
    owner: ProviderReference,
    conversation: ProviderReference,
  ): AutomationDefinition {
    const automation = this.#store.getAutomation(id);
    if (
      automation === undefined ||
      !sameReference(automation.owner, owner) ||
      !sameReference(automation.conversation, conversation)
    ) {
      throw new Error("Automation not found");
    }
    return automation;
  }

  private requireOwnedAutomation(id: string, owner: ProviderReference): AutomationDefinition {
    const automation = this.#store.getAutomation(id);
    if (automation === undefined || !sameReference(automation.owner, owner)) {
      throw new AutomationManagementError("not_found", "Schedule not found");
    }
    return automation;
  }

  private async ensureMemoryFile(automationId: string): Promise<string> {
    const directory = join(this.#workspace, ".wirebot", "automations", automationId);
    const path = join(directory, "memory.md");
    await mkdir(directory, { recursive: true });
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, "# Automation memory\n\n", { encoding: "utf8", mode: 0o600 });
    }
    return path;
  }

  private currentDate(): Date {
    const date = this.#now();
    if (!Number.isFinite(date.getTime()))
      throw new Error("Automation clock returned an invalid date");
    return date;
  }
}

function toolJsonSchema(schema: z.ZodType): JsonValue {
  const { $schema: _$schema, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema as JsonValue;
}

function stableAutomationId(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  const value = hash.digest("hex");
  return `auto_${value.slice(0, 32)}`;
}

function conversationReference(provider: string, id: string): ProviderReference {
  return { provider, resource: "conversation", id };
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function automationKind(automation: AutomationDefinition): "cron" | "heartbeat" {
  return automation.threadId === null ? "cron" : "heartbeat";
}

function notificationDecision(automation: AutomationDefinition, modelDecision: boolean): boolean {
  if (automation.notificationPolicy === "always") return true;
  if (automation.notificationPolicy === "never") return false;
  return modelDecision;
}

function parseScheduledResult(text: string): z.infer<typeof scheduledResultSchema> {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    return scheduledResultSchema.parse(JSON.parse(unfenced));
  } catch {
    return {
      // Suppression must be an explicit, schema-valid model decision. A malformed
      // result is surfaced rather than silently hiding a potentially important heartbeat.
      notify: true,
      title: "",
      message: truncate(
        trimmed || "Scheduled run completed without a result.",
        maximumResultLength,
      ),
    };
  }
}

function summarizeAutomation(automation: AutomationDefinition): ManagedSchedule {
  return {
    id: automation.id,
    kind: automationKind(automation),
    name: automation.name,
    prompt: automation.prompt,
    status: automation.status,
    rrule: automation.schedule.rrule,
    time_zone: automation.schedule.timeZone,
    next_run_at: automation.nextRunAt,
    last_run_at: automation.lastRunAt,
    notification_policy: automation.notificationPolicy,
    model: automation.model,
    reasoning_effort: automation.reasoningEffort,
    deferral_reason: automation.deferralReason,
    created_at: automation.createdAt,
    updated_at: automation.updatedAt,
    revision: automation.revision,
  };
}

function scheduledPrompt(
  automation: AutomationDefinition,
  run: AutomationRun,
  memoryPath: string,
  now: Date,
): string {
  const envelope = automation.threadId === null ? "scheduled_run" : "heartbeat";
  // The envelope is advisory structure for the model, not a parser boundary.
  return `<${envelope}>
<automation_id>${automation.id}</automation_id>
<run_id>${run.id}</run_id>
<name>${automation.name}</name>
<scheduled_for>${run.scheduledFor}</scheduled_for>
<current_time_iso>${now.toISOString()}</current_time_iso>
<memory_path>${memoryPath}</memory_path>
<instructions>
${automation.prompt}
</instructions>

Read the memory file before doing the work. Update it with concise durable context before finishing. This is an unattended run: do not ask the user questions or wait for approval. Return the required structured result. Set notify=false when a heartbeat found nothing worth interrupting the user about. Never claim that a suppressed result was shown to the user.
</${envelope}>`;
}

function scheduledDeveloperInstructions(memoryPath: string): string {
  return `You are running an unattended Wirebot scheduled task, following the Codex Desktop automation model. Read ${memoryPath} before each run and update it with concise durable context before finishing. Do not ask the user questions or wait for interactive approval. Your final response must follow the supplied output schema.`;
}

function notificationText(title: string, message: string): string {
  return `⏱ ${title}\n\n${message}\n\nReply to this message to discuss it in your current task.`;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, length);
}

function validRetryAt(candidate: Date | undefined, now: Date, deferralMs: number): Date {
  if (candidate !== undefined && Number.isFinite(candidate.getTime()) && candidate > now) {
    return candidate;
  }
  return new Date(now.getTime() + deferralMs);
}

function appendUnavailableAttachmentWarning(
  message: string,
  unavailable: readonly string[],
): string {
  if (unavailable.length === 0) return message;
  const warning = `Could not attach ${unavailable.join(", ")}.`;
  return truncate(message.length === 0 ? warning : `${warning}\n\n${message}`, maximumResultLength);
}
