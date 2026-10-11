import { expect, test } from "bun:test";
import {
  applyConfigValue,
  defaultOptionValue,
  displayValue,
  fieldOptions,
  overviewModel,
  pickerModel,
} from "../src/channels/config-fields.js";
import { CodexConfigService } from "../src/codex/config-service.js";
import { modelSelectionPatch } from "../src/codex/model-settings.js";
import type { CodexAppServer } from "../src/codex/rpc.js";
import type { ConfigBatchWriteParams } from "../src/generated/codex/v2/ConfigBatchWriteParams.js";
import type { ModelListParams } from "../src/generated/codex/v2/ModelListParams.js";
import { modelCatalog } from "./fixtures/model-catalog.js";

test("in-chat Auto control and manual choices agree on the active mode", async () => {
  const service = catalogService().service;
  let autoMode = true;
  const config = {
    read: async () => ({ ...(await service.read()), autoMode }),
    update: (input: unknown) => service.update(input),
    updateAutoMode: async (value: boolean) => {
      autoMode = value;
    },
  };
  expect(overviewModel(await config.read()).fields).toContainEqual({
    key: "auto_mode",
    label: "Auto effort & speed",
    value: "On",
  });
  expect(displayValue(await config.read(), "service_tier")).toBe("Auto");
  expect(await applyConfigValue(config, "model_reasoning_effort", "low")).toContain(
    "Auto mode disabled",
  );
  expect(autoMode).toBe(false);
  expect(await applyConfigValue(config, "auto_mode", "true")).toContain("enabled");
  expect(autoMode).toBe(true);
});

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

function catalogService() {
  const writes: ConfigBatchWriteParams[] = [];
  const requests: ModelListParams[] = [];
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
                config: {
                  model: "gpt-6.1-sol",
                  model_reasoning_effort: "ultra",
                  service_tier: "ultrafast",
                },
                disabledReason: null,
              },
            ],
          };
        case "model/list": {
          const params = message.params as ModelListParams;
          requests.push(params);
          return params.cursor === null
            ? { data: [{ ...modelCatalog[0], hidden: false }], nextCursor: "page-2" }
            : {
                data: [
                  ...modelCatalog.slice(1).map((model) => ({ ...model, hidden: false })),
                  { ...modelCatalog[0], model: "hidden-model", hidden: true },
                ],
                nextCursor: null,
              };
        }
        case "permissionProfile/list":
        case "experimentalFeature/list":
          return { data: [], nextCursor: null };
        case "configRequirements/read":
          return { requirements: null };
        case "config/batchWrite":
          writes.push(message.params as ConfigBatchWriteParams);
          return {};
        default:
          throw new Error(`Unexpected RPC: ${message.method}`);
      }
    },
  } as unknown as CodexAppServer;
  return { service: new CodexConfigService(rpc), writes, requests };
}

test("new models, reasoning, and Ultrafast follow the paginated Codex catalog", async () => {
  const { service, requests } = catalogService();
  const snapshot = await service.read();
  expect(snapshot.capabilities.models).toEqual(modelCatalog);
  expect(requests).toEqual([
    { cursor: null, limit: 100, includeHidden: false },
    { cursor: "page-2", limit: 100, includeHidden: false },
  ]);
  expect(fieldOptions(snapshot, "model").map((option) => option.value)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
  ]);
  expect(fieldOptions(snapshot, "model_reasoning_effort").map((option) => option.value)).toContain(
    "ultra",
  );
  expect(pickerModel(snapshot, "service_tier").options).toContainEqual({
    label: "✓ Ultrafast",
    encodedValue: "ultrafast",
  });
  expect(displayValue(snapshot, "service_tier")).toBe("Ultrafast");
  for (const model of ["gpt-6-luna", "custom-model"]) {
    const selected = { ...snapshot, values: { ...snapshot.values, model } };
    expect(
      fieldOptions(selected, "service_tier").some((option) => option.value === "ultrafast"),
    ).toBe(false);
  }
});

test("speed saves preserve Codex tier IDs and reset Standard with a hot reload", async () => {
  const { service, writes } = catalogService();
  for (const encoded of ["ultrafast", "priority", defaultOptionValue]) {
    expect(await applyConfigValue(service, "service_tier", encoded)).toBe("✅ Speed updated.");
  }
  expect(writes).toEqual(
    ["ultrafast", "priority", null].map((value) => ({
      edits: [{ keyPath: "service_tier", value, mergeStrategy: "upsert" }],
      expectedVersion: "v1",
      reloadUserConfig: true,
    })),
  );
});

test("model switches clear incompatible speed and reasoning in the same config write", async () => {
  const { service, writes } = catalogService();
  expect(await applyConfigValue(service, "model", "gpt-6-luna")).toBe("✅ Model updated.");
  expect(writes).toEqual([
    {
      edits: [
        { keyPath: "model", value: "gpt-6-luna", mergeStrategy: "upsert" },
        { keyPath: "model_reasoning_effort", value: null, mergeStrategy: "upsert" },
        { keyPath: "service_tier", value: null, mergeStrategy: "upsert" },
      ],
      expectedVersion: "v1",
      reloadUserConfig: true,
    },
  ]);
  await applyConfigValue(service, "model", "gpt-6-astra");
  expect(writes[1]?.edits).toEqual([
    { keyPath: "model", value: "gpt-6-astra", mergeStrategy: "upsert" },
  ]);
});

test("shared model selection preserves supported settings and unknown catalog entries", async () => {
  const { service } = catalogService();
  const { values } = await service.read();
  for (const tier of [null, "default", "priority", "fast"]) {
    expect(
      modelSelectionPatch(
        { ...values, service_tier: tier, model_reasoning_effort: "max" },
        "gpt-6-luna",
        modelCatalog,
      ),
    ).toEqual({ model: "gpt-6-luna" });
  }
  expect(modelSelectionPatch(values, "custom-model", modelCatalog)).toEqual({
    model: "custom-model",
  });
  expect(modelSelectionPatch(values, null, modelCatalog)).toEqual({ model: null });
  expect(modelSelectionPatch(values, "gpt-6-luna", [])).toEqual({ model: "gpt-6-luna" });
});
