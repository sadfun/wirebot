import { z } from "zod";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import type { ConfigBatchWriteParams } from "../generated/codex/v2/ConfigBatchWriteParams.js";
import type { ConfigEdit } from "../generated/codex/v2/ConfigEdit.js";
import type { ConfigLayer } from "../generated/codex/v2/ConfigLayer.js";
import type { ConfigLayerSource } from "../generated/codex/v2/ConfigLayerSource.js";
import type { ConfigReadResponse } from "../generated/codex/v2/ConfigReadResponse.js";
import type { ConfigRequirements } from "../generated/codex/v2/ConfigRequirements.js";
import type { ConfigRequirementsReadResponse } from "../generated/codex/v2/ConfigRequirementsReadResponse.js";
import type { ConfigWriteResponse } from "../generated/codex/v2/ConfigWriteResponse.js";
import type { ExperimentalFeature } from "../generated/codex/v2/ExperimentalFeature.js";
import type { ExperimentalFeatureListResponse } from "../generated/codex/v2/ExperimentalFeatureListResponse.js";
import type { ExperimentalFeatureStage } from "../generated/codex/v2/ExperimentalFeatureStage.js";
import type { Model } from "../generated/codex/v2/Model.js";
import type { ModelListResponse } from "../generated/codex/v2/ModelListResponse.js";
import type { PermissionProfileListResponse } from "../generated/codex/v2/PermissionProfileListResponse.js";
import type { PermissionProfileSummary } from "../generated/codex/v2/PermissionProfileSummary.js";
import { BridgeError } from "../shared/errors.js";
import { capitalize } from "../shared/text.js";
import type { CodexAppServer } from "./rpc.js";

// Loose: pass through granular fields future Codex versions add instead of rejecting the write.
const granularApprovalSchema = z.looseObject({
  sandbox_approval: z.boolean(),
  rules: z.boolean(),
  skill_approval: z.boolean(),
  request_permissions: z.boolean(),
  mcp_elicitations: z.boolean(),
});

const approvalPolicySchema = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z.strictObject({ granular: granularApprovalSchema }),
]);
const approvalsReviewerSchema = z.enum(["user", "auto_review"]);
const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const webSearchSchema = z.enum(["disabled", "cached", "indexed", "live"]);
const reasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);
const verbositySchema = z.enum(["low", "medium", "high"]);
const personalitySchema = z.enum(["none", "friendly", "pragmatic"]);
const windowsSandboxSchema = z.enum(["unelevated", "elevated"]);

const nullableIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !containsControlCharacter(value), "Control characters are not allowed")
  .nullable();

const environmentPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !containsControlCharacter(value), "Control characters are not allowed");

const environmentPatternsSchema = z
  .array(environmentPatternSchema)
  .max(100)
  .superRefine(requireUniqueStrings)
  .nullable();

/**
 * Feature flags come from the running app-server's `experimentalFeature/list`;
 * the key pattern only keeps `features.<key>` write paths well-formed.
 */
const featureKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "Feature keys must use letters, digits, underscores, or dashes");

const featureValuesSchema = z.record(featureKeySchema, z.boolean().nullable());

const featurePatchSchema = featureValuesSchema.refine(
  (value) => Object.keys(value).length > 0,
  "At least one feature value is required",
);

const editableCodexConfigSchema = z.strictObject({
  model: nullableIdentifierSchema,
  model_provider: nullableIdentifierSchema,
  approval_policy: approvalPolicySchema.nullable(),
  approvals_reviewer: approvalsReviewerSchema.nullable(),
  sandbox_mode: sandboxModeSchema.nullable(),
  default_permissions: nullableIdentifierSchema,
  web_search: webSearchSchema.nullable(),
  model_reasoning_effort: nullableIdentifierSchema,
  model_reasoning_summary: reasoningSummarySchema.nullable(),
  model_verbosity: verbositySchema.nullable(),
  service_tier: nullableIdentifierSchema,
  personality: personalitySchema.nullable(),
  windows_sandbox: windowsSandboxSchema.nullable(),
  shell_environment_include_only: environmentPatternsSchema,
  features: featureValuesSchema,
});

const configPatchSchema = editableCodexConfigSchema.partial().extend({
  features: featurePatchSchema.optional(),
});

const configUpdateSchema = z.strictObject({
  expectedVersion: z.string().min(1).nullable(),
  values: configPatchSchema.refine((value) => Object.keys(value).length > 0, {
    message: "At least one config value is required",
  }),
});

export type EditableCodexConfig = z.infer<typeof editableCodexConfigSchema>;
type ConfigUpdate = z.infer<typeof configUpdateSchema>;

export type ModelCapability = Readonly<
  Pick<
    Model,
    | "model"
    | "displayName"
    | "description"
    | "supportedReasoningEfforts"
    | "defaultReasoningEffort"
    | "serviceTiers"
    | "defaultServiceTier"
    | "isDefault"
  >
>;

export interface ModelProviderCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly allowed: boolean;
}

export interface FeatureCapability {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly stage: ExperimentalFeatureStage;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  readonly locked: boolean;
}

export interface ConfigCapabilities {
  readonly platform: NodeJS.Platform;
  readonly models: readonly ModelCapability[];
  readonly modelProviders: readonly ModelProviderCapability[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly features: readonly FeatureCapability[];
  readonly requirements: ConfigRequirements | null;
}

export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigValidationIssue {
  readonly path: string;
  readonly severity: ConfigIssueSeverity;
  readonly message: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export interface EditableConfigSnapshot {
  readonly version: string | null;
  readonly values: EditableCodexConfig;
  readonly capabilities: ConfigCapabilities;
  readonly validation: ConfigValidationResult;
}

export class ConfigValidationError extends BridgeError {
  public readonly issues: readonly ConfigValidationIssue[];

  public constructor(issues: readonly ConfigValidationIssue[]) {
    super("The config update is invalid", "INVALID_CONFIG");
    this.issues = issues;
    this.name = "ConfigValidationError";
  }
}

interface ConfigState {
  readonly version: string | null;
  readonly values: EditableCodexConfig;
  readonly capabilities: ConfigCapabilities;
}

interface CapabilitiesCache {
  readonly expiresAt: number;
  readonly value: Promise<CachedConfigCapabilities>;
}

type CachedConfigCapabilities = Omit<ConfigCapabilities, "modelProviders">;

const CAPABILITIES_CACHE_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const scalarConfigPaths = Object.freeze([
  ["model", "model"],
  ["model_provider", "model_provider"],
  ["approval_policy", "approval_policy"],
  ["approvals_reviewer", "approvals_reviewer"],
  ["sandbox_mode", "sandbox_mode"],
  ["default_permissions", "default_permissions"],
  ["web_search", "web_search"],
  ["model_reasoning_effort", "model_reasoning_effort"],
  ["model_reasoning_summary", "model_reasoning_summary"],
  ["model_verbosity", "model_verbosity"],
  ["service_tier", "service_tier"],
  ["personality", "personality"],
  ["windows_sandbox", "windows.sandbox"],
  ["shell_environment_include_only", "shell_environment_policy.include_only"],
] as const satisfies readonly (readonly [
  Exclude<keyof EditableCodexConfig, "features">,
  string,
])[]);

export class CodexConfigService {
  readonly #rpc: CodexAppServer;
  readonly #cwd: string;
  #capabilitiesCache: CapabilitiesCache | undefined;

  public constructor(rpc: CodexAppServer, cwd = process.cwd()) {
    this.#rpc = rpc;
    this.#cwd = cwd;
  }

  /** Drop app-server-derived catalogs after an external reload or child restart. */
  public invalidateCapabilities(): void {
    this.#capabilitiesCache = undefined;
  }

  public async read(): Promise<EditableConfigSnapshot> {
    const state = await this.readState();
    return {
      version: state.version,
      values: state.values,
      capabilities: state.capabilities,
      validation: structurallyValid(),
    };
  }

  /**
   * Structural validation only: the zod schemas that construct writes. Codex
   * itself is the authoritative semantic validator — the app-server runs with
   * --strict-config and rejects invalid saves in the version-checked
   * config/batchWrite, whose errors the Mini App already surfaces.
   */
  public validate(input: unknown): Promise<ConfigValidationResult> {
    configUpdateSchema.parse(input);
    return Promise.resolve(structurallyValid());
  }

  public async update(input: unknown): Promise<ConfigWriteResponse> {
    const update = configUpdateSchema.parse(input);
    const params: ConfigBatchWriteParams = {
      edits: editsForPatch(update.values),
      expectedVersion: update.expectedVersion,
      reloadUserConfig: true,
    };
    const response = await this.#rpc.request<ConfigWriteResponse>({
      method: "config/batchWrite",
      params,
    });
    this.#capabilitiesCache = undefined;
    return response;
  }

  private async readState(): Promise<ConfigState> {
    const [response, cachedCapabilities] = await Promise.all([
      this.#rpc.request<ConfigReadResponse>({
        method: "config/read",
        params: { includeLayers: true, cwd: this.#cwd },
      }),
      this.capabilities(),
    ]);
    const userLayer = findBaseUserLayer(response.layers);
    const capabilities: ConfigCapabilities = {
      ...cachedCapabilities,
      modelProviders: toModelProviderCapabilities(response),
    };
    return {
      version: userLayer?.version ?? null,
      values: parseUserValues(
        userLayer?.config,
        capabilities.features.map((feature) => feature.name),
      ),
      capabilities,
    };
  }

  private capabilities(): Promise<CachedConfigCapabilities> {
    const now = Date.now();
    const cached = this.#capabilitiesCache;
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    const value = this.loadCapabilities();
    this.#capabilitiesCache = { expiresAt: now + CAPABILITIES_CACHE_MS, value };
    void value.catch(() => {
      if (this.#capabilitiesCache?.value === value) this.#capabilitiesCache = undefined;
    });
    return value;
  }

  private async loadCapabilities(): Promise<CachedConfigCapabilities> {
    const [models, permissionProfiles, remoteFeatures, requirementsResponse] = await Promise.all([
      paginate("model", (cursor) =>
        this.#rpc.request<ModelListResponse>({
          method: "model/list",
          params: { cursor, limit: PAGE_SIZE, includeHidden: false },
        }),
      ),
      paginate("permission profile", (cursor) =>
        this.#rpc.request<PermissionProfileListResponse>({
          method: "permissionProfile/list",
          params: { cursor, limit: PAGE_SIZE, cwd: this.#cwd },
        }),
      ),
      paginate("feature", (cursor) =>
        this.#rpc.request<ExperimentalFeatureListResponse>({
          method: "experimentalFeature/list",
          params: { cursor, limit: PAGE_SIZE },
        }),
      ),
      this.#rpc.request<ConfigRequirementsReadResponse>({
        method: "configRequirements/read",
        params: undefined,
      }),
    ]);
    const requirements = requirementsResponse.requirements;
    return {
      platform: process.platform,
      models: models.filter((model) => !model.hidden).map(toModelCapability),
      permissionProfiles,
      features: toFeatureCapabilities(remoteFeatures, requirements),
      requirements,
    };
  }
}

async function paginate<Item>(
  label: string,
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ readonly data: readonly Item[]; readonly nextCursor: string | null }>,
): Promise<Item[]> {
  const values: Item[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchPage(cursor);
    values.push(...response.data);
    if (response.nextCursor === null) return values;
    cursor = response.nextCursor;
  }
  throw new BridgeError(`Codex ${label} list exceeded the pagination limit`, "CODEX_PAGINATION");
}

function parseUserValues(
  config: JsonValue | undefined,
  featureNames: readonly string[],
): EditableCodexConfig {
  const root = asRecord(config);
  // Every capability feature gets an entry (null = inherit); user-set flags
  // outside the catalog are preserved, and non-boolean entries are ignored.
  const features: Record<string, boolean | null> = Object.fromEntries(
    featureNames.map((name) => [name, null]),
  );
  for (const [name, value] of Object.entries(asRecord(root.features))) {
    if (!featureKeySchema.safeParse(name).success) continue;
    const parsed = z
      .boolean()
      .nullable()
      .safeParse(value ?? null);
    if (parsed.success) features[name] = parsed.data;
  }
  const values: Record<string, unknown> = { features };
  for (const [key, keyPath] of scalarConfigPaths) {
    values[key] = readPath(root, keyPath.split("."), editableCodexConfigSchema.shape[key]);
  }
  return editableCodexConfigSchema.parse(values);
}

function readPath(
  root: Readonly<Record<string, JsonValue | undefined>>,
  path: readonly string[],
  schema: z.ZodType<unknown>,
): unknown {
  let value: JsonValue | undefined = root;
  for (const segment of path) {
    const record = asRecord(value);
    value = record[segment];
  }
  return schema.parse(value ?? null);
}

function editsForPatch(patch: ConfigUpdate["values"]): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const [key, keyPath] of scalarConfigPaths) {
    if (!Object.hasOwn(patch, key)) continue;
    edits.push({
      keyPath,
      value: patch[key] as JsonValue,
      mergeStrategy: "upsert",
    });
  }
  for (const [key, value] of Object.entries(patch.features ?? {})) {
    edits.push({
      keyPath: `features.${key}`,
      value: value ?? null,
      mergeStrategy: "upsert",
    });
  }
  return edits;
}

function structurallyValid(): ConfigValidationResult {
  return { valid: true, issues: [] };
}

function toModelCapability(model: Model): ModelCapability {
  return {
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: model.serviceTiers,
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault,
  };
}

/** Wirebot is OpenAI-official-API-only; offer the builtin provider plus the one Codex runs with. */
function toModelProviderCapabilities(response: ConfigReadResponse): ModelProviderCapability[] {
  const providers: ModelProviderCapability[] = [
    {
      id: "openai",
      displayName: "OpenAI",
      description: "Built-in OpenAI model provider.",
      allowed: true,
    },
  ];
  const current = nullableIdentifierSchema.safeParse(response.config.model_provider);
  if (current.success && current.data !== null && current.data !== "openai") {
    providers.push({
      id: current.data,
      displayName: current.data,
      description: "Current model provider reported by Codex.",
      allowed: true,
    });
  }
  return providers;
}

/** The feature catalog comes from the running app-server, not a handwritten list. */
function toFeatureCapabilities(
  remote: readonly ExperimentalFeature[],
  requirements: ConfigRequirements | null,
): FeatureCapability[] {
  return remote
    .filter(
      (feature) =>
        feature.stage !== "deprecated" &&
        feature.stage !== "removed" &&
        featureKeySchema.safeParse(feature.name).success,
    )
    .map((feature) => ({
      name: feature.name,
      displayName: feature.displayName ?? sentenceCase(feature.name),
      description: feature.description ?? "",
      stage: feature.stage,
      enabled: feature.enabled,
      defaultEnabled: feature.defaultEnabled,
      locked: requirements?.featureRequirements?.[feature.name] !== undefined,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function sentenceCase(name: string): string {
  return capitalize(name.replaceAll("_", " "));
}

/** The profile-less "user" layer — the file the Mini App and hot reload treat as the user's config. */
export type BaseUserConfigLayer = ConfigLayer & {
  readonly name: Extract<ConfigLayerSource, { readonly type: "user" }>;
};

function isBaseUserLayer(layer: ConfigLayer): layer is BaseUserConfigLayer {
  return layer.name.type === "user" && layer.name.profile === null;
}

export function findBaseUserLayer(
  layers: readonly ConfigLayer[] | null,
): BaseUserConfigLayer | undefined {
  return layers?.find(isBaseUserLayer);
}

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue | undefined>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function requireUniqueStrings(
  values: readonly string[],
  context: z.core.$RefinementCtx<readonly string[]>,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Duplicate values are not allowed",
      });
    }
    seen.add(value);
  }
}
