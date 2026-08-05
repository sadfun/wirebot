import { createHmac } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiniAppServer } from "../../dist/miniapp/server.js";

const sourceAssetDirectory = join(process.cwd(), "dist/miniapp/public");
const previewAssetDirectory = await mkdtemp(join(tmpdir(), "wirebot-miniapp-preview-"));
const botToken = "preview-token";
const userId = 42;
const initData = signedInitData(botToken, userId);

await Promise.all([
  copyFile(join(sourceAssetDirectory, "index.html"), join(previewAssetDirectory, "index.html")),
  copyFile(join(sourceAssetDirectory, "app.css"), join(previewAssetDirectory, "app.css")),
  readFile(join(sourceAssetDirectory, "app.js"), "utf8").then((bundle) =>
    writeFile(
      join(previewAssetDirectory, "app.js"),
      `for(const [name,value] of Object.entries({"--tg-theme-bg-color":"#000000","--tg-theme-secondary-bg-color":"#1c1c1e","--tg-theme-section-bg-color":"#2c2c2e","--tg-theme-text-color":"#f5f5f7","--tg-theme-hint-color":"#8e8e93","--tg-theme-button-color":"#ffffff","--tg-theme-button-text-color":"#111113","--tg-theme-link-color":"#55aaf0","--tg-theme-bottom-bar-bg-color":"#000000","--tg-theme-section-header-text-color":"#8e8e93","--tg-theme-section-separator-color":"#38383a","--tg-theme-subtitle-text-color":"#8e8e93","--tg-theme-destructive-text-color":"#ff6961"})){document.documentElement.style.setProperty(name,value)}window.Telegram={WebApp:{initData:${JSON.stringify(initData)},colorScheme:"dark",ready(){},expand(){},onEvent(){},offEvent(){},HapticFeedback:{notificationOccurred(){}}}};\n${bundle}`,
    ),
  ),
]);

const featureNames = [
  "apps",
  "goals",
  "hooks",
  "fast_mode",
  "memories",
  "multi_agent",
  "personality",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "unified_exec",
];

const snapshot = {
  version: "sha256:abcdef0123456789",
  values: {
    model_provider: null,
    model: "gpt-5.6-sol",
    model_reasoning_effort: "high",
    model_reasoning_summary: "auto",
    model_verbosity: "low",
    service_tier: null,
    personality: "friendly",
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
    sandbox_mode: "workspace-write",
    default_permissions: ":workspace",
    web_search: "live",
    windows_sandbox: null,
    shell_environment_include_only: null,
    features: Object.fromEntries(featureNames.map((name) => [name, null])),
  },
  capabilities: {
    platform: "linux",
    modelProviders: [],
    models: [
      {
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
          (reasoningEffort) => ({
            reasoningEffort,
            description: `${reasoningEffort} reasoning depth.`,
          }),
        ),
        defaultReasoningEffort: "high",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      },
    ],
    permissionProfiles: [
      {
        id: ":workspace",
        description: "Workspace-scoped filesystem and tool access.",
        allowed: true,
      },
    ],
    features: [
      {
        name: "goals",
        stage: "stable",
        displayName: "Goals",
        description: "Enable persisted goals and automatic continuation.",
        enabled: true,
        defaultEnabled: true,
        locked: false,
      },
      {
        name: "hooks",
        stage: "stable",
        displayName: "Hooks",
        description: "Enable lifecycle hooks from hooks.json or inline config.",
        enabled: false,
        defaultEnabled: false,
        locked: false,
      },
    ],
    requirements: null,
  },
  validation: { valid: true, issues: [] },
};

const runtimeStatus = {
  state: "ready",
  configPath: "/preview/config.toml",
  restartRequired: false,
  config: { state: "ready", message: "Effective config loaded by Codex." },
  mcp: { state: "ready", message: "MCP servers loaded by the app-server." },
  skills: { state: "ready", message: "3 enabled skills loaded." },
};

const skills = [
  {
    name: "imagegen",
    description:
      "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts.",
  },
  {
    name: "openai-docs",
    description:
      "Use current official OpenAI documentation to answer product and API questions with precise citations.",
  },
  {
    name: "plugin-creator",
    description:
      "Create and scaffold Codex plugin directories with valid manifests and reusable component structure.",
  },
];

let usageWindows = {
  weekly: {
    remainingPercent: 68,
    resetsAt: Math.floor(Date.now() / 1_000) + 3 * 24 * 60 * 60 + 7 * 60 * 60,
  },
  fiveHour: {
    remainingPercent: 42,
    resetsAt: Math.floor(Date.now() / 1_000) + 2 * 60 * 60 + 18 * 60,
  },
};
let bankedResetCredits = [
  {
    id: "preview-reset-1",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: Math.floor(Date.now() / 1_000) - 5 * 24 * 60 * 60,
    expiresAt: Math.floor(Date.now() / 1_000) + 21 * 24 * 60 * 60,
    title: "Codex usage reset",
    description: "Restores all Codex usage windows that are currently eligible.",
  },
  {
    id: "preview-reset-2",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: Math.floor(Date.now() / 1_000) - 2 * 24 * 60 * 60,
    expiresAt: Math.floor(Date.now() / 1_000) + 45 * 24 * 60 * 60,
    title: null,
    description: null,
  },
];

const server = new MiniAppServer({
  host: "0.0.0.0",
  port: Number(process.env.PREVIEW_PORT ?? "8787"),
  botToken,
  allowedUserIds: new Set([userId]),
  assetDirectory: previewAssetDirectory,
  configService: {
    read: async () => snapshot,
    validate: async () => ({ valid: true, issues: [] }),
    update: async () => ({ status: "ok", version: snapshot.version }),
  },
  settings: {
    read: () => ({ remoteClientContext: true }),
    update: async (value) => value,
  },
  runtime: {
    status: () => runtimeStatus,
    usageLimits: async () => ({
      ...usageWindows,
      bankedResets: {
        availableCount: bankedResetCredits.length,
        credits: bankedResetCredits,
      },
    }),
    applyBankedReset: async (creditId) => {
      const available = bankedResetCredits.some((credit) => credit.id === creditId);
      if (!available) return "noCredit";
      bankedResetCredits = bankedResetCredits.filter((credit) => credit.id !== creditId);
      usageWindows = {
        weekly: {
          remainingPercent: 100,
          resetsAt: Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60,
        },
        fiveHour: {
          remainingPercent: 100,
          resetsAt: Math.floor(Date.now() / 1_000) + 5 * 60 * 60,
        },
      };
      return "reset";
    },
    skills: () => skills,
    browseSkill: async (_name, path) => skillResource(path),
    afterConfigWrite: async () => runtimeStatus,
    reload: async () => runtimeStatus,
    restart: async () => runtimeStatus,
  },
  logger: {
    debug() {},
    error() {},
    info() {},
    warn() {},
  },
});

await server.start();
process.stdout.write("Mini App preview ready.\n");

const shutdown = async () => {
  await server.stop();
  await rm(previewAssetDirectory, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function skillResource(path) {
  if (path === "") {
    return {
      type: "directory",
      path,
      entries: [
        { name: "agents", path: "agents", type: "directory", size: null },
        { name: "assets", path: "assets", type: "directory", size: null },
        { name: "references", path: "references", type: "directory", size: null },
      ],
    };
  }
  if (path === "SKILL.md") {
    const content = `---
name: imagegen
description: Generate or edit raster images for projects.
---

# Image Generation Skill

Generates or edits images for the current project.

## Top-level modes and rules

This skill has exactly two top-level modes:

- Create a new image.
- Edit an existing image.

\`\`\`text
Long unbroken preview value:
abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz
\`\`\`
`;
    return {
      type: "file",
      path,
      size: Buffer.byteLength(content),
      mediaType: "text/markdown",
      encoding: "utf8",
      content,
    };
  }
  return { type: "directory", path, entries: [] };
}

function signedInitData(token, allowedUserId) {
  const fields = new Map([
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
    ["query_id", "AAEAAAE"],
    ["user", JSON.stringify({ id: allowedUserId, first_name: "Preview" })],
  ]);
  const dataCheckString = [...fields.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]).toString();
}
