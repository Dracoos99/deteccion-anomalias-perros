/**
 * Run report for the phase 1 exit criterion (10 dogs, 30 min, no lost blocks; latency measured in the emulator) and
 * for the provisional rules: which injections opened an alert and how many alerts opened without any injection.
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { BLOCK_SECONDS } from "./config";
import { summarize } from "./stats";
import type { SimulatorRunDoc } from "../../shared/types";

export interface DogReport {
  dogId: string;
  readings: number;
  results: number;
  missingResults: string[];
  blockGaps: number[];
  alertsOpened: { id: string; block: number; severity: string; components: string[]; duringInjection: string | null }[];
  levels: Record<string, number>;
}

export interface RunReport {
  runId: string;
  state: string;
  speed: number;
  dogs: DogReport[];
  blocksExpected: number | null;
  readings: number;
  results: number;
  lostBlocks: number;
  latency: ReturnType<typeof summarize>;
  simulatedMinutes: number;
  injections: { id: string; dogId: string; type: string; startBlock: number; endBlock: number; detected: boolean; firstAlertBlock: number | null }[];
  alertsWithoutInjection: number;
  /** Share of each predicted behavior in the results (null predictions excluded). */
  behaviorShare: Record<string, number>;
  ok: boolean;
}

const blockOf = (id: string) => Number(id.slice(id.lastIndexOf("_") + 1));

export async function buildReport(db: Firestore, runId: string): Promise<RunReport> {
  const runSnap = await db.doc(`simulatorRuns/${runId}`).get();
  if (!runSnap.exists) throw new Error(`No existe la ejecución ${runId}.`);
  const run = runSnap.data() as SimulatorRunDoc<Timestamp>;
  const [readings, results] = await Promise.all([
    db.collection("readings").where("sourceRef", "==", runId).select("dogId").get(),
    db.collection("results").where("sourceRef", "==", runId).select("dogId", "latencyMs", "level", "predictedBehavior").get(),
  ]);
  const resultIds = new Set(results.docs.map((d) => d.id));
  const alertSnaps = await db.collection("alerts").where("dogId", "in", run.dogIds).get();
  const alerts = alertSnaps.docs.filter((d) => d.id.startsWith(`${runId}_`));
  const log = run.injectionsLog ?? [];

  const dogs: DogReport[] = run.dogIds.map((dogId) => {
    const rs = readings.docs.filter((d) => d.get("dogId") === dogId).map((d) => d.id).sort();
    const blocks = rs.map(blockOf).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 0, expect = 0; i < blocks.length; i++, expect++) {
      while (blocks[i] > expect) gaps.push(expect++);
    }
    const levels: Record<string, number> = {};
    for (const r of results.docs.filter((d) => d.get("dogId") === dogId)) levels[r.get("level")] = (levels[r.get("level")] ?? 0) + 1;
    const opened = alerts.filter((a) => a.get("dogId") === dogId).map((a) => {
      const block = blockOf(a.id);
      const inj = log.find((j) => j.dogId === dogId && block >= j.startBlock && block < j.endBlock + 6);  // +1 min: 60 s average
      return { id: a.id, block, severity: a.get("severity"), components: (a.get("reasons") ?? []).map((r: { component: string }) => r.component), duringInjection: inj?.id ?? null };
    }).sort((a, b) => a.block - b.block);
    return { dogId, readings: rs.length, results: rs.filter((id) => resultIds.has(id)).length,
      missingResults: rs.filter((id) => !resultIds.has(id)), blockGaps: gaps, alertsOpened: opened, levels };
  });

  const injections = log.map((j) => {
    const first = dogs.find((d) => d.dogId === j.dogId)?.alertsOpened.find((a) => a.duringInjection === j.id);
    return { id: j.id, dogId: j.dogId, type: j.type, startBlock: j.startBlock, endBlock: j.endBlock, detected: !!first, firstAlertBlock: first?.block ?? null };
  });
  const blocksExpected = run.durationS ? Math.ceil(run.durationS / BLOCK_SECONDS) * run.dogIds.length : null;
  const lost = dogs.reduce((n, d) => n + d.blockGaps.length + d.missingResults.length, 0);
  const latency = summarize(results.docs.map((d) => d.get("latencyMs") as number).filter(Number.isFinite));
  const counts: Record<string, number> = {};
  for (const d of results.docs) { const b = d.get("predictedBehavior"); if (b) counts[b] = (counts[b] ?? 0) + 1; }
  const predicted = Object.values(counts).reduce((a, b) => a + b, 0);
  const behaviorShare = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / predicted) * 1000) / 1000]));
  return {
    runId, state: run.state, speed: run.speed, dogs, blocksExpected, readings: readings.size, results: results.size, lostBlocks: lost,
    latency, simulatedMinutes: Math.round((Math.max(0, ...dogs.map((d) => d.readings)) * BLOCK_SECONDS) / 60),
    injections, alertsWithoutInjection: dogs.reduce((n, d) => n + d.alertsOpened.filter((a) => !a.duringInjection).length, 0), behaviorShare,
    ok: lost === 0 && (blocksExpected == null || readings.size === blocksExpected),
  };
}

export function formatReport(r: RunReport): string {
  const lines = [
    `Ejecución ${r.runId} (${r.state}, ×${r.speed}): ${r.dogs.length} perros, ${r.simulatedMinutes} min simulados`,
    `Bloques: ${r.readings} escritos${r.blocksExpected != null ? ` de ${r.blocksExpected} esperados` : ""}, ${r.results} con resultado, ${r.lostBlocks} perdidos`,
    `Latencia (escritura → resultado, emulador): media ${r.latency.avgMs ?? "—"} ms · p50 ${r.latency.p50Ms ?? "—"} · p95 ${r.latency.p95Ms ?? "—"} · máx ${r.latency.maxMs ?? "—"} ms`,
  ];
  for (const d of r.dogs) {
    lines.push(`  ${d.dogId.padEnd(8)} ${String(d.readings).padStart(5)} bloques · niveles ${JSON.stringify(d.levels)} · alertas ${d.alertsOpened.length}` +
      (d.blockGaps.length ? ` · huecos ${d.blockGaps.join(",")}` : "") + (d.missingResults.length ? ` · sin resultado ${d.missingResults.length}` : ""));
  }
  for (const j of r.injections) lines.push(`  inyección ${j.type} en ${j.dogId} (bloques ${j.startBlock}–${j.endBlock - 1}): ${j.detected ? `alerta en el bloque ${j.firstAlertBlock}` : "sin alerta"}`);
  lines.push(`Alertas sin anomalía inyectada (reglas provisionales): ${r.alertsWithoutInjection}`);
  if (Object.keys(r.behaviorShare).length) lines.push(`Conductas predichas: ${Object.entries(r.behaviorShare).map(([k, v]) => `${k} ${Math.round(v * 100)} %`).join(", ")}`);
  lines.push(r.ok ? "Resultado: OK, sin bloques perdidos." : "Resultado: FALLA, hay bloques perdidos o faltantes.");
  return lines.join("\n");
}
