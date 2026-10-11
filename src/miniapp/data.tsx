/**
 * App-wide data: the settings snapshot, the skill and schedule lists, and
 * polled usage limits. Loaded once when the app opens so that tabs, the
 * desktop rail, and the Settings pages share one copy.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ManagedSchedule } from "../automations/engine.js";
import type { AvailableSkill, CodexUsageLimits } from "../codex/runtime-service.js";
import {
  type LoadedSnapshot,
  requestSchedules,
  requestSkills,
  requestSnapshot,
  requestUsage,
} from "./api.js";
import { type AsyncState, messageOf, useAsync } from "./shared.js";

export interface UsageState {
  readonly value: CodexUsageLimits | undefined;
  readonly error: string | undefined;
  readonly refreshing: boolean;
  readonly refresh: (showRefreshing?: boolean) => Promise<void>;
  readonly update: (
    updater: (current: CodexUsageLimits | undefined) => CodexUsageLimits | undefined,
  ) => void;
}

export interface AppData {
  readonly provider: string;
  readonly snapshot: LoadedSnapshot | undefined;
  readonly snapshotError: string | undefined;
  readonly setSnapshot: (
    snapshot: LoadedSnapshot | ((current: LoadedSnapshot | undefined) => LoadedSnapshot),
  ) => void;
  readonly reloadSnapshot: () => void;
  readonly skills: readonly AvailableSkill[] | undefined;
  readonly skillsError: string | undefined;
  readonly reloadSkills: () => void;
  readonly schedules: readonly ManagedSchedule[] | undefined;
  readonly schedulesError: string | undefined;
  readonly updateSchedules: (
    updater: (current: readonly ManagedSchedule[]) => readonly ManagedSchedule[],
  ) => void;
  readonly reloadSchedules: () => void;
  readonly usage: UsageState;
  readonly signOut: () => void;
  readonly signOutBusy: boolean;
  readonly signOutError: string | undefined;
}

const AppDataContext = createContext<AppData | undefined>(undefined);

interface Override<Value> {
  readonly base: Value | undefined;
  readonly value: Value;
}

interface AppDataProviderProps {
  readonly provider: string;
  readonly onSignOut: () => Promise<void>;
  readonly children: ReactNode;
}

export function AppDataProvider(props: AppDataProviderProps): ReactElement {
  const [snapshotAttempt, setSnapshotAttempt] = useState(0);
  const [skillsAttempt, setSkillsAttempt] = useState(0);
  const [schedulesAttempt, setSchedulesAttempt] = useState(0);
  const snapshotLoad = useAsync(() => requestSnapshot("GET"), [snapshotAttempt]);
  const skillsLoad = useAsync(requestSkills, [skillsAttempt]);
  const schedulesLoad = useAsync(requestSchedules, [schedulesAttempt]);
  // Local edits win over the load they were based on; a reload replaces them.
  const [snapshotOverride, setSnapshotOverride] = useState<Override<LoadedSnapshot>>();
  const [schedulesOverride, setSchedulesOverride] =
    useState<Override<readonly ManagedSchedule[]>>();
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const usage = useUsage();

  const snapshot =
    snapshotOverride !== undefined && snapshotOverride.base === snapshotLoad.value
      ? snapshotOverride.value
      : snapshotLoad.value;
  const schedules =
    schedulesOverride !== undefined && schedulesOverride.base === schedulesLoad.value
      ? schedulesOverride.value
      : schedulesLoad.value;
  const setSnapshot = useCallback(
    (value: LoadedSnapshot | ((current: LoadedSnapshot | undefined) => LoadedSnapshot)): void => {
      const base = snapshotLoad.value;
      setSnapshotOverride((current) => ({
        base,
        value:
          typeof value === "function"
            ? value(current !== undefined && current.base === base ? current.value : base)
            : value,
      }));
    },
    [snapshotLoad.value],
  );
  const updateSchedules = useCallback(
    (updater: (current: readonly ManagedSchedule[]) => readonly ManagedSchedule[]): void => {
      const base = schedulesLoad.value;
      setSchedulesOverride((current) => ({
        base,
        value: updater(
          current !== undefined && current.base === base ? current.value : (base ?? []),
        ),
      }));
    },
    [schedulesLoad.value],
  );
  const signOut = useCallback((): void => {
    setSignOutBusy(true);
    setSignOutError(undefined);
    void props
      .onSignOut()
      .catch((error: unknown) => setSignOutError(messageOf(error)))
      .finally(() => setSignOutBusy(false));
  }, [props.onSignOut]);

  const value = useMemo<AppData>(
    () => ({
      provider: props.provider,
      snapshot,
      snapshotError: snapshotLoad.error,
      setSnapshot,
      reloadSnapshot: () => setSnapshotAttempt((attempt) => attempt + 1),
      skills: skillsLoad.value,
      skillsError: skillsLoad.error,
      reloadSkills: () => setSkillsAttempt((attempt) => attempt + 1),
      schedules,
      schedulesError: schedulesLoad.error,
      updateSchedules,
      reloadSchedules: () => setSchedulesAttempt((attempt) => attempt + 1),
      usage,
      signOut,
      signOutBusy,
      signOutError,
    }),
    [
      props.provider,
      snapshot,
      snapshotLoad.error,
      setSnapshot,
      skillsLoad,
      schedules,
      schedulesLoad.error,
      updateSchedules,
      usage,
      signOut,
      signOutBusy,
      signOutError,
    ],
  );
  return <AppDataContext.Provider value={value}>{props.children}</AppDataContext.Provider>;
}

export function useAppData(): AppData {
  const data = useContext(AppDataContext);
  if (data === undefined) throw new Error("useAppData requires an AppDataProvider");
  return data;
}

function useUsage(): UsageState {
  const [state, setState] = useState<AsyncState<CodexUsageLimits>>({});
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (showRefreshing = true): Promise<void> => {
    if (showRefreshing) setRefreshing(true);
    try {
      const value = await requestUsage();
      setState({ value });
    } catch (error) {
      setState((current) => ({ ...current, error: messageOf(error) }));
    } finally {
      if (showRefreshing) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(false), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const update = useCallback(
    (updater: (current: CodexUsageLimits | undefined) => CodexUsageLimits | undefined): void => {
      setState((current) => ({ ...current, value: updater(current.value) }));
    },
    [],
  );
  return useMemo(
    () => ({ value: state.value, error: state.error, refreshing, refresh, update }),
    [state, refreshing, refresh, update],
  );
}
