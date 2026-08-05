import type { ScheduledRunsEngine } from "../automations/engine.js";
import type { CodexRuntimeStatus } from "../codex/runtime-service.js";
import type { CodexService } from "../codex/service.js";
import type { Account } from "../generated/codex/v2/Account.js";
import type { AccountLoginCompletedNotification } from "../generated/codex/v2/AccountLoginCompletedNotification.js";
import type { GetAccountResponse } from "../generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../generated/codex/v2/LoginAccountResponse.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type {
  InboundCommand,
  InboundMessage,
  MessageHandler,
  MessageResponder,
  ProviderReference,
} from "./channel.js";

const introText =
  "👋 Hi, I'm Telex. Send me a message and I'll hand it to Codex, then stream progress and results back into this chat.";

/**
 * The single source for the user-facing command list: /help and the Telegram
 * command menu both derive from it. /continue stays hidden on purpose.
 */
export const botCommands: readonly {
  readonly command: string;
  readonly menuDescription: string;
  readonly help: string;
}[] = [
  { command: "start", menuDescription: "Set up Telex", help: "show setup and sign-in help" },
  { command: "new", menuDescription: "Start a new Codex task", help: "start a fresh Codex task" },
  {
    command: "back",
    menuDescription: "Return to the previous Codex task",
    help: "return to the previous Codex task",
  },
  { command: "stop", menuDescription: "Stop the running turn", help: "stop the current turn" },
  { command: "schedules", menuDescription: "List scheduled runs", help: "list scheduled runs" },
  {
    command: "status",
    menuDescription: "Show Codex status",
    help: "check Codex and sign-in status",
  },
  { command: "login", menuDescription: "Sign in to Codex", help: "sign in to ChatGPT" },
  { command: "logout", menuDescription: "Sign out of Codex", help: "sign out" },
  { command: "config", menuDescription: "Open Codex settings", help: "open Codex settings" },
  {
    command: "reload",
    menuDescription: "Reload Codex resources",
    help: "reload Codex config, MCP servers, and skills",
  },
  {
    command: "restart",
    menuDescription: "Restart the Codex app-server",
    help: "safely restart the Codex app-server",
  },
  { command: "help", menuDescription: "Show commands", help: "show this help" },
];

const helpText = [
  "Send me a message to work with Codex in this conversation.",
  "",
  ...botCommands.map((entry) => `/${entry.command} — ${entry.help}`),
].join("\n");

const readyText =
  'Try something like "explain what this project does", or send /help for all commands.';

const loginCodeTtl = 15 * 60 * 1_000;

export interface CodexRuntimeCommand {
  status(): CodexRuntimeStatus;
  reload(): Promise<unknown>;
  restart(): Promise<unknown>;
}

interface PendingLogin {
  readonly responder: MessageResponder;
  readonly timer: NodeJS.Timeout;
  /** Message that arrived before sign-in; replayed once login completes. */
  readonly resume?: InboundMessage;
}

export class CodexBridge {
  readonly #codex: CodexService;
  readonly #publicUrl: string | undefined;
  readonly #logger: Logger;
  readonly #runtimeCommand: CodexRuntimeCommand;
  readonly #scheduledRuns: ScheduledRunsEngine;
  readonly #pendingLogins = new Map<string, PendingLogin>();
  #signedInConfirmed = false;

  public readonly handleMessage: MessageHandler = async (message) => {
    try {
      // Command parsing is owned by the channel; the bridge trusts message.command.
      const command = message.command;
      if (command === undefined) {
        if (!(await this.ensureSignedIn(message))) return;
        await this.runUserTurn(message);
        return;
      }
      await this.handleCommand(message, command);
    } catch (error) {
      this.#logger.error("Bridge command failed", error, {
        channel: message.address.channel,
        conversation: message.address.key,
      });
      await message.responder.sendText(`Codex error: ${errorMessage(error)}`);
    }
  };

  public constructor(
    codex: CodexService,
    publicUrl: string | undefined,
    logger: Logger,
    runtimeCommand: CodexRuntimeCommand,
    scheduledRuns: ScheduledRunsEngine,
  ) {
    this.#codex = codex;
    this.#publicUrl = publicUrl;
    this.#logger = logger;
    this.#runtimeCommand = runtimeCommand;
    this.#scheduledRuns = scheduledRuns;
    codex.onLoginCompleted((notification) => {
      void this.handleLoginCompleted(notification);
    });
  }

  private async runUserTurn(message: InboundMessage): Promise<void> {
    if (message.address.isGuest) {
      await this.#codex.runTurn(
        message.address.key,
        message.address.channel,
        message.text,
        message.responder,
        true,
        message.attachments,
      );
      return;
    }
    const owner = messageOwner(message);
    const additionalContext = await this.#scheduledRuns.contextForReply(
      message.replyTo,
      owner,
      messageConversation(message),
    );
    await this.#codex.runTurn(
      message.address.key,
      message.address.channel,
      message.text,
      message.responder,
      false,
      message.attachments,
      {
        owner,
        ...(message.address.deliveryTarget === undefined
          ? {}
          : { deliveryTarget: message.address.deliveryTarget }),
        ...(additionalContext === undefined ? {} : { additionalContext }),
      },
    );
  }

  private async handleCommand(message: InboundMessage, command: InboundCommand): Promise<void> {
    switch (command.name) {
      case "start":
        await this.handleStart(message);
        return;
      case "help":
        await message.responder.sendText(helpText);
        return;
      case "new":
        await this.#codex.resetConversation(message.address.key);
        await message.responder.sendText("Started a fresh Codex task. What should we work on?");
        return;
      case "back": {
        const threadId = await this.#codex.activatePreviousConversationThread(
          message.address.key,
          message.address.channel,
        );
        await message.responder.sendText(
          threadId === undefined
            ? "There is no previous Codex task in this conversation."
            : "Returned to the previous Codex task.",
        );
        return;
      }
      case "stop": {
        const stopped = await this.#codex.interrupt(message.address.key);
        await message.responder.sendText(
          stopped ? "Stopping the current turn." : "Nothing is running.",
        );
        return;
      }
      case "status":
        await message.responder.sendText(await this.statusText());
        return;
      case "schedules":
        await this.handleSchedules(message);
        return;
      case "continue":
        await this.handleContinueRun(message, command.args);
        return;
      case "login": {
        if (!(await this.requirePrivateChat(message))) return;
        const account = (await this.#codex.account().catch(() => undefined))?.account;
        if (account !== undefined && account !== null) {
          await message.responder.sendText(
            `You're already ${accountSummary(account)}. Send /logout first if you want to switch accounts.`,
          );
          return;
        }
        await this.sendLogin(message.responder, await this.#codex.startDeviceLogin());
        return;
      }
      case "logout":
        if (!(await this.requirePrivateChat(message))) return;
        await this.#codex.logout();
        this.#signedInConfirmed = false;
        await message.responder.sendText(
          "Signed out of Codex. Send /login whenever you want back in.",
        );
        return;
      case "config":
        if (!(await this.requirePrivateChat(message))) return;
        if (this.#publicUrl === undefined) {
          await message.responder.sendText(
            "The settings Mini App is disabled. Set PUBLIC_URL to its public HTTPS origin, or leave TELEX_TUNNEL=auto and restart with network access for an automatic quick tunnel.",
          );
          return;
        }
        await message.responder.sendText("Open the Mini App to edit Codex settings.", {
          button: {
            label: "Open settings",
            kind: "webApp",
            url: `${this.#publicUrl}/miniapp`,
          },
        });
        return;
      case "reload":
        if (!(await this.requirePrivateChat(message))) return;
        await this.handleRuntimeCommand(message, "reload");
        return;
      case "restart":
        if (!(await this.requirePrivateChat(message))) return;
        await this.handleRuntimeCommand(message, "restart");
        return;
      default:
        await message.responder.sendText(`Unknown command /${command.name}.\n\n${helpText}`);
    }
  }

  private async handleSchedules(message: InboundMessage): Promise<void> {
    const automations = this.#scheduledRuns.listForConversation(
      messageOwner(message),
      messageConversation(message),
    );
    if (automations.length === 0) {
      await message.responder.sendText(
        "No scheduled runs yet. Ask Codex something like “check the build every weekday at 9”.",
      );
      return;
    }
    await message.responder.sendText(
      automations
        .map(
          (automation) =>
            `${automation.status === "active" ? "▶️" : "⏸"} ${automation.name}\n${automation.kind} · ${automation.schedule.rrule}\nNext: ${automation.nextRunAt ?? "not scheduled"}${automation.deferralReason === null ? "" : `\nReason: ${automation.deferralReason}`}\nID: ${automation.id}`,
        )
        .join("\n\n"),
    );
  }

  private async handleContinueRun(message: InboundMessage, runId: string): Promise<void> {
    if (runId.trim().length === 0) {
      await message.responder.sendText("This scheduled-run link is incomplete.");
      return;
    }
    const result = await this.#scheduledRuns.continueRun(
      messageOwner(message),
      messageConversation(message),
      runId.trim(),
    );
    await message.responder.sendText(
      result.changed
        ? `Continuing “${result.automationName}”. Subsequent messages will use that Codex thread. Send /back to return.`
        : `“${result.automationName}” is already the active Codex thread.`,
    );
  }

  private async handleRuntimeCommand(
    message: InboundMessage,
    action: "reload" | "restart",
  ): Promise<void> {
    const runtime = this.#runtimeCommand;
    await message.responder.sendText(
      action === "reload"
        ? "Applying Codex config, MCP servers, and skills…"
        : "Safely restarting the Codex app-server…",
    );
    if (action === "reload") await runtime.reload();
    else await runtime.restart();
    const status = runtimeStatusSummary(runtime.status());
    await message.responder.sendText(
      action === "reload"
        ? status.degraded
          ? `Reload finished with warnings: ${status.detail}`
          : "✅ Config and skills refreshed. MCP changes will be active on the next turn."
        : status.degraded
          ? `Restart needs attention: ${status.detail}`
          : "✅ Codex restarted and is ready.",
    );
  }

  private async handleStart(message: InboundMessage): Promise<void> {
    const status = await this.#codex.account().catch(() => undefined);
    if (status === undefined) {
      await message.responder.sendText(`${introText}\n\n${helpText}`);
      return;
    }
    if (!needsLogin(status)) {
      const account = status.account;
      const readyLine =
        account === null
          ? "✅ No sign-in needed with this configuration — you're ready to go."
          : `✅ You're ${accountSummary(account)} — ready to go.`;
      await message.responder.sendText(`${introText}\n\n${readyLine}\n\n${readyText}`);
      return;
    }
    if (!isPrivate(message)) {
      await message.responder.sendText(
        `${introText}\n\nTo get set up, open a private chat with me and send /start — I'll walk you through signing in to ChatGPT.`,
      );
      return;
    }
    await this.sendLogin(
      message.responder,
      await this.#codex.startDeviceLogin(),
      `${introText}\n\nOne thing first: let's connect your ChatGPT account.`,
    );
  }

  private async ensureSignedIn(message: InboundMessage): Promise<boolean> {
    if (this.#signedInConfirmed) return true;
    const status = await this.#codex.account().catch(() => undefined);
    // If the status check itself fails, run the turn anyway so the real error surfaces.
    if (status === undefined) return true;
    if (!needsLogin(status)) {
      this.#signedInConfirmed = true;
      return true;
    }
    if (isPrivate(message)) {
      await this.sendLogin(
        message.responder,
        await this.#codex.startDeviceLogin(),
        "Almost there — I need you to sign in to ChatGPT before I can work on that. I'll start on your message as soon as you're in.",
        message,
      );
    } else {
      await message.responder.sendText(
        "Codex isn't signed in yet. Open a private chat with me and send /start to set it up.",
      );
    }
    return false;
  }

  private async handleLoginCompleted(
    notification: AccountLoginCompletedNotification,
  ): Promise<void> {
    if (notification.success) this.#signedInConfirmed = true;
    const pendingLogins = this.takePendingLogins(notification.loginId);
    for (const pending of pendingLogins) {
      try {
        if (notification.success) {
          const account = (await this.#codex.account().catch(() => undefined))?.account;
          const summary =
            account === undefined || account === null ? "signed in" : accountSummary(account);
          const next =
            pending.resume === undefined
              ? "All set — send me a message and I'll get to work."
              : "All set — starting on your message now.";
          await pending.responder.sendText(`✅ You're ${summary}. ${next}`);
          if (pending.resume !== undefined) {
            await this.runUserTurn(pending.resume);
          }
        } else {
          await pending.responder.sendText(
            `Sign-in didn't go through${
              notification.error === null ? "" : `: ${notification.error}`
            }. Send /login to try again with a fresh code.`,
          );
        }
      } catch (error) {
        this.#logger.error("Could not deliver sign-in confirmation", error);
      }
    }
  }

  private async sendLogin(
    responder: MessageResponder,
    login: LoginAccountResponse,
    intro?: string,
    resume?: InboundMessage,
  ): Promise<void> {
    const prefix = intro === undefined ? "" : `${intro}\n\n`;
    switch (login.type) {
      case "chatgptDeviceCode":
        this.registerPendingLogin(login.loginId, responder, resume);
        await responder.sendText(
          `${prefix}Tap the button below and enter this one-time code on the sign-in page:\n\n${login.userCode}\n\nI'll confirm here the moment you're in.`,
          {
            button: { label: "Open sign-in", kind: "url", url: login.verificationUrl },
          },
        );
        return;
      case "chatgpt":
        this.registerPendingLogin(login.loginId, responder, resume);
        await responder.sendText(
          `${prefix}Open the sign-in page to continue. I'll confirm here the moment you're in.`,
          {
            button: { label: "Open sign-in", kind: "url", url: login.authUrl },
          },
        );
        return;
      case "apiKey":
        await responder.sendText("Codex is configured to use an API key.");
        return;
      case "chatgptAuthTokens":
        await responder.sendText("Codex is configured with ChatGPT authentication tokens.");
    }
  }

  private registerPendingLogin(
    loginId: string,
    responder: MessageResponder,
    resume?: InboundMessage,
  ): void {
    const existing = this.#pendingLogins.get(loginId);
    if (existing !== undefined) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.#pendingLogins.delete(loginId), loginCodeTtl);
    timer.unref();
    this.#pendingLogins.set(loginId, {
      responder,
      timer,
      ...(resume === undefined ? {} : { resume }),
    });
  }

  private takePendingLogins(loginId: string | null): readonly PendingLogin[] {
    const taken: PendingLogin[] = [];
    for (const [id, pending] of this.#pendingLogins) {
      if (loginId !== null && id !== loginId) continue;
      clearTimeout(pending.timer);
      this.#pendingLogins.delete(id);
      taken.push(pending);
    }
    return taken;
  }

  private async requirePrivateChat(message: InboundMessage): Promise<boolean> {
    if (isPrivate(message)) return true;
    await message.responder.sendText("This command is available in a private bot chat only.");
    return false;
  }

  private async statusText(): Promise<string> {
    const runtime = runtimeStatusSummary(this.#runtimeCommand.status());
    const response = await this.#codex.account().catch((error: unknown) => {
      throw new BridgeError(
        `Codex app-server is unavailable: ${errorMessage(error)}. Runtime status: ${runtime.detail}. Send /restart to recover it.`,
        "CODEX_STATUS_UNAVAILABLE",
      );
    });
    const account = response.account;
    const accountStatus =
      account === null
        ? response.requiresOpenaiAuth
          ? "Codex app-server is connected. Not signed in — send /login to connect ChatGPT."
          : "Codex app-server is connected. This configuration does not require OpenAI sign-in."
        : `Codex app-server is connected. You're ${accountSummary(account)}.`;
    return runtime.degraded
      ? `${accountStatus}\nRuntime needs attention: ${runtime.detail}`
      : accountStatus;
  }
}

function runtimeStatusSummary(status: CodexRuntimeStatus): {
  readonly degraded: boolean;
  readonly detail: string;
} {
  const degraded = status.state === "degraded" || status.restartRequired;
  const detail =
    status.lastError ??
    (status.restartRequired
      ? "an app-server restart is required to apply startup-only changes"
      : status.state);
  return { degraded, detail };
}

function accountSummary(account: Account): string {
  switch (account.type) {
    case "apiKey":
      return "authenticated with an OpenAI API key";
    case "chatgpt":
      return `signed in to ChatGPT (${account.planType})`;
    case "amazonBedrock":
      return "authenticated through Amazon Bedrock";
  }
}

function needsLogin(status: GetAccountResponse): boolean {
  return status.account === null && status.requiresOpenaiAuth;
}

function isPrivate(message: InboundMessage): boolean {
  return message.address.isPrivate && !message.address.isGuest;
}

function messageOwner(message: InboundMessage): ProviderReference {
  return {
    provider: message.address.channel,
    resource: "user",
    id: message.sender.id,
  };
}

function messageConversation(message: InboundMessage): ProviderReference {
  return {
    provider: message.address.channel,
    resource: "conversation",
    id: message.address.key,
  };
}
