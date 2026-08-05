import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "../shared/errors.js";

const telegramUserSchema = z
  .object({
    id: z.number().int().positive().safe(),
    is_bot: z.boolean().optional(),
  })
  .strip();

export interface TelegramInitDataOptions {
  readonly botToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly maxAgeSeconds?: number;
  readonly now?: Date;
}

export interface TelegramInitDataUser {
  readonly id: number;
}

const HASH_LENGTH = 32;
const DEFAULT_MAX_AGE_SECONDS = 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;

/**
 * Verifies Telegram's raw WebApp.initData and throws unless it is freshly
 * signed for an allowlisted human user. The raw string must be passed as-is
 * by the Mini App, not reconstructed client-side.
 */
export function validateTelegramInitData(
  initData: string,
  options: TelegramInitDataOptions,
): TelegramInitDataUser {
  if (initData.length === 0 || initData.length > 16_384) {
    throw new BridgeError("Invalid Telegram initialization data", "MINIAPP_UNAUTHORIZED");
  }

  const parameters = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [key] of parameters) {
    if (seen.has(key)) {
      throw new BridgeError("Duplicate Telegram initialization field", "MINIAPP_UNAUTHORIZED");
    }
    seen.add(key);
  }

  const receivedHash = parameters.get("hash");
  if (receivedHash === null || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    throw new BridgeError("Invalid Telegram initialization signature", "MINIAPP_UNAUTHORIZED");
  }

  const signedFields = [...parameters.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(options.botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(signedFields).digest();
  const receivedHashBytes = Buffer.from(receivedHash, "hex");
  if (
    receivedHashBytes.length !== HASH_LENGTH ||
    !timingSafeEqual(expectedHash, receivedHashBytes)
  ) {
    throw new BridgeError("Invalid Telegram initialization signature", "MINIAPP_UNAUTHORIZED");
  }

  const authDate = parseUnixTimestamp(parameters.get("auth_date"));
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (
    !Number.isSafeInteger(nowSeconds) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds <= 0 ||
    authDate > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    nowSeconds - authDate > maxAgeSeconds
  ) {
    throw new BridgeError("Expired Telegram initialization data", "MINIAPP_UNAUTHORIZED");
  }

  const rawUser = parameters.get("user");
  if (rawUser === null) {
    throw new BridgeError("Telegram user is missing", "MINIAPP_UNAUTHORIZED");
  }

  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(rawUser);
  } catch {
    throw new BridgeError("Invalid Telegram user", "MINIAPP_UNAUTHORIZED");
  }
  const userResult = telegramUserSchema.safeParse(parsedUser);
  if (!userResult.success) {
    throw new BridgeError("Invalid Telegram user", "MINIAPP_UNAUTHORIZED");
  }
  const user = userResult.data;
  if (user.is_bot === true || !options.allowedUserIds.has(user.id)) {
    throw new BridgeError("This Telegram user is not allowed", "MINIAPP_FORBIDDEN");
  }
  return { id: user.id };
}

function parseUnixTimestamp(value: string | null): number {
  if (value === null || !/^\d{1,12}$/.test(value)) {
    throw new BridgeError("Invalid Telegram authentication date", "MINIAPP_UNAUTHORIZED");
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new BridgeError("Invalid Telegram authentication date", "MINIAPP_UNAUTHORIZED");
  }
  return timestamp;
}
