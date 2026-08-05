import { describe, expect, it } from "vitest";
import { createRemoteClientContext, createTurnInput } from "../src/codex/service.js";

describe("createTurnInput", () => {
  it("keeps the existing text-only protocol shape", () => {
    expect(createTurnInput("hello", "telegram", [])).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("uses native localImage inputs for supported Telegram images", () => {
    expect(
      createTurnInput("What is in this?", "telegram", [
        { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
        { kind: "image", path: "/workspace/sticker.webp", description: "Telegram sticker" },
      ]),
    ).toEqual([
      { type: "text", text: "What is in this?", text_elements: [] },
      { type: "localImage", path: "/workspace/photo.jpg" },
      { type: "localImage", path: "/workspace/sticker.webp" },
    ]);
  });

  it("references generic files in text instead of inventing a protocol input type", () => {
    expect(
      createTurnInput("Summarize these", "telegram", [
        { kind: "file", path: "/workspace/clip.mp4", description: "Telegram video" },
        { kind: "image", path: "/workspace/cover.jpg", description: "Video thumbnail" },
      ]),
    ).toEqual([
      {
        type: "text",
        text: `Summarize these

Telegram files available in the local workspace:
- Telegram video: "/workspace/clip.mp4"`,
        text_elements: [],
      },
      { type: "localImage", path: "/workspace/cover.jpg" },
    ]);
  });

  it("keeps the original voice attachment alongside its transcript", () => {
    expect(
      createTurnInput("Voice message transcript:\nHello Wirebot.", "telegram", [
        {
          kind: "voice",
          path: "/workspace/voice.ogg",
          description: "Telegram voice message",
        },
      ]),
    ).toEqual([
      {
        type: "text",
        text: `Voice message transcript:
Hello Wirebot.

Telegram files available in the local workspace:
- Telegram voice message: "/workspace/voice.ogg"`,
        text_elements: [],
      },
    ]);
  });

  it("uses the current connector in file context", () => {
    expect(
      createTurnInput("Summarize this", "discord", [
        { kind: "file", path: "/workspace/report.pdf", description: "Discord document" },
      ]),
    ).toEqual([
      {
        type: "text",
        text: `Summarize this

Discord files available in the local workspace:
- Discord document: "/workspace/report.pdf"`,
        text_elements: [],
      },
    ]);
  });
});

describe("createRemoteClientContext", () => {
  it("describes the current connector as application context", () => {
    const telegram = createRemoteClientContext("telegram");
    const discord = createRemoteClientContext("discord");

    expect(telegram["wirebot.remote-client"]).toMatchObject({
      kind: "application",
      value: expect.stringContaining("reads and replies through Telegram"),
    });
    expect(discord["wirebot.remote-client"]).toMatchObject({
      kind: "application",
      value: expect.stringContaining("reads and replies through Discord"),
    });
    expect(discord["wirebot.remote-client"]?.value).not.toContain("Telegram");
  });
});
