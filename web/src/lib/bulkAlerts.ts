/* The bulk action of Alertas, without Firestore: «Marcar todas como revisadas», what it changed (to undo it)
   and what the owner reads afterwards. The writes are in alertActions.ts. retired «Limpiar lista»: the
   «Historial» tab keeps every alert, so nothing is taken off a list any more. */

/** How long «Deshacer» stays. firestore.rules lets whoever reviewed an alert make it new again for 10 minutes; the
 * button leaves a minute earlier, so a slow connection does not meet the limit. */
export const UNDO_MS = 9 * 60_000;

/** What the action did, enough to undo it: the new alerts it reviewed («Deshacer» makes them new again). */
export interface BulkChange {
  kind: "review";
  reviewed: string[];
}

const num = (n: number) => n.toLocaleString("es-PE");

/** What the owner reads after the action. `dogName`: the dog the list was filtered by, if any. */
export function bulkDoneText(change: BulkChange, dogName?: string | null): string {
  const k = change.reviewed.length;
  const of = dogName ? ` de ${dogName}` : "";
  return k === 1 ? `La alerta nueva${of} quedó revisada.` : `Las ${num(k)} alertas nuevas${of} quedaron revisadas.`;
}

/** The last bulk action, kept in sessionStorage while its «Deshacer» lasts, so it survives
 * leaving Alertas and coming back (the person who marked everything by mistake often notices it on Inicio). */
export interface StoredBulk { change: BulkChange; text: string; at: number }

/** The sessionStorage key of a person's last bulk action. */
export const bulkStorageKey = (uid: string) => `alerts-bulk:${uid}`;

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");

/** The stored action back, if it is well formed, it changed something and its «Deshacer» has not expired; else null
 * (the caller then clears the key). One stored by the retired «Limpiar lista» is not brought back. */
export function restoreBulk(raw: string | null, now: number): StoredBulk | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const { change, text, at } = v as Partial<StoredBulk>;
  if (typeof at !== "number" || typeof text !== "string" || !change || change.kind !== "review") return null;
  if (!isStringArray(change.reviewed) || !change.reviewed.length) return null;
  if (now - at >= UNDO_MS || at - now > 60_000) return null;
  return { change: { kind: "review", reviewed: change.reviewed }, text, at };
}

/** What the owner reads after «Deshacer». */
export function bulkUndoneText(change: BulkChange): string {
  const k = change.reviewed.length;
  return k === 1 ? "La alerta volvió a quedar como nueva." : `Las ${num(k)} alertas volvieron a quedar como nuevas.`;
}
