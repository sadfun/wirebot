import { describe, expect, it, vi } from "vitest";
import type { ScheduledRunsEngine } from "../src/automations/engine.js";
import type { CodexRuntimeStatus } from "../src/codex/runtime-service.js";
import type { CodexService } from "../src/codex/service.js";
import { CodexBridge, type CodexRuntimeCommand } from "../src/core/bridge.js";
import type {
  InboundAttachment,
  InboundCommand,
  InboundMessage,
  ProviderReference,
  SendOptions,
} from "../src/core/channel.js";
import type { AccountLoginCompletedNotification } from "../src/generated/codex/v2/AccountLoginCompletedNotification.js";
import type { GetAccountResponse } from "../src/generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../src/generated/codex/v2/LoginAccountResponse.js";
import { Logger } from "../src/shared/logger.js";

const logger = new Logger("error");

function createResponder() {
  return {
    createStream: vi.fn(),
    sendText: vi.fn(async (_text: string, _options?: SendOptions) => undefined),
    askChoice: vi.fn(async () => "decline"),
  };
}

function createMessage(
  text: string,
  responder: ReturnType<typeof createResponder>,
  address: Partial<InboundMessage["address"]> = {},
  attachments: readonly InboundAttachment[] = [],
  command?: InboundCommand,
): InboundMessage {
  return {
    id: "1",
    address: {
      channel: "telegram",
      key: "telegram:1:0",
      isPrivate: true,
      isGuest: false,
      ...address,
    },
    sender: { id: "1", displayName: "Test" },
    text,
    ...(command === undefined ? {} : { command }),
    attachments,
    responder,
  };
}

function command(name: string, args = ""): InboundCommand {
  return { name, args };
}

function createCodex(overrides: Record<string, unknown> = {}) {
  let loginListener: ((notification: AccountLoginCompletedNotification) => void) | undefined;
  const raw = {
    runTurn: vi.fn(async () => undefined),
    resetConversation: vi.fn(async () => undefined),
    activatePreviousConversationThread: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => false),
    account: vi.fn(
      async (): Promise<GetAccountResponse> => ({ account: null, requiresOpenaiAuth: true }),
    ),
    startDeviceLogin: vi.fn(
      async (): Promise<LoginAccountResponse> => ({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://example.com/device",
        userCode: "ABCD-1234",
      }),
    ),
    logout: vi.fn(async () => undefined),
    onLoginCompleted: vi.fn((listener: (n: AccountLoginCompletedNotification) => void) => {
      loginListener = listener;
    }),
    ...overrides,
  };
  return {
    raw,
    codex: raw as unknown as CodexService,
    emitLoginCompleted: (notification: AccountLoginCompletedNotification) => {
      loginListener?.(notification);
    },
  };
}

const readyRuntimeStatus: CodexRuntimeStatus = {
  state: "ready",
  restartRequired: false,
  lastError: null,
  lastAppliedAt: null,
  configPath: null,
};

function stubRuntime(status: Partial<CodexRuntimeStatus> = {}): CodexRuntimeCommand {
  return {
    status: () => ({ ...readyRuntimeStatus, ...status }),
    reload: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
  };
}

function stubScheduledRuns(overrides: Record<string, unknown> = {}): ScheduledRunsEngine {
  return {
    contextForReply: vi.fn(async () => undefined),
    listForConversation: vi.fn(() => []),
    continueRun: vi.fn(),
    ...overrides,
  } as unknown as ScheduledRunsEngine;
}

function createBridge(
  codex: CodexService,
  overrides: {
    publicUrl?: string;
    runtime?: CodexRuntimeCommand;
    scheduledRuns?: ScheduledRunsEngine;
  } = {},
): CodexBridge {
  return new CodexBridge(
    codex,
    overrides.publicUrl,
    logger,
    overrides.runtime ?? stubRuntime(),
    overrides.scheduledRuns ?? stubScheduledRuns(),
  );
}

const signedInAccount: GetAccountResponse = {
  account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
  requiresOpenaiAuth: true,
};

const messageOwner = providerReference("user", "1");

describe("CodexBridge onboarding", () => {
  it("welcomes a signed-in user on /start without starting a login", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/start", responder, {}, [], command("start")));

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    const text = responder.sendText.mock.calls[0]?.[0];
    expect(text).toContain("signed in to ChatGPT (plus)");
    expect(text).toContain("ready to go");
  });

  it("prefers a transport command over normalized reply context and attachments", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage(
        "Replying to Topic:\n  [Photo]\n/start",
        responder,
        {},
        [{ kind: "image", path: "/workspace/topic.jpg", description: "Topic root" }],
        command("start"),
      ),
    );

    expect(raw.runTurn).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("ready to go");
  });

  it("runs a command-looking message as a turn when the channel sends no command", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();
    const attachments: readonly InboundAttachment[] = [
      { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
    ];

    await bridge.handleMessage(createMessage("/new\n[Photo]", responder, {}, attachments));

    expect(raw.resetConversation).not.toHaveBeenCalled();
    expect(raw.runTurn).toHaveBeenCalledWith(
      "telegram:1:0",
      "telegram",
      "/new\n[Photo]",
      responder,
      false,
      attachments,
      { owner: messageOwner },
    );
  });

  it("starts the sign-in flow directly from /start in a private chat", async () => {
    const { codex, raw } = createCodex();
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/start", responder, {}, [], command("start")));

    expect(raw.startDeviceLogin).toHaveBeenCalledTimes(1);
    const call = responder.sendText.mock.calls[0];
    expect(call?.[0]).toContain("ABCD-1234");
    expect(call?.[0]).toContain("I'll confirm here");
    expect(call?.[1]?.button?.url).toBe("https://example.com/device");
  });

  it("points group members to a private chat on /start when sign-in is needed", async () => {
    const { codex, raw } = createCodex();
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(
      createMessage("/start", responder, { isPrivate: false }, [], command("start")),
    );

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("open a private chat");
  });

  it("intercepts a task message when not signed in and resumes it after login", async () => {
    const { codex, raw, emitLoginCompleted } = createCodex();
    const bridge = createBridge(codex);
    const responder = createResponder();
    const attachments: readonly InboundAttachment[] = [
      { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
    ];
    await bridge.handleMessage(createMessage("fix the tests", responder, {}, attachments));

    expect(raw.runTurn).not.toHaveBeenCalled();
    expect(raw.startDeviceLogin).toHaveBeenCalledTimes(1);
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("ABCD-1234");

    raw.account.mockResolvedValue(signedInAccount);
    emitLoginCompleted({ loginId: "login-1", success: true, error: null });
    await vi.waitFor(() => {
      expect(raw.runTurn).toHaveBeenCalledWith(
        "telegram:1:0",
        "telegram",
        "fix the tests",
        responder,
        false,
        attachments,
        { owner: messageOwner },
      );
    });
    const confirmation = responder.sendText.mock.calls[1]?.[0];
    expect(confirmation).toContain("✅");
    expect(confirmation).toContain("starting on your message");
  });

  it("confirms sign-in after /login completes", async () => {
    const { codex, emitLoginCompleted } = createCodex();
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder, {}, [], command("login")));

    emitLoginCompleted({ loginId: "login-1", success: true, error: null });
    await vi.waitFor(() => {
      expect(responder.sendText).toHaveBeenCalledTimes(2);
    });
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("✅");
  });

  it("reports a failed sign-in", async () => {
    const { codex, emitLoginCompleted } = createCodex();
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder, {}, [], command("login")));

    emitLoginCompleted({ loginId: "login-1", success: false, error: "code expired" });
    await vi.waitFor(() => {
      expect(responder.sendText).toHaveBeenCalledTimes(2);
    });
    const text = responder.sendText.mock.calls[1]?.[0];
    expect(text).toContain("code expired");
    expect(text).toContain("/login");
  });

  it("skips repeated account checks once sign-in is confirmed", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("task one", responder));
    await bridge.handleMessage(createMessage("task two", responder));

    expect(raw.runTurn).toHaveBeenCalledTimes(2);
    expect(raw.account).toHaveBeenCalledTimes(1);
  });

  it("passes the current connector to Codex", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage("summarize this", responder, {
        channel: "discord",
        key: "discord:1",
      }),
    );

    expect(raw.runTurn).toHaveBeenCalledWith(
      "discord:1",
      "discord",
      "summarize this",
      responder,
      false,
      [],
      { owner: { provider: "discord", resource: "user", id: "1" } },
    );
  });

  it("tells an already signed-in user how to switch accounts on /login", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = createBridge(codex);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder, {}, [], command("login")));

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    const text = responder.sendText.mock.calls[0]?.[0];
    expect(text).toContain("already signed in to ChatGPT (plus)");
    expect(text).toContain("/logout");
  });
});

describe("CodexBridge runtime controls", () => {
  it.each(["reload", "restart"] as const)("runs /%s in a private chat", async (action) => {
    const { codex } = createCodex();
    const runtime = stubRuntime();
    const bridge = createBridge(codex, { runtime });
    const responder = createResponder();

    await bridge.handleMessage(createMessage(`/${action}`, responder, {}, [], command(action)));

    expect(runtime[action]).toHaveBeenCalledOnce();
    expect(responder.sendText).toHaveBeenCalledTimes(2);
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("✅");
  });

  it("keeps restart controls out of group chats", async () => {
    const { codex } = createCodex();
    const runtime = stubRuntime();
    const bridge = createBridge(codex, { runtime });
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage("/restart", responder, { isPrivate: false }, [], command("restart")),
    );

    expect(runtime.restart).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("private bot chat");
  });

  it("points status checks to restart when the app-server is down", async () => {
    const { codex } = createCodex({
      account: vi.fn(async () => Promise.reject(new Error("down"))),
    });
    const runtime = stubRuntime({ state: "degraded", lastError: "transport exited" });
    const bridge = createBridge(codex, { runtime });
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/status", responder, {}, [], command("status")));

    expect(responder.sendText.mock.calls[0]?.[0]).toContain("/restart");
  });
});

describe("CodexBridge scheduled-run routing", () => {
  it("adds a replied-to notification as context without switching the active task", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const replyTo = providerReference("message", "reply-1");
    const deliveryTarget = providerReference("destination", "target-1");
    const applicationContext = {
      "telex.scheduled-result": { kind: "application" as const, value: "Complete result" },
    };
    const scheduledRuns = stubScheduledRuns({
      contextForReply: vi.fn(async () => applicationContext),
    });
    const bridge = createBridge(codex, { scheduledRuns });
    const responder = createResponder();
    const base = createMessage("What does this mean?", responder, { deliveryTarget });

    await bridge.handleMessage({ ...base, replyTo });

    const conversation = providerReference("conversation", "telegram:1:0");
    expect(scheduledRuns.contextForReply).toHaveBeenCalledWith(replyTo, messageOwner, conversation);
    expect(raw.runTurn).toHaveBeenCalledWith(
      "telegram:1:0",
      "telegram",
      "What does this mean?",
      responder,
      false,
      [],
      { owner: messageOwner, deliveryTarget, additionalContext: applicationContext },
    );
  });

  it("switches only through an explicit continue action and supports back", async () => {
    const { codex, raw } = createCodex({
      activatePreviousConversationThread: vi.fn(async () => "thread-previous"),
    });
    const scheduledRuns = stubScheduledRuns({
      continueRun: vi.fn(async () => ({ automationName: "Build monitor", changed: true })),
    });
    const bridge = createBridge(codex, { scheduledRuns });
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage("/continue run-1", responder, {}, [], command("continue", "run-1")),
    );
    await bridge.handleMessage(createMessage("/back", responder, {}, [], command("back")));

    expect(scheduledRuns.continueRun).toHaveBeenCalledWith(
      messageOwner,
      providerReference("conversation", "telegram:1:0"),
      "run-1",
    );
    expect(raw.activatePreviousConversationThread).toHaveBeenCalledWith("telegram:1:0", "telegram");
  });
});

function providerReference(resource: ProviderReference["resource"], id: string): ProviderReference {
  return { provider: "telegram", resource, id };
}
