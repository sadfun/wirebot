import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexDynamicTool, CodexDynamicToolContext } from "../src/codex/service.js";
import { silentStream } from "../src/codex/thread-session.js";
import { ThreadMessages } from "../src/core/thread-messages.js";
import { Logger } from "../src/shared/logger.js";
import { startTestApp } from "./fixtures/web-app.js";

const context: CodexDynamicToolContext = {
  connector: "telegram",
  conversationKey: "chat",
  threadId: "thread-A",
  turnId: "turn",
  callId: "call",
  owner: { provider: "telegram", resource: "user", id: "123" },
  deliveryTarget: { provider: "telegram", resource: "destination", id: "chat:123" },
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-message-tokens-"));
  const path = join(directory, "tokens.json");
  let tool: CodexDynamicTool;
  let authorized = true;
  const calls: unknown[][] = [];
  const make = () =>
    new ThreadMessages({
      path,
      workspace: directory,
      logger: new Logger("error"),
      codex: {
        registerDynamicTool: (value) => {
          tool = value;
        },
        runTurn: async (...args) => {
          calls.push(args);
        },
      },
      channels: [
        {
          name: "telegram",
          isAuthorized: () => authorized,
          createResponder: async () => ({
            createStream: () => silentStream,
            sendText: async () => {},
            askChoice: async () => "decline",
          }),
          start: async () => {},
          stop: async () => {},
          publish: async () => ({ publishedMessages: [] }),
        },
      ],
    });
  let messages = make();
  await messages.load();
  return {
    path,
    directory,
    calls,
    get messages() {
      return messages;
    },
    manage: async (input: Parameters<CodexDynamicTool["execute"]>[0], ctx = context) =>
      await tool.execute(input, ctx),
    reload: async () => {
      messages = make();
      await messages.load();
    },
    revokeOwner: () => {
      authorized = false;
    },
    close: async () => await rm(directory, { recursive: true, force: true }),
  };
}

test("tokens persist hashed, bind the real thread, and enforce scoped registration/revocation", async () => {
  const f = await fixture();
  try {
    const token = (await f.manage({ action: "register" })) as {
      token: string;
      tokenId: string;
      threadId: string;
    };
    expect(token.threadId).toBe("thread-A");
    expect(await readFile(f.path, "utf8")).not.toContain(token.token);
    await expect(
      f.manage({ action: "register" }, { ...context, externalMessage: true }),
    ).rejects.toThrow();
    await expect(
      f.manage({ action: "revoke", tokenId: token.tokenId }, { ...context, threadId: "thread-B" }),
    ).rejects.toThrow();
    await f.reload();
    await f.messages.submit({ token: token.token, text: "hello" });
    expect(f.calls[0]?.[8]).toMatchObject({ threadId: "thread-A" });
    expect(f.calls[0]?.[6]).toMatchObject({
      externalMessage: true,
      owner: context.owner,
      deliveryTarget: context.deliveryTarget,
    });
    const queued = f.calls[0]?.[8] as { authorize: () => Promise<void> };
    await f.manage({ action: "revoke", tokenId: token.tokenId });
    await expect(queued.authorize()).rejects.toThrow();
    await f.reload();
    await expect(f.messages.submit({ token: token.token, text: "revoked" })).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("uploads actual bytes; refuses traversal, server paths, invalid base64 and revoked owners", async () => {
  const f = await fixture();
  try {
    const { token } = (await f.manage({ action: "register" })) as { token: string };
    const file = {
      name: "report.txt",
      base64: Buffer.from("private attachment\n").toString("base64"),
    };
    await f.messages.submit({ token, text: "", files: [file] });
    const attachments = f.calls[0]?.[5] as { path: string; kind: string }[];
    expect(
      attachments[0]?.path.startsWith(join(f.directory, ".wirebot", "attachments", "api")),
    ).toBe(true);
    expect(await readFile(attachments[0]?.path ?? "", "utf8")).toBe("private attachment\n");
    for (const bad of [
      { ...file, name: "../secret" },
      { ...file, path: "/etc/passwd" },
      { ...file, base64: "not base64!" },
    ]) {
      await expect(f.messages.submit({ token, text: "", files: [bad] })).rejects.toThrow();
    }
    await expect(
      f.messages.submit({ token, text: "redirect", threadId: "thread-B" }),
    ).rejects.toThrow();
    f.revokeOwner();
    await expect(f.messages.submit({ token, text: "blocked" })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("HTTP submissions use only the scoped token and never accept browser login as a substitute", async () => {
  const app = await startTestApp();
  const f = await fixture();
  app.server.setMessageHandler((input) => f.messages.submit(input));
  try {
    const { token } = (await f.manage({ action: "register" })) as { token: string };
    const post = async (input: unknown) =>
      await fetch(new URL("/api/messages", app.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    expect((await post({ token: "a".repeat(43), text: "unauthorized" })).status).toBe(401);
    expect((await post({ text: "missing token" })).status).toBe(400);
    const response = await post({
      token,
      text: "hello",
      files: [{ name: "report.txt", base64: "SGVsbG8=" }],
    });
    expect(response.status).toBe(202);
    expect(f.calls).toHaveLength(1);
    f.revokeOwner();
    expect((await post({ token, text: "blocked" })).status).toBe(403);
  } finally {
    await app.close();
    await f.close();
  }
});
