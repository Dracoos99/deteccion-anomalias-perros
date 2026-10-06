/* Live panel of the dog detail: the last minutes of a dog from its results. The heart rate goes as the
   engine's mean of the last 60 s at the end of each block over the values
   second by second (results.hrValues); the Health Score, one point per block; the time in movement, as the share of
   the last minute (with 2 s blocks the share of a single block is 0 or 100 %). Pure functions, no Firestore. */
import type { Behavior } from "@shared/types";

const LIVE_SPAN_MS = 10 * 60_000;
const LIVE_MAX_AGE_MS = 2 * 60_000;
const MOVEMENT_SPAN_MS = 60_000;
const BLOCK_MS = 10_000;   // results written before had 10 s blocks

export interface LivePoint { t: number; v: number }

/** What the panel needs from one result. */
export interface LiveBlock {
  blockStartMs: number;
  blockSeconds?: number | null;  // 2 or 10; absent in older results: 10
  createdMs: number | null;      // server time of the result: how fresh the data are
  hrValues: number[] | null;     // 1 Hz from blockStart
  hr: number | null;             // the engine's mean of the last 60 s at the end of the block
  activeFraction: number | null; // share of the block's 2 s windows with movement
  healthScore: number;
  behavior: Behavior | null;
}

export interface LiveSeries {
  hr: LivePoint[];         // second by second
  hrAvg: LivePoint[];      // mean of the last 60 s, at the last second of each block
  activity: LivePoint[];   // % of the last minute in movement, at the end of each block
  health: LivePoint[];
  latest: LiveBlock | null;
  lastHr: number | null;
  lastActivity: number | null;
}

/** Share of time in movement over the minute that ends with each block, weighting blocks by their length. */
function movementByMinute(blocks: LiveBlock[]): LivePoint[] {
  const out: LivePoint[] = [];
  for (const b of blocks) {
    if (b.activeFraction == null) continue;
    const end = b.blockStartMs + (b.blockSeconds ?? BLOCK_MS / 1000) * 1000;
    let moving = 0, total = 0;
    for (const x of blocks) {
      if (x.activeFraction == null || x.blockStartMs > b.blockStartMs || x.blockStartMs < end - MOVEMENT_SPAN_MS) continue;
      const secs = x.blockSeconds ?? BLOCK_MS / 1000;
      moving += x.activeFraction * secs;
      total += secs;
    }
    if (total > 0) out.push({ t: end, v: Math.round((100 * moving) / total) });
  }
  return out;
}

/** Series of the `spanMs` of data that end with the latest block (data time, as the trend charts). */
export function liveSeries(blocks: LiveBlock[], spanMs = LIVE_SPAN_MS): LiveSeries {
  const sorted = [...blocks].sort((a, b) => a.blockStartMs - b.blockStartMs);
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return { hr: [], hrAvg: [], activity: [], health: [], latest: null, lastHr: null, lastActivity: null };
  const recent = sorted.filter((b) => b.blockStartMs > latest.blockStartMs - spanMs);
  const hr: LivePoint[] = [], hrAvg: LivePoint[] = [];
  for (const b of recent) {
    b.hrValues?.forEach((v, i) => hr.push({ t: b.blockStartMs + i * 1000, v }));
    if (b.hr != null) hrAvg.push({ t: b.blockStartMs + ((b.blockSeconds ?? BLOCK_MS / 1000) - 1) * 1000, v: b.hr });
  }
  const activity = movementByMinute(recent);
  return {
    hr, hrAvg, activity, health: recent.map((b) => ({ t: b.blockStartMs, v: b.healthScore })), latest,
    // The mean the state and the alerts use; the latest second only while the first minute fills.
    lastHr: latest.hr ?? (latest.hrValues?.length ? latest.hrValues[latest.hrValues.length - 1] : null),
    lastActivity: activity.length ? activity[activity.length - 1].v : null,
  };
}

/** Data keep arriving: the latest result was written less than maxAgeMs ago (both in server time, roughly). */
export const isLive = (createdMs: number | null, now: number, maxAgeMs = LIVE_MAX_AGE_MS) =>
  createdMs != null && now - createdMs <= maxAgeMs;

/** The latest block is live: written recently and measured recently, so a CSV of yesterday loaded a minute ago is
 * not shown as "En vivo". Data time ahead of the clock (a
 * simulation faster than real time) counts as recent. */
export const isLiveBlock = (b: LiveBlock | null, now: number) =>
  !!b && isLive(b.createdMs, now) && b.blockStartMs + (b.blockSeconds ?? BLOCK_MS / 1000) * 1000 >= now - LIVE_MAX_AGE_MS;

// ── Freshness of a dog's state ─────────────────────────────────────────────────────────────────────────────

/** dogs.status written less than this ago, with data measured in the last LIVE_MAX_AGE_MS: "En vivo". */
const STATUS_LIVE_MS = 30_000;
/** Newest data older than this: the card stops presenting them as the dog's current state. A display rule, not a
 * scoring threshold. */
export const STALE_AFTER_MS = 30 * 60_000;

export type Freshness = "live" | "recent" | "stale";

/** When the dog's newest data were measured, but never later than when they arrived: a simulation faster than real
 * time writes data ahead of the clock. This is the time the owner is shown. */
export function shownDataMs(dataMs: number | null, receivedMs: number | null): number | null {
  if (dataMs == null) return receivedMs;
  return receivedMs == null ? dataMs : Math.min(dataMs, receivedMs);
}

/** How current a dog's state is: "live" while blocks keep arriving, "stale" when its newest data are older than
 * STALE_AFTER_MS (a sensor that stopped, a CSV of yesterday), "recent" in between. dataMs is status.lastBlockAt and
 * receivedMs status.updatedAt. */
export function freshness(dataMs: number | null, receivedMs: number | null, now: number): Freshness {
  const shown = shownDataMs(dataMs, receivedMs);
  if (shown == null) return "stale";
  if (receivedMs != null && now - receivedMs <= STATUS_LIVE_MS && now - (dataMs ?? receivedMs) <= LIVE_MAX_AGE_MS) return "live";
  return now - shown > STALE_AFTER_MS ? "stale" : "recent";
}
