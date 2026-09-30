/**
 * Physiological model contract: metadata of the TF.js autoencoder in functions/models/physio and the
 * pure steps around it. The runtime lives in functions/ (and simulator/), which own the @tensorflow dependencies.
 * The engine turns error / threshold ("ratio") into r_p and the heart-rate critical rule.
 */
export interface PhysioModelMeta {
  version: string;
  sequenceLength: number;   // 60 values of 1 Hz heart rate
  threshold: number;        // 95th percentile of the reconstruction error on normal validation sequences
  criticalRatio: number;    // error / threshold of the heart-rate critical rule (99.9th percentile of normal validation)
  fullScaleRatio: number;   // error / threshold where r_p reaches 1
  metrics: Record<string, number>;
  architecture: string;
  trainingData: string[];
  trainedAt: string;
}

/** What the engine needs: the metadata and the reconstruction error of each z-scored sequence (one batch per block). */
export interface PhysioScorer {
  meta: PhysioModelMeta;
  score(batch: Float32Array[]): number[];
}

/** Packs sequences of equal length into one row-major buffer (n × length) for a batched prediction. */
export function packSequences(batch: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(batch.length * length);
  batch.forEach((z, i) => out.set(z, i * length));
  return out;
}

const HR_SD_FLOOR = 1; // bpm, same floor as the engine and ml/src/physio_data.py

/** The last `length` heart-rate values as the dog's z-score, or null if there are not enough. */
export function sequenceZ(values: number[], mean: number, std: number, length: number): Float32Array | null {
  if (values.length < length) return null;
  const s = Math.max(std, HR_SD_FLOOR);
  const out = new Float32Array(length);
  const from = values.length - length;
  for (let i = 0; i < length; i++) out[i] = (values[from + i] - mean) / s;
  return out;
}

/** r_p from error / threshold: 0 up to the threshold, 1 at fullScaleRatio. */
export function ratioToScore(ratio: number, fullScaleRatio: number): number {
  return Math.min(1, Math.max(0, (ratio - 1) / Math.max(1e-6, fullScaleRatio - 1)));
}
