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

/** The largest per-channel standard deviation below which the IMU of a block counts as «no movement at all».
 * A worn collar keeps the dog's breathing and the sensor's own noise; this is far below both. Provisional: it is
 * checked only with the injected «collar off» and must be calibrated with a real wearable. */
export const FLAT_IMU_STD = 1e-4;

/** Whether every channel of the block stays still (standard deviation under FLAT_IMU_STD). */
export function flatImu(imu: readonly number[]): boolean {
  const n = Math.floor(imu.length / 6);
  if (n < 2) return false;
  for (let c = 0; c < 6; c++) {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) { const v = imu[i * 6 + c]; sum += v; sumSq += v * v; }
    const mean = sum / n;
    if (Math.sqrt(Math.max(0, sumSq / n - mean * mean)) >= FLAT_IMU_STD) return false;
  }
  return true;
}

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
  // The collar seems off the dog: no movement at all, no heart rate and no plausible temperature. Its IMU is
  // not the dog's (imu_ flags keep the behavioral model off) and the engine does not read it as a dog lying still.
  if (!flags.some((f) => f.startsWith("imu_")) && hr.length === 0 && temp == null && flatImu(imu)) flags.push("imu_no_wear");

  return { hr, temp, flags };
}
