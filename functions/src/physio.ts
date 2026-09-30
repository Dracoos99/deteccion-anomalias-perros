/**
 * Physiological model runtime: the heart-rate LSTM autoencoder exported by ml/src/train_physio.py,
 * loaded once per instance from functions/models/physio with the same TF.js WebAssembly backend as the behavioral model.
 * The score of a sequence is its reconstruction error (mean squared error of the 60 z values).
 */
import fs from "node:fs";
import path from "node:path";
import * as tf from "@tensorflow/tfjs";
import { packSequences, type PhysioModelMeta, type PhysioScorer } from "./shared/physio-model";
import { initBackend } from "./behavior";

export const PHYSIO_BUNDLE_DIR = process.env.PHYSIO_MODEL_DIR ?? path.resolve(__dirname, "../models/physio");

export interface PhysioRunner extends PhysioScorer {
  backend: string;
  /** Reconstruction errors of several z-scored sequences (n × sequenceLength, row-major). */
  errors(data: Float32Array, n: number): number[];
}

export async function loadPhysioModel(dir = PHYSIO_BUNDLE_DIR): Promise<PhysioRunner | null> {
  const metaPath = path.join(dir, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as PhysioModelMeta;
  const mj = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
  const weightSpecs = mj.weightsManifest.flatMap((g: { weights: tf.io.WeightsManifestEntry[] }) => g.weights);
  const shards = mj.weightsManifest.flatMap((g: { paths: string[] }) => g.paths.map((p) => fs.readFileSync(path.join(dir, p))));
  const all = Buffer.concat(shards);
  const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer;
  const backend = await initBackend();
  const model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: mj.modelTopology, weightSpecs, weightData }));
  const L = meta.sequenceLength;

  const errors = (data: Float32Array, n: number): number[] => tf.tidy(() => {
    const x = tf.tensor3d(data, [n, L, 1]);
    const rec = model.predict(x) as tf.Tensor;
    return (tf.mean(tf.square(tf.sub(rec, x)), [1, 2]).arraySync() as number[]);
  });
  errors(new Float32Array(L), 1);  // warm-up: compiles the kernels before the first real block

  return { meta, backend, errors, score: (batch) => (batch.length ? errors(packSequences(batch, L), batch.length) : []) };
}

let loading: Promise<PhysioRunner | null> | null = null;

/** Global, loaded once per instance. Failures fall back to the provisional heart-rate rule. */
export function getPhysioRunner(): Promise<PhysioRunner | null> {
  loading ??= loadPhysioModel().catch((e) => {
    console.error("physiological model not loaded; using the provisional heart-rate rule", e);
    return null;
  });
  return loading;
}
