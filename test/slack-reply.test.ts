import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
  SlackEphemeralOptions,
  SlackMessagingApi,
  SlackPostOptions,
  SlackUpdateOptions,
  SlackUploadOptions,
} from "../src/channels/slack/reply.js";
import {
  choicePromptText,
  publishSlackMessage,
  SlackReplyStream,
  SlackResponder,
} from "../src/channels/slack/reply.js";
import { Logger } from "../src/shared/logger.js";

afterEach(() => {
  vi.useRealTimers();
});

interface RecordedCalls {
  readonly posts: SlackPostOptions[];
  readonly updates: SlackUpdateOptions[];
  readonly uploads: SlackUploadOptions[];
  readonly ephemerals: SlackEphemeralOptions[];
}

function fakeApi(overrides: Partial<SlackMessagingApi> = {}): {
  api: SlackMessagingApi;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = { posts: [], updates: [], uploads: [], ephemerals: [] };
  let sequence = 0;
  const api: SlackMessagingApi = {
    async postMessage(options) {
      calls.posts.push(options);
      sequence += 1;
      return `170000000${sequence}.000100`;
    },
    async updateMessage(options) {
      calls.updates.push(options);
    },
    async uploadFile(options) {
      calls.uploads.push(options);
    },
    async postEphemeral(options) {
      calls.ephemerals.push(options);
    },
    async fetchThreadReplies() {
      return [];
    },
    ...overrides,
  };
  return { api, calls };
}

function responder(
  api: SlackMessagingApi,
  fallbackUrl?: string,
  fetchImplementation?: typeof fetch,
) {
  return new SlackResponder(
    api,
    "C1",
    "1699.5",
    "U1",
    async () => "decline",
    new Logger("error"),
    fallbackUrl,
    fetchImplementation,
  );
}

describe("SlackResponder", () => {
  it("posts converted mrkdwn into the reply thread", async () => {
    const { api, calls } = fakeApi();
    await responder(api).sendText("**done** with [it](https://x.dev)");
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatchObject({
      channel: "C1",
      threadTs: "1699.5",
      text: "*done* with <https://x.dev|it>",
    });
  });

  it("appends a URL button as a follow-up block message", async () => {
    const { api, calls } = fakeApi();
    await responder(api).sendText("Open settings", {
      button: { label: "Open", kind: "url", url: "https://example.com" },
    });
    expect(calls.posts).toHaveLength(2);
    const buttonPost = calls.posts[1];
    expect(buttonPost?.blocks?.[0]).toMatchObject({
      type: "actions",
      elements: [
        expect.objectContaining({ action_id: "wirebot_link", url: "https://example.com" }),
      ],
    });
  });

  it("splits long replies into multiple messages", async () => {
    const { api, calls } = fakeApi();
    await responder(api).sendText(`${"a".repeat(12_500)}\n${"b".repeat(300)}`);
    expect(calls.posts.length).toBeGreaterThan(1);
  });

  it("falls back to the response webhook when posting fails", async () => {
    const { api } = fakeApi({
      postMessage: async () => {
        throw new Error("not_in_channel");
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    await responder(api, "https://hooks.slack.com/respond", fetchMock).sendText("hello");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.slack.com/respond");
    expect(JSON.parse(String(init?.body))).toEqual({
      response_type: "ephemeral",
      text: "hello",
    });
  });

  it("sends only unposted chunks through the webhook fallback", async () => {
    let attempts = 0;
    const { api, calls } = fakeApi({
      postMessage: async (options) => {
        attempts += 1;
        if (attempts > 1) throw new Error("rate_limited");
        calls.posts.push(options);
        return "1700.1";
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    const text = `${"a".repeat(12_500)}\n${"b".repeat(300)}`;
    await responder(api, "https://hooks.slack.com/respond", fetchMock).sendText(text);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]?.text).toBe("a".repeat(3_900));
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { text: string };
    // The ephemeral webhook fallback carries at most one message worth of text.
    expect(body.text).toBe("a".repeat(3_900));
  });
});

describe("SlackReplyStream", () => {
  function stream(api: SlackMessagingApi) {
    return new SlackReplyStream(api, "C1", "1699.5", new Logger("error"));
  }

  it("freezes the progress message and posts the answer separately", async () => {
    const { api, calls } = fakeApi();
    const reply = stream(api);
    await reply.start({ summary: "Reading files", actions: [], plan: [] });
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]?.text).toContain("Reading files");
    expect(calls.posts[0]?.text).toContain("▌");
    await reply.complete("All **done**");
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.text).toContain("Reading files");
    expect(calls.updates[0]?.text.endsWith("▌")).toBe(false);
    expect(calls.posts).toHaveLength(2);
    expect(calls.posts[1]).toMatchObject({ channel: "C1", threadTs: "1699.5", text: "All *done*" });
  });

  it("delivers the remaining chunks even when one post fails", async () => {
    let posted = 0;
    const { api, calls } = fakeApi({
      postMessage: async (options) => {
        posted += 1;
        if (posted === 2) throw new Error("msg_too_long");
        calls.posts.push(options);
        return `1700.${posted}`;
      },
    });
    const reply = stream(api);
    await reply.start();
    await reply.complete(`${"a".repeat(4_000)}\n${"b".repeat(4_000)}\n${"c".repeat(300)}`);
    const texts = calls.posts.map((post) => post.text);
    expect(texts.some((text) => text.includes("c".repeat(300)))).toBe(true);
    expect(texts.at(-1)).toContain("could not be delivered");
  });

  it("throttles draft updates", async () => {
    vi.useFakeTimers();
    const { api, calls } = fakeApi();
    const reply = stream(api);
    await reply.start();
    reply.appendFinal("first ");
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    reply.appendFinal("second ");
    reply.appendFinal("third ");
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(calls.updates.length).toBeGreaterThan(0);
    expect(calls.updates.length).toBeLessThan(3);
    const lastUpdate = calls.updates.at(-1);
    expect(lastUpdate?.text).toContain("third");
  });

  it("freezes the progress text when the turn ends without output", async () => {
    const { api, calls } = fakeApi();
    const reply = stream(api);
    await reply.start({ summary: "Working", actions: [], plan: [] });
    await reply.complete("");
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.text).toContain("Working");
    expect(calls.updates[0]?.text.endsWith("▌")).toBe(false);
  });

  it("posts the final text directly when no progress message exists", async () => {
    let attempts = 0;
    const { api, calls } = fakeApi();
    api.postMessage = async (options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporarily unavailable");
      calls.posts.push(options);
      return "1700.1";
    };
    const reply = stream(api);
    await reply.start();
    await reply.complete("result");
    expect(calls.updates).toHaveLength(0);
    expect(calls.posts.map((post) => post.text)).toContain("result");
  });

  it("uploads attachments and reports failures", async () => {
    const { api, calls } = fakeApi({
      uploadFile: async (options) => {
        if (options.filename === "bad.bin") throw new Error("upload_error");
        calls.uploads.push(options);
      },
    });
    const reply = stream(api);
    await reply.start();
    await reply.complete("done", [
      { path: "/tmp/a/good.txt", filename: "good.txt" },
      { path: "/tmp/a/bad.bin", filename: "bad.bin" },
    ]);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]).toMatchObject({ filename: "good.txt", threadTs: "1699.5" });
    const notice = calls.posts.at(-1);
    expect(notice?.text).toContain("bad.bin");
  });
});

describe("choicePromptText", () => {
  it("escapes Slack entities in the prompt and option details", () => {
    const text = choicePromptText("Codex wants to run: sort data.txt > out.txt", [
      { id: "approve", label: "Approve", description: "runs cat <file> & more" },
    ]);
    expect(text).toBe(
      "Codex wants to run: sort data.txt &gt; out.txt\n\nApprove: runs cat &lt;file&gt; &amp; more",
    );
  });

  it("truncates very long prompts to Slack's section limit", () => {
    const text = choicePromptText("p".repeat(4_000), []);
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("publishSlackMessage", () => {
  it("posts chunks, action buttons, and attachments to the target", async () => {
    const { api, calls } = fakeApi();
    const published = await publishSlackMessage(
      api,
      { channel: "C7", channelType: "channel", threadTs: "1690.1" },
      {
        text: "# Report\nAll good",
        actions: [{ label: "Continue", command: { name: "continue", args: "run-1" } }],
        attachments: [{ path: "/tmp/r/report.csv", filename: "report.csv" }],
      },
      new Logger("error"),
    );
    expect(calls.posts[0]).toMatchObject({ channel: "C7", threadTs: "1690.1" });
    expect(calls.posts[0]?.text).toContain("*Report*");
    const buttons = calls.posts[1];
    expect(buttons?.blocks?.[0]).toMatchObject({
      type: "actions",
      elements: [expect.objectContaining({ value: "tx:continue:run-1" })],
    });
    expect(calls.uploads).toHaveLength(1);
    expect(published.length).toBeGreaterThanOrEqual(2);
  });
});
