import {
  CalendarClock,
  Check,
  ChevronLeft,
  CirclePlus,
  Clock3,
  Maximize2,
  Pause,
  Pencil,
  Play,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent,
  type ReactElement,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ManagedSchedule } from "../automations/engine.js";
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
  readonly BackButton?: {
    readonly isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(listener: () => void): void;
    offClick(listener: () => void): void;
  };
  ready(): void;
  expand(): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
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
const nativeTelegramNavigation = telegramReady && webApp?.BackButton !== undefined;

interface NativeBackEntry {
  readonly handler: () => void;
  readonly order: number;
  readonly priority: number;
}

const nativeBackEntries = new Map<symbol, NativeBackEntry>();
const unsavedScopes = new Set<symbol>();
let nativeBackOrder = 0;
let nativeBackListening = false;
let beforeUnloadListening = false;
let closingConfirmationEnabled = false;

function handleNativeBack(): void {
  const entry = [...nativeBackEntries.values()].sort(
    (left, right) => right.priority - left.priority || right.order - left.order,
  )[0];
  entry?.handler();
}

function syncNativeBackButton(): void {
  const backButton = nativeTelegramNavigation ? webApp?.BackButton : undefined;
  if (backButton === undefined) return;
  if (nativeBackEntries.size > 0) {
    if (!nativeBackListening) {
      backButton.onClick(handleNativeBack);
      nativeBackListening = true;
    }
    backButton.show();
    return;
  }
  if (nativeBackListening) {
    backButton.offClick(handleNativeBack);
    nativeBackListening = false;
  }
  backButton.hide();
}

function useTelegramBackButton(handler: (() => void) | undefined, priority: number): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = handler !== undefined && nativeTelegramNavigation;
  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("native-back-handler");
    nativeBackOrder += 1;
    nativeBackEntries.set(id, {
      handler: () => handlerRef.current?.(),
      order: nativeBackOrder,
      priority,
    });
    syncNativeBackButton();
    return () => {
      nativeBackEntries.delete(id);
      syncNativeBackButton();
    };
  }, [enabled, priority]);
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

function syncUnsavedChangesGuard(): void {
  const dirty = unsavedScopes.size > 0;
  if (dirty && !beforeUnloadListening) {
    window.addEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadListening = true;
  } else if (!dirty && beforeUnloadListening) {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadListening = false;
  }

  if (!telegramReady) return;
  if (dirty && !closingConfirmationEnabled) {
    webApp?.enableClosingConfirmation?.();
    closingConfirmationEnabled = true;
  } else if (!dirty && closingConfirmationEnabled) {
    webApp?.disableClosingConfirmation?.();
    closingConfirmationEnabled = false;
  }
}

function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol("unsaved-changes");
    unsavedScopes.add(id);
    syncUnsavedChangesGuard();
    return () => {
      unsavedScopes.delete(id);
      syncUnsavedChangesGuard();
    };
  }, [dirty]);
}

function confirmDiscardChanges(message = "Discard your unsaved changes?"): Promise<boolean> {
  if (telegramReady && webApp?.showConfirm !== undefined) {
    return new Promise((resolve) => {
      try {
        webApp?.showConfirm?.(message, resolve);
      } catch {
        resolve(window.confirm(message));
      }
    });
  }
  return Promise.resolve(window.confirm(message));
}

function navigateWithUnsavedGuard(action: () => void, forceGuard = false): void {
  if (!forceGuard && unsavedScopes.size === 0) {
    action();
    return;
  }
  void confirmDiscardChanges().then((confirmed) => {
    if (confirmed) action();
  });
}

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

interface ExpandableTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}

function ExpandableTextarea({
  label,
  value,
  onValueChange,
  className,
  disabled,
  id,
  rows,
  ...textareaProps
}: ExpandableTextareaProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="expandableTextarea">
        <textarea
          {...textareaProps}
          id={id}
          className={className}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <button
          type="button"
          className="expandTextareaButton"
          aria-label={`Edit ${label} full screen`}
          title="Edit full screen"
          disabled={disabled}
          onClick={() => setExpanded(true)}
        >
          <Maximize2 aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <FullscreenTextEditor
          label={label}
          initialValue={value}
          textareaProps={textareaProps}
          onApply={(nextValue) => {
            onValueChange(nextValue);
            setExpanded(false);
          }}
          onCancel={() => setExpanded(false)}
        />
      ) : undefined}
    </>
  );
}

interface FullscreenTextEditorProps {
  readonly label: string;
  readonly initialValue: string;
  readonly textareaProps: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "className" | "disabled" | "id" | "onChange" | "rows" | "value"
  >;
  readonly onApply: (value: string) => void;
  readonly onCancel: () => void;
}

function FullscreenTextEditor(props: FullscreenTextEditorProps): ReactElement {
  const [value, setValue] = useState(props.initialValue);
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = value !== props.initialValue;
  useUnsavedChanges(dirty);

  const close = useCallback((): void => {
    if (!dirty) {
      props.onCancel();
      return;
    }
    void confirmDiscardChanges(`Discard changes to ${props.label}?`).then((confirmed) => {
      if (confirmed) props.onCancel();
    });
  }, [dirty, props.label, props.onCancel]);
  const closeRef = useRef(close);
  closeRef.current = close;
  useTelegramBackButton(close, 100);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(props.initialValue.length, props.initialValue.length);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.initialValue.length]);

  return (
    <section
      className="fullscreenEditor"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${textareaId}-title`}
    >
      <header className="fullscreenEditorHeader">
        <Button
          type="button"
          mode="plain"
          size="s"
          className="fullscreenEditorClose"
          onClick={close}
        >
          <X className="size-5" aria-hidden="true" />
          <span className="fullscreenEditorCloseLabel">Cancel</span>
        </Button>
        <div className="fullscreenEditorHeading">
          <strong id={`${textareaId}-title`}>{props.label}</strong>
          <Caption>{dirty ? "Draft not applied" : "Editing draft"}</Caption>
        </div>
        <Button
          type="button"
          size="s"
          className="fullscreenEditorApply"
          onClick={() => props.onApply(value)}
        >
          <Check className="size-4" aria-hidden="true" />
          Apply
        </Button>
      </header>
      <div className="fullscreenEditorBody">
        <textarea
          {...props.textareaProps}
          ref={textareaRef}
          id={textareaId}
          className="fullscreenEditorTextarea"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </div>
      <footer className="fullscreenEditorFooter">
        <Caption>
          {value.length.toLocaleString()}
          {props.textareaProps.maxLength === undefined
            ? " characters"
            : ` / ${Number(props.textareaProps.maxLength).toLocaleString()}`}
        </Caption>
        <Caption>Apply returns this draft to the form. Save the form to persist it.</Caption>
      </footer>
    </section>
  );
}

function SettingsApp(): ReactElement {
  const [appearance, setAppearance] = useState<"dark" | "light">(webApp?.colorScheme ?? "light");
  const [activeTab, setActiveTab] = useState<"schedules" | "settings" | "skills">("settings");
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
  useUnsavedChanges(activeTab === "settings" && dirty);

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
  const selectTab = (nextTab: "schedules" | "settings" | "skills"): void => {
    if (nextTab === activeTab) return;
    navigateWithUnsavedGuard(
      () => {
        if (activeTab === "settings" && dirty && snapshot !== undefined) {
          setDraft(draftFromConfig(snapshot.values));
          setRemoteClientContext(snapshot.wirebot.remoteClientContext);
          setValidation(snapshot.validation);
          setNotice("Settings are up to date.");
        }
        setActiveTab(nextTab);
      },
      activeTab === "settings" && dirty,
    );
  };
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
      {activeTab === "settings" ? (
        settingsContent
      ) : activeTab === "skills" ? (
        <SkillsBrowser />
      ) : (
        <SchedulesManager />
      )}
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
          onClick={() => selectTab("settings")}
          aria-label="Settings"
        >
          {tabIcon("settings")}
        </Tabbar.Item>
        <Tabbar.Item
          selected={activeTab === "skills"}
          text="Skills"
          onClick={() => selectTab("skills")}
          aria-label="Skills"
        >
          {tabIcon("skills")}
        </Tabbar.Item>
        <Tabbar.Item
          selected={activeTab === "schedules"}
          text="Schedules"
          onClick={() => selectTab("schedules")}
          aria-label="Schedules"
        >
          {tabIcon("schedules")}
        </Tabbar.Item>
      </Tabbar>
    </AppRoot>
  );
}

type ScheduleCadence = "custom" | "daily" | "hourly" | "minutely" | "weekdays" | "weekly";

interface ScheduleDraft {
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  readonly interval: string;
  readonly time: string;
  readonly days: readonly string[];
  readonly customRrule: string;
  readonly timeZone: string;
  readonly notificationPolicy: ManagedSchedule["notification_policy"];
}

const weekdayOptions = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
] as const;

function SchedulesManager(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editing, setEditing] = useState<ManagedSchedule | "new">();
  const [deleting, setDeleting] = useState<ManagedSchedule>();
  const [mutationId, setMutationId] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const schedulesLoad = useAsync(requestSchedules, [loadAttempt]);

  const refresh = (message?: string): void => {
    setEditing(undefined);
    setDeleting(undefined);
    setMutationError(undefined);
    setNotice(message);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const toggleStatus = async (schedule: ManagedSchedule): Promise<void> => {
    if (mutationId !== undefined) return;
    const status = schedule.status === "active" ? "paused" : "active";
    setMutationId(schedule.id);
    setMutationError(undefined);
    try {
      await requestUpdateSchedule(schedule.id, {
        expected_revision: schedule.revision,
        status,
      });
      webApp?.HapticFeedback?.notificationOccurred("success");
      refresh(status === "active" ? `“${schedule.name}” resumed.` : `“${schedule.name}” paused.`);
    } catch (error) {
      setMutationError(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setMutationId(undefined);
    }
  };

  if (editing !== undefined) {
    return (
      <ScheduleEditor
        schedule={editing === "new" ? undefined : editing}
        onCancel={() => setEditing(undefined)}
        onSaved={(schedule) => {
          const created = editing === "new";
          refresh(created ? `“${schedule.name}” scheduled.` : `“${schedule.name}” updated.`);
        }}
      />
    );
  }

  const schedules = schedulesLoad.value;
  if (schedules === undefined) {
    if (schedulesLoad.error !== undefined) {
      return (
        <div className="loadingRoot tabbedLoadingRoot">
          <Placeholder
            header="Couldn’t load schedules"
            description={schedulesLoad.error}
            action={
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="loadingRoot tabbedLoadingRoot">
        <Placeholder header="Loading schedules" description="Reading your current scheduled runs…">
          <Spinner size="l" />
        </Placeholder>
      </div>
    );
  }

  const ordered = [...schedules].sort(compareSchedules);
  const activeCount = ordered.filter((schedule) => schedule.status === "active").length;
  return (
    <main className="page schedulesPage">
      <header className="pageHeader schedulesHeader">
        <div>
          <Headline Component="h1">Schedules</Headline>
          <Caption className="pageSubtitle">
            {activeCount} active · {ordered.length} total
          </Caption>
        </div>
        <Button
          type="button"
          size="s"
          className="scheduleCreateButton"
          onClick={() => setEditing("new")}
        >
          <CirclePlus className="size-4" aria-hidden="true" />
          New
        </Button>
      </header>
      {notice === undefined ? undefined : (
        <Caption className="scheduleNotice" role="status">
          {notice}
        </Caption>
      )}
      {mutationError === undefined ? undefined : (
        <Banner
          className="bannerSpacing"
          header="Couldn’t update the schedule"
          subheader={mutationError}
        />
      )}
      {ordered.length === 0 ? (
        <div className="scheduleEmpty">
          <Placeholder
            header="Nothing scheduled yet"
            description="Create a recurring task and Wirebot will run it even when the chat is quiet."
            action={<Button onClick={() => setEditing("new")}>Create a schedule</Button>}
          >
            <CalendarClock className="scheduleEmptyIcon" aria-hidden="true" />
          </Placeholder>
        </div>
      ) : (
        <div className="scheduleList">
          {ordered.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              busy={mutationId === schedule.id}
              onEdit={() => setEditing(schedule)}
              onToggle={() => void toggleStatus(schedule)}
              onDelete={() => {
                setMutationError(undefined);
                setDeleting(schedule);
              }}
            />
          ))}
        </div>
      )}
      {deleting === undefined ? undefined : (
        <ScheduleDeleteDialog
          schedule={deleting}
          deleting={mutationId === deleting.id}
          error={mutationError}
          onCancel={() => {
            if (mutationId === undefined) setDeleting(undefined);
          }}
          onDelete={async () => {
            if (mutationId !== undefined) return;
            setMutationId(deleting.id);
            setMutationError(undefined);
            try {
              await requestDeleteSchedule(deleting.id);
              webApp?.HapticFeedback?.notificationOccurred("success");
              refresh(`“${deleting.name}” deleted.`);
            } catch (error) {
              setMutationError(messageOf(error));
              webApp?.HapticFeedback?.notificationOccurred("error");
            } finally {
              setMutationId(undefined);
            }
          }}
        />
      )}
    </main>
  );
}

interface ScheduleCardProps {
  readonly schedule: ManagedSchedule;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
}

function ScheduleCard(props: ScheduleCardProps): ReactElement {
  const schedule = props.schedule;
  const nextRun =
    schedule.status === "paused"
      ? "Paused"
      : schedule.next_run_at === null
        ? "No future run"
        : `Next ${formatScheduleDate(schedule.next_run_at, schedule.time_zone)}`;
  return (
    <article className={`scheduleCard scheduleCard-${schedule.status}`}>
      <div className="scheduleCardTopline">
        <span className={`scheduleStatus scheduleStatus-${schedule.status}`}>
          <span aria-hidden="true" />
          {schedule.status === "active" ? "Active" : "Paused"}
        </span>
        <Caption className="scheduleKind">
          {schedule.kind === "heartbeat" ? "Heartbeat" : "Fresh task"}
        </Caption>
      </div>
      <div className="scheduleCardCopy">
        <h2>{schedule.name}</h2>
        <p className="ui-line-clamp-2">{schedule.prompt}</p>
      </div>
      <div className="scheduleTiming">
        <Clock3 className="size-4" aria-hidden="true" />
        <div>
          <strong>{humanizeRrule(schedule.rrule)}</strong>
          <Caption>{`${nextRun} · ${schedule.time_zone}`}</Caption>
        </div>
      </div>
      {schedule.deferral_reason === null ? undefined : (
        <Caption className="scheduleDeferral">Waiting: {schedule.deferral_reason}</Caption>
      )}
      <div className="scheduleActions">
        <Button type="button" mode="bezeled" size="s" disabled={props.busy} onClick={props.onEdit}>
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </Button>
        <Button type="button" mode="bezeled" size="s" loading={props.busy} onClick={props.onToggle}>
          {schedule.status === "active" ? (
            <Pause className="size-4" aria-hidden="true" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
          {schedule.status === "active" ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          mode="plain"
          size="s"
          className="scheduleDeleteButton"
          aria-label={`Delete ${schedule.name}`}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}

interface ScheduleEditorProps {
  readonly schedule: ManagedSchedule | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (schedule: ManagedSchedule) => void;
}

function ScheduleEditor(props: ScheduleEditorProps): ReactElement {
  const [initialDraft] = useState<ScheduleDraft>(() => scheduleDraft(props.schedule));
  const [draft, setDraft] = useState<ScheduleDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [idempotencyKey] = useState(scheduleAttemptId);
  const existing = props.schedule;
  const dirty = !scheduleDraftsEqual(draft, initialDraft);
  useUnsavedChanges(dirty);

  const cancel = useCallback((): void => {
    if (saving) return;
    if (!dirty) {
      props.onCancel();
      return;
    }
    void confirmDiscardChanges("Discard this schedule draft?").then((confirmed) => {
      if (confirmed) props.onCancel();
    });
  }, [dirty, props.onCancel, saving]);
  useTelegramBackButton(saving ? undefined : cancel, 20);

  const setValue = <Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const validationError = validateScheduleDraft(draft);
    if (validationError !== undefined) {
      setError(validationError);
      webApp?.HapticFeedback?.notificationOccurred("warning");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const values = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        rrule: rruleFromDraft(draft),
        time_zone: draft.timeZone.trim(),
        notification_policy: draft.notificationPolicy,
      };
      const schedule =
        existing === undefined
          ? await requestCreateSchedule({ ...values, idempotency_key: idempotencyKey })
          : await requestUpdateSchedule(existing.id, {
              ...values,
              expected_revision: existing.revision,
            });
      webApp?.HapticFeedback?.notificationOccurred("success");
      props.onSaved(schedule);
    } catch (saveError) {
      setError(messageOf(saveError));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setSaving(false);
    }
  };

  const showInterval = ["daily", "hourly", "minutely", "weekly"].includes(draft.cadence);
  const showTime = ["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence);
  return (
    <form onSubmit={(event) => void submit(event)}>
      <main className="page scheduleEditorPage">
        <header className="skillDetailHeader scheduleEditorHeader">
          {nativeTelegramNavigation ? undefined : (
            <Button type="button" mode="plain" size="s" disabled={saving} onClick={cancel}>
              <ChevronLeft className="size-4" aria-hidden="true" />
              Schedules
            </Button>
          )}
          <Headline Component="h1">
            {existing === undefined ? "New schedule" : "Edit schedule"}
          </Headline>
          <Caption className="pageSubtitle">
            {existing?.kind === "heartbeat"
              ? "This heartbeat continues its original Codex task."
              : "Each run starts a fresh persistent Codex task."}
          </Caption>
        </header>
        {error === undefined ? undefined : (
          <Banner
            className="bannerSpacing"
            header="Couldn’t save this schedule"
            subheader={error}
          />
        )}
        <div className="sectionStack">
          <Section header="Task" footer="Give Codex enough detail to run unattended.">
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-name">
                Name
              </Caption>
              <input
                id="schedule-name"
                className="nativeControl"
                value={draft.name}
                maxLength={200}
                autoComplete="off"
                placeholder="Daily project check"
                disabled={saving}
                onChange={(event) => setValue("name", event.currentTarget.value)}
              />
              <Caption className="fieldHint">
                A short label for notifications and this list.
              </Caption>
            </div>
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-prompt">
                Instructions
              </Caption>
              <ExpandableTextarea
                id="schedule-prompt"
                className="nativeControl nativeTextarea schedulePrompt"
                label="schedule instructions"
                value={draft.prompt}
                maxLength={20_000}
                rows={5}
                placeholder="Check the repository for failed CI runs and summarize anything actionable."
                disabled={saving}
                onValueChange={(value) => setValue("prompt", value)}
              />
              <Caption className="fieldHint">
                This is the full prompt Codex receives on every run.
              </Caption>
            </div>
          </Section>
          <Section
            header="Timing"
            footer="Times use the selected IANA time zone, including daylight saving changes."
          >
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-cadence">
                Repeats
              </Caption>
              <select
                id="schedule-cadence"
                className="nativeControl nativeSelect"
                value={draft.cadence}
                disabled={saving}
                onChange={(event) =>
                  setValue("cadence", event.currentTarget.value as ScheduleCadence)
                }
              >
                <option value="minutely">Every few minutes</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom RRULE</option>
              </select>
              <Caption className="fieldHint">
                Common schedules stay readable; custom rules remain editable.
              </Caption>
            </div>
            {showInterval ? (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-interval">
                  Every
                </Caption>
                <div className="scheduleIntervalControl">
                  <input
                    id="schedule-interval"
                    className="nativeControl"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1_000}
                    value={draft.interval}
                    disabled={saving}
                    onChange={(event) => setValue("interval", event.currentTarget.value)}
                  />
                  <Caption>{cadenceUnit(draft.cadence, Number(draft.interval))}</Caption>
                </div>
                <Caption className="fieldHint">
                  Use 1 for every {cadenceUnit(draft.cadence, 1)}.
                </Caption>
              </div>
            ) : undefined}
            {showTime ? (
              <div className="field scheduleTimeRow">
                <div>
                  <Caption Component="label" className="controlLabel" htmlFor="schedule-time">
                    {draft.cadence === "hourly" ? "At minute" : "Time"}
                  </Caption>
                  {draft.cadence === "hourly" ? (
                    <input
                      id="schedule-time"
                      className="nativeControl"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={59}
                      value={draft.time.slice(3)}
                      disabled={saving}
                      onChange={(event) =>
                        setValue("time", `00:${event.currentTarget.value.padStart(2, "0")}`)
                      }
                    />
                  ) : (
                    <input
                      id="schedule-time"
                      className="nativeControl"
                      type="time"
                      value={draft.time}
                      disabled={saving}
                      onChange={(event) => setValue("time", event.currentTarget.value)}
                    />
                  )}
                </div>
                <div>
                  <Caption Component="label" className="controlLabel" htmlFor="schedule-time-zone">
                    Time zone
                  </Caption>
                  <input
                    id="schedule-time-zone"
                    className="nativeControl"
                    value={draft.timeZone}
                    maxLength={128}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Europe/Warsaw"
                    disabled={saving}
                    onChange={(event) => setValue("timeZone", event.currentTarget.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-time-zone">
                  Time zone
                </Caption>
                <input
                  id="schedule-time-zone"
                  className="nativeControl"
                  value={draft.timeZone}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Europe/Warsaw"
                  disabled={saving}
                  onChange={(event) => setValue("timeZone", event.currentTarget.value)}
                />
                <Caption className="fieldHint">
                  Use an IANA time zone, such as Europe/Warsaw.
                </Caption>
              </div>
            )}
            {draft.cadence === "weekly" ? (
              <fieldset className="field scheduleDaysField">
                <legend className="controlLabel">Days</legend>
                <div className="weekdayPicker">
                  {weekdayOptions.map(([value, label]) => {
                    const selected = draft.days.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className={
                          selected ? "weekdayButton weekdayButtonSelected" : "weekdayButton"
                        }
                        aria-pressed={selected}
                        disabled={saving}
                        onClick={() =>
                          setValue(
                            "days",
                            selected
                              ? draft.days.filter((day) => day !== value)
                              : [...draft.days, value],
                          )
                        }
                      >
                        {label.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
                <Caption className="fieldHint">Choose one or more days.</Caption>
              </fieldset>
            ) : undefined}
            {draft.cadence === "custom" ? (
              <div className="field">
                <Caption Component="label" className="controlLabel" htmlFor="schedule-rrule">
                  RRULE
                </Caption>
                <ExpandableTextarea
                  id="schedule-rrule"
                  className="nativeControl nativeTextarea scheduleRrule"
                  label="custom RRULE"
                  value={draft.customRrule}
                  rows={3}
                  maxLength={4_096}
                  spellCheck={false}
                  disabled={saving}
                  onValueChange={(value) => setValue("customRrule", value)}
                />
                <Caption className="fieldHint">
                  One bounded RRULE line; DTSTART is managed by Wirebot.
                </Caption>
              </div>
            ) : undefined}
          </Section>
          <Section
            header="Notifications"
            footer="Heartbeat schedules can decide when a result is important."
          >
            <div className="field">
              <Caption Component="label" className="controlLabel" htmlFor="schedule-notifications">
                Notify me
              </Caption>
              <select
                id="schedule-notifications"
                className="nativeControl nativeSelect"
                value={draft.notificationPolicy}
                disabled={saving}
                onChange={(event) =>
                  setValue(
                    "notificationPolicy",
                    event.currentTarget.value as ManagedSchedule["notification_policy"],
                  )
                }
              >
                <option value="always">After every run</option>
                <option value="on-result">Only when there is something to report</option>
                <option value="never">Never</option>
              </select>
              <Caption className="fieldHint">
                Runs still happen when notifications are suppressed.
              </Caption>
            </div>
          </Section>
        </div>
        <div className="scheduleEditorActions">
          <Button type="button" mode="bezeled" size="l" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" size="l" loading={saving}>
            {existing === undefined ? "Create schedule" : "Save changes"}
          </Button>
        </div>
      </main>
    </form>
  );
}

interface ScheduleDeleteDialogProps {
  readonly schedule: ManagedSchedule;
  readonly deleting: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onDelete: () => Promise<void>;
}

function ScheduleDeleteDialog(props: ScheduleDeleteDialogProps): ReactElement {
  useTelegramBackButton(props.deleting ? undefined : props.onCancel, 50);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !props.deleting) props.onCancel();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.deleting, props.onCancel]);
  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !props.deleting) props.onCancel();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop dismisses on click; Escape is handled while the dialog is open.
    <div className="resetDialogBackdrop" onMouseDown={dismissBackdrop}>
      <section
        className="resetDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-schedule-title"
        aria-describedby="delete-schedule-description"
      >
        <h2 id="delete-schedule-title">Delete “{props.schedule.name}”?</h2>
        <p id="delete-schedule-description">
          This permanently removes the schedule and its retained run history. It cannot be undone.
        </p>
        {props.error === undefined ? undefined : (
          <Caption className="resetDialogError" role="alert">
            {props.error}
          </Caption>
        )}
        <div className="resetDialogActions">
          <Button type="button" mode="bezeled" disabled={props.deleting} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            className="resetConfirmApply"
            loading={props.deleting}
            autoFocus
            onClick={() => void props.onDelete()}
          >
            Delete schedule
          </Button>
        </div>
      </section>
    </div>
  );
}

function SkillsBrowser(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<AvailableSkill>();
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string>();
  const navigateBack = useCallback((): void => {
    if (selectedFilePath !== undefined) {
      setSelectedFilePath(undefined);
      return;
    }
    if (directoryPath.length > 0) {
      setDirectoryPath(parentDirectory(directoryPath));
      return;
    }
    setSelectedSkill(undefined);
  }, [directoryPath, selectedFilePath]);
  useTelegramBackButton(selectedSkill === undefined ? undefined : navigateBack, 10);

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
        {nativeTelegramNavigation ? undefined : (
          <Button mode="plain" size="s" onClick={options.onBack} aria-label="Back to skills">
            ‹ Skills
          </Button>
        )}
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

function tabIcon(kind: "schedules" | "settings" | "skills"): ReactElement {
  if (kind === "settings") return <SlidersHorizontal aria-hidden="true" />;
  if (kind === "skills") return <Sparkles aria-hidden="true" />;
  return <CalendarClock aria-hidden="true" />;
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

function compareSchedules(left: ManagedSchedule, right: ManagedSchedule): number {
  if (left.status !== right.status) return left.status === "active" ? -1 : 1;
  const leftNext = left.next_run_at ?? "9999";
  const rightNext = right.next_run_at ?? "9999";
  const nextOrder = leftNext.localeCompare(rightNext);
  return nextOrder === 0 ? left.name.localeCompare(right.name) : nextOrder;
}

function scheduleDraft(schedule: ManagedSchedule | undefined): ScheduleDraft {
  const now = new Date();
  const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (schedule === undefined) {
    return {
      name: "",
      prompt: "",
      cadence: "daily",
      interval: "1",
      time: defaultTime,
      days: ["MO"],
      customRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timeZone: defaultTimeZone,
      notificationPolicy: "always",
    };
  }

  const fields = parseRruleFields(schedule.rrule);
  const frequency = fields?.get("FREQ");
  const interval = fields?.get("INTERVAL") ?? "1";
  const hour = fields?.get("BYHOUR") ?? "0";
  const minute = fields?.get("BYMINUTE") ?? "0";
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const days = fields?.get("BYDAY")?.split(",") ?? ["MO"];
  let cadence: ScheduleCadence = "custom";
  if (fields !== undefined && hasOnlyFields(fields, ["FREQ", "INTERVAL"])) {
    if (frequency === "MINUTELY") cadence = "minutely";
  }
  if (
    fields !== undefined &&
    frequency === "HOURLY" &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYMINUTE"]) &&
    isSingleInteger(minute, 0, 59)
  ) {
    cadence = "hourly";
  }
  if (
    fields !== undefined &&
    frequency === "DAILY" &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute)
  ) {
    cadence = "daily";
  }
  if (
    fields !== undefined &&
    frequency === "WEEKLY" &&
    fields.has("BYDAY") &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute) &&
    days.every((day) => weekdayOptions.some(([value]) => value === day))
  ) {
    cadence = sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"]) ? "weekdays" : "weekly";
  }
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    cadence,
    interval,
    time: isClockFields(hour, minute) ? time : defaultTime,
    days,
    customRrule: schedule.rrule,
    timeZone: schedule.time_zone,
    notificationPolicy: schedule.notification_policy,
  };
}

function scheduleDraftsEqual(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateScheduleDraft(draft: ScheduleDraft): string | undefined {
  if (draft.name.trim().length === 0) return "Add a schedule name.";
  if (draft.prompt.trim().length === 0) return "Add instructions for Codex.";
  if (draft.timeZone.trim().length === 0) return "Add an IANA time zone, such as Europe/Warsaw.";
  if (["daily", "hourly", "minutely", "weekly"].includes(draft.cadence)) {
    const interval = Number(draft.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1_000) {
      return "The repeat interval must be a whole number from 1 to 1000.";
    }
  }
  if (["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence)) {
    const [hour, minute] = draft.time.split(":").map(Number);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour === undefined ||
      minute === undefined ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return draft.cadence === "hourly" ? "Choose a minute from 0 to 59." : "Choose a valid time.";
    }
  }
  if (draft.cadence === "weekly" && draft.days.length === 0) {
    return "Choose at least one day.";
  }
  if (draft.cadence === "custom" && draft.customRrule.trim().length === 0) {
    return "Add a custom RRULE.";
  }
  return undefined;
}

function rruleFromDraft(draft: ScheduleDraft): string {
  if (draft.cadence === "custom") return draft.customRrule.trim();
  const interval = Number(draft.interval);
  const intervalField = interval === 1 ? "" : `;INTERVAL=${interval}`;
  const [hour = "0", minute = "0"] = draft.time.split(":");
  switch (draft.cadence) {
    case "minutely":
      return `FREQ=MINUTELY${intervalField}`;
    case "hourly":
      return `FREQ=HOURLY${intervalField};BYMINUTE=${Number(minute)}`;
    case "daily":
      return `FREQ=DAILY${intervalField};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekly":
      return `FREQ=WEEKLY${intervalField};BYDAY=${orderedWeekdays(draft.days).join(",")};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
  }
}

function humanizeRrule(rule: string): string {
  const fields = parseRruleFields(rule);
  if (fields === undefined) return rule;
  const interval = Number(fields.get("INTERVAL") ?? "1");
  const frequency = fields.get("FREQ");
  const minute = fields.get("BYMINUTE");
  const hour = fields.get("BYHOUR");
  if (!Number.isInteger(interval) || interval < 1) return rule;
  if (frequency === "MINUTELY") {
    return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
  }
  if (frequency === "HOURLY" && minute !== undefined) {
    const suffix = `at :${minute.padStart(2, "0")}`;
    return interval === 1 ? `Every hour ${suffix}` : `Every ${interval} hours ${suffix}`;
  }
  const formattedTime =
    hour !== undefined && minute !== undefined
      ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : undefined;
  if (frequency === "DAILY" && formattedTime !== undefined) {
    return interval === 1
      ? `Daily at ${formattedTime}`
      : `Every ${interval} days at ${formattedTime}`;
  }
  if (frequency === "WEEKLY" && formattedTime !== undefined) {
    const days = fields.get("BYDAY")?.split(",") ?? [];
    if (sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"])) {
      return `Weekdays at ${formattedTime}`;
    }
    const labels = orderedWeekdays(days)
      .map((day) => weekdayOptions.find(([value]) => value === day)?.[1])
      .filter(isDefined);
    if (labels.length > 0) {
      const prefix =
        interval === 1 ? labels.join(", ") : `Every ${interval} weeks · ${labels.join(", ")}`;
      return `${prefix} at ${formattedTime}`;
    }
  }
  return rule;
}

function parseRruleFields(rule: string): ReadonlyMap<string, string> | undefined {
  const normalized = rule.trim().replace(/^RRULE:/iu, "");
  if (normalized.length === 0 || /[\r\n]/u.test(normalized)) return undefined;
  const fields = new Map<string, string>();
  for (const component of normalized.split(";")) {
    const separator = component.indexOf("=");
    if (separator <= 0 || separator === component.length - 1) return undefined;
    const key = component.slice(0, separator).trim().toUpperCase();
    const value = component
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (fields.has(key)) return undefined;
    fields.set(key, value);
  }
  return fields;
}

function hasOnlyFields(fields: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return [...fields.keys()].every((key) => allowedSet.has(key));
}

function isClockFields(hour: string, minute: string): boolean {
  return isSingleInteger(hour, 0, 23) && isSingleInteger(minute, 0, 59);
}

function isSingleInteger(value: string, minimum: number, maximum: number): boolean {
  if (!/^\d{1,2}$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function orderedWeekdays(days: readonly string[]): string[] {
  const selected = new Set(days);
  return weekdayOptions.map(([value]) => value).filter((day) => selected.has(day));
}

function sameWeekdays(left: readonly string[], right: readonly string[]): boolean {
  return orderedWeekdays(left).join(",") === orderedWeekdays(right).join(",");
}

function cadenceUnit(cadence: ScheduleCadence, amount: number): string {
  const singular =
    cadence === "minutely"
      ? "minute"
      : cadence === "hourly"
        ? "hour"
        : cadence === "daily"
          ? "day"
          : "week";
  return amount === 1 ? singular : `${singular}s`;
}

function formatScheduleDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function scheduleAttemptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `schedule-${Date.now()}-${Math.random()}`;
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
  useTelegramBackButton(props.applying ? undefined : props.onCancel, 50);
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

async function requestSchedules(): Promise<readonly ManagedSchedule[]> {
  const value = await requestJson("/api/schedules", { method: "GET" });
  return (value as { readonly schedules: readonly ManagedSchedule[] }).schedules;
}

async function requestCreateSchedule(
  input: Readonly<{
    name: string;
    prompt: string;
    rrule: string;
    time_zone: string;
    notification_policy: ManagedSchedule["notification_policy"];
    idempotency_key: string;
  }>,
): Promise<ManagedSchedule> {
  const value = await requestJson("/api/schedules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (value as { readonly schedule: ManagedSchedule }).schedule;
}

async function requestUpdateSchedule(
  id: string,
  input: Readonly<{
    expected_revision: number;
    name?: string;
    prompt?: string;
    rrule?: string;
    time_zone?: string;
    status?: ManagedSchedule["status"];
    notification_policy?: ManagedSchedule["notification_policy"];
  }>,
): Promise<ManagedSchedule> {
  const value = await requestJson(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return (value as { readonly schedule: ManagedSchedule }).schedule;
}

async function requestDeleteSchedule(id: string): Promise<void> {
  await requestJson(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
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
