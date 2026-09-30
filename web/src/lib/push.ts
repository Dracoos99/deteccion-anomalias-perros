/**
 * Browser notifications with Firebase Cloud Messaging. Turning them on asks the browser for permission,
 * registers the service worker (public/firebase-messaging-sw.js), gets this browser's token and adds it to
 * users/{uid}.fcmTokens; the Function pushes new alerts to those tokens. Turning them off deletes the token.
 * FCM needs the project's Web Push certificate (VITE_FIREBASE_VAPID_KEY) and does not work with the emulators.
 */
import { arrayRemove, arrayUnion, doc, updateDoc } from "firebase/firestore";
import { deleteToken, getMessaging, getToken, isSupported } from "firebase/messaging";
import { app, db, usingEmulators } from "../firebase";

const env = import.meta.env;
const VAPID_KEY = env.VITE_FIREBASE_VAPID_KEY as string | undefined;
const TOKEN_KEY = "push-token";
const SW_SCOPE = "/firebase-cloud-messaging-push-scope";

export type PushSupport = "ok" | "emulator" | "unconfigured" | "unsupported";

export async function pushSupport(): Promise<PushSupport> {
  if (usingEmulators) return "emulator";
  if (!VAPID_KEY || !app.options.messagingSenderId) return "unconfigured";
  return (await isSupported().catch(() => false)) && "Notification" in window && "serviceWorker" in navigator ? "ok" : "unsupported";
}

export const permission = (): NotificationPermission => ("Notification" in window ? Notification.permission : "denied");

function storedToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** True when this browser already sent its token to the profile. */
export const pushOnHere = (tokens: string[] | undefined): boolean => {
  const t = storedToken();
  return !!t && !!tokens?.includes(t) && permission() === "granted";
};

async function registration(): Promise<ServiceWorkerRegistration> {
  const o = app.options;
  const q = new URLSearchParams({ apiKey: o.apiKey ?? "", projectId: o.projectId ?? "", messagingSenderId: o.messagingSenderId ?? "", appId: o.appId ?? "" });
  return navigator.serviceWorker.register(`/firebase-messaging-sw.js?${q}`, { scope: SW_SCOPE });
}

export async function enablePush(uid: string): Promise<"granted" | "denied"> {
  if (permission() !== "granted" && (await Notification.requestPermission()) !== "granted") return "denied";
  const token = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: await registration() });
  await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: the token still works for this session */ }
  return "granted";
}

export async function disablePush(uid: string): Promise<void> {
  const token = storedToken();
  if (token) await updateDoc(doc(db, "users", uid), { fcmTokens: arrayRemove(token) });
  await deleteToken(getMessaging(app)).catch(() => undefined);
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}
