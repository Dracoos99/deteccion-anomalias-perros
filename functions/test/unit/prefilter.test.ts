import { describe, expect, it } from "vitest";
import { flatImu, prefilterBlock } from "../../src/prefilter";
import { DEFAULT_FUSION_CONFIG } from "../../../shared/types";

const limits = DEFAULT_FUSION_CONFIG.prefilter;
// A worn collar: the signal moves a little on every channel.
const moving = (n: number) => Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.05);
const imu = moving(6000);

describe("prefilterBlock", () => {
  it("keeps plausible values and raises no flags", () => {
    const r = prefilterBlock({ hr: [72, 75, 80], temp: 38.6, imu }, limits);
    expect(r).toEqual({ hr: [72, 75, 80], temp: 38.6, flags: [] });
  });
  it("drops impossible heart rates and temperatures", () => {
    const r = prefilterBlock({ hr: [15, 80, 312], temp: 50, imu }, limits);
    expect(r.hr).toEqual([80]);
    expect(r.temp).toBeNull();
    expect(r.flags).toContain("hr_out_of_range:2");
    expect(r.flags).toContain("temp_out_of_range");
  });
  it("flags a malformed IMU block", () => {
    const r = prefilterBlock({ hr: [], imu: [1, 2, Number.NaN] }, limits);
    expect(r.flags).toEqual(["imu_length:3", "imu_not_finite"]);
  });
  it("accepts a block without heart rate or temperature", () => {
    expect(prefilterBlock({ imu }, limits).flags).toEqual([]);
  });
  it("accepts blocks of 1 to 5 windows of 2 s, and nothing in between", () => {
    for (const n of [1200, 2400, 6000]) expect(prefilterBlock({ imu: moving(n) }, limits).flags).toEqual([]);
    for (const n of [600, 7200]) expect(prefilterBlock({ imu: new Array(n).fill(0) }, limits).flags).toEqual([`imu_length:${n}`]);
  });
  it("marks a collar that seems off: no movement at all, no heart rate and no plausible temperature", () => {
    const still = new Array(6000).fill(0.5);
    expect(prefilterBlock({ imu: still }, limits).flags).toEqual(["imu_no_wear"]);
    expect(prefilterBlock({ imu: still, temp: 24 }, limits).flags).toEqual(["temp_out_of_range", "imu_no_wear"]);
    // A dog lying still keeps its heart rate or its temperature: not a collar off.
    expect(prefilterBlock({ imu: still, hr: [60, 61] }, limits).flags).toEqual([]);
    expect(prefilterBlock({ imu: still, temp: 38.5 }, limits).flags).toEqual([]);
    expect(prefilterBlock({ imu }, limits).flags).toEqual([]);
    expect(flatImu(still)).toBe(true);
    expect(flatImu(imu)).toBe(false);
  });
});
