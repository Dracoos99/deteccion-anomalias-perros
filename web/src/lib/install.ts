/**
 * The app on the home screen. Chromium browsers fire `beforeinstallprompt` when the app can be installed:
 * it is kept here, from the first script, so «Instalar la app» in Perfil can show the browser's own dialog later.
 * Safari on the iPhone has no such event: there the person adds it from Compartir, and only an installed app can
 * receive pushes (iOS 16.4 or later).
 */
import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = "installed" | "prompt" | "ios" | "unavailable";

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; notify(); });
  window.addEventListener("appinstalled", () => { deferred = null; installedNow = true; notify(); });
}

/** iPhone, iPad and iPod (an iPad reports itself as a Mac with touch). */
export function isIos(ua = navigator.userAgent, touch = navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch > 1);
}

/** Opened from the home screen (or as an installed app on a computer). */
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function installState(): InstallState {
  if (installedNow || isStandalone()) return "installed";
  if (deferred) return "prompt";
  return isIos() ? "ios" : "unavailable";
}

/** Shows the browser's install dialog; true when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome === "accepted";
}

export function useInstallState(): InstallState {
  const [state, setState] = useState<InstallState>(installState);
  useEffect(() => {
    const update = () => setState(installState());
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  return state;
}
