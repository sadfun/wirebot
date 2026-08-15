/**
 * The Mini App shell: theme integration, the Settings/Skills/Schedules tab
 * bar, and the initial config snapshot load for the Settings tab.
 */
import { CalendarClock, SlidersHorizontal, Sparkles } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { type LoadedSnapshot, requestSnapshot } from "./api.js";
import { SchedulesManager } from "./schedules.js";
import { SettingsForm } from "./settings-form.js";
import { useAsync } from "./shared.js";
import { SkillsBrowser } from "./skills.js";
import { navigateWithUnsavedGuard, telegramReady, webApp } from "./telegram.js";
import { AppRoot, Button, Placeholder, Spinner, Tabbar } from "./ui.js";

type AppTab = "schedules" | "settings" | "skills";

export function SettingsApp(): ReactElement {
  const [appearance, setAppearance] = useState<"dark" | "light">(webApp?.colorScheme ?? "light");
  const [activeTab, setActiveTab] = useState<AppTab>("settings");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<LoadedSnapshot>();

  useEffect(() => {
    const app = webApp;
    if (app === undefined) return;
    const handleThemeChanged = (): void => setAppearance(app.colorScheme);
    app.ready();
    app.expand();
    app.onEvent("themeChanged", handleThemeChanged);
    return () => app.offEvent("themeChanged", handleThemeChanged);
  }, []);

  const snapshotLoad = useAsync(telegramReady ? () => requestSnapshot("GET") : undefined, [
    loadAttempt,
  ]);
  const loadError = telegramReady
    ? snapshotLoad.error
    : "Open this settings page from the bot in Telegram.";

  useEffect(() => {
    if (snapshotLoad.value !== undefined) setSnapshot(snapshotLoad.value);
  }, [snapshotLoad.value]);

  const selectTab = (nextTab: AppTab): void => {
    if (nextTab === activeTab) return;
    navigateWithUnsavedGuard(() => setActiveTab(nextTab));
  };

  const settingsContent =
    snapshot === undefined ? (
      <SettingsLoading error={loadError} onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />
    ) : (
      <SettingsForm snapshot={snapshot} onSnapshot={setSnapshot} />
    );

  return (
    <AppRoot appearance={appearance} className="appRoot">
      {activeTab === "settings" ? (
        settingsContent
      ) : activeTab === "skills" ? (
        <SkillsBrowser />
      ) : (
        <SchedulesManager />
      )}
      <Tabbar aria-label="Main navigation">
        <Tabbar.Item
          selected={activeTab === "settings"}
          text="Settings"
          onClick={() => selectTab("settings")}
          aria-label="Settings"
        >
          <SlidersHorizontal aria-hidden="true" />
        </Tabbar.Item>
        <Tabbar.Item
          selected={activeTab === "skills"}
          text="Skills"
          onClick={() => selectTab("skills")}
          aria-label="Skills"
        >
          <Sparkles aria-hidden="true" />
        </Tabbar.Item>
        <Tabbar.Item
          selected={activeTab === "schedules"}
          text="Schedules"
          onClick={() => selectTab("schedules")}
          aria-label="Schedules"
        >
          <CalendarClock aria-hidden="true" />
        </Tabbar.Item>
      </Tabbar>
    </AppRoot>
  );
}

interface SettingsLoadingProps {
  readonly error: string | undefined;
  readonly onRetry: () => void;
}

function SettingsLoading(props: SettingsLoadingProps): ReactElement {
  if (props.error !== undefined) {
    return (
      <div className="loadingRoot">
        <Placeholder
          header="Couldn’t open settings"
          description={props.error}
          action={<Button onClick={props.onRetry}>Try again</Button>}
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
