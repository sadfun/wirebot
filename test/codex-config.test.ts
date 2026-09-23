import { expect, test } from "bun:test";
import { CodexConfigService } from "../src/codex/config-service.js";
import type { CodexAppServer } from "../src/codex/rpc.js";

test("retired personality config is left untouched by Wirebot settings", async () => {
  const writes: unknown[] = [];
  const rpc = {
    async request(message: { method: string; params?: unknown }): Promise<unknown> {
      switch (message.method) {
        case "config/read":
          return {
            config: { model_provider: null },
            layers: [
              {
                name: { type: "user", profile: null },
                version: "v1",
                config: { model: "gpt-6", personality: "friendly" },
                disabledReason: null,
              },
            ],
          };
        case "model/list":
        case "permissionProfile/list":
        case "experimentalFeature/list":
          return { data: [], nextCursor: null };
        case "configRequirements/read":
          return { requirements: null };
        case "config/batchWrite":
          writes.push(message.params);
          return {};
        default:
          throw new Error(`Unexpected RPC: ${message.method}`);
      }
    },
  } as unknown as CodexAppServer;
  const service = new CodexConfigService(rpc);

  const snapshot = await service.read();
  expect(snapshot.values.model).toBe("gpt-6");
  expect("personality" in snapshot.values).toBe(false);

  await service.update({ expectedVersion: snapshot.version, values: { model: "gpt-6-sol" } });
  expect(writes).toEqual([
    {
      edits: [{ keyPath: "model", value: "gpt-6-sol", mergeStrategy: "upsert" }],
      expectedVersion: "v1",
      reloadUserConfig: true,
    },
  ]);
});
