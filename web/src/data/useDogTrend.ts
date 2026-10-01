import { useMemo } from "react";
import {
  MINUTE_TIER, SLOT_MS, TEN_SEC_TIER, collectSlots, collectTierSlots, dayKey, hrSeconds, rebucket, slotStartMs, tierDocStart, toPoint,
  type TimedSlot, type TrendPoint, type TrendTier,
} from "@shared/trends";
import { useTierDocs, useTrendDocs, type Dog, type Viewer } from "./hooks";

export type RangeKey = "1h" | "24h" | "7d";
/** 1 h from 10 s slots (and the 1 Hz heart rate), 24 h from 1-minute slots, 7 days from the 5-minute ones. */
export const RANGES: Record<RangeKey, { ms: number; bucketMs: number; label: string; text: string; tier: TrendTier | null }> = {
  "1h": { ms: 3_600_000, bucketMs: TEN_SEC_TIER.slotMs, label: "1 h", text: "la última hora", tier: TEN_SEC_TIER },
  "24h": { ms: 86_400_000, bucketMs: MINUTE_TIER.slotMs, label: "24 h", text: "las últimas 24 h", tier: MINUTE_TIER },
  "7d": { ms: 7 * 86_400_000, bucketMs: 3_600_000, label: "7 días", text: "los últimos 7 días", tier: null },
};

export interface DogTrend {
  items: TimedSlot[];   // slots in the window
  points: TrendPoint[]; // bucketed for the chart
  /** 1 Hz heart rate. */
  hr: { t: number; v: number }[] | null;
  start: number | null;
  end: number | null;
  loading: boolean;
  error: string | null;
}

/** The dog's own data time: the latest block processed, not the wall clock. */
export function dataAnchor(dog: Dog | null | undefined): number | null {
  const s = dog?.status;
  return s?.lastBlockAt?.toMillis?.() ?? s?.updatedAt?.toMillis?.() ?? null;
}

/** Slots and chart points of [end - rangeMs, end], where end is the dog's latest data. Without a tier: 5-minute slots. */
export function useDogTrend(dog: Dog | null | undefined, viewer: Viewer, rangeMs: number, bucketMs = SLOT_MS, tier: TrendTier | null = null): DogTrend {
  const anchor = dataAnchor(dog);
  const fromDay = !tier && anchor != null ? dayKey(anchor - rangeMs) : null;
  const fromMs = tier && anchor != null ? tierDocStart(tier, anchor - rangeMs) : null;
  const day = useTrendDocs(tier ? undefined : dog?.id, viewer, fromDay);
  const fine = useTierDocs(tier, dog?.id, viewer, fromMs);
  return useMemo(() => {
    const loading = tier ? fine.loading : day.loading, error = tier ? fine.error : day.error;
    if (anchor == null) return { items: [], points: [], hr: null, start: null, end: null, loading: dog === undefined, error };
    // dogs.status may lag a block behind the slots, so the latest slot can be a little ahead of lastBlockAt.
    let latest = anchor;
    if (tier) {
      for (const d of fine.data) for (const k of Object.keys(d.slots ?? {})) latest = Math.max(latest, d.startMs + (Number(k) + 1) * d.slotMs);
    } else {
      for (const d of day.data) for (const k of Object.keys(d.slots ?? {})) latest = Math.max(latest, slotStartMs(d.day, Number(k)) + SLOT_MS);
    }
    const end = latest, start = end - rangeMs;
    const items = tier ? collectTierSlots(fine.data, start, end) : collectSlots(day.data, start, end);
    const slotMs = tier?.slotMs ?? SLOT_MS;
    const points = (bucketMs > slotMs ? rebucket(items, bucketMs) : items).map(toPoint);
    return { items, points, hr: tier?.hrValues ? hrSeconds(items) : null, start, end, loading, error };
  }, [day.data, day.loading, day.error, fine.data, fine.loading, fine.error, anchor, rangeMs, bucketMs, tier, dog]);
}
