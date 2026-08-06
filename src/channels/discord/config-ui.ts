import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  ConfigValidationError,
  type EditableConfigSnapshot,
  type ModelCapability,
} from "../../codex/config-service.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import type { DiscordActionRow, DiscordMessagingApi } from "./reply.js";

export interface CodexConfigAccess {
  read(): Promise<EditableConfigSnapshot>;
  update(input: unknown): Promise<unknown>;
}

export const discordConfigActionPrefix = "wirebot_cfg";

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

const defaultOptionValue = "__default__";

interface FieldOption {
  readonly value: string | null;
  readonly label: string;
}

interface DiscordConfigScreen {
  readonly content: string;
  readonly components: readonly DiscordActionRow[];
}

/** Compact select-menu settings UI for Discord direct messages. */
export class DiscordConfigUi {
  readonly #api: DiscordMessagingApi;
  readonly #config: CodexConfigAccess;
  readonly #logger: Logger;

  public constructor(api: DiscordMessagingApi, config: CodexConfigAccess, logger: Logger) {
    this.#api = api;
    this.#config = config;
    this.#logger = logger;
  }

  public async open(channelId: string): Promise<string> {
    const screen = overviewScreen(await this.#config.read());
    return await this.#api.postMessage({ channelId, ...screen });
  }

  public async handleField(channelId: string, messageId: string, rawField: string): Promise<void> {
    const field = fieldKey(rawField);
    if (field === undefined) return;
    await this.replace(channelId, messageId, pickerScreen(await this.#config.read(), field));
  }

  public async handleValue(
    channelId: string,
    messageId: string,
    rawField: string,
    encodedValue: string,
  ): Promise<void> {
    const field = fieldKey(rawField);
    if (field === undefined) return;
    const value = encodedValue === defaultOptionValue ? null : decodeURIComponent(encodedValue);
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
    await this.showOverview(channelId, messageId, status);
  }

  public async showOverview(channelId: string, messageId: string, status?: string): Promise<void> {
    try {
      await this.replace(channelId, messageId, overviewScreen(await this.#config.read(), status));
    } catch (error) {
      this.#logger.warn("Discord config action failed", { error: errorMessage(error) });
      await this.#api
        .updateMessage({
          channelId,
          messageId,
          content: `⚠️ ${errorMessage(error)}`.slice(0, 2_000),
          components: [],
        })
        .catch(() => undefined);
    }
  }

  private async replace(
    channelId: string,
    messageId: string,
    screen: DiscordConfigScreen,
  ): Promise<void> {
    await this.#api.updateMessage({ channelId, messageId, ...screen });
  }
}

function overviewScreen(snapshot: EditableConfigSnapshot, status?: string): DiscordConfigScreen {
  const values = configFieldKeys.map(
    (field) => `**${fieldLabels[field]}:** ${displayValue(snapshot, field)}`,
  );
  const warnings = snapshot.validation.issues
    .map((issue) => `⚠️ ${issue.path}: ${issue.message}`)
    .slice(0, 3);
  const content = [
    "**Codex settings**",
    ...(status === undefined ? [] : [status]),
    ...values,
    ...warnings,
    "_Everyone using this Wirebot shares these settings._",
  ]
    .join("\n")
    .slice(0, 2_000);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${discordConfigActionPrefix}:field`)
    .setPlaceholder("Choose a setting")
    .addOptions(
      configFieldKeys.map((field) => ({
        label: fieldLabels[field],
        value: field,
        description: `Current: ${displayValue(snapshot, field)}`.slice(0, 100),
      })),
    );
  return { content, components: [row(menu)] };
}

function pickerScreen(
  snapshot: EditableConfigSnapshot,
  field: ConfigFieldKey,
): DiscordConfigScreen {
  const current = snapshot.values[field];
  const options = fieldOptions(snapshot, field)
    .map((option) => ({
      label: `${option.value === current ? "✓ " : ""}${option.label}`.slice(0, 100),
      value: option.value === null ? defaultOptionValue : encodeURIComponent(option.value),
    }))
    .filter((option) => option.value.length <= 100)
    .slice(0, 25);
  const back = new ButtonBuilder()
    .setCustomId(`${discordConfigActionPrefix}:back`)
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary);
  return {
    content: `**${fieldLabels[field]}** — current: ${displayValue(snapshot, field)}`,
    components:
      options.length === 0
        ? [row(back)]
        : [
            row(
              new StringSelectMenuBuilder()
                .setCustomId(`${discordConfigActionPrefix}:value:${field}`)
                .setPlaceholder(`Choose ${fieldLabels[field].toLowerCase()}`)
                .addOptions(options),
            ),
            row(back),
          ],
  };
}

function row(
  component: StringSelectMenuBuilder | ButtonBuilder,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(component);
}

function fieldKey(candidate: string | undefined): ConfigFieldKey | undefined {
  return configFieldKeys.find((key) => key === candidate);
}

function currentModel(snapshot: EditableConfigSnapshot): ModelCapability | undefined {
  const selected = snapshot.values.model;
  if (selected !== null) {
    const match = snapshot.capabilities.models.find((model) => model.model === selected);
    if (match !== undefined) return match;
  }
  return (
    snapshot.capabilities.models.find((model) => model.isDefault) ?? snapshot.capabilities.models[0]
  );
}

function displayValue(snapshot: EditableConfigSnapshot, field: ConfigFieldKey): string {
  const raw = snapshot.values[field];
  if (raw === null || raw === undefined) return "default";
  return typeof raw === "string" ? raw : "granular";
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
