/** Load Telegram's SDK only for a Mini App launch; ordinary browsers stay standalone. */
import { createRoot } from "react-dom/client";

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
const { SettingsApp } = await import("./app.js");
const root = document.getElementById("root");
if (root === null) throw new Error("Wirebot root element is missing");
createRoot(root).render(<SettingsApp loginToken={loginToken} />);

// A sign-in link opened in an already-open tab can be a same-document navigation.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(window.location.hash.slice(1)).has("login")) window.location.reload();
});
