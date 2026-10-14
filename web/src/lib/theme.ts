/**
 * Appearance: automatic (the system's light or dark mode), light or dark, chosen in Perfil and kept in this
 * browser. The stylesheet reads:root[data-theme]: «light» and «dark» force a theme, and without it
 * (prefers-color-scheme) the system decides.
 *
 * Style: a personality on top of the light or dark scheme, independent of it. «sereno» is the app as it was
 * (no attribute); «calido» and «extravagante» set:root[data-palette]. It changes surfaces, the accent, the title font
 * and the decoration, never the levels, the alert texts, the figures, the focus ring or the vet view.
 */
import { useEffect, useSyncExternalStore } from "react";

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

export type Palette = "sereno" | "calido" | "extravagante";
export const PALETTES: readonly Palette[] = ["sereno", "calido", "extravagante"];
const PALETTE_KEY = "palette";
/** The ground of each style (light, dark), for the browser's bar (meta theme-color). */
const GROUND: Record<Palette, [string, string]> = {
  sereno: ["#f1f2f4", "#141519"],
  calido: ["#f8f3e6", "#18161a"],
  extravagante: ["#fff1d0", "#17140f"],
};

export const isPalette = (v: unknown): v is Palette => typeof v === "string" && (PALETTES as readonly string[]).includes(v);

export function storedPalette(): Palette {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return isPalette(v) ? v : "sereno";
  } catch {
    return "sereno";
  }
}

// The chosen style, and how many open pages ask for the serene look (the Vista para el veterinario, a document for a third
// party). Components follow it with usePalette.
let chosen: Palette = "sereno";
let serenePages = 0;
const listeners = new Set<() => void>();

function paint(): void {
  const shown: Palette = serenePages > 0 ? "sereno" : chosen;
  const root = document.documentElement;
  if (shown === "sereno") root.removeAttribute("data-palette");
  else root.setAttribute("data-palette", shown);
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m) => { m.content = GROUND[shown][m.media.includes("dark") ? 1 : 0]; });
}

/** Applies a style to the page and keeps it in this browser. */
export function applyPalette(palette: Palette): void {
  chosen = palette;
  try {
    if (palette === "sereno") localStorage.removeItem(PALETTE_KEY); else localStorage.setItem(PALETTE_KEY, palette);
  } catch { /* not stored: it lasts this visit */ }
  paint();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The style the person chose (also while a page shows the serene look). */
export function usePalette(): Palette {
  return useSyncExternalStore(subscribe, () => chosen, () => "sereno");
}

/** True with the eccentric style: a little humour is allowed in neutral moments (a page not found, an empty list), never
 * in a level, an alert, an error or the fixed notice. */
export const usePlayful = () => usePalette() === "extravagante";

/** The page keeps the serene look while it is open, whatever the chosen style (the Vista para el veterinario). */
export function useSerenePage(): void {
  useEffect(() => {
    serenePages += 1;
    paint();
    return () => { serenePages -= 1; paint(); };
  }, []);
}

/** Another tab changed the appearance or the style: follow it. */
export function followOtherTabs(): void {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyTheme(storedTheme());
    if (e.key === PALETTE_KEY) applyPalette(storedPalette());
  });
}
