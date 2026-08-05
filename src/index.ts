import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScheduledRunsEngine } from "./automations/engine.js";
import { AutomationStore } from "./automations/store.js";
import { TelegramChannel } from "./channels/telegram/channel.js";
import { CodexConfigService } from "./codex/config-service.js";
import { CodexAppServer } from "./codex/rpc.js";
import { CodexRuntimeService } from "./codex/runtime-service.js";
import { CodexService } from "./codex/service.js";
import { CodexToolchainManager, readPinnedCodexVersion } from "./codex/toolchain.js";
import { loadAppConfig } from "./config/env.js";
import { CodexBridge } from "./core/bridge.js";
import { ConversationStore } from "./core/conversation-store.js";
import { TelexSettingsStore } from "./core/settings-store.js";
import { ensureCloudflared } from "./miniapp/cloudflared.js";
import { MiniAppServer } from "./miniapp/server.js";
import { QuickTunnel } from "./miniapp/tunnel.js";
import { deferred } from "./shared/async.js";
import { errorMessage } from "./shared/errors.js";
import { atomicWriteFile, ensureDirectory } from "./shared/fs.js";
import { Logger } from "./shared/logger.js";
import { readTelexVersion } from "./shared/version.js";
import { ChatGptVoiceTranscriber } from "./transcription/service.js";
import { CurlImpersonateTransport } from "./transcription/transport.js";

const defaultConfig = `# Managed by Telex. You can edit this file or use the Telegram Mini App.
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "live"
cli_auth_credentials_store = "file"
project_root_markers = []
`;

interface Stoppable {
  stop(): Promise<void>;
}

export async function runTelex(): Promise<void> {
  const config = loadAppConfig();
  const logger = new Logger(config.logLevel, { service: "telex" });
  const shutdown = shutdownSignal(logger);
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const bridgeVersion = await readTelexVersion(projectRoot);
  const codexHome = join(config.dataDirectory, "codex-home");
  const outboundDirectory = join(config.dataDirectory, "outbound");
  const toolchainsDirectory = join(config.dataDirectory, "toolchains");
  const statePath = join(config.dataDirectory, "conversations.json");
  const settingsPath = join(config.dataDirectory, "settings.json");
  const automationsPath = join(config.dataDirectory, "automations.json");
  const resources: Stoppable[] = [];

  try {
    await Promise.all([
      ensureDirectory(config.dataDirectory),
      ensureDirectory(config.workspace),
      ensureDirectory(codexHome),
      ensureDirectory(outboundDirectory),
    ]);
    await ensureDefaultCodexConfig(join(codexHome, "config.toml"));

    const pinnedVersion = await readPinnedCodexVersion(projectRoot);
    const toolchains = new CodexToolchainManager(
      toolchainsDirectory,
      logger.child({ component: "toolchain" }),
    );
    const binaryPath = await toolchains.ensureVersion(pinnedVersion);

    const rpc = new CodexAppServer(
      binaryPath,
      config.workspace,
      codexHome,
      bridgeVersion,
      logger.child({ component: "codex-rpc" }),
    );
    resources.push(rpc);
    await rpc.start();

    const conversations = new ConversationStore(
      statePath,
      logger.child({ component: "conversation-store" }),
    );
    const settings = new TelexSettingsStore(
      settingsPath,
      logger.child({ component: "settings-store" }),
    );
    const automations = new AutomationStore(
      automationsPath,
      logger.child({ component: "automation-store" }),
    );
    await Promise.all([conversations.load(), settings.load(), automations.load()]);
    const transcriptionTransport = new CurlImpersonateTransport(
      toolchainsDirectory,
      logger.child({ component: "transcription-transport" }),
    );
    const voiceTranscriber = new ChatGptVoiceTranscriber(
      codexHome,
      transcriptionTransport,
      async () => {
        await rpc.request<unknown>({
          method: "account/read",
          params: { refreshToken: true },
        });
      },
    );
    let liveRuntime: CodexRuntimeService | undefined;
    const codex = new CodexService(
      rpc,
      conversations,
      config.workspace,
      join(codexHome, "generated_images"),
      outboundDirectory,
      logger.child({ component: "codex" }),
      voiceTranscriber,
      () => settings.read().remoteClientContext,
      {
        effectiveSettings: () => liveRuntime?.settings() ?? {},
        explicitSkillInputs: (text) => liveRuntime?.skillInputs(text) ?? [],
      },
    );
    const configService = new CodexConfigService(rpc, config.workspace);
    const runtime = new CodexRuntimeService({
      rpc,
      codex,
      configService,
      workspace: config.workspace,
      logger: logger.child({ component: "codex-runtime" }),
    });
    liveRuntime = runtime;
    resources.push(runtime);
    await runtime.start();

    const miniApp = new MiniAppServer({
      host: config.host,
      port: config.port,
      botToken: config.telegramToken,
      allowedUserIds: config.allowedUserIds,
      configService,
      runtime,
      settings,
      logger: logger.child({ component: "miniapp" }),
    });
    resources.push(miniApp);
    await miniApp.start();

    let publicUrl = config.publicUrl;
    if (publicUrl === undefined && config.tunnelMode === "auto") {
      try {
        const binary = await ensureCloudflared(
          toolchainsDirectory,
          logger.child({ component: "tunnel" }),
        );
        const tunnel = new QuickTunnel({
          host: config.host,
          port: config.port,
          binary,
          logger: logger.child({ component: "tunnel" }),
        });
        publicUrl = await tunnel.start();
        resources.push(tunnel);
        logger.info("The Mini App is exposed through a TryCloudflare quick tunnel", {
          url: publicUrl,
        });
      } catch (error) {
        logger.warn(
          "No PUBLIC_URL and no quick tunnel; the settings Mini App is disabled. Set PUBLIC_URL, or set TELEX_TUNNEL=auto with network access to GitHub releases.",
          { error: errorMessage(error) },
        );
      }
    }

    const telegram = new TelegramChannel(
      config.telegramToken,
      config.telegramApiBase,
      config.allowedUserIds,
      config.telegramPollTimeout,
      join(config.workspace, ".telex", "attachments"),
      logger.child({ component: "telegram" }),
      publicUrl === undefined ? undefined : `${publicUrl}/miniapp`,
    );
    const scheduledRuns = new ScheduledRunsEngine({
      store: automations,
      codex,
      channels: [telegram],
      workspace: config.workspace,
      logger: logger.child({ component: "scheduled-runs" }),
    });
    const bridge = new CodexBridge(
      codex,
      publicUrl,
      logger.child({ component: "bridge" }),
      runtime,
      scheduledRuns,
    );
    resources.push(telegram);
    await telegram.start(bridge.handleMessage);
    resources.push(scheduledRuns);
    await scheduledRuns.start();

    logger.info("Telex is ready", {
      version: bridgeVersion,
      codexVersion: pinnedVersion,
      workspace: config.workspace,
      miniApp: `${config.host}:${config.port}`,
    });

    await shutdown.promise;
  } catch (error) {
    logger.error("Telex failed", error);
    throw error;
  } finally {
    shutdown.dispose();
    await stopAll(resources, logger);
  }
}

async function ensureDefaultCodexConfig(path: string): Promise<void> {
  try {
    await access(path);
    const contents = await readFile(path, "utf8");
    const hasCredentialStore = /^\s*cli_auth_credentials_store\s*=/mu.test(contents);
    const withoutProjectRootMarkers = contents.replace(
      /^\s*project_root_markers\s*=.*(?:\r?\n|$)/gmu,
      "",
    );
    const firstTable = withoutProjectRootMarkers.search(/^\s*\[/mu);
    const root =
      firstTable < 0 ? withoutProjectRootMarkers : withoutProjectRootMarkers.slice(0, firstTable);
    const tables = firstTable < 0 ? "" : withoutProjectRootMarkers.slice(firstTable);
    const credentialStore = hasCredentialStore ? "" : '\ncli_auth_credentials_store = "file"';
    const isolated = `${root.trimEnd()}${credentialStore}\nproject_root_markers = []\n${tables.length === 0 ? "" : `\n${tables.trimStart()}`}`;
    if (isolated !== contents) {
      await atomicWriteFile(path, isolated);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWriteFile(path, defaultConfig);
  }
}

function shutdownSignal(logger: Logger): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
} {
  const shutdown = deferred<void>();
  const handle = (signal: NodeJS.Signals): void => {
    dispose();
    logger.info("Shutting down", { signal });
    shutdown.resolve();
  };
  const dispose = (): void => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  return { promise: shutdown.promise, dispose };
}

async function stopAll(resources: readonly Stoppable[], logger: Logger): Promise<void> {
  for (const resource of resources.toReversed()) {
    try {
      await resource.stop();
    } catch (error) {
      logger.error("Shutdown step failed", error);
    }
  }
}
