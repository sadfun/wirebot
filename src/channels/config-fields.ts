import { ConfigValidationError, type EditableConfigSnapshot } from "../codex/config-service.js";
import { modelSelectionPatch, resolveSelectedModel } from "../codex/model-settings.js";
import type { WirebotSettingsStore } from "../core/settings-store.js";
import { errorMessage } from "../shared/errors.js";

/** Narrow port over CodexConfigService, easy to fake in tests. */
export interface CodexConfigAccess {
  read(): Promise<ChannelConfigSnapshot>;
  update(input: unknown): Promise<unknown>;
  updateAutoMode?(enabled: boolean): Promise<unknown>;
}

export type ChannelConfigSnapshot = EditableConfigSnapshot & { readonly autoMode?: boolean };

export function withWirebotSettings(
  config: CodexConfigAccess,
  settings: WirebotSettingsStore,
  afterConfigWrite?: () => Promise<unknown>,
): CodexConfigAccess {
  return {
    read: async () => ({ ...(await config.read()), autoMode: settings.read().autoMode }),
    update: async (input) => {
      const result = await config.update(input);
      await afterConfigWrite?.();
      return result;
    },
    updateAutoMode: (autoMode) => settings.update({ autoMode }),
  };
}

export const configFieldKeys = [
  "model",
  "auto_mode",
  "model_reasoning_effort",
  "service_tier",
  "approval_policy",
  "sandbox_mode",
  "web_search",
] as const;

export type ConfigFieldKey = (typeof configFieldKeys)[number];

export const fieldLabels: Readonly<Record<ConfigFieldKey, string>> = {
  model: "Model",
  auto_mode: "Auto effort & speed",
  model_reasoning_effort: "Reasoning effort",
  service_tier: "Speed",
  approval_policy: "Approvals",
  sandbox_mode: "Sandbox",
  web_search: "Web search",
};

export const fieldNotes: Partial<Record<ConfigFieldKey, string>> = {
  auto_mode:
    "Reassess every message using the full conversation; in DMs, new starts fresh. Simple questions: Low/Medium. Tasks: High/Extra high. Deep research and debugging: Ultra at Standard speed. Explicit speed requests: Ultrafast/Fast when available. Your selected model stays the same.",
  model_reasoning_effort: "Choosing a manual effort turns Auto mode off.",
  service_tier: "Choosing a manual speed turns Auto mode off.",
  sandbox_mode:
    "In the Docker container only danger-full-access executes commands reliably; the container itself is the isolation boundary.",
};

export const defaultOptionValue = "__default__";

export interface FieldOption {
  readonly value: string | null;
  readonly label: string;
}

export function fieldKey(candidate: string | undefined): ConfigFieldKey | undefined {
  return configFieldKeys.find((key) => key === candidate);
}

export function displayValue(snapshot: ChannelConfigSnapshot, field: ConfigFieldKey): string {
  if (field === "auto_mode") return snapshot.autoMode ? "On" : "Off";
  if (snapshot.autoMode && (field === "model_reasoning_effort" || field === "service_tier"))
    return "Auto";
  const raw = snapshot.values[field];
  if (field === "service_tier") {
    if (raw === null || raw === "default") return "Standard";
    const tier = raw === "fast" ? "priority" : raw;
    const model = resolveSelectedModel(snapshot.values.model, snapshot.capabilities.models);
    return model?.serviceTiers.find((option) => option.id === tier)?.name ?? String(raw);
  }
  if (raw === null || raw === undefined) return "default";
  // approval_policy can be a granular object; summarize it.
  return typeof raw === "string" ? raw : "granular";
}

export function fieldOptions(
  snapshot: ChannelConfigSnapshot,
  field: ConfigFieldKey,
): FieldOption[] {
  const model = resolveSelectedModel(snapshot.values.model, snapshot.capabilities.models);
  switch (field) {
    case "auto_mode":
      return [
        { value: "true", label: "On" },
        { value: "false", label: "Off" },
      ];
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

export interface ConfigFieldLine {
  readonly key: ConfigFieldKey;
  readonly label: string;
  readonly value: string;
}

/** Channel-neutral overview screen; connectors add their own markup. */
export interface ConfigOverviewModel {
  readonly title: string;
  readonly status?: string;
  readonly fields: readonly ConfigFieldLine[];
  readonly warnings: readonly string[];
  readonly footer: string;
}

export function overviewModel(
  snapshot: ChannelConfigSnapshot,
  status?: string,
): ConfigOverviewModel {
  return {
    title: "Codex settings",
    ...(status === undefined ? {} : { status }),
    fields: configFieldKeys
      .filter((key) => key !== "auto_mode" || snapshot.autoMode !== undefined)
      .map((key) => ({
        key,
        label: fieldLabels[key],
        value: displayValue(snapshot, key),
      })),
    warnings: snapshot.validation.issues
      .map((issue) => `⚠️ ${issue.path}: ${issue.message}`)
      .slice(0, 3),
    footer: "Everyone using this Wirebot shares these settings.",
  };
}

export interface ConfigPickerOption {
  /** Display label; the currently selected option carries a "✓ " prefix. */
  readonly label: string;
  /** Value for `applyConfigValue`: `defaultOptionValue` or URI-encoded. */
  readonly encodedValue: string;
}

/** Channel-neutral picker screen for one field; connectors add a Back control. */
export interface ConfigPickerModel {
  readonly field: ConfigFieldKey;
  readonly label: string;
  readonly currentValue: string;
  readonly note?: string;
  readonly options: readonly ConfigPickerOption[];
}

export function pickerModel(
  snapshot: ChannelConfigSnapshot,
  field: ConfigFieldKey,
): ConfigPickerModel {
  const note = fieldNotes[field];
  const current =
    field === "auto_mode"
      ? String(snapshot.autoMode ?? false)
      : snapshot.autoMode && (field === "model_reasoning_effort" || field === "service_tier")
        ? undefined
        : snapshot.values[field];
  return {
    field,
    label: fieldLabels[field],
    currentValue: displayValue(snapshot, field),
    ...(note === undefined ? {} : { note }),
    options: fieldOptions(snapshot, field).map((option) => ({
      label: `${option.value === current ? "✓ " : ""}${option.label}`,
      encodedValue: option.value === null ? defaultOptionValue : encodeURIComponent(option.value),
    })),
  };
}

/** Apply a picker selection through CodexConfigService and describe the outcome. */
export async function applyConfigValue(
  config: CodexConfigAccess,
  field: ConfigFieldKey,
  encoded: string,
): Promise<string> {
  const value = encoded === defaultOptionValue ? null : decodeURIComponent(encoded);
  try {
    if (field === "auto_mode") {
      if (config.updateAutoMode === undefined || (value !== "true" && value !== "false"))
        throw new Error("Auto mode setting unavailable");
      await config.updateAutoMode(value === "true");
      return `✅ Auto effort & speed ${value === "true" ? "enabled" : "disabled"}.`;
    }
    const snapshot = await config.read();
    await config.update({
      expectedVersion: snapshot.version,
      values:
        field === "model"
          ? modelSelectionPatch(snapshot.values, value, snapshot.capabilities.models)
          : { [field]: value },
    });
    if (snapshot.autoMode && (field === "model_reasoning_effort" || field === "service_tier")) {
      await config.updateAutoMode?.(false);
      return `✅ ${fieldLabels[field]} updated. Auto mode disabled.`;
    }
    return `✅ ${fieldLabels[field]} updated.`;
  } catch (error) {
    return error instanceof ConfigValidationError
      ? `⚠️ ${error.issues.map((issue) => issue.message).join(" ") || "The change was rejected."}`
      : `⚠️ ${errorMessage(error)}`;
  }
}
