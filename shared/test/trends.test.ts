import { describe, expect, it } from "vitest";
import {
  addBlock, collectSlots, dayKey, emptySlot, mergeSlots, movingShare, rebucket, rollingMean, slotIndex, slotStartMs, summarize,
  toPoint, windowAlpha, withMovingShare, type BlockSummary, type TimedSlot,
} from "../trends";

const block = (over: Partial<BlockSummary> = {}): BlockSummary => ({
  healthScore: 90, level: "green", windows: 5, active: 2, novel: 0, behaviors: ["walk", "walk", "sit", "sit", "sit"],
  hr: [70, 72, 74], temp: 38.6, ...over,
});

describe("trend slots", () => {
  it("keys blocks by UTC day and 5-minute slot", () => {
    const t = Date.parse("2026-09-29T14:37:40Z");
    expect(dayKey(t)).toBe("2026-09-29");
    expect(slotIndex(t)).toBe((14 * 60 + 35) / 5);
    expect(slotStartMs("2026-09-29", slotIndex(t))).toBe(Date.parse("2026-09-29T14:35:00Z"));
  });

  it("adds blocks as sums, minimums and maximums", () => {
    const s = addBlock(addBlock(emptySlot(), block()), block({ healthScore: 55, level: "red", hr: [90], temp: 40.1, active: 5 }));
    expect(s).toMatchObject({ n: 2, hsSum: 145, hsMin: 55, lv: [1, 0, 1], w: 10, act: 7, hrN: 4, hrMin: 70, hrMax: 90, tN: 2, tMax: 40.1 });
    expect(s.beh).toEqual([6, 0, 0, 0, 4, 0, 0]);
  });

  it("merges slots and summarizes a period", () => {
    const a = addBlock(emptySlot(), block());
    const b = addBlock(emptySlot(), block({ hr: [60], temp: null, healthScore: 70, level: "amber" }));
    expect(mergeSlots(a, b)).toMatchObject({ n: 2, hrMin: 60, hrMax: 74, tN: 1 });
    const sum = summarize([{ t: 0, slot: a }, { t: 1, slot: b }]);
    expect(sum.hr).toEqual({ min: 60, max: 74, mean: (70 + 72 + 74 + 60) / 4 });
    expect(sum.temp).toEqual({ min: 38.6, max: 38.6, mean: 38.6 });
    expect(sum.activity).toBeCloseTo(0.4);
    expect(sum.behaviors[0]).toEqual({ behavior: "sit", share: 0.6 });
    expect(sum.levels).toEqual({ green: 0.5, amber: 0.5, red: 0 });
  });

  it("turns day documents into time-ordered points and coarser buckets", () => {
    const slot = addBlock(emptySlot(), block());
    const docs = [{ day: "2026-09-29", slots: { "287": slot, "0": slot } }, { day: "2026-09-30", slots: { "0": slot } }];
    const from = Date.parse("2026-09-29T00:00:00Z"), to = Date.parse("2026-09-30T00:05:00Z");
    const items = collectSlots(docs, from, to);
    expect(items.map((i) => new Date(i.t).toISOString())).toEqual(["2026-09-29T00:00:00.000Z", "2026-09-29T23:55:00.000Z", "2026-09-30T00:00:00.000Z"]);
    expect(rebucket(items, 86_400_000).map((i) => i.slot.n)).toEqual([2, 1]);
    expect(toPoint(items[0])).toMatchObject({ healthScore: 90, activity: 0.4, hr: 72, temp: 38.6, level: "green", blocks: 1 });
  });
});

describe("averages the dog's normal band refers to", () => {
  it("keeps the engine's moving share of time in movement in the slots", () => {
    const a = addBlock(addBlock(emptySlot(), block({ activityAvg: [0.5, 0.52] })), block({ activityAvg: [0.54] }));
    expect(a).toMatchObject({ aeSum: 1.56, aeN: 3 });
    expect(toPoint({ t: 0, slot: a }).activityAvg).toBeCloseTo(0.52);
    expect(mergeSlots(a, addBlock(emptySlot(), block({ activityAvg: [0.4] })))).toMatchObject({ aeSum: 1.96, aeN: 4 });
    // Slots written before keep no such fields, and their points have no average.
    const old = addBlock(emptySlot(), block());
    expect("aeN" in old).toBe(false);
    expect(toPoint({ t: 0, slot: old }).activityAvg).toBeNull();
  });

  it("rebuilds it for older slots, from the baseline mean, and goes on from stored values", () => {
    const alpha = windowAlpha(1200);
    const still = (t: number): TimedSlot => ({ t, slot: addBlock(emptySlot(), block({ windows: 30, active: 0 })) });
    // One hour of a still dog in 1-minute slots: the average falls from the baseline (0.5) like the engine's, about
    // 95 % of the way to 0 after three time constants, never at once.
    const items = withMovingShare(Array.from({ length: 60 }, (_, i) => still(i * 60_000)), 0.5, alpha);
    const v = items.map((i) => toPoint(i).activityAvg!);
    expect(v[0]).toBeGreaterThan(0.48);
    expect(v.every((x, i) => i === 0 || x < v[i - 1])).toBe(true);
    expect(v[59]).toBeCloseTo(0.5 * Math.exp(-3600 / 1200), 1);
    // A stored value resets the rebuilt one.
    const mixed = withMovingShare([still(0), { t: 60_000, slot: addBlock(emptySlot(), block({ activityAvg: [0.8] })) }, still(120_000)], 0.5, alpha);
    expect(toPoint(mixed[1]).activityAvg).toBe(0.8);
    expect(toPoint(mixed[2]).activityAvg).toBeGreaterThan(0.75);
    // The same rule for any 0/1 signal, e.g. unusual movements starting at their expected rate.
    expect(movingShare([still(0)], (s) => [s.nov, s.w], 0.05, windowAlpha(300))[0]).toBeLessThan(0.05);
  });

  it("averages the heart rate over the last 60 s at each second, with at least half of them", () => {
    const hr = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, v: i < 60 ? 70 : 130 }));
    const avg = rollingMean(hr, 60_000, 30);
    expect(avg[0]).toEqual({ t: 29_000, v: 70 });   // from the 30th second
    expect(avg.find((p) => p.t === 59_000)?.v).toBe(70);
    expect(avg.find((p) => p.t === 89_000)?.v).toBe(100);
    expect(avg[avg.length - 1].v).toBe(130);
    // A 1 Hz spike moves the mean by 1/31 of its size in the first half minute (1/60 once the minute is full).
    const spike = rollingMean(hr.map((p) => (p.t === 30_000 ? { ...p, v: 190 } : p)), 60_000, 30);
    expect(spike.find((p) => p.t === 30_000)!.v).toBeCloseTo(70 + 120 / 31);
  });
});
