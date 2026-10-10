/**
 * Appearance: automatic (the system's light or dark mode), light or dark, chosen in Perfil and kept in this
 * browser. The stylesheet reads:root[data-theme]: «light» and «dark» force a theme, and without it
 * (prefers-color-scheme) the system decides.
 */
export type Theme = "auto" | "light" | "dark";
const KEY = "appearance";

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Applies a theme to the page (and keeps it): «auto» removes the attribute so the system decides. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, theme);
  } catch { /* not stored: it lasts this visit */ }
}
