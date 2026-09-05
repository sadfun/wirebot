/** Shared browser and Telegram application shell. */
import { CalendarClock, LogOut, SlidersHorizontal, Sparkles, Terminal } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  ConfigApiError,
  exchangeLogin,
  type LoadedSnapshot,
  logoutBrowser,
  requestSession,
  requestSnapshot,
} from "./api.js";
import { SchedulesManager } from "./schedules.js";
import { SettingsForm } from "./settings-form.js";
import { messageOf, useAsync } from "./shared.js";
import { SkillsBrowser } from "./skills.js";
import { navigateWithUnsavedGuard, telegramReady, webApp } from "./telegram.js";
import { AppRoot, Button, Placeholder, Spinner, Tabbar } from "./ui.js";

type AppTab = "schedules" | "settings" | "skills";
type Session = { readonly provider: string } | null;
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

export function SettingsApp({ loginToken }: { readonly loginToken: string | null }): ReactElement {
  const [appearance, setAppearance] = useState<"dark" | "light">(
    webApp?.colorScheme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  const [session, setSession] = useState<Session | undefined>(
    telegramReady ? { provider: "telegram" } : undefined,
  );
  const [authError, setAuthError] = useState<string>();
  const [authBusy, setAuthBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>(tabFromLocation);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<LoadedSnapshot>();
  const initialAuth = useRef<Promise<Session> | undefined>(undefined);

  useEffect(() => {
    const app = webApp;
    if (app !== undefined) {
      const changed = (): void => setAppearance(app.colorScheme);
      app.ready();
      app.expand();
      app.onEvent("themeChanged", changed);
      return () => app.offEvent("themeChanged", changed);
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (): void => setAppearance(media.matches ? "dark" : "light");
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
  }, [appearance]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (telegramReady || viewport === null) return;
    const resize = (): void => {
      document.documentElement.style.setProperty(
        "--browser-viewport-height",
        `${viewport.height}px`,
      );
      document.documentElement.style.setProperty(
        "--browser-viewport-top",
        `${viewport.offsetTop}px`,
      );
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, []);

  useEffect(() => {
    if (telegramReady) return;
    let active = true;
    initialAuth.current ??= (async () => {
      if (loginToken !== null) await exchangeLogin(loginToken);
      try {
        return await requestSession();
      } catch (error) {
        if (loginToken === null && error instanceof ConfigApiError && error.status === 401)
          return null;
        throw error;
      }
    })();
    void initialAuth.current
      .then((value) => {
        if (active) setSession(value);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuthError(messageOf(error));
        setSession(null);
      });
    return () => {
      active = false;
    };
  }, [loginToken]);

  useEffect(() => {
    const expired = (): void => {
      setSession(null);
      setSnapshot(undefined);
      setAuthError("Your session ended. Request a fresh sign-in link from the bot.");
    };
    window.addEventListener("wirebot:session-expired", expired);
    return () => window.removeEventListener("wirebot:session-expired", expired);
  }, []);

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

  const snapshotLoad = useAsync(session ? () => requestSnapshot("GET") : undefined, [
    session,
    loadAttempt,
  ]);
  useEffect(() => {
    if (snapshotLoad.value !== undefined) setSnapshot(snapshotLoad.value);
  }, [snapshotLoad.value]);

  const signOut = (): void =>
    navigateWithUnsavedGuard(() => {
      setAuthBusy(true);
      void logoutBrowser()
        .then(() => {
          setSession(null);
          setSnapshot(undefined);
          setAuthError(undefined);
        })
        .catch((error: unknown) => setAuthError(messageOf(error)))
        .finally(() => setAuthBusy(false));
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
    <AppRoot
      appearance={appearance}
      className={`appRoot ${telegramReady ? "telegramApp" : "browserApp"} ${session ? "authenticatedApp" : ""}`}
    >
      {session === undefined ? (
        <div className="loadingRoot">
          <Placeholder header="Opening Wirebot">
            <Spinner size="l" />
          </Placeholder>
        </div>
      ) : session === null ? (
        <main className="loadingRoot px-5 py-8">
          <Placeholder
            className="rounded-2xl border border-border bg-card py-8"
            header={<h1 className="text-2xl">Sign in to Wirebot</h1>}
            description={
              <div className="space-y-4">
                <p>Manage Codex settings, skills, and schedules through your bot.</p>
                <p>
                  Send <code>/wirebot web</code> in a direct message to your Slack or Discord bot,
                  or <code>/web</code> in Telegram. Open the private link it replies with.
                </p>
                <p>Admin access only. Links work once and expire after 5 minutes.</p>
                {authError && (
                  <p className="text-destructive" role="alert">
                    {authError}
                  </p>
                )}
              </div>
            }
          >
            <Terminal className="size-10 text-primary" aria-hidden="true" />
          </Placeholder>
        </main>
      ) : (
        <>
          {!telegramReady && (
            <header className="browserHeader">
              <span>
                Connected through <strong>{session.provider}</strong>
              </span>
              <Button mode="plain" size="s" disabled={authBusy} onClick={signOut}>
                <LogOut size={16} /> Sign out
              </Button>
            </header>
          )}
          {authError && (
            <p className="sessionError" role="alert">
              {authError}
            </p>
          )}
          <main id="main-content">
            {activeTab === "settings" ? (
              snapshot === undefined ? (
                <SettingsLoading
                  error={snapshotLoad.error}
                  onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
                />
              ) : (
                <SettingsForm snapshot={snapshot} onSnapshot={setSnapshot} />
              )
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
      )}
    </AppRoot>
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
