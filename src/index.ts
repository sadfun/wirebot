import { join } from "node:path";
import { ScheduledRunsEngine } from "./automations/engine.js";
import { AutomationStore } from "./automations/store.js";
import { SlackChannel } from "./channels/slack/channel.js";
import { TelegramChannel } from "./channels/telegram/channel.js";
import { CodexConfigService } from "./codex/config-service.js";
import { CodexAppServer } from "./codex/rpc.js";
import { CodexRuntimeService } from "./codex/runtime-service.js";
import { CodexService, createContainerEnvironmentContext } from "./codex/service.js";
import { CodexToolchainManager, pinnedCodexVersion } from "./codex/toolchain.js";
import { loadAppConfig } from "./config/env.js";
import { CodexBridge } from "./core/bridge.js";
import { ConversationStore } from "./core/conversation-store.js";
import { WirebotSettingsStore } from "./core/settings-store.js";
import { MiniAppServer } from "./miniapp/server.js";
import { QuickTunnel } from "./miniapp/tunnel.js";
import { deferred } from "./shared/async.js";
import { errorMessage } from "./shared/errors.js";
import { atomicWriteFile, ensureDirectory, readFileIfExists } from "./shared/fs.js";
import { Logger } from "./shared/logger.js";
import { wirebotVersion } from "./shared/version.js";
import { ChatGptVoiceTranscriber } from "./transcription/service.js";
import { CurlImpersonateTransport } from "./transcription/transport.js";

/**
 * Inside the Wirebot container the container boundary is the sandbox, and the
 * agent is expected to manage the whole machine (apt, /usr/local, services),
 * so Codex's own command sandbox is off. Elsewhere the Codex default of
 * workspace-write stays.
 */
function defaultCodexConfig(container: boolean): string {
  return `# Managed by Wirebot. You can edit this file or use a Wirebot settings UI.
approval_policy = "on-request"
sandbox_mode = "${container ? "danger-full-access" : "workspace-write"}"
web_search = "live"
cli_auth_credentials_store = "file"
project_root_markers = []
`;
}

interface Stoppable {
  stop(): Promise<void>;
}

export async function runWirebot(): Promise<void> {
  const config = loadAppConfig();
  const logger = new Logger(config.logLevel, { service: "wirebot" });
  const shutdown = shutdownSignal(logger);
  const codexHome = join(config.dataDirectory, "codex-home");
  const outboundDirectory = join(config.dataDirectory, "outbound");
  const toolchainsDirectory =
    config.toolchainsDirectory ?? join(config.dataDirectory, "toolchains");
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
    await ensureDefaultCodexConfig(join(codexHome, "config.toml"), config.container);

    const toolchains = new CodexToolchainManager(
      toolchainsDirectory,
      logger.child({ component: "toolchain" }),
    );
    const binaryPath = await toolchains.ensureVersion(pinnedCodexVersion);

    const rpc = new CodexAppServer(
      binaryPath,
      config.workspace,
      codexHome,
      wirebotVersion,
      logger.child({ component: "codex-rpc" }),
    );
    resources.push(rpc);
    await rpc.start();

    const conversations = new ConversationStore(
      statePath,
      logger.child({ component: "conversation-store" }),
    );
    const settings = new WirebotSettingsStore(
      settingsPath,
      logger.child({ component: "settings-store" }),
    );
    const automations = new AutomationStore(
      automationsPath,
      logger.child({ component: "automation-store" }),
    );
    await Promise.all([conversations.load(), settings.load(), automations.load()]);
    const chatgptAuth = config.codexChatgptAuth;
    const voiceTranscriber = new ChatGptVoiceTranscriber(
      codexHome,
      new CurlImpersonateTransport(),
      async () => {
        await rpc.request<unknown>({
          method: "account/read",
          params: { refreshToken: true },
        });
      },
      chatgptAuth === undefined ? undefined : () => Promise.resolve(chatgptAuth),
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
        ...(config.container ? { environmentContext: createContainerEnvironmentContext() } : {}),
        ...(chatgptAuth === undefined
          ? {}
          : {
              externalAuthTokens: (request) => {
                logger.warn(
                  "Codex asked to refresh the static CODEX_CHATGPT_TOKEN; returning it unchanged — replace the token and restart if authentication keeps failing",
                  { reason: request.reason },
                );
                return Promise.resolve({
                  accessToken: chatgptAuth.accessToken,
                  chatgptAccountId: chatgptAuth.accountId,
                  chatgptPlanType: null,
                });
              },
            }),
      },
    );
    if (chatgptAuth !== undefined) {
      await codex.loginWithChatgptTokens(chatgptAuth.accessToken, chatgptAuth.accountId);
      logger.info("Codex is authenticated with the ChatGPT token from CODEX_CHATGPT_TOKEN");
    } else if (config.codexApiKey !== undefined) {
      await codex.loginWithApiKey(config.codexApiKey);
      logger.info("Codex is authenticated with the API key from CODEX_API_KEY");
    }
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

    // The Mini App authenticates through Telegram initData, so it only runs
    // when the Telegram connector is configured.
    let miniApp: MiniAppServer | undefined;
    if (config.telegram !== undefined) {
      miniApp = new MiniAppServer({
        host: config.host,
        port: config.port,
        botToken: config.telegram.botToken,
        allowedUserIds: config.telegram.allowedUserIds,
        configService,
        runtime,
        settings,
        logger: logger.child({ component: "miniapp" }),
        ...(config.assetsDirectory === undefined ? {} : { assetDirectory: config.assetsDirectory }),
      });
      resources.push(miniApp);
      await miniApp.start();
    }

    let publicUrl = config.publicUrl;
    if (publicUrl === undefined && config.telegram !== undefined && config.tunnelMode === "auto") {
      try {
        const tunnel = new QuickTunnel({
          host: config.host,
          port: config.port,
          logger: logger.child({ component: "tunnel" }),
        });
        publicUrl = await tunnel.start();
        resources.push(tunnel);
        logger.info("The Mini App is exposed through a TryCloudflare quick tunnel", {
          url: publicUrl,
        });
      } catch (error) {
        logger.warn(
          "The quick tunnel failed to start and no PUBLIC_URL is set; the settings Mini App is disabled. Set PUBLIC_URL, install cloudflared, or check outbound network access to Cloudflare.",
          { error: errorMessage(error) },
        );
      }
    }

    const telegram =
      config.telegram === undefined
        ? undefined
        : new TelegramChannel(
            config.telegram.botToken,
            config.telegramApiBase,
            config.telegram.allowedUserIds,
            config.telegramPollTimeout,
            join(config.workspace, ".wirebot", "attachments"),
            logger.child({ component: "telegram" }),
            publicUrl === undefined ? undefined : `${publicUrl}/miniapp`,
          );
    const slack =
      config.slack === undefined
        ? undefined
        : new SlackChannel(
            config.slack,
            join(config.workspace, ".wirebot", "attachments"),
            logger.child({ component: "slack" }),
            configService,
          );
    const channels = [telegram, slack].filter(
      (channel): channel is NonNullable<typeof channel> => channel !== undefined,
    );
    const scheduledRuns = new ScheduledRunsEngine({
      store: automations,
      codex,
      channels,
      workspace: config.workspace,
      logger: logger.child({ component: "scheduled-runs" }),
    });
    miniApp?.setScheduledRuns(scheduledRuns);
    const bridge = new CodexBridge(
      codex,
      publicUrl,
      logger.child({ component: "bridge" }),
      runtime,
      scheduledRuns,
    );
    for (const channel of channels) {
      resources.push(channel);
      await channel.start(bridge.handleMessage);
    }
    resources.push(scheduledRuns);
    await scheduledRuns.start();

    logger.info("Wirebot is ready", {
      version: wirebotVersion,
      codexVersion: pinnedCodexVersion,
      workspace: config.workspace,
      miniApp: config.telegram === undefined ? "disabled" : `${config.host}:${config.port}`,
      telegram: telegram === undefined ? "disabled" : "enabled",
      slack: slack === undefined ? "disabled" : "enabled",
    });

    await shutdown.promise;
  } catch (error) {
    logger.error("Wirebot failed", error);
    throw error;
  } finally {
    shutdown.dispose();
    await stopAll(resources, logger);
  }
}

async function ensureDefaultCodexConfig(path: string, container: boolean): Promise<void> {
  const contents = await readFileIfExists(path);
  if (contents === undefined) {
    await atomicWriteFile(path, defaultCodexConfig(container));
    return;
  }
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
