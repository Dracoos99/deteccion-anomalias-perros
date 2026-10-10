import { describe, expect, it } from "vitest";
import { alertWindow, cohenKappa, controlWindows, kappaText, shuffledOrder } from "../src/lib/review";

describe("blind expert review", () => {
  it("computes Cohen's kappa between the system and the reviewer, leaving «unsure» out", () => {
    // 20 alerts (system yes): the reviewer agrees on 16; 20 controls (system no): agrees on 18.
    const items = [
      ...Array.from({ length: 16 }, () => ({ system: true, verdict: "relevant" as const })),
      ...Array.from({ length: 4 }, () => ({ system: true, verdict: "not_relevant" as const })),
      ...Array.from({ length: 2 }, () => ({ system: false, verdict: "relevant" as const })),
      ...Array.from({ length: 18 }, () => ({ system: false, verdict: "not_relevant" as const })),
      { system: true, verdict: "unsure" as const }, { system: false, verdict: null },
    ];
    const k = cohenKappa(items);
    expect(k.n).toBe(40);
    expect(k.unsure).toBe(1);
    expect(k.table).toEqual({ yy: 16, yn: 4, ny: 2, nn: 18 });
    expect(k.po).toBeCloseTo(0.85);
    expect(k.pe).toBeCloseTo(0.5);
    expect(k.kappa).toBeCloseTo(0.7);
    expect(kappaText(k.kappa)).toBe("Acuerdo sustancial");
    expect(cohenKappa([]).kappa).toBeNull();
  });

  it("shows an alert with margins and picks control stretches with data, far from any alert", () => {
    expect(alertWindow(1_000_000, 1_600_000, 100_000)).toEqual({ fromMs: 900_000, toMs: 1_700_000 });
    expect(alertWindow(1_000_000, null, 100_000)).toEqual({ fromMs: 900_000, toMs: 1_200_000 });
    const slot = 300_000;
    const slots = Array.from({ length: 96 }, (_, i) => i * slot);   // 8 h of data
    const episode = { fromMs: 40 * slot, toMs: 44 * slot };
    const w = controlWindows([{ dogId: "toby", slots, episodes: [episode] }], 10, { lengthMs: 8 * slot, clearMs: 6 * slot, seed: 3 });
    expect(w.length).toBeGreaterThan(0);
    for (const c of w) {
      expect(c.toMs - c.fromMs).toBe(8 * slot);
      expect(c.toMs <= episode.fromMs - 6 * slot || c.fromMs >= episode.toMs + 6 * slot).toBe(true);
    }
    // No two control stretches overlap, and the same seed gives the same queue.
    const starts = w.map((c) => c.fromMs).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(8 * slot);
    expect(controlWindows([{ dogId: "toby", slots, episodes: [episode] }], 10, { lengthMs: 8 * slot, clearMs: 6 * slot, seed: 3 })).toEqual(w);
    expect(shuffledOrder(5, 1).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("computes no kappa when the queue has one kind of stretch only, and sizes the controls like the alerts", () => {
    expect(cohenKappa([{ system: true, verdict: "relevant" }, { system: true, verdict: "not_relevant" }]).kappa).toBeNull();
    const slot = 300_000;
    const slots = Array.from({ length: 200 }, (_, i) => i * slot);
    const w = controlWindows([{ dogId: "luna", slots, episodes: [] }], 3, { lengthsMs: [9 * slot, 11 * slot], seed: 5 });
    expect(w.map((c) => c.toMs - c.fromMs)).toEqual([9 * slot, 11 * slot, 9 * slot]);
  });
});
