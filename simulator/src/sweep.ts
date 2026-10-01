/**
 * Offline sweep of the provisional alert rules (no Firestore): replays simulated dogs through shared/engine.ts to
 * measure, per configuration, alerts per dog-hour without any injection and detection of the catalog anomalies.
 * Input for the pending decision on critical rules (C4) and weights (C3). Values are simulation results with
 * provisional rules, not clinical performance.
 *
 *   npm run sim -- sweep [--hours 2]
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { BLOCK_SECONDS } from "./config";
import { loadHr, loadImu } from "./data";
import { DogStream } from "./stream";
import { computeBaseline } from "./baseline";
import { ANOMALY_CATALOG, schedule } from "../../shared/anomalies";
import { evaluateBlock, initialState, type EngineConfig } from "../../shared/engine";
import type { PhysioScorer } from "../../shared/physio-model";
import { DEFAULT_FUSION_CONFIG, type AnomalyType } from "../../shared/types";

/** Same subject pairs as scripts/seed-emulator.mjs (Vehkaoja IMU, Invoxia HR). */
export const SEED_SUBJECTS: [string, string, string][] = [
  ["toby", "23", "30"], ["luna", "16", "8"], ["rocky", "29", "0"], ["bruno", "74", "24"], ["canela", "39", "11"],
  ["max", "47", "10"], ["nala", "26", "9"], ["kira", "30", "12"], ["simba", "41", "18"], ["coco", "27", "13"],
];

interface Variant { name: string; cfg: EngineConfig }

function replay(dog: [string, string, string], cfg: EngineConfig, blocks: number, injection?: { type: AnomalyType; startBlock: number; durationS: number },
  physio: PhysioScorer | null = null) {
  const [id, imuId, hrId] = dog;
  const imu = loadImu("vehkaoja2022", imuId), hr = loadHr("invoxia2023", hrId);
  const stream = new DogStream(id, imu, hr.values, { hrBreaks: hr.breaks });
  const baseline = computeBaseline(imu, hr.values, stream.temperatureStats, cfg);
  if (injection) stream.injections.push(schedule("sweep", injection.type, DEFAULT_MAGNITUDE[injection.type], injection.durationS, injection.startBlock));
  let state = initialState();
  const opened: number[] = [];
  let hrOpened = 0;              // opened alerts that name the heart rate
  const flagged: number[] = [];  // blocks where an alert (new or updated) names the injected signal
  const component = injection ? COMPONENT[ANOMALY_CATALOG.types[injection.type].signal] : null;
  for (let k = 0; k < blocks; k++) {
    const b = stream.block(k);
    const ev = evaluateBlock({ imu: b.imu, hr: b.hr, temp: b.temp, blockStartMs: k * BLOCK_SECONDS * 1000, physio }, state, baseline, cfg,
      { alertId: String(k) });
    if (ev.alert?.action === "open") {
      opened.push(k);
      if (ev.alert.reasons.some((r) => r.component === "heart_rate")) hrOpened++;
    }
    if (ev.alert && component && ev.alert.reasons.some((r) => r.component === component)) flagged.push(k);
    state = ev.state;
  }
  return { opened, flagged, hrOpened };
}

const COMPONENT = { imu: "behavior", hr: "heart_rate", temp: "temperature" } as const;

const DEFAULT_MAGNITUDE: Record<AnomalyType, number> = {
  activity_drop: 0.6, immobility: 0.97, tachycardia: 0.4, bradycardia: 0.3, fever: 1.5, hypothermia: 1.5,
};

export function runSweep(hours = 2, log: (s: string) => void = console.log): void {
  const base = DEFAULT_FUSION_CONFIG as EngineConfig;
  const variants: Variant[] = [];
  for (const sigma of [2, 2.5, 3]) {
    for (const windows of [2, 15, 30]) {
      variants.push({ name: `σ ${sigma} · ${windows} ventanas (${windows * 2} s)`, cfg: { ...base, baselineSigma: sigma, consecutiveCritical: windows } });
    }
  }
  const blocks = Math.round((hours * 3600) / BLOCK_SECONDS);
  const start = 90, durationS = 600;  // injection at minute 15, for 10 minutes
  const types: AnomalyType[] = ["tachycardia", "bradycardia", "fever", "hypothermia", "activity_drop", "immobility"];
  log(`Perros: ${SEED_SUBJECTS.length} · ${hours} h sin anomalías por perro · inyecciones de 10 min (magnitud por defecto) desde el minuto 15\n`);
  log(["Configuración", "Alertas/perro-h sin anomalía", ...types.map((t) => `${t} (detectadas, retardo medio)`)].join(" | "));
  for (const v of variants) {
    let falseAlerts = 0;
    for (const d of SEED_SUBJECTS) falseAlerts += replay(d, v.cfg, blocks).opened.length;
    const cells = types.map((t) => {
      let detected = 0, delay = 0;
      for (const d of SEED_SUBJECTS) {
        const { flagged } = replay(d, v.cfg, start + 60 + 12, { type: t, startBlock: start, durationS });
        const first = flagged.find((k) => k >= start && k < start + 60 + 6);
        if (first != null) { detected++; delay += (first - start) * BLOCK_SECONDS; }
      }
      return `${detected}/${SEED_SUBJECTS.length}${detected ? `, ${Math.round(delay / detected)} s` : ""}`;
    });
    log([v.name, (falseAlerts / (SEED_SUBJECTS.length * hours)).toFixed(2), ...cells].join(" | "));
  }
}

/**
 * Heart-rate rule alone vs rule plus the autoencoder. For each level of the rule, the autoencoder with
 * several ramps and critical rules, given as "criticalRatio:fullScaleRatio" pairs ("inf" = no critical rule).
 *   npm run sim -- sweep --physio [--hours 2] [--ratios inf:3.81,2.4:3.81,6.9:12.8] [--cache file.json]
 */
export function runPhysioSweep(model: PhysioScorer, hours = 2, pairs: [number, number][] = [[model.meta.criticalRatio, model.meta.fullScaleRatio]],
  cacheFile?: string, log: (s: string) => void = console.log): void {
  // The sequences do not depend on the configuration: each one is scored once (and kept on disk with --cache).
  const memo = new Map<string, number>(cacheFile && fs.existsSync(cacheFile) ? Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8"))) : []);
  const key = (z: Float32Array) => createHash("sha1").update(new Uint8Array(z.buffer, z.byteOffset, z.byteLength)).digest("base64");
  const physio: PhysioScorer = {
    meta: model.meta,
    score(batch) {
      const keys = batch.map(key);
      const missing = batch.filter((_, i) => !memo.has(keys[i]));
      const errors = model.score(missing);
      batch.forEach((_, i) => { if (!memo.has(keys[i])) memo.set(keys[i], errors.shift()!); });
      return keys.map((k) => memo.get(k)!);
    },
  };
  const base = DEFAULT_FUSION_CONFIG as EngineConfig;
  const blocks = Math.round((hours * 3600) / BLOCK_SECONDS);
  const start = 90, durationS = 600;
  const types: AnomalyType[] = ["tachycardia", "bradycardia"];
  const fmtRatio = (r: number) => (Number.isFinite(r) ? String(r) : "sin regla crítica");
  log(`Perros: ${SEED_SUBJECTS.length} · ${hours} h sin anomalías por perro · taquicardia y bradicardia de 10 min (magnitud por defecto) desde el minuto 15`);
  log(`Modelo: ${physio.meta.version} (umbral p95 ${physio.meta.threshold}; del modelo: criticalRatio ${physio.meta.criticalRatio}, fullScaleRatio ${physio.meta.fullScaleRatio})\n`);
  log(["Configuración", "Alertas/perro-h sin anomalía", "Alertas de FC/perro-h", ...types.map((t) => `${t} (detectadas, retardo medio)`)].join(" | "));
  for (const sigma of [2, 2.5, 3]) {
    const variants: [string, PhysioScorer | null, EngineConfig["physio"] | null][] = [
      ["solo regla", null, null],
      ...pairs.map(([criticalRatio, fullScaleRatio]): [string, PhysioScorer, EngineConfig["physio"]] =>
        [`autoencoder (crítico ${fmtRatio(criticalRatio)}, escala ${fullScaleRatio})`, physio, { criticalRatio, fullScaleRatio }]),
    ];
    for (const [name, pm, physioCfg] of variants) {
      const cfg: EngineConfig = { ...base, baselineSigma: sigma, ...(physioCfg ? { physio: physioCfg } : {}) };
      let opened = 0, hrOpened = 0;
      for (const d of SEED_SUBJECTS) {
        const r = replay(d, cfg, blocks, undefined, pm);
        opened += r.opened.length;
        hrOpened += r.hrOpened;
      }
      const cells = types.map((t) => {
        let detected = 0, delay = 0;
        for (const d of SEED_SUBJECTS) {
          const { flagged } = replay(d, cfg, start + 60 + 12, { type: t, startBlock: start, durationS }, pm);
          const first = flagged.find((k) => k >= start && k < start + 60 + 6);
          if (first != null) { detected++; delay += (first - start) * BLOCK_SECONDS; }
        }
        return `${detected}/${SEED_SUBJECTS.length}${detected ? `, ${Math.round(delay / detected)} s` : ""}`;
      });
      const perHour = (n: number) => (n / (SEED_SUBJECTS.length * hours)).toFixed(2);
      log([`σ ${sigma} · ${name}`, perHour(opened), perHour(hrOpened), ...cells].join(" | "));
      if (cacheFile && pm) fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(memo)));
    }
  }
}
