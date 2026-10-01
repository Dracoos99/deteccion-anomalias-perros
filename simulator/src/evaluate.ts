/**
 * Offline evaluation of the alert rules with both models, no Firestore. Replays dogs of one split through
 * shared/engine.ts with the behavioral model (softmax of every window) and the heart-rate autoencoder, and measures per
 * configuration:
 *   - false alerts: alerts opened per dog-hour of normal data (no injection), by the variable that caused them;
 *   - detection of every anomaly at the catalog's default magnitude: an alert that names the injected variable
 *     while it lasts (+1 min), and how long it took. Heart rate and temperature last 10 min; the behavioral ones
 *     ("inmovilidad prolongada", activity drops) 60 min.
 * Each dog pairs an IMU subject and a heart-rate subject of the same split. The validation dogs calibrated the models
 * (novelty threshold, autoencoder threshold), so the rules are tuned on them too; the test dogs are measured once.
 * Model outputs are cached on disk (simulator/.eval-cache), so trying many configurations is fast.
 *
 *   npm run sim -- evaluate [--split val|test] [--hours 3] [--search] [--config '{"alertMinDurationS":120}'] [--out f.json]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BLOCK_SECONDS } from "./config";
import { loadHr, loadImu, loadManifest } from "./data";
import { DogStream, type Block } from "./stream";
import { computeBaseline } from "./baseline";
import { imuStats } from "../../shared/behavior-model";
import { ANOMALY_CATALOG, schedule } from "../../shared/anomalies";
import { evaluateBlock, initialState, type EngineConfig } from "../../shared/engine";
import type { PhysioScorer } from "../../shared/physio-model";
import { DEFAULT_FUSION_CONFIG, type AnomalyType, type FusionConfig } from "../../shared/types";
import type { SimBehaviorModel } from "./behavior";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(here, "../.eval-cache");

/** Vehkaoja dogs of ml splits.json and Invoxia dogs of the physiological split (functions/models/physio). */
export const SPLIT_DOGS = {
  val: { imu: ["46", "48", "52", "55", "60", "72", "74"], hr: ["12", "15", "25", "38", "7", "9"] },
  test: { imu: ["21", "25", "27", "49", "54", "58", "61"], hr: ["13", "23", "27", "28", "31", "34"] },
} as const;
export type Split = keyof typeof SPLIT_DOGS;

const TYPES: AnomalyType[] = ["tachycardia", "bradycardia", "fever", "hypothermia", "activity_drop", "immobility"];
const COMPONENT = { imu: "behavior", hr: "heart_rate", temp: "temperature" } as const;
const DURATION_S: Record<AnomalyType, number> = {
  tachycardia: 600, bradycardia: 600, fever: 600, hypothermia: 600, activity_drop: 3600, immobility: 3600,
};
const START_BLOCK = 90;   // minute 15: the engine has settled

interface DogCase { key: string; imuId: string; hrId: string; imu: Float32Array; hr: { values: number[]; breaks?: number[] }; mean: number[]; std: number[] }

export interface Outcome {
  falseAlertsPerDogHour: number;
  falseByComponent: Record<string, number>;
  detection: Record<string, { detected: number; dogs: number; meanDelayS: number | null }>;
  minDetectionRate: number;
}

/** Model outputs that do not depend on the rules: kept across configurations and runs. */
class Cache {
  private behavior = new Map<string, number[][]>();
  private physio = new Map<string, number>();
  private dirty = false;
  constructor(private readonly file: string) {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as { behavior: Record<string, number[][]>; physio: Record<string, number> };
      this.behavior = new Map(Object.entries(d.behavior));
      this.physio = new Map(Object.entries(d.physio));
    }
  }
  has(key: string): boolean { return this.behavior.has(key); }
  get(key: string): number[][] | undefined { return this.behavior.get(key); }
  put(key: string, probs: number[][]): void {
    this.behavior.set(key, probs.map((r) => r.map((x) => Math.round(x * 1e5) / 1e5)));
    this.dirty = true;
  }
  scorer(model: PhysioScorer): PhysioScorer {
    const key = (z: Float32Array) => createHash("sha1").update(new Uint8Array(z.buffer, z.byteOffset, z.byteLength)).digest("base64");
    return {
      meta: model.meta,
      score: (batch) => {
        const keys = batch.map(key);
        const missing = batch.filter((_, i) => !this.physio.has(keys[i]));
        if (missing.length) {
          const errors = model.score(missing);
          let j = 0;
          batch.forEach((_, i) => { if (!this.physio.has(keys[i])) this.physio.set(keys[i], errors[j++]); });
          this.dirty = true;
        }
        return keys.map((k) => this.physio.get(k)!);
      },
    };
  }
  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ behavior: Object.fromEntries(this.behavior), physio: Object.fromEntries(this.physio) }));
    this.dirty = false;
  }
}

export class Evaluator {
  private readonly dogs: DogCase[];
  private readonly cache: Cache;
  private readonly physio: PhysioScorer;

  constructor(private readonly split: Split, private readonly model: SimBehaviorModel, physio: PhysioScorer, private readonly hours = 3) {
    const manifest = loadManifest();
    const { imu: imuIds, hr: hrIds } = SPLIT_DOGS[split];
    this.dogs = imuIds.map((imuId, i) => {
      const hrId = hrIds[i % hrIds.length];
      const imu = loadImu("vehkaoja2022", imuId);
      const subject = manifest.imu.vehkaoja2022?.find((s) => s.subjectId === imuId);
      const stats = subject?.imuMean && subject?.imuStd ? { mean: subject.imuMean, std: subject.imuStd } : imuStats(imu);
      return { key: `${split}-${imuId}-${hrId}`, imuId, hrId, imu, hr: loadHr("invoxia2023", hrId), mean: stats.mean, std: stats.std };
    });
    this.cache = new Cache(path.join(CACHE_DIR, `${split}-${model.meta.version}-${physio.meta.version}.json`));
    this.physio = this.cache.scorer(physio);
  }

  get description(): string {
    return `${this.dogs.length} perros de ${this.split === "val" ? "validación" : "prueba"} (${this.dogs.map((d) => `IMU ${d.imuId} + FC ${d.hrId}`).join(", ")})`;
  }

  /** Softmax of every window of the blocks, from the cache or computed in large batches (one TF.js call per dog). */
  private blockProbs(d: DogCase, blocks: Block[], tag: string): number[][][] {
    const keyOf = (b: Block) => `${d.imuId}|${b.index}${tag && b.truth.length ? tag : ""}`;
    const missing = blocks.filter((b) => !this.cache.has(keyOf(b)));
    if (missing.length) {
      const per = missing[0].imu.length;
      const all = new Float32Array(missing.length * per);
      missing.forEach((b, i) => all.set(b.imu, i * per));
      const probs = this.model.predict(all, d.mean, d.std);
      const w = probs.length / missing.length;
      missing.forEach((b, i) => this.cache.put(keyOf(b), probs.slice(i * w, (i + 1) * w)));
    }
    return blocks.map((b) => this.cache.get(keyOf(b))!);
  }

  private replay(d: DogCase, cfg: EngineConfig, nBlocks: number, injection?: { type: AnomalyType; durationS: number; magnitude?: number }) {
    const stream = new DogStream(d.key, d.imu, d.hr.values, { hrBreaks: d.hr.breaks });
    if (!this.cache.has(`${d.imuId}|baseline`)) this.cache.put(`${d.imuId}|baseline`, this.model.predict(d.imu, d.mean, d.std));
    const active = this.cache.get(`${d.imuId}|baseline`)!
      .map((p) => (this.model.meta.activeClasses.includes(this.model.meta.classes[p.indexOf(Math.max(...p))]) ? 1 : 0));
    const baseline = computeBaseline(d.imu, d.hr.values, stream.temperatureStats, cfg,
      { version: this.model.meta.version, active, imuMean: d.mean, imuStd: d.std });
    let tag = "";
    if (injection) {
      const mag = injection.magnitude ?? ANOMALY_CATALOG.types[injection.type].default;
      stream.injections.push(schedule("eval", injection.type, mag, injection.durationS, START_BLOCK));
      tag = ANOMALY_CATALOG.types[injection.type].signal === "imu" ? `|${injection.type}:${mag}` : "";
    }
    const blocks = Array.from({ length: nBlocks }, (_, k) => stream.block(k));
    const probs = this.blockProbs(d, blocks, tag);
    let state = initialState();
    const opened: { k: number; components: string[] }[] = [];
    const flagged: number[] = [];
    const component = injection ? COMPONENT[ANOMALY_CATALOG.types[injection.type].signal] : null;
    for (let k = 0; k < nBlocks; k++) {
      const b = blocks[k];
      const ev = evaluateBlock({ imu: b.imu, hr: b.hr, temp: b.temp, blockStartMs: k * BLOCK_SECONDS * 1000,
        behavior: { meta: this.model.meta, probs: probs[k] }, physio: this.physio }, state, baseline, cfg, { alertId: String(k) });
      if (ev.alert?.action === "open") opened.push({ k, components: ev.alert.reasons.map((r) => r.component) });
      if (ev.alert && component && ev.alert.reasons.some((r) => r.component === component)) flagged.push(k);
      state = ev.state;
    }
    return { opened, flagged };
  }

  /** magnitudes: per anomaly type, instead of the catalog's default (to see how detection depends on it). */
  run(overrides: Partial<FusionConfig>, magnitudes: Partial<Record<AnomalyType, number>> = {}): Outcome {
    const cfg = { ...DEFAULT_FUSION_CONFIG, ...overrides } as EngineConfig;
    const blocks = Math.round((this.hours * 3600) / BLOCK_SECONDS);
    let falseAlerts = 0;
    const falseByComponent: Record<string, number> = {};
    for (const d of this.dogs) {
      for (const a of this.replay(d, cfg, blocks).opened) {
        falseAlerts++;
        for (const c of new Set(a.components)) falseByComponent[c] = (falseByComponent[c] ?? 0) + 1;
      }
    }
    const dogHours = this.dogs.length * this.hours;
    const detection: Outcome["detection"] = {};
    for (const t of TYPES) {
      const dur = DURATION_S[t], endBlock = START_BLOCK + dur / BLOCK_SECONDS;
      let detected = 0, delay = 0;
      for (const d of this.dogs) {
        const { flagged } = this.replay(d, cfg, endBlock + 12, { type: t, durationS: dur, magnitude: magnitudes[t] });
        const first = flagged.find((k) => k >= START_BLOCK && k < endBlock + 6);
        if (first != null) { detected++; delay += (first - START_BLOCK) * BLOCK_SECONDS; }
      }
      detection[t] = { detected, dogs: this.dogs.length, meanDelayS: detected ? Math.round(delay / detected) : null };
    }
    this.cache.save();
    return {
      falseAlertsPerDogHour: falseAlerts / dogHours,
      falseByComponent: Object.fromEntries(Object.entries(falseByComponent).map(([k, v]) => [k, v / dogHours])),
      detection,
      minDetectionRate: Math.min(...Object.values(detection).map((x) => x.detected / x.dogs)),
    };
  }
}

const fmt2 = (x: number) => x.toFixed(2);
export function formatOutcome(name: string, o: Outcome): string {
  const comps = Object.entries(o.falseByComponent).map(([k, v]) => `${k} ${fmt2(v)}`).join(", ") || "—";
  const det = TYPES.map((t) => { const x = o.detection[t]; return `${t} ${x.detected}/${x.dogs}${x.meanDelayS != null ? ` (${x.meanDelayS} s)` : ""}`; }).join(" · ");
  return `${name}\n  falsas alarmas/perro-h ${fmt2(o.falseAlertsPerDogHour)} [${comps}]\n  detección: ${det}`;
}

/** Candidate rules for the search. Each one is applied over the production defaults. */
export function searchGrid(): Partial<FusionConfig>[] {
  const out: Partial<FusionConfig>[] = [];
  for (const alertMinDurationS of [0, 60, 120, 180, 300]) {
    for (const levelSigma of [2, 2.5, 3, 3.5]) {
      for (const activityCriticalSigma of [null, 1.5, 2, 2.5]) {
        for (const criticalRatio of [undefined, 10, Number.POSITIVE_INFINITY]) {
          out.push({ alertMinDurationS, activityCriticalSigma, physio: { levelSigma, ...(criticalRatio != null ? { criticalRatio } : {}) } });
        }
      }
    }
  }
  return out;
}

export function describeConfig(c: Partial<FusionConfig>): string {
  const p = c.physio ?? {};
  return [`persistencia ${c.alertMinDurationS ?? 0} s`, `FC ±${p.levelSigma ?? "σ base"}σ`,
    `actividad ${c.activityCriticalSigma == null ? "sin regla" : `−${c.activityCriticalSigma}σ`}`,
    `autoencoder crítico ${p.criticalRatio == null ? "del modelo" : Number.isFinite(p.criticalRatio) ? p.criticalRatio : "sin regla"}`,
    ...(c.hrAverageS ? [`FC promedio ${c.hrAverageS} s`] : []), ...(c.alertThreshold ? [`umbral HS ${c.alertThreshold}`] : [])].join(" · ");
}
