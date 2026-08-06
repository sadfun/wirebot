import type {
  ChoiceOption,
  InboundAttachment,
  MessageResponder,
  OutboundAttachment,
  ProviderReference,
} from "../core/channel.js";
import type { ConversationStore } from "../core/conversation-store.js";
import type { RequestId } from "../generated/codex/RequestId.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ServerRequest } from "../generated/codex/ServerRequest.js";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import type { AccountLoginCompletedNotification } from "../generated/codex/v2/AccountLoginCompletedNotification.js";
import type { ChatgptAuthTokensRefreshParams } from "../generated/codex/v2/ChatgptAuthTokensRefreshParams.js";
import type { ChatgptAuthTokensRefreshResponse } from "../generated/codex/v2/ChatgptAuthTokensRefreshResponse.js";
import type { CommandExecutionRequestApprovalResponse } from "../generated/codex/v2/CommandExecutionRequestApprovalResponse.js";
import type { DynamicToolCallParams } from "../generated/codex/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "../generated/codex/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "../generated/codex/v2/DynamicToolSpec.js";
import type { FileChangeRequestApprovalResponse } from "../generated/codex/v2/FileChangeRequestApprovalResponse.js";
import type { GetAccountResponse } from "../generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../generated/codex/v2/LoginAccountResponse.js";
import type { PermissionsRequestApprovalResponse } from "../generated/codex/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadCompactStartResponse } from "../generated/codex/v2/ThreadCompactStartResponse.js";
import type { ThreadResumeResponse } from "../generated/codex/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../generated/codex/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../generated/codex/v2/ThreadStartResponse.js";
import type { ToolRequestUserInputAnswer } from "../generated/codex/v2/ToolRequestUserInputAnswer.js";
import type { ToolRequestUserInputResponse } from "../generated/codex/v2/ToolRequestUserInputResponse.js";
import type { TurnStartParams } from "../generated/codex/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../generated/codex/v2/TurnStartResponse.js";
import type { UserInput } from "../generated/codex/v2/UserInput.js";
import { type Deferred, deferred, KeyedSerialQueue } from "../shared/async.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { VoiceTranscriber } from "../transcription/service.js";
import {
  type ApplicationContext,
  type CodexAppServer,
  isCodexTransportUnavailable,
} from "./rpc.js";
import {
  type FinalizedTurn,
  silentStream,
  ThreadSession,
  type ThreadSessionContext,
  type TurnPresentation,
} from "./thread-session.js";

export interface CodexInvocationContext {
  readonly owner?: ProviderReference;
  readonly deliveryTarget?: ProviderReference;
  readonly additionalContext?: ApplicationContext;
  readonly automationId?: string;
}

export interface CodexDynamicToolContext extends CodexInvocationContext {
  readonly conversationKey: string;
  readonly connector: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

export interface CodexDynamicTool {
  readonly spec: DynamicToolSpec & { readonly type: "function" };
  execute(argumentsValue: JsonValue, context: CodexDynamicToolContext): Promise<unknown>;
}

export interface ScheduledTurnRequest {
  readonly conversationKey: string;
  readonly connector: string;
  readonly prompt: string;
  readonly thread:
    | { readonly mode: "new"; readonly developerInstructions?: string }
    | { readonly mode: "existing"; readonly threadId: string };
  readonly invocation: CodexInvocationContext;
  readonly model?: string;
  readonly reasoningEffort?: CodexTurnSettings["effort"];
  readonly outputSchema?: JsonValue;
}

export interface CodexTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  /** Unmodified final assistant text, before delivery-specific warnings. */
  readonly rawText: string;
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailableAttachments: readonly string[];
  dispose(): Promise<void>;
}

type BackgroundLeaseDecision =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly reason: string; readonly retryAt: Date };

interface StartTurnRequest extends TurnPresentation {
  readonly input: readonly UserInput[];
  readonly turnSettings: CodexTurnSettings;
  readonly outputSchema?: JsonValue;
  /** Called once the turn exists in Codex and its rendering is session-owned. */
  readonly onStarted?: () => void;
}

interface StartCompactionRequest extends TurnPresentation {
  /** Called once the compaction turn exists and its rendering is session-owned. */
  readonly onStarted?: () => void;
}

type LoginCompletedListener = (notification: AccountLoginCompletedNotification) => void;

type CodexThreadSettings = Readonly<
  Pick<
    ThreadStartParams,
    | "model"
    | "modelProvider"
    | "serviceTier"
    | "approvalPolicy"
    | "approvalsReviewer"
    | "sandbox"
    | "config"
    | "baseInstructions"
    | "developerInstructions"
    | "personality"
  >
>;

type CodexTurnSettings = Readonly<
  Pick<
    TurnStartParams,
    | "approvalPolicy"
    | "approvalsReviewer"
    | "sandboxPolicy"
    | "model"
    | "serviceTier"
    | "effort"
    | "summary"
    | "personality"
  >
>;

export interface EffectiveCodexSettings {
  readonly thread?: CodexThreadSettings;
  readonly turn?: CodexTurnSettings;
}

export type ExplicitSkillInput = Extract<UserInput, { readonly type: "skill" }>;
type EffectiveCodexSettingsProvider = () =>
  | EffectiveCodexSettings
  | Promise<EffectiveCodexSettings>;
type ExplicitSkillInputProvider = (
  text: string,
) => readonly ExplicitSkillInput[] | Promise<readonly ExplicitSkillInput[]>;

export interface CodexServiceProviders {
  readonly effectiveSettings?: EffectiveCodexSettingsProvider;
  readonly explicitSkillInputs?: ExplicitSkillInputProvider;
  /** Static deployment-environment context added to every turn (e.g. the container persistence contract). */
  readonly environmentContext?: ApplicationContext;
  readonly externalAuthTokens?: (
    request: ChatgptAuthTokensRefreshParams,
  ) => Promise<ChatgptAuthTokensRefreshResponse>;
  readonly now?: () => number;
  /** Passive lifecycle observer for test harnesses. */
  readonly onTurnStarting?: (threadId: string, conversationKey: string) => void;
}

export class CodexService {
  static readonly #backgroundQuietPeriodMs = 30_000;
  readonly #queue = new KeyedSerialQueue();
  readonly #sessions = new Map<string, ThreadSession>();
  readonly #conversationSessions = new Map<string, ThreadSession>();
  readonly #dynamicTools = new Map<string, CodexDynamicTool>();
  readonly #foregroundWaiting = new Map<string, number>();
  readonly #lastForegroundAt = new Map<string, number>();
  readonly #loginListeners = new Set<LoginCompletedListener>();
  readonly #rpc: CodexAppServer;
  readonly #conversations: ConversationStore;
  readonly #workspace: string;
  readonly #logger: Logger;
  readonly #sessionContext: ThreadSessionContext;
  readonly #voiceTranscriber: VoiceTranscriber | undefined;
  readonly #remoteClientContextEnabled: () => boolean;
  readonly #effectiveSettings: EffectiveCodexSettingsProvider;
  readonly #explicitSkillInputs: ExplicitSkillInputProvider;
  readonly #environmentContext: ApplicationContext | undefined;
  readonly #externalAuthTokens: CodexServiceProviders["externalAuthTokens"];
  readonly #now: () => number;
  readonly #onTurnStarting: CodexServiceProviders["onTurnStarting"];
  #pauseGate: Deferred<void> | undefined;
  #idleGate: Deferred<void> | undefined;
  #interruptingScheduledTurns = false;
  #runningJobs = 0;

  public constructor(
    rpc: CodexAppServer,
    conversations: ConversationStore,
    workspace: string,
    generatedImagesDirectory: string,
    outboundDirectory: string,
    logger: Logger,
    voiceTranscriber?: VoiceTranscriber,
    remoteClientContextEnabled: () => boolean = () => true,
    providers: CodexServiceProviders = {},
  ) {
    this.#rpc = rpc;
    this.#conversations = conversations;
    this.#workspace = workspace;
    this.#logger = logger;
    this.#sessionContext = {
      rpc,
      logger,
      workspace,
      generatedImagesDirectory,
      outboundDirectory,
    };
    this.#voiceTranscriber = voiceTranscriber;
    this.#remoteClientContextEnabled = remoteClientContextEnabled;
    this.#effectiveSettings = providers.effectiveSettings ?? (() => ({}));
    this.#explicitSkillInputs = providers.explicitSkillInputs ?? (() => []);
    this.#environmentContext = providers.environmentContext;
    this.#externalAuthTokens = providers.externalAuthTokens;
    this.#now = providers.now ?? Date.now;
    this.#onTurnStarting = providers.onTurnStarting;
    rpc.onNotification((notification) => this.handleNotification(notification));
    rpc.onExit((exit) => this.handleTransportExit(exit.error));
    rpc.setServerRequestHandler(async (request) => await this.handleServerRequest(request));
  }

  public pause(): void {
    this.#pauseGate ??= deferred<void>();
  }

  public async waitForIdle(): Promise<void> {
    if (this.#runningJobs === 0) return;
    this.#idleGate ??= deferred<void>();
    await this.#idleGate.promise;
  }

  public resume(): void {
    const gate = this.#pauseGate;
    if (gate === undefined) return;
    this.#pauseGate = undefined;
    gate.resolve();
  }

  public registerDynamicTool(tool: CodexDynamicTool): void {
    if (this.#dynamicTools.has(tool.spec.name)) {
      throw new Error(`Dynamic tool ${tool.spec.name} is already registered`);
    }
    this.#dynamicTools.set(tool.spec.name, tool);
  }

  public tryAcquireBackground(conversationKey: string): BackgroundLeaseDecision {
    const now = this.#now();
    const retryAt = new Date(now + CodexService.#backgroundQuietPeriodMs);
    if ((this.#foregroundWaiting.get(conversationKey) ?? 0) > 0) {
      return { acquired: false, reason: "A user message is waiting.", retryAt };
    }
    const lastForegroundAt = this.#lastForegroundAt.get(conversationKey);
    if (
      lastForegroundAt !== undefined &&
      now - lastForegroundAt < CodexService.#backgroundQuietPeriodMs
    ) {
      return {
        acquired: false,
        reason: "The conversation was used recently.",
        retryAt: new Date(lastForegroundAt + CodexService.#backgroundQuietPeriodMs),
      };
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) {
      return { acquired: false, reason: "The conversation is busy.", retryAt };
    }
    return { acquired: true, release: lease.release };
  }

  public async runTurn(
    conversationKey: string,
    connector: string,
    text: string,
    responder: MessageResponder,
    ephemeral = false,
    attachments: readonly InboundAttachment[] = [],
    invocation: CodexInvocationContext = {},
    syntheticText = false,
  ): Promise<void> {
    const stream = responder.createStream();
    const voiceAttachments = attachments.filter((attachment) => attachment.kind === "voice");
    const shouldTranscribe = voiceAttachments.length > 0 && this.#voiceTranscriber !== undefined;
    this.incrementForegroundWaiting(conversationKey);
    let dequeued = false;
    try {
      const startsQueued = this.#queue.isBusy(conversationKey);
      let preparedText: Promise<string> | undefined;
      if (shouldTranscribe) {
        await stream.start({ summary: "Transcribing…", actions: [], plan: [] });
        preparedText = this.transcribeVoiceMessages(text, syntheticText, voiceAttachments).then(
          (prepared) => {
            stream.setProgress({ summary: "Thinking…", actions: [], plan: [] });
            return prepared;
          },
        );
        void preparedText.catch(() => undefined);
      } else if (startsQueued) {
        await stream.start({ summary: "Queued behind earlier work…", actions: [], plan: [] });
      }

      await this.#queue.run(conversationKey, async () => {
        dequeued = true;
        this.decrementForegroundWaiting(conversationKey);
        await this.enterJob();
        let started = false;
        try {
          if (!shouldTranscribe) {
            if (startsQueued) {
              stream.setProgress({ summary: "Thinking…", actions: [], plan: [] });
            } else {
              await stream.start();
            }
          }
          const prepared = preparedText === undefined ? text : await preparedText;
          this.#logger.debug("Preparing Codex turn", { conversationKey, connector });
          const [settings, skillInputs] = await Promise.all([
            this.#effectiveSettings(),
            this.#explicitSkillInputs(prepared),
          ]);
          const threadId = await this.ensureThread(
            conversationKey,
            connector,
            ephemeral,
            settings.thread ?? {},
          );
          const session = this.requireSession(threadId);
          this.#conversationSessions.set(conversationKey, session);
          session.adoptPresenter(conversationKey, connector, responder, invocation);
          this.#logger.debug("Starting Codex turn", { conversationKey, threadId });
          const finalized = await this.startTurn(session, {
            origin: "user",
            stream,
            responder,
            invocation,
            conversationKey,
            connector,
            input: [...createTurnInput(prepared, connector, attachments), ...skillInputs],
            turnSettings: settings.turn ?? {},
            onStarted: () => {
              started = true;
            },
          });
          this.#logger.debug("Codex turn finalized", {
            conversationKey,
            turnId: finalized.turn.id,
            status: finalized.turn.status,
            finalTextLength: finalized.finalText.length,
          });
          if (finalized.turn.status === "failed") {
            this.#logger.warn("Codex turn failed", {
              conversationKey,
              turnId: finalized.turn.id,
              error: finalized.turn.error?.message,
            });
          }
        } catch (error) {
          this.#logger.error("Codex turn failed", error, { conversationKey });
          // Once a turn started, its session owns the stream, including failure.
          if (!started) await stream.fail(errorMessage(error));
        } finally {
          this.#lastForegroundAt.set(conversationKey, this.#now());
          this.leaveJob();
        }
      });
    } finally {
      if (!dequeued) this.decrementForegroundWaiting(conversationKey);
    }
  }

  public async runScheduledTurn(request: ScheduledTurnRequest): Promise<CodexTurnResult> {
    await this.enterJob();
    try {
      const [settings, skillInputs] = await Promise.all([
        this.#effectiveSettings(),
        this.#explicitSkillInputs(request.prompt),
      ]);
      const threadId =
        request.thread.mode === "new"
          ? await this.startThread(
              {
                ...(settings.thread ?? {}),
                ...(request.model === undefined ? {} : { model: request.model }),
                ...(request.thread.developerInstructions === undefined
                  ? {}
                  : { developerInstructions: request.thread.developerInstructions }),
              },
              "automation",
              false,
              request.conversationKey,
              request.connector,
            )
          : await this.resumeThreadStrict(
              request.thread.threadId,
              settings.thread ?? {},
              request.conversationKey,
              request.connector,
            );
      const session = this.requireSession(threadId);
      this.#conversationSessions.set(request.conversationKey, session);
      session.adoptPresenter(
        request.conversationKey,
        request.connector,
        undefined,
        request.invocation,
      );
      const finalized = await this.startTurn(session, {
        origin: "scheduled",
        stream: silentStream,
        responder: undefined,
        invocation: request.invocation,
        conversationKey: request.conversationKey,
        connector: request.connector,
        input: [...createTurnInput(request.prompt, request.connector, []), ...skillInputs],
        turnSettings: {
          ...(settings.turn ?? {}),
          approvalPolicy: "never",
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
        },
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
      const turn = finalized.turn;
      if (turn.status === "failed") {
        throw new BridgeError(turn.error?.message ?? "Codex turn failed", "CODEX_TURN_FAILED");
      }
      if (turn.status === "interrupted") {
        await finalized.dispose();
        throw new BridgeError("Scheduled Codex turn was interrupted", "CODEX_TURN_INTERRUPTED");
      }
      return {
        threadId,
        turnId: turn.id,
        rawText: finalized.finalText,
        attachments: finalized.attachments,
        unavailableAttachments: finalized.unavailableAttachments,
        dispose: finalized.dispose,
      };
    } finally {
      this.leaveJob();
    }
  }

  /**
   * Start a turn and follow it to its `turn/completed` notification. The
   * turn/start response and the turn/started notification race by design;
   * the session binds the presentation to whichever announcement wins.
   */
  private async startTurn(
    session: ThreadSession,
    request: StartTurnRequest,
  ): Promise<FinalizedTurn> {
    this.#onTurnStarting?.(session.threadId, request.conversationKey);
    const additionalContext = this.additionalContext(request.connector, request.invocation);
    const pending = session.expectTurn(request);
    let response: TurnStartResponse;
    try {
      response = await this.#rpc.request<TurnStartResponse>({
        method: "turn/start",
        params: {
          ...request.turnSettings,
          threadId: session.threadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [...request.input],
          ...(Object.keys(additionalContext).length === 0 ? {} : { additionalContext }),
          ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        },
      });
    } catch (error) {
      const view = pending.cancel();
      if (view === undefined) throw error;
      request.onStarted?.();
      return await view.terminal.promise;
    }
    const view = pending.claim(response.turn.id);
    request.onStarted?.();
    if (this.#interruptingScheduledTurns && request.invocation.automationId !== undefined) {
      await session.interruptTurn(view);
    }
    return await view.terminal.promise;
  }

  /** Start a native compaction turn, whose empty RPC response has no turn ID. */
  private async startCompaction(
    session: ThreadSession,
    request: StartCompactionRequest,
  ): Promise<FinalizedTurn> {
    this.#onTurnStarting?.(session.threadId, request.conversationKey);
    const pending = session.expectTurn(request);
    try {
      await this.#rpc.request<ThreadCompactStartResponse>({
        method: "thread/compact/start",
        params: { threadId: session.threadId },
      });
    } catch (error) {
      const view = pending.cancel();
      if (view === undefined) throw error;
      request.onStarted?.();
      return await view.terminal.promise;
    }
    const view = await pending.waitForClaim();
    request.onStarted?.();
    return await view.terminal.promise;
  }

  private async transcribeVoiceMessages(
    text: string,
    syntheticText: boolean,
    attachments: readonly InboundAttachment[],
  ): Promise<string> {
    const transcriber = this.#voiceTranscriber;
    if (transcriber === undefined) return text;
    let transcripts: readonly string[];
    try {
      transcripts = await Promise.all(
        attachments.map(async (attachment) => await transcriber.transcribe(attachment.path)),
      );
    } catch (error) {
      // A deployment without the transcription transport forwards the voice
      // message untranscribed; other failures (auth, HTTP) surface to the user.
      if (!(error instanceof BridgeError) || error.code !== "TRANSCRIPTION_UNAVAILABLE") {
        throw error;
      }
      this.#logger.info(
        "Voice transcription is unavailable; forwarding the voice message untranscribed",
      );
      return text;
    }
    const base = syntheticText ? "" : text.trim();
    const blocks = transcripts.map((transcript, index) => {
      const heading =
        transcripts.length === 1
          ? "Voice message transcript:"
          : `Voice message transcript ${index + 1}:`;
      return `${heading}\n${transcript}`;
    });
    return [base, ...blocks].filter((part) => part.length > 0).join("\n\n");
  }

  public async resetConversation(conversationKey: string): Promise<void> {
    await this.interrupt(conversationKey);
    await this.#conversations.delete(conversationKey);
  }

  public async compactConversation(
    conversationKey: string,
    connector: string,
    responder: MessageResponder,
    invocation: CodexInvocationContext = {},
  ): Promise<boolean> {
    const storedThread = this.#conversations.get(conversationKey);
    if (storedThread === undefined) return false;
    if (
      this.#conversationSessions.get(conversationKey)?.busy === true ||
      (this.#foregroundWaiting.get(conversationKey) ?? 0) > 0
    ) {
      throw conversationBusyError();
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) throw conversationBusyError();
    try {
      await this.enterJob();
      try {
        const settings = await this.#effectiveSettings();
        const threadId = await this.resumeThreadStrict(
          storedThread,
          settings.thread ?? {},
          conversationKey,
          connector,
        );
        const session = this.requireSession(threadId);
        if (session.busy) throw conversationBusyError();
        this.#conversationSessions.set(conversationKey, session);
        session.adoptPresenter(conversationKey, connector, responder, invocation);
        const stream = responder.createStream();
        let started = false;
        try {
          await stream.start({ summary: "Compacting context…", actions: [], plan: [] });
          const finalized = await this.startCompaction(session, {
            origin: "user",
            stream,
            responder,
            invocation,
            conversationKey,
            connector,
            onStarted: () => {
              started = true;
            },
          });
          this.#logger.debug("Codex context compaction finalized", {
            conversationKey,
            turnId: finalized.turn.id,
            status: finalized.turn.status,
          });
          if (finalized.turn.status === "failed") {
            this.#logger.warn("Codex context compaction failed", {
              conversationKey,
              turnId: finalized.turn.id,
              error: finalized.turn.error?.message,
            });
          }
        } catch (error) {
          this.#logger.error("Codex context compaction failed", error, { conversationKey });
          // Once a turn started, its session owns the stream, including failure.
          if (!started) await stream.fail(errorMessage(error));
        }
        return true;
      } finally {
        this.#lastForegroundAt.set(conversationKey, this.#now());
        this.leaveJob();
      }
    } finally {
      lease.release();
    }
  }

  public async activateConversationThread(
    conversationKey: string,
    connector: string,
    threadId: string,
  ): Promise<boolean> {
    if (
      this.#conversationSessions.get(conversationKey)?.busy === true ||
      (this.#foregroundWaiting.get(conversationKey) ?? 0) > 0
    ) {
      throw conversationBusyError();
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) throw conversationBusyError();
    try {
      const settings = await this.#effectiveSettings();
      const resumedThreadId = await this.resumeThreadStrict(
        threadId,
        settings.thread ?? {},
        conversationKey,
        connector,
      );
      return await this.#conversations.switchTo(conversationKey, resumedThreadId);
    } finally {
      lease.release();
    }
  }

  public async activatePreviousConversationThread(
    conversationKey: string,
    connector: string,
  ): Promise<string | undefined> {
    const previous = this.#conversations.previous(conversationKey);
    if (previous === undefined) return undefined;
    await this.activateConversationThread(conversationKey, connector, previous);
    return previous;
  }

  public async interrupt(conversationKey: string): Promise<boolean> {
    const sessions = new Set<ThreadSession>();
    const bound = this.#conversationSessions.get(conversationKey);
    if (bound !== undefined) sessions.add(bound);
    const storedThread = this.#conversations.get(conversationKey);
    const stored = storedThread === undefined ? undefined : this.#sessions.get(storedThread);
    if (stored !== undefined) sessions.add(stored);
    let interrupted = false;
    for (const session of sessions) {
      interrupted = (await session.interruptRunning()) || interrupted;
    }
    return interrupted;
  }

  public async interruptScheduledTurns(): Promise<void> {
    this.#interruptingScheduledTurns = true;
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await session.interruptMatching((view) => view.invocation.automationId !== undefined);
      }),
    );
  }

  public async account(): Promise<GetAccountResponse> {
    return await this.#rpc.request<GetAccountResponse>({
      method: "account/read",
      params: { refreshToken: false },
    });
  }

  public async startDeviceLogin(): Promise<LoginAccountResponse> {
    return await this.#rpc.request<LoginAccountResponse>({
      method: "account/login/start",
      params: { type: "chatgptDeviceCode" },
    });
  }

  public async loginWithApiKey(apiKey: string): Promise<void> {
    await this.#rpc.request<LoginAccountResponse>({
      method: "account/login/start",
      params: { type: "apiKey", apiKey },
    });
  }

  public async loginWithChatgptTokens(
    accessToken: string,
    chatgptAccountId: string,
  ): Promise<void> {
    await this.#rpc.request<LoginAccountResponse>({
      method: "account/login/start",
      params: { type: "chatgptAuthTokens", accessToken, chatgptAccountId },
    });
  }

  public async logout(): Promise<void> {
    await this.#rpc.request<unknown>({ method: "account/logout", params: undefined });
  }

  public onLoginCompleted(listener: LoginCompletedListener): void {
    this.#loginListeners.add(listener);
  }

  private async ensureThread(
    conversationKey: string,
    connector: string,
    ephemeral: boolean,
    settings: CodexThreadSettings,
  ): Promise<string> {
    if (!ephemeral) {
      const stored = this.#conversations.get(conversationKey);
      if (stored !== undefined) {
        try {
          return await this.resumeThreadStrict(stored, settings, conversationKey, connector);
        } catch (error) {
          if (isCodexTransportUnavailable(error)) throw error;
          this.#logger.warn("Stored Codex thread could not be resumed; starting a new thread", {
            conversationKey,
            error: errorMessage(error),
          });
          await this.#conversations.delete(conversationKey);
        }
      }
    }

    const threadId = await this.startThread(
      settings,
      "wirebot",
      ephemeral,
      conversationKey,
      connector,
    );
    if (!ephemeral) await this.#conversations.set(conversationKey, threadId);
    return threadId;
  }

  private async startThread(
    settings: CodexThreadSettings,
    threadSource: string,
    ephemeral: boolean,
    conversationKey: string,
    connector: string,
  ): Promise<string> {
    const started = await this.#rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        ...settings,
        cwd: this.#workspace,
        ephemeral,
        serviceName: "wirebot",
        threadSource,
        dynamicTools: [...this.#dynamicTools.values()].map((tool) => tool.spec),
      },
    });
    this.openSession(started.thread.id, conversationKey, connector);
    return started.thread.id;
  }

  private async resumeThreadStrict(
    threadId: string,
    settings: CodexThreadSettings,
    conversationKey: string,
    connector: string,
  ): Promise<string> {
    if (this.#sessions.has(threadId)) return threadId;
    const resumed = await this.#rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: { ...settings, threadId, cwd: this.#workspace },
    });
    this.openSession(resumed.thread.id, conversationKey, connector);
    return resumed.thread.id;
  }

  private openSession(threadId: string, conversationKey: string, connector: string): void {
    if (this.#sessions.has(threadId)) return;
    this.#sessions.set(
      threadId,
      new ThreadSession(threadId, conversationKey, connector, this.#sessionContext),
    );
  }

  private requireSession(threadId: string): ThreadSession {
    const session = this.#sessions.get(threadId);
    if (session === undefined) {
      throw new BridgeError(`Codex thread ${threadId} is not loaded`, "CODEX_THREAD_NOT_LOADED");
    }
    return session;
  }

  private additionalContext(
    connector: string,
    invocation: CodexInvocationContext,
  ): ApplicationContext {
    return {
      ...(this.#remoteClientContextEnabled() ? createRemoteClientContext(connector) : {}),
      ...(this.#environmentContext ?? {}),
      ...(invocation.additionalContext ?? {}),
    };
  }

  private incrementForegroundWaiting(conversationKey: string): void {
    this.#foregroundWaiting.set(
      conversationKey,
      (this.#foregroundWaiting.get(conversationKey) ?? 0) + 1,
    );
  }

  private decrementForegroundWaiting(conversationKey: string): void {
    const waiting = (this.#foregroundWaiting.get(conversationKey) ?? 1) - 1;
    if (waiting <= 0) this.#foregroundWaiting.delete(conversationKey);
    else this.#foregroundWaiting.set(conversationKey, waiting);
  }

  private async enterJob(): Promise<void> {
    while (this.#pauseGate !== undefined) await this.#pauseGate.promise;
    this.#runningJobs += 1;
  }

  private leaveJob(): void {
    this.#runningJobs -= 1;
    if (this.#runningJobs !== 0) return;
    const gate = this.#idleGate;
    this.#idleGate = undefined;
    gate?.resolve();
  }

  private handleTransportExit(error: BridgeError): void {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#conversationSessions.clear();
    for (const session of sessions) session.fail(error);
  }

  private handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "account/login/completed":
        this.handleLoginCompleted(notification.params);
        return;
      case "error":
        this.#logger.warn("Codex reported an error notification", {
          codexMessage: notification.params.error.message,
        });
        return;
      case "configWarning":
        this.#logger.warn("Codex reported a config warning", {
          summary: notification.params.summary,
          path: notification.params.path,
        });
        return;
      default: {
        const threadId = notificationThreadId(notification);
        if (threadId !== undefined) this.#sessions.get(threadId)?.handleNotification(notification);
        return;
      }
    }
  }

  private handleLoginCompleted(notification: AccountLoginCompletedNotification): void {
    this.#logger.info("Codex account login completed", {
      success: notification.success,
      error: notification.error,
    });
    for (const listener of this.#loginListeners) {
      try {
        listener(notification);
      } catch (error) {
        this.#logger.error("Login completion listener failed", error);
      }
    }
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const choice = await this.askApproval(
          request.id,
          request.params.threadId,
          request.params.turnId,
          `Codex wants to run:\n\n${request.params.command ?? "(unknown command)"}${
            request.params.reason === undefined || request.params.reason === null
              ? ""
              : `\n\nReason: ${request.params.reason}`
          }`,
        );
        const response: CommandExecutionRequestApprovalResponse = {
          decision: approvalDecision(choice),
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/fileChange/requestApproval": {
        const choice = await this.askApproval(
          request.id,
          request.params.threadId,
          request.params.turnId,
          `Codex wants permission to change files${
            request.params.reason === undefined || request.params.reason === null
              ? "."
              : `:\n\n${request.params.reason}`
          }`,
        );
        const response: FileChangeRequestApprovalResponse = {
          decision: approvalDecision(choice),
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/permissions/requestApproval": {
        const choice = await this.askApproval(
          request.id,
          request.params.threadId,
          request.params.turnId,
          request.params.reason ?? "Codex is requesting additional permissions.",
        );
        const response: PermissionsRequestApprovalResponse = {
          permissions:
            choice === "decline"
              ? {}
              : {
                  ...(request.params.permissions.network === null
                    ? {}
                    : { network: request.params.permissions.network }),
                  ...(request.params.permissions.fileSystem === null
                    ? {}
                    : { fileSystem: request.params.permissions.fileSystem }),
                },
          scope: choice === "session" ? "session" : "turn",
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/tool/requestUserInput": {
        const session = this.#sessions.get(request.params.threadId);
        const responder = this.turnResponder(request.params.threadId, request.params.turnId);
        const signal = session?.beginServerRequest(request.id);
        const answers: Record<string, ToolRequestUserInputAnswer> = {};
        try {
          for (const question of request.params.questions) {
            if (
              responder === undefined ||
              question.options === null ||
              question.options.length === 0
            ) {
              answers[question.id] = { answers: [] };
              continue;
            }
            const options: ChoiceOption[] = question.options.map((option, index) => ({
              id: String(index),
              label: option.label,
              description: option.description,
            }));
            const answer = await responder.askChoice(question.question, options, signal);
            const selected = question.options[Number(answer)];
            answers[question.id] = { answers: selected === undefined ? [] : [selected.label] };
          }
        } finally {
          session?.endServerRequest(request.id);
        }
        const response: ToolRequestUserInputResponse = { answers };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/tool/call":
        await this.handleDynamicToolCall(request.params, request.id);
        break;
      case "account/chatgptAuthTokens/refresh": {
        const provider = this.#externalAuthTokens;
        if (provider === undefined) {
          await this.#rpc.replyError(request.id, -32_601, "External ChatGPT auth is unavailable");
          break;
        }
        await this.#rpc.reply(request.id, await provider(request.params));
        break;
      }
      default:
        await this.#rpc.replyError(request.id, -32_601, `Unsupported request: ${request.method}`);
    }
  }

  private async handleDynamicToolCall(
    params: DynamicToolCallParams,
    requestId: ServerRequest["id"],
  ): Promise<void> {
    const view = this.#sessions.get(params.threadId)?.view(params.turnId);
    if (view === undefined || params.namespace !== null) {
      await this.replyDynamicTool(requestId, false, "This tool call has no active Wirebot turn.");
      return;
    }
    const tool = this.#dynamicTools.get(params.tool);
    if (tool === undefined) {
      await this.replyDynamicTool(requestId, false, `Unknown dynamic tool: ${params.tool}`);
      return;
    }
    try {
      const result = await tool.execute(params.arguments, {
        ...view.invocation,
        conversationKey: view.conversationKey,
        connector: view.connector,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
      });
      await this.replyDynamicTool(requestId, true, JSON.stringify(result));
    } catch (error) {
      this.#logger.warn("Dynamic tool call failed", {
        tool: params.tool,
        error: errorMessage(error),
      });
      await this.replyDynamicTool(requestId, false, errorMessage(error));
    }
  }

  private async replyDynamicTool(
    requestId: ServerRequest["id"],
    success: boolean,
    text: string,
  ): Promise<void> {
    const response: DynamicToolCallResponse = {
      success,
      contentItems: [{ type: "inputText", text }],
    };
    await this.#rpc.reply(requestId, response);
  }

  private turnResponder(threadId: string, turnId: string): MessageResponder | undefined {
    const session = this.#sessions.get(threadId);
    if (session === undefined) return undefined;
    const view = session.view(turnId);
    // A known turn keeps its own presenter: scheduled turns intentionally
    // have none, so their approvals are declined rather than shown to a
    // user who is not attending the run.
    if (view !== undefined) return view.responder;
    return session.defaultResponder();
  }

  private async askApproval(
    requestId: RequestId,
    threadId: string,
    turnId: string,
    prompt: string,
  ): Promise<"once" | "session" | "decline"> {
    const session = this.#sessions.get(threadId);
    const responder = this.turnResponder(threadId, turnId);
    if (session === undefined || responder === undefined) return "decline";
    const signal = session.beginServerRequest(requestId);
    try {
      const answer = await responder.askChoice(
        prompt,
        [
          { id: "once", label: "Allow once" },
          { id: "session", label: "Allow for session" },
          { id: "decline", label: "Deny" },
        ],
        signal,
      );
      return answer === "once" || answer === "session" ? answer : "decline";
    } finally {
      session.endServerRequest(requestId);
    }
  }
}

function conversationBusyError(): BridgeError {
  return new BridgeError(
    "The conversation is busy. Stop or wait for the current turn first.",
    "CONVERSATION_BUSY",
  );
}

function approvalDecision(
  choice: "once" | "session" | "decline",
): "accept" | "acceptForSession" | "decline" {
  return choice === "session" ? "acceptForSession" : choice === "once" ? "accept" : "decline";
}

function notificationThreadId(notification: ServerNotification): string | undefined {
  const params: unknown = notification.params;
  if (typeof params !== "object" || params === null) return undefined;
  const threadId = (params as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function createTurnInput(
  text: string,
  connector: string,
  attachments: readonly InboundAttachment[],
): UserInput[] {
  const connectorName = connectorDisplayName(connector);
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  const fileContext = files
    .map((file) => `- ${file.description}: ${JSON.stringify(file.path)}`)
    .join("\n");
  const prompt =
    fileContext.length === 0
      ? text
      : `${text}\n\n${connectorName} files available in the local workspace:\n${fileContext}`;
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment): UserInput => ({ type: "localImage", path: attachment.path })),
  ];
}

function createRemoteClientContext(connector: string): ApplicationContext {
  const connectorName = connectorDisplayName(connector);
  return {
    "wirebot.remote-client": {
      kind: "application",
      value: `This Codex session is operated through Wirebot, a remote messaging bridge. The user reads and replies through ${connectorName} and is not present at the machine where Codex and its commands run.

Host-local UI is not visible or accessible to the user:
- Do not open browsers, GUI applications, editors, file managers, or OAuth pages as a way of handing work to the user.
- Never ask the user to visit localhost, 127.0.0.1, a file:// URL, or another host-local address. Those addresses refer to the Codex host, not the user's device.
- You may run and access local services yourself for development and testing. Only present a URL to the user when it is reachable from their device.
- For authentication, prefer a device-code flow or a publicly reachable HTTPS flow and send the URL and code through chat. If only a local callback exists, explain the constraint and offer a remote-safe alternative such as a device flow, tunnel, or SSH port forwarding.
- Do not assume the user can see the host screen, clipboard, notifications, or spawned windows.

File delivery:
- ${connectorName} can receive files as native attachments through Wirebot.
- When the user asks for a report, archive, image, or another local deliverable, save it inside the workspace and include a Markdown link to its workspace-relative path in the final response, for example \`[Download report](artifacts/report.pdf)\`. Wirebot resolves that link and uploads the file; do not use a file:// URL.
- Link only files deliberately intended for the user. Never attach secrets, credentials, environment files, authentication data, or unrelated workspace files.
- Codex-generated images are attached automatically, but still mention the delivered file in the final response.

When referencing code or files in replies:
- Except for deliberate attachment links described above, never format a local filesystem path as a Markdown link target; the user cannot open it. This includes workspace paths and home-relative paths.
- Refer to code with a repository-relative path and line number as inline code, for example \`src/app/main.ts:42\`.
- When you know the repository's public remote (for example on GitHub) and the relevant branch or commit, prefer a full https URL to the file and line so the reference is clickable in chat.

All normal Codex filesystem, shell, network, approval, and project behavior remains unchanged. Wirebot changes only how the user communicates with Codex.`,
    },
  };
}

/**
 * The persistence contract for the official Wirebot container image. The
 * paths listed here mirror the image layout in Dockerfile/entrypoint.sh —
 * update both together.
 */
export function createContainerEnvironmentContext(): ApplicationContext {
  return {
    "wirebot.environment": {
      kind: "application",
      value: `This session runs inside the Wirebot container, an Ubuntu-based image dedicated to this user. You have a normal Linux machine with passwordless sudo and common tools preinstalled (ffmpeg, git, python3, build tools, and more).

The operator updates Wirebot by replacing the container image, which resets the filesystem. Only these locations are persistent — they live on a mounted volume and survive every update:
- the Codex workspace and your home directory,
- /usr/local (a symlink into the volume) for manually installed software,
- /home/linuxbrew for a Homebrew installation, if one is set up.

Everything else resets on update. In particular, packages installed with apt disappear. Choose installation targets accordingly:
- apt-get is fine for one-off needs in the current session.
- When the user wants a tool to stay available, install it into /usr/local (static binaries, make install), the home directory (uv, pipx, cargo, npm prefix), or via Homebrew.
- Keep long-lived configuration (dotfiles, git config, SSH keys) in the home directory, where it persists.

There is no systemd in this container. Processes you start do not survive restarts; use Wirebot scheduled runs when something must be checked or re-established periodically.`,
    },
  };
}

function connectorDisplayName(connector: string): string {
  const words = connector
    .trim()
    .split(/[-_\s]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "a remote messaging connector";
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}
