/** Loads the signals exported by ml/src/export_sim.py (IMU as float32, heart rate as JSON). */
import fs from "node:fs";
import path from "node:path";
import { IMU_CHANNELS, SIM_DATA_DIR } from "./config";
import type { DatasetId } from "../../shared/types";

export interface Manifest {
  version: number;
  imuHz: number;
  imuChannels: string[];
  imu: Record<string, { subjectId: string; samples: number; minutes: number; breed?: string; weightKg?: number; imuMean?: number[]; imuStd?: number[];
    /** The split of the behavioral model the subject belongs to, and its 2 s windows with one annotated class. */
    split?: "train" | "val" | "test" | null; labeledWindows?: number }[]>;
  hr: Record<string, { subjectId: string; values: number; hours: number; hrMean: number; stretches?: number }[]>;
  activity: { thresholdG: number; balancedAccuracyVal: number };
}

export const IMU_DATASETS: DatasetId[] = ["vehkaoja2022"];
export const HR_DATASETS: DatasetId[] = ["invoxia2023", "physiozoo2018", "rri23dogs"];

export function loadManifest(dir = SIM_DATA_DIR): Manifest {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) {
    throw new Error(`No encuentro ${file}. Genera los datos del simulador con: cd ml && .venv/Scripts/python -m src.export_sim`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The behavior annotated from video for each 2 s window of a subject's IMU (index in BEHAVIORS, -1 without one
 * clean class), or null when the export has no labels. Never read by the engine. */
export function loadLabels(datasetId: string, subjectId: string, dir = SIM_DATA_DIR): Int8Array | null {
  const file = path.join(dir, "labels", datasetId, `${subjectId}.i8`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return new Int8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

/** Interleaved IMU samples (n × 6) of one subject, in g and °/s. */
export function loadImu(datasetId: string, subjectId: string, dir = SIM_DATA_DIR): Float32Array {
  const file = path.join(dir, "imu", datasetId, `${subjectId}.f32`);
  if (!fs.existsSync(file)) throw new Error(`Falta la señal IMU de ${datasetId}/${subjectId} (${file}).`);
  const buf = fs.readFileSync(file);
  if (buf.length % (4 * IMU_CHANNELS) !== 0) throw new Error(`${file}: tamaño no múltiplo de ${4 * IMU_CHANNELS} bytes.`);
  // Copy into an aligned buffer; the file is little-endian float32.
  const out = new Float32Array(buf.length / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * 1 Hz heart rate of one subject (valid seconds of its sessions, chained) and where each later contiguous stretch
 * starts. `breaks` is undefined in exports older than.
 */
export function loadHr(datasetId: string, subjectId: string, dir = SIM_DATA_DIR): { values: number[]; breaks?: number[] } {
  const file = path.join(dir, "hr", datasetId, `${subjectId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Falta la serie de FC de ${datasetId}/${subjectId} (${file}).`);
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { values: number[]; breaks?: number[] };
  if (!data.values.length) throw new Error(`${file}: la serie de FC está vacía.`);
  return { values: data.values, breaks: data.breaks };
}
