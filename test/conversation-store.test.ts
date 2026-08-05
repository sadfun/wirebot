import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/core/conversation-store.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("ConversationStore", () => {
  it("persists durable Codex thread mappings atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wirebot-store-"));
    directories.push(directory);
    const path = join(directory, "state", "conversations.json");
    const logger = new Logger("error");
    const store = new ConversationStore(path, logger);
    await store.load();
    await Promise.all([store.set("telegram:1", "thread-a"), store.set("telegram:2", "thread-b")]);

    const reloaded = new ConversationStore(path, logger);
    await reloaded.load();
    expect(reloaded.get("telegram:1")).toBe("thread-a");
    expect(reloaded.get("telegram:2")).toBe("thread-b");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2 });
  });

  it("keeps explicit thread-switch history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wirebot-store-"));
    directories.push(directory);
    const path = join(directory, "conversations.json");
    const store = new ConversationStore(path, new Logger("error"));
    await store.load();
    await store.set("telegram:1", "thread-a");

    await store.switchTo("telegram:1", "thread-b");

    expect(store.get("telegram:1")).toBe("thread-b");
    expect(store.previous("telegram:1")).toBe("thread-a");
    await store.switchTo("telegram:1", store.previous("telegram:1") as string);
    expect(store.get("telegram:1")).toBe("thread-a");
    expect(store.previous("telegram:1")).toBe("thread-b");
  });
});
