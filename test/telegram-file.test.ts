import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadTelegramFile,
  type TelegramFileDownloadError,
} from "../src/channels/telegram/file.js";
import type { TelegramFileReference } from "../src/channels/telegram/message.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("downloadTelegramFile", () => {
  it("downloads into the attachment directory without exposing a hostile filename", async () => {
    const directory = await temporaryDirectory();
    const api = apiReturning({
      file_id: "file-1",
      file_unique_id: "unique-1",
      file_path: "photos/server-name.jpg",
    });
    const fetch = vi.fn(async () => new Response("image bytes"));

    const path = await downloadTelegramFile(reference({ suggestedName: "../../portrait.jpg" }), {
      api,
      apiRoot: "https://api.telegram.org",
      botToken: "123:secret-token",
      directory,
      index: 0,
      fetch,
    });

    expect(resolve(path).startsWith(`${resolve(directory)}${sep}`)).toBe(true);
    expect(basename(path)).toBe("01-portrait.jpg");
    expect(await readFile(path, "utf8")).toBe("image bytes");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123:secret-token/photos/server-name.jpg",
    );
  });

  it("copies absolute paths returned by a local Bot API server", async () => {
    const directory = await temporaryDirectory();
    const source = join(await temporaryDirectory(), "voice.ogg");
    await writeFile(source, "voice bytes");
    const api = apiReturning({
      file_id: "file-1",
      file_unique_id: "unique-1",
      file_path: source,
    });

    const path = await downloadTelegramFile(reference({ suggestedName: "voice.ogg" }), {
      api,
      apiRoot: "http://127.0.0.1:8081",
      botToken: "123:secret-token",
      directory,
      index: 2,
    });

    expect(basename(path)).toBe("03-voice.ogg");
    expect(await readFile(path, "utf8")).toBe("voice bytes");
  });

  it("reports the cloud Bot API limit before requesting an oversized file", async () => {
    const api = apiReturning({ file_id: "file-1", file_unique_id: "unique-1" });

    await expect(
      downloadTelegramFile(reference({ size: 21 * 1_024 * 1_024 }), {
        api,
        apiRoot: "https://api.telegram.org",
        botToken: "123:secret-token",
        directory: await temporaryDirectory(),
        index: 0,
      }),
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("20 MB"),
    } satisfies Partial<TelegramFileDownloadError>);
    expect(api.getFile).not.toHaveBeenCalled();
  });
});

function reference(overrides: Partial<TelegramFileReference> = {}): TelegramFileReference {
  return {
    fileId: "file-1",
    uniqueId: "unique-1",
    description: "Telegram photo",
    suggestedName: "photo.jpg",
    mimeType: "image/jpeg",
    size: 12,
    nativeImage: true,
    ...overrides,
  };
}

function apiReturning(file: Awaited<ReturnType<Api["getFile"]>>): Api {
  return { getFile: vi.fn(async () => file) } as unknown as Api;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wirebot-telegram-test-"));
  temporaryDirectories.push(path);
  return path;
}
