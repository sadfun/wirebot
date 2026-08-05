import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../shared/logger.js";
import { jwtPayload } from "../shared/text.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  TELEGRAM_API_BASE: z.url().default("https://api.telegram.org"),
  TELEGRAM_POLL_TIMEOUT: z.coerce.number().int().min(1).max(50).default(30),
  PUBLIC_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "PUBLIC_URL must use HTTPS")
    .optional(),
  WIREBOT_TUNNEL: z.enum(["auto", "off"]).default("auto"),
  WIREBOT_CONTAINER: z.enum(["0", "1"]).default("0"),
  WIREBOT_DATA_DIR: z.string().min(1).default(".wirebot"),
  WIREBOT_TOOLCHAINS_DIR: z.string().min(1).optional(),
  WIREBOT_ASSETS_DIR: z.string().min(1).optional(),
  CODEX_WORKSPACE: z.string().min(1).default(".wirebot/workspace"),
  CODEX_API_KEY: z.string().min(1).optional(),
  CODEX_CHATGPT_TOKEN: z.string().min(1).optional(),
  CODEX_CHATGPT_ACCOUNT_ID: z.string().min(1).optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Bridge-owned variables (credentials and channel wiring) that must never
 * reach Codex/npm/cloudflared subprocess environments. Kept next to the
 * schema so a new secret variable is scrubbed in the same edit that adds it;
 * `externalProcessEnvironment` in shared/environment.ts consumes this set.
 */
export const bridgeOnlyEnvironmentKeys: ReadonlySet<keyof z.infer<typeof envSchema>> = new Set([
  "CODEX_API_KEY",
  "CODEX_CHATGPT_ACCOUNT_ID",
  "CODEX_CHATGPT_TOKEN",
  "PUBLIC_URL",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_API_BASE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_POLL_TIMEOUT",
] as const);

export interface ChatgptAuthConfig {
  readonly accessToken: string;
  readonly accountId: string;
}

interface AppConfig {
  readonly telegramToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly telegramApiBase: string;
  readonly telegramPollTimeout: number;
  readonly publicUrl: string | undefined;
  readonly tunnelMode: "auto" | "off";
  readonly container: boolean;
  readonly dataDirectory: string;
  readonly toolchainsDirectory: string | undefined;
  readonly assetsDirectory: string | undefined;
  readonly workspace: string;
  readonly codexApiKey: string | undefined;
  readonly codexChatgptAuth: ChatgptAuthConfig | undefined;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(environment);
  const allowedUserIds = new Set(
    parsed.TELEGRAM_ALLOWED_USER_IDS.split(",").map((part) =>
      z.coerce.number().int().positive().safe().parse(part.trim()),
    ),
  );
  const codexChatgptAuth = resolveChatgptAuth(parsed);
  if (parsed.CODEX_API_KEY !== undefined && codexChatgptAuth !== undefined) {
    throw new Error("CODEX_API_KEY and CODEX_CHATGPT_TOKEN are mutually exclusive; set only one");
  }

  return {
    telegramToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedUserIds,
    telegramApiBase: parsed.TELEGRAM_API_BASE.replace(/\/$/, ""),
    telegramPollTimeout: parsed.TELEGRAM_POLL_TIMEOUT,
    publicUrl: parsed.PUBLIC_URL?.replace(/\/$/, ""),
    tunnelMode: parsed.WIREBOT_TUNNEL,
    container: parsed.WIREBOT_CONTAINER === "1",
    dataDirectory: resolve(parsed.WIREBOT_DATA_DIR),
    toolchainsDirectory:
      parsed.WIREBOT_TOOLCHAINS_DIR === undefined
        ? undefined
        : resolve(parsed.WIREBOT_TOOLCHAINS_DIR),
    assetsDirectory:
      parsed.WIREBOT_ASSETS_DIR === undefined ? undefined : resolve(parsed.WIREBOT_ASSETS_DIR),
    workspace: resolve(parsed.CODEX_WORKSPACE),
    codexApiKey: parsed.CODEX_API_KEY,
    codexChatgptAuth,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}

function resolveChatgptAuth(parsed: z.infer<typeof envSchema>): ChatgptAuthConfig | undefined {
  if (parsed.CODEX_CHATGPT_TOKEN === undefined) {
    if (parsed.CODEX_CHATGPT_ACCOUNT_ID !== undefined) {
      throw new Error("CODEX_CHATGPT_ACCOUNT_ID is set but CODEX_CHATGPT_TOKEN is not");
    }
    return undefined;
  }
  const accountId =
    parsed.CODEX_CHATGPT_ACCOUNT_ID ?? chatgptAccountIdFromToken(parsed.CODEX_CHATGPT_TOKEN);
  if (accountId === undefined) {
    throw new Error(
      "CODEX_CHATGPT_TOKEN carries no chatgpt_account_id claim; set CODEX_CHATGPT_ACCOUNT_ID as well",
    );
  }
  return { accessToken: parsed.CODEX_CHATGPT_TOKEN, accountId };
}

function chatgptAccountIdFromToken(accessToken: string): string | undefined {
  const claims = z
    .object({
      "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().min(1) }).loose(),
    })
    .loose()
    .safeParse(jwtPayload(accessToken));
  return claims.success ? claims.data["https://api.openai.com/auth"].chatgpt_account_id : undefined;
}
