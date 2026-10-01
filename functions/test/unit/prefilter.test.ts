import { describe, expect, it } from "vitest";
import { prefilterBlock } from "../../src/prefilter";
import { DEFAULT_FUSION_CONFIG } from "../../../shared/types";

const limits = DEFAULT_FUSION_CONFIG.prefilter;
const imu = new Array(6000).fill(0);

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
    for (const n of [1200, 2400, 6000]) expect(prefilterBlock({ imu: new Array(n).fill(0) }, limits).flags).toEqual([]);
    for (const n of [600, 7200]) expect(prefilterBlock({ imu: new Array(n).fill(0) }, limits).flags).toEqual([`imu_length:${n}`]);
  });
});
