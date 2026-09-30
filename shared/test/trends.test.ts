import { describe, expect, it } from "vitest";
import {
  addBlock, collectSlots, dayKey, daysBetween, emptySlot, mergeSlots, rebucket, slotIndex, slotStartMs, summarize, toPoint,
  type BlockSummary,
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
    expect(daysBetween(Date.parse("2026-09-29T23:00:00Z"), Date.parse("2026-09-30T01:00:00Z"))).toEqual(["2026-09-29", "2026-09-30"]);
  });
});
