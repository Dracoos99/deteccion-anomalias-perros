/**
 * Behavioral model runtime: the CNN-LSTM exported by ml/src/ensemble_behavior.py (v2), loaded once per
 * instance from functions/models/behavior and run with the TF.js WebAssembly backend. tfjs-node has no prebuilt
 * binary for Windows (the local emulator), and WebAssembly runs the same on Windows and in Cloud Functions.
 */
import fs from "node:fs";
import path from "node:path";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { normalizeWindows, type BehaviorModelMeta, type BehaviorOutput } from "./shared/behavior-model";
import { logger } from "firebase-functions";

export const BUNDLE_DIR = process.env.BEHAVIOR_MODEL_DIR ?? path.resolve(__dirname, "../models/behavior");

export interface BehaviorRunner {
  meta: BehaviorModelMeta;
  backend: string;
  /** Softmax per 2 s window of a block, with the dog's z-score; null if the dog has no IMU statistics yet. */
  run(imu: ArrayLike<number>, mean: number[] | undefined, std: number[] | undefined): BehaviorOutput | null;
  predictWindows(data: Float32Array, windows: number): number[][];
}

let backendReady: Promise<string> | null = null;

export function initBackend(): Promise<string> {
  backendReady ??= (async () => {
    try {
      setWasmPaths(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm")) + path.sep);
      if (!(await tf.setBackend("wasm"))) throw new Error("wasm backend unavailable");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    return tf.getBackend();
  })();
  return backendReady;
}

export async function loadBehaviorModel(dir = BUNDLE_DIR): Promise<BehaviorRunner | null> {
  const metaPath = path.join(dir, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BehaviorModelMeta;
  const mj = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
  const weightSpecs = mj.weightsManifest.flatMap((g: { weights: tf.io.WeightsManifestEntry[] }) => g.weights);
  const shards = mj.weightsManifest.flatMap((g: { paths: string[] }) => g.paths.map((p) => fs.readFileSync(path.join(dir, p))));
  const all = Buffer.concat(shards);
  const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer;
  const backend = await initBackend();
  const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: mj.modelTopology, weightSpecs, weightData }));
  const w = meta.windowSamples, ch = meta.channels.length || 6;

  const predictWindows = (data: Float32Array, windows: number): number[][] => tf.tidy(() => {
    const out = model.predict(tf.tensor3d(data, [windows, w, ch])) as tf.Tensor;
    return out.arraySync() as number[][];
  });
  predictWindows(new Float32Array(w * ch), 1);  // warm-up: compiles the kernels before the first real block

  return {
    meta, backend, predictWindows,
    run(imu, mean, std) {
      if (!mean || !std || mean.length !== ch || std.length !== ch) return null;
      const [data, n] = normalizeWindows(imu, mean, std, w);
      return n ? { meta, probs: predictWindows(data, n) } : null;
    },
  };
}

let loading: Promise<BehaviorRunner | null> | null = null;

/** Global, loaded once per instance. Failures fall back to the rule. */
export function getBehaviorRunner(): Promise<BehaviorRunner | null> {
  loading ??= loadBehaviorModel().catch((e) => {
    logger.error("behavior model not loaded; using the provisional movement rule", { error: (e as Error).message });
    return null;
  });
  return loading;
}
