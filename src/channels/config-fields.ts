import {
  ConfigValidationError,
  type EditableConfigSnapshot,
  type ModelCapability,
} from "../codex/config-service.js";
import { errorMessage } from "../shared/errors.js";

/** Narrow port over CodexConfigService, easy to fake in tests. */
export interface CodexConfigAccess {
  read(): Promise<EditableConfigSnapshot>;
  update(input: unknown): Promise<unknown>;
}

export const configFieldKeys = [
  "model",
  "model_reasoning_effort",
  "service_tier",
  "approval_policy",
  "sandbox_mode",
  "web_search",
] as const;

export type ConfigFieldKey = (typeof configFieldKeys)[number];

export const fieldLabels: Readonly<Record<ConfigFieldKey, string>> = {
  model: "Model",
  model_reasoning_effort: "Reasoning effort",
  service_tier: "Speed",
  approval_policy: "Approvals",
  sandbox_mode: "Sandbox",
  web_search: "Web search",
};

export const fieldNotes: Partial<Record<ConfigFieldKey, string>> = {
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

export function displayValue(snapshot: EditableConfigSnapshot, field: ConfigFieldKey): string {
  const raw = snapshot.values[field];
  if (raw === null || raw === undefined) return "default";
  // approval_policy can be a granular object; summarize it.
  return typeof raw === "string" ? raw : "granular";
}

export function fieldOptions(
  snapshot: EditableConfigSnapshot,
  field: ConfigFieldKey,
): FieldOption[] {
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
  snapshot: EditableConfigSnapshot,
  status?: string,
): ConfigOverviewModel {
  return {
    title: "Codex settings",
    ...(status === undefined ? {} : { status }),
    fields: configFieldKeys.map((key) => ({
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
  snapshot: EditableConfigSnapshot,
  field: ConfigFieldKey,
): ConfigPickerModel {
  const note = fieldNotes[field];
  const current = snapshot.values[field];
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
    const snapshot = await config.read();
    await config.update({
      expectedVersion: snapshot.version,
      values: { [field]: value },
    });
    return `✅ ${fieldLabels[field]} updated.`;
  } catch (error) {
    return error instanceof ConfigValidationError
      ? `⚠️ ${error.issues.map((issue) => issue.message).join(" ") || "The change was rejected."}`
      : `⚠️ ${errorMessage(error)}`;
  }
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
