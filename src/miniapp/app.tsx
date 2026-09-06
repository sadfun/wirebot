/** Shared browser and Telegram application shell. */
import { CalendarClock, LogOut, SlidersHorizontal, Sparkles } from "lucide-react";
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
      <Tabbar aria-label="Main navigation" brand={<WirebotLogo />}>
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
        <WirebotLogo className="h-12 w-52 max-w-full" />
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

/** Full logo from https://wirebot.ai/. */
function WirebotLogo({ className }: { readonly className?: string }): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 428.7 100.7"
      role="img"
      aria-label="Wirebot"
      focusable="false"
    >
      <g fill="currentColor" transform="translate(0 -174)">
        <g transform="translate(0 173.97) scale(0.3158)">
          <path d="M105 19 A19 19 0 1 1 143 19 A19 19 0 1 1 105 19 Z M117 31 H131 V79 H117 Z M0 195 A124 124 0 1 1 248 195 A124 124 0 1 1 0 195 Z M97 174 A15 15 0 0 0 67 174 V224 A15 15 0 0 0 97 224 Z M181 174 A15 15 0 0 0 151 174 V224 A15 15 0 0 0 181 224 Z" />
        </g>
        <path d="M122.2 260.0 107.3 211.1H120.2L130.6 248.4H126.7L138.7 211.1H149.3L161.3 248.4H157.5L167.9 211.1H180.4L165.4 260.0H153.8L142.2 225.0H145.8L134.1 260.0Z M198.7 260.0H185.6V211.1H198.7ZM184.2 195.9Q184.2 192.3 186.4 190.1Q188.5 187.8 192.1 187.8Q195.7 187.8 197.9 190.1Q200.0 192.3 200.0 195.9Q200.0 199.3 197.9 201.5Q195.7 203.7 192.1 203.7Q188.5 203.7 186.4 201.5Q184.2 199.3 184.2 195.9Z M218.4 211.1 221.7 224.6V260.0H208.6V211.1ZM219.0 231.3 216.6 230.2V220.2L217.5 219.1Q218.6 217.3 220.9 215.2Q223.1 213.1 226.1 211.6Q229.0 210.0 232.2 210.0Q233.8 210.0 235.1 210.2Q236.4 210.4 237.1 210.9V222.8H233.9Q227.4 222.8 223.9 224.9Q220.4 226.9 219.0 231.3Z M262.0 261.0Q254.7 261.0 249.2 257.9Q243.7 254.7 240.7 249.0Q237.7 243.3 237.7 235.6Q237.7 228.0 240.7 222.2Q243.7 216.5 249.2 213.2Q254.7 210.0 262.0 210.0Q269.4 210.0 274.9 213.3Q280.3 216.6 283.3 222.3Q286.3 228.1 286.3 235.5Q286.3 236.6 286.3 237.6Q286.2 238.7 286.0 239.4H248.4V229.6H276.1L274.1 234.3Q274.1 228.1 271.2 224.2Q268.2 220.3 262.0 220.3Q256.6 220.3 253.3 223.7Q250.0 227.0 250.0 232.6V237.9Q250.0 243.8 253.4 247.2Q256.7 250.5 262.5 250.5Q267.6 250.5 270.5 248.4Q273.4 246.3 275.5 243.2L284.6 248.4Q281.3 254.5 275.7 257.8Q270.0 261.0 262.0 261.0Z M319.1 261.2Q312.7 261.2 307.9 258.0Q303.0 254.8 300.3 249.1Q297.6 243.3 297.6 235.5Q297.6 227.4 300.3 221.7Q302.9 216.0 307.7 213.0Q312.5 210.0 319.0 210.0Q325.7 210.0 330.8 213.2Q335.9 216.4 338.8 222.2Q341.6 227.9 341.6 235.5Q341.6 243.0 338.8 248.8Q335.9 254.6 330.9 257.9Q325.8 261.2 319.1 261.2ZM292.8 260.0V191.9H305.9V223.9H304.9V248.4H305.9L302.6 260.0ZM316.8 249.1Q321.8 249.1 325.1 245.3Q328.3 241.5 328.3 235.5Q328.3 229.5 325.1 225.8Q321.8 222.0 316.8 222.0Q311.8 222.0 308.5 225.8Q305.2 229.5 305.2 235.6Q305.2 241.6 308.5 245.3Q311.8 249.1 316.8 249.1Z M369.8 261.2Q362.2 261.2 356.5 257.9Q350.7 254.7 347.5 248.9Q344.3 243.2 344.3 235.6Q344.3 228.0 347.5 222.2Q350.7 216.5 356.5 213.2Q362.2 210.0 369.8 210.0Q377.4 210.0 383.2 213.2Q388.9 216.5 392.1 222.2Q395.3 228.0 395.3 235.6Q395.3 243.2 392.1 248.9Q388.9 254.7 383.2 257.9Q377.4 261.2 369.8 261.2ZM369.8 248.5Q375.2 248.5 378.6 244.9Q382.0 241.3 382.0 235.6Q382.0 229.8 378.6 226.2Q375.2 222.6 369.8 222.6Q364.4 222.6 361.1 226.1Q357.7 229.7 357.7 235.5Q357.7 241.3 361.1 244.9Q364.4 248.5 369.8 248.5Z M421.1 260.9Q413.6 260.9 409.3 256.9Q404.9 253.0 404.9 244.3V211.7L404.7 211.1L407.4 199.6H418.0V242.2Q418.0 245.4 419.6 246.9Q421.1 248.3 423.5 248.3Q425.1 248.3 426.4 248.1Q427.7 247.8 428.7 247.5V259.7Q427.1 260.3 425.3 260.6Q423.5 260.9 421.1 260.9ZM397.3 223.2V211.1H428.7V223.2Z" />
      </g>
    </svg>
  );
}
