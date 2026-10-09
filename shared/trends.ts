/**
 * Trend aggregates: 5-minute slots per dog and UTC day in trends/{dogId}_{YYYY-MM-DD}, for 7 days and the
 * vet view. adds two finer tiers in small documents, so a live chart never downloads a big one per block:
 * 10 s slots with the 1 Hz heart rate in 10-minute documents (trendsTenSec, the 1 h chart) and 1-minute slots in hour
 * documents (trendsMinute, the 24 h chart and alert episodes).
 * The Function adds each block to the current slots (write side); the web app merges slots into chart points and
 * period summaries (read side). Pure functions, shared by functions/ and web/.
 */
import { BEHAVIORS, type Behavior, type Level } from "./types";

export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60_000;
export const DAY_MS = 86_400_000;

/** Sums, minimums and maximums of the blocks of one slot, so slots can be merged into any coarser bucket. */
export interface TrendSlot {
  n: number;                    // blocks
  hsSum: number; hsMin: number; // Health Score of each block
  lv: [number, number, number]; // blocks per level: green, amber, red
  w: number; act: number; nov: number;  // windows, active windows, novel windows
  hrSum: number; hrN: number; hrMin: number | null; hrMax: number | null;  // 1 Hz heart-rate values
  tSum: number; tN: number; tMin: number | null; tMax: number | null;      // temperature per block
  beh: number[];                // windows per behavior, order of BEHAVIORS
  /** 10 s tier only: the 1 Hz heart-rate values of the slot, in time order. */
  hrv?: number[];
  /** The engine's moving share of time in movement (its 20-minute exponential average) after each 2 s window,
   * as sum and count. The dog's normal band refers to this average, not to the share of a single slot. Slots written
   * before do not have it (see withMovingShare). */
  aeSum?: number; aeN?: number;
}

/** Finer tiers, each in documents that span docMs and hold slotMs slots. */
export interface TrendTier { collection: "trendsTenSec" | "trendsMinute"; slotMs: number; docMs: number; hrValues: boolean }
export const TEN_SEC_TIER: TrendTier = { collection: "trendsTenSec", slotMs: 10_000, docMs: 600_000, hrValues: true };
export const MINUTE_TIER: TrendTier = { collection: "trendsMinute", slotMs: 60_000, docMs: 3_600_000, hrValues: false };

export interface TrendTierDoc<T = unknown> {
  dogId: string;
  ownerId: string;
  startMs: number;     // start of the span (for range queries)
  slotMs: number;
  slots: Record<string, TrendSlot>;
  schemaVersion: number;
  updatedAt: T;
  expireAt?: T;        // 10 s tier: removed by the TTL policy after 7 days, like readings
}

export const tierDocStart = (tier: TrendTier, ms: number) => Math.floor(ms / tier.docMs) * tier.docMs;
export const tierSlotIndex = (tier: TrendTier, ms: number) => Math.floor((ms - tierDocStart(tier, ms)) / tier.slotMs);
/** e.g. toby_2026-10-01T1350 (10 s tier) or toby_2026-10-01T13 (minute tier). */
export function tierDocId(tier: TrendTier, dogId: string, ms: number): string {
  const iso = new Date(tierDocStart(tier, ms)).toISOString();
  return `${dogId}_${tier.docMs < 3_600_000 ? iso.slice(0, 13) + iso.slice(14, 16) : iso.slice(0, 13)}`;
}

/** Slots of tier documents whose start is inside [fromMs, toMs), in time order. */
export function collectTierSlots(docs: Pick<TrendTierDoc, "startMs" | "slotMs" | "slots">[], fromMs: number, toMs: number): TimedSlot[] {
  const out: TimedSlot[] = [];
  for (const d of docs) {
    for (const [k, slot] of Object.entries(d.slots ?? {})) {
      const t = d.startMs + Number(k) * d.slotMs;
      if (t >= fromMs && t < toMs && slot.n > 0) out.push({ t, slot });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The 1 Hz heart rate of 10 s slots as points: value i of a slot is second i after its start. */
export function hrSeconds(items: TimedSlot[]): { t: number; v: number }[] {
  return items.flatMap(({ t, slot }) => (slot.hrv ?? []).map((v, i) => ({ t: t + i * 1000, v })));
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

/** What one block (2 to 10 s) contributes, taken from the engine evaluation. */
export interface BlockSummary {
  healthScore: number;
  level: Level;
  windows: number;
  active: number;
  novel: number;
  behaviors: (Behavior | null)[];
  hr: number[];
  temp: number | null;
  /** The engine's moving share of time in movement after each measured window. */
  activityAvg?: number[];
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
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** The moving-share sums of two slots, or nothing when neither has them (older slots stay as they were). */
function movingSums(a: Pick<TrendSlot, "aeSum" | "aeN">, sum: number, n: number): Pick<TrendSlot, "aeSum" | "aeN"> {
  return a.aeN || n ? { aeSum: r4((a.aeSum ?? 0) + sum), aeN: (a.aeN ?? 0) + n } : {};
}
const maxOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
const LEVEL_INDEX: Record<Level, 0 | 1 | 2> = { green: 0, amber: 1, red: 2 };

/** Adds one block to a slot (returns a new slot). keepHr: also keep the 1 Hz values. */
export function addBlock(slot: TrendSlot, b: BlockSummary, keepHr = false): TrendSlot {
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
    ...(keepHr ? { hrv: [...(slot.hrv ?? []), ...b.hr.map((v) => Math.round(v * 10) / 10)] } : {}),
    ...movingSums(slot, (b.activityAvg ?? []).reduce((a, v) => a + v, 0), b.activityAvg?.length ?? 0),
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
    ...movingSums(a, b.aeSum ?? 0, b.aeN ?? 0),
  };
}

// ── Read side ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TimedSlot { t: number; slot: TrendSlot }

/** Chart point: means per bucket (null when the bucket has no data for that signal) and its worst level. */
export interface TrendPoint {
  t: number;
  healthScore: number | null;
  activity: number | null;  // fraction of 2 s windows in movement
  /** Mean of the engine's moving share of time in movement, what the dog's normal band refers to. */
  activityAvg: number | null;
  hr: number | null;
  temp: number | null;
  level: Level | null;
  blocks: number;
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
    activityAvg: s.aeN ? s.aeSum! / s.aeN : null,
    hr: s.hrN ? s.hrSum / s.hrN : null,
    temp: s.tN ? s.tSum / s.tN : null,
  };
}

// ── Averages the dog's normal band refers to ─────────────────────────────────────────────────────

/** Weight of each 2 s window in an exponential average with this time constant, as in the engine. */
export const windowAlpha = (timeConstantS: number) => 1 - Math.exp(-2 / timeConstantS);

/** The engine's exponential average of a 0/1 signal per 2 s window, rebuilt from slots: `count` gives the windows of a
 * slot and how many of them were 1. Returns the mean of the average over each slot (null for a slot without windows).
 * It starts at `init`, as the engine starts at the dog's baseline; a slot with a `stored` value resets it to that. */
export function movingShare(items: TimedSlot[], count: (s: TrendSlot) => [hits: number, n: number], init: number | null, alpha: number,
  stored?: (s: TrendSlot) => number | null): (number | null)[] {
  let ema = init;
  return items.map(({ slot }) => {
    const known = stored?.(slot) ?? null;
    if (known != null) { ema = known; return known; }
    const [hits, n] = count(slot);
    if (!n) return null;
    const f = hits / n, before = ema ?? f, after = f + (before - f) * Math.pow(1 - alpha, n);
    ema = after;
    return (before + after) / 2;
  });
}

/** Slots with the engine's moving share of time in movement. Slots written before get it rebuilt from their
 * share of active windows (init: the dog's baseline mean; alpha: windowAlpha of config/fusion.activity). */
export function withMovingShare(items: TimedSlot[], init: number | null, alpha: number): TimedSlot[] {
  if (items.every((i) => i.slot.aeN || !i.slot.w)) return items;
  const v = movingShare(items, (s) => [s.act, s.w], init, alpha, (s) => (s.aeN ? s.aeSum! / s.aeN : null));
  return items.map((it, i) => (it.slot.aeN || v[i] == null ? it : { t: it.t, slot: { ...it.slot, aeSum: v[i]! * it.slot.w, aeN: it.slot.w } }));
}

/** Mean of each point with the points of the `windowMs` before it: the engine compares the mean of the last 60 s of
 * heart rate with the dog's band, never a single second. A point with fewer than `minCount` values in its window is
 * left out, as the engine leaves out a minute with less than half of its values. */
export function rollingMean(points: { t: number; v: number }[], windowMs: number, minCount = 1): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  let sum = 0, j = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].v;
    while (points[j].t <= points[i].t - windowMs) sum -= points[j++].v;
    if (i - j + 1 >= minCount) out.push({ t: points[i].t, v: sum / (i - j + 1) });
  }
  return out;
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
