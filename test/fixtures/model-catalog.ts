import type { ModelCapability } from "../../src/codex/config-service.js";

/** Account catalog fixture: Ultrafast is available for Sol 6.1 and Astra, not Luna. */
export const modelCatalog: readonly ModelCapability[] = [
  {
    model: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    description: "Latest workhorse model",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Light reasoning" },
      { reasoningEffort: "max", description: "Maximum reasoning" },
      { reasoningEffort: "ultra", description: "Automatic delegation" },
    ],
    defaultReasoningEffort: "low",
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster responses, increased usage" },
      { id: "ultrafast", name: "Ultrafast", description: "Fastest responses, increased usage" },
    ],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "Frontier model",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Light reasoning" },
      { reasoningEffort: "ultra", description: "Automatic delegation" },
    ],
    defaultReasoningEffort: "low",
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster responses, increased usage" },
      { id: "ultrafast", name: "Ultrafast", description: "Fastest responses, increased usage" },
    ],
    defaultServiceTier: null,
    isDefault: false,
  },
  {
    model: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    description: "Efficient model",
    supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Maximum reasoning" }],
    defaultReasoningEffort: "max",
    serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
    defaultServiceTier: "priority",
    isDefault: false,
  },
];
