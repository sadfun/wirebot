import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGptVoiceTranscriber } from "../src/transcription/service.js";
import type { TranscriptionTransport } from "../src/transcription/transport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("ChatGptVoiceTranscriber", () => {
  it("uses a current Codex ChatGPT credential without refreshing it", async () => {
    const codexHome = await temporaryCodexHome(tokenWithExpiration(Date.now() + 60 * 60_000));
    const transport = fakeTransport(async () => ({
      status: 200,
      body: JSON.stringify({ text: "  Hello from Telegram.  ", asset_pointer: "ignored" }),
    }));
    const refresh = vi.fn(async () => undefined);
    const transcriber = new ChatGptVoiceTranscriber(codexHome, transport, refresh);

    await expect(transcriber.transcribe("/workspace/voice.ogg")).resolves.toBe(
      "Hello from Telegram.",
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(transport.transcribe).toHaveBeenCalledWith({
      path: "/workspace/voice.ogg",
      accessToken: expect.any(String),
      accountId: "account-1",
    });
  });

  it("asks app-server for a native refresh when the access token is expiring", async () => {
    const codexHome = await temporaryCodexHome(tokenWithExpiration(Date.now() + 30_000));
    const refreshedToken = tokenWithExpiration(Date.now() + 60 * 60_000, "refreshed");
    const refresh = vi.fn(async () => {
      await writeAuth(codexHome, refreshedToken);
    });
    const transport = fakeTransport(async () => ({
      status: 200,
      body: JSON.stringify({ text: "Fresh credentials" }),
    }));
    const transcriber = new ChatGptVoiceTranscriber(codexHome, transport, refresh);

    await expect(transcriber.transcribe("/workspace/voice.ogg")).resolves.toBe("Fresh credentials");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transport.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: refreshedToken }),
    );
  });

  it("refreshes through app-server and retries once after a 401", async () => {
    const originalToken = tokenWithExpiration(Date.now() + 60 * 60_000, "original");
    const refreshedToken = tokenWithExpiration(Date.now() + 60 * 60_000, "refreshed");
    const codexHome = await temporaryCodexHome(originalToken);
    const refresh = vi.fn(async () => {
      await writeAuth(codexHome, refreshedToken);
    });
    const transport = fakeTransport(
      vi
        .fn()
        .mockResolvedValueOnce({ status: 401, body: "unauthorized" })
        .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ text: "Retried" }) }),
    );
    const transcriber = new ChatGptVoiceTranscriber(codexHome, transport, refresh);

    await expect(transcriber.transcribe("/workspace/voice.ogg")).resolves.toBe("Retried");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transport.transcribe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accessToken: originalToken }),
    );
    expect(transport.transcribe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: refreshedToken }),
    );
  });
});

function fakeTransport(
  implementation: TranscriptionTransport["transcribe"],
): TranscriptionTransport & { transcribe: ReturnType<typeof vi.fn> } {
  return { transcribe: vi.fn(implementation) };
}

async function temporaryCodexHome(accessToken: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-transcription-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  await writeAuth(directory, accessToken);
  return directory;
}

async function writeAuth(codexHome: string, accessToken: string): Promise<void> {
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        account_id: "account-1",
      },
    }),
    { mode: 0o600 },
  );
}

function tokenWithExpiration(expiration: number, marker = "token"): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiration / 1_000) })).toString(
    "base64url",
  );
  return `${marker}.${payload}.signature`;
}
