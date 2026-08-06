import { describe, expect, it, vi } from "bun:test";
import { overviewScreen, pickerScreen, SlackConfigUi } from "../src/channels/slack/config-ui.js";
import type {
  SlackMessagingApi,
  SlackPostOptions,
  SlackUpdateOptions,
} from "../src/channels/slack/reply.js";
import type { EditableConfigSnapshot } from "../src/codex/config-service.js";
import { Logger } from "../src/shared/logger.js";

function snapshot(
  overrides: Partial<EditableConfigSnapshot["values"]> = {},
): EditableConfigSnapshot {
  return {
    version: "v42",
    values: {
      model: "gpt-5.6-sol",
      model_provider: null,
      approval_policy: "on-request",
      approvals_reviewer: null,
      sandbox_mode: "danger-full-access",
      default_permissions: null,
      web_search: "live",
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      service_tier: "priority",
      personality: null,
      windows_sandbox: null,
      shell_environment_include_only: null,
      features: {
        apps: null,
        goals: null,
        hooks: null,
        fast_mode: null,
        memories: null,
        multi_agent: null,
        personality: null,
        remote_plugin: null,
        shell_snapshot: null,
        shell_tool: null,
        unified_exec: null,
      },
      ...overrides,
    },
    capabilities: {
      platform: "linux",
      models: [
        {
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "frontier",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "fast" },
            { reasoningEffort: "high", description: "deep" },
          ],
          defaultReasoningEffort: "low",
          serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x" }],
          defaultServiceTier: null,
          isDefault: true,
        },
        {
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          description: "small",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "mid" }],
          defaultReasoningEffort: "medium",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        },
      ],
      modelProviders: [],
      permissionProfiles: [],
      features: [],
      requirements: null,
    },
    validation: { valid: true, issues: [] },
  } as unknown as EditableConfigSnapshot;
}

function fakeUi(read = vi.fn(async () => snapshot()), update = vi.fn(async () => ({}))) {
  const posts: SlackPostOptions[] = [];
  const updates: SlackUpdateOptions[] = [];
  const api: SlackMessagingApi = {
    async postMessage(options) {
      posts.push(options);
      return "1700.1";
    },
    async updateMessage(options) {
      updates.push(options);
    },
    async uploadFile() {},
    async postEphemeral() {},
    async fetchThreadReplies() {
      return [];
    },
  };
  const ui = new SlackConfigUi(api, { read, update }, new Logger("error"));
  return { ui, posts, updates, read, update };
}

describe("overviewScreen", () => {
  it("lists current values and one button per setting", () => {
    const { text, blocks } = overviewScreen(snapshot());
    expect(text).toBe("Codex settings");
    const section = blocks[0];
    expect(section?.type).toBe("section");
    if (section?.type === "section") {
      expect(section.text.text).toContain("*Model*: gpt-5.6-sol");
      expect(section.text.text).toContain("*Speed*: priority");
      expect(section.text.text).toContain("shares these settings");
    }
    const buttons = blocks
      .filter((block) => block.type === "actions")
      .flatMap((block) => (block.type === "actions" ? block.elements : []));
    expect(buttons.map((button) => button.value)).toContain("pick:model");
    expect(buttons).toHaveLength(6);
  });
});

describe("pickerScreen", () => {
  it("marks the current option and offers a default", () => {
    const { blocks } = pickerScreen(snapshot(), "service_tier");
    const buttons = blocks
      .filter((block) => block.type === "actions")
      .flatMap((block) => (block.type === "actions" ? block.elements : []));
    expect(buttons.map((button) => button.text.text)).toEqual([
      "✓ Fast",
      "standard (default)",
      "← Back",
    ]);
    expect(buttons[1]?.value).toBe("set:service_tier:__default__");
  });

  it("derives effort options from the selected model", () => {
    const { blocks } = pickerScreen(snapshot(), "model_reasoning_effort");
    const buttons = blocks
      .filter((block) => block.type === "actions")
      .flatMap((block) => (block.type === "actions" ? block.elements : []));
    expect(buttons.map((button) => button.text.text)).toEqual([
      "low",
      "high",
      "✓ default (low)",
      "← Back",
    ]);
  });

  it("warns about the container on the sandbox screen", () => {
    const { blocks } = pickerScreen(snapshot(), "sandbox_mode");
    const section = blocks[0];
    if (section?.type === "section") {
      expect(section.text.text).toContain("danger-full-access executes commands reliably");
    } else {
      expect.unreachable("first block must be a section");
    }
  });
});

describe("SlackConfigUi.handleAction", () => {
  it("applies a chosen value with the snapshot version and re-renders", async () => {
    const { ui, updates, update } = fakeUi();
    await ui.handleAction("set:web_search:cached", "D1", "1700.5");
    expect(update).toHaveBeenCalledWith({
      expectedVersion: "v42",
      values: { web_search: "cached" },
    });
    const rendered = updates.at(-1);
    expect(rendered?.ts).toBe("1700.5");
    const section = rendered?.blocks?.[0];
    if (section?.type === "section") {
      expect(section.text.text).toContain("✅ Web search updated.");
    }
  });

  it("maps the default option to null", async () => {
    const { ui, update } = fakeUi();
    await ui.handleAction("set:service_tier:__default__", "D1", "1700.5");
    expect(update).toHaveBeenCalledWith({
      expectedVersion: "v42",
      values: { service_tier: null },
    });
  });

  it("shows the picker for a field and returns to the menu", async () => {
    const { ui, updates } = fakeUi();
    await ui.handleAction("pick:model", "D1", "1700.5");
    expect(updates.at(-1)?.text).toBe("Codex settings — Model");
    await ui.handleAction("menu", "D1", "1700.5");
    expect(updates.at(-1)?.text).toBe("Codex settings");
  });

  it("surfaces update failures as a status line", async () => {
    const failing = vi.fn(async () => {
      throw new Error("version conflict");
    });
    const { ui, updates } = fakeUi(undefined, failing);
    await ui.handleAction("set:web_search:live", "D1", "1700.5");
    const section = updates.at(-1)?.blocks?.[0];
    if (section?.type === "section") {
      expect(section.text.text).toContain("⚠️ version conflict");
    } else {
      expect.unreachable("expected a rendered section");
    }
  });

  it("ignores malformed action values", async () => {
    const { ui, updates, update } = fakeUi();
    await ui.handleAction("set:not_a_field:x", "D1", "1700.5");
    await ui.handleAction("garbage", "D1", "1700.5");
    expect(update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
