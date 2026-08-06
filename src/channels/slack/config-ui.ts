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
import { escapeSlackEntities } from "./format.js";
import type { SlackBlock, SlackButtonElement, SlackMessagingApi } from "./reply.js";

export type { CodexConfigAccess } from "../config-fields.js";

export const slackConfigActionPrefix = "wirebot_cfg";

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
        const status = await applyConfigValue(this.#config, setField, set[2]);
        await this.showOverview(channel, messageTs, status);
      }
    } catch (error) {
      this.#logger.warn("Slack config action failed", { error: errorMessage(error) });
      await this.showOverview(channel, messageTs, `⚠️ ${errorMessage(error)}`).catch(
        () => undefined,
      );
    }
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

function chunkButtons(buttons: readonly SlackButtonElement[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    blocks.push({ type: "actions", elements: buttons.slice(index, index + 5) });
  }
  return blocks;
}
