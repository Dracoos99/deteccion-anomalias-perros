import { describe, expect, it } from "vitest";
import { isLive, liveSeries, type LiveBlock } from "../src/lib/live";

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const block = (k: number, over: Partial<LiveBlock> = {}): LiveBlock => ({
  blockStartMs: T0 + k * 10_000, createdMs: T0 + k * 10_000 + 10_500, hrValues: [100 + k, 101 + k], hr: 100,
  activeFraction: 0.4, healthScore: 90 - k, behavior: "walk", ...over,
});

describe("live panel series", () => {
  it("puts the heart rate second by second and the other signals once per block, oldest first", () => {
    const s = liveSeries([block(1), block(0)]);
    expect(s.hr).toEqual([{ t: T0, v: 100 }, { t: T0 + 1000, v: 101 }, { t: T0 + 10_000, v: 101 }, { t: T0 + 11_000, v: 102 }]);
    expect(s.activity).toEqual([{ t: T0 + 10_000, v: 40 }, { t: T0 + 20_000, v: 40 }]);   // at the end of each block
    expect(s.health.map((p) => p.v)).toEqual([90, 89]);
    expect([s.latest?.blockStartMs, s.lastHr, s.lastActivity]).toEqual([T0 + 10_000, 102, 40]);
  });

  it("keeps only the last 10 minutes of data before the latest block", () => {
    const blocks = Array.from({ length: 70 }, (_, k) => block(k));
    const s = liveSeries(blocks);
    expect(s.health).toHaveLength(60);
    expect(s.health[0].t).toBe(T0 + 10 * 10_000);
  });

  it("shows movement as the share of the last minute, so 2 s blocks (0 or 100 % each) read as a share", () => {
    // 30 blocks of 2 s: moving in the first 15, still in the last 15.
    const blocks = Array.from({ length: 30 }, (_, k) => block(0, { blockStartMs: T0 + k * 2_000, blockSeconds: 2, activeFraction: k < 15 ? 1 : 0 }));
    const s = liveSeries(blocks);
    expect(s.activity[14].v).toBe(100);            // after 30 s of movement
    expect(s.lastActivity).toBe(50);              // the last minute: half moving, half still
    expect(s.activity.every((p) => p.v >= 50)).toBe(true);
  });

  it("falls back to the 60 s mean of older results and skips missing signals", () => {
    const s = liveSeries([block(0, { hrValues: null, hr: 96, activeFraction: null })]);
    expect(s.hr).toEqual([{ t: T0 + 9_000, v: 96 }]);
    expect([s.activity, s.lastHr, s.lastActivity]).toEqual([[], 96, null]);
    expect(liveSeries([])).toMatchObject({ latest: null, hr: [] });
  });

  it("is live while the latest result is less than 2 minutes old", () => {
    expect(isLive(T0, T0 + 119_000)).toBe(true);
    expect(isLive(T0, T0 + 121_000)).toBe(false);
    expect(isLive(null, T0)).toBe(false);
  });
});
