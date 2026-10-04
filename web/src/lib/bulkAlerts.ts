/* Bulk actions of the Alertas list, without Firestore: which alerts stay on a person's list, what each action
   changed (to undo it) and what the owner reads afterwards. The writes are in alertActions.ts.
   «Limpiar lista» moves a mark in the person's own profile (users/{uid}.alertsCleared), for every dog or for the dog
   chosen in the filter: the alerts created until then leave their list and stay in the dog's history and in the vet
   view. The new ones among them are reviewed in the same write. */

export type BulkKind = "review" | "clear";

/** When the person cleared the list, in epoch ms: for every dog, and per dog. */
export interface ClearMarks { all: number | null; byDog: Record<string, number> }
export const NO_MARKS: ClearMarks = { all: null, byDog: {} };

/** How long «Deshacer» stays. firestore.rules lets whoever reviewed an alert make it new again for 10 minutes; the
 * button leaves a minute earlier, so a slow connection does not meet the limit. */
export const UNDO_MS = 9 * 60_000;

/** The mark that applies to a dog's alerts: the later of the two. */
export function clearedUntil(marks: ClearMarks, dogId: string): number | null {
  const all = marks.all, one = marks.byDog[dogId] ?? null;
  return all == null ? one : one == null ? all : Math.max(all, one);
}

/** Whether an alert is on the list: created after the mark of its dog. One without a creation time yet (still being
 * written) is new, so it stays. */
export function onList(alert: { dogId: string; createdAtMs: number | null }, marks: ClearMarks): boolean {
  const until = clearedUntil(marks, alert.dogId);
  return until == null || alert.createdAtMs == null || alert.createdAtMs > until;
}

/** What an action did, enough to undo it. */
export interface BulkChange {
  kind: BulkKind;
  /** New alerts it reviewed: «Deshacer» makes them new again. */
  reviewed: string[];
  /** «Limpiar lista»: the dog whose mark moved (null: every dog) and the value the mark had before. */
  mark?: { dogId: string | null; previous: number | null };
}

const num = (n: number) => n.toLocaleString("es-PE");

/** What the owner reads after an action. `dogName`: the dog the list was filtered by, if any. Where cleared alerts went
 * is said by the empty list below it («Lista limpia»), so the message stays short. */
export function bulkDoneText(change: BulkChange, dogName?: string | null): string {
  const k = change.reviewed.length;
  if (change.kind === "review") {
    const of = dogName ? ` de ${dogName}` : "";
    return k === 1 ? `La alerta nueva${of} quedó revisada.` : `Las ${num(k)} alertas nuevas${of} quedaron revisadas.`;
  }
  const reviewed = !k ? "" : k === 1 ? " La nueva quedó revisada." : ` Las ${num(k)} nuevas quedaron revisadas.`;
  return (dogName ? `Quitamos de la lista las alertas de ${dogName}.` : "Quitamos las alertas de la lista.") + reviewed;
}

/** What the owner reads after «Deshacer». */
export function bulkUndoneText(change: BulkChange): string {
  const k = change.reviewed.length;
  if (change.kind === "review") return k === 1 ? "La alerta volvió a quedar como nueva." : `Las ${num(k)} alertas volvieron a quedar como nuevas.`;
  return "Las alertas volvieron a la lista, como estaban.";
}
