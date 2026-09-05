/** Shared browser and Telegram application shell. */
import { CalendarClock, LogOut, SlidersHorizontal, Sparkles, Terminal } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { requestSnapshot } from "./api.js";
import { SchedulesManager } from "./schedules.js";
import { SettingsForm } from "./settings-form.js";
import { messageOf, useAsync } from "./shared.js";
import { SkillsBrowser } from "./skills.js";
import { navigateWithUnsavedGuard, telegramReady } from "./telegram.js";
import { Button, Placeholder, Spinner, Tabbar } from "./ui.js";

type AppTab = "schedules" | "settings" | "skills";
const tabs = [
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
] as const;

function tabFromLocation(): AppTab {
  const tab = telegramReady
    ? new URLSearchParams(window.location.search).get("tab")
    : window.location.pathname.split("/").at(-1);
  return tab === "skills" || tab === "schedules" ? tab : "settings";
}

function tabUrl(tab: AppTab): string {
  return telegramReady ? `/miniapp?tab=${tab}${window.location.hash}` : `/app/${tab}`;
}

export function SettingsApp({
  provider,
  onSignOut,
}: {
  readonly provider: string;
  readonly onSignOut: () => Promise<void>;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<AppTab>(tabFromLocation);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();

  // Keep browser back/forward navigation behind the same draft guard as tab clicks.
  useEffect(() => {
    const onPopState = (): void => {
      const next = tabFromLocation();
      if (next === activeTab) return;
      // Restore the current page while the unsaved-changes guard asks the user.
      window.history.replaceState(null, "", tabUrl(activeTab));
      navigateWithUnsavedGuard(() => {
        window.history.replaceState(null, "", tabUrl(next));
        setActiveTab(next);
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeTab]);

  const signOut = (): void =>
    navigateWithUnsavedGuard(() => {
      setSignOutBusy(true);
      void onSignOut()
        .catch((error: unknown) => setSignOutError(messageOf(error)))
        .finally(() => setSignOutBusy(false));
    });

  const selectTab = (next: AppTab): void => {
    if (next === activeTab) return;
    navigateWithUnsavedGuard(() => {
      window.history.pushState(null, "", tabUrl(next));
      setActiveTab(next);
      window.scrollTo(0, 0);
    });
  };

  return (
    <>
      {!telegramReady && (
        <header className="browserHeader">
          <span>
            Connected through <strong>{provider}</strong>
          </span>
          <Button mode="plain" size="s" loading={signOutBusy} onClick={signOut}>
            <LogOut size={16} /> Sign out
          </Button>
        </header>
      )}
      {signOutError && (
        <p className="sessionError" role="alert">
          {signOutError}
        </p>
      )}
      <main id="main-content">
        {activeTab === "settings" ? (
          <SettingsPage />
        ) : activeTab === "skills" ? (
          <SkillsBrowser />
        ) : (
          <SchedulesManager />
        )}
      </main>
      <Tabbar
        aria-label="Main navigation"
        brand={
          <>
            <Terminal aria-hidden="true" />
            <span>
              Wirebot<small>Your Codex workspace</small>
            </span>
          </>
        }
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <Tabbar.Item
            key={id}
            selected={activeTab === id}
            text={label}
            href={tabUrl(id)}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              selectTab(id);
            }}
          >
            <Icon aria-hidden="true" />
          </Tabbar.Item>
        ))}
      </Tabbar>
    </>
  );
}

/** Initial data is read when this tab opens; the form owns subsequent saves. */
function SettingsPage(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const { value, error } = useAsync(() => requestSnapshot("GET"), [loadAttempt]);
  return value === undefined ? (
    <SettingsLoading error={error} onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />
  ) : (
    <SettingsForm initialSnapshot={value} />
  );
}

export function SignIn({ error }: { readonly error: string | undefined }): ReactElement {
  return (
    <main className="loadingRoot px-5 py-8">
      <Placeholder
        className="rounded-2xl border border-border bg-card py-8"
        header={<h1 className="text-2xl">Sign in to Wirebot</h1>}
        description={
          <div className="space-y-4">
            <p>Manage Codex settings, skills, and schedules through your bot.</p>
            <p>
              Send <code>/wirebot web</code> in a direct message to your Slack or Discord bot, or{" "}
              <code>/web</code> in Telegram. Open the private link it replies with.
            </p>
            <p>Admin access only. Links work once and expire after 5 minutes.</p>
            {error && (
              <p className="text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        }
      >
        <Terminal className="size-10 text-primary" aria-hidden="true" />
      </Placeholder>
    </main>
  );
}

function SettingsLoading({
  error,
  onRetry,
}: {
  readonly error: string | undefined;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div className="loadingRoot tabbedLoadingRoot">
      {error !== undefined ? (
        <Placeholder
          header="Couldn’t open settings"
          description={error}
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      ) : (
        <Placeholder
          header="Loading Codex settings"
          description="Reading the effective config and capabilities…"
        >
          <Spinner size="l" />
        </Placeholder>
      )}
    </div>
  );
}
