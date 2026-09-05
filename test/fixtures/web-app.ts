import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationManagementError } from "../../src/automations/engine.js";
import type { EditableConfigSnapshot } from "../../src/codex/config-service.js";
import type { CodexRuntimeStatus } from "../../src/codex/runtime-service.js";
import { type AppPrincipal, BrowserAuth } from "../../src/miniapp/browser-auth.js";
import { MiniAppServer, type MiniAppServerOptions } from "../../src/miniapp/server.js";
import { Logger } from "../../src/shared/logger.js";

export const testPrincipal: AppPrincipal = {
  owner: { provider: "slack", resource: "user", id: "U_ADMIN" },
  conversation: { provider: "slack", resource: "conversation", id: "slack:D_ADMIN" },
  deliveryTarget: { provider: "slack", resource: "destination", id: "private-dm-target" },
};
export const snapshot: EditableConfigSnapshot = {
  version: "test-version",
  values: {
    model: "test-model",
    model_provider: null,
    approval_policy: "on-request",
    approvals_reviewer: "user",
    sandbox_mode: "workspace-write",
    default_permissions: null,
    web_search: "live",
    model_reasoning_effort: null,
    model_reasoning_summary: null,
    model_verbosity: null,
    service_tier: null,
    personality: null,
    windows_sandbox: null,
    shell_environment_include_only: null,
    features: {},
  },
  capabilities: {
    platform: "linux",
    models: [
      {
        model: "test-model",
        displayName: "Test model",
        description: "A local fixture model",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      },
    ],
    modelProviders: [{ id: "openai", displayName: "OpenAI", description: "", allowed: true }],
    permissionProfiles: [],
    features: [],
    requirements: null,
  },
  validation: { valid: true, issues: [] },
};

/** Exercises the real HTTP server; only the Codex/messenger services are local fakes. */
export async function startTestApp(assetDirectory?: string, includeTelegram = false) {
  let admin = true;
  const auth = new BrowserAuth(
    (owner) => admin && (owner.provider === "slack" || owner.provider === "discord"),
  );
  const assets = assetDirectory ?? (await mkdtemp(join(tmpdir(), "wirebot-browser-test-")));
  const ownedDirectory = assetDirectory === undefined ? assets : undefined;
  if (ownedDirectory !== undefined) {
    await Promise.all(
      ["index.html", "app.js", "app.css"].map((name) =>
        Bun.write(
          join(assets, name),
          name === "index.html" ? "<!doctype html><title>Wirebot</title>" : "",
        ),
      ),
    );
  }
  const scheduleScopes: unknown[][] = [];
  const status: CodexRuntimeStatus = {
    state: "ready",
    restartRequired: false,
    lastError: null,
    lastAppliedAt: null,
    configPath: "/test/config.toml",
  };
  const runtime = {
    status: () => status,
    usageLimits: async () => ({
      weekly: { remainingPercent: 78, resetsAt: null },
      fiveHour: { remainingPercent: 94, resetsAt: null },
      bankedResets: null,
    }),
    skills: () => [
      {
        name: "workspace-guide",
        description: "Work with your project files and development tools.",
      },
    ],
    browseSkill: async () => {
      throw new Error("Not used");
    },
    afterConfigWrite: async () => status,
    reload: async () => status,
    restart: async () => status,
    applyBankedReset: async () => "nothingToReset" as const,
  };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    browserAuth: auth,
    assetDirectory: assets,
    ...(includeTelegram
      ? { telegramAuth: { botToken: "123456:TEST_BOT_TOKEN", allowedUserIds: new Set([42]) } }
      : {}),
    codex: { account: async () => ({ account: null, requiresOpenaiAuth: false }) },
    runtime,
    configService: {
      read: async () => snapshot,
      validate: async () => ({ valid: true, issues: [] }),
      update: async () => ({
        status: "ok",
        version: "saved",
        filePath: "/test/config.toml",
        overriddenMetadata: null,
      }),
    },
    settings: {
      read: () => ({ remoteClientContext: true }),
      update: async () => ({ remoteClientContext: true }),
    },
    scheduledRuns: {
      listForOwner: (owner) => {
        scheduleScopes.push([owner]);
        return [];
      },
      createForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("invalid", "Captured scope");
      },
      updateForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("not_found", "Schedule not found");
      },
      deleteForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("not_found", "Schedule not found");
      },
    },
    logger: new Logger("error"),
  } satisfies MiniAppServerOptions);
  const url = await server.start();
  return {
    server,
    url,
    auth,
    scheduleScopes,
    setAdmin: (value: boolean) => {
      admin = value;
    },
    close: async () => {
      await server.stop();
      if (ownedDirectory !== undefined) await rm(ownedDirectory, { recursive: true, force: true });
    },
  };
}
