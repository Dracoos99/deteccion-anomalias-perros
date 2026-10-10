/**
 * Simulator CLI. Examples (from simulator/, with the emulators running):
 *   npm run sim -- start --dogs toby,luna,rocky --speed 10 --minutes 30
 *   npm run sim -- start --dogs nala --speed 10 --learn   # a «new dog»: the Function learns its baseline
 *   npm run sim -- inject --run <runId> --dog rocky --type fever --magnitude 1.5 --duration 600
 *   npm run sim -- pause|resume|stop --run <runId>
 *   npm run sim -- speed --run <runId> --value 5
 *   npm run sim -- serve            # executes the runs created from the admin panel (screen 8)
 *   npm run sim -- job --run <runId> # executes one run and exits
 *   npm run sim -- status [--run <runId>]
 *   npm run sim -- report --run <runId> [--json]
 *   npm run sim -- subjects         # subjects available in the exported data
 *   npm run sim -- sweep [--hours 2] # offline sweep of the alert rules (no Firestore)
 *   npm run sim -- validation-report # from
 *   npm run sim -- sweep --physio [--ratios inf:3.81,6.9:12.8] [--cache f.json] # HR rule alone vs rule + autoencoder
 *   npm run sim -- evaluate [--split val|test] [--hours 3] [--search] [--config '{...}'] [--out f.json] # rules with both models
 */
import os from "node:os";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { PROJECT_ID, USING_EMULATORS } from "./config";
import { loadManifest } from "./data";
import { SimulatorRun, createRun, runJob, serveRuns } from "./run";
import { fetchRunData, jobWorkerId } from "./cloud";
import { buildReport, formatReport } from "./report";
import { runPhysioSweep, runSweep } from "./sweep";
import { Evaluator, describeConfig, formatOutcome, searchGrid, type Outcome, type Split } from "./evaluate";
import { loadSimBehaviorModel } from "./behavior";
import fs from "node:fs";
import type { FusionConfig } from "../../shared/types";
import { loadSimPhysioModel } from "./physio";
import { ANOMALY_CATALOG, ANOMALY_TYPES, validateInjection } from "../../shared/anomalies";
import type { AnomalyType, SimulatorRunDoc } from "../../shared/types";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dogs: { type: "string" }, speed: { type: "string" }, minutes: { type: "string" }, run: { type: "string" },
    dog: { type: "string" }, type: { type: "string" }, magnitude: { type: "string" }, duration: { type: "string" },
    value: { type: "string" }, json: { type: "boolean" }, rebaseline: { type: "boolean" }, "run-id": { type: "string" }, learn: { type: "boolean" }, truth: { type: "boolean" },
    hours: { type: "string" }, physio: { type: "boolean" }, ratios: { type: "string" }, cache: { type: "string" },
    split: { type: "string" }, search: { type: "boolean" }, config: { type: "string" }, out: { type: "string" }, val: { type: "string" }, test: { type: "string" }, magnitudes: { type: "string" },
  },
});

const workerId = `${os.hostname()}-${process.pid}`;

function db(): Firestore {
  initializeApp({ projectId: PROJECT_ID });
  if (!USING_EMULATORS) console.log(`Atención: proyecto real ${PROJECT_ID} (escrituras con costo).`);
  return getFirestore();
}

function need(name: string, v: string | undefined): string {
  if (!v) throw new Error(`Falta --${name}.`);
  return v;
}

async function setRun(runId: string, update: Partial<SimulatorRunDoc>): Promise<void> {
  await db().doc(`simulatorRuns/${runId}`).update(update);
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  switch (cmd) {
    case "start": {
      const firestore = db();
      const dogIds = need("dogs", values.dogs).split(",").map((s) => s.trim()).filter(Boolean);
      const speed = Number(values.speed ?? 1);
      const durationS = values.minutes ? Math.round(Number(values.minutes) * 60) : null;
      const runId = await createRun(firestore, { dogIds, speed, durationS, createdBy: "cli", runId: values["run-id"], worker: workerId, learnBaseline: values.learn, recordTruth: values.truth });
      console.log(`Ejecución ${runId}. Detén con Ctrl+C o: npm run sim -- stop --run ${runId}`);
      const run = new SimulatorRun(firestore, runId, { workerId, rebaseline: values.rebaseline });
      process.once("SIGINT", () => void run.stop("Ctrl+C"));
      await run.start();
      await run.done;
      break;
    }
    case "serve": {
      const stop = serveRuns(db(), { workerId });
      console.log(`Esperando ejecuciones creadas desde el panel (worker ${workerId}). Ctrl+C para salir.`);
      await new Promise<void>((resolve) => process.once("SIGINT", async () => { await stop(); resolve(); }));
      break;
    }
    case "job": {
      // Cloud Run job: SIM_DATA_URI points to the prepared signals in Cloud Storage.
      const runId = need("run", values.run);
      const firestore = db();
      const dataDir = process.env.SIM_DATA_URI ? await fetchRunData(firestore, runId, process.env.SIM_DATA_URI) : undefined;
      const outcome = await runJob(firestore, runId, {
        workerId: process.env.CLOUD_RUN_JOB ? jobWorkerId() : workerId, dataDir,
        // Cloud Run sends SIGTERM when the job is cancelled or times out: the run is stopped, not left claimed.
        onRun: (run) => process.once("SIGTERM", () => void run.stop("el job se detuvo")),
      });
      console.log(outcome === "not_claimed" ? `La ejecución ${runId} ya la tomó otro proceso (o terminó).` : `Ejecución ${runId}: ${outcome}.`);
      process.exitCode = outcome === "failed" ? 1 : 0;
      break;
    }
    case "inject": {
      const type = need("type", values.type);
      const spec = ANOMALY_CATALOG.types[type as keyof typeof ANOMALY_CATALOG.types];
      const magnitude = values.magnitude != null ? Number(values.magnitude) : spec?.default;
      const durationS = Number(values.duration ?? 600);
      validateInjection(type, magnitude, durationS);
      await setRun(need("run", values.run), { pendingInjection: { dogId: need("dog", values.dog), type, magnitude, durationS } });
      console.log(`Inyección enviada: ${spec.label}, magnitud ${magnitude}, ${durationS} s.`);
      break;
    }
    case "pause": case "resume": case "stop": {
      await setRun(need("run", values.run), { state: cmd === "pause" ? "paused" : cmd === "resume" ? "running" : "stopped" });
      console.log(`Estado enviado: ${cmd}.`);
      break;
    }
    case "speed": {
      const v = Number(need("value", values.value));
      if (!(v >= 1 && v <= 10)) throw new Error("La velocidad debe estar entre 1 y 10.");
      await setRun(need("run", values.run), { speed: v });
      break;
    }
    case "status": {
      const firestore = db();
      const docs = values.run ? [await firestore.doc(`simulatorRuns/${values.run}`).get()]
        : (await firestore.collection("simulatorRuns").orderBy("createdAt", "desc").limit(10).get()).docs;
      for (const d of docs) {
        const r = d.data() as SimulatorRunDoc | undefined;
        if (!r) continue;
        console.log(`${d.id}  ${r.state.padEnd(8)} ×${r.speed}  perros: ${r.dogIds.join(",")}  bloques: ${r.stats.blocksWritten}  latencia media: ${r.stats.avgLatencyMs ?? "—"} ms  worker: ${r.worker?.id ?? "—"}${r.error ? `  error: ${r.error}` : ""}`);
      }
      break;
    }
    case "report": {
      const report = await buildReport(db(), need("run", values.run));
      console.log(values.json ? JSON.stringify(report, null, 1) : formatReport(report));
      process.exitCode = report.ok ? 0 : 1;
      break;
    }
    case "sweep": {
      if (values.physio) {
        const physio = await loadSimPhysioModel();
        if (!physio) throw new Error("No está el modelo fisiológico en functions/models/physio (ml: python -m src.train_physio).");
        const pairs = values.ratios?.split(",").map((p): [number, number] => {
          const [c, f] = p.split(":");
          return [c === "inf" ? Number.POSITIVE_INFINITY : Number(c), f ? Number(f) : physio.meta.fullScaleRatio];
        });
        runPhysioSweep(physio, Number(values.hours ?? 2), pairs, values.cache);
      } else runSweep(Number(values.hours ?? 2));
      break;
    }
    case "evaluate": {
      const model = await loadSimBehaviorModel();
      const physio = await loadSimPhysioModel();
      if (!model || !physio) throw new Error("Faltan los modelos en functions/models (behavior y physio).");
      const split = (values.split ?? "val") as Split;
      if (split !== "val" && split !== "test") throw new Error("--split debe ser val o test.");
      const hours = Number(values.hours ?? 3);
      const ev = new Evaluator(split, model, physio, hours);
      // «--magnitudes min» injects each anomaly at the smallest magnitude of the catalog (the hardest case).
      const magnitudes: Partial<Record<AnomalyType, number>> = values.magnitudes === "min"
        ? Object.fromEntries(ANOMALY_TYPES.filter((t) => t !== "collar_off").map((t) => [t, ANOMALY_CATALOG.types[t].min])) : {};
      console.log(`Modelos: ${model.meta.version} y ${physio.meta.version} · ${ev.description} · ${hours} h normales por perro\n`);
      // JSON has no Infinity: "inf" turns the autoencoder's critical rule off.
      const parse = (text: string): Partial<FusionConfig> => JSON.parse(text, (k, v) => (v === "inf" ? Number.POSITIVE_INFINITY : v));
      const results: { config: Partial<FusionConfig>; outcome: Outcome }[] = [];
      const current = ev.run({}, magnitudes);
      console.log(formatOutcome("Configuración actual", current));
      results.push({ config: {}, outcome: current });
      const candidates = values.search ? searchGrid() : values.config ? [parse(values.config)] : [];
      candidates.forEach((c, i) => {
        const o = ev.run(c, magnitudes);
        results.push({ config: c, outcome: o });
        if (!values.search) console.log(formatOutcome(describeConfig(c), o));
        else if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${candidates.length} configuraciones`);
      });
      if (values.search) {
        // Every anomaly detected in every dog first; then the fewest false alerts; then the quickest detection.
        const delay = (o: Outcome) => Object.values(o.detection).reduce((a, x) => a + (x.meanDelayS ?? 1e6), 0);
        const ranked = results.slice(1).sort((a, b) => b.outcome.minDetectionRate - a.outcome.minDetectionRate
          || a.outcome.falseAlertsPerDogHour - b.outcome.falseAlertsPerDogHour || delay(a.outcome) - delay(b.outcome));
        console.log("\nMejores configuraciones:");
        for (const r of ranked.slice(0, 12)) console.log(formatOutcome(describeConfig(r.config), r.outcome));
      }
      if (values.out) {
        fs.writeFileSync(values.out, JSON.stringify({ split, hours, models: [model.meta.version, physio.meta.version], magnitudes, results },
          (k, v) => (v === Number.POSITIVE_INFINITY ? "inf" : v), 1));
        console.log(`\nResultados en ${values.out}`);
      }
      break;
    }
    case "validation-report": {
      // from the two outputs of `evaluate --out` (validation and test dogs).
      // A report generator, like ml/src/report.py: loaded only when this command runs.
      const generator = "./validation-report";
      const { writeValidationReport } = await import(generator);
      writeValidationReport(values.val, values.test, values.out);
      break;
    }
    case "subjects": {
      const m = loadManifest();
      console.log("IMU (Vehkaoja 2022):", m.imu.vehkaoja2022.map((s) => `${s.subjectId} (${s.minutes} min)`).join(", "));
      for (const [src, list] of Object.entries(m.hr)) console.log(`FC (${src}):`, list.map((s) => `${s.subjectId} (${s.hours} h, ${s.hrMean} lpm)`).join(", "));
      break;
    }
    default:
      console.log("Comandos: start, serve, job, inject, pause, resume, stop, speed, status, report, subjects, sweep, evaluate. Ver el encabezado de src/cli.ts.");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().then(() => {
  process.exit(process.exitCode ?? 0);
}).catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
