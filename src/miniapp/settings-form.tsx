/**
 * The Settings tab: a typed draft of the editable Codex config plus Wirebot
 * settings, with live validation and version-checked saves. The draft holds
 * the same shape as the server values; field components map "" to null.
 */
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from "react";
import type {
  ConfigCapabilities,
  ConfigValidationIssue,
  ConfigValidationResult,
  EditableCodexConfig,
  FeatureCapability,
  ModelCapability,
} from "../codex/config-service.js";
import type { CodexRuntimeStatus } from "../codex/runtime-service.js";
import {
  ConfigApiError,
  type LoadedSnapshot,
  requestRuntime,
  requestSnapshot,
  requestValidation,
} from "./api.js";
import { ExpandableTextarea } from "./dialogs.js";
import { messageOf } from "./shared.js";
import { notifyHaptic, useUnsavedChanges } from "./telegram.js";
import { Banner, Button, Caption, Headline, Section, Switch } from "./ui.js";
import { UsageSection } from "./usage-section.js";

type FeatureName = FeatureCapability["name"];
type ApprovalPolicy = NonNullable<EditableCodexConfig["approval_policy"]>;
type ApprovalMode = Exclude<ApprovalPolicy, { granular: unknown }> | "granular";
type GranularApproval = Extract<ApprovalPolicy, { granular: unknown }>["granular"];
type ConfigRequirements = NonNullable<ConfigCapabilities["requirements"]>;

interface UiOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

const approvalOptions: readonly UiOption<ApprovalMode>[] = [
  { value: "untrusted", label: "Only untrusted commands" },
  { value: "on-request", label: "When Codex requests it" },
  { value: "granular", label: "Choose by category" },
  { value: "never", label: "Never ask" },
];

const reviewerOptions: readonly UiOption<NonNullable<EditableCodexConfig["approvals_reviewer"]>>[] =
  [
    { value: "user", label: "Me" },
    { value: "auto_review", label: "Automatic reviewer" },
  ];

const sandboxOptions: readonly UiOption<NonNullable<EditableCodexConfig["sandbox_mode"]>>[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full access" },
];

const searchOptions: readonly UiOption<NonNullable<EditableCodexConfig["web_search"]>>[] = [
  { value: "disabled", label: "Disabled" },
  { value: "cached", label: "Cached" },
  { value: "indexed", label: "Indexed" },
  { value: "live", label: "Live" },
];

const summaryOptions: readonly UiOption<
  NonNullable<EditableCodexConfig["model_reasoning_summary"]>
>[] = [
  { value: "auto", label: "Automatic" },
  { value: "concise", label: "Concise" },
  { value: "detailed", label: "Detailed" },
  { value: "none", label: "None" },
];

const verbosityOptions: readonly UiOption<NonNullable<EditableCodexConfig["model_verbosity"]>>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const personalityOptions: readonly UiOption<NonNullable<EditableCodexConfig["personality"]>>[] = [
  { value: "none", label: "None" },
  { value: "friendly", label: "Friendly" },
  { value: "pragmatic", label: "Pragmatic" },
];

const windowsSandboxOptions: readonly UiOption<
  NonNullable<EditableCodexConfig["windows_sandbox"]>
>[] = [
  { value: "elevated", label: "Elevated" },
  { value: "unelevated", label: "Unelevated" },
];

const defaultGranularApproval: GranularApproval = {
  sandbox_approval: true,
  rules: true,
  skill_approval: true,
  request_permissions: true,
  mcp_elicitations: true,
};

interface SettingsFormProps {
  readonly snapshot: LoadedSnapshot;
  readonly onSnapshot: (snapshot: LoadedSnapshot) => void;
}

export function SettingsForm({ snapshot, onSnapshot }: SettingsFormProps): ReactElement {
  const [draft, setDraft] = useState<EditableCodexConfig>(snapshot.values);
  const [environmentText, setEnvironmentText] = useState(() =>
    linesFromConfig(snapshot.values.shell_environment_include_only),
  );
  const [granular, setGranular] = useState<GranularApproval>(() =>
    granularApprovalOf(snapshot.values.approval_policy),
  );
  const [remoteClientContext, setRemoteClientContext] = useState(
    snapshot.wirebot.remoteClientContext,
  );
  const [saving, setSaving] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<"reload" | "restart">();
  const [validation, setValidation] = useState<ConfigValidationResult>(snapshot.validation);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState("Settings are up to date.");

  const normalizedValues = useMemo<EditableCodexConfig>(
    () => ({ ...draft, shell_environment_include_only: linesToConfig(environmentText) }),
    [draft, environmentText],
  );
  const changes = useMemo(
    () => changedConfig(snapshot.values, normalizedValues),
    [normalizedValues, snapshot.values],
  );
  const configDirty = Object.keys(changes).length > 0;
  const remoteClientContextDirty = remoteClientContext !== snapshot.wirebot.remoteClientContext;
  const dirty = configDirty || remoteClientContextDirty;
  useUnsavedChanges(dirty);

  useEffect(() => {
    if (!configDirty) {
      setValidating(false);
      setValidation(snapshot.validation);
      setNotice(dirty ? "Ready to save." : "Settings are up to date.");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setValidating(true);
      void requestValidation(
        { expectedVersion: snapshot.version, values: changes },
        controller.signal,
      )
        .then((result) => {
          setValidation(result);
          setNotice(result.valid ? "Ready to save." : "Fix the highlighted settings.");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ConfigApiError && error.issues !== undefined) {
            setValidation({ valid: false, issues: error.issues });
            setNotice("Fix the highlighted settings.");
            return;
          }
          setNotice(`Validation unavailable: ${messageOf(error)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setValidating(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [changes, configDirty, dirty, snapshot]);

  const updateDraft = (patch: Partial<EditableCodexConfig>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateModel = (value: string | null): void => {
    const models = snapshot.capabilities.models;
    setDraft((current) => {
      const model = resolveSelectedModel(value, models);
      const effortSupported =
        current.model_reasoning_effort === null ||
        model?.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === current.model_reasoning_effort,
        ) === true;
      const tierSupported =
        current.service_tier === null ||
        model?.serviceTiers.some((tier) => tier.id === current.service_tier) === true;
      return {
        ...current,
        model: value,
        model_reasoning_effort: effortSupported ? current.model_reasoning_effort : null,
        service_tier: tierSupported ? current.service_tier : null,
      };
    });
  };
  const updateGranularApproval = (key: keyof GranularApproval, value: boolean): void => {
    const next = { ...granular, [key]: value };
    setGranular(next);
    setDraft((current) => ({ ...current, approval_policy: { granular: next } }));
  };
  const updateFeature = (name: FeatureName, value: boolean): void => {
    setDraft((current) => ({
      ...current,
      features: { ...current.features, [name]: value },
    }));
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!dirty || saving || runtimeAction !== undefined) return;
    setSaving(true);
    setNotice("Saving…");
    try {
      const body = {
        expectedVersion: snapshot.version,
        values: changes,
        ...(remoteClientContextDirty ? { wirebot: { remoteClientContext } } : {}),
      };
      const loaded = await requestSnapshot("PUT", body);
      onSnapshot(loaded);
      setDraft(loaded.values);
      setEnvironmentText(linesFromConfig(loaded.values.shell_environment_include_only));
      setGranular(granularApprovalOf(loaded.values.approval_policy));
      setRemoteClientContext(loaded.wirebot.remoteClientContext);
      setValidation(loaded.validation);
      const overridden = loaded.writeOutcome?.status === "okOverridden";
      setNotice(
        overridden
          ? (loaded.writeOutcome?.overriddenMetadata?.message ??
              "Saved, but a higher-priority layer overrides this value.")
          : configDirty
            ? runtimeSaveNotice(loaded.runtime)
            : "Saved.",
      );
      notifyHaptic(
        overridden || loaded.runtime.state === "degraded" || loaded.runtime.restartRequired
          ? "warning"
          : "success",
      );
    } catch (error) {
      if (error instanceof ConfigApiError && error.issues !== undefined) {
        setValidation({ valid: false, issues: error.issues });
      }
      setNotice(messageOf(error));
      notifyHaptic("error");
    } finally {
      setSaving(false);
    }
  };

  const runRuntimeAction = async (action: "reload" | "restart"): Promise<void> => {
    if (runtimeAction !== undefined || dirty) return;
    setRuntimeAction(action);
    setNotice(action === "reload" ? "Applying Codex changes…" : "Restarting Codex…");
    try {
      const runtime = await requestRuntime(action);
      onSnapshot({ ...snapshot, runtime, writeOutcome: undefined });
      setNotice(runtimeActionNotice(runtime, action));
      notifyHaptic(runtime.state === "degraded" || runtime.restartRequired ? "warning" : "success");
    } catch (error) {
      setNotice(messageOf(error));
      notifyHaptic("error");
    } finally {
      setRuntimeAction(undefined);
    }
  };

  const issues = validation.issues;
  const capabilities = snapshot.capabilities;
  const requirements = capabilities.requirements;
  const selectedModel = resolveSelectedModel(draft.model, capabilities.models);
  const models = capabilities.models.map((model) => ({
    value: model.model,
    label: model.displayName,
  }));
  const serviceTiers =
    selectedModel?.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name })) ?? [];
  const serviceTierOptions = [{ value: "", label: "Standard" }, ...serviceTiers];
  const allowedApprovalPolicies = approvalModeSet(requirements?.allowedApprovalPolicies);
  const allowedSandboxModes = valueSet(requirements?.allowedSandboxModes);
  const allowedSearchModes = valueSet(requirements?.allowedWebSearchModes);
  const allowedWindowsSandboxes = valueSet(requirements?.allowedWindowsSandboxImplementations);
  const issueSummary = renderIssueSummary(issues);
  const approvalMode: ApprovalMode | null =
    draft.approval_policy === null
      ? null
      : typeof draft.approval_policy === "string"
        ? draft.approval_policy
        : "granular";

  const runtime = snapshot.runtime;
  const runtimeControlsDisabled = dirty || runtimeAction !== undefined;
  const runtimeSection = (
    <Section
      header="Codex runtime"
      footer={
        dirty
          ? "Save the draft before applying it to Codex."
          : "Reload uses Codex's native config, MCP, and skill refresh APIs. MCP changes become active on the next turn."
      }
    >
      <div className="runtimePanel">
        <div className="runtimeSummary">
          <span
            className={`runtimeDot runtimeDot-${runtime.restartRequired ? "degraded" : runtime.state}`}
            aria-hidden="true"
          />
          <div className="runtimeCopy">
            <strong>{runtimeStateLabel(runtime)}</strong>
            <Caption className="runtimeDetail">
              {runtime.lastError ??
                (runtime.restartRequired
                  ? "Restart Codex to apply startup-only changes."
                  : "Runtime configuration is loaded.")}
            </Caption>
          </div>
        </div>
        <div className="runtimeActions">
          <Button
            type="button"
            mode="bezeled"
            size="s"
            loading={runtimeAction === "reload"}
            disabled={runtimeControlsDisabled}
            onClick={() => void runRuntimeAction("reload")}
          >
            Apply changes
          </Button>
          <Button
            type="button"
            mode="bezeled"
            size="s"
            loading={runtimeAction === "restart"}
            disabled={runtimeControlsDisabled}
            onClick={() => void runRuntimeAction("restart")}
          >
            Restart Codex
          </Button>
        </div>
      </div>
    </Section>
  );

  const wirebotSection = (
    <Section
      header="Remote connection"
      footer="Enabled by default; Wirebot detects the current connector for each turn."
    >
      <ToggleField
        draftKey="wirebot.remoteClientContext"
        label="Remote session context"
        description="Tell Codex that you are connected remotely, so it avoids host-local UI and localhost handoffs."
        checked={remoteClientContext}
        disabled={false}
        issues={[]}
        fieldId="wirebot-remote-client-context"
        onChange={setRemoteClientContext}
      />
    </Section>
  );

  const modelSection = (
    <Section header="Model" footer="Options follow the selected model's live capabilities.">
      <SelectField
        draftKey="model"
        label="Model"
        description={selectedModel?.description ?? "The model Codex uses for new conversations."}
        value={selectedModel?.model ?? draft.model}
        disabled={models.length === 0}
        issues={issues}
        options={withCurrent(models, draft.model ?? "")}
        onChange={updateModel}
      />
      <ReasoningEffortField
        model={selectedModel}
        value={draft.model_reasoning_effort}
        issues={issues}
        onChange={(value) => updateDraft({ model_reasoning_effort: value })}
      />
      {serviceTiers.length === 0 ? undefined : (
        <SelectField
          draftKey="service_tier"
          label="Service tier"
          description={serviceTierDescription(selectedModel, draft.service_tier ?? "")}
          value={draft.service_tier}
          fallback={selectedModel?.defaultServiceTier ?? undefined}
          issues={issues}
          options={withCurrent(serviceTierOptions, draft.service_tier ?? "")}
          onChange={(value) => updateDraft({ service_tier: value })}
        />
      )}
      <SelectField
        draftKey="personality"
        label="Personality"
        description="The conversational style Codex should use."
        value={draft.personality}
        fallback="pragmatic"
        issues={issues}
        options={personalityOptions}
        onChange={(value) => updateDraft({ personality: value })}
      />
      <SelectField
        draftKey="model_reasoning_summary"
        label="Reasoning summary"
        description="How Codex summarizes its reasoning progress."
        value={draft.model_reasoning_summary}
        fallback="auto"
        issues={issues}
        options={summaryOptions}
        onChange={(value) => updateDraft({ model_reasoning_summary: value })}
      />
      <SelectField
        draftKey="model_verbosity"
        label="Verbosity"
        description="The preferred level of detail in answers."
        value={draft.model_verbosity}
        fallback="medium"
        issues={issues}
        options={verbosityOptions}
        onChange={(value) => updateDraft({ model_verbosity: value })}
      />
    </Section>
  );

  const permissionOptions = capabilities.permissionProfiles.map((profile) => ({
    value: profile.id,
    label: sentenceCase(profile.id),
    disabled: !profile.allowed,
  }));
  const accessSection = (
    <Section header="Access & approvals" footer="Managed requirements appear disabled.">
      <SelectField
        draftKey="default_permissions"
        label="Permission profile"
        description={permissionDescription(
          capabilities.permissionProfiles,
          draft.default_permissions ?? "",
        )}
        value={draft.default_permissions}
        disabled={permissionOptions.length === 0}
        issues={issues}
        options={[
          { value: "", label: "Direct sandbox settings" },
          ...withCurrent(permissionOptions, draft.default_permissions ?? ""),
        ]}
        onChange={(value) =>
          updateDraft({
            default_permissions: value,
            ...(value !== null ? { sandbox_mode: null } : {}),
          })
        }
      />
      <SelectField
        draftKey="approval_policy"
        label="Approval policy"
        description="When Codex pauses and asks before taking an action."
        value={approvalMode}
        fallback="on-request"
        issues={issues}
        options={constrainOptions(approvalOptions, allowedApprovalPolicies)}
        onChange={(mode) =>
          setDraft((current) => ({
            ...current,
            approval_policy: mode === "granular" ? { granular } : mode,
          }))
        }
      />
      {approvalMode === "granular" ? (
        <GranularApprovalFields
          value={granular}
          issues={issues}
          onChange={updateGranularApproval}
        />
      ) : undefined}
      <SelectField
        draftKey="approvals_reviewer"
        label="Approval reviewer"
        description="Choose who reviews approval requests."
        value={draft.approvals_reviewer}
        fallback="user"
        issues={issues}
        options={reviewerOptions}
        onChange={(value) => updateDraft({ approvals_reviewer: value })}
      />
      <SelectField
        draftKey="sandbox_mode"
        label="Sandbox"
        description="Filesystem access granted to Codex commands."
        value={draft.sandbox_mode}
        fallback="workspace-write"
        issues={issues}
        options={constrainOptions(sandboxOptions, allowedSandboxModes)}
        onChange={(value) =>
          updateDraft({
            sandbox_mode: value,
            ...(value !== null ? { default_permissions: null } : {}),
          })
        }
      />
      <SelectField
        draftKey="web_search"
        label="Web search"
        description="How Codex retrieves information from the internet."
        value={draft.web_search}
        fallback="live"
        issues={issues}
        options={constrainOptions(searchOptions, allowedSearchModes)}
        onChange={(value) => updateDraft({ web_search: value })}
      />
      {capabilities.platform === "win32" ? (
        <SelectField
          draftKey="windows_sandbox"
          label="Windows sandbox"
          description="How Windows sandbox setup is launched."
          value={draft.windows_sandbox}
          issues={issues}
          options={constrainOptions(windowsSandboxOptions, allowedWindowsSandboxes)}
          onChange={(value) => updateDraft({ windows_sandbox: value })}
        />
      ) : undefined}
    </Section>
  );

  const environmentSection = (
    <Section header="Environment" footer="One environment variable pattern per line.">
      <ListField
        draftKey="shell_environment_include_only"
        label="Shell environment allowlist"
        description="Only these environment variables are passed to commands."
        value={environmentText}
        disabled={false}
        issues={issues}
        onChange={setEnvironmentText}
      />
    </Section>
  );

  const featureRequirements = requirements?.featureRequirements;
  const featureSection =
    capabilities.features.length === 0 ? undefined : (
      <Section header="Features" footer="Availability and current state come directly from Codex.">
        {capabilities.features.map((capability) => {
          const name = capability.name;
          const requiredValue = featureRequirements?.[name];
          const locked = capability.locked || requiredValue !== undefined;
          const effective = requiredValue ?? capability.enabled;
          const description = [
            capability.description,
            locked ? `Managed: ${effective ? "on" : "off"}.` : undefined,
            `Stage: ${sentenceCase(capability.stage)}.`,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" ");
          return (
            <ToggleField
              key={name}
              draftKey={`features.${name}`}
              label={capability.displayName}
              description={description}
              checked={draft.features[name] ?? effective}
              disabled={locked}
              issues={issues}
              fieldId={`feature-${name}`}
              onChange={(value) => updateFeature(name, value)}
            />
          );
        })}
      </Section>
    );

  const dangerous =
    draft.sandbox_mode === "danger-full-access" && draft.approval_policy === "never" ? (
      <Banner
        className="bannerSpacing"
        header="Unrestricted autonomous access"
        subheader="Full access with approvals disabled lets Codex run without confirmation."
      />
    ) : undefined;
  const catalogWarning =
    models.length === 0 ? (
      <Banner
        className="bannerSpacing"
        header="Model catalog unavailable"
        subheader="Model settings are read-only until Codex returns its model capabilities."
      >
        <Button type="button" mode="bezeled" size="s" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </Banner>
    ) : undefined;
  const overrideMetadata = snapshot.writeOutcome?.overriddenMetadata;
  const overrideBanner =
    snapshot.writeOutcome?.status === "okOverridden" ? (
      <Banner
        className="bannerSpacing"
        header="Saved, but not currently effective"
        subheader={
          overrideMetadata === null || overrideMetadata === undefined
            ? "A higher-priority configuration layer overrides the saved value."
            : `${overrideMetadata.message} Effective value: ${displayValue(overrideMetadata.effectiveValue)}.`
        }
      />
    ) : undefined;

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const saveDisabled =
    !dirty || saving || validating || runtimeAction !== undefined || errorCount > 0;
  const saveText = !dirty
    ? "Up to date"
    : errorCount > 0
      ? "Fix validation issues"
      : "Save changes";
  const showSaveDock = dirty || saving || validating || errorCount > 0;

  return (
    <form onSubmit={(event) => void save(event)}>
      <main className={`page ${showSaveDock ? "pageWithSaveDock" : ""}`}>
        <header className="pageHeader">
          <div>
            <Headline Component="h1">Wirebot settings</Headline>
            <Caption className="pageSubtitle">Bridge behavior and Codex configuration</Caption>
          </div>
          <Caption className="revision">
            {snapshot.version === null ? "new file" : `rev ${snapshot.version.slice(0, 8)}`}
          </Caption>
        </header>
        {issueSummary}
        {overrideBanner}
        {catalogWarning}
        {dangerous}
        <div className="sectionStack">
          <UsageSection />
          {runtimeSection}
          {wirebotSection}
          {modelSection}
          {accessSection}
          {environmentSection}
          {featureSection}
        </div>
      </main>
      {showSaveDock ? (
        <div className="saveDock">
          <div className="saveDockInner">
            <Caption
              className={`saveStatus ${errorCount > 0 ? "saveStatusError" : dirty ? "saveStatusReady" : ""}`}
              aria-live="polite"
            >
              {validating ? "Checking settings…" : notice}
            </Caption>
            <Button type="submit" size="l" stretched loading={saving} disabled={saveDisabled}>
              {saveText}
            </Button>
          </div>
        </div>
      ) : undefined}
    </form>
  );
}

interface SelectFieldProps<Value extends string> {
  readonly draftKey: string;
  readonly label: string;
  readonly description: string;
  /** The typed draft value; null renders as the fallback (or empty) option. */
  readonly value: Value | null;
  readonly fallback?: Value | undefined;
  readonly disabled?: boolean | undefined;
  readonly issues: readonly ConfigValidationIssue[];
  readonly options: readonly UiOption<Value>[];
  readonly fieldId?: string | undefined;
  /** Receives null when the empty ("default") option is chosen. */
  readonly onChange: (value: Value | null) => void;
}

function SelectField<Value extends string>(props: SelectFieldProps<Value>): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  const fieldId = props.fieldId ?? `config-${props.draftKey}`;
  return (
    <div className="field">
      <Caption Component="label" className="controlLabel" htmlFor={fieldId}>
        {props.label}
      </Caption>
      <select
        id={fieldId}
        className={`nativeControl nativeSelect ${issue?.severity === "error" ? "nativeControlError" : ""}`}
        value={props.value ?? props.fallback ?? ""}
        disabled={props.disabled === true}
        onChange={(event) => {
          const selected = props.options.find(
            (option) => option.value === event.currentTarget.value,
          );
          props.onChange(selected === undefined || selected.value === "" ? null : selected.value);
        }}
      >
        {props.options.map((option) => (
          <option
            key={option.value || "explicit-default"}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      <Caption className={issue === undefined ? "fieldHint" : "fieldHint fieldIssue"}>
        {issue?.message ?? props.description}
      </Caption>
    </div>
  );
}

interface ToggleFieldProps {
  readonly draftKey: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly fieldId: string;
  readonly onChange: (value: boolean) => void;
}

function ToggleField(props: ToggleFieldProps): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  return (
    <div className="toggleField">
      <label className="toggleCopy" htmlFor={props.fieldId}>
        <Caption className="toggleLabel">{props.label}</Caption>
        <Caption className={issue === undefined ? "toggleHint" : "toggleHint fieldIssue"}>
          {issue?.message ?? props.description}
        </Caption>
      </label>
      <Switch
        id={props.fieldId}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        aria-label={props.label}
      />
    </div>
  );
}

interface ListFieldProps {
  readonly draftKey: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly onChange: (value: string) => void;
}

function ListField(props: ListFieldProps): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  return (
    <div className="field">
      <Caption Component="label" className="controlLabel" htmlFor={`config-${props.draftKey}`}>
        {props.label}
      </Caption>
      <ExpandableTextarea
        id={`config-${props.draftKey}`}
        className={`nativeControl nativeTextarea ${issue?.severity === "error" ? "nativeControlError" : ""}`}
        label={props.label.toLowerCase()}
        value={props.value}
        rows={3}
        placeholder="Leave empty to pass the full environment"
        disabled={props.disabled}
        onValueChange={props.onChange}
      />
      <Caption className={issue === undefined ? "fieldHint" : "fieldHint fieldIssue"}>
        {issue?.message ?? props.description}
      </Caption>
    </div>
  );
}

interface GranularApprovalFieldsProps {
  readonly value: GranularApproval;
  readonly issues: readonly ConfigValidationIssue[];
  readonly onChange: (key: keyof GranularApproval, value: boolean) => void;
}

function GranularApprovalFields(props: GranularApprovalFieldsProps): ReactElement {
  const definitions = [
    ["sandbox_approval", "Sandbox escalation", "Commands that need broader sandbox access."],
    ["rules", "Rules", "Actions governed by configured execution rules."],
    ["skill_approval", "Skills", "Skill actions that require explicit review."],
    ["request_permissions", "Permission requests", "Requests for additional permissions."],
    ["mcp_elicitations", "MCP elicitations", "Interactive requests initiated by MCP servers."],
  ] as const satisfies readonly (readonly [keyof GranularApproval, string, string])[];
  return (
    <>
      {definitions.map(([key, label, description]) => (
        <ToggleField
          key={key}
          draftKey={`approval_policy.granular.${key}`}
          label={label}
          description={description}
          checked={props.value[key]}
          disabled={false}
          issues={props.issues}
          fieldId={`approval-granular-${key}`}
          onChange={(next) => props.onChange(key, next)}
        />
      ))}
    </>
  );
}

interface ReasoningEffortFieldProps {
  readonly model: ModelCapability | undefined;
  readonly value: string | null;
  readonly issues: readonly ConfigValidationIssue[];
  readonly onChange: (value: string) => void;
}

function ReasoningEffortField(props: ReasoningEffortFieldProps): ReactElement {
  const efforts = props.model?.supportedReasoningEfforts ?? [];
  const effectiveValue =
    efforts.find((effort) => effort.reasoningEffort === props.value)?.reasoningEffort ??
    props.model?.defaultReasoningEffort ??
    efforts[0]?.reasoningEffort ??
    "";
  const issue = primaryIssue(props.issues, "model_reasoning_effort");
  const description = reasoningDescription(props.model, effectiveValue);
  return (
    <div className="field reasoningField">
      <div className="reasoningHeader">
        <Caption className="controlLabel">Reasoning effort</Caption>
        <Caption className="reasoningValue" aria-live="polite">
          {sentenceCase(effectiveValue)}
        </Caption>
      </div>
      <div className="effortPicker">
        {efforts.map((effort) => {
          const selected = effort.reasoningEffort === effectiveValue;
          return (
            <button
              key={effort.reasoningEffort}
              type="button"
              className={selected ? "weekdayButton weekdayButtonSelected" : "weekdayButton"}
              aria-pressed={selected}
              aria-label={`Reasoning effort: ${sentenceCase(effort.reasoningEffort)}`}
              disabled={efforts.length < 2}
              onClick={() => props.onChange(effort.reasoningEffort)}
            >
              {sentenceCase(effort.reasoningEffort)}
            </button>
          );
        })}
      </div>
      <Caption className={issue === undefined ? "fieldHint" : "fieldHint fieldIssue"}>
        {issue?.message ?? description}
      </Caption>
    </div>
  );
}

function renderIssueSummary(issues: readonly ConfigValidationIssue[]): ReactElement | undefined {
  if (issues.length === 0) return undefined;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const visible = [...errors, ...warnings].slice(0, 3);
  return (
    <Banner
      className="bannerSpacing"
      header={
        errors.length > 0
          ? `${errors.length} setting${errors.length === 1 ? " needs" : "s need"} attention`
          : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
      }
      subheader={visible.map((issue) => issue.message).join(" · ")}
    />
  );
}

function granularApprovalOf(policy: EditableCodexConfig["approval_policy"]): GranularApproval {
  return typeof policy === "object" && policy !== null ? policy.granular : defaultGranularApproval;
}

function changedConfig(
  current: EditableCodexConfig,
  candidate: EditableCodexConfig,
): Partial<EditableCodexConfig> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(candidate) as readonly (keyof EditableCodexConfig)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(candidate[key])) {
      changed[key] = candidate[key];
    }
  }
  return changed as Partial<EditableCodexConfig>;
}

function resolveSelectedModel(
  model: string | null,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return model === null || model.length === 0
    ? (models.find((candidate) => candidate.isDefault) ?? models[0])
    : models.find((candidate) => candidate.model === model);
}

function reasoningDescription(model: ModelCapability | undefined, effort: string): string {
  if (model === undefined) return "How much reasoning the model should use.";
  const selected = model.supportedReasoningEfforts.find(
    (option) => option.reasoningEffort === effort,
  );
  return selected?.description ?? "How much reasoning the selected model should use.";
}

function serviceTierDescription(model: ModelCapability | undefined, tier: string): string {
  if (tier.length === 0) return "Standard speed and credit usage.";
  const selected = model?.serviceTiers.find((option) => option.id === tier);
  return selected?.description ?? "The selected model's latency and capacity tier.";
}

function permissionDescription(
  profiles: ConfigCapabilities["permissionProfiles"],
  selected: string,
): string {
  return (
    profiles.find((profile) => profile.id === selected)?.description ??
    "A bundled or custom permission profile for Codex tools."
  );
}

function withCurrent(options: readonly UiOption[], current: string): UiOption[] {
  if (current.length === 0 || options.some((option) => option.value === current))
    return [...options];
  return [{ value: current, label: `${sentenceCase(current)} (current)` }, ...options];
}

function constrainOptions<Value extends string>(
  options: readonly UiOption<Value>[],
  allowed: ReadonlySet<string> | undefined,
): UiOption<Value>[] {
  return options.map((option) => ({
    ...option,
    ...(allowed === undefined ? {} : { disabled: !allowed.has(option.value) }),
  }));
}

function primaryIssue(
  issues: readonly ConfigValidationIssue[],
  draftKey: string,
): ConfigValidationIssue | undefined {
  return issues.find((issue) => issue.path === draftKey || issue.path.endsWith(`.${draftKey}`));
}

function linesFromConfig(value: readonly string[] | null): string {
  return value?.join("\n") ?? "";
}

function linesToConfig(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? null : lines;
}

function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return words.length === 0 ? words : `${words[0]?.toUpperCase()}${words.slice(1)}`;
}

function valueSet(values: readonly string[] | null | undefined): ReadonlySet<string> | undefined {
  return values === null || values === undefined ? undefined : new Set(values);
}

function approvalModeSet(
  policies: ConfigRequirements["allowedApprovalPolicies"] | undefined,
): ReadonlySet<string> | undefined {
  if (policies === null || policies === undefined) return undefined;
  return new Set(policies.map((policy) => (typeof policy === "string" ? policy : "granular")));
}

function displayValue(value: unknown): string {
  let displayed: string;
  if (typeof value === "string") {
    displayed = value;
  } else {
    try {
      displayed = JSON.stringify(value) ?? "unknown";
    } catch {
      displayed = "unavailable";
    }
  }
  const singleLine = displayed.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 119)}…`;
}

function runtimeStateLabel(runtime: CodexRuntimeStatus): string {
  if (runtime.restartRequired) return "Restart recommended";
  switch (runtime.state) {
    case "ready":
      return "Ready for the next turn";
    case "reloading":
      return "Applying changes";
    case "restarting":
      return "Restarting Codex";
    case "degraded":
      return "Some resources need attention";
  }
}

function runtimeSaveNotice(runtime: CodexRuntimeStatus): string {
  if (runtime.restartRequired) {
    return "Saved. Restart Codex to apply the startup-only changes.";
  }
  return runtime.state === "degraded"
    ? "Saved. Some Codex resources could not refresh; check runtime status."
    : "Saved. Changes apply on the next turn.";
}

function runtimeActionNotice(runtime: CodexRuntimeStatus, action: "reload" | "restart"): string {
  if (runtime.restartRequired) {
    return action === "reload"
      ? "Reloaded available resources. Restart Codex to apply startup-only changes."
      : "Restart did not complete; check runtime status and retry.";
  }
  if (runtime.state === "degraded") {
    return action === "reload"
      ? "Reload finished with warnings; check runtime status."
      : "Restart needs attention; check runtime status.";
  }
  return action === "reload"
    ? "Config and skills refreshed; MCP changes are queued for the next turn."
    : "Codex restarted and is ready.";
}
