/**
 * Anomaly injection. The catalog is shared/anomaly-catalog.json, also read by
 * ml/src/inject.py; shared/fixtures/cross-language.json keeps both implementations equal.
 * Pure functions: no Firebase dependencies, used by the simulator and the web panel.
 */
import catalogJson from "./anomaly-catalog.json";
import type { AnomalyType, InjectedAnomaly } from "./types";

export interface AnomalySpec {
  signal: "imu" | "hr" | "temp";
  label: string;
  unit: "fraction" | "relative" | "celsius";
  min: number;
  max: number;
  default: number;
  rampS: number;
  rule: string;
}

export interface AnomalyCatalog {
  version: number;
  blockSeconds: number;
  durationsS: number[];
  maxDurationS: number;
  types: Record<AnomalyType, AnomalySpec>;
}

export const ANOMALY_CATALOG = catalogJson as unknown as AnomalyCatalog;
export const ANOMALY_TYPES = Object.keys(ANOMALY_CATALOG.types) as AnomalyType[];

/** An injection scheduled on a dog: blocks [startBlock, endBlock) of that dog's stream are altered. */
export interface ActiveInjection {
  id: string;
  type: AnomalyType;
  magnitude: number;
  durationS: number;
  startBlock: number;
  endBlock: number;
}

/** Throws with a message in Spanish when a request is outside the catalog (shown in the CLI and the panel). */
export function validateInjection(type: string, magnitude: number, durationS: number): asserts type is AnomalyType {
  const spec = ANOMALY_CATALOG.types[type as AnomalyType];
  if (!spec) throw new Error(`Tipo de anomalía desconocido: ${type}. Opciones: ${ANOMALY_TYPES.join(", ")}`);
  if (!(magnitude >= spec.min && magnitude <= spec.max)) {
    throw new Error(`${spec.label}: la magnitud ${magnitude} está fuera de ${spec.min}–${spec.max} (${spec.unit}).`);
  }
  if (!(durationS > 0 && durationS <= ANOMALY_CATALOG.maxDurationS)) {
    throw new Error(`${spec.label}: la duración ${durationS} s está fuera de 1–${ANOMALY_CATALOG.maxDurationS} s.`);
  }
}

export function blocksFor(durationS: number): number {
  return Math.ceil(durationS / ANOMALY_CATALOG.blockSeconds);
}

export function schedule(id: string, type: AnomalyType, magnitude: number, durationS: number, startBlock: number): ActiveInjection {
  validateInjection(type, magnitude, durationS);
  return { id, type, magnitude, durationS, startBlock, endBlock: startBlock + blocksFor(durationS) };
}

export function ramp(offsetS: number, rampS: number): number {
  return rampS <= 0 ? 1 : Math.min(1, Math.max(0, offsetS / rampS));
}

/** imu: n × 6 sample-major (imu[i * 6 + c]). Returns a new array; per channel x' = mean + (1 - m·ramp)(x - mean). */
export function applyImu(imu: ArrayLike<number>, inj: Pick<ActiveInjection, "type" | "magnitude">, offsetS: number): number[] {
  const spec = ANOMALY_CATALOG.types[inj.type];
  const out = Array.from(imu);
  if (spec.signal !== "imu") return out;
  const n = out.length / 6;
  const k = 1 - inj.magnitude * ramp(offsetS, spec.rampS);
  for (let c = 0; c < 6; c++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i * 6 + c];
    mean /= n;
    for (let i = 0; i < n; i++) out[i * 6 + c] = mean + k * (out[i * 6 + c] - mean);
  }
  return out;
}

/** values at 1 Hz; offsetS is the offset of values[0] since the injection started. */
export function applyHr(values: number[], inj: Pick<ActiveInjection, "type" | "magnitude">, offsetS: number): number[] {
  const spec = ANOMALY_CATALOG.types[inj.type];
  if (spec.signal !== "hr") return values.slice();
  const sign = inj.type === "tachycardia" ? 1 : -1;
  return values.map((v, i) => v * (1 + sign * inj.magnitude * ramp(offsetS + i, spec.rampS)));
}

export function applyTemp(value: number, inj: Pick<ActiveInjection, "type" | "magnitude">, offsetS: number): number {
  const spec = ANOMALY_CATALOG.types[inj.type];
  if (spec.signal !== "temp") return value;
  const sign = inj.type === "fever" ? 1 : -1;
  return value + sign * inj.magnitude * ramp(offsetS, spec.rampS);
}

export interface BlockSignals { imu: number[]; hr: number[]; temp: number | null }

/** Applies every injection active in `block` (in start order) and returns the altered signals and their ground truth. */
export function applyInjections(signals: BlockSignals, injections: ActiveInjection[], block: number): { signals: BlockSignals; truth: InjectedAnomaly[] } {
  let { imu, hr, temp } = signals;
  const truth: InjectedAnomaly[] = [];
  const active = injections.filter((j) => block >= j.startBlock && block < j.endBlock).sort((a, b) => a.startBlock - b.startBlock);
  for (const j of active) {
    const offsetS = (block - j.startBlock) * ANOMALY_CATALOG.blockSeconds;
    const signal = ANOMALY_CATALOG.types[j.type].signal;
    if (signal === "imu") imu = applyImu(imu, j, offsetS);
    else if (signal === "hr") hr = applyHr(hr, j, offsetS);
    else if (temp != null) temp = applyTemp(temp, j, offsetS);
    truth.push({ type: j.type, magnitude: j.magnitude, durationS: j.durationS, injectionId: j.id, offsetS });
  }
  return { signals: { imu, hr, temp }, truth };
}
