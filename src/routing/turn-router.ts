import {
  type EditableConfigSnapshot,
  type ModelCapability,
  selectedModel,
} from "../codex/config-service.js";
import type { TurnRoutingDecision, TurnRoutingRequest } from "../codex/service.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { truncate } from "../shared/text.js";
import type { JevDecision, JevDecisionClient, JevQuestion } from "./jev.js";

export interface TurnRouterConfigAccess {
  read(): Promise<Pick<EditableConfigSnapshot, "values" | "capabilities">>;
}

export interface JevTurnRouterOptions {
  readonly client: JevDecisionClient;
  readonly config: TurnRouterConfigAccess;
  readonly logger: Logger;
  /** Let Jev pick the reasoning effort among the model's supported levels. */
  readonly effort: boolean;
  /** Let Jev decide per turn whether the fast service tier is worth it. */
  readonly fast: boolean;
  /** Service tier id used when Jev votes for a fast reply. */
  readonly fastTier: string;
  readonly timeoutMs?: number;
  /** Minimum "fast is better" probability that selects the fast tier. */
  readonly fastThreshold?: number;
}

const defaultTimeoutMs = 2_500;
const defaultFastThreshold = 0.7;
const maxMessageChars = 8_000;

const effortInstructions =
  "The message was sent to an autonomous coding assistant that can read and edit files, run commands, and browse the web. Pick how much reasoning effort the assistant needs to handle it well.";

/**
 * Routing-oriented descriptions of Codex's effort levels. Levels the model
 * reports but this table lacks fall back to Codex's own description.
 */
const effortCriteria: Readonly<Record<string, string>> = {
  none: "no reasoning needed: a greeting, thanks, or a one-word acknowledgement",
  minimal:
    "a greeting, thanks, a one-word confirmation, or a trivial question answerable in one line",
  low: "a greeting, thanks, a short confirmation, or a trivial question answerable in a line or two",
  medium:
    "an ordinary task: a small edit, a lookup with a short explanation, a summary, or a routine report",
  high: "multi-step work: debugging, investigating logs or code across several files, or a task with several moving parts",
  xhigh:
    "a very hard or high-stakes single problem: architecture or migration design, ambiguous requirements, or risky changes needing deep analysis",
  ultra:
    "large-scale research or investigation: surveying many sources, repositories, or systems and synthesizing them into a report, plan, or comparison; work that splits into parallel sub-tasks",
  max: "one unusually hard problem that needs the deepest possible reasoning, such as a subtle correctness proof or a root cause nobody could find",
};

const fastQuestion: JevQuestion = {
  type: "noul",
  instructions:
    "Would the sender be better served by a quick, low-latency reply than by a slower, more thorough one?",
  criteria: {
    true: "a short conversational message, quick confirmation, or simple lookup where waiting would be annoying",
    false: "substantial work where quality and completeness matter more than response speed",
  },
};

/**
 * Picks per-turn Codex settings with a Jev decision before each user turn.
 * Any failure falls back to the configured settings; routing never blocks a
 * turn for longer than the timeout.
 */
export class JevTurnRouter {
  readonly #client: JevDecisionClient;
  readonly #config: TurnRouterConfigAccess;
  readonly #logger: Logger;
  readonly #effort: boolean;
  readonly #fast: boolean;
  readonly #fastTier: string;
  readonly #timeoutMs: number;
  readonly #fastThreshold: number;

  public constructor(options: JevTurnRouterOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#effort = options.effort;
    this.#fast = options.fast;
    this.#fastTier = options.fastTier;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#fastThreshold = options.fastThreshold ?? defaultFastThreshold;
  }

  public async route(request: TurnRoutingRequest): Promise<TurnRoutingDecision> {
    const model = await this.currentModel();
    if (model === undefined) return {};
    const efforts = this.#effort
      ? model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
      : [];
    const askEffort = efforts.length > 1;
    const askFast = this.#fast && this.fastTierAvailable(model);
    if (!askEffort && !askFast) return {};

    const questions: Record<string, JevQuestion> = {};
    if (askEffort) {
      questions.effort = {
        type: "choice",
        instructions: effortInstructions,
        criteria: Object.fromEntries(
          model.supportedReasoningEfforts.map((option) => [
            option.reasoningEffort,
            effortCriteria[option.reasoningEffort] ??
              (option.description === "" ? option.reasoningEffort : option.description),
          ]),
        ),
      };
    }
    if (askFast) questions.fast = fastQuestion;

    const startedAt = Date.now();
    let decision: JevDecision;
    try {
      decision = await this.#client.decide(
        {
          state: {
            message: truncate(request.text, maxMessageChars),
            conversation: request.newThread
              ? "first message of a new task"
              : "follow-up in an ongoing task",
            attachments: request.attachmentCount,
            channel: request.connector,
          },
          questions,
        },
        AbortSignal.timeout(this.#timeoutMs),
      );
    } catch (error) {
      this.#logger.warn("Jev turn routing failed; using the configured settings", {
        conversationKey: request.conversationKey,
        error: errorMessage(error),
      });
      return {};
    }

    const result: { effort?: string; serviceTierForTurn?: string } = {};
    const effortAnswer = decision.answers.effort;
    if (askEffort && effortAnswer?.type === "choice") {
      if (efforts.includes(effortAnswer.choice)) result.effort = effortAnswer.choice;
      else {
        this.#logger.warn("Jev picked a reasoning effort the model does not support", {
          conversationKey: request.conversationKey,
          choice: effortAnswer.choice,
          supported: efforts,
        });
      }
    }
    const fastAnswer = decision.answers.fast;
    if (askFast && fastAnswer?.type === "noul") {
      result.serviceTierForTurn =
        fastAnswer.noul >= this.#fastThreshold ? this.#fastTier : "default";
    }
    this.#logger.info("Jev routed the turn", {
      conversationKey: request.conversationKey,
      newThread: request.newThread,
      ...result,
      ...(effortAnswer?.type === "choice"
        ? {
            effortConfidence: effortAnswer.confidence,
            effortProbabilities: effortAnswer.probabilities,
          }
        : {}),
      ...(fastAnswer?.type === "noul" ? { fastProbability: fastAnswer.noul } : {}),
      latencyMs: Date.now() - startedAt,
      ...(decision.model === undefined ? {} : { jevModel: decision.model }),
    });
    return result;
  }

  private async currentModel(): Promise<ModelCapability | undefined> {
    try {
      return selectedModel(await this.#config.read());
    } catch (error) {
      this.#logger.warn("Jev turn routing skipped: the Codex model catalog is unavailable", {
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private fastTierAvailable(model: ModelCapability): boolean {
    if (model.serviceTiers.some((tier) => tier.id === this.#fastTier)) return true;
    this.#logger.debug("Jev fast routing skipped: the model has no such service tier", {
      model: model.model,
      fastTier: this.#fastTier,
      serviceTiers: model.serviceTiers.map((tier) => tier.id),
    });
    return false;
  }
}
