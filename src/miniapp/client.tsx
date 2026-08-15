/** Mini App browser entry: mounts the app shell into the page root. */
import { createRoot } from "react-dom/client";
import { SettingsApp } from "./app.js";

const root = document.getElementById("root");
if (root === null) throw new Error("Mini App root element is missing");
createRoot(root).render(<SettingsApp />);
