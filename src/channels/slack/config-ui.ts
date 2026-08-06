import {
  ConfigValidationError,
  type EditableConfigSnapshot,
  type ModelCapability,
} from "../../codex/config-service.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { escapeSlackEntities } from "./format.js";
import type { SlackBlock, SlackButtonElement, SlackMessagingApi } from "./reply.js";

/** Narrow port over CodexConfigService, easy to fake in tests. */
export interface CodexConfigAccess {
  read(): Promise<EditableConfigSnapshot>;
  update(input: unknown): Promise<unknown>;
}

export const slackConfigActionPrefix = "wirebot_cfg";

const configFieldKeys = [
  "model",
  "model_reasoning_effort",
  "service_tier",
  "approval_policy",
  "sandbox_mode",
  "web_search",
] as const;

type ConfigFieldKey = (typeof configFieldKeys)[number];

const fieldLabels: Readonly<Record<ConfigFieldKey, string>> = {
  model: "Model",
  model_reasoning_effort: "Reasoning effort",
  service_tier: "Speed",
  approval_policy: "Approvals",
  sandbox_mode: "Sandbox",
  web_search: "Web search",
};

const fieldNotes: Partial<Record<ConfigFieldKey, string>> = {
  sandbox_mode:
    "In the Docker container only danger-full-access executes commands reliably; the container itself is the isolation boundary.",
};

const defaultOptionValue = "__default__";

interface FieldOption {
  readonly value: string | null;
  readonly label: string;
}

/**
 * Interactive Codex settings rendered as Slack blocks — the Slack counterpart
 * of the Telegram Mini App's settings screen. One message is edited in place:
 * an overview screen with a button per setting, and per-setting picker
 * screens whose buttons apply the change through CodexConfigService.
 */
export class SlackConfigUi {
  readonly #api: SlackMessagingApi;
  readonly #config: CodexConfigAccess;
  readonly #logger: Logger;

  public constructor(api: SlackMessagingApi, config: CodexConfigAccess, logger: Logger) {
    this.#api = api;
    this.#config = config;
    this.#logger = logger;
  }

  public async open(channel: string): Promise<void> {
    const snapshot = await this.#config.read();
    const { text, blocks } = overviewScreen(snapshot);
    await this.#api.postMessage({ channel, text, blocks });
  }

  public async handleAction(value: string, channel: string, messageTs: string): Promise<void> {
    try {
      if (value === "menu") {
        await this.showOverview(channel, messageTs, undefined);
        return;
      }
      const pick = /^pick:([a-z_]+)$/u.exec(value);
      const pickField = fieldKey(pick?.[1]);
      if (pickField !== undefined) {
        const snapshot = await this.#config.read();
        const { text, blocks } = pickerScreen(snapshot, pickField);
        await this.#api.updateMessage({ channel, ts: messageTs, text, blocks });
        return;
      }
      const set = /^set:([a-z_]+):(.*)$/u.exec(value);
      const setField = fieldKey(set?.[1]);
      if (setField !== undefined && set?.[2] !== undefined) {
        await this.applyValue(channel, messageTs, setField, set[2]);
      }
    } catch (error) {
      this.#logger.warn("Slack config action failed", { error: errorMessage(error) });
      await this.showOverview(channel, messageTs, `⚠️ ${errorMessage(error)}`).catch(
        () => undefined,
      );
    }
  }

  private async applyValue(
    channel: string,
    messageTs: string,
    field: ConfigFieldKey,
    encoded: string,
  ): Promise<void> {
    const value = encoded === defaultOptionValue ? null : decodeURIComponent(encoded);
    let status: string;
    try {
      const snapshot = await this.#config.read();
      await this.#config.update({
        expectedVersion: snapshot.version,
        values: { [field]: value },
      });
      status = `✅ ${fieldLabels[field]} updated.`;
    } catch (error) {
      status =
        error instanceof ConfigValidationError
          ? `⚠️ ${error.issues.map((issue) => issue.message).join(" ") || "The change was rejected."}`
          : `⚠️ ${errorMessage(error)}`;
    }
    await this.showOverview(channel, messageTs, status);
  }

  private async showOverview(
    channel: string,
    messageTs: string,
    status: string | undefined,
  ): Promise<void> {
    const snapshot = await this.#config.read();
    const { text, blocks } = overviewScreen(snapshot, status);
    await this.#api.updateMessage({ channel, ts: messageTs, text, blocks });
  }
}

function fieldKey(candidate: string | undefined): ConfigFieldKey | undefined {
  return configFieldKeys.find((key) => key === candidate);
}

function currentModel(snapshot: EditableConfigSnapshot): ModelCapability | undefined {
  const selected = snapshot.values.model;
  const models = snapshot.capabilities.models;
  if (selected !== null) {
    const match = models.find((model) => model.model === selected);
    if (match !== undefined) return match;
  }
  return models.find((model) => model.isDefault) ?? models[0];
}

function displayValue(snapshot: EditableConfigSnapshot, field: ConfigFieldKey): string {
  const raw = snapshot.values[field];
  if (raw === null || raw === undefined) return "default";
  if (typeof raw === "string") return raw;
  // approval_policy can be a granular object; summarize it.
  return "granular";
}

export function overviewScreen(
  snapshot: EditableConfigSnapshot,
  status?: string,
): { text: string; blocks: readonly SlackBlock[] } {
  const lines = configFieldKeys.map(
    (field) => `*${fieldLabels[field]}*: ${escapeSlackEntities(displayValue(snapshot, field))}`,
  );
  const warnings = snapshot.validation.issues
    .map((issue) => `⚠️ ${escapeSlackEntities(`${issue.path}: ${issue.message}`)}`)
    .slice(0, 3);
  const header = [
    "*Codex settings*",
    ...(status === undefined ? [] : [escapeSlackEntities(status)]),
    ...lines,
    ...warnings,
    "_Everyone using this Wirebot shares these settings._",
  ].join("\n");
  const buttons = configFieldKeys.map(
    (field, index): SlackButtonElement => ({
      type: "button",
      text: { type: "plain_text", text: fieldLabels[field] },
      action_id: `${slackConfigActionPrefix}_pick_${index}`,
      value: `pick:${field}`,
    }),
  );
  return {
    text: "Codex settings",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header.slice(0, 3_000) } },
      ...chunkButtons(buttons),
    ],
  };
}

export function pickerScreen(
  snapshot: EditableConfigSnapshot,
  field: ConfigFieldKey,
): { text: string; blocks: readonly SlackBlock[] } {
  const note = fieldNotes[field];
  const header = [
    `*${fieldLabels[field]}* — current: ${escapeSlackEntities(displayValue(snapshot, field))}`,
    ...(note === undefined ? [] : [escapeSlackEntities(note)]),
  ].join("\n");
  const current = snapshot.values[field];
  const buttons = fieldOptions(snapshot, field).map(
    (option, index): SlackButtonElement => ({
      type: "button",
      text: {
        type: "plain_text",
        text: `${option.value === current ? "✓ " : ""}${option.label}`.slice(0, 75),
      },
      action_id: `${slackConfigActionPrefix}_set_${index}`,
      value: `set:${field}:${option.value === null ? defaultOptionValue : encodeURIComponent(option.value)}`,
    }),
  );
  const back: SlackButtonElement = {
    type: "button",
    text: { type: "plain_text", text: "← Back" },
    action_id: `${slackConfigActionPrefix}_back`,
    value: "menu",
  };
  return {
    text: `Codex settings — ${fieldLabels[field]}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header.slice(0, 3_000) } },
      ...chunkButtons([...buttons, back]),
    ],
  };
}

function fieldOptions(snapshot: EditableConfigSnapshot, field: ConfigFieldKey): FieldOption[] {
  const model = currentModel(snapshot);
  switch (field) {
    case "model":
      return snapshot.capabilities.models.map((candidate) => ({
        value: candidate.model,
        label: `${candidate.displayName}${candidate.isDefault ? " (default)" : ""}`,
      }));
    case "model_reasoning_effort":
      return [
        ...(model?.supportedReasoningEfforts ?? []).map((option) => ({
          value: option.reasoningEffort,
          label: option.reasoningEffort,
        })),
        { value: null, label: `default (${model?.defaultReasoningEffort ?? "model default"})` },
      ];
    case "service_tier":
      return [
        ...(model?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name })),
        { value: null, label: "standard (default)" },
      ];
    case "approval_policy":
      return [
        { value: "untrusted", label: "untrusted — approve most actions" },
        { value: "on-request", label: "on-request — Codex decides when to ask" },
        { value: "never", label: "never — fully unattended" },
        { value: null, label: "default" },
      ];
    case "sandbox_mode":
      return [
        { value: "read-only", label: "read-only" },
        { value: "workspace-write", label: "workspace-write" },
        { value: "danger-full-access", label: "danger-full-access" },
        { value: null, label: "default" },
      ];
    case "web_search":
      return [
        { value: "disabled", label: "disabled" },
        { value: "cached", label: "cached" },
        { value: "indexed", label: "indexed" },
        { value: "live", label: "live" },
        { value: null, label: "default" },
      ];
  }
}

function chunkButtons(buttons: readonly SlackButtonElement[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    blocks.push({ type: "actions", elements: buttons.slice(index, index + 5) });
  }
  return blocks;
}
