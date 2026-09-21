import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/shared/logger.js";
import { GithubWebhooks, githubHookSchema, verifyGithubSignature } from "../src/webhooks/github.js";

const secret = "a".repeat(64);
const hook = githubHookSchema.parse({
  id: "maintenance",
  secret,
  repository: "owner/repo",
  events: ["issue_comment", "workflow_run"],
  conversationKey: "telegram:123:0",
  threadId: "existing-thread",
  owner: { provider: "telegram", resource: "user", id: "123" },
  deliveryTarget: { provider: "telegram", resource: "destination", id: "chat:123" },
  prompt: "Read current PR state. Wait for explicit approval.",
});
async function fixture(path?: string, initiallyBusy = true) {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-hooks-"));
  const file = path ?? join(directory, "queue.json");
  const turns: unknown[] = [];
  const messages: unknown[] = [];
  let busy = initiallyBusy;
  const engine = new GithubWebhooks({
    hooks: [hook],
    path: file,
    logger: new Logger("error"),
    codex: {
      tryAcquireBackground: () =>
        busy ? { acquired: false, reason: "Busy" } : { acquired: true, release: () => {} },
      runScheduledTurn: async (request) => {
        turns.push(request);
        return {
          threadId: "existing-thread",
          turnId: "turn-1",
          rawText: JSON.stringify({ notify: true, message: "Ready for review" }),
          attachments: [],
          unavailableAttachments: [],
          dispose: async () => {},
        };
      },
    },
    channels: [
      {
        name: "telegram",
        isAuthorized: () => true,
        start: async () => {},
        stop: async () => {},
        publish: async (target, message) => {
          messages.push({ target, message });
          return { publishedMessages: [] };
        },
      },
    ],
  });
  await engine.start();
  const server = createServer((req, res) => {
    void engine.handle("maintenance", req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  return {
    engine,
    turns,
    messages,
    file,
    setBusy: (value: boolean) => {
      busy = value;
    },
    send: async (
      payload: unknown,
      opts: { event?: string; id?: string; signature?: string } = {},
    ) => {
      const body = JSON.stringify(payload);
      return await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body,
        headers: {
          "x-github-event": opts.event ?? "issue_comment",
          "x-github-delivery": opts.id ?? "delivery-1",
          "x-hub-signature-256":
            opts.signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
      });
    },
    close: async () => {
      await engine.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const payload = {
  action: "created",
  repository: { full_name: "owner/repo" },
  issue: { number: 16, pull_request: {} },
  comment: { body: "untrusted comment text" },
};

test("GitHub signature validation uses the official test vector and rejects tampering", () => {
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  expect(
    verifyGithubSignature("It's a Secret to Everybody", Buffer.from("Hello, World!"), signature),
  ).toBe(true);
  expect(
    verifyGithubSignature("It's a Secret to Everybody", Buffer.from("Tampered!"), signature),
  ).toBe(false);
  expect(verifyGithubSignature(secret, Buffer.from("x"), "sha256=bad")).toBe(false);
});

test("rejects forged and cross-repository events and ignores non-actionable deliveries", async () => {
  const f = await fixture();
  try {
    expect((await f.send(payload, { signature: "sha256=bad" })).status).toBe(401);
    expect((await f.send({ ...payload, repository: { full_name: "attacker/repo" } })).status).toBe(
      403,
    );
    expect((await f.send(payload, { event: "ping" })).status).toBe(200);
    expect(await (await f.send(payload, { event: "workflow_run" })).json()).toEqual({
      message: "Ignored action",
    });
    expect(await (await f.send({ ...payload, issue: { number: 1 } })).json()).toEqual({
      message: "Ignored issue",
    });
    expect(f.turns).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("persists busy-conversation events, deduplicates replays, resumes exact thread after restart", async () => {
  const f = await fixture();
  let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    expect(await (await f.send(payload)).json()).toEqual({ message: "queued" });
    expect(await (await f.send(payload)).json()).toEqual({ message: "duplicate" });
    expect(await (await f.send(payload, { id: "changed-header" })).json()).toEqual({
      message: "duplicate",
    });
    expect(f.turns).toHaveLength(0);
    expect(JSON.parse(await readFile(f.file, "utf8"))[0].status).toBe("pending");
    await f.engine.stop();
    resumed = await fixture(f.file, false);
    resumed.setBusy(false);
    for (let i = 0; i < 100 && resumed.messages.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumed.turns).toHaveLength(1);
    const turn = resumed.turns[0] as { thread: unknown; prompt: string; invocation: unknown };
    expect(turn.thread).toEqual({ mode: "existing", threadId: "existing-thread" });
    expect(turn.prompt).not.toContain("untrusted comment text");
    expect(turn.invocation).toEqual({ owner: hook.owner, deliveryTarget: hook.deliveryTarget });
    expect(resumed.messages).toHaveLength(1);
  } finally {
    await resumed?.close();
    await f.close();
  }
});
