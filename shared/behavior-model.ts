/**
 * Behavioral model contract: metadata of the TF.js bundle in functions/models/behavior and the pure steps
 * around inference (per-dog z-score and reading of the softmax). The TF.js runtime itself lives in functions/ and
 * simulator/, which own the @tensorflow dependencies.
 */
import type { Behavior } from "./types";

export interface BehaviorModelMeta {
  version: string;
  classes: Behavior[];
  activeClasses: Behavior[];
  windowSamples: number;
  imuHz: number;
  channels: string[];
  noveltyThreshold: number;
  noveltyQuantile: number;
  metrics: Record<string, number>;
  architecture: string;
  trainingData: string[];
  trainedAt: string;
}

export interface BehaviorOutput {
  meta: BehaviorModelMeta;
  probs: number[][];   // one softmax per 2 s window of the block, in time order
}

const CHANNELS = 6;

/** Cuts `imu` (sample-major, n × 6) into consecutive windows and applies the dog's z-score. Returns [data, windows]. */
export function normalizeWindows(imu: ArrayLike<number>, mean: number[], std: number[], windowSamples: number): [Float32Array, number] {
  const n = Math.floor(imu.length / CHANNELS / windowSamples);
  const out = new Float32Array(n * windowSamples * CHANNELS);
  for (let i = 0; i < n * windowSamples; i++) {
    for (let c = 0; c < CHANNELS; c++) out[i * CHANNELS + c] = (imu[i * CHANNELS + c] - mean[c]) / (std[c] || 1);
  }
  return [out, n];
}

export interface WindowReading { predicted: Behavior; maxProb: number; active: boolean; novel: boolean }

/** Class, confidence, activity and novelty of one window. */
export function readWindow(probs: number[], meta: BehaviorModelMeta): WindowReading {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  const predicted = meta.classes[best];
  return { predicted, maxProb: probs[best], active: meta.activeClasses.includes(predicted), novel: probs[best] < meta.noveltyThreshold };
}

/** Per-channel mean and std of a dog's normal IMU (population std), for dogs.baseline.imuMean / imuStd. */
export function imuStats(imu: ArrayLike<number>): { mean: number[]; std: number[] } {
  const n = Math.floor(imu.length / CHANNELS);
  const s = new Array(CHANNELS).fill(0), s2 = new Array(CHANNELS).fill(0);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < CHANNELS; c++) {
      const v = imu[i * CHANNELS + c];
      s[c] += v;
      s2[c] += v * v;
    }
  }
  const mean = s.map((v) => v / n);
  return { mean, std: s2.map((v, c) => Math.sqrt(Math.max(0, v / n - mean[c] ** 2))) };
}
