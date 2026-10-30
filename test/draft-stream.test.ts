import { describe, expect, it } from "bun:test";
import { DraftReplyStream } from "../src/channels/draft-stream.js";
import type { OutboundAttachment } from "../src/core/channel.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

class RecordingDraftStream extends DraftReplyStream {
  public readonly posts: string[] = [];
  public readonly updates: string[] = [];
  public readonly deletions: string[] = [];
  public readonly attachments: OutboundAttachment[] = [];
  public initialPost = Promise.resolve("message-1");
  public failDeletion = false;

  public constructor(limit = 100) {
    super(new Logger("error"), "Test", limit);
  }

  protected async postInitial(content: string): Promise<string> {
    this.posts.push(content);
    return await this.initialPost;
  }

  protected async post(content: string): Promise<void> {
    this.posts.push(content);
  }

  protected async update(_messageId: string, content: string): Promise<void> {
    this.updates.push(content);
  }

  protected async remove(messageId: string): Promise<void> {
    this.deletions.push(messageId);
    if (this.failDeletion) throw new Error("delete failed");
  }

  protected override async finishExtras(attachments: readonly OutboundAttachment[]): Promise<void> {
    this.attachments.push(...attachments);
  }

  protected renderProgress(block: string): string {
    return block;
  }

  protected renderFinal(text: string): string {
    return text;
  }
}

describe("DraftReplyStream", () => {
  it("posts the final answer as a new message and deletes the thinking block", async () => {
    const stream = new RecordingDraftStream();

    await stream.start({ summary: "Thinking…", actions: [], plan: [] });
    expect(stream.posts).toEqual(["▌ Thinking…"]);

    await stream.complete("Finished");
    expect(stream.updates).toEqual([]);
    expect(stream.posts).toEqual(["▌ Thinking…", "Finished"]);
    expect(stream.deletions).toEqual(["message-1"]);
  });

  it("keeps the thinking placeholder until the complete answer is available", async () => {
    const stream = new RecordingDraftStream();

    await stream.start();
    stream.appendFinal("Working answer");

    expect(stream.posts).toEqual(["▌ Thinking…"]);
    expect(stream.updates).toEqual([]);
  });

  it("posts every chunk of a long answer as a new message", async () => {
    const stream = new RecordingDraftStream(10);

    await stream.start();
    await stream.complete("1234567890abcdefghij");

    expect(stream.updates).toEqual([]);
    expect(stream.posts.slice(1)).toEqual(["1234567890", "abcdefghij"]);
    expect(stream.deletions).toEqual(["message-1"]);
  });

  it("still delivers the answer when the thinking message can't be deleted", async () => {
    const stream = new RecordingDraftStream();

    await stream.start();
    stream.appendFinal("Partial preview");
    stream.failDeletion = true;
    await stream.complete("Finished");

    expect(stream.updates).toEqual([]);
    expect(stream.posts).toEqual(["▌ Thinking…", "Finished"]);
    expect(stream.deletions).toEqual(["message-1"]);
  });

  it("deletes progress when a turn ends without an answer", async () => {
    const stream = new RecordingDraftStream();

    await stream.start({ summary: "Thinking…", actions: [], plan: [] });
    stream.setProgress({ summary: "Waiting for input", actions: [], plan: [] });
    await stream.complete("");
    await stream.complete("");
    stream.setProgress({ summary: "Late progress", actions: [], plan: [] });

    expect(stream.deletions).toEqual(["message-1"]);
    expect(stream.updates).toEqual([]);
    expect(stream.posts).toEqual(["▌ Thinking…"]);
  });

  it("waits for the initial post before deleting and still delivers attachments on deletion failure", async () => {
    const stream = new RecordingDraftStream();
    const initialPost = deferred<string>();
    stream.initialPost = initialPost.promise;
    stream.failDeletion = true;
    const attachments = [{ path: "/tmp/report.pdf", filename: "report.pdf" }];

    const starting = stream.start();
    const completing = stream.complete("", attachments);
    expect(stream.deletions).toEqual([]);
    initialPost.resolve("late-message");
    await Promise.all([starting, completing]);

    expect(stream.deletions).toEqual(["late-message"]);
    expect(stream.attachments).toEqual(attachments);
    expect(stream.updates).toEqual([]);
    expect(stream.posts).toEqual(["▌ Thinking…"]);
  });

  it("sends nothing for an empty answer without a progress message", async () => {
    const stream = new RecordingDraftStream();

    await stream.complete("");

    expect(stream.deletions).toEqual([]);
    expect(stream.updates).toEqual([]);
    expect(stream.posts).toEqual([]);
  });
});
