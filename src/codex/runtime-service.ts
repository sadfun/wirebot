import type { Personality } from "../generated/codex/Personality.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { Config } from "../generated/codex/v2/Config.js";
import type { ConfigBatchWriteParams } from "../generated/codex/v2/ConfigBatchWriteParams.js";
import type { ConfigReadResponse } from "../generated/codex/v2/ConfigReadResponse.js";
import type { ConsumeAccountRateLimitResetCreditParams } from "../generated/codex/v2/ConsumeAccountRateLimitResetCreditParams.js";
import type { ConsumeAccountRateLimitResetCreditResponse } from "../generated/codex/v2/ConsumeAccountRateLimitResetCreditResponse.js";
import type { GetAccountRateLimitsResponse } from "../generated/codex/v2/GetAccountRateLimitsResponse.js";
import type { RateLimitResetCredit } from "../generated/codex/v2/RateLimitResetCredit.js";
import type { RateLimitResetCreditsSummary } from "../generated/codex/v2/RateLimitResetCreditsSummary.js";
import type { RateLimitSnapshot } from "../generated/codex/v2/RateLimitSnapshot.js";
import type { RateLimitWindow } from "../generated/codex/v2/RateLimitWindow.js";
import type { SkillMetadata } from "../generated/codex/v2/SkillMetadata.js";
import type { SkillsListResponse } from "../generated/codex/v2/SkillsListResponse.js";
import { KeyedSerialQueue } from "../shared/async.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { type CodexConfigService, findBaseUserLayer } from "./config-service.js";
import {
  type CodexAppServer,
  type CodexAppServerExit,
  isCodexTransportUnavailable,
} from "./rpc.js";
import type { CodexService, EffectiveCodexSettings, ExplicitSkillInput } from "./service.js";
import { readSkillResource, type SkillResource } from "./skill-browser.js";

export interface CodexRuntimeStatus {
  readonly state: "ready" | "reloading" | "restarting" | "degraded";
  readonly restartRequired: boolean;
  readonly lastError: string | null;
  readonly lastAppliedAt: string | null;
  readonly configPath: string | null;
}

export interface AvailableSkill {
  readonly name: string;
  readonly description: string;
}

export interface CodexUsageLimitWindow {
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}

export interface CodexBankedReset {
  readonly id: string;
  readonly resetType: "codexRateLimits" | "unknown";
  readonly status: "available" | "redeeming" | "redeemed" | "unknown";
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly title: string | null;
  readonly description: string | null;
}

export interface CodexBankedResets {
  readonly availableCount: number;
  readonly credits: readonly CodexBankedReset[] | null;
}

export interface CodexUsageLimits {
  readonly weekly: CodexUsageLimitWindow | null;
  readonly fiveHour: CodexUsageLimitWindow | null;
  readonly bankedResets: CodexBankedResets | null;
}

export type ApplyBankedResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface CodexRuntimeServiceOptions {
  readonly rpc: CodexAppServer;
  readonly codex: CodexService;
  readonly configService: Pick<CodexConfigService, "invalidateCapabilities">;
  readonly workspace: string;
  readonly logger: Logger;
}

interface ReconcileOptions {
  readonly hotReloadConfig: boolean;
  readonly reloadMcp: boolean;
  readonly freshServer: boolean;
}

/**
 * Keeps Wirebot's long-lived app-server synchronized through Codex's native
 * config, MCP, and skill protocol surface.
 */
export class CodexRuntimeService {
  readonly #rpc: CodexAppServer;
  readonly #codex: CodexService;
  readonly #configService: Pick<CodexConfigService, "invalidateCapabilities">;
  readonly #workspace: string;
  readonly #logger: Logger;
  readonly #skills = new Map<string, SkillMetadata>();
  #skillsByLowerName = new Map<string, SkillMetadata>();
  #skillMentionPattern: RegExp | undefined;
  #settings: EffectiveCodexSettings = {};
  #serverModelProvider: string | null | undefined;
  #status: CodexRuntimeStatus = {
    state: "reloading",
    restartRequired: false,
    lastError: null,
    lastAppliedAt: null,
    configPath: null,
  };
  readonly #operations = new KeyedSerialQueue();
  #unsubscribeNotification: (() => void) | undefined;
  #unsubscribeExit: (() => void) | undefined;
  #stopped = true;

  public constructor(options: CodexRuntimeServiceOptions) {
    this.#rpc = options.rpc;
    this.#codex = options.codex;
    this.#configService = options.configService;
    this.#workspace = options.workspace;
    this.#logger = options.logger;
  }

  public async start(): Promise<CodexRuntimeStatus> {
    this.#stopped = false;
    this.#unsubscribeNotification ??= this.#rpc.onNotification((notification) => {
      this.handleNotification(notification);
    });
    this.#unsubscribeExit ??= this.#rpc.onExit((exit) => this.handleExit(exit));
    return await this.serialize(async () => {
      this.updateStatus({ state: "reloading", lastError: null, restartRequired: false });
      return await this.reconcile({
        hotReloadConfig: false,
        reloadMcp: false,
        freshServer: true,
      });
    });
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    await this.serialize(async () => {});
    this.#unsubscribeNotification?.();
    this.#unsubscribeNotification = undefined;
    this.#unsubscribeExit?.();
    this.#unsubscribeExit = undefined;
  }

  public status(): CodexRuntimeStatus {
    return this.#status;
  }

  public settings(): EffectiveCodexSettings {
    return this.#settings;
  }

  public skills(): readonly AvailableSkill[] {
    return [...this.#skills.values()]
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async usageLimits(): Promise<CodexUsageLimits> {
    const response = await this.#rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read",
      params: undefined,
    });
    return usageLimitsFromSnapshot(response.rateLimits, response.rateLimitResetCredits ?? null);
  }

  public async applyBankedReset(
    creditId: string,
    idempotencyKey: string,
  ): Promise<ApplyBankedResetOutcome> {
    const response = await this.#rpc.request<ConsumeAccountRateLimitResetCreditResponse>({
      method: "account/rateLimitResetCredit/consume",
      params: {
        creditId,
        idempotencyKey,
      } satisfies ConsumeAccountRateLimitResetCreditParams,
    });
    return response.outcome;
  }

  public async browseSkill(name: string, path: string): Promise<SkillResource> {
    const skill = this.#skills.get(name);
    if (skill === undefined) {
      throw new BridgeError("This skill is not available to Codex.", "SKILL_NOT_FOUND");
    }
    return await readSkillResource(skill.path, path);
  }

  public skillInputs(text: string): readonly ExplicitSkillInput[] {
    const pattern = this.#skillMentionPattern;
    if (pattern === undefined) return [];
    const inputs: ExplicitSkillInput[] = [];
    const included = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const mentioned = match[2];
      if (mentioned === undefined) continue;
      const skill = this.#skillsByLowerName.get(mentioned.toLowerCase());
      if (skill === undefined || included.has(skill.name)) continue;
      included.add(skill.name);
      inputs.push({ type: "skill", name: skill.name, path: skill.path });
    }
    return inputs;
  }

  public async reload(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "reloading", lastError: null });
      return await this.reconcile({
        hotReloadConfig: true,
        reloadMcp: true,
        freshServer: false,
      });
    });
  }

  public async afterConfigWrite(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "reloading", lastError: null });
      return await this.reconcile({
        hotReloadConfig: false,
        reloadMcp: true,
        freshServer: false,
      });
    });
  }

  public async restart(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "restarting", lastError: null, restartRequired: false });
      try {
        await this.readConfig();
      } catch (error) {
        if (!isCodexTransportUnavailable(error)) {
          this.updateStatus({
            state: "degraded",
            lastError: errorMessage(error),
            restartRequired: false,
          });
          return this.status();
        }
      }

      this.#codex.pause();
      let resumeTurns = true;
      try {
        await this.#codex.waitForIdle();
        await this.#rpc.stop();
        resumeTurns = false;
        await this.#rpc.start();
        resumeTurns = true;
        this.#serverModelProvider = undefined;
        return await this.reconcile({
          hotReloadConfig: false,
          reloadMcp: false,
          freshServer: true,
        });
      } catch (error) {
        this.#logger.error("Could not restart the Codex app-server", error);
        this.updateStatus({
          state: "degraded",
          lastError: errorMessage(error),
          restartRequired: !resumeTurns,
        });
        return this.status();
      } finally {
        if (resumeTurns) this.#codex.resume();
      }
    });
  }

  private async reconcile(options: ReconcileOptions): Promise<CodexRuntimeStatus> {
    const errors: string[] = [];
    let restartRequired = options.freshServer ? false : this.#status.restartRequired;
    try {
      let response = await this.readConfig();
      if (options.hotReloadConfig) {
        const userLayer = findBaseUserLayer(response.layers);
        const params: ConfigBatchWriteParams = {
          edits: [],
          reloadUserConfig: true,
          ...(userLayer === undefined
            ? {}
            : { filePath: userLayer.name.file, expectedVersion: userLayer.version }),
        };
        await this.#rpc.request<unknown>({ method: "config/batchWrite", params });
        response = await this.readConfig();
      }
      const nextSettings = settingsFromConfig(response.config);
      const nextProvider = response.config.model_provider;
      if (options.freshServer || this.#serverModelProvider === undefined) {
        this.#serverModelProvider = nextProvider;
        restartRequired = false;
      } else {
        restartRequired = nextProvider !== this.#serverModelProvider;
      }
      this.#settings = nextSettings;
      this.#configService.invalidateCapabilities();
      this.updateStatus({
        configPath: findBaseUserLayer(response.layers)?.name.file ?? null,
      });
    } catch (error) {
      errors.push(errorMessage(error));
      if (isCodexTransportUnavailable(error)) restartRequired = true;
    }

    if (options.reloadMcp) {
      try {
        await this.#rpc.request<unknown>({ method: "config/mcpServer/reload", params: undefined });
      } catch (error) {
        errors.push(errorMessage(error));
        if (isCodexTransportUnavailable(error)) restartRequired = true;
      }
    }

    const skillError = await this.refreshSkills();
    if (skillError !== undefined) errors.push(skillError);

    this.updateStatus({
      state: errors.length === 0 ? "ready" : "degraded",
      lastAppliedAt:
        errors.length === 0 && !restartRequired
          ? new Date().toISOString()
          : this.#status.lastAppliedAt,
      lastError: errors[0] ?? null,
      restartRequired,
    });
    return this.status();
  }

  private async refreshSkills(): Promise<string | undefined> {
    try {
      const response = await this.#rpc.request<SkillsListResponse>({
        method: "skills/list",
        params: { cwds: [this.#workspace], forceReload: true },
      });
      const entry =
        response.data.find((candidate) => candidate.cwd === this.#workspace) ?? response.data[0];
      this.#skills.clear();
      for (const skill of entry?.skills ?? []) {
        if (skill.enabled) this.#skills.set(skill.name, skill);
      }
      this.rebuildSkillMatcher();
      const errors = entry?.errors ?? [];
      if (errors.length > 0) {
        return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
      }
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** Precompute the skill-mention lookup and pattern; they change only when skills do. */
  private rebuildSkillMatcher(): void {
    this.#skillsByLowerName = new Map(
      [...this.#skills.values()].map((skill) => [skill.name.toLowerCase(), skill] as const),
    );
    if (this.#skills.size === 0) {
      this.#skillMentionPattern = undefined;
      return;
    }
    const alternatives = [...this.#skills.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    this.#skillMentionPattern = new RegExp(
      `(^|[^A-Za-z0-9_])\\$(${alternatives})(?=$|[^A-Za-z0-9_:-])`,
      "gi",
    );
  }

  private async readConfig(): Promise<ConfigReadResponse> {
    return await this.#rpc.request<ConfigReadResponse>({
      method: "config/read",
      params: { includeLayers: true, cwd: this.#workspace },
    });
  }

  private handleNotification(notification: ServerNotification): void {
    if (notification.method === "skills/changed" && !this.#stopped) {
      void this.refreshSkillsAfterChange();
    }
  }

  private async refreshSkillsAfterChange(): Promise<void> {
    await this.serialize(async () => {
      const error = await this.refreshSkills();
      this.updateStatus({
        state: error === undefined ? "ready" : "degraded",
        lastAppliedAt:
          error === undefined && !this.#status.restartRequired
            ? new Date().toISOString()
            : this.#status.lastAppliedAt,
        lastError: error ?? null,
      });
    });
  }

  private handleExit(exit: CodexAppServerExit): void {
    if (exit.expected && this.#status.state === "restarting") return;
    this.updateStatus({
      state: "degraded",
      lastError: exit.error.message,
      restartRequired: true,
    });
  }

  private updateStatus(patch: Partial<CodexRuntimeStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#operations.run("runtime", operation);
  }
}

function usageLimitsFromSnapshot(
  snapshot: RateLimitSnapshot,
  resetCredits: RateLimitResetCreditsSummary | null,
): CodexUsageLimits {
  let weekly: CodexUsageLimitWindow | null = null;
  let fiveHour: CodexUsageLimitWindow | null = null;
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (window?.windowDurationMins === 7 * 24 * 60 && weekly === null) {
      weekly = usageLimitWindow(window);
    }
    if (window?.windowDurationMins === 5 * 60 && fiveHour === null) {
      fiveHour = usageLimitWindow(window);
    }
  }
  return { weekly, fiveHour, bankedResets: bankedResets(resetCredits) };
}

function usageLimitWindow(window: RateLimitWindow): CodexUsageLimitWindow {
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetsAt: window.resetsAt,
  };
}

function bankedResets(summary: RateLimitResetCreditsSummary | null): CodexBankedResets | null {
  if (summary === null) return null;
  return {
    availableCount: Math.max(0, Number(summary.availableCount)),
    credits: summary.credits?.map(bankedReset) ?? null,
  };
}

function bankedReset(credit: RateLimitResetCredit): CodexBankedReset {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: credit.grantedAt,
    expiresAt: credit.expiresAt ?? null,
    title: credit.title ?? null,
    description: credit.description ?? null,
  };
}

function settingsFromConfig(config: Config): EffectiveCodexSettings {
  const personality = isPersonality(config.personality) ? config.personality : null;
  return {
    thread: {
      model: config.model,
      modelProvider: config.model_provider,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      approvalsReviewer: config.approvals_reviewer,
      sandbox: config.sandbox_mode,
      baseInstructions: config.instructions,
      developerInstructions: config.developer_instructions,
      personality,
    },
    turn: {
      model: config.model,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      approvalsReviewer: config.approvals_reviewer,
      effort: config.model_reasoning_effort,
      summary: config.model_reasoning_summary,
      personality,
    },
  };
}

function isPersonality(value: unknown): value is Personality {
  return value === "none" || value === "friendly" || value === "pragmatic";
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
