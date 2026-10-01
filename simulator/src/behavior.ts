/**
 * The behavioral model in the simulator: baselines with the same definition of "active" as the Cloud
 * Function, and the softmax of each window for the offline evaluation of the alert rules. Loads the TF.js
 * bundle of functions/models/behavior with the WebAssembly backend.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { normalizeWindows, readWindow, type BehaviorModelMeta } from "../../shared/behavior-model";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE_DIR = process.env.BEHAVIOR_MODEL_DIR || path.resolve(here, "../../functions/models/behavior");

export interface SimBehaviorModel {
  meta: BehaviorModelMeta;
  /** 0/1 active flag per consecutive 2 s window of a whole recording, and the share of novel windows. */
  activeFlags(imu: ArrayLike<number>, mean: number[], std: number[]): { active: number[]; novelShare: number };
  /** Softmax of each consecutive 2 s window, as the Function computes it. */
  predict(imu: ArrayLike<number>, mean: number[], std: number[]): number[][];
}

let cached: Promise<SimBehaviorModel | null> | null = null;

export function loadSimBehaviorModel(dir = BUNDLE_DIR): Promise<SimBehaviorModel | null> {
  cached ??= (async (): Promise<SimBehaviorModel | null> => {
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BehaviorModelMeta;
    const mj = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
    const weightSpecs = mj.weightsManifest.flatMap((g: { weights: tf.io.WeightsManifestEntry[] }) => g.weights);
    const all = Buffer.concat(mj.weightsManifest.flatMap((g: { paths: string[] }) => g.paths.map((p) => fs.readFileSync(path.join(dir, p)))));
    try {
      setWasmPaths(path.dirname(createRequire(import.meta.url).resolve("@tensorflow/tfjs-backend-wasm")) + path.sep);
      if (!(await tf.setBackend("wasm"))) await tf.setBackend("cpu");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    const model = await tf.loadLayersModel(tf.io.fromMemory({
      modelTopology: mj.modelTopology, weightSpecs, weightData: all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer,
    }));
    const w = meta.windowSamples;
    const predict = (imu: ArrayLike<number>, mean: number[], std: number[]): number[][] => {
      const [data, n] = normalizeWindows(imu, mean, std, w);
      const out: number[][] = [];
      for (let start = 0; start < n; start += 512) {
        const count = Math.min(512, n - start);
        out.push(...tf.tidy(() => (model.predict(tf.tensor3d(data.subarray(start * w * 6, (start + count) * w * 6), [count, w, 6])) as tf.Tensor).arraySync() as number[][]));
      }
      return out;
    };
    return {
      meta, predict,
      activeFlags(imu, mean, std) {
        const active: number[] = [];
        let novel = 0;
        for (const p of predict(imu, mean, std)) {
          const r = readWindow(p, meta);
          active.push(r.active ? 1 : 0);
          if (r.novel) novel += 1;
        }
        return { active, novelShare: active.length ? novel / active.length : 0 };
      },
    };
  })().catch((e) => {
    console.error("No se pudo cargar el modelo conductual; las líneas base usarán la regla provisional.", e);
    return null;
  });
  return cached;
}
