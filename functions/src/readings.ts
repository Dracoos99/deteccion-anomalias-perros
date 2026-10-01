/**
 * Inference trigger on each 10 s block. The behavioral CNN-LSTM (TF.js)
 * classifies the 5 windows of 2 s; shared/engine.ts turns its output, the heart rate and the temperature into scores.
 * Without the model or the dog's IMU statistics, the provisional movement rule applies (flagged in the result).
 *
 * One transaction per block keeps it idempotent (RNF-02): if results/{readingId} exists the retry does nothing.
 * It writes results/{readingId}, the per-dog engine memory dogState/{dogId}, dogs.status and alerts/{readingId} when an episode opens.
 * A dog without baseline learns it from its first blocks (shared/baseline.ts), and a CSV block counts in
 * its csvUploads document.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineInt } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { FieldValue, Timestamp, getFirestore, type Firestore } from "firebase-admin/firestore";
import { REGION, SCHEMA_VERSION } from "./config";
import { prefilterBlock } from "./prefilter";
// ./behavior (TF.js) is imported lazily: loading it at import time slows the CLI's code analysis (10 s limit).
const behaviorModule = () => import("./behavior");
const physioModule = () => import("./physio");
import { ENGINE_VERSION, evaluateBlock, initialState, type EngineConfig, type EngineState } from "./shared/engine";
import { DEFAULT_BASELINE_BLOCKS, baselineShare, learnBaseline, type BaselineAcc } from "./shared/baseline";
import { readWindow } from "./shared/behavior-model";
import { DEFAULT_FUSION_CONFIG, type CsvUploadDoc, type DogDoc, type FusionConfig, type ReadingDoc } from "./shared/types";
import {
  MINUTE_TIER, SLOT_MINUTES, TEN_SEC_TIER, addBlock, dayKey, emptySlot, slotIndex, tierDocId, tierDocStart, tierSlotIndex, trendDocId,
  type BlockSummary, type TrendSlot, type TrendTier,
} from "./shared/trends";

const CONFIG_TTL_MS = 15_000;
let configCache: { value: EngineConfig; at: number } | null = null;

export function resetConfigCache(): void {
  configCache = null;
}

/** config/fusion merged over the defaults. */
export async function getConfig(db: Firestore, now = Date.now()): Promise<EngineConfig> {
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const snap = await db.doc("config/fusion").get();
  const value = { ...DEFAULT_FUSION_CONFIG, ...(snap.data() as Partial<FusionConfig> | undefined) } as EngineConfig;
  configCache = { value, at: now };
  return value;
}

export async function countOpenAlerts(db: Firestore, dogId: string): Promise<number> {
  const agg = await db.collection("alerts").where("dogId", "==", dogId).where("status", "==", "open").count().get();
  return agg.data().count;
}

const toMillis = (t: unknown, fallback: number) => (t instanceof Timestamp ? t.toMillis() : typeof t === "number" ? t : fallback);

export type ProcessOutcome = "written" | "duplicate" | "missing_dog";

/** The slot being filled, kept in dogState between blocks and written to trends/. */
interface TrendState { day: string; index: number; slot: TrendSlot; pending: number }
/** The slot being filled of a finer tier. */
interface TierState { docStart: number; index: number; slot: TrendSlot }

const TIER_STATE_KEY = { trendsTenSec: "trendTenSec", trendsMinute: "trendMinute" } as const;
const TEN_SEC_TTL_MS = 7 * 86_400_000;

export async function processReading(db: Firestore, readingId: string, reading: ReadingDoc<Timestamp>): Promise<ProcessOutcome> {
  const cfg = await getConfig(db);
  const pre = prefilterBlock(reading, cfg.prefilter);
  const createdMs = toMillis(reading.createdAt, Date.now());
  const blockStartMs = toMillis(reading.blockStart, createdMs);
  const resultRef = db.doc(`results/${readingId}`);
  const stateRef = db.doc(`dogState/${reading.dogId}`);
  const dogRef = db.doc(`dogs/${reading.dogId}`);
  const uploadRef = reading.source === "csv" && reading.sourceRef ? db.doc(`csvUploads/${reading.sourceRef}`) : null;

  // The model is loaded once per instance; the first block of a dog seeds its open-alert count.
  const runner = await (await behaviorModule()).getBehaviorRunner();
  const physio = await (await physioModule()).getPhysioRunner();
  const stateExists = (await stateRef.get()).exists;
  const initialOpen = stateExists ? 0 : await countOpenAlerts(db, reading.dogId);

  return db.runTransaction(async (tx) => {
    const [resultSnap, stateSnap, dogSnap, uploadSnap] = await tx.getAll(resultRef, stateRef, dogRef, ...(uploadRef ? [uploadRef] : []));
    if (resultSnap.exists) return "duplicate";
    if (!dogSnap.exists) return "missing_dog";
    const dog = dogSnap.data() as DogDoc<Timestamp>;
    const prev = stateSnap.exists ? (stateSnap.data() as EngineState) : initialState(initialOpen);
    const imu = reading.imu ?? [];
    const imuOk = !pre.flags.some((f) => f.startsWith("imu_"));
    const behavior = runner && imuOk ? runner.run(imu, dog.baseline?.imuMean, dog.baseline?.imuStd) : null;
    const ev = evaluateBlock({ imu, hr: pre.hr, temp: pre.temp, blockStartMs, behavior, physio }, prev, dog.baseline ?? null, cfg,
      { alertId: readingId });
    const flags = [...pre.flags, ...ev.flags];

    tx.set(resultRef, {
      readingId, dogId: reading.dogId, ownerId: reading.ownerId, blockStart: reading.blockStart,
      sourceRef: reading.sourceRef ?? null, predictedBehavior: ev.result.predictedBehavior, behaviorProbs: ev.result.behaviorProbs,
      rB: ev.result.rB, rP: ev.result.rP, rT: ev.result.rT, healthScore: ev.result.healthScore, level: ev.result.level,
      signals: ev.result.signals, hrValues: pre.hr, prefilterFlags: flags,
      modelVersions: { behavior: behavior?.meta.version ?? ENGINE_VERSION, physiological: ev.result.signals.hrRatio != null ? physio!.meta.version : ENGINE_VERSION },
      latencyMs: Date.now() - createdMs, schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(),
    });
    // A CSV upload ends with this block: its last trend slot is written now, not when the next data arrive.
    const upload = uploadSnap?.exists ? (uploadSnap.data() as CsvUploadDoc<Timestamp>) : null;
    const uploadProcessed = upload ? (upload.blocksProcessed ?? 0) + 1 : 0;
    const uploadDone = !!upload && uploadProcessed >= upload.blocksExpected;

    // Trend slot and baseline being learned: out-of-order blocks leave the engine memory, the
    // trends and the baseline untouched.
    let trend = (stateSnap.exists ? stateSnap.get("trend") : null) as TrendState | null;
    let acc = (stateSnap.exists ? stateSnap.get("baselineAcc") ?? null : null) as BaselineAcc | null;
    let learned: ReturnType<typeof learnBaseline>["learned"] = null;
    const minBlocks = cfg.baseline?.minBlocks ?? DEFAULT_BASELINE_BLOCKS;
    if (ev.state !== prev && imuOk) {
      ({ acc, learned } = learnBaseline(dog.baseline ?? null, acc, {
        imu, hr: pre.hr, temp: pre.temp, ruleFlags: ev.windows.map((w) => !!w.active),
        model: behavior ? { version: behavior.meta.version, flags: behavior.probs.map((p) => readWindow(p, behavior.meta).active) } : null,
      }, cfg, minBlocks));
    }
    if (ev.state !== prev) {
      const writeSlot = (t: TrendState) => tx.set(db.doc(`trends/${trendDocId(reading.dogId, t.day)}`), {
        dogId: reading.dogId, ownerId: dog.ownerId, day: t.day, slotMinutes: SLOT_MINUTES, schemaVersion: SCHEMA_VERSION,
        updatedAt: FieldValue.serverTimestamp(), slots: { [String(t.index)]: t.slot },
      }, { merge: true });
      const day = dayKey(blockStartMs), index = slotIndex(blockStartMs);
      const measured = ev.windows.filter((w) => w.active != null);
      const summary: BlockSummary = {
        healthScore: ev.result.healthScore, level: ev.result.level, windows: measured.length,
        active: measured.filter((w) => w.active).length, novel: ev.windows.filter((w) => w.novel).length,
        behaviors: ev.windows.map((w) => w.predicted), hr: pre.hr, temp: pre.temp,
      };
      // Every block writes its slot, so a slot never waits for the next one.
      const same = trend && trend.day === day && trend.index === index;
      trend = { day, index, slot: addBlock(same ? trend!.slot : emptySlot(), summary), pending: 0 };
      writeSlot(trend);
      // The 1-minute and 10-second tiers, in small documents.
      const tiers: Record<string, TierState> = {};
      for (const tier of [MINUTE_TIER, TEN_SEC_TIER] as TrendTier[]) {
        const key = TIER_STATE_KEY[tier.collection];
        const prevTier = (stateSnap.exists ? stateSnap.get(key) : null) as TierState | null;
        const docStart = tierDocStart(tier, blockStartMs), tIndex = tierSlotIndex(tier, blockStartMs);
        const keep = prevTier && prevTier.docStart === docStart && prevTier.index === tIndex;
        const tierState: TierState = { docStart, index: tIndex, slot: addBlock(keep ? prevTier!.slot : emptySlot(), summary, tier.hrValues) };
        tiers[key] = tierState;
        tx.set(db.doc(`${tier.collection}/${tierDocId(tier, reading.dogId, blockStartMs)}`), {
          dogId: reading.dogId, ownerId: dog.ownerId, startMs: docStart, slotMs: tier.slotMs, schemaVersion: SCHEMA_VERSION,
          updatedAt: FieldValue.serverTimestamp(), slots: { [String(tIndex)]: tierState.slot },
          ...(tier.hrValues ? { expireAt: Timestamp.fromMillis(docStart + tier.docMs + TEN_SEC_TTL_MS) } : {}),
        }, { merge: true });
      }
      tx.set(stateRef, { ...ev.state, trend, ...tiers, baselineAcc: acc, updatedAt: FieldValue.serverTimestamp() });
    }

    if (ev.alert) {
      const alertRef = db.doc(`alerts/${ev.alert.alertId}`);
      if (ev.alert.action === "open") {
        tx.create(alertRef, {
          dogId: reading.dogId, resultId: readingId, lastResultId: readingId, ownerId: dog.ownerId,
          dogName: dog.name, healthScore: ev.alert.healthScore, severity: ev.alert.severity, reasons: ev.alert.reasons,
          status: "open", acknowledgedBy: null, acknowledgedAt: null, notified: false, provisional: true,
          startedAt: Timestamp.fromMillis(ev.alert.startedAtMs ?? blockStartMs), endedAt: null,
          schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        // Merge: never touches status or acknowledgement written by the owner.
        tx.set(alertRef, { healthScore: ev.alert.healthScore, severity: ev.alert.severity, reasons: ev.alert.reasons,
          lastResultId: readingId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }

    if (ev.closed) {
      tx.set(db.doc(`alerts/${ev.closed.alertId}`), { endedAt: Timestamp.fromMillis(ev.closed.endedAtMs), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    if (upload) {
      // CSV progress: the app writes the blocks one after another and follows this counter.
      tx.update(uploadRef!, {
        blocksProcessed: uploadProcessed, status: uploadDone ? "done" : "processing", updatedAt: FieldValue.serverTimestamp(),
        ...(flags.includes("out_of_order") ? { blocksOutOfOrder: FieldValue.increment(1) } : {}),
        ...(uploadDone ? { completedAt: FieldValue.serverTimestamp() } : {}),
      });
    }

    const dogUpdate: Record<string, unknown> = {};
    if (learned) dogUpdate.baseline = { ...learned, computedAt: FieldValue.serverTimestamp() };
    // Also at the end of a CSV upload, so the app shows the state after its last block (dogs.status is throttled).
    if (ev.statusDue || learned || uploadDone) {
      const lastHr = ev.result.signals.hr ?? (pre.hr.length ? Math.round(pre.hr.reduce((a, b) => a + b, 0) / pre.hr.length) : dog.status?.lastHr ?? null);
      Object.assign(dogUpdate, {
        status: {
          healthScore: ev.result.healthScore, level: ev.result.level, lastBehavior: ev.result.predictedBehavior, lastHr,
          lastTemp: pre.temp ?? dog.status?.lastTemp ?? null, lastActivityRatio: ev.result.signals.activityRatio,
          openAlerts: ev.state.openAlerts, engineVersion: ENGINE_VERSION, behaviorModel: behavior?.meta.version ?? null,
          physioModel: ev.result.signals.hrRatio != null ? physio!.meta.version : null,
          lastBlockAt: Timestamp.fromMillis(blockStartMs),
          baselineProgress: acc ? { stage: acc.stage, share: Math.round(baselineShare(acc, minBlocks) * 1000) / 1000 } : null,
          updatedAt: FieldValue.serverTimestamp(),
        },
      });
    }
    if (Object.keys(dogUpdate).length) tx.update(dogRef, dogUpdate);
    return "written";
  });
}

// Instances kept warm to avoid cold starts with the model. Costs money on Blaze: 0 unless the team decides otherwise
// at deploy time (firebase deploy asks for the value, or set it in functions/.env).
const MIN_INSTANCES = defineInt("READINGS_MIN_INSTANCES", { default: 0, description: "Warm instances of onReadingCreated (0 = none)" });

// retry: transient failures are retried; the transaction above makes a retry harmless (RNF-02).
// memory: TF.js with the WebAssembly backend and the model fit comfortably in 1 GiB.
export const onReadingCreated = onDocumentCreated({
  document: "readings/{readingId}", region: REGION, retry: true, memory: "1GiB", minInstances: MIN_INSTANCES,
}, async (event) => {
  const data = event.data?.data() as ReadingDoc<Timestamp> | undefined;
  if (!data) return;
  // injectedAnomaly is ground truth for evaluation only and is never passed to the engine.
  const outcome = await processReading(getFirestore(), event.params.readingId, data);
  if (outcome !== "written") logger.warn("reading not scored", { readingId: event.params.readingId, dogId: data.dogId, outcome });
});
