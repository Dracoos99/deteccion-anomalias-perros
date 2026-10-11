/**
 * «Descargar mis datos». Everything the account can read about itself,
 * in one JSON file: the profile, the dogs (archived ones too), their alerts, their uploads and their 5-minute and
 * 1-minute trends. Raw sensor blocks (`readings`, which expire), the per-block results and the 10-second tier stay
 * out: they are the sensor and model detail behind the trends, and a long history of them does not fit a download.
 * Built in the browser with the owner's own reads; nothing new on the server.
 */
import { collection, doc, getDoc, getDocs, query, where, type DocumentData } from "firebase/firestore";
import { db } from "../firebase";

/** The word «Borrar mi cuenta» and «Borrar sus datos» ask for; the deleteMyData function checks it too. */
export const CONFIRM_WORD = "BORRAR";

export const EXPORT_COLLECTIONS = ["alerts", "csvUploads", "trends", "trendsMinute"] as const;

/** Firestore values made plain JSON: timestamps as ISO 8601 (UTC), the rest as they are. */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const v = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof v.toDate === "function") return v.toDate().toISOString();
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  return value;
}

/** The profile without the browsers' notification tokens (technical identifiers): only how many there are. */
export function profileForExport(profile: DocumentData | null): Record<string, unknown> | null {
  if (!profile) return null;
  const { fcmTokens, ...rest } = profile;
  return { ...(plain(rest) as Record<string, unknown>), notificationBrowsers: Array.isArray(fcmTokens) ? fcmTokens.length : 0 };
}

export interface MyDataFile {
  exportedAt: string;
  note: string;
  account: Record<string, unknown> | null;
  dogs: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
  csvUploads: Record<string, unknown>[];
  trends: Record<string, unknown>[];
  trendsMinute: Record<string, unknown>[];
}

export const EXPORT_NOTE = "Datos de tu cuenta: tu perfil, tus perros, sus alertas, sus cargas de datos y sus tendencias de 5 minutos y de 1 minuto. No incluye los datos crudos de cada bloque del sensor ni el resultado del modelo para cada bloque. Las horas están en UTC.";

export async function collectMyData(uid: string, now = new Date()): Promise<MyDataFile> {
  const withId = (id: string, data: DocumentData) => ({ id, ...(plain(data) as Record<string, unknown>) });
  const byOwner = async (name: string) =>
    (await getDocs(query(collection(db, name), where("ownerId", "==", uid)))).docs.map((d) => withId(d.id, d.data()));
  const [profile, dogs, ...rest] = await Promise.all([
    getDoc(doc(db, "users", uid)),
    byOwner("dogs"),
    ...EXPORT_COLLECTIONS.map(byOwner),
  ]);
  const [alerts, csvUploads, trends, trendsMinute] = rest;
  return {
    exportedAt: now.toISOString(), note: EXPORT_NOTE,
    account: profileForExport(profile.exists() ? profile.data() : null),
    dogs, alerts, csvUploads, trends, trendsMinute,
  };
}

/** A local calendar date for the file name. */
export const exportFileName = (d = new Date()) =>
  `mis-datos-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;

export async function downloadMyData(uid: string): Promise<string> {
  const data = await collectMyData(uid);
  const name = exportFileName();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

const DELETED_KEY = "account-deleted";
/** «Borramos tu cuenta…» on the sign-in, right after the deletion (kept for this tab only). */
export function markAccountDeleted(): void { try { sessionStorage.setItem(DELETED_KEY, "1"); } catch { /* storage blocked: no notice */ } }
export function accountJustDeleted(): boolean { try { return sessionStorage.getItem(DELETED_KEY) === "1"; } catch { return false; } }
export function clearAccountDeleted(): void { try { sessionStorage.removeItem(DELETED_KEY); } catch { /* nothing stored */ } }
