import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { EditableConfigSnapshot } from "../../codex/config-service.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import {
  applyConfigValue,
  type CodexConfigAccess,
  type ConfigFieldKey,
  configFieldKeys,
  defaultOptionValue,
  displayValue,
  fieldKey,
  fieldLabels,
  fieldNotes,
  fieldOptions,
} from "../config-fields.js";
import type { DiscordActionRow, DiscordMessagingApi } from "./reply.js";

export type { CodexConfigAccess } from "../config-fields.js";

export const discordConfigActionPrefix = "wirebot_cfg";

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
    const status = await applyConfigValue(this.#config, field, encodedValue);
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
  const note = fieldNotes[field];
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
  const content = [
    `**${fieldLabels[field]}** — current: ${displayValue(snapshot, field)}`,
    ...(note === undefined ? [] : [note]),
  ].join("\n");
  return {
    content,
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
