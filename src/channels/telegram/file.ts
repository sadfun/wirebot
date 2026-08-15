import { constants, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Api } from "grammy";
import type { TelegramFileReference } from "./message.js";

const telegramCloudDownloadLimit = 20 * 1_024 * 1_024;

export class TelegramFileDownloadError extends Error {
  public readonly userMessage: string;

  public constructor(message: string, userMessage: string) {
    super(message);
    this.name = "TelegramFileDownloadError";
    this.userMessage = userMessage;
  }
}

interface DownloadOptions {
  readonly api: Api;
  readonly apiRoot: string;
  readonly botToken: string;
  readonly directory: string;
  readonly index: number;
}

export async function downloadTelegramFile(
  reference: TelegramFileReference,
  options: DownloadOptions,
): Promise<string> {
  if (isTelegramCloud(options.apiRoot) && (reference.size ?? 0) > telegramCloudDownloadLimit) {
    throw new TelegramFileDownloadError(
      `${reference.description} exceeds Telegram's cloud download limit`,
      "it is larger than Telegram's 20 MB cloud Bot API download limit; a local Bot API server is required",
    );
  }

  const file = await options.api.getFile(reference.fileId);
  if (file.file_path === undefined) {
    throw new TelegramFileDownloadError(
      `Telegram did not return a path for ${reference.description}`,
      "Telegram did not make the file downloadable",
    );
  }

  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const target = join(
    options.directory,
    `${String(options.index + 1).padStart(2, "0")}-${safeName(reference.suggestedName, file.file_path)}`,
  );

  if (isAbsolute(file.file_path)) {
    await copyFile(file.file_path, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return target;
  }

  const url = `${options.apiRoot}/file/bot${options.botToken}/${encodeFilePath(file.file_path)}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new TelegramFileDownloadError(
      `The download request for ${reference.description} failed`,
      "Telegram's file download request failed",
    );
  }
  if (!response.ok || response.body === null) {
    throw new TelegramFileDownloadError(
      `Telegram returned HTTP ${response.status} for ${reference.description}`,
      `Telegram's file server returned HTTP ${response.status}`,
    );
  }

  try {
    await pipeline(
      Readable.from(response.body),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    return target;
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

function isTelegramCloud(apiRoot: string): boolean {
  try {
    return new URL(apiRoot).hostname === "api.telegram.org";
  } catch {
    return false;
  }
}

function safeName(suggestedName: string, filePath: string): string {
  const suggested = basename(suggestedName).replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const fallbackExtension = extname(filePath).replaceAll(/[^A-Za-z0-9.]/g, "");
  const name =
    suggested.length === 0 || suggested === "." || suggested === ".." ? "attachment" : suggested;
  const withExtension =
    extname(name).length === 0 && fallbackExtension.length > 0
      ? `${name}${fallbackExtension}`
      : name;
  return withExtension.slice(-120);
}

function encodeFilePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}
