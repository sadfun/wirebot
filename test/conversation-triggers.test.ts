import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  ConversationTriggers,
  conversationTriggerSchema,
} from "../src/core/conversation-triggers.js";

const token = "test-token-".repeat(4);
const binding = conversationTriggerSchema.parse({
  id: "example",
  token,
  conversationKey: "telegram:123:0",
  threadId: "original-thread",
  owner: { provider: "telegram", resource: "user", id: "123" },
  deliveryTarget: { provider: "telegram", resource: "destination", id: "chat:123" },
});

async function fixture() {
  const calls: unknown[] = [];
  const sent: unknown[] = [];
  let authorized = true,
    busy = false,
    notify = true,
    fail = false,
    released = 0;
  const triggers = new ConversationTriggers({
    bindings: [binding],
    codex: {
      tryAcquireBackground: () =>
        busy
          ? { acquired: false, reason: "busy" }
          : {
              acquired: true,
              release: () => {
                released++;
              },
            },
      runScheduledTurn: async (request) => {
        calls.push(request);
        if (fail) throw new Error("test failure");
        return {
          threadId: binding.threadId,
          turnId: "turn",
          rawText: JSON.stringify({ notify, message: "Result" }),
          attachments: [],
          unavailableAttachments: [],
          dispose: async () => {},
        };
      },
    },
    channels: [
      {
        name: "telegram",
        isAuthorized: () => authorized,
        start: async () => {},
        stop: async () => {},
        publish: async (target, message) => {
          sent.push({ target, message });
          return { publishedMessages: [] };
        },
      },
    ],
  });
  const server = createServer((request, response) => {
    void triggers.handle("example", request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    calls,
    sent,
    releases: () => released,
    set: (options: { authorized?: boolean; busy?: boolean; notify?: boolean; fail?: boolean }) => {
      authorized = options.authorized ?? authorized;
      busy = options.busy ?? busy;
      notify = options.notify ?? notify;
      fail = options.fail ?? fail;
    },
    post: async (body: unknown, bearer = token) =>
      await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("trigger rejects unauthenticated, revoked, rerouted and busy requests without a turn", async () => {
  const f = await fixture();
  try {
    expect((await f.post({ prompt: "test" }, "wrong")).status).toBe(401);
    f.set({ authorized: false });
    expect((await f.post({ prompt: "test" })).status).toBe(403);
    f.set({ authorized: true });
    expect((await f.post({ prompt: "test", threadId: "someone-else" })).status).toBe(400);
    expect((await f.post({ prompt: " " })).status).toBe(400);
    expect((await f.post({ prompt: "x".repeat(100_001) })).status).toBe(413);
    f.set({ busy: true });
    const response = await f.post({ prompt: "test" });
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(f.calls).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("trigger resumes bound thread, delivers or suppresses results, and releases on failure", async () => {
  const f = await fixture();
  try {
    const result = await (await f.post({ prompt: "Inspect requested work." })).json();
    expect(result).toEqual({ threadId: "original-thread", turnId: "turn", notified: true });
    expect(f.calls[0]).toMatchObject({
      thread: { mode: "existing", threadId: binding.threadId },
      invocation: { owner: binding.owner, deliveryTarget: binding.deliveryTarget },
    });
    expect(f.sent[0]).toMatchObject({
      target: binding.deliveryTarget,
      message: { text: "Result" },
    });
    f.set({ notify: false });
    expect((await (await f.post({ prompt: "Nothing new" })).json()).notified).toBe(false);
    expect(f.sent).toHaveLength(1);
    f.set({ fail: true });
    expect((await f.post({ prompt: "Fail" })).status).toBe(500);
    expect(f.releases()).toBe(3);
  } finally {
    await f.close();
  }
});
