/**
 * Per-dog baseline from the dog's normal data, with the formulas of the engine
 * (activityBaselineFromFlags, hrBaseline). The simulator computes it at once from a whole subject; the Function learns
 * it from the first blocks of a dog that has none, in two stages:
 *   1. "initial": minBlocks blocks with the provisional movement rule give the per-channel IMU statistics, the heart rate, the temperature and the active-time ratio of the rule;
 *   2. "model": with those statistics the behavioral model can run, and minBlocks more blocks replace the active-time
 *      ratio with the model's, so the engine uses the model's activity.
 * The accumulator lives in dogState/{dogId}.baselineAcc between blocks: raw flags and values (not running sums) so the
 * result is exactly the one of the simulator for the same data.
 */
import { activityBaselineFromFlags, hrBaseline, type EngineConfig } from "./engine";
import type { Baseline } from "./types";

export const DEFAULT_BASELINE_BLOCKS = 360;   // 1 h of 10 s blocks
/** Blocks may last 2 to 10 s, so progress counts 2 s windows; minBlocks stays in 10 s blocks (5 windows). */
const WINDOWS_PER_BLOCK = 5;
const enough = (acc: BaselineAcc, minBlocks: number) => acc.activeFlags.length >= minBlocks * WINDOWS_PER_BLOCK;
const CHANNELS = 6;

export type BaselineValues = Omit<Baseline, "computedAt">;

export interface BaselineAcc {
  stage: "initial" | "model";
  /** Stage "model": the behavioral model whose flags are collected (a new version restarts the stage). */
  modelVersion: string | null;
  blocks: number;
  /** One 0/1 per 2 s window: the movement rule in "initial", the model in "model". */
  activeFlags: number[];
  /** Stage "initial": 1 Hz heart rate (prefiltered) and one temperature per block. */
  hr: number[];
  temps: number[];
  /** Stage "initial": per-channel sums of the IMU samples, for the mean and the population std. */
  imu: { n: number; sum: number[]; sumSq: number[] } | null;
}

export function newBaselineAcc(stage: BaselineAcc["stage"], modelVersion: string | null = null): BaselineAcc {
  return {
    stage, modelVersion, blocks: 0, activeFlags: [], hr: [], temps: [],
    imu: stage === "initial" ? { n: 0, sum: new Array(CHANNELS).fill(0), sumSq: new Array(CHANNELS).fill(0) } : null,
  };
}

export interface BaselineBlock {
  /** Sample-major IMU of the block, or null when the prefilter rejected it. */
  imu: ArrayLike<number> | null;
  hr: number[];
  temp: number | null;
  activeFlags: boolean[];
}

/** Adds one block (pure: returns a new accumulator). */
export function addToBaseline(acc: BaselineAcc, block: BaselineBlock): BaselineAcc {
  const next: BaselineAcc = {
    ...acc, blocks: acc.blocks + 1, activeFlags: [...acc.activeFlags, ...block.activeFlags.map((a) => (a ? 1 : 0))],
  };
  if (acc.stage === "initial") {
    next.hr = [...acc.hr, ...block.hr.map((v) => Math.round(v * 10) / 10)];
    next.temps = block.temp == null ? acc.temps : [...acc.temps, Math.round(block.temp * 100) / 100];
    if (acc.imu && block.imu) {
      const sum = [...acc.imu.sum], sumSq = [...acc.imu.sumSq];
      const n = Math.floor(block.imu.length / CHANNELS);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < CHANNELS; c++) {
          const v = block.imu[i * CHANNELS + c];
          sum[c] += v;
          sumSq[c] += v * v;
        }
      }
      next.imu = { n: acc.imu.n + n, sum, sumSq };
    }
  }
  return next;
}

export function baselineShare(acc: BaselineAcc, minBlocks: number): number {
  return Math.min(1, acc.activeFlags.length / Math.max(1, minBlocks * WINDOWS_PER_BLOCK));
}

export function meanStd(values: number[]): { mean: number; std: number } | null {
  if (!values.length) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean: m, std: Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length) };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The baseline document from its parts: the one formula of the simulator and the Function. */
export function baselineFromParts(parts: {
  activeFlags: number[]; hr: number[]; temp: { mean: number; std: number } | null;
  imu?: { mean: number[]; std: number[] } | null; activitySource: string;
}, cfg: EngineConfig): BaselineValues {
  const act = activityBaselineFromFlags(parts.activeFlags, cfg);
  const h = hrBaseline(parts.hr, cfg);
  const hasHr = h.n > 0;
  return {
    activeRatioMean: r4(act.mean), activeRatioStd: r4(act.std),
    hrMean: hasHr ? Math.round(h.mean * 10) / 10 : null, hrStd: hasHr ? Math.round(h.std * 10) / 10 : null,
    tempMean: parts.temp ? Math.round(parts.temp.mean * 100) / 100 : null, tempStd: parts.temp ? Math.round(parts.temp.std * 100) / 100 : null,
    samples: act.windows,
    ...(parts.imu ? { imuMean: parts.imu.mean, imuStd: parts.imu.std } : {}),
    activitySource: parts.activitySource,
  };
}

function imuStatsOf(acc: BaselineAcc): { mean: number[]; std: number[] } | null {
  if (!acc.imu || acc.imu.n === 0) return null;
  const { n, sum, sumSq } = acc.imu;
  const mean = sum.map((s) => s / n);
  return { mean: mean.map(r6), std: sumSq.map((s, c) => r6(Math.sqrt(Math.max(0, s / n - mean[c] ** 2)))) };
}

/** Stage "initial" finished: the dog's first baseline, with the activity of the movement rule. */
export function finishInitial(acc: BaselineAcc, cfg: EngineConfig): BaselineValues {
  return {
    ...baselineFromParts({ activeFlags: acc.activeFlags, hr: acc.hr, temp: meanStd(acc.temps), imu: imuStatsOf(acc), activitySource: "rules" }, cfg),
    origin: "function",
  };
}

/** Stage "model" finished: the same baseline with the active-time ratio of the behavioral model. */
export function finishModel(base: BaselineValues, acc: BaselineAcc, cfg: EngineConfig): BaselineValues {
  const act = activityBaselineFromFlags(acc.activeFlags, cfg);
  return { ...base, activeRatioMean: r4(act.mean), activeRatioStd: r4(act.std), samples: act.windows, activitySource: acc.modelVersion ?? "rules" };
}

export interface LearnInput {
  imu: ArrayLike<number> | null;
  hr: number[];
  temp: number | null;
  /** The movement rule of each 2 s window (the engine's own activity while the dog has no model baseline). */
  ruleFlags: boolean[];
  /** The behavioral model and its activity per window, when it ran on this block. */
  model: { version: string; flags: boolean[] } | null;
}

/**
 * One in-order block of the dog: which stage it feeds and whether the baseline is ready. `current` is the dog's
 * baseline; a baseline from the simulator (no origin) is never touched.
 */
export function learnBaseline(current: BaselineValues | null, acc: BaselineAcc | null, block: LearnInput, cfg: EngineConfig,
  minBlocks: number): { acc: BaselineAcc | null; learned: BaselineValues | null } {
  if (!current) {
    const a = addToBaseline(acc?.stage === "initial" ? acc : newBaselineAcc("initial"),
      { imu: block.imu, hr: block.hr, temp: block.temp, activeFlags: block.ruleFlags });
    return enough(a, minBlocks) ? { acc: null, learned: finishInitial(a, cfg) } : { acc: a, learned: null };
  }
  if (current.origin === "function" && current.activitySource === "rules" && current.imuMean && block.model) {
    const same = acc?.stage === "model" && acc.modelVersion === block.model.version;
    const a = addToBaseline(same ? acc! : newBaselineAcc("model", block.model.version),
      { imu: null, hr: [], temp: null, activeFlags: block.model.flags });
    return enough(a, minBlocks) ? { acc: null, learned: finishModel(current, a, cfg) } : { acc: a, learned: null };
  }
  return { acc: null, learned: null };
}
