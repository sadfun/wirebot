import type { EditableCodexConfig, ModelCapability } from "./config-service.js";

export function resolveSelectedModel(
  model: string | null,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return model === null || model.length === 0
    ? (models.find((candidate) => candidate.isDefault) ?? models[0])
    : models.find((candidate) => candidate.model === model);
}

/** Keep compatible choices when switching models; reset unsupported choices together. */
export function modelSelectionPatch(
  current: EditableCodexConfig,
  value: string | null,
  models: readonly ModelCapability[],
): Partial<EditableCodexConfig> {
  const model = resolveSelectedModel(value, models);
  const patch: Partial<EditableCodexConfig> = { model: value };
  // An unavailable catalog cannot tell us which saved options are unsupported.
  if (model === undefined) return patch;
  if (
    current.model_reasoning_effort !== null &&
    !model.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === current.model_reasoning_effort,
    )
  ) {
    patch.model_reasoning_effort = null;
  }
  const tier = current.service_tier === "fast" ? "priority" : current.service_tier;
  if (
    tier !== null &&
    tier !== "default" &&
    !model.serviceTiers.some((option) => option.id === tier)
  ) {
    patch.service_tier = null;
  }
  return patch;
}
