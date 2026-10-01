/**
 * Statistical prefilter: drops physically impossible values before any model runs.
 * Thresholds come from config/fusion.prefilter; nothing is hardcoded at call sites.
 */
import type { FusionConfig } from "./shared/types";

export interface PrefilterResult {
  hr: number[];            // heart-rate values kept
  temp: number | null;     // temperature kept, or null when impossible or missing
  flags: string[];         // stored in results.prefilterFlags
}

/** A block lasts 1 to 5 windows of 2 s (200 samples × 6 channels each): 10 s from CSV uploads, 2 s from the
 * live simulator. */
const WINDOW_VALUES = 1200;
const MAX_WINDOWS = 5;

export function prefilterBlock(
  block: { hr?: number[] | null; temp?: number | null; imu?: number[] | null },
  limits: FusionConfig["prefilter"],
): PrefilterResult {
  const flags: string[] = [];
  const hrIn = Array.isArray(block.hr) ? block.hr : [];
  const hr = hrIn.filter((v) => Number.isFinite(v) && v >= limits.hrMin && v <= limits.hrMax);
  if (hr.length < hrIn.length) flags.push(`hr_out_of_range:${hrIn.length - hr.length}`);

  let temp: number | null = null;
  if (block.temp != null) {
    if (Number.isFinite(block.temp) && block.temp >= limits.tempMin && block.temp <= limits.tempMax) temp = block.temp;
    else flags.push("temp_out_of_range");
  }

  const imu = Array.isArray(block.imu) ? block.imu : [];
  if (imu.length === 0 || imu.length % WINDOW_VALUES !== 0 || imu.length > MAX_WINDOWS * WINDOW_VALUES) flags.push(`imu_length:${imu.length}`);
  if (imu.some((v) => !Number.isFinite(v))) flags.push("imu_not_finite");

  return { hr, temp, flags };
}
