/** Document startup: load the host SDK, establish a session, then mount the app. */
import { createRoot } from "react-dom/client";
import { Placeholder, Spinner } from "./ui.js";

const launch = new URLSearchParams(window.location.hash.slice(1));
const loginToken = launch.get("login");
// Remove the secret before loading any other code or making a network request.
if (loginToken !== null)
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
if (loginToken === null && launch.has("tgWebAppData")) {
  await new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.append(script);
  });
}
// These modules read Telegram's SDK at import time.
const { SettingsApp, SignIn } = await import("./app.js");
const { ConfigApiError, exchangeLogin, logoutBrowser, requestSession } = await import("./api.js");
const { webApp } = await import("./telegram.js");
const element = document.getElementById("root");
if (element === null) throw new Error("Wirebot root element is missing");
const root = createRoot(element);
element.className = `appRoot bg-background text-foreground ${webApp ? "telegramApp" : "browserApp"}`;

// Host listeners live for the document's lifetime, independently of React renders.
if (webApp !== undefined) {
  const app = webApp;
  const applyTheme = (): void => {
    element.dataset.appearance = app.colorScheme;
    element.style.colorScheme = app.colorScheme;
  };
  applyTheme();
  app.onEvent("themeChanged", applyTheme);
  app.ready();
  app.expand();
} else if (window.visualViewport !== null) {
  const viewport = window.visualViewport;
  const resize = (): void => {
    element.style.setProperty("--browser-viewport-height", `${viewport.height}px`);
    element.style.setProperty("--browser-viewport-top", `${viewport.offsetTop}px`);
  };
  resize();
  viewport.addEventListener("resize", resize);
  viewport.addEventListener("scroll", resize);
}

const showApp = (provider: string): void => {
  element.classList.add("authenticatedApp");
  root.render(<SettingsApp provider={provider} onSignOut={signOut} />);
};
const showSignIn = (error?: string): void => {
  element.classList.remove("authenticatedApp");
  root.render(<SignIn error={error} />);
};

async function signOut(): Promise<void> {
  await logoutBrowser();
  showSignIn();
}

window.addEventListener("wirebot:session-expired", () => {
  showSignIn("Your session ended. Request a fresh sign-in link from the bot.");
});
// A sign-in link opened in an already-open tab can be a same-document navigation.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(window.location.hash.slice(1)).has("login")) window.location.reload();
});

if (webApp !== undefined) {
  showApp("telegram");
} else {
  root.render(
    <div className="loadingRoot">
      <Placeholder header="Opening Wirebot">
        <Spinner size="l" />
      </Placeholder>
    </div>,
  );
  try {
    if (loginToken !== null) await exchangeLogin(loginToken);
    showApp((await requestSession()).provider);
  } catch (error) {
    const signedOut =
      loginToken === null && error instanceof ConfigApiError && error.status === 401;
    showSignIn(signedOut ? undefined : error instanceof Error ? error.message : "Sign-in failed.");
  }
}
