/**
 * Execution of one simulatorRuns/{runId} document.
 * - Writes one reading per dog every 10 s / speed, with deterministic ids and create: a retry never duplicates and a
 *   failed write is retried on the next tick with the same block, so no block is lost (RNF-02).
 * - Follows the run document: state (running | paused | stopped), speed, durationS and pendingInjection.
 * - Follows results of the run to measure latency (results.latencyMs) and publishes stats in the run document.
 */
import os from "node:os";
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import {
  BLOCK_SECONDS, MAX_DOGS_PER_RUN, READING_TTL_DAYS, SCHEMA_VERSION, STATS_FLUSH_MS, SUB_BLOCK_MAX_SPEED, WINDOWS_PER_BLOCK, WINDOW_SECONDS, readingId,
} from "./config";
import { HR_DATASETS, IMU_DATASETS, loadHr, loadImu, loadManifest } from "./data";
import { loadSimBehaviorModel } from "./behavior";
import { imuStats } from "../../shared/behavior-model";
import { DogStream, splitBlock, type Block } from "./stream";
import { LatencyStats } from "./stats";
import { computeBaseline } from "./baseline";
import { ANOMALY_CATALOG, schedule } from "../../shared/anomalies";
import type { EngineConfig } from "../../shared/engine";
import { DEFAULT_FUSION_CONFIG, type DogDoc, type FusionConfig, type InjectionRequest, type SimulatorRunDoc } from "../../shared/types";

type RunState = SimulatorRunDoc["state"];
/** next: 10 s block of the stream; parts: that block as it goes out.
 * awaiting: id of the dog's last block while its result has not arrived. */
interface SimDog { stream: DogStream; name: string; ownerId: string; next: number; parts: Block[] | null; sub: number;
  awaiting: string | null; awaitingSince: number }

/** A dog's next block waits for the result of the previous one at most this long (then it goes out anyway). */
const RESULT_WAIT_MS = 30_000;

export interface RunOptions {
  workerId: string;
  rebaseline?: boolean;
  dataDir?: string;
  /** How long finish() waits for the results of the last blocks (0 when no Functions emulator is running). */
  drainMs?: number;
  log?: (msg: string) => void;
}

export async function loadConfig(db: Firestore): Promise<EngineConfig> {
  const snap = await db.doc("config/fusion").get();
  return { ...DEFAULT_FUSION_CONFIG, ...(snap.data() as Partial<FusionConfig> | undefined) } as EngineConfig;
}

export function validateRunRequest(dogIds: string[], speed: number): void {
  if (dogIds.length < 1 || dogIds.length > MAX_DOGS_PER_RUN) throw new Error(`Una ejecución admite de 1 a ${MAX_DOGS_PER_RUN} perros.`);
  if (new Set(dogIds).size !== dogIds.length) throw new Error("Hay perros repetidos en la ejecución.");
  if (!(speed >= 1 && speed <= 10)) throw new Error("La velocidad debe estar entre 1 y 10.");
}

/** Creates a run document. worker is set when the caller will execute it; null leaves it for a `serve` process. */
export async function createRun(db: Firestore, req: { dogIds: string[]; speed: number; durationS?: number | null; createdBy: string; runId?: string; worker?: string | null }): Promise<string> {
  validateRunRequest(req.dogIds, req.speed);
  const ref = req.runId ? db.doc(`simulatorRuns/${req.runId}`) : db.collection("simulatorRuns").doc();
  await ref.create({
    createdBy: req.createdBy, dogIds: req.dogIds, speed: req.speed, state: "running", durationS: req.durationS ?? null, seed: 0,
    pendingInjection: null, injectionsLog: [], error: null,
    worker: req.worker ? { id: req.worker, host: os.hostname(), heartbeatAt: Timestamp.now() } : null,
    stats: { blocksWritten: 0, avgLatencyMs: null, p95LatencyMs: null, maxLatencyMs: null, resultsSeen: 0, startedAt: null, stoppedAt: null, lastBlockAt: null },
    schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export class SimulatorRun {
  private readonly ref: DocumentReference;
  private readonly dogs = new Map<string, SimDog>();
  private readonly latency = new LatencyStats();
  private readonly unsubs: (() => void)[] = [];
  private state: RunState = "running";
  private speed = 1;
  private durationS: number | null = null;
  private timelineStartMs = 0;
  private blocksWritten = 0;
  private writeErrors = 0;
  /** Ids with a result (this run). A dog's next block goes out only after the previous one has its result. */
  private readonly resultIds = new Set<string>();
  private waits = 0;
  private resultTimeouts = 0;
  private lastBlockAt: number | null = null;
  private nextAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private handlingInjection = false;
  private finished = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((r) => (this.resolveDone = r));

  constructor(private readonly db: Firestore, readonly runId: string, private readonly opts: RunOptions) {
    this.ref = db.doc(`simulatorRuns/${runId}`);
  }

  private log(msg: string) {
    (this.opts.log ?? console.log)(`[${this.runId}] ${msg}`);
  }

  get written(): number {
    return this.blocksWritten;
  }

  async start(): Promise<void> {
    const snap = await this.ref.get();
    if (!snap.exists) throw new Error(`No existe la ejecución ${this.runId}.`);
    const run = snap.data() as SimulatorRunDoc<Timestamp>;
    validateRunRequest(run.dogIds, run.speed);
    this.speed = run.speed;
    this.state = run.state === "stopped" ? "stopped" : run.state;
    this.durationS = run.durationS ?? null;
    this.timelineStartMs = run.stats?.startedAt?.toMillis?.() ?? Date.now();
    const cfg = await loadConfig(this.db);

    // A dog in two active runs would interleave two timelines in its engine memory (dogState): not allowed.
    const busy = await this.db.collection("simulatorRuns").where("state", "in", ["running", "paused"])
      .where("dogIds", "array-contains-any", run.dogIds).get();
    const clash = busy.docs.find((d) => d.id !== this.runId);
    if (clash) {
      const shared = (clash.get("dogIds") as string[]).filter((id) => run.dogIds.includes(id));
      throw new Error(`${shared.join(", ")} ya está en la ejecución activa ${clash.id}. Detenla antes de iniciar otra con el mismo perro.`);
    }

    const model = await loadSimBehaviorModel();
    const manifest = loadManifest(this.opts.dataDir);
    let latestBlockMs = 0;
    for (const dogId of run.dogIds) {
      // A faster-than-real run leaves the dog's data ahead of the clock: continue after it, or the engine would
      // discard the new blocks as out of order.
      const state = (await this.db.doc(`dogState/${dogId}`).get()).data();
      const lastEnd = typeof state?.lastBlockEndMs === "number" ? state.lastBlockEndMs
        : typeof state?.lastBlockStartMs === "number" ? state.lastBlockStartMs + BLOCK_SECONDS * 1000 : null;
      if (lastEnd != null) latestBlockMs = Math.max(latestBlockMs, lastEnd);
      const dogSnap = await this.db.doc(`dogs/${dogId}`).get();
      if (!dogSnap.exists) throw new Error(`No existe el perro ${dogId}.`);
      const dog = dogSnap.data() as DogDoc<Timestamp>;
      const imuSrc = dog.source?.imu, hrSrc = dog.source?.hr;
      if (!imuSrc?.subjectId || !IMU_DATASETS.includes(imuSrc.datasetId!)) throw new Error(`${dog.name}: source.imu debe apuntar a un sujeto de Vehkaoja.`);
      if (!hrSrc?.subjectId || !HR_DATASETS.includes(hrSrc.datasetId!)) throw new Error(`${dog.name}: source.hr debe apuntar a Invoxia, PhysioZoo o los 23 perros.`);
      const imu = loadImu(imuSrc.datasetId!, imuSrc.subjectId, this.opts.dataDir);
      const hr = loadHr(hrSrc.datasetId!, hrSrc.subjectId, this.opts.dataDir);
      const stream = new DogStream(dogId, imu, hr.values, { hrBreaks: hr.breaks });
      // Recompute when missing, when asked, or when it was measured with another behavioral model.
      const wanted = model?.meta.version ?? "rules";
      if (!dog.baseline || this.opts.rebaseline || (dog.baseline.activitySource ?? "rules") !== wanted) {
        const subject = manifest.imu[imuSrc.datasetId!]?.find((s) => s.subjectId === imuSrc.subjectId);
        const stats = subject?.imuMean && subject?.imuStd ? { mean: subject.imuMean, std: subject.imuStd } : imuStats(imu);
        const flags = model ? model.activeFlags(imu, stats.mean, stats.std) : null;
        const baseline = computeBaseline(imu, hr.values, stream.temperatureStats, cfg,
          model && flags ? { version: model.meta.version, active: flags.active, imuMean: stats.mean, imuStd: stats.std } : null);
        await dogSnap.ref.update({ baseline: { ...baseline, computedAt: FieldValue.serverTimestamp() } });
        this.log(`línea base de ${dog.name} (${baseline.activitySource}): movimiento ${Math.round(baseline.activeRatioMean * 100)} %, FC ${baseline.hrMean} lpm, temperatura ${baseline.tempMean} °C`);
      }
      this.dogs.set(dogId, { stream, name: dog.name, ownerId: dog.ownerId, next: 0, parts: null, sub: 0, awaiting: null, awaitingSince: 0 });
    }

    if (!run.stats?.startedAt) this.timelineStartMs = Math.max(this.timelineStartMs, latestBlockMs);
    await this.ref.update({
      "stats.startedAt": run.stats?.startedAt ?? Timestamp.fromMillis(this.timelineStartMs),
      worker: { id: this.opts.workerId, host: os.hostname(), heartbeatAt: Timestamp.now() }, error: null,
    });

    this.unsubs.push(this.ref.onSnapshot((s) => this.onRunSnapshot(s.data() as SimulatorRunDoc<Timestamp> | undefined), (e) => this.log(`error al seguir la ejecución: ${e.message}`)));
    for (const dogId of this.dogs.keys()) {
      this.unsubs.push(this.db.doc(`dogs/${dogId}`).onSnapshot((s) => {
        const d = this.dogs.get(dogId), data = s.data();
        if (d && data) { d.ownerId = data.ownerId; d.name = data.name; }
      }));
    }
    this.unsubs.push(this.db.collection("results").where("sourceRef", "==", this.runId).onSnapshot((s) => {
      for (const ch of s.docChanges()) {
        if (ch.type !== "added") continue;
        this.latency.add(ch.doc.get("latencyMs"));
        this.resultIds.add(ch.doc.id);
      }
    }, (e) => this.log(`error al seguir los resultados: ${e.message}`)));

    this.log(`inicia con ${this.dogs.size} perros a ×${this.speed}${this.durationS ? ` durante ${this.durationS / 60} min simulados` : ""}`);
    this.nextAt = Date.now();
    this.timer = setTimeout(() => this.tick(), 0);
    this.flushTimer = setInterval(() => void this.flushStats(), STATS_FLUSH_MS);
    if (this.state === "stopped") await this.finish();
  }

  private onRunSnapshot(run: SimulatorRunDoc<Timestamp> | undefined): void {
    if (!run) return void this.finish("la ejecución se eliminó");
    if (run.speed !== this.speed && run.speed >= 1 && run.speed <= 10) {
      this.speed = run.speed;
      this.log(`velocidad ×${this.speed}`);
    }
    this.durationS = run.durationS ?? null;
    if (run.state !== this.state) {
      this.state = run.state;
      this.log(`estado: ${this.state}`);
      if (this.state === "stopped") return void this.finish();
    }
    if (run.pendingInjection && !this.handlingInjection) void this.takeInjection(run.pendingInjection);
  }

  /** Moves pendingInjection to injectionsLog and schedules it from the dog's next block. */
  private async takeInjection(req: InjectionRequest): Promise<void> {
    this.handlingInjection = true;
    try {
      await this.db.runTransaction(async (tx) => {
        const cur = (await tx.get(this.ref)).data() as SimulatorRunDoc<Timestamp> | undefined;
        const p = cur?.pendingInjection;
        if (!p || JSON.stringify(p) !== JSON.stringify(req)) return;
        const dog = this.dogs.get(p.dogId);
        try {
          if (!dog) throw new Error(`El perro ${p.dogId} no está en esta ejecución.`);
          const id = `inj_${Date.now().toString(36)}_${p.dogId}`;
          // A 10 s block already split into 2 s parts keeps its signals: the injection starts with the next one.
          const inj = schedule(id, p.type, p.magnitude, p.durationS, dog.parts ? dog.next + 1 : dog.next);
          dog.stream.injections.push(inj);
          tx.update(this.ref, {
            pendingInjection: null, error: null,
            injectionsLog: FieldValue.arrayUnion({ ...p, id, startBlock: inj.startBlock, endBlock: inj.endBlock, at: Timestamp.now() }),
          });
          this.log(`inyección ${ANOMALY_CATALOG.types[p.type].label} en ${dog.name}: magnitud ${p.magnitude}, ${p.durationS} s desde el bloque ${inj.startBlock}`);
        } catch (e) {
          tx.update(this.ref, { pendingInjection: null, error: (e as Error).message });
          this.log(`inyección rechazada: ${(e as Error).message}`);
        }
      });
    } finally {
      this.handlingInjection = false;
    }
  }

  /** Seconds of data of the next block to write. */
  private nextBlockSeconds(): number {
    const d = this.dogs.values().next().value as SimDog | undefined;
    if (d?.parts) return BLOCK_SECONDS / d.parts.length;
    return this.speed <= SUB_BLOCK_MAX_SPEED ? WINDOW_SECONDS : BLOCK_SECONDS;
  }

  private scheduleNext(): void {
    if (this.finished) return;
    const interval = (this.nextBlockSeconds() * 1000) / this.speed;
    // After a pause or a slow tick, catch up by at most one block instead of bursting.
    this.nextAt = Math.max(this.nextAt + interval, Date.now() - interval);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, this.nextAt - Date.now()));
  }

  private async tick(): Promise<void> {
    if (this.finished) return;
    if (this.state === "running") {
      await Promise.all([...this.dogs.entries()].map(([id, d]) => this.writeBlock(id, d)));
      if (this.durationS != null && [...this.dogs.values()].every((d) => d.next * BLOCK_SECONDS >= this.durationS!)) {
        await this.ref.update({ state: "stopped" });
        return this.finish("se cumplió la duración");
      }
    }
    this.scheduleNext();
  }

  private async writeBlock(dogId: string, d: SimDog): Promise<void> {
    // The Function processes each block in a transaction on the dog's memory, and Firestore triggers keep no
    // order. If blocks of a dog overlap (a fast run, cold instances), later ones finish first and the earlier ones are
    // scored as out of order, without updating the memory: the heart-rate minute and the activity average break.
    // So a dog's next block waits for the result of the previous one; a slow Function then slows the run down.
    if (d.awaiting && !this.resultIds.has(d.awaiting)) {
      if (Date.now() - d.awaitingSince < RESULT_WAIT_MS) {
        this.waits += 1;
        return;
      }
      this.resultTimeouts += 1;
      this.log(`sin resultado del bloque ${d.awaiting} de ${d.name} tras ${RESULT_WAIT_MS / 1000} s: se envía el siguiente`);
    }
    if (!d.parts) {
      // The stream advances in 10 s blocks (temperature and injections are per 10 s block); the speed decides how
      // each one goes out.
      d.parts = splitBlock(d.stream.block(d.next), this.speed <= SUB_BLOCK_MAX_SPEED ? WINDOWS_PER_BLOCK : 1);
      d.sub = 0;
    }
    const b = d.parts[d.sub];
    const seconds = BLOCK_SECONDS / d.parts.length;
    const blockStartMs = this.timelineStartMs + (d.next * BLOCK_SECONDS + d.sub * seconds) * 1000;
    const index = d.next * WINDOWS_PER_BLOCK + (d.sub * seconds) / WINDOW_SECONDS;
    const doc: Record<string, unknown> = {
      dogId, ownerId: d.ownerId, source: "simulator", sourceRef: this.runId,
      blockStart: Timestamp.fromMillis(blockStartMs), blockSeconds: seconds, imuHz: 100, imu: b.imu, hr: b.hr, temp: b.temp,
      processed: false, expireAt: Timestamp.fromMillis(Date.now() + READING_TTL_DAYS * 86_400_000),
      schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(),
    };
    if (b.truth.length) {
      doc.injectedAnomaly = b.truth[0];
      doc.injectedAnomalies = b.truth;
    }
    try {
      await this.db.doc(`readings/${readingId(this.runId, dogId, index)}`).create(doc);
      d.awaiting = readingId(this.runId, dogId, index);
      d.awaitingSince = Date.now();
    } catch (e) {
      if ((e as { code?: number }).code !== 6) {  // 6 = ALREADY_EXISTS: an earlier attempt landed, the block is written
        this.writeErrors += 1;
        this.log(`no se pudo escribir el bloque ${index} de ${d.name} (se reintenta): ${(e as Error).message}`);
        return;
      }
      d.awaiting = readingId(this.runId, dogId, index);
      d.awaitingSince = Date.now();
    }
    d.sub += 1;
    if (d.sub >= d.parts.length) {
      d.next += 1;
      d.parts = null;
      d.sub = 0;
    }
    this.blocksWritten += 1;
    this.lastBlockAt = Date.now();
  }

  private async flushStats(final = false): Promise<void> {
    const s = this.latency.summary();
    const update: Record<string, unknown> = {
      "stats.blocksWritten": this.blocksWritten, "stats.avgLatencyMs": s.avgMs, "stats.p95LatencyMs": s.p95Ms,
      "stats.maxLatencyMs": s.maxMs, "stats.resultsSeen": this.latency.count,
      "stats.lastBlockAt": this.lastBlockAt ? Timestamp.fromMillis(this.lastBlockAt) : null,
      "worker.heartbeatAt": Timestamp.now(),
    };
    if (final) update["stats.stoppedAt"] = Timestamp.now();
    try {
      await this.ref.update(update);
    } catch (e) {
      this.log(`no se pudieron guardar las estadísticas: ${(e as Error).message}`);
    }
  }

  /** Waits (up to timeoutMs) until every written block has its result, so the final latency stats are complete. */
  async drain(timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.latency.count < this.blocksWritten && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  }

  /** Stops from this process (Ctrl+C, shutdown): marks the run as stopped so it is not left claimed. */
  async stop(reason: string): Promise<void> {
    if (this.finished) return;
    try {
      await this.ref.update({ state: "stopped", worker: null });
    } catch (e) {
      this.log(`no se pudo marcar como detenida: ${(e as Error).message}`);
    }
    await this.finish(reason);
  }

  async finish(reason?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    await this.drain(this.opts.drainMs ?? 30_000);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushStats(true);
    for (const u of this.unsubs) u();
    const s = this.latency.summary();
    this.log(`terminó${reason ? ` (${reason})` : ""}: ${this.blocksWritten} bloques, ${this.latency.count} resultados, latencia media ${s.avgMs ?? "—"} ms, p95 ${s.p95Ms ?? "—"} ms, errores de escritura reintentados ${this.writeErrors}, esperas por resultados ${this.waits}${this.resultTimeouts ? ` (${this.resultTimeouts} sin resultado a tiempo)` : ""}`);
    this.resolveDone();
  }
}

/** Takes a run left for a worker (worker == null): of several processes, only one gets it. */
export async function claimRun(db: Firestore, runId: string, workerId: string): Promise<boolean> {
  const ref = db.doc(`simulatorRuns/${runId}`);
  return db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("worker") || cur.get("state") === "stopped") return false;
    tx.update(ref, { worker: { id: workerId, host: os.hostname(), heartbeatAt: Timestamp.now() } });
    return true;
  });
}

/**
 * `job` mode: claims one run created from the panel, executes it until it stops and returns.
 * A `serve` process that took the run first wins: the job then returns without doing anything.
 */
export async function runJob(db: Firestore, runId: string, opts: RunOptions & { onRun?: (run: SimulatorRun) => void }):
  Promise<"done" | "not_claimed" | "failed"> {
  const log = opts.log ?? console.log;
  if (!(await claimRun(db, runId, opts.workerId))) return "not_claimed";
  const run = new SimulatorRun(db, runId, opts);
  opts.onRun?.(run);
  try {
    await run.start();
  } catch (e) {
    log(`[${runId}] no pudo iniciar: ${(e as Error).message}`);
    await db.doc(`simulatorRuns/${runId}`).update({ state: "stopped", error: (e as Error).message, worker: null });
    return "failed";
  }
  await run.done;
  return "done";
}

/** `serve` mode: executes the runs created from the admin panel (worker == null). Returns a stop function. */
export function serveRuns(db: Firestore, opts: RunOptions & { maxRuns?: number }): () => Promise<void> {
  const active = new Map<string, SimulatorRun>();
  const log = opts.log ?? console.log;
  let unsub: () => void = () => undefined;
  let stopped = false;
  const subscribe = () => {
    unsub = db.collection("simulatorRuns").where("state", "in", ["running", "paused"]).onSnapshot(onRuns, (e) => {
      // Firestore unavailable (restart, network): keep serving by subscribing again.
      log(`error al seguir las ejecuciones (se reintenta en 5 s): ${e.message}`);
      if (!stopped) setTimeout(subscribe, 5000);
    });
  };
  const onRuns = async (snap: FirebaseFirestore.QuerySnapshot) => {
    for (const doc of snap.docs) {
      if (active.has(doc.id) || doc.get("worker") || active.size >= (opts.maxRuns ?? 5)) continue;
      if (!(await claimRun(db, doc.id, opts.workerId))) continue;
      const run = new SimulatorRun(db, doc.id, opts);
      active.set(doc.id, run);
      run.start().catch(async (e) => {
        log(`[${doc.id}] no pudo iniciar: ${(e as Error).message}`);
        await doc.ref.update({ state: "stopped", error: (e as Error).message, worker: null });
        active.delete(doc.id);
      });
      void run.done.then(() => active.delete(doc.id));
    }
  };
  subscribe();
  return async () => {
    stopped = true;
    unsub();
    await Promise.all([...active.values()].map((r) => r.stop("el proceso se detuvo")));
  };
}
