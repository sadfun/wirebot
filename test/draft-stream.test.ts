import { afterEach, describe, expect, it, jest } from "bun:test";
import { DraftReplyStream } from "../src/channels/draft-stream.js";
import { Logger } from "../src/shared/logger.js";

class RecordingDraftStream extends DraftReplyStream {
  public readonly posts: string[] = [];
  public readonly updates: string[] = [];
  public failUpdates = false;

  public constructor(limit = 100) {
    super(new Logger("error"), "Test", limit);
  }

  protected async postInitial(content: string): Promise<string> {
    this.posts.push(content);
    return "message-1";
  }

  protected async post(content: string): Promise<void> {
    this.posts.push(content);
  }

  protected async update(_messageId: string, content: string): Promise<void> {
    if (this.failUpdates) throw new Error("update failed");
    this.updates.push(content);
  }

  protected renderProgress(block: string): string {
    return block;
  }

  protected renderFinal(text: string): string {
    return text;
  }
}

afterEach(() => {
  jest.useRealTimers();
});

describe("DraftReplyStream", () => {
  it("posts one thinking block and replaces it with the final answer", async () => {
    const stream = new RecordingDraftStream();

    await stream.start({ summary: "Thinking…", actions: [], plan: [] });
    expect(stream.posts).toEqual(["▌ Thinking…"]);

    await stream.complete("Finished");
    expect(stream.updates).toEqual(["Finished"]);
    expect(stream.posts).toEqual(["▌ Thinking…"]);
  });

  it("replaces thinking with answer text while streaming", async () => {
    jest.useFakeTimers();
    const stream = new RecordingDraftStream();

    await stream.start();
    stream.appendFinal("Working answer");
    jest.advanceTimersByTime(1_500);
    await Promise.resolve();

    expect(stream.updates).toEqual(["Working answer▌"]);
  });

  it("posts only overflow chunks after replacing the thinking message", async () => {
    const stream = new RecordingDraftStream(10);

    await stream.start();
    await stream.complete("1234567890abcdefghij");

    expect(stream.updates).toEqual(["1234567890"]);
    expect(stream.posts.slice(1)).toEqual(["abcdefghij"]);
  });

  it("posts the complete answer when replacing the thinking message fails", async () => {
    const stream = new RecordingDraftStream();

    await stream.start();
    stream.failUpdates = true;
    await stream.complete("Finished");

    expect(stream.updates).toEqual([]);
    expect(stream.posts.at(-1)).toBe("Finished");
  });

  it("publishes the latest progress when a turn ends without an answer", async () => {
    const stream = new RecordingDraftStream();

    await stream.start({ summary: "Thinking…", actions: [], plan: [] });
    stream.setProgress({ summary: "Waiting for input", actions: [], plan: [] });
    await stream.complete("");

    expect(stream.updates).toEqual(["▌ Waiting for input"]);
  });
});
