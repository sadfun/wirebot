import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../shared/logger.js";

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
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

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
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
