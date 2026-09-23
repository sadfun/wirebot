/**
 * The Settings tab: a summary home on phones, and one page per topic (Model,
 * Access & approvals, Features, Environment, Remote session). Each page keeps
 * its own draft, validates it live, and saves with a version-checked write.
 */
import { LogOut } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { cn } from "./cn.js";
import { useAppData } from "./data.js";
import { ExpandableTextarea } from "./dialogs.js";
import {
  BottomBar,
  ContentHeader,
  type RailSettingsPage,
  Screen,
  ScreenBody,
  SubpageHeader,
  TabBar,
  useDesktop,
  useSubpageBack,
} from "./layout.js";
import { WirebotLogo } from "./logo.js";
import { isSettingsPage, type Route, routeLink, type SettingsPage, useRoute } from "./route.js";
import { messageOf } from "./shared.js";
import { notifyHaptic, telegramReady, useUnsavedChanges } from "./telegram.js";
import {
  Badge,
  Banner,
  Button,
  Field,
  Group,
  Hint,
  LoadingState,
  Notice,
  Row,
  RowButton,
  RowLink,
  Rule,
  SectionLabel,
  Segmented,
  Spinner,
  ToggleRow,
} from "./ui.js";
import { UsageCard } from "./usage.js";

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

interface PageNotice {
  readonly tone: "success" | "warning" | "error";
  readonly text: string;
}

const pageTitles: Readonly<Record<SettingsPage, string>> = {
  model: "Model",
  access: "Access & approvals",
  features: "Features",
  environment: "Environment",
  remote: "Remote session",
};

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

const windowsSandboxOptions: readonly UiOption<
  NonNullable<EditableCodexConfig["windows_sandbox"]>
>[] = [
  { value: "elevated", label: "Elevated" },
  { value: "unelevated", label: "Unelevated" },
];

const granularDefinitions = [
  ["sandbox_approval", "Sandbox escalation", "Commands that need broader sandbox access."],
  ["rules", "Rules", "Actions governed by configured execution rules."],
  ["skill_approval", "Skills", "Skill actions that require explicit review."],
  ["request_permissions", "Permission requests", "Requests for additional permissions."],
  ["mcp_elicitations", "MCP elicitations", "Interactive requests initiated by MCP servers."],
] as const satisfies readonly (readonly [keyof GranularApproval, string, string])[];

const defaultGranularApproval: GranularApproval = {
  sandbox_approval: true,
  rules: true,
  skill_approval: true,
  request_permissions: true,
  mcp_elicitations: true,
};

const settingsRoute: Route = { tab: "settings" };

export function SettingsTab(): ReactElement {
  const route = useRoute();
  const desktop = useDesktop();
  const data = useAppData();
  const page = isSettingsPage(route.detail) ? route.detail : undefined;
  if (data.snapshot === undefined) {
    const loading = (
      <LoadingState
        header={
          data.snapshotError === undefined ? "Loading Codex settings" : "Couldn’t open settings"
        }
        description="Reading the effective config and capabilities…"
        error={data.snapshotError}
        onRetry={data.reloadSnapshot}
      />
    );
    if (desktop) return loading;
    return (
      <Screen>
        {loading}
        <TabBar route={route} />
      </Screen>
    );
  }
  if (desktop) return <SettingsPageView page={page ?? "model"} desktop />;
  if (page === undefined) return <SettingsHome snapshot={data.snapshot} route={route} />;
  return <SettingsPageView page={page} desktop={false} />;
}

/** Labels and current values for the desktop rail and the phone home list. */
export function settingsRailPages(snapshot: LoadedSnapshot): readonly RailSettingsPage[] {
  const values = snapshot.values;
  const capabilities = snapshot.capabilities;
  const model = resolveSelectedModel(values.model, capabilities.models);
  const effort = values.model_reasoning_effort ?? model?.defaultReasoningEffort ?? null;
  const modelValue = [model?.displayName ?? values.model ?? "Default", effort]
    .filter((part): part is string => part !== null)
    .map(sentenceCaseIfCode)
    .join(" · ");
  const accessValue =
    values.default_permissions !== null && values.default_permissions.length > 0
      ? sentenceCase(values.default_permissions)
      : (sandboxOptions.find(
          (option) => option.value === (values.sandbox_mode ?? "workspace-write"),
        )?.label ?? "Workspace write");
  const total = capabilities.features.length;
  const enabled = capabilities.features.filter((capability) =>
    effectiveFeature(capability, values.features, capabilities.requirements),
  ).length;
  const patterns = values.shell_environment_include_only;
  return [
    { page: "model", label: "Model", value: modelValue },
    { page: "access", label: "Access & approvals", value: accessValue },
    {
      page: "features",
      label: "Features",
      value: total === 0 ? "None" : `${enabled} of ${total} on`,
    },
    {
      page: "environment",
      label: "Environment",
      value:
        patterns === null || patterns.length === 0
          ? "All variables"
          : `${patterns.length} pattern${patterns.length === 1 ? "" : "s"}`,
    },
    {
      page: "remote",
      label: "Remote session",
      value: snapshot.wirebot.remoteClientContext ? "On" : "Off",
    },
  ];
}

function SettingsHome({
  snapshot,
  route,
}: {
  readonly snapshot: LoadedSnapshot;
  readonly route: Route;
}): ReactElement {
  const data = useAppData();
  const rows = settingsRailPages(snapshot).filter((entry) => entry.page !== "remote");
  return (
    <Screen>
      <header className="brandHeader">
        <WirebotLogo className="brandHeader-logo" />
      </header>
      <ScreenBody className="stack">
        <UsageCard />
        <section className="section">
          <SectionLabel>Codex configuration</SectionLabel>
          <Group>
            {rows.map((entry) => (
              <RowLink
                key={entry.page}
                label={entry.label}
                value={entry.value}
                chevron
                {...routeLink({ tab: "settings", detail: entry.page })}
              />
            ))}
          </Group>
          <Hint>Each page saves on its own. Changes apply on the next Codex turn.</Hint>
        </section>
        <section className="section">
          <Group>
            <RemoteContextToggle />
          </Group>
        </section>
        <RuntimeBlock variant="rows" />
        <div className="versionLine">
          <span>
            {snapshot.wirebotVersion === undefined
              ? "Wirebot"
              : `Wirebot ${snapshot.wirebotVersion}`}
          </span>
          {telegramReady ? undefined : (
            <button
              type="button"
              className="linkButton"
              disabled={data.signOutBusy}
              onClick={data.signOut}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          )}
        </div>
        {data.signOutError === undefined ? undefined : (
          <Notice tone="error">{data.signOutError}</Notice>
        )}
      </ScreenBody>
      <TabBar route={route} />
    </Screen>
  );
}

interface SettingsPageViewProps {
  readonly page: SettingsPage;
  readonly desktop: boolean;
}

function SettingsPageView({ page, desktop }: SettingsPageViewProps): ReactElement {
  useSubpageBack(settingsRoute);
  const title = pageTitles[page];
  const body =
    page === "remote" ? <RemotePage /> : <ConfigPage key={page} page={page} desktop={desktop} />;
  if (desktop) return body;
  return (
    <Screen className="screen-subpage">
      <SubpageHeader back={{ label: "Settings", route: settingsRoute }} title={title} />
      {body}
    </Screen>
  );
}

/** The wrapper both page kinds use: desktop header plus body, or the phone body. */
function PageFrame({
  page,
  desktop,
  actions,
  bottom,
  children,
}: {
  readonly page: SettingsPage;
  readonly desktop: boolean;
  readonly actions?: ReactNode;
  readonly bottom?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  if (desktop) {
    return (
      <>
        <ContentHeader crumbs={["Settings", pageTitles[page]]}>{actions}</ContentHeader>
        <main className="paneBody">
          <div className="form">{children}</div>
        </main>
      </>
    );
  }
  return (
    <>
      <ScreenBody className={cn("form", bottom !== undefined && "screenBody-withBar")}>
        {children}
      </ScreenBody>
      {bottom}
    </>
  );
}

function RemotePage(): ReactElement {
  const desktop = useDesktop();
  return (
    <PageFrame page="remote" desktop={desktop}>
      <Group>
        <RemoteContextToggle />
      </Group>
      <Hint>
        Enabled by default. Wirebot detects the current connector for each turn and tells Codex it
        is being used remotely.
      </Hint>
    </PageFrame>
  );
}

/** The remote-session toggle saves immediately; it is not part of a draft. */
function RemoteContextToggle(): ReactElement {
  const data = useAppData();
  const [pending, setPending] = useState<boolean>();
  const [error, setError] = useState<string>();
  const snapshot = data.snapshot;
  const current = snapshot?.wirebot.remoteClientContext ?? true;
  const change = async (next: boolean): Promise<void> => {
    if (snapshot === undefined || pending !== undefined) return;
    setPending(next);
    setError(undefined);
    try {
      const loaded = await requestSnapshot("PUT", {
        expectedVersion: snapshot.version,
        values: {},
        wirebot: { remoteClientContext: next },
      });
      data.setSnapshot(loaded);
      notifyHaptic("success");
    } catch (changeError) {
      setError(messageOf(changeError));
      notifyHaptic("error");
    } finally {
      setPending(undefined);
    }
  };
  return (
    <ToggleRow
      id="wirebot-remote-client-context"
      label="Remote session context"
      detail={error ?? "Codex avoids host-local UI and localhost handoffs."}
      checked={pending ?? current}
      busy={pending !== undefined}
      onChange={(next) => void change(next)}
    />
  );
}

interface RuntimeActions {
  readonly runtime: CodexRuntimeStatus;
  readonly action: "reload" | "restart" | undefined;
  readonly notice: PageNotice | undefined;
  readonly run: (action: "reload" | "restart") => void;
}

function useRuntimeActions(): RuntimeActions | undefined {
  const data = useAppData();
  const [action, setAction] = useState<"reload" | "restart">();
  const [notice, setNotice] = useState<PageNotice>();
  const snapshot = data.snapshot;
  if (snapshot === undefined) return undefined;
  const run = (next: "reload" | "restart"): void => {
    if (action !== undefined) return;
    setAction(next);
    setNotice(undefined);
    void requestRuntime(next)
      .then((runtime) => {
        data.setSnapshot({ ...snapshot, runtime, writeOutcome: undefined });
        const warning = runtime.state === "degraded" || runtime.restartRequired;
        setNotice({
          tone: warning ? "warning" : "success",
          text: runtimeActionNotice(runtime, next),
        });
        notifyHaptic(warning ? "warning" : "success");
      })
      .catch((error: unknown) => {
        setNotice({ tone: "error", text: messageOf(error) });
        notifyHaptic("error");
      })
      .finally(() => setAction(undefined));
  };
  return { runtime: snapshot.runtime, action, notice, run };
}

function RuntimeBlock({
  variant,
  disabled = false,
}: {
  readonly variant: "rows" | "inline";
  readonly disabled?: boolean;
}): ReactElement | undefined {
  const actions = useRuntimeActions();
  if (actions === undefined) return undefined;
  const { runtime, action, notice, run } = actions;
  const state = runtime.restartRequired ? "degraded" : runtime.state;
  const detail =
    runtime.lastError ??
    (runtime.restartRequired
      ? "Restart Codex to apply startup-only changes."
      : "Runtime configuration is loaded.");
  const controlsDisabled = disabled || action !== undefined;
  if (variant === "rows") {
    return (
      <section className="section">
        <SectionLabel>Runtime</SectionLabel>
        {notice === undefined ? undefined : <Notice tone={notice.tone}>{notice.text}</Notice>}
        <Group>
          <Row
            before={<span className={`statusDot statusDot-${state}`} aria-hidden="true" />}
            label={runtimeStateLabel(runtime)}
            detail={detail}
          />
          <RowButton
            tone="primary"
            label="Apply saved changes"
            after={action === "reload" ? <Spinner /> : undefined}
            disabled={controlsDisabled}
            onClick={() => run("reload")}
          />
          <RowButton
            tone="primary"
            label="Restart Codex"
            after={action === "restart" ? <Spinner /> : undefined}
            disabled={controlsDisabled}
            onClick={() => run("restart")}
          />
        </Group>
        <Hint>
          Apply reloads config, MCP and skills without a restart. Restart is only needed for
          startup-only changes.
        </Hint>
      </section>
    );
  }
  return (
    <>
      <Rule />
      <Field label="Runtime" as="span">
        <div className="runtime">
          {notice === undefined ? undefined : <Notice tone={notice.tone}>{notice.text}</Notice>}
          <div className="runtime-status">
            <span className={`statusDot statusDot-${state}`} aria-hidden="true" />
            <span>{runtimeStateLabel(runtime)}</span>
          </div>
          <div className="runtime-actions">
            <Button
              variant="secondary"
              size="s"
              loading={action === "reload"}
              disabled={controlsDisabled}
              onClick={() => run("reload")}
            >
              Apply saved changes
            </Button>
            <Button
              variant="secondary"
              size="s"
              loading={action === "restart"}
              disabled={controlsDisabled}
              onClick={() => run("restart")}
            >
              Restart Codex
            </Button>
          </div>
          <div className="field-hint">
            {disabled ? "Save the draft before applying it to Codex." : detail}
          </div>
        </div>
      </Field>
    </>
  );
}

interface SettingsDraft {
  readonly draft: EditableCodexConfig;
  readonly environmentText: string;
  readonly granular: GranularApproval;
  readonly changes: Partial<EditableCodexConfig>;
  readonly changeCount: number;
  readonly dirty: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly errorCount: number;
  readonly validating: boolean;
  readonly saving: boolean;
  readonly notice: PageNotice | undefined;
  readonly banners: ReactNode;
  readonly updateDraft: (patch: Partial<EditableCodexConfig>) => void;
  readonly updateModel: (value: string | null) => void;
  readonly updateGranular: (key: keyof GranularApproval, value: boolean) => void;
  readonly updateFeature: (name: FeatureName, value: boolean) => void;
  readonly setEnvironmentText: (value: string) => void;
  readonly discard: () => void;
  readonly save: () => Promise<void>;
}

function useSettingsDraft(snapshot: LoadedSnapshot): SettingsDraft {
  const data = useAppData();
  const [draft, setDraft] = useState<EditableCodexConfig>(snapshot.values);
  const [environmentText, setEnvironmentText] = useState(() =>
    linesFromConfig(snapshot.values.shell_environment_include_only),
  );
  const [granular, setGranular] = useState<GranularApproval>(() =>
    granularApprovalOf(snapshot.values.approval_policy),
  );
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<ConfigValidationResult>(snapshot.validation);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState<PageNotice>();
  const [override, setOverride] = useState<LoadedSnapshot["writeOutcome"]>();

  const normalizedValues = useMemo<EditableCodexConfig>(
    () => ({ ...draft, shell_environment_include_only: linesToConfig(environmentText) }),
    [draft, environmentText],
  );
  const changes = useMemo(
    () => changedConfig(snapshot.values, normalizedValues),
    [normalizedValues, snapshot.values],
  );
  const changeCount = Object.keys(changes).length;
  const dirty = changeCount > 0;
  useUnsavedChanges(dirty);

  const resetFrom = useCallback((loaded: LoadedSnapshot): void => {
    setDraft(loaded.values);
    setEnvironmentText(linesFromConfig(loaded.values.shell_environment_include_only));
    setGranular(granularApprovalOf(loaded.values.approval_policy));
    setValidation(loaded.validation);
  }, []);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Another page or a runtime action may refresh the snapshot underneath a clean draft.
  useEffect(() => {
    if (!dirtyRef.current) resetFrom(snapshot);
  }, [snapshot, resetFrom]);

  useEffect(() => {
    if (!dirty) {
      setValidating(false);
      setValidation(snapshot.validation);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setValidating(true);
      void requestValidation(
        { expectedVersion: snapshot.version, values: changes },
        controller.signal,
      )
        .then((result) => setValidation(result))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ConfigApiError && error.issues !== undefined) {
            setValidation({ valid: false, issues: error.issues });
            return;
          }
          setNotice({ tone: "warning", text: `Validation unavailable: ${messageOf(error)}` });
        })
        .finally(() => {
          if (!controller.signal.aborted) setValidating(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [changes, dirty, snapshot]);

  const updateDraft = (patch: Partial<EditableCodexConfig>): void => {
    setNotice(undefined);
    setOverride(undefined);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateModel = (value: string | null): void => {
    const models = snapshot.capabilities.models;
    setNotice(undefined);
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
  const updateGranular = (key: keyof GranularApproval, value: boolean): void => {
    const next = { ...granular, [key]: value };
    setGranular(next);
    updateDraft({ approval_policy: { granular: next } });
  };
  const updateFeature = (name: FeatureName, value: boolean): void => {
    setNotice(undefined);
    setDraft((current) => ({ ...current, features: { ...current.features, [name]: value } }));
  };
  const discard = (): void => {
    resetFrom(snapshot);
    setNotice(undefined);
  };
  const save = async (): Promise<void> => {
    if (!dirty || saving) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const loaded = await requestSnapshot("PUT", {
        expectedVersion: snapshot.version,
        values: changes,
      });
      data.setSnapshot(loaded);
      resetFrom(loaded);
      setOverride(loaded.writeOutcome);
      const overridden = loaded.writeOutcome?.status === "okOverridden";
      const warning =
        overridden || loaded.runtime.state === "degraded" || loaded.runtime.restartRequired;
      setNotice({
        tone: warning ? "warning" : "success",
        text: overridden
          ? (loaded.writeOutcome?.overriddenMetadata?.message ??
            "Saved, but a higher-priority layer overrides this value.")
          : runtimeSaveNotice(loaded.runtime),
      });
      notifyHaptic(warning ? "warning" : "success");
    } catch (error) {
      if (error instanceof ConfigApiError && error.issues !== undefined) {
        setValidation({ valid: false, issues: error.issues });
      }
      setNotice({ tone: "error", text: messageOf(error) });
      notifyHaptic("error");
    } finally {
      setSaving(false);
    }
  };

  const issues = validation.issues;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const overrideMetadata = override?.overriddenMetadata;
  const banners = (
    <>
      {renderIssueSummary(issues)}
      {override?.status === "okOverridden" ? (
        <Banner
          header="Saved, but not currently effective"
          subheader={
            overrideMetadata === null || overrideMetadata === undefined
              ? "A higher-priority configuration layer overrides the saved value."
              : `${overrideMetadata.message} Effective value: ${displayValue(overrideMetadata.effectiveValue)}.`
          }
        />
      ) : undefined}
    </>
  );

  return {
    draft,
    environmentText,
    granular,
    changes,
    changeCount,
    dirty,
    issues,
    errorCount,
    validating,
    saving,
    notice,
    banners,
    updateDraft,
    updateModel,
    updateGranular,
    updateFeature,
    setEnvironmentText: (value) => {
      setNotice(undefined);
      setEnvironmentText(value);
    },
    discard,
    save,
  };
}

function ConfigPage({
  page,
  desktop,
}: {
  readonly page: Exclude<SettingsPage, "remote">;
  readonly desktop: boolean;
}): ReactElement {
  const data = useAppData();
  const snapshot = data.snapshot;
  if (snapshot === undefined) throw new Error("Settings pages need a loaded snapshot");
  const form = useSettingsDraft(snapshot);
  const saveDisabled = !form.dirty || form.saving || form.validating || form.errorCount > 0;
  const status = form.saving
    ? "Saving…"
    : form.validating
      ? "Checking settings…"
      : form.errorCount > 0
        ? "Fix the highlighted settings"
        : `${form.changeCount} change${form.changeCount === 1 ? "" : "s"} · ready to save`;
  const showBar = form.dirty || form.saving;
  const fields =
    page === "model" ? (
      <ModelFields form={form} snapshot={snapshot} desktop={desktop} />
    ) : page === "access" ? (
      <AccessFields form={form} snapshot={snapshot} />
    ) : page === "features" ? (
      <FeatureFields form={form} snapshot={snapshot} />
    ) : (
      <EnvironmentFields form={form} />
    );
  return (
    <PageFrame
      page={page}
      desktop={desktop}
      actions={
        showBar ? (
          <>
            <span className={cn("contentHeader-status", form.errorCount > 0 && "text-error")}>
              {status}
            </span>
            <Button variant="secondary" size="s" disabled={form.saving} onClick={form.discard}>
              Discard
            </Button>
            <Button
              size="s"
              loading={form.saving}
              disabled={saveDisabled}
              onClick={() => void form.save()}
            >
              Save
            </Button>
          </>
        ) : undefined
      }
      bottom={
        showBar ? (
          <BottomBar
            status={
              <span className={form.errorCount > 0 ? "text-error" : undefined}>{status}</span>
            }
          >
            <Button
              size="l"
              stretched
              loading={form.saving}
              disabled={saveDisabled}
              onClick={() => void form.save()}
            >
              Save changes
            </Button>
          </BottomBar>
        ) : undefined
      }
    >
      {form.notice === undefined ? undefined : (
        <Notice tone={form.notice.tone}>{form.notice.text}</Notice>
      )}
      {form.banners}
      {fields}
    </PageFrame>
  );
}

interface FieldsProps {
  readonly form: SettingsDraft;
  readonly snapshot: LoadedSnapshot;
}

function ModelFields({
  form,
  snapshot,
  desktop,
}: FieldsProps & { readonly desktop: boolean }): ReactElement {
  const { draft, issues, changes } = form;
  const capabilities = snapshot.capabilities;
  const selectedModel = resolveSelectedModel(draft.model, capabilities.models);
  const models = capabilities.models.map((model) => ({
    value: model.model,
    label: model.displayName,
  }));
  const serviceTiers =
    selectedModel?.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name })) ?? [];
  return (
    <>
      {models.length === 0 ? (
        <Banner
          header="Model catalog unavailable"
          subheader="Model settings are read-only until Codex returns its model capabilities."
        >
          <Button variant="secondary" size="s" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Banner>
      ) : undefined}
      <SelectField
        id="config-model"
        label="Model"
        hint={selectedModel?.description ?? "The model Codex uses for new conversations."}
        value={selectedModel?.model ?? draft.model}
        disabled={models.length === 0}
        issue={primaryIssue(issues, "model")}
        changed={"model" in changes}
        options={withCurrent(models, draft.model ?? "")}
        onChange={form.updateModel}
      />
      <ReasoningEffortField
        model={selectedModel}
        value={draft.model_reasoning_effort}
        issue={primaryIssue(issues, "model_reasoning_effort")}
        changed={"model_reasoning_effort" in changes}
        onChange={(value) => form.updateDraft({ model_reasoning_effort: value })}
      />
      {serviceTiers.length === 0 ? undefined : (
        <SelectField
          id="config-service_tier"
          label="Service tier"
          hint={serviceTierDescription(selectedModel, draft.service_tier ?? "")}
          value={draft.service_tier}
          fallback={selectedModel?.defaultServiceTier ?? undefined}
          issue={primaryIssue(issues, "service_tier")}
          changed={"service_tier" in changes}
          options={withCurrent(
            [{ value: "", label: "Standard" }, ...serviceTiers],
            draft.service_tier ?? "",
          )}
          onChange={(value) => form.updateDraft({ service_tier: value })}
        />
      )}
      <Rule />
      <SelectField
        id="config-model_reasoning_summary"
        label="Reasoning summary"
        hint="How Codex summarizes its reasoning progress while it works."
        value={draft.model_reasoning_summary}
        fallback="auto"
        issue={primaryIssue(issues, "model_reasoning_summary")}
        changed={"model_reasoning_summary" in changes}
        options={summaryOptions}
        onChange={(value) => form.updateDraft({ model_reasoning_summary: value })}
      />
      <SelectField
        id="config-model_verbosity"
        label="Verbosity"
        hint="The preferred level of detail in answers."
        value={draft.model_verbosity}
        fallback="medium"
        issue={primaryIssue(issues, "model_verbosity")}
        changed={"model_verbosity" in changes}
        options={verbosityOptions}
        onChange={(value) => form.updateDraft({ model_verbosity: value })}
      />
      <Hint className="form-footnote">Options follow the selected model's live capabilities.</Hint>
      {desktop ? <RuntimeBlock variant="inline" disabled={form.dirty} /> : undefined}
    </>
  );
}

function AccessFields({ form, snapshot }: FieldsProps): ReactElement {
  const { draft, issues, changes, granular } = form;
  const capabilities = snapshot.capabilities;
  const requirements = capabilities.requirements;
  const allowedApprovalPolicies = approvalModeSet(requirements?.allowedApprovalPolicies);
  const allowedSandboxModes = valueSet(requirements?.allowedSandboxModes);
  const allowedSearchModes = valueSet(requirements?.allowedWebSearchModes);
  const allowedWindowsSandboxes = valueSet(requirements?.allowedWindowsSandboxImplementations);
  const permissionOptions = capabilities.permissionProfiles.map((profile) => ({
    value: profile.id,
    label: sentenceCase(profile.id),
    disabled: !profile.allowed,
  }));
  const approvalMode: ApprovalMode | null =
    draft.approval_policy === null
      ? null
      : typeof draft.approval_policy === "string"
        ? draft.approval_policy
        : "granular";
  const dangerous =
    draft.sandbox_mode === "danger-full-access" && draft.approval_policy === "never";
  return (
    <>
      {dangerous ? (
        <Banner
          header="Unrestricted autonomous access"
          subheader="Full access with approvals disabled lets Codex run without confirmation."
        />
      ) : undefined}
      <SelectField
        id="config-default_permissions"
        label="Permission profile"
        hint={permissionDescription(
          capabilities.permissionProfiles,
          draft.default_permissions ?? "",
        )}
        value={draft.default_permissions}
        disabled={permissionOptions.length === 0}
        issue={primaryIssue(issues, "default_permissions")}
        changed={"default_permissions" in changes}
        options={[
          { value: "", label: "Direct sandbox settings" },
          ...withCurrent(permissionOptions, draft.default_permissions ?? ""),
        ]}
        onChange={(value) =>
          form.updateDraft({
            default_permissions: value,
            ...(value !== null ? { sandbox_mode: null } : {}),
          })
        }
      />
      <SelectField
        id="config-sandbox_mode"
        label="Sandbox"
        hint="Filesystem access granted to Codex commands."
        value={draft.sandbox_mode}
        fallback="workspace-write"
        issue={primaryIssue(issues, "sandbox_mode")}
        changed={"sandbox_mode" in changes}
        options={constrainOptions(sandboxOptions, allowedSandboxModes)}
        onChange={(value) =>
          form.updateDraft({
            sandbox_mode: value,
            ...(value !== null ? { default_permissions: null } : {}),
          })
        }
      />
      <Rule />
      <SelectField
        id="config-approval_policy"
        label="Ask for approval"
        hint="When Codex pauses and asks before taking an action."
        value={approvalMode}
        fallback="on-request"
        issue={primaryIssue(issues, "approval_policy")}
        changed={"approval_policy" in changes}
        options={constrainOptions(approvalOptions, allowedApprovalPolicies)}
        onChange={(mode) =>
          form.updateDraft({ approval_policy: mode === "granular" ? { granular } : mode })
        }
        below={
          approvalMode === "granular" ? (
            <Group className="field-group">
              {granularDefinitions.map(([key, label, description]) => (
                <ToggleRow
                  key={key}
                  id={`approval-granular-${key}`}
                  label={label}
                  detail={
                    primaryIssue(issues, `approval_policy.granular.${key}`)?.message ?? description
                  }
                  checked={granular[key]}
                  onChange={(next) => form.updateGranular(key, next)}
                />
              ))}
            </Group>
          ) : undefined
        }
      />
      <SelectField
        id="config-approvals_reviewer"
        label="Approval reviewer"
        hint="Choose who reviews approval requests."
        value={draft.approvals_reviewer}
        fallback="user"
        issue={primaryIssue(issues, "approvals_reviewer")}
        changed={"approvals_reviewer" in changes}
        options={reviewerOptions}
        onChange={(value) => form.updateDraft({ approvals_reviewer: value })}
      />
      <Rule />
      <SelectField
        id="config-web_search"
        label="Web search"
        hint="How Codex retrieves information from the internet."
        value={draft.web_search}
        fallback="live"
        issue={primaryIssue(issues, "web_search")}
        changed={"web_search" in changes}
        options={constrainOptions(searchOptions, allowedSearchModes)}
        onChange={(value) => form.updateDraft({ web_search: value })}
      />
      {capabilities.platform === "win32" ? (
        <SelectField
          id="config-windows_sandbox"
          label="Windows sandbox"
          hint="How Windows sandbox setup is launched."
          value={draft.windows_sandbox}
          issue={primaryIssue(issues, "windows_sandbox")}
          changed={"windows_sandbox" in changes}
          options={constrainOptions(windowsSandboxOptions, allowedWindowsSandboxes)}
          onChange={(value) => form.updateDraft({ windows_sandbox: value })}
        />
      ) : undefined}
      <Hint className="form-footnote">Options your organization manages appear disabled.</Hint>
    </>
  );
}

function FeatureFields({ form, snapshot }: FieldsProps): ReactElement {
  const capabilities = snapshot.capabilities;
  const featureRequirements = capabilities.requirements?.featureRequirements;
  if (capabilities.features.length === 0) {
    return <Hint>Codex did not report any feature flags for this workspace.</Hint>;
  }
  return (
    <>
      <Group>
        {capabilities.features.map((capability) => {
          const name = capability.name;
          const requiredValue = featureRequirements?.[name];
          const locked = capability.locked || requiredValue !== undefined;
          const effective = requiredValue ?? capability.enabled;
          const issue = primaryIssue(form.issues, `features.${name}`);
          return (
            <ToggleRow
              key={name}
              id={`feature-${name}`}
              label={capability.displayName}
              badge={<Badge>{stageLabel(capability.stage)}</Badge>}
              detail={
                issue?.message ??
                [capability.description, locked ? "Managed by your organization." : undefined]
                  .filter((part): part is string => part !== undefined && part.length > 0)
                  .join(" ")
              }
              checked={form.draft.features[name] ?? effective}
              disabled={locked}
              locked={locked}
              onChange={(value) => form.updateFeature(name, value)}
            />
          );
        })}
      </Group>
      <Hint>Availability and state come from Codex. Managed features can't be changed here.</Hint>
    </>
  );
}

function EnvironmentFields({ form }: { readonly form: SettingsDraft }): ReactElement {
  const issue = primaryIssue(form.issues, "shell_environment_include_only");
  return (
    <Field
      label="Shell environment allowlist"
      htmlFor="config-shell_environment_include_only"
      hint="One pattern per line. Leave empty to pass the full environment."
      issue={issue?.message}
      changed={"shell_environment_include_only" in form.changes}
    >
      <ExpandableTextarea
        id="config-shell_environment_include_only"
        className={cn("control-mono", issue?.severity === "error" && "control-error")}
        label="shell environment allowlist"
        value={form.environmentText}
        rows={4}
        placeholder={"PATH\nHOME\nGIT_*"}
        spellCheck={false}
        onValueChange={form.setEnvironmentText}
      />
    </Field>
  );
}

interface SelectFieldProps<Value extends string> {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** The typed draft value; null renders as the fallback (or empty) option. */
  readonly value: Value | null;
  readonly fallback?: Value | undefined;
  readonly disabled?: boolean | undefined;
  readonly issue: ConfigValidationIssue | undefined;
  readonly changed: boolean;
  readonly options: readonly UiOption<Value>[];
  readonly below?: ReactNode;
  /** Receives null when the empty ("default") option is chosen. */
  readonly onChange: (value: Value | null) => void;
}

function SelectField<Value extends string>(props: SelectFieldProps<Value>): ReactElement {
  return (
    <>
      <Field
        label={props.label}
        htmlFor={props.id}
        hint={props.hint}
        issue={props.issue?.message}
        changed={props.changed}
      >
        <select
          id={props.id}
          className={cn(
            "control control-select",
            props.issue?.severity === "error" && "control-error",
          )}
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
      </Field>
      {props.below}
    </>
  );
}

interface ReasoningEffortFieldProps {
  readonly model: ModelCapability | undefined;
  readonly value: string | null;
  readonly issue: ConfigValidationIssue | undefined;
  readonly changed: boolean;
  readonly onChange: (value: string) => void;
}

function ReasoningEffortField(props: ReasoningEffortFieldProps): ReactElement {
  const efforts = props.model?.supportedReasoningEfforts ?? [];
  const effectiveValue =
    efforts.find((effort) => effort.reasoningEffort === props.value)?.reasoningEffort ??
    props.model?.defaultReasoningEffort ??
    efforts[0]?.reasoningEffort ??
    "";
  return (
    <Field
      label="Reasoning effort"
      as="span"
      hint={reasoningDescription(props.model, effectiveValue)}
      issue={props.issue?.message}
      changed={props.changed}
    >
      {efforts.length === 0 ? (
        <div className="control control-static">Not configurable for this model</div>
      ) : (
        <Segmented
          aria-label="Reasoning effort"
          options={efforts.map((effort) => ({
            value: effort.reasoningEffort,
            label: sentenceCase(effort.reasoningEffort),
          }))}
          value={effectiveValue}
          disabled={efforts.length < 2}
          onChange={props.onChange}
        />
      )}
    </Field>
  );
}

function renderIssueSummary(issues: readonly ConfigValidationIssue[]): ReactElement | undefined {
  if (issues.length === 0) return undefined;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const visible = [...errors, ...warnings].slice(0, 3);
  return (
    <Banner
      header={
        errors.length > 0
          ? `${errors.length} setting${errors.length === 1 ? " needs" : "s need"} attention`
          : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
      }
      subheader={visible.map((issue) => issue.message).join(" · ")}
    />
  );
}

function effectiveFeature(
  capability: FeatureCapability,
  values: EditableCodexConfig["features"],
  requirements: ConfigCapabilities["requirements"],
): boolean {
  const required = requirements?.featureRequirements?.[capability.name];
  if (required !== undefined) return required;
  return values[capability.name] ?? capability.enabled;
}

function stageLabel(stage: FeatureCapability["stage"]): string {
  return stage === "underDevelopment" ? "Experimental" : sentenceCase(stage);
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
    "Choose a bundled profile, or set the sandbox directly below."
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

/** Display names stay as-is; identifiers such as reasoning efforts get a capital. */
function sentenceCaseIfCode(value: string): string {
  return /^[a-z][a-z0-9_-]*$/.test(value) ? sentenceCase(value) : value;
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
