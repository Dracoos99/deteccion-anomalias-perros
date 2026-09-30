/**
 * Upload of a checked CSV: one csvUploads document and one readings document per 10 s block, with source
 * "csv" (the only blocks an owner may write, firestore.rules). The Function scores each block and counts it in the
 * upload. Blocks are written one after another, each once the previous one has been scored: the engine learns only
 * from blocks that arrive in time order (an earlier block after a later one is flagged out_of_order).
 */
import { Timestamp, collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { CsvCheck } from "./csv";

const READING_TTL_MS = 7 * 86_400_000;     //: readings expire after 7 days
const FIRST_BLOCK_WAIT_MS = 90_000;        // the first block may meet a cold start of the Function with the models
const BLOCK_WAIT_MS = 30_000;

export interface UploadProgress { uploadId: string; total: number; written: number; processed: number; waitedOut: number }

export async function uploadCsv(args: {
  dogId: string; ownerId: string; uid: string; fileName: string; check: CsvCheck;
  onProgress: (p: UploadProgress) => void; signal?: AbortSignal;
}): Promise<UploadProgress> {
  const { check } = args;
  const upRef = doc(collection(db, "csvUploads"));
  const total = check.blocks.length;
  await setDoc(upRef, {
    dogId: args.dogId, ownerId: args.ownerId, uploadedBy: args.uid, fileName: args.fileName.slice(0, 200),
    rows: check.rows, columns: check.header, status: "validated",
    errors: check.issues.slice(0, 50).map(({ row, column, message }) => ({ row, column, message })),
    warnings: check.warnings, blocksExpected: total, blocksProcessed: 0,
    firstBlockAt: Timestamp.fromMillis(check.blocks[0].startMs), lastBlockAt: Timestamp.fromMillis(check.blocks[total - 1].startMs),
    schemaVersion: 1, createdAt: serverTimestamp(),
  });

  const p: UploadProgress = { uploadId: upRef.id, total, written: 0, processed: 0, waitedOut: 0 };
  let wake: (() => void) | null = null;
  const unsub = onSnapshot(upRef, (snap) => {
    p.processed = snap.get("blocksProcessed") ?? 0;
    args.onProgress({ ...p });
    wake?.();
  });
  const waitProcessed = (n: number, ms: number) => new Promise<boolean>((resolve) => {
    if (p.processed >= n) return resolve(true);
    const timer = setTimeout(() => { wake = null; resolve(false); }, ms);
    wake = () => { if (p.processed >= n) { clearTimeout(timer); wake = null; resolve(true); } };
  });

  try {
    for (let k = 0; k < total; k++) {
      if (args.signal?.aborted) throw new DOMException("Carga cancelada", "AbortError");
      if (k > 0 && !(await waitProcessed(k, k === 1 ? FIRST_BLOCK_WAIT_MS : BLOCK_WAIT_MS))) p.waitedOut++;
      const b = check.blocks[k];
      await writeWithRetry(doc(db, "readings", `${upRef.id}_${String(k).padStart(6, "0")}`), {
        dogId: args.dogId, ownerId: args.ownerId, source: "csv", sourceRef: upRef.id,
        blockStart: Timestamp.fromMillis(b.startMs), imuHz: 100, imu: b.imu, hr: b.hr, temp: b.temp,
        processed: false, expireAt: Timestamp.fromMillis(Date.now() + READING_TTL_MS), schemaVersion: 1, createdAt: serverTimestamp(),
      });
      p.written = k + 1;
      args.onProgress({ ...p });
    }
    await waitProcessed(total, BLOCK_WAIT_MS);
    return { ...p };
  } finally {
    unsub();
  }
}

/** A block is created once: a retry after a lost acknowledgement finds it already there (an update is denied). */
async function writeWithRetry(ref: ReturnType<typeof doc>, data: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await setDoc(ref, data);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (attempt > 0 && code === "permission-denied") return;
      if (attempt >= 3 || code === "permission-denied" || code === "invalid-argument") throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
