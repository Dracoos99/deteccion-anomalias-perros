import { useMemo } from "react";
import { SLOT_MS, collectSlots, dayKey, rebucket, slotStartMs, toPoint, type TimedSlot, type TrendPoint } from "@shared/trends";
import { useTrendDocs, type Dog, type Viewer } from "./hooks";

export type RangeKey = "1h" | "24h" | "7d";
export const RANGES: Record<RangeKey, { ms: number; bucketMs: number; label: string; text: string }> = {
  "1h": { ms: 3_600_000, bucketMs: SLOT_MS, label: "1 h", text: "la última hora" },
  "24h": { ms: 86_400_000, bucketMs: SLOT_MS, label: "24 h", text: "las últimas 24 h" },
  "7d": { ms: 7 * 86_400_000, bucketMs: 3_600_000, label: "7 días", text: "los últimos 7 días" },
};

export interface DogTrend {
  items: TimedSlot[];   // 5-minute slots in the window
  points: TrendPoint[]; // bucketed for the chart
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

/** Slots and chart points of [end - rangeMs, end], where end is the dog's latest data. */
export function useDogTrend(dog: Dog | null | undefined, viewer: Viewer, rangeMs: number, bucketMs = SLOT_MS): DogTrend {
  const anchor = dataAnchor(dog);
  const fromDay = anchor != null ? dayKey(anchor - rangeMs) : null;
  const { data: docs, loading, error } = useTrendDocs(dog?.id, viewer, fromDay);
  return useMemo(() => {
    if (anchor == null) return { items: [], points: [], start: null, end: null, loading: dog === undefined, error };
    // dogs.status is throttled, so the latest slot may be a little ahead of lastBlockAt.
    let latest = anchor;
    for (const d of docs) for (const k of Object.keys(d.slots ?? {})) latest = Math.max(latest, slotStartMs(d.day, Number(k)) + SLOT_MS);
    const end = latest, start = end - rangeMs;
    const items = collectSlots(docs, start, end);
    const points = (bucketMs > SLOT_MS ? rebucket(items, bucketMs) : items).map(toPoint);
    return { items, points, start, end, loading, error };
  }, [docs, anchor, rangeMs, bucketMs, loading, error, dog]);
}
