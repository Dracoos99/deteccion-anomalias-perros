/**
 * Baseline of a simulated dog, computed from the same normal data the simulator replays and with
 * the same code as the Function (shared/baseline.ts). With the behavioral model the active-time ratio
 * comes from its predictions and the per-dog IMU statistics are stored for its z-score. Dogs created by owners get
 * their baseline from the Function, from their first blocks.
 */
import { windowIntensity, type EngineConfig } from "../../shared/engine";
import { baselineFromParts, type BaselineValues } from "../../shared/baseline";

export interface BaselineModelInput {
  version: string;
  active: number[];           // one flag per 2 s window, from the model
  imuMean: number[];
  imuStd: number[];
}

const WINDOW_SAMPLES = 200;

export function computeBaseline(imu: ArrayLike<number>, hr: number[], temp: { mean: number; std: number }, cfg: EngineConfig,
  model?: BaselineModelInput | null): BaselineValues {
  let activeFlags = model?.active;
  if (!activeFlags) {
    const nWin = Math.floor(imu.length / 6 / WINDOW_SAMPLES);
    activeFlags = Array.from({ length: nWin }, (_, w) => (windowIntensity(imu, w * WINDOW_SAMPLES) > cfg.activity.thresholdG ? 1 : 0));
  }
  return baselineFromParts({
    activeFlags, hr, temp, imu: model ? { mean: model.imuMean, std: model.imuStd } : null, activitySource: model?.version ?? "rules",
  }, cfg);
}
