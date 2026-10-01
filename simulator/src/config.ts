/**
 * Simulator settings. With a demo-* project (default) everything goes to the local emulators; a real project needs
 * GCLOUD_PROJECT plus Application Default Credentials, and credentials never live in the repository.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-perros-tesis";
export const USING_EMULATORS = PROJECT_ID.startsWith("demo-");
if (USING_EMULATORS) {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
}

/** Output of ml/src/export_sim.py. */
export const SIM_DATA_DIR = process.env.SIM_DATA_DIR || path.resolve(here, "../../ml/data/processed/sim");

export const BLOCK_SECONDS = 10;
export const BLOCK_SAMPLES = 1000;
/** Up to this speed each 10 s block goes out as 5 blocks of 2 s (one per window), so the app gets data every
 * 2 s of real time. Faster runs keep 10 s blocks: either way a dog gets at most one block per real second, the
 * sustained rate Firestore recommends per document (dogState, dogs, trends). */
export const SUB_BLOCK_MAX_SPEED = 2;
export const WINDOWS_PER_BLOCK = 5;
export const WINDOW_SECONDS = 2;
export const IMU_CHANNELS = 6;
export const MAX_DOGS_PER_RUN = 10;   //
export const SPEEDS = [1, 2, 5, 10];  // C13: options of screen 8; any value 1-10 is accepted
export const STATS_FLUSH_MS = 5000;
export const READING_TTL_DAYS = 7;    //: TTL on readings.expireAt
export const SCHEMA_VERSION = 1;

/** Deterministic id of a block: retries write the same document instead of a duplicate (RNF-02). `block` counts 2 s
 * windows from the start of the run: a 10 s block takes 5 numbers, a 2 s block one. */
export function readingId(runId: string, dogId: string, block: number): string {
  return `${runId}_${dogId}_${String(block).padStart(6, "0")}`;
}
