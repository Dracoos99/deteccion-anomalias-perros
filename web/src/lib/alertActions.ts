/* Firestore side of the bulk actions of the Alertas list: find the new alerts an action covers, then write the
   action (or undo it) in batches: the reviews of those alerts and, for «Limpiar lista», the mark in the person's own
   profile. firestore.rules accepts a review only from the owner (or an admin) at the server time, lets the same person
   undo it for 10 minutes, and accepts the mark only in the person's own profile. */
import {
  FieldPath, Timestamp, collection, deleteField, doc, getDocs, query, serverTimestamp, where, writeBatch, type QueryConstraint,
} from "firebase/firestore";
import { db } from "../firebase";
import type { Viewer } from "../data/hooks";
import type { BulkChange } from "./bulkAlerts";

const BATCH_WRITES = 450;   // a Firestore batch takes at most 500 writes
/** How long a batch may wait for the server before the owner is told it will finish when the connection returns. */
const SAVE_WAIT_MS = 8000;

/** The new alerts an action covers: the viewer's (every one, for an admin), of one dog when the list is filtered. All of
 * them, not only the ones on screen. Equality filters only, so no composite index is needed. */
export async function newAlertIds(viewer: Viewer, dogId: string | null): Promise<string[]> {
  const filters: QueryConstraint[] = [where("status", "==", "open")];
  if (!viewer.isAdmin) filters.push(where("ownerId", "==", viewer.uid));
  if (dogId) filters.push(where("dogId", "==", dogId));
  const snap = await getDocs(query(collection(db, "alerts"), ...filters));
  return snap.docs.map((d) => d.id);
}

export interface Applied {
  /** What was written (or queued): the whole change, or the part before an error. */
  done: BulkChange;
  /** Offline: Firestore keeps the writes and sends them when the connection returns; the lists already show them. */
  pending: boolean;
  error: unknown;
}

/** Writes a bulk action, or undoes it. The mark goes in the last batch, so up to 449 new alerts it is all or nothing. */
export async function applyBulk(change: BulkChange, uid: string, undo = false): Promise<Applied> {
  const parts: string[][] = [];
  for (let i = 0; i < change.reviewed.length; i += BATCH_WRITES) parts.push(change.reviewed.slice(i, i + BATCH_WRITES));
  if (!parts.length) {
    if (!change.mark) return { done: change, pending: false, error: null };
    parts.push([]);
  }
  const review = undo
    ? { status: "open", acknowledgedBy: null, acknowledgedAt: null }
    : { status: "acknowledged", acknowledgedBy: uid, acknowledgedAt: serverTimestamp() };
  const commit = (part: string[], last: boolean) => {
    const batch = writeBatch(db);
    for (const id of part) batch.update(doc(db, "alerts", id), review);
    if (last && change.mark) {
      const { dogId, previous } = change.mark;
      const path = dogId ? new FieldPath("alertsCleared", "byDog", dogId) : new FieldPath("alertsCleared", "all");
      batch.update(doc(db, "users", uid), path, !undo ? serverTimestamp() : previous == null ? deleteField() : Timestamp.fromMillis(previous));
    }
    return batch.commit();
  };
  const reviewed: string[] = [];
  for (let p = 0; p < parts.length; p++) {
    const write = commit(parts[p], p === parts.length - 1);
    let sent: boolean;
    try {
      sent = await Promise.race([write.then(() => true), new Promise<false>((r) => window.setTimeout(() => r(false), SAVE_WAIT_MS))]);
    } catch (error) {
      return { done: { kind: change.kind, reviewed }, pending: false, error };
    }
    reviewed.push(...parts[p]);
    if (!sent) {
      // Firestore sends the queued batches in order once the connection returns.
      write.catch(() => undefined);
      for (let q = p + 1; q < parts.length; q++) commit(parts[q], q === parts.length - 1).catch(() => undefined);
      return { done: change, pending: true, error: null };
    }
  }
  return { done: change, pending: false, error: null };
}
