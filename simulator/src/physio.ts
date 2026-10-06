/**
 * The physiological model in the simulator: for the offline sweep, which compares the heart-rate rule with
 * the rule plus the autoencoder, and for evaluate. Loads the TF.js bundle of functions/models/physio with the WebAssembly backend.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { packSequences, type PhysioModelMeta, type PhysioScorer } from "../../shared/physio-model";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PHYSIO_BUNDLE_DIR = process.env.PHYSIO_MODEL_DIR || path.resolve(here, "../../functions/models/physio");

let cached: Promise<PhysioScorer | null> | null = null;

export function loadSimPhysioModel(dir = PHYSIO_BUNDLE_DIR): Promise<PhysioScorer | null> {
  cached ??= (async (): Promise<PhysioScorer | null> => {
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as PhysioModelMeta;
    const mj = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
    const weightSpecs = mj.weightsManifest.flatMap((g: { weights: tf.io.WeightsManifestEntry[] }) => g.weights);
    const all = Buffer.concat(mj.weightsManifest.flatMap((g: { paths: string[] }) => g.paths.map((p) => fs.readFileSync(path.join(dir, p)))));
    const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer;
    try {
      const require = createRequire(import.meta.url);
      setWasmPaths(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm")) + path.sep);
      if (!(await tf.setBackend("wasm"))) throw new Error("wasm backend unavailable");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: mj.modelTopology, weightSpecs, weightData }));
    const L = meta.sequenceLength;
    const score = (batch: Float32Array[]): number[] => (!batch.length ? [] : tf.tidy(() => {
      const x = tf.tensor3d(packSequences(batch, L), [batch.length, L, 1]);
      return (tf.mean(tf.square(tf.sub(model.predict(x) as tf.Tensor, x)), [1, 2]).arraySync() as number[]);
    }));
    return { meta, score };
  })();
  return cached;
}
