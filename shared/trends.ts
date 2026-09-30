/**
 * Trend aggregates: 5-minute slots per dog and UTC day in trends/{dogId}_{YYYY-MM-DD}.
 * The Function adds each block to the current slot (write side); the web app merges slots into chart points and
 * period summaries (read side). Pure functions, shared by functions/ and web/.
 */
import { BEHAVIORS, type Behavior, type Level } from "./types";

export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60_000;
export const DAY_MS = 86_400_000;
export const SLOTS_PER_DAY = DAY_MS / SLOT_MS;
/** A slot is written when a block falls into another slot, or after this many blocks (1 min of data). */
export const FLUSH_EVERY_BLOCKS = 6;

/** Sums, minimums and maximums of the blocks of one slot, so slots can be merged into any coarser bucket. */
export interface TrendSlot {
  n: number;                    // blocks
  hsSum: number; hsMin: number; // Health Score of each block
  lv: [number, number, number]; // blocks per level: green, amber, red
  w: number; act: number; nov: number;  // windows, active windows, novel windows
  hrSum: number; hrN: number; hrMin: number | null; hrMax: number | null;  // 1 Hz heart-rate values
  tSum: number; tN: number; tMin: number | null; tMax: number | null;      // temperature per block
  beh: number[];                // windows per behavior, order of BEHAVIORS
}

export interface TrendDayDoc<T = unknown> {
  dogId: string;
  ownerId: string;
  day: string;         // YYYY-MM-DD (UTC)
  slotMinutes: number;
  slots: Record<string, TrendSlot>;
  schemaVersion: number;
  updatedAt: T;
}

/** What one 10 s block contributes, taken from the engine evaluation. */
export interface BlockSummary {
  healthScore: number;
  level: Level;
  windows: number;
  active: number;
  novel: number;
  behaviors: (Behavior | null)[];
  hr: number[];
  temp: number | null;
}

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const slotIndex = (ms: number) => Math.floor((((ms % DAY_MS) + DAY_MS) % DAY_MS) / SLOT_MS);
export const trendDocId = (dogId: string, day: string) => `${dogId}_${day}`;
export const slotStartMs = (day: string, index: number) => Date.parse(`${day}T00:00:00Z`) + index * SLOT_MS;

export function emptySlot(): TrendSlot {
  return { n: 0, hsSum: 0, hsMin: 100, lv: [0, 0, 0], w: 0, act: 0, nov: 0, hrSum: 0, hrN: 0, hrMin: null, hrMax: null,
    tSum: 0, tN: 0, tMin: null, tMax: null, beh: BEHAVIORS.map(() => 0) };
}

const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
const LEVEL_INDEX: Record<Level, 0 | 1 | 2> = { green: 0, amber: 1, red: 2 };

/** Adds one block to a slot (returns a new slot). */
export function addBlock(slot: TrendSlot, b: BlockSummary): TrendSlot {
  const lv = [...slot.lv] as TrendSlot["lv"];
  lv[LEVEL_INDEX[b.level]] += 1;
  const beh = [...slot.beh];
  for (const x of b.behaviors) if (x) beh[BEHAVIORS.indexOf(x)] += 1;
  const hrMin = b.hr.length ? Math.min(...b.hr) : null, hrMax = b.hr.length ? Math.max(...b.hr) : null;
  return {
    n: slot.n + 1, hsSum: slot.hsSum + b.healthScore, hsMin: Math.min(slot.hsMin, b.healthScore), lv,
    w: slot.w + b.windows, act: slot.act + b.active, nov: slot.nov + b.novel,
    hrSum: slot.hrSum + b.hr.reduce((a, v) => a + v, 0), hrN: slot.hrN + b.hr.length,
    hrMin: minOf(slot.hrMin, hrMin), hrMax: maxOf(slot.hrMax, hrMax),
    tSum: slot.tSum + (b.temp ?? 0), tN: slot.tN + (b.temp == null ? 0 : 1),
    tMin: minOf(slot.tMin, b.temp), tMax: maxOf(slot.tMax, b.temp),
    beh,
  };
}

export function mergeSlots(a: TrendSlot, b: TrendSlot): TrendSlot {
  return {
    n: a.n + b.n, hsSum: a.hsSum + b.hsSum, hsMin: Math.min(a.hsMin, b.hsMin),
    lv: [a.lv[0] + b.lv[0], a.lv[1] + b.lv[1], a.lv[2] + b.lv[2]],
    w: a.w + b.w, act: a.act + b.act, nov: a.nov + b.nov,
    hrSum: a.hrSum + b.hrSum, hrN: a.hrN + b.hrN, hrMin: minOf(a.hrMin, b.hrMin), hrMax: maxOf(a.hrMax, b.hrMax),
    tSum: a.tSum + b.tSum, tN: a.tN + b.tN, tMin: minOf(a.tMin, b.tMin), tMax: maxOf(a.tMax, b.tMax),
    beh: a.beh.map((v, i) => v + (b.beh[i] ?? 0)),
  };
}

// ── Read side ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TimedSlot { t: number; slot: TrendSlot }

/** Chart point: means per bucket (null when the bucket has no data for that signal) and its worst level. */
export interface TrendPoint {
  t: number;
  healthScore: number | null;
  activity: number | null;  // fraction of 2 s windows in movement
  hr: number | null;
  temp: number | null;
  level: Level | null;
  blocks: number;
}

/** Day documents needed to cover [fromMs, toMs]. */
export function daysBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${dayKey(fromMs)}T00:00:00Z`); d <= toMs; d += DAY_MS) out.push(dayKey(d));
  return out;
}

/** Slots whose start is inside [fromMs, toMs), in time order. */
export function collectSlots(docs: Pick<TrendDayDoc, "day" | "slots">[], fromMs: number, toMs: number): TimedSlot[] {
  const out: TimedSlot[] = [];
  for (const d of docs) {
    for (const [k, slot] of Object.entries(d.slots ?? {})) {
      const t = slotStartMs(d.day, Number(k));
      if (t >= fromMs && t < toMs && slot.n > 0) out.push({ t, slot });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Merges slots into coarser buckets (e.g. hourly for 7 days). */
export function rebucket(items: TimedSlot[], bucketMs: number): TimedSlot[] {
  const byT = new Map<number, TrendSlot>();
  for (const { t, slot } of items) {
    const k = Math.floor(t / bucketMs) * bucketMs;
    byT.set(k, byT.has(k) ? mergeSlots(byT.get(k)!, slot) : slot);
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, slot]) => ({ t, slot }));
}

export function toPoint({ t, slot: s }: TimedSlot): TrendPoint {
  const level: Level | null = s.lv[2] ? "red" : s.lv[1] ? "amber" : s.n ? "green" : null;
  return {
    t, blocks: s.n, level,
    healthScore: s.n ? s.hsSum / s.n : null,
    activity: s.w ? s.act / s.w : null,
    hr: s.hrN ? s.hrSum / s.hrN : null,
    temp: s.tN ? s.tSum / s.tN : null,
  };
}

export interface Range { min: number; max: number; mean: number }
export interface PeriodSummary {
  blocks: number;
  healthScore: { mean: number; min: number } | null;
  activity: number | null;
  hr: Range | null;
  temp: Range | null;
  behaviors: { behavior: Behavior; share: number }[];  // share of classified windows, largest first
  levels: { green: number; amber: number; red: number };  // share of blocks
}

/** Minimum, maximum and mean of each signal over a period (Vista para el veterinario). */
export function summarize(items: TimedSlot[]): PeriodSummary {
  const s = items.reduce((acc, it) => mergeSlots(acc, it.slot), emptySlot());
  const totalBeh = s.beh.reduce((a, v) => a + v, 0);
  return {
    blocks: s.n,
    healthScore: s.n ? { mean: s.hsSum / s.n, min: s.hsMin } : null,
    activity: s.w ? s.act / s.w : null,
    hr: s.hrN && s.hrMin != null && s.hrMax != null ? { min: s.hrMin, max: s.hrMax, mean: s.hrSum / s.hrN } : null,
    temp: s.tN && s.tMin != null && s.tMax != null ? { min: s.tMin, max: s.tMax, mean: s.tSum / s.tN } : null,
    behaviors: totalBeh
      ? BEHAVIORS.map((behavior, i) => ({ behavior, share: s.beh[i] / totalBeh })).filter((x) => x.share > 0).sort((a, b) => b.share - a.share)
      : [],
    levels: s.n ? { green: s.lv[0] / s.n, amber: s.lv[1] / s.n, red: s.lv[2] / s.n } : { green: 0, amber: 0, red: 0 },
  };
}
