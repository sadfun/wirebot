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
  fieldKey,
  overviewModel,
  pickerModel,
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
  const model = overviewModel(snapshot, status);
  const content = [
    `**${model.title}**`,
    ...(model.status === undefined ? [] : [model.status]),
    ...model.fields.map((field) => `**${field.label}:** ${field.value}`),
    ...model.warnings,
    `_${model.footer}_`,
  ]
    .join("\n")
    .slice(0, 2_000);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${discordConfigActionPrefix}:field`)
    .setPlaceholder("Choose a setting")
    .addOptions(
      model.fields.map((field) => ({
        label: field.label,
        value: field.key,
        description: `Current: ${field.value}`.slice(0, 100),
      })),
    );
  return { content, components: [row(menu)] };
}

function pickerScreen(
  snapshot: EditableConfigSnapshot,
  field: ConfigFieldKey,
): DiscordConfigScreen {
  const model = pickerModel(snapshot, field);
  const options = model.options
    .map((option) => ({
      label: option.label.slice(0, 100),
      value: option.encodedValue,
    }))
    .filter((option) => option.value.length <= 100)
    .slice(0, 25);
  const back = new ButtonBuilder()
    .setCustomId(`${discordConfigActionPrefix}:back`)
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary);
  const content = [
    `**${model.label}** — current: ${model.currentValue}`,
    ...(model.note === undefined ? [] : [model.note]),
  ].join("\n");
  return {
    content,
    components:
      options.length === 0
        ? [row(back)]
        : [
            row(
              new StringSelectMenuBuilder()
                .setCustomId(`${discordConfigActionPrefix}:value:${model.field}`)
                .setPlaceholder(`Choose ${model.label.toLowerCase()}`)
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
