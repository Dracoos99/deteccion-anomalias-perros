import { describe, expect, it } from "vitest";
import { DogStream, hrBlocks } from "../../src/stream";
import { LatencyStats, percentile, summarize } from "../../src/stats";
import { readingId } from "../../src/config";
import { validateRunRequest } from "../../src/run";
import { computeBaseline } from "../../src/baseline";
import { schedule } from "../../../shared/anomalies";
import { DEFAULT_FUSION_CONFIG } from "../../../shared/types";

/** 2 500 samples (2.5 blocks) where sample i has every channel equal to i, so slices are easy to check. */
function ramp(samples = 2500): Float32Array {
  const a = new Float32Array(samples * 6);
  for (let i = 0; i < samples; i++) for (let c = 0; c < 6; c++) a[i * 6 + c] = i;
  return a;
}

describe("DogStream", () => {
  it("cuts 1 000-sample blocks, loops at the end and takes 10 HR values per block", () => {
    const s = new DogStream("toby", ramp(), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]);
    const b0 = s.block(0), b1 = s.block(1), b2 = s.block(2);
    expect(b0.imu).toHaveLength(6000);
    expect(b0.imu[0]).toBe(0);
    expect(b1.imu[0]).toBe(1000);
    expect(b2.imu[0]).toBe(2000);
    expect(b2.imu[500 * 6]).toBe(0);            // sample 2 500 wraps to 0
    expect(b0.hr).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
    expect(b1.hr.slice(0, 4)).toEqual([70, 71, 72, 60]);
    expect(b0.truth).toEqual([]);
  });

  it("is reproducible and keeps temperature as a process", () => {
    const a = new DogStream("luna", ramp(), [70]), b = new DogStream("luna", ramp(), [70]);
    const ta = [0, 1, 2, 3].map((k) => a.block(k).temp), tb = [0, 1, 2, 3].map((k) => b.block(k).temp);
    expect(ta).toEqual(tb);
    const c = new DogStream("luna", ramp(), [70]);
    expect(c.block(3).temp).toBe(ta[3]);         // skipping ahead advances the process the same way
    expect(() => c.block(1)).toThrow();          // going back is an error
  });

  it("applies scheduled injections to the right blocks and reports the ground truth", () => {
    const s = new DogStream("rocky", ramp(), Array(10).fill(80));
    s.injections.push(schedule("i1", "tachycardia", 0.5, 20, 1));
    expect(s.block(0).hr[0]).toBe(80);
    const b1 = s.block(1);
    expect(b1.truth).toEqual([{ type: "tachycardia", magnitude: 0.5, durationS: 20, injectionId: "i1", offsetS: 0 }]);
    expect(b1.hr[9]).toBeCloseTo(80 * (1 + 0.5 * (9 / 30)), 1);
    expect(s.block(2).truth[0].offsetS).toBe(10);
    expect(s.block(3).truth).toEqual([]);
  });

  it("ends a heart-rate block at every break of the series instead of joining the stretches", () => {
    const hr = Array.from({ length: 35 }, (_, i) => 60 + i);
    expect(hrBlocks(hr, [12, 30]).map((b) => b.length)).toEqual([10, 2, 10, 8, 5]);
    expect(hrBlocks(hr, [12, 30])[2][0]).toBe(72);
    expect(hrBlocks(Array(20).fill(70), []).map((b) => b.length)).toEqual([10, 9]);   // the loop back is a gap too
    const s = new DogStream("toby", ramp(), hr, { hrBreaks: [12, 30] });
    expect([0, 1, 2, 3, 4, 5].map((k) => s.block(k).hr.length)).toEqual([10, 2, 10, 8, 5, 10]);
  });

  it("rejects a subject shorter than one block", () => {
    expect(() => new DogStream("x", new Float32Array(600), [70])).toThrow();
  });
});

describe("helpers", () => {
  it("builds deterministic reading ids", () => {
    expect(readingId("run1", "toby", 7)).toBe("run1_toby_000007");
  });
  it("validates runs: 1-10 distinct dogs and speed 1-10", () => {
    expect(() => validateRunRequest([], 1)).toThrow();
    expect(() => validateRunRequest(Array.from({ length: 11 }, (_, i) => `d${i}`), 1)).toThrow();
    expect(() => validateRunRequest(["a", "a"], 1)).toThrow();
    expect(() => validateRunRequest(["a"], 11)).toThrow();
    expect(() => validateRunRequest(["a", "b"], 10)).not.toThrow();
  });
  it("summarizes latency with nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(summarize([100, 200, 300])).toEqual({ avgMs: 200, p50Ms: 200, p95Ms: 300, maxMs: 300 });
    const l = new LatencyStats(2);
    [10, 20, 30].forEach((v) => l.add(v));
    expect(l.count).toBe(3);
    expect(l.summary()).toMatchObject({ avgMs: 25, maxMs: 30 });
  });
  it("computes a baseline in the units", () => {
    const imu = new Float32Array(1000 * 6 * 3);
    for (let i = 0; i < 3000; i++) imu[i * 6 + 2] = 1;
    const b = computeBaseline(imu, Array(300).fill(64), { mean: 38.55, std: 0.15 }, DEFAULT_FUSION_CONFIG);
    expect(b).toMatchObject({ activeRatioMean: 0, activeRatioStd: 0, hrMean: 64, hrStd: 0, tempMean: 38.55, tempStd: 0.15, samples: 15 });
  });
});
