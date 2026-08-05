import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WirebotSettingsStore } from "../src/core/settings-store.js";
import type { Logger } from "../src/shared/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("WirebotSettingsStore", () => {
  it("defaults remote client context to enabled", async () => {
    const path = join(await temporaryDirectory(), "settings.json");
    const store = new WirebotSettingsStore(path, testLogger());

    await store.load();

    expect(store.read()).toEqual({ remoteClientContext: true });
  });

  it("persists changes across instances", async () => {
    const path = join(await temporaryDirectory(), "settings.json");
    const first = new WirebotSettingsStore(path, testLogger());
    await first.load();
    await first.update({ remoteClientContext: false });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      remoteClientContext: false,
    });

    const second = new WirebotSettingsStore(path, testLogger());
    await second.load();
    expect(second.read()).toEqual({ remoteClientContext: false });
  });

  it("falls back to enabled when stored settings are invalid", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 1, remoteClientContext: "no" }));
    const logger = testLogger();
    const store = new WirebotSettingsStore(path, logger);

    await store.load();

    expect(store.read()).toEqual({ remoteClientContext: true });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wirebot-settings-store-"));
  temporaryDirectories.push(path);
  return path;
}

function testLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}
