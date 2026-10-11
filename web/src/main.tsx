import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, storedTheme } from "./lib/theme";
// Listens for the browser's install offer from the first script, so Perfil can show it later.
import "./lib/install";
import "./styles/app.css";

// The appearance chosen in Perfil, before the first paint.
applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
