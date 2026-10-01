/* Live panel of the dog detail: the last minutes of a dog from its results. The heart rate goes second by
   second (results.hrValues); movement and the Health Score, one point per block (2 or 10 s). Pure functions, no Firestore. */
import type { Behavior } from "@shared/types";

export const LIVE_SPAN_MS = 10 * 60_000;
export const LIVE_MAX_AGE_MS = 2 * 60_000;
const BLOCK_MS = 10_000;   // results written before had 10 s blocks

export interface LivePoint { t: number; v: number }

/** What the panel needs from one result. */
export interface LiveBlock {
  blockStartMs: number;
  createdMs: number | null;      // server time of the result: how fresh the data are
  hrValues: number[] | null;     // 1 Hz from blockStart
  hr: number | null;             // mean of the last 60 s, the fallback for those older results
  activeFraction: number | null; // share of the block's 2 s windows with movement
  healthScore: number;
  behavior: Behavior | null;
}

export interface LiveSeries {
  hr: LivePoint[];
  activity: LivePoint[];   // %
  health: LivePoint[];
  latest: LiveBlock | null;
  lastHr: number | null;
  lastActivity: number | null;
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
  const activity = recent.filter((b) => b.activeFraction != null).map((b) => ({ t: b.blockStartMs, v: Math.round(100 * b.activeFraction!) }));
  return {
    hr, activity, health: recent.map((b) => ({ t: b.blockStartMs, v: b.healthScore })), latest,
    lastHr: latest.hrValues?.length ? latest.hrValues[latest.hrValues.length - 1] : latest.hr,
    lastActivity: latest.activeFraction != null ? Math.round(100 * latest.activeFraction) : null,
  };
}

/** Data keep arriving: the latest result was written less than maxAgeMs ago (both in server time, roughly). */
export const isLive = (createdMs: number | null, now: number, maxAgeMs = LIVE_MAX_AGE_MS) =>
  createdMs != null && now - createdMs <= maxAgeMs;
