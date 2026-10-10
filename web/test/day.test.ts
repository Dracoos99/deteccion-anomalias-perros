import { describe, expect, it } from "vitest";
import { BEHAVIORS } from "../../shared/types";
import { SLOT_MS, type TrendSlot } from "../../shared/trends";
import { activeHours, compare, dayPhrase, daySegments, dayTotals, groupCounts, groupShares, hourlyGrid, localDayStart, restingHr, weekPhrase } from "../src/lib/day";

// Windows per behavior in the order of BEHAVIORS.
const beh = (o: Partial<Record<(typeof BEHAVIORS)[number], number>>) => BEHAVIORS.map((b) => o[b] ?? 0);
const slot = (b: number[], hr: number | null = null): TrendSlot => ({
  n: 30, hsSum: 2700, hsMin: 90, lv: [30, 0, 0], w: 150, act: 0, nov: 0,
  hrSum: hr == null ? 0 : hr * 300, hrN: hr == null ? 0 : 300, hrMin: hr, hrMax: hr, tSum: 0, tN: 0, tMin: null, tMax: null, beh: b,
});

describe("a dog's day by behavior", () => {
  const day = localDayStart(Date.UTC(2026, 9, 9, 15));
  it("groups the quiet postures as rest and keeps the moving behaviors apart", () => {
    expect(groupCounts(beh({ sit: 10, stand: 5, lie: 30, play: 4 }))).toEqual({ rest: 45, walk: 0, trot: 0, play: 4, sniff: 0 });
  });

  it("gives each 5-minute slot its main behavior, how pure it is, and leaves out the slots of another day", () => {
    const segs = daySegments([
      { t: day - SLOT_MS, slot: slot(beh({ lie: 150 })) },
      { t: day, slot: slot(beh({ lie: 120, walk: 30 }), 60) },
      { t: day + SLOT_MS, slot: slot(beh({ play: 100, trot: 50 }), 110) },
      { t: day + 2 * SLOT_MS, slot: slot(beh({})) },
    ], day);
    expect(segs.map((s) => s.group)).toEqual(["rest", "play", null]);
    expect(segs[0].share).toBeCloseTo(0.8);
    expect(segs[0].hr).toBe(60);
    // The third has windows but no behavior (a dog still learning): data, not «descansando».
    const t = dayTotals(segs);
    expect(t.ms.rest).toBe(120 * 2000);
    expect(t.ms.play).toBe(100 * 2000);
    expect(t.dataMs).toBe(3 * SLOT_MS);
    expect(t.classifiedMs).toBe(300 * 2000);
    // Resting heart rate: only the slots spent resting.
    expect(restingHr(segs, 0.75)).toBe(60);
    expect(restingHr(segs, 0.9)).toBeNull();
  });

  it("compares a share with the usual days only with enough data, and reads small changes as «como de costumbre»", () => {
    expect(groupShares({ ms: { rest: 1_000_000, walk: 0, trot: 0, play: 0, sniff: 0 }, dataMs: 1_000_000, classifiedMs: 1_000_000 })).toBeNull();
    const shares = groupShares({ ms: { rest: 3_000_000, walk: 600_000, trot: 0, play: 0, sniff: 0 }, dataMs: 3_600_000, classifiedMs: 3_600_000 })!;
    expect(shares.walk).toBeCloseTo(1 / 6);
    const c = compare(0.04, [0.08, 0.07, null], 0.02)!;
    expect(c).toMatchObject({ days: 2, trend: "less" });
    expect(c.usual).toBeCloseTo(0.075);
    expect(compare(0.07, [0.08], 0.02)).toMatchObject({ trend: "same" });
    // Small groups: half a point is the floor, so play going from 3 % to 1 % of the day is a change, and rest from 89
    // to 92 % is not.
    expect(compare(0.01, [0.03], 0.005)).toMatchObject({ trend: "less" });
    expect(compare(0.92, [0.89], 0.005)).toMatchObject({ trend: "same" });
    expect(compare(0.07, [null, null], 0.02)).toEqual({ today: 0.07, usual: null, days: 0, trend: null });
    expect(compare(null, [0.08], 0.02)).toBeNull();
    // The resting heart rate: 5 lpm or 10 %.
    expect(compare(68, [60], 5, 0.1)).toMatchObject({ trend: "more" });
    expect(compare(63, [60], 5, 0.1)).toMatchObject({ trend: "same" });
  });

  it("says in plain words what moved, without judging", () => {
    const less = { today: 0.04, usual: 0.08, days: 3, trend: "less" as const };
    const more = { today: 0.9, usual: 0.6, days: 3, trend: "more" as const };
    const same = { today: 0.1, usual: 0.1, days: 3, trend: "same" as const };
    expect(dayPhrase("Toby", { play: less, rest: more, walk: same }, true)).toBe("Hoy Toby descansó más que de costumbre y jugó menos.");
    expect(dayPhrase("Luna", { play: same, rest: same }, false)).toBe("Ese día Luna repartió su tiempo como de costumbre.");
    expect(dayPhrase("Luna", { play: { today: 0.1, usual: null, days: 0, trend: null } }, true)).toBeNull();
    const all = dayPhrase("Toby", { play: less, rest: more }, true)!;
    expect(/enferm|diagnóstic|grave|urgente|peligro/i.test(all)).toBe(false);
  });
});

describe("the week", () => {
  const day = localDayStart(Date.UTC(2026, 9, 9, 15));
  const hour = (d: number, h: number) => day - d * 86_400_000 + h * 3_600_000;
  it("builds a day × hour grid of movement, with coverage, and finds the most active hours", () => {
    const slots = [
      { t: hour(0, 7), slot: { ...slot(beh({ walk: 150 })), act: 150 } },
      { t: hour(0, 7) + SLOT_MS, slot: { ...slot(beh({ lie: 150 })), act: 0 } },
      { t: hour(1, 19), slot: { ...slot(beh({ play: 150 })), act: 150 } },
    ];
    const grid = hourlyGrid(slots, hour(0, 12), 2);
    expect(grid).toHaveLength(2);
    expect(grid[1][7].moving).toBeCloseTo(0.5);
    expect(grid[1][7].coverage).toBeCloseTo(2 / 12);
    expect(grid[0][19].moving).toBe(1);
    expect(grid[0][3].moving).toBeNull();
    expect(activeHours(grid, 1)).toEqual([19]);
  });
  it("says the mean per day, the most active day and the trend of the last days, only with enough data", () => {
    const h = 3_600_000;
    const week = [6, 5, 4, 3, 2, 1, 0].map((d, i) => ({ dayStart: day - d * 86_400_000, movingMs: (i < 4 ? 120 : 40) * 60_000, dataMs: 10 * h }));
    const text = weekPhrase("Toby", week, () => "lunes", (ms) => `${Math.round(ms / 60_000)} min`)!;
    expect(text).toContain("se movió en promedio 86 min por día");
    expect(text).toContain("el día que más se movió fue el lunes (120 min)");
    expect(text).toContain("En los últimos 3 días se movió menos que en los anteriores.");
    expect(weekPhrase("Toby", week.map((d) => ({ ...d, dataMs: 0 })), () => "lunes", String)).toBeNull();
  });
});
