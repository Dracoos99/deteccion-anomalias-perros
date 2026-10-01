/* Live panel of the dog detail: the last minutes of a dog from its results. The heart rate goes second by
   second (results.hrValues); the Health Score, one point per block; the time in movement, as the share of the last
   minute (with 2 s blocks the share of a single block is 0 or 100 %). Pure functions, no Firestore. */
import type { Behavior } from "@shared/types";

export const LIVE_SPAN_MS = 10 * 60_000;
export const LIVE_MAX_AGE_MS = 2 * 60_000;
export const MOVEMENT_SPAN_MS = 60_000;
const BLOCK_MS = 10_000;   // results written before had 10 s blocks

export interface LivePoint { t: number; v: number }

/** What the panel needs from one result. */
export interface LiveBlock {
  blockStartMs: number;
  blockSeconds?: number | null;  // 2 or 10; absent in older results: 10
  createdMs: number | null;      // server time of the result: how fresh the data are
  hrValues: number[] | null;     // 1 Hz from blockStart
  hr: number | null;             // mean of the last 60 s, the fallback for those older results
  activeFraction: number | null; // share of the block's 2 s windows with movement
  healthScore: number;
  behavior: Behavior | null;
}

export interface LiveSeries {
  hr: LivePoint[];
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
  if (!latest) return { hr: [], activity: [], health: [], latest: null, lastHr: null, lastActivity: null };
  const recent = sorted.filter((b) => b.blockStartMs > latest.blockStartMs - spanMs);
  const hr: LivePoint[] = [];
  for (const b of recent) {
    if (b.hrValues?.length) b.hrValues.forEach((v, i) => hr.push({ t: b.blockStartMs + i * 1000, v }));
    else if (b.hr != null) hr.push({ t: b.blockStartMs + BLOCK_MS - 1000, v: b.hr });
  }
  const activity = movementByMinute(recent);
  return {
    hr, activity, health: recent.map((b) => ({ t: b.blockStartMs, v: b.healthScore })), latest,
    lastHr: latest.hrValues?.length ? latest.hrValues[latest.hrValues.length - 1] : latest.hr,
    lastActivity: activity.length ? activity[activity.length - 1].v : null,
  };
}

/** Data keep arriving: the latest result was written less than maxAgeMs ago (both in server time, roughly). */
export const isLive = (createdMs: number | null, now: number, maxAgeMs = LIVE_MAX_AGE_MS) =>
  createdMs != null && now - createdMs <= maxAgeMs;
