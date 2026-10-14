import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyPalette, applyTheme, followOtherTabs, storedPalette, storedTheme } from "./lib/theme";
// Listens for the browser's install offer from the first script, so Perfil can show it later.
import "./lib/install";
import "./styles/app.css";

// The appearance and the style chosen in Perfil, before the first paint, and in step with other tabs.
applyTheme(storedTheme());
applyPalette(storedPalette());
followOtherTabs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
