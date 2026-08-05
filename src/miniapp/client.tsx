import {
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ConfigCapabilities,
  ConfigValidationIssue,
  ConfigValidationResult,
  EditableCodexConfig,
  EditableConfigSnapshot,
  FeatureCapability,
  ModelCapability,
} from "../codex/config-service.js";
import type {
  ApplyBankedResetOutcome,
  AvailableSkill,
  CodexBankedReset,
  CodexBankedResets,
  CodexRuntimeStatus,
  CodexUsageLimits,
  CodexUsageLimitWindow,
} from "../codex/runtime-service.js";
import type { SkillDirectory, SkillFile, SkillResource } from "../codex/skill-browser.js";
import type { WirebotSettings } from "../core/settings-store.js";
import type { ConfigWriteResponse } from "../generated/codex/v2/ConfigWriteResponse.js";
import {
  AppRoot,
  Banner,
  Button,
  Caption,
  Cell,
  Headline,
  Placeholder,
  Section,
  Slider,
  Spinner,
  Switch,
  Tabbar,
} from "./ui.js";

interface TelegramWebApp {
  readonly initData: string;
  readonly colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  onEvent(event: "themeChanged", listener: () => void): void;
  offEvent(event: "themeChanged", listener: () => void): void;
  readonly HapticFeedback?: {
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp: TelegramWebApp };
  }
}

type FeatureName = FeatureCapability["name"];
type TriState = "" | "false" | "true";
type ApprovalPolicy = NonNullable<EditableCodexConfig["approval_policy"]>;
type ApprovalMode = Exclude<ApprovalPolicy, { granular: unknown }> | "granular";
type GranularApproval = Extract<ApprovalPolicy, { granular: unknown }>["granular"];
type ConfigRequirements = NonNullable<ConfigCapabilities["requirements"]>;

/** The `/api/config` wire shape; the client trusts the server's typed JSON as-is. */
type LoadedSnapshot = EditableConfigSnapshot & {
  readonly wirebot: WirebotSettings;
  readonly runtime: CodexRuntimeStatus;
  readonly writeOutcome?: ConfigWriteResponse | undefined;
};

interface ConfigDraft {
  readonly model_provider: string;
  readonly model: string;
  readonly model_reasoning_effort: string;
  readonly model_reasoning_summary: string;
  readonly model_verbosity: string;
  readonly service_tier: string;
  readonly personality: string;
  readonly approval_policy: string;
  readonly approval_granular: GranularApproval;
  readonly approvals_reviewer: string;
  readonly sandbox_mode: string;
  readonly default_permissions: string;
  readonly web_search: string;
  readonly windows_sandbox: string;
  readonly shell_environment_include_only: string;
  readonly features: Readonly<Record<FeatureName, TriState>>;
}

type ScalarDraftKey = Exclude<keyof ConfigDraft, "approval_granular" | "features">;

interface ResetConfirmation {
  readonly credit: CodexBankedReset;
  readonly idempotencyKey: string;
}

interface UiOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

interface FieldProps {
  readonly draftKey: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly onChange: (value: string) => void;
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

const webApp = window.Telegram?.WebApp;
const telegramReady = webApp !== undefined && webApp.initData.length > 0;

interface AsyncState<Value> {
  readonly value?: Value | undefined;
  readonly error?: string | undefined;
}

/**
 * Shared fetch effect: clears its state and reloads when the dependencies
 * change, dropping results from superseded attempts. A missing loader keeps
 * the state empty.
 */
function useAsync<Value>(
  load: (() => Promise<Value>) | undefined,
  deps: readonly unknown[],
): AsyncState<Value> {
  const [state, setState] = useState<AsyncState<Value>>({});
  useEffect(() => {
    setState({});
    if (load === undefined) return;
    let active = true;
    load()
      .then((value) => {
        if (active) setState({ value });
      })
      .catch((error: unknown) => {
        if (active) setState({ error: messageOf(error) });
      });
    return () => {
      active = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns the dependency list.
  }, deps);
  return state;
}

function SettingsApp(): ReactElement {
  const [appearance, setAppearance] = useState<"dark" | "light">(webApp?.colorScheme ?? "light");
  const [activeTab, setActiveTab] = useState<"settings" | "skills">("settings");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<LoadedSnapshot>();
  const [draft, setDraft] = useState<ConfigDraft>();
  const [remoteClientContext, setRemoteClientContext] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<"reload" | "restart">();
  const [validation, setValidation] = useState<ConfigValidationResult>({ valid: true, issues: [] });
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState("Settings are up to date.");
  const [usage, setUsage] = useState<CodexUsageLimits>();
  const [usageError, setUsageError] = useState<string>();
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [bankedResetsExpanded, setBankedResetsExpanded] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<ResetConfirmation>();
  const [resetApplying, setResetApplying] = useState(false);
  const [resetError, setResetError] = useState<string>();
  const [resetNotice, setResetNotice] = useState<string>();

  useEffect(() => {
    if (webApp === undefined) return;
    const handleThemeChanged = (): void => setAppearance(webApp.colorScheme);
    webApp.ready();
    webApp.expand();
    webApp.onEvent("themeChanged", handleThemeChanged);
    return () => webApp.offEvent("themeChanged", handleThemeChanged);
  }, []);

  const snapshotLoad = useAsync(telegramReady ? () => requestSnapshot("GET") : undefined, [
    loadAttempt,
  ]);
  const loadError = telegramReady
    ? snapshotLoad.error
    : "Open this settings page from the bot in Telegram.";

  useEffect(() => {
    const loaded = snapshotLoad.value;
    if (loaded === undefined) return;
    setSnapshot(loaded);
    setDraft(draftFromConfig(loaded.values));
    setRemoteClientContext(loaded.wirebot.remoteClientContext);
    setValidation(loaded.validation);
    setNotice("Settings are up to date.");
  }, [snapshotLoad.value]);

  const refreshUsage = useCallback(async (showRefreshing = true): Promise<void> => {
    if (showRefreshing) setUsageRefreshing(true);
    try {
      setUsage(await requestUsage());
      setUsageError(undefined);
    } catch (error) {
      setUsageError(messageOf(error));
    } finally {
      if (showRefreshing) setUsageRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!telegramReady) return;
    void refreshUsage();
    const timer = window.setInterval(() => void refreshUsage(false), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshUsage]);

  const chooseBankedReset = (credit: CodexBankedReset): void => {
    setResetError(undefined);
    setResetConfirmation({
      credit,
      idempotencyKey: resetAttemptId(),
    });
  };

  const closeResetConfirmation = (): void => {
    if (resetApplying) return;
    setResetConfirmation(undefined);
    setResetError(undefined);
  };

  const applyBankedReset = async (): Promise<void> => {
    if (resetConfirmation === undefined || resetApplying) return;
    setResetApplying(true);
    setResetError(undefined);
    try {
      const outcome = await requestApplyBankedReset(resetConfirmation);
      const creditId = resetConfirmation.credit.id;
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        setUsage((current) => removeAppliedReset(current, creditId));
        setResetNotice(
          outcome === "reset"
            ? "Banked reset applied. Refreshing your usage limits…"
            : "This banked reset was already applied. Refreshing your usage limits…",
        );
        setResetConfirmation(undefined);
        webApp?.HapticFeedback?.notificationOccurred("success");
        await refreshUsage();
        setResetNotice(
          outcome === "reset" ? "Banked reset applied." : "This banked reset was already applied.",
        );
        return;
      }
      if (outcome === "nothingToReset") {
        setResetError("None of your current usage windows are eligible for a reset yet.");
      } else {
        setUsage((current) => clearUnavailableResets(current));
        setResetError("This banked reset is no longer available.");
      }
      webApp?.HapticFeedback?.notificationOccurred("warning");
    } catch (error) {
      setResetError(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setResetApplying(false);
    }
  };

  const normalizedValues = useMemo(
    () => (draft === undefined ? undefined : configFromDraft(draft)),
    [draft],
  );
  const changes = useMemo(
    () =>
      snapshot === undefined || normalizedValues === undefined
        ? {}
        : changedConfig(snapshot.values, normalizedValues),
    [normalizedValues, snapshot],
  );
  const configDirty = Object.keys(changes).length > 0;
  const remoteClientContextDirty =
    snapshot !== undefined && remoteClientContext !== snapshot.wirebot.remoteClientContext;
  const dirty = configDirty || remoteClientContextDirty;

  useEffect(() => {
    if (!configDirty || snapshot === undefined) {
      setValidating(false);
      setValidation(snapshot?.validation ?? { valid: true, issues: [] });
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

  const updateScalar = (key: ScalarDraftKey, value: string): void => {
    setDraft((current) => (current === undefined ? current : { ...current, [key]: value }));
  };
  const updateModel = (value: string): void => {
    const models = snapshot?.capabilities.models ?? [];
    setDraft((current) => {
      if (current === undefined) return current;
      const model = resolveSelectedModel(value, models);
      const effortSupported =
        current.model_reasoning_effort.length === 0 ||
        model?.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === current.model_reasoning_effort,
        ) === true;
      const tierSupported =
        current.service_tier.length === 0 ||
        model?.serviceTiers.some((tier) => tier.id === current.service_tier) === true;
      return {
        ...current,
        model: value,
        model_reasoning_effort: effortSupported ? current.model_reasoning_effort : "",
        service_tier: tierSupported ? current.service_tier : "",
      };
    });
  };
  const updateGranularApproval = (key: keyof GranularApproval, value: boolean): void => {
    setDraft((current) =>
      current === undefined
        ? current
        : {
            ...current,
            approval_granular: { ...current.approval_granular, [key]: value },
          },
    );
  };
  const updateFeature = (name: FeatureName, value: boolean): void => {
    setDraft((current) =>
      current === undefined
        ? current
        : { ...current, features: { ...current.features, [name]: String(value) as TriState } },
    );
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!dirty || snapshot === undefined || saving || runtimeAction !== undefined) return;
    setSaving(true);
    setNotice("Saving…");
    try {
      const body = {
        expectedVersion: snapshot.version,
        values: changes,
        ...(remoteClientContextDirty ? { wirebot: { remoteClientContext } } : {}),
      };
      const loaded = await requestSnapshot("PUT", body);
      setSnapshot(loaded);
      setDraft(draftFromConfig(loaded.values));
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
      webApp?.HapticFeedback?.notificationOccurred(
        overridden || loaded.runtime.state === "degraded" || loaded.runtime.restartRequired
          ? "warning"
          : "success",
      );
    } catch (error) {
      if (error instanceof ConfigApiError && error.issues !== undefined) {
        setValidation({ valid: false, issues: error.issues });
      }
      setNotice(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
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
      setSnapshot((current) =>
        current === undefined ? current : { ...current, runtime, writeOutcome: undefined },
      );
      setNotice(runtimeActionNotice(runtime, action));
      webApp?.HapticFeedback?.notificationOccurred(
        runtime.state === "degraded" || runtime.restartRequired ? "warning" : "success",
      );
    } catch (error) {
      setNotice(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setRuntimeAction(undefined);
    }
  };

  const retry = (): void => setLoadAttempt((attempt) => attempt + 1);
  const settingsContent =
    snapshot === undefined || draft === undefined
      ? renderLoading(loadError, retry)
      : renderForm({
          snapshot,
          draft,
          remoteClientContext,
          issues: validation.issues,
          dirty,
          saving,
          validating,
          runtimeAction,
          notice,
          usage,
          usageError,
          usageRefreshing,
          bankedResetsExpanded,
          resetNotice,
          onSave: save,
          onRuntimeAction: runRuntimeAction,
          onRefreshUsage: refreshUsage,
          onToggleBankedResets: () => setBankedResetsExpanded((expanded) => !expanded),
          onChooseBankedReset: chooseBankedReset,
          updateScalar,
          updateModel,
          updateGranularApproval,
          updateFeature,
          updateRemoteClientContext: setRemoteClientContext,
        });

  return (
    <AppRoot appearance={appearance} className="appRoot">
      {activeTab === "settings" ? settingsContent : <SkillsBrowser />}
      {resetConfirmation === undefined ? undefined : (
        <ResetConfirmationDialog
          confirmation={resetConfirmation}
          applying={resetApplying}
          error={resetError}
          onCancel={closeResetConfirmation}
          onApply={applyBankedReset}
        />
      )}
      <Tabbar aria-label="Main navigation">
        <Tabbar.Item
          selected={activeTab === "settings"}
          text="Settings"
          onClick={() => setActiveTab("settings")}
          aria-label="Settings"
        >
          {tabIcon("settings")}
        </Tabbar.Item>
        <Tabbar.Item
          selected={activeTab === "skills"}
          text="Skills"
          onClick={() => setActiveTab("skills")}
          aria-label="Skills"
        >
          {tabIcon("skills")}
        </Tabbar.Item>
      </Tabbar>
    </AppRoot>
  );
}

function SkillsBrowser(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<AvailableSkill>();
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string>();

  const skillsLoad = useAsync(requestSkills, [loadAttempt]);
  const documentLoad = useAsync(
    selectedSkill === undefined
      ? undefined
      : async (): Promise<SkillFile> => {
          const resource = await requestSkillResource(selectedSkill.name, "SKILL.md");
          if (resource.type !== "file" || resource.encoding !== "utf8") {
            throw new Error("SKILL.md is not a readable text file.");
          }
          return resource;
        },
    [selectedSkill],
  );
  const directoryLoad = useAsync(
    selectedSkill === undefined
      ? undefined
      : async (): Promise<SkillDirectory> => {
          const resource = await requestSkillResource(selectedSkill.name, directoryPath);
          if (resource.type !== "directory") throw new Error("This path is not a directory.");
          return resource;
        },
    [directoryPath, selectedSkill],
  );
  const fileLoad = useAsync(
    selectedSkill === undefined || selectedFilePath === undefined
      ? undefined
      : async (): Promise<SkillFile> => {
          const resource = await requestSkillResource(selectedSkill.name, selectedFilePath);
          if (resource.type !== "file") throw new Error("This path is not a file.");
          return resource;
        },
    [selectedFilePath, selectedSkill],
  );

  const openSkill = (skill: AvailableSkill): void => {
    setSelectedSkill(skill);
    setDirectoryPath("");
    setSelectedFilePath(undefined);
  };

  if (selectedSkill !== undefined) {
    return renderSkillDetail({
      skill: selectedSkill,
      skillDocument: documentLoad.value,
      skillDocumentError: documentLoad.error,
      directoryPath,
      directory: directoryLoad.value,
      directoryError: directoryLoad.error,
      selectedFilePath,
      selectedFile: fileLoad.value,
      selectedFileError: fileLoad.error,
      onBack: () => setSelectedSkill(undefined),
      onDirectory: (path) => {
        setDirectoryPath(path);
        setSelectedFilePath(undefined);
      },
      onFile: setSelectedFilePath,
    });
  }

  const skills = skillsLoad.value;
  if (skills === undefined) {
    if (skillsLoad.error !== undefined) {
      return (
        <div className="loadingRoot tabbedLoadingRoot">
          <Placeholder
            header="Couldn’t load skills"
            description={skillsLoad.error}
            action={
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="loadingRoot tabbedLoadingRoot">
        <Placeholder
          header="Loading Codex skills"
          description="Reading the skills currently available to this workspace…"
        >
          <Spinner size="l" />
        </Placeholder>
      </div>
    );
  }

  return (
    <main className="page skillsPage">
      <header className="pageHeader">
        <div>
          <Headline Component="h1">Skills</Headline>
          <Caption className="pageSubtitle">Available to Codex in this workspace</Caption>
        </div>
        <Caption className="revision">{String(skills.length)}</Caption>
      </header>
      {skills.length === 0 ? (
        <Placeholder
          header="No skills available"
          description="Reload Codex after installing or enabling a skill."
        />
      ) : (
        <Section
          header={`${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
          footer="Open a skill to read its instructions and browse its bundled files."
        >
          {skills.map((skill) => (
            <Cell
              key={skill.name}
              className="skillCell"
              subtitle={skill.description}
              multiline
              after={
                <span className="cellChevron" aria-hidden="true">
                  ›
                </span>
              }
              onClick={() => openSkill(skill)}
            >
              {skill.name}
            </Cell>
          ))}
        </Section>
      )}
    </main>
  );
}

interface SkillDetailOptions {
  readonly skill: AvailableSkill;
  readonly skillDocument: SkillFile | undefined;
  readonly skillDocumentError: string | undefined;
  readonly directoryPath: string;
  readonly directory: SkillDirectory | undefined;
  readonly directoryError: string | undefined;
  readonly selectedFilePath: string | undefined;
  readonly selectedFile: SkillFile | undefined;
  readonly selectedFileError: string | undefined;
  readonly onBack: () => void;
  readonly onDirectory: (path: string) => void;
  readonly onFile: (path: string) => void;
}

function renderSkillDetail(options: SkillDetailOptions): ReactElement {
  const parentPath = parentDirectory(options.directoryPath);
  return (
    <main className="page skillsPage">
      <header className="skillDetailHeader">
        <Button mode="plain" size="s" onClick={options.onBack} aria-label="Back to skills">
          ‹ Skills
        </Button>
        <Headline Component="h1">{options.skill.name}</Headline>
        <Caption className="pageSubtitle">{options.skill.description}</Caption>
      </header>
      <div className="sectionStack">
        <Section
          header="SKILL.md"
          footer="These are the instructions Codex reads when the skill is selected."
        >
          {options.skillDocumentError !== undefined ? (
            <Banner header="Couldn’t read SKILL.md" subheader={options.skillDocumentError} />
          ) : options.skillDocument === undefined ? (
            <div className="resourceLoading">
              <Spinner />
            </div>
          ) : (
            renderMarkdownPreview(options.skillDocument.content, true)
          )}
        </Section>
        <Section
          header={options.directoryPath.length === 0 ? "Files" : options.directoryPath}
          footer="Folders, scripts, references, images, and other resources bundled with this skill."
        >
          {options.directoryPath.length === 0 ? undefined : (
            <Cell
              className="skillCell"
              before={
                <span className="fileIcon" aria-hidden="true">
                  ↰
                </span>
              }
              onClick={() => options.onDirectory(parentPath)}
            >
              {parentPath.length === 0 ? "Skill root" : parentPath}
            </Cell>
          )}
          {options.directoryError !== undefined ? (
            <Banner header="Couldn’t open this folder" subheader={options.directoryError} />
          ) : options.directory === undefined ? (
            <div className="resourceLoading">
              <Spinner />
            </div>
          ) : options.directory.entries.length === 0 ? (
            <Caption className="emptyDirectory">This folder is empty.</Caption>
          ) : (
            options.directory.entries.map((entry) => (
              <Cell
                key={entry.path}
                className="skillCell"
                before={
                  <span className="fileIcon" aria-hidden="true">
                    {entry.type === "directory" ? "▸" : "·"}
                  </span>
                }
                subtitle={
                  entry.type === "file" && entry.size !== null ? formatBytes(entry.size) : undefined
                }
                after={
                  <span className="cellChevron" aria-hidden="true">
                    ›
                  </span>
                }
                onClick={() =>
                  entry.type === "directory"
                    ? options.onDirectory(entry.path)
                    : options.onFile(entry.path)
                }
              >
                {entry.name}
              </Cell>
            ))
          )}
        </Section>
        {options.selectedFilePath === undefined ? undefined : (
          <Section
            header={options.selectedFilePath}
            footer={
              options.selectedFile === undefined
                ? undefined
                : `${formatBytes(options.selectedFile.size)} · ${options.selectedFile.mediaType}`
            }
          >
            {renderFilePreview(options.selectedFile, options.selectedFileError)}
          </Section>
        )}
      </div>
    </main>
  );
}

function renderFilePreview(file: SkillFile | undefined, error: string | undefined): ReactElement {
  if (error !== undefined) {
    return <Banner header="Couldn’t preview this file" subheader={error} />;
  }
  if (file === undefined) {
    return (
      <div className="resourceLoading">
        <Spinner />
      </div>
    );
  }
  if (file.encoding === "utf8") {
    return file.mediaType === "text/markdown" || file.path.toLowerCase().endsWith(".md") ? (
      renderMarkdownPreview(file.content)
    ) : (
      <pre className="skillSource">{file.content}</pre>
    );
  }
  if (file.mediaType.startsWith("image/")) {
    return (
      <div className="imagePreview">
        <img src={`data:${file.mediaType};base64,${file.content}`} alt={file.path} />
      </div>
    );
  }
  return (
    <Caption className="binaryPreview">
      This binary file can be browsed, but it cannot be previewed in the Mini App.
    </Caption>
  );
}

function renderMarkdownPreview(content: string, stripFrontmatter = false): ReactElement {
  const markdown = stripFrontmatter
    ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    : content;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function tabIcon(kind: "settings" | "skills"): ReactElement {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "settings" ? (
        <>
          <path d="M5 8h18M5 20h18M9 5v6M19 17v6" />
          <circle cx={9} cy={8} r={2} />
          <circle cx={19} cy={20} r={2} />
        </>
      ) : (
        <>
          <path d="M14 3l1.8 6.2L22 11l-6.2 1.8L14 19l-1.8-6.2L6 11l6.2-1.8L14 3z" />
          <path d="M21.5 18l.8 2.7L25 21.5l-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7z" />
        </>
      )}
    </svg>
  );
}

function parentDirectory(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

interface FormRenderOptions {
  readonly snapshot: LoadedSnapshot;
  readonly draft: ConfigDraft;
  readonly remoteClientContext: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly validating: boolean;
  readonly runtimeAction: "reload" | "restart" | undefined;
  readonly notice: string;
  readonly usage: CodexUsageLimits | undefined;
  readonly usageError: string | undefined;
  readonly usageRefreshing: boolean;
  readonly bankedResetsExpanded: boolean;
  readonly resetNotice: string | undefined;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRuntimeAction: (action: "reload" | "restart") => Promise<void>;
  readonly onRefreshUsage: () => Promise<void>;
  readonly onToggleBankedResets: () => void;
  readonly onChooseBankedReset: (credit: CodexBankedReset) => void;
  readonly updateScalar: (key: ScalarDraftKey, value: string) => void;
  readonly updateModel: (value: string) => void;
  readonly updateGranularApproval: (key: keyof GranularApproval, value: boolean) => void;
  readonly updateFeature: (name: FeatureName, value: boolean) => void;
  readonly updateRemoteClientContext: (value: boolean) => void;
}

function renderForm(options: FormRenderOptions): ReactElement {
  const { snapshot, draft, issues, updateScalar } = options;
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

  const usageSection = renderUsageSection(
    options.usage,
    options.usageError,
    options.usageRefreshing,
    options.onRefreshUsage,
    options.bankedResetsExpanded,
    options.resetNotice,
    options.onToggleBankedResets,
    options.onChooseBankedReset,
  );
  const runtime = snapshot.runtime;
  const runtimeControlsDisabled = options.dirty || options.runtimeAction !== undefined;
  const runtimeSection = (
    <Section
      header="Codex runtime"
      footer={
        options.dirty
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
            loading={options.runtimeAction === "reload"}
            disabled={runtimeControlsDisabled}
            onClick={() => void options.onRuntimeAction("reload")}
          >
            Apply changes
          </Button>
          <Button
            type="button"
            mode="bezeled"
            size="s"
            loading={options.runtimeAction === "restart"}
            disabled={runtimeControlsDisabled}
            onClick={() => void options.onRuntimeAction("restart")}
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
      {toggleField({
        draftKey: "wirebot.remoteClientContext",
        label: "Remote session context",
        description:
          "Tell Codex that you are connected remotely, so it avoids host-local UI and localhost handoffs.",
        checked: options.remoteClientContext,
        disabled: false,
        issues: [],
        fieldId: "wirebot-remote-client-context",
        onChange: options.updateRemoteClientContext,
      })}
    </Section>
  );

  const modelField = selectField({
    draftKey: "model",
    label: "Model",
    description: selectedModel?.description ?? "The model Codex uses for new conversations.",
    value: selectedModel?.model ?? draft.model,
    disabled: models.length === 0,
    issues,
    options: withCurrent(models, draft.model),
    onChange: options.updateModel,
  });

  const effortField = reasoningSliderField(
    selectedModel,
    draft.model_reasoning_effort,
    issues,
    (value) => updateScalar("model_reasoning_effort", value),
  );

  const modelSection = (
    <Section header="Model" footer="Options follow the selected model's live capabilities.">
      {modelField}
      {effortField}
      {serviceTiers.length === 0
        ? undefined
        : selectField({
            draftKey: "service_tier",
            label: "Service tier",
            description: serviceTierDescription(selectedModel, draft.service_tier),
            value: draft.service_tier || selectedModel?.defaultServiceTier || "",
            disabled: false,
            issues,
            options: withCurrent(serviceTierOptions, draft.service_tier),
            onChange: (value) => updateScalar("service_tier", value),
          })}
      {selectField({
        draftKey: "personality",
        label: "Personality",
        description: "The conversational style Codex should use.",
        value: draft.personality || "pragmatic",
        disabled: false,
        issues,
        options: personalityOptions,
        onChange: (value) => updateScalar("personality", value),
      })}
      {selectField({
        draftKey: "model_reasoning_summary",
        label: "Reasoning summary",
        description: "How Codex summarizes its reasoning progress.",
        value: draft.model_reasoning_summary || "auto",
        disabled: false,
        issues,
        options: summaryOptions,
        onChange: (value) => updateScalar("model_reasoning_summary", value),
      })}
      {selectField({
        draftKey: "model_verbosity",
        label: "Verbosity",
        description: "The preferred level of detail in answers.",
        value: draft.model_verbosity || "medium",
        disabled: false,
        issues,
        options: verbosityOptions,
        onChange: (value) => updateScalar("model_verbosity", value),
      })}
    </Section>
  );

  const permissionOptions = capabilities.permissionProfiles.map((profile) => ({
    value: profile.id,
    label: sentenceCase(profile.id),
    disabled: !profile.allowed,
  }));
  const accessSection = (
    <Section header="Access & approvals" footer="Managed requirements appear disabled.">
      {selectField({
        draftKey: "default_permissions",
        label: "Permission profile",
        description: permissionDescription(
          capabilities.permissionProfiles,
          draft.default_permissions,
        ),
        value: draft.default_permissions,
        disabled: permissionOptions.length === 0,
        issues,
        options: [
          { value: "", label: "Direct sandbox settings" },
          ...withCurrent(permissionOptions, draft.default_permissions),
        ],
        onChange: (value) => {
          updateScalar("default_permissions", value);
          if (value.length > 0) updateScalar("sandbox_mode", "");
        },
      })}
      {selectField({
        draftKey: "approval_policy",
        label: "Approval policy",
        description: "When Codex pauses and asks before taking an action.",
        value: draft.approval_policy || "on-request",
        disabled: false,
        issues,
        options: constrainOptions(approvalOptions, allowedApprovalPolicies),
        onChange: (value) => updateScalar("approval_policy", value),
      })}
      {draft.approval_policy === "granular"
        ? granularApprovalFields(draft.approval_granular, issues, options.updateGranularApproval)
        : undefined}
      {selectField({
        draftKey: "approvals_reviewer",
        label: "Approval reviewer",
        description: "Choose who reviews approval requests.",
        value: draft.approvals_reviewer || "user",
        disabled: false,
        issues,
        options: reviewerOptions,
        onChange: (value) => updateScalar("approvals_reviewer", value),
      })}
      {selectField({
        draftKey: "sandbox_mode",
        label: "Sandbox",
        description: "Filesystem access granted to Codex commands.",
        value: draft.sandbox_mode || "workspace-write",
        disabled: false,
        issues,
        options: constrainOptions(sandboxOptions, allowedSandboxModes),
        onChange: (value) => {
          updateScalar("sandbox_mode", value);
          if (value.length > 0) updateScalar("default_permissions", "");
        },
      })}
      {selectField({
        draftKey: "web_search",
        label: "Web search",
        description: "How Codex retrieves information from the internet.",
        value: draft.web_search || "live",
        disabled: false,
        issues,
        options: constrainOptions(searchOptions, allowedSearchModes),
        onChange: (value) => updateScalar("web_search", value),
      })}
      {capabilities.platform === "win32"
        ? selectField({
            draftKey: "windows_sandbox",
            label: "Windows sandbox",
            description: "How Windows sandbox setup is launched.",
            value: draft.windows_sandbox,
            disabled: false,
            issues,
            options: constrainOptions(windowsSandboxOptions, allowedWindowsSandboxes),
            onChange: (value) => updateScalar("windows_sandbox", value),
          })
        : undefined}
    </Section>
  );

  const environmentSection = (
    <Section header="Environment" footer="One environment variable pattern per line.">
      {listField({
        draftKey: "shell_environment_include_only",
        label: "Shell environment allowlist",
        description: "Only these environment variables are passed to commands.",
        value: draft.shell_environment_include_only,
        disabled: false,
        issues,
        onChange: (value) => updateScalar("shell_environment_include_only", value),
      })}
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
          const checked = draft.features[name] === "" ? effective : draft.features[name] === "true";
          return toggleField({
            draftKey: `features.${name}`,
            label: capability.displayName,
            description,
            checked,
            disabled: locked,
            issues,
            onChange: (value) => options.updateFeature(name, value),
            fieldId: `feature-${name}`,
          });
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
    !options.dirty ||
    options.saving ||
    options.validating ||
    options.runtimeAction !== undefined ||
    errorCount > 0;
  const saveText = !options.dirty
    ? "Up to date"
    : errorCount > 0
      ? "Fix validation issues"
      : "Save changes";
  const showSaveDock = options.dirty || options.saving || options.validating || errorCount > 0;

  return (
    <form onSubmit={(event) => void options.onSave(event)}>
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
          {usageSection}
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
              className={`saveStatus ${errorCount > 0 ? "saveStatusError" : options.dirty ? "saveStatusReady" : ""}`}
              aria-live="polite"
            >
              {options.validating ? "Checking settings…" : options.notice}
            </Caption>
            <Button
              type="submit"
              size="l"
              stretched
              loading={options.saving}
              disabled={saveDisabled}
            >
              {saveText}
            </Button>
          </div>
        </div>
      ) : undefined}
    </form>
  );
}

function renderUsageSection(
  usage: CodexUsageLimits | undefined,
  error: string | undefined,
  refreshing: boolean,
  onRefresh: () => Promise<void>,
  bankedResetsExpanded: boolean,
  resetNotice: string | undefined,
  onToggleBankedResets: () => void,
  onChooseBankedReset: (credit: CodexBankedReset) => void,
): ReactElement {
  const windows = [
    usage?.weekly === null || usage?.weekly === undefined
      ? undefined
      : (["Weekly", usage.weekly] as const),
    usage?.fiveHour === null || usage?.fiveHour === undefined
      ? undefined
      : (["5 hours", usage.fiveHour] as const),
  ].filter(isDefined);
  let body: ReactElement;
  if (usage === undefined && error === undefined) {
    body = (
      <div className="usageLoading" aria-live="polite">
        <Spinner />
        <Caption>Checking Codex usage…</Caption>
      </div>
    );
  } else if (usage === undefined) {
    body = (
      <div className="usageUnavailable" role="status">
        <strong>Usage unavailable</strong>
        <Caption>{error}</Caption>
      </div>
    );
  } else if (windows.length === 0) {
    body = (
      <div className="usageUnavailable" role="status">
        <strong>No active limits</strong>
        <Caption>Codex is not reporting a weekly or five-hour usage window.</Caption>
      </div>
    );
  } else {
    body = (
      <div className="usageWindows" aria-live="polite">
        {windows.map(([label, window]) => renderUsageWindow(label, window))}
        {usage.bankedResets !== null && usage.bankedResets.availableCount > 0
          ? renderBankedResets(
              usage.bankedResets,
              bankedResetsExpanded,
              resetNotice,
              onToggleBankedResets,
              onChooseBankedReset,
            )
          : undefined}
        {error === undefined ? undefined : (
          <Caption className="usageStale">{`Could not refresh: ${error}`}</Caption>
        )}
      </div>
    );
  }
  return (
    <Section
      header={
        <div className="usageHeader">
          <span>Usage limits</span>
          <Button
            type="button"
            mode="plain"
            size="s"
            className="usageRefresh"
            loading={refreshing}
            disabled={refreshing}
            onClick={() => void onRefresh()}
            aria-label="Refresh usage limits"
          >
            Refresh
          </Button>
        </div>
      }
      footer="Refreshes automatically. The five-hour limit appears only while Codex reports that window."
    >
      {body}
    </Section>
  );
}

function renderBankedResets(
  resets: CodexBankedResets,
  expanded: boolean,
  notice: string | undefined,
  onToggle: () => void,
  onChoose: (credit: CodexBankedReset) => void,
): ReactElement {
  const count = resets.availableCount;
  const credits = resets.credits ?? [];
  return (
    <div className="bankedResets">
      <button
        type="button"
        className="bankedResetsSummary"
        aria-expanded={expanded}
        aria-controls="banked-reset-details"
        onClick={onToggle}
      >
        <span className="bankedResetsSummaryCopy">
          <strong>{`You have ${count} banked reset${count === 1 ? "" : "s"}`}</strong>
          <Caption>Use one to restore every currently eligible Codex usage window.</Caption>
        </span>
        <span className={`bankedResetsChevron ${expanded ? "bankedResetsChevronOpen" : ""}`}>
          ⌄
        </span>
      </button>
      {expanded ? (
        <div id="banked-reset-details" className="bankedResetDetails">
          {notice === undefined ? undefined : (
            <Caption className="bankedResetNotice" role="status">
              {notice}
            </Caption>
          )}
          {credits.length === 0 ? (
            <div className="bankedResetEmpty">
              <strong>Reset details unavailable</strong>
              <Caption>Codex reported the banked count without individual reset details.</Caption>
            </div>
          ) : (
            credits.map((credit) => renderBankedReset(credit, onChoose))
          )}
          {credits.length > 0 && credits.length < count ? (
            <Caption className="bankedResetPartial">
              {`Codex returned details for ${credits.length} of ${count} banked resets.`}
            </Caption>
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

function renderBankedReset(
  credit: CodexBankedReset,
  onChoose: (credit: CodexBankedReset) => void,
): ReactElement {
  const available = credit.status === "available";
  return (
    <article className="bankedReset" key={credit.id}>
      <div className="bankedResetHeader">
        <strong>{credit.title ?? resetTypeLabel(credit.resetType)}</strong>
        <span className={`bankedResetStatus bankedResetStatus-${credit.status}`}>
          {resetStatusLabel(credit.status)}
        </span>
      </div>
      <dl className="bankedResetFacts">
        <div>
          <dt>Type</dt>
          <dd>{resetTypeLabel(credit.resetType)}</dd>
        </div>
        <div>
          <dt>Expiration</dt>
          <dd>{formatExpiry(credit.expiresAt)}</dd>
        </div>
      </dl>
      {credit.description === null ? undefined : (
        <Caption className="bankedResetDescription">{credit.description}</Caption>
      )}
      <Button
        type="button"
        mode="bezeled"
        size="s"
        stretched
        disabled={!available}
        onClick={() => onChoose(credit)}
      >
        {available ? "Apply this reset" : resetStatusLabel(credit.status)}
      </Button>
    </article>
  );
}

interface ResetConfirmationDialogProps {
  readonly confirmation: ResetConfirmation;
  readonly applying: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onApply: () => Promise<void>;
}

function ResetConfirmationDialog(props: ResetConfirmationDialogProps): ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !props.applying) props.onCancel();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.applying, props.onCancel]);

  const credit = props.confirmation.credit;
  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !props.applying) props.onCancel();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop dismisses on click; Escape is handled while the dialog is open.
    <div className="resetDialogBackdrop" onMouseDown={dismissBackdrop}>
      <section
        className="resetDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-dialog-title"
        aria-describedby="reset-dialog-description"
      >
        <h2 id="reset-dialog-title">Apply banked reset?</h2>
        <p id="reset-dialog-description">
          This immediately spends one banked reset and restores every eligible Codex usage window.
          It cannot be undone.
        </p>
        <dl className="resetDialogFacts">
          <div>
            <dt>Type</dt>
            <dd>{resetTypeLabel(credit.resetType)}</dd>
          </div>
          <div>
            <dt>Expiration</dt>
            <dd>{formatExpiry(credit.expiresAt)}</dd>
          </div>
        </dl>
        {props.error === undefined ? undefined : (
          <Caption className="resetDialogError" role="alert">
            {props.error}
          </Caption>
        )}
        <div className="resetDialogActions">
          <Button type="button" mode="bezeled" disabled={props.applying} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            className="resetConfirmApply"
            loading={props.applying}
            autoFocus
            onClick={() => void props.onApply()}
          >
            Apply reset
          </Button>
        </div>
      </section>
    </div>
  );
}

function resetTypeLabel(type: CodexBankedReset["resetType"]): string {
  return type === "codexRateLimits" ? "Codex usage limits" : "Unknown reset type";
}

function resetStatusLabel(status: CodexBankedReset["status"]): string {
  switch (status) {
    case "available":
      return "Available";
    case "redeeming":
      return "Applying";
    case "redeemed":
      return "Applied";
    default:
      return "Unavailable";
  }
}

function formatUnixDate(seconds: number, withYear: boolean): string | undefined {
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "Does not expire";
  return formatUnixDate(expiresAt, true) ?? "Unavailable";
}

function formatResetTime(resetsAt: number | null): string {
  const formatted = resetsAt === null ? undefined : formatUnixDate(resetsAt, false);
  return formatted === undefined ? "Reset time unavailable" : `Resets ${formatted}`;
}

function renderUsageWindow(label: string, window: CodexUsageLimitWindow): ReactElement {
  const percent = Math.max(0, Math.min(100, window.remainingPercent));
  const percentText = formatRemainingPercent(percent);
  const level = percent <= 20 ? "low" : percent <= 50 ? "medium" : "healthy";
  return (
    <div className="usageWindow" key={label}>
      <div className="usageWindowHeader">
        <strong>{label}</strong>
        <span className={`usageRemaining usageRemaining-${level}`}>{percentText}</span>
      </div>
      <div
        className="usageTrack"
        role="progressbar"
        aria-label={`${label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={`usageFill usageFill-${level}`} style={{ width: `${percent}%` }} />
      </div>
      <Caption className="usageReset">{formatResetTime(window.resetsAt)}</Caption>
    </div>
  );
}

function formatRemainingPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1% left";
  return `${Math.round(percent)}% left`;
}

function listField(props: FieldProps): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  return (
    <div className="field" key={props.draftKey}>
      <Caption Component="label" className="controlLabel" htmlFor={`config-${props.draftKey}`}>
        {props.label}
      </Caption>
      <textarea
        id={`config-${props.draftKey}`}
        className={`nativeControl nativeTextarea ${issue?.severity === "error" ? "nativeControlError" : ""}`}
        value={props.value}
        rows={3}
        placeholder="Leave empty to pass the full environment"
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <Caption className={issue === undefined ? "fieldHint" : "fieldHint fieldIssue"}>
        {issue?.message ?? props.description}
      </Caption>
    </div>
  );
}

function granularApprovalFields(
  value: GranularApproval,
  issues: readonly ConfigValidationIssue[],
  onChange: (key: keyof GranularApproval, value: boolean) => void,
): ReactElement[] {
  const definitions = [
    ["sandbox_approval", "Sandbox escalation", "Commands that need broader sandbox access."],
    ["rules", "Rules", "Actions governed by configured execution rules."],
    ["skill_approval", "Skills", "Skill actions that require explicit review."],
    ["request_permissions", "Permission requests", "Requests for additional permissions."],
    ["mcp_elicitations", "MCP elicitations", "Interactive requests initiated by MCP servers."],
  ] as const satisfies readonly (readonly [keyof GranularApproval, string, string])[];
  return definitions.map(([key, label, description]) =>
    toggleField({
      draftKey: `approval_policy.granular.${key}`,
      label,
      description,
      checked: value[key],
      disabled: false,
      issues,
      fieldId: `approval-granular-${key}`,
      onChange: (next) => onChange(key, next),
    }),
  );
}

function reasoningSliderField(
  model: ModelCapability | undefined,
  value: string,
  issues: readonly ConfigValidationIssue[],
  onChange: (value: string) => void,
): ReactElement {
  const efforts = model?.supportedReasoningEfforts ?? [];
  const effectiveValue =
    efforts.find((effort) => effort.reasoningEffort === value)?.reasoningEffort ??
    model?.defaultReasoningEffort ??
    efforts[0]?.reasoningEffort ??
    "";
  const selectedIndex = Math.max(
    0,
    efforts.findIndex((effort) => effort.reasoningEffort === effectiveValue),
  );
  const issue = primaryIssue(issues, "model_reasoning_effort");
  const description = reasoningDescription(model, effectiveValue);
  return (
    <div className="field reasoningField" key="model_reasoning_effort">
      <div className="reasoningHeader">
        <Caption className="controlLabel">Reasoning effort</Caption>
        <Caption className="reasoningValue" aria-live="polite">
          {sentenceCase(effectiveValue)}
        </Caption>
      </div>
      <Slider
        className="reasoningSlider"
        min={0}
        max={Math.max(0, efforts.length - 1)}
        step={1}
        value={selectedIndex}
        disabled={efforts.length < 2}
        getAriaLabel={() => "Reasoning effort"}
        getAriaValueText={(index) =>
          sentenceCase(efforts[Math.round(index)]?.reasoningEffort ?? effectiveValue)
        }
        onValueChange={(index) => {
          const effort = efforts[Math.round(index)];
          if (effort !== undefined) onChange(effort.reasoningEffort);
        }}
      />
      <div className="reasoningTicks" aria-hidden="true">
        {efforts.map((effort, index) => (
          <span
            key={effort.reasoningEffort}
            className={`reasoningTick ${index === selectedIndex ? "reasoningTickActive" : ""}`}
            style={{ left: `${efforts.length < 2 ? 50 : (index / (efforts.length - 1)) * 100}%` }}
          >
            {sentenceCase(effort.reasoningEffort)}
          </span>
        ))}
      </div>
      <Caption className={issue === undefined ? "fieldHint" : "fieldHint fieldIssue"}>
        {issue?.message ?? description}
      </Caption>
    </div>
  );
}

function toggleField(props: {
  readonly draftKey: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly issues: readonly ConfigValidationIssue[];
  readonly fieldId: string;
  readonly onChange: (value: boolean) => void;
}): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  return (
    <div className="toggleField" key={props.draftKey}>
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

function selectField(
  props: FieldProps & {
    readonly options: readonly UiOption[];
    readonly fieldId?: string;
  },
): ReactElement {
  const issue = primaryIssue(props.issues, props.draftKey);
  const fieldId = props.fieldId ?? `config-${props.draftKey}`;
  return (
    <div className="field" key={props.draftKey}>
      <Caption Component="label" className="controlLabel" htmlFor={fieldId}>
        {props.label}
      </Caption>
      <select
        id={fieldId}
        className={`nativeControl nativeSelect ${issue?.severity === "error" ? "nativeControlError" : ""}`}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
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

function renderLoading(error: string | undefined, retry: () => void): ReactElement {
  if (error !== undefined) {
    return (
      <div className="loadingRoot">
        <Placeholder
          header="Couldn’t open settings"
          description={error}
          action={<Button onClick={retry}>Try again</Button>}
        />
      </div>
    );
  }
  return (
    <div className="loadingRoot">
      <Placeholder
        header="Loading Codex settings"
        description="Reading the effective config and capabilities…"
      >
        <Spinner size="l" />
      </Placeholder>
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

function draftFromConfig(values: EditableCodexConfig): ConfigDraft {
  const policy = values.approval_policy;
  const granularApproval =
    typeof policy === "object" && policy !== null ? policy.granular : undefined;
  return {
    model_provider: values.model_provider ?? "",
    model: values.model ?? "",
    model_reasoning_effort: values.model_reasoning_effort ?? "",
    model_reasoning_summary: values.model_reasoning_summary ?? "",
    model_verbosity: values.model_verbosity ?? "",
    service_tier: values.service_tier ?? "",
    personality: values.personality ?? "",
    approval_policy: typeof policy === "string" ? policy : policy === null ? "" : "granular",
    approval_granular: granularApproval ?? defaultGranularApproval,
    approvals_reviewer: values.approvals_reviewer ?? "",
    sandbox_mode: values.sandbox_mode ?? "",
    default_permissions: values.default_permissions ?? "",
    web_search: values.web_search ?? "",
    windows_sandbox: values.windows_sandbox ?? "",
    shell_environment_include_only: linesFromConfig(values.shell_environment_include_only),
    features: Object.fromEntries(
      Object.entries(values.features).map(([name, value]) => [name, triStateFromConfig(value)]),
    ) as Record<FeatureName, TriState>,
  };
}

function configFromDraft(draft: ConfigDraft): EditableCodexConfig {
  return {
    model_provider: nullable(draft.model_provider),
    model: nullable(draft.model),
    model_reasoning_effort: nullable(draft.model_reasoning_effort),
    model_reasoning_summary: (draft.model_reasoning_summary ||
      null) as EditableCodexConfig["model_reasoning_summary"],
    model_verbosity: (draft.model_verbosity || null) as EditableCodexConfig["model_verbosity"],
    service_tier: nullable(draft.service_tier),
    personality: (draft.personality || null) as EditableCodexConfig["personality"],
    approval_policy:
      draft.approval_policy === "granular"
        ? { granular: { ...draft.approval_granular } }
        : ((draft.approval_policy || null) as EditableCodexConfig["approval_policy"]),
    approvals_reviewer: (draft.approvals_reviewer ||
      null) as EditableCodexConfig["approvals_reviewer"],
    sandbox_mode: (draft.sandbox_mode || null) as EditableCodexConfig["sandbox_mode"],
    default_permissions: nullable(draft.default_permissions),
    web_search: (draft.web_search || null) as EditableCodexConfig["web_search"],
    windows_sandbox: (draft.windows_sandbox || null) as EditableCodexConfig["windows_sandbox"],
    shell_environment_include_only: linesToConfig(draft.shell_environment_include_only),
    features: Object.fromEntries(
      Object.entries(draft.features).map(([name, value]) => [name, triStateToConfig(value)]),
    ) as EditableCodexConfig["features"],
  };
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

async function requestSnapshot(
  method: "GET" | "PUT",
  body?: Readonly<{
    expectedVersion: string | null;
    values: Partial<EditableCodexConfig>;
    wirebot?: WirebotSettings;
  }>,
): Promise<LoadedSnapshot> {
  const value = await requestJson("/api/config", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return value as LoadedSnapshot;
}

async function requestValidation(
  body: Readonly<{
    expectedVersion: string | null;
    values: Partial<EditableCodexConfig>;
  }>,
  signal?: AbortSignal,
): Promise<ConfigValidationResult> {
  const value = await requestJson("/api/config/validate", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  return value as ConfigValidationResult;
}

async function requestRuntime(action: "reload" | "restart"): Promise<CodexRuntimeStatus> {
  const value = await requestJson(`/api/runtime/${action}`, { method: "POST" });
  return (value as { readonly runtime: CodexRuntimeStatus }).runtime;
}

async function requestSkills(): Promise<readonly AvailableSkill[]> {
  const value = await requestJson("/api/skills", { method: "GET" });
  return (value as { readonly skills: readonly AvailableSkill[] }).skills;
}

async function requestUsage(): Promise<CodexUsageLimits> {
  return (await requestJson("/api/usage", { method: "GET" })) as CodexUsageLimits;
}

async function requestApplyBankedReset(
  confirmation: ResetConfirmation,
): Promise<ApplyBankedResetOutcome> {
  const value = await requestJson("/api/usage/reset", {
    method: "POST",
    body: JSON.stringify({
      creditId: confirmation.credit.id,
      idempotencyKey: confirmation.idempotencyKey,
    }),
  });
  return (value as { readonly outcome: ApplyBankedResetOutcome }).outcome;
}

async function requestSkillResource(skill: string, path: string): Promise<SkillResource> {
  const query = new URLSearchParams({ skill, path });
  const value = await requestJson(`/api/skills/resource?${query.toString()}`, { method: "GET" });
  return value as SkillResource;
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const initData = webApp?.initData;
  if (initData === undefined || initData.length === 0) {
    throw new Error("Telegram authorization is unavailable.");
  }
  const hasBody = init.body !== undefined;
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `tma ${initData}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const failure = value as {
      readonly error?: string;
      readonly issues?: readonly ConfigValidationIssue[];
    };
    throw new ConfigApiError(
      failure.error ?? `Request failed (${response.status}).`,
      failure.issues,
    );
  }
  return value;
}

function removeAppliedReset(
  usage: CodexUsageLimits | undefined,
  creditId: string,
): CodexUsageLimits | undefined {
  if (usage?.bankedResets === null || usage === undefined) return usage;
  return {
    ...usage,
    bankedResets: {
      availableCount: Math.max(0, usage.bankedResets.availableCount - 1),
      credits: usage.bankedResets.credits?.filter((credit) => credit.id !== creditId) ?? null,
    },
  };
}

function clearUnavailableResets(usage: CodexUsageLimits | undefined): CodexUsageLimits | undefined {
  return usage === undefined
    ? usage
    : { ...usage, bankedResets: { availableCount: 0, credits: [] } };
}

function resetAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `reset-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function resolveSelectedModel(
  model: string,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return model.length === 0
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

function constrainOptions(
  options: readonly UiOption[],
  allowed: ReadonlySet<string> | undefined,
): UiOption[] {
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

function triStateFromConfig(value: boolean | null): TriState {
  return value === null ? "" : (String(value) as TriState);
}

function triStateToConfig(value: TriState): boolean | null {
  return value === "" ? null : value === "true";
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

class ConfigApiError extends Error {
  public readonly issues: readonly ConfigValidationIssue[] | undefined;

  public constructor(message: string, issues: readonly ConfigValidationIssue[] | undefined) {
    super(message);
    this.name = "ConfigApiError";
    this.issues = issues;
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("Mini App root element is missing");
createRoot(root).render(<SettingsApp />);
