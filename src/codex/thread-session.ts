import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  MessageResponder,
  OutboundAttachment,
  OutboundStream,
  ProgressAction,
  ProgressPlanStep,
  ProgressSnapshot,
} from "../core/channel.js";
import type { RequestId } from "../generated/codex/RequestId.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem.js";
import type { Turn } from "../generated/codex/v2/Turn.js";
import type { TurnInterruptResponse } from "../generated/codex/v2/TurnInterruptResponse.js";
import { type Deferred, deferred } from "../shared/async.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { generatedFilePaths, resolveOutboundAttachments } from "./output-files.js";
import { fileChangeActions, finalTextFromTurn, progressActions } from "./progress.js";
import type { CodexAppServer } from "./rpc.js";
import type { CodexInvocationContext } from "./service.js";

/**
 * How a turn came to exist, which decides how its output is delivered:
 * `user` turns answer a chat message, `scheduled` turns run silently and hand
 * their result to the caller, and `server` turns were started by Codex itself
 * (mailbox follow-ups, reviews) and are rendered as fresh chat messages.
 */
type TurnOrigin = "user" | "scheduled" | "server";

export interface TurnPresentation {
  readonly origin: TurnOrigin;
  readonly stream: OutboundStream;
  readonly responder: MessageResponder | undefined;
  readonly invocation: CodexInvocationContext;
  readonly conversationKey: string;
  readonly connector: string;
}

/** Terminal state of one turn, with its deliverable output resolved. */
export interface FinalizedTurn {
  readonly turn: Turn;
  /** Final assistant text before delivery fallbacks and warnings. */
  readonly finalText: string;
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailableAttachments: readonly string[];
  dispose(): Promise<void>;
}

/**
 * A turn/start request that is in flight. Codex announces the new turn either
 * through the RPC response or through `turn/started`, in whichever order the
 * streams interleave, so the presentation is parked here until the first
 * announcement claims it.
 */
interface PendingTurnStart {
  claim(turnId: string): TurnView;
  /** Withdraw an unclaimed start; returns the view if it was claimed anyway. */
  cancel(): TurnView | undefined;
}

interface TurnView extends TurnPresentation {
  readonly turnId: string;
  readonly terminal: Deferred<FinalizedTurn>;
  readonly phases: Map<string, "commentary" | "final_answer" | null>;
  readonly actions: Map<string, readonly ProgressAction[]>;
  readonly reasoning: Map<string, readonly string[]>;
  readonly generatedPaths: string[];
  plan: readonly ProgressPlanStep[];
  progressMessage: string;
  finalText: string;
  interrupting: Promise<void> | undefined;
}

export interface ThreadSessionContext {
  readonly rpc: Pick<CodexAppServer, "request">;
  readonly logger: Logger;
  readonly workspace: string;
  readonly generatedImagesDirectory: string;
  readonly outboundDirectory: string;
}

interface ParkedTurnStart {
  readonly presentation: TurnPresentation;
  view: TurnView | undefined;
}

/**
 * Renders one Codex thread's notification stream.
 *
 * The app-server owns the conversation: turns start (ours or Codex's own),
 * emit item events, and complete, all announced through notifications. This
 * class is a projection of that stream onto chat messages — one view per
 * turn, each delivering its own final message — plus the interrupt and
 * approval bookkeeping that must be answered per turn.
 */
export class ThreadSession {
  readonly #context: ThreadSessionContext;
  readonly #views = new Map<string, TurnView>();
  readonly #parkedStarts: ParkedTurnStart[] = [];
  readonly #serverRequests = new Map<string, AbortController>();
  readonly threadId: string;
  #conversationKey: string;
  #connector: string;
  #defaultResponder: MessageResponder | undefined;
  #defaultInvocation: CodexInvocationContext = {};
  #stopRequested = false;

  public constructor(
    threadId: string,
    conversationKey: string,
    connector: string,
    context: ThreadSessionContext,
  ) {
    this.threadId = threadId;
    this.#conversationKey = conversationKey;
    this.#connector = connector;
    this.#context = context;
  }

  public get busy(): boolean {
    return this.#views.size > 0 || this.#parkedStarts.length > 0;
  }

  /** Latest chat presenter; server-initiated turns are rendered through it. */
  public adoptPresenter(
    conversationKey: string,
    connector: string,
    responder: MessageResponder | undefined,
    invocation: CodexInvocationContext,
  ): void {
    this.#conversationKey = conversationKey;
    this.#connector = connector;
    if (responder !== undefined) this.#defaultResponder = responder;
    this.#defaultInvocation = invocation;
  }

  /**
   * Park a presentation for a turn Wirebot is about to start. Starting new work
   * supersedes an earlier stop request.
   */
  public expectTurn(presentation: TurnPresentation): PendingTurnStart {
    this.#stopRequested = false;
    const parked: ParkedTurnStart = { presentation, view: undefined };
    this.#parkedStarts.push(parked);
    return {
      claim: (turnId: string) => this.claimParked(parked, turnId),
      cancel: () => {
        const index = this.#parkedStarts.indexOf(parked);
        if (index !== -1) this.#parkedStarts.splice(index, 1);
        return parked.view;
      },
    };
  }

  public view(turnId: string): TurnView | undefined {
    return this.#views.get(turnId);
  }

  /** Fallback presenter for approvals on turns Wirebot did not start. */
  public defaultResponder(): MessageResponder | undefined {
    return this.#defaultResponder;
  }

  public defaultToolContext(): Readonly<{
    invocation: CodexInvocationContext;
    conversationKey: string;
    connector: string;
  }> {
    return {
      invocation: this.#defaultInvocation,
      conversationKey: this.#conversationKey,
      connector: this.#connector,
    };
  }

  /**
   * Interrupt every running turn and keep interrupting successors until new
   * work is started. Interrupts are requests, not guarantees: the definitive
   * outcome is each turn's `turn/completed` notification, so RPC failures
   * (for example a successor Codex already swapped in) are only logged.
   */
  public async interruptRunning(): Promise<boolean> {
    const views = [...this.#views.values()];
    if (views.length === 0 && this.#parkedStarts.length === 0) return false;
    this.#stopRequested = true;
    await Promise.all(views.map(async (view) => await this.interruptTurn(view)));
    return true;
  }

  public async interruptMatching(
    predicate: (view: TurnView) => boolean,
  ): Promise<readonly TurnView[]> {
    const views = [...this.#views.values()].filter(predicate);
    await Promise.all(views.map(async (view) => await this.interruptTurn(view)));
    return views;
  }

  public interruptTurn(view: TurnView): Promise<void> {
    view.interrupting ??= this.#context.rpc
      .request<TurnInterruptResponse>({
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: view.turnId },
      })
      .then(
        () => undefined,
        (error: unknown) => {
          view.interrupting = undefined;
          this.#context.logger.warn("Codex turn interrupt was not accepted", {
            threadId: this.threadId,
            turnId: view.turnId,
            error: errorMessage(error),
          });
        },
      );
    return view.interrupting;
  }

  /** Track a server→client request so `serverRequest/resolved` can cancel it. */
  public beginServerRequest(requestId: RequestId): AbortSignal {
    const controller = new AbortController();
    this.#serverRequests.set(String(requestId), controller);
    return controller.signal;
  }

  public endServerRequest(requestId: RequestId): void {
    this.#serverRequests.delete(String(requestId));
  }

  /** The app-server closes every open turn when it exits. */
  public fail(error: Error): void {
    for (const controller of this.#serverRequests.values()) controller.abort();
    this.#serverRequests.clear();
    this.#parkedStarts.length = 0;
    for (const view of [...this.#views.values()]) {
      this.#views.delete(view.turnId);
      if (view.origin !== "scheduled") {
        void view.stream.fail(errorMessage(error)).catch(() => undefined);
      }
      view.terminal.reject(error);
    }
  }

  public handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "turn/started":
        this.handleTurnStarted(notification.params.turn);
        return;
      case "turn/completed":
        this.handleTurnCompleted(notification.params.turn);
        return;
      case "item/started":
      case "item/completed":
        this.handleItem(notification.params.turnId, notification.params.item);
        return;
      case "item/agentMessage/delta": {
        const view = this.#views.get(notification.params.turnId);
        if (view === undefined) return;
        if (view.phases.get(notification.params.itemId) === "commentary") {
          view.progressMessage += notification.params.delta;
          this.publishProgress(view);
        } else {
          view.finalText += notification.params.delta;
          view.stream.appendFinal(notification.params.delta);
        }
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const view = this.#views.get(notification.params.turnId);
        if (view === undefined) return;
        const summaries = [...(view.reasoning.get(notification.params.itemId) ?? [])];
        summaries[notification.params.summaryIndex] =
          `${summaries[notification.params.summaryIndex] ?? ""}${notification.params.delta}`;
        view.reasoning.set(notification.params.itemId, summaries);
        this.publishProgress(view);
        return;
      }
      case "item/fileChange/patchUpdated": {
        const view = this.#views.get(notification.params.turnId);
        if (view === undefined) return;
        view.actions.set(
          notification.params.itemId,
          fileChangeActions(notification.params.changes, false),
        );
        this.publishProgress(view);
        return;
      }
      case "turn/plan/updated": {
        const view = this.#views.get(notification.params.turnId);
        if (view === undefined) return;
        view.plan = notification.params.plan;
        this.publishProgress(view);
        return;
      }
      case "serverRequest/resolved":
        this.#serverRequests.get(String(notification.params.requestId))?.abort();
        this.endServerRequest(notification.params.requestId);
        return;
      default:
        return;
    }
  }

  private handleTurnStarted(turn: Turn): void {
    if (this.#views.has(turn.id)) return;
    const parked = this.#parkedStarts[0];
    if (parked === undefined) {
      this.bindView(turn.id, this.serverPresentation());
    } else {
      this.claimParked(parked, turn.id);
    }
  }

  private handleTurnCompleted(turn: Turn): void {
    const view = this.#views.get(turn.id);
    if (view === undefined) return;
    this.#views.delete(turn.id);
    void this.finalize(view, turn);
  }

  private claimParked(parked: ParkedTurnStart, turnId: string): TurnView {
    if (parked.view !== undefined) {
      if (parked.view.turnId === turnId) return parked.view;
      // The parked stream was claimed by an interleaving turn; render the
      // newly announced turn through a fresh stream instead of losing it.
      return this.bindView(turnId, this.serverPresentation(parked.presentation));
    }
    const index = this.#parkedStarts.indexOf(parked);
    if (index !== -1) this.#parkedStarts.splice(index, 1);
    parked.view = this.bindView(turnId, parked.presentation);
    return parked.view;
  }

  private serverPresentation(base?: TurnPresentation): TurnPresentation {
    const responder = base?.responder ?? this.#defaultResponder;
    const stream = responder?.createStream() ?? silentStream;
    void stream.start({ summary: "Thinking…", actions: [], plan: [] }).catch((error: unknown) => {
      this.#context.logger.warn("Could not open a stream for a Codex-initiated turn", {
        threadId: this.threadId,
        error: errorMessage(error),
      });
    });
    return {
      origin: "server",
      stream,
      responder,
      invocation: base?.invocation ?? this.#defaultInvocation,
      conversationKey: base?.conversationKey ?? this.#conversationKey,
      connector: base?.connector ?? this.#connector,
    };
  }

  private bindView(turnId: string, presentation: TurnPresentation): TurnView {
    const view: TurnView = {
      ...presentation,
      turnId,
      terminal: deferred<FinalizedTurn>(),
      phases: new Map(),
      actions: new Map(),
      reasoning: new Map(),
      generatedPaths: [],
      plan: [],
      progressMessage: "",
      finalText: "",
      interrupting: undefined,
    };
    // Codex-initiated turns may have no awaiter; their outcome is the chat.
    void view.terminal.promise.catch(() => undefined);
    this.#views.set(turnId, view);
    // A stop requested while the start was in flight applies to this turn.
    if (this.#stopRequested) void this.interruptTurn(view);
    return view;
  }

  private handleItem(turnId: string, item: ThreadItem): void {
    const view = this.#views.get(turnId);
    if (view === undefined) return;
    if (item.type === "agentMessage") {
      view.phases.set(item.id, item.phase);
      if (item.phase === "commentary") {
        view.progressMessage = item.text;
      } else if (item.text.length > 0) {
        view.finalText = item.text;
      }
    }
    if (item.type === "reasoning") {
      view.reasoning.set(item.id, item.summary);
    }
    if (
      item.type === "imageGeneration" &&
      item.savedPath !== undefined &&
      !view.generatedPaths.includes(item.savedPath)
    ) {
      view.generatedPaths.push(item.savedPath);
    }
    const actions = progressActions(item);
    if (actions.length > 0) view.actions.set(item.id, actions);
    this.publishProgress(view);
  }

  private publishProgress(view: TurnView): void {
    const summary = Array.from(view.reasoning.values())
      .reverse()
      .flatMap((summaries) => [...summaries].reverse())
      .find((value) => value.trim().length > 0);
    const progress: ProgressSnapshot = {
      ...(summary === undefined ? {} : { summary }),
      ...(view.progressMessage.trim().length === 0 ? {} : { message: view.progressMessage }),
      actions: Array.from(view.actions.values()).flat(),
      plan: view.plan,
    };
    view.stream.setProgress(progress);
  }

  private async finalize(view: TurnView, turn: Turn): Promise<void> {
    try {
      if (turn.status === "failed") {
        const message = turn.error?.message ?? "Codex turn failed";
        if (view.origin !== "scheduled") await view.stream.fail(message);
        view.terminal.resolve({
          turn,
          finalText: "",
          attachments: [],
          unavailableAttachments: [],
          dispose: async () => undefined,
        });
        return;
      }
      const finalText = finalTextFromTurn(turn) || view.finalText;
      const stagingDirectory = join(this.#context.outboundDirectory, crypto.randomUUID());
      const resolution = await resolveOutboundAttachments(
        this.#context.workspace,
        this.#context.generatedImagesDirectory,
        stagingDirectory,
        finalText,
        [...view.generatedPaths, ...generatedFilePaths(turn.items)],
      );
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      };
      if (view.origin !== "scheduled") {
        await view.stream.complete(
          deliveryText(view.origin, turn.status, finalText, resolution),
          resolution.attachments,
        );
        await dispose();
      }
      view.terminal.resolve({
        turn,
        finalText,
        attachments: resolution.attachments,
        unavailableAttachments: resolution.unavailable,
        dispose,
      });
    } catch (error) {
      this.#context.logger.error("Could not deliver a completed Codex turn", error, {
        threadId: this.threadId,
        turnId: view.turnId,
      });
      if (view.origin !== "scheduled") {
        void view.stream.fail(errorMessage(error)).catch(() => undefined);
      }
      view.terminal.reject(error);
    }
  }
}

function deliveryText(
  origin: TurnOrigin,
  status: Turn["status"],
  finalText: string,
  resolution: Readonly<{
    attachments: readonly OutboundAttachment[];
    unavailable: readonly string[];
  }>,
): string {
  if (status === "interrupted" && finalText.length === 0) return "Stopped.";
  const text =
    resolution.unavailable.length === 0
      ? finalText
      : `Could not attach ${resolution.unavailable.join(", ")}.${finalText.length === 0 ? "" : `\n\n${finalText}`}`;
  if (text.length > 0) return text;
  return origin === "user" && resolution.attachments.length === 0 ? "Done." : "";
}

export const silentStream: OutboundStream = {
  start: async () => undefined,
  setProgress: () => undefined,
  appendFinal: () => undefined,
  complete: async () => undefined,
  fail: async () => undefined,
};
