/**
 * Firestore data model shared by web/, functions/ and simulator/.
 * Source: (DB design v1.0) with the adjustments (source per signal),
 * (heart rate relative to each dog's baseline) (owner-centred app, no vet role). Timestamps are Firestore Timestamps at runtime;
 * they are typed generically so each package can plug in its own SDK type.
 */

/** Every sign-up is an owner; "admin" is granted only by a server-side script and never shown in the UI. */
export type Role = "owner" | "admin";
export type Level = "green" | "amber" | "red";
export type Behavior = "sit" | "stand" | "lie" | "trot" | "walk" | "play" | "sniff";
export const BEHAVIORS: readonly Behavior[] = ["sit", "stand", "lie", "trot", "walk", "play", "sniff"] as const;

export type DatasetId = "vehkaoja2022" | "invoxia2023" | "physiozoo2018" | "rri23dogs" | "uwbdvs2024" | "synthetic" | "csv";
export type AnomalyType = "activity_drop" | "immobility" | "tachycardia" | "bradycardia" | "fever" | "hypothermia";

export interface SourceRef { datasetId: DatasetId | null; subjectId: string | null }

export interface UserDoc<T = unknown> {
  role: Role;
  displayName: string;
  email: string;
  phone?: string;
  /** FCM tokens of the browsers where the owner turned on notifications (at most 10). */
  fcmTokens?: string[];
  /** Which alerts are pushed. Missing means both; "red" alerts stay on in the app. */
  notificationPrefs?: { red: boolean; amber: boolean };
  /** When this person last cleared their Alertas list, for every dog (`all`) or for one (`byDog`). Alerts
   * created until then leave their list; they stay in the dog's history and in the vet view. */
  alertsCleared?: { all?: T; byDog?: Record<string, T> };
  /** RNF-03 (Ley N.° 29733): when the user accepted the processing of personal data at sign-up. */
  privacyConsentAt?: T;
  schemaVersion: number;
  createdAt: T;
}

export interface Baseline<T = unknown> {
  activeRatioMean: number; activeRatioStd: number;
  /** Null when the dog's data had no heart rate (or no temperature); CSV columns are optional. */
  hrMean: number | null; hrStd: number | null;
  tempMean: number | null; tempStd: number | null;
  samples: number;
  /** Per-channel IMU mean and std of the dog's normal data, for the per-dog z-score of the model. */
  imuMean?: number[]; imuStd?: number[];
  /** How the active-time ratio was measured: the behavioral model version, or "rules". */
  activitySource?: string;
  /** "function" when the Function learned it from the dog's first blocks; missing for the simulator's. */
  origin?: "simulator" | "function";
  computedAt: T;
}

/** The Function is learning the dog's baseline ("initial") or refining its activity with the model ("model"). */
export interface BaselineProgress { stage: "initial" | "model"; share: number }

export interface DogStatus<T = unknown> {
  healthScore: number;
  level: Level;
  lastBehavior: Behavior | null;
  lastHr: number | null;
  lastTemp: number | null;
  openAlerts: number;
  /** Active-time ratio behind rB (the engine's moving share of time in movement, from the model or the rule). */
  lastActivityRatio?: number | null;
  /** Engine that produced the score, kept for traceability; the app does not read it. */
  engineVersion?: string;
  /** Behavioral model used for lastBehavior, or null with the provisional rule. */
  behaviorModel?: string | null;
  /** Physiological model used for r_p, or null with the provisional heart-rate rule. */
  physioModel?: string | null;
  /** BlockStart of the latest block; charts are anchored here, not at the wall clock. */
  lastBlockAt?: T;
  /** Progress of the baseline being learned, or null. */
  baselineProgress?: BaselineProgress | null;
  /** Exponential average of the Health Score with config/fusion.stableTimeConstantS (5 minutes by default) and
   * its level. Inicio and the dog's seal show these, so a dog that plays for a minute does not flip to «Atención»; the
   * live panel and the alerts keep the instantaneous healthScore and level. Missing in status docs written before. */
  stableHealthScore?: number;
  stableLevel?: Level;
  /** Where the latest block came from. A CSV upload is never shown as «En vivo». */
  lastSource?: "simulator" | "csv";
  updatedAt: T;
}

export interface DogDoc<T = unknown> {
  name: string;
  breed?: string | null;
  sex?: "female" | "male" | null;
  birthDate?: string | null; // ISO date (YYYY-MM-DD)
  weightKg?: number | null;
  ownerId: string;
  active: boolean;
  /** One source per signal, because no public dataset has the three signals of the same dog. */
  source?: { imu: SourceRef; hr: SourceRef; temp: SourceRef };
  baseline?: Baseline<T>; // Functions only
  status?: DogStatus<T>;  // Functions only
  schemaVersion: number;
  createdAt: T;
}

/** Injected anomaly as stored in readings. */
export interface InjectedAnomaly {
  type: AnomalyType;
  magnitude: number;
  durationS: number;
  injectionId?: string;
  offsetS?: number;
}

/** One block of 2 to 10 s: 10 s from the CSV, 2 or 10 s from the simulator, which also writes blockSeconds.
 * 100 IMU samples per second × 6, sample-major (imu[i * 6 + c], channels acc_x, acc_y, acc_z in g and gyr_x, gyr_y,
 * gyr_z in °/s), one HR value per second at most and one temperature. */
export interface ReadingDoc<T = unknown> {
  dogId: string;
  ownerId: string;
  source: "simulator" | "csv";
  sourceRef: string; // runId or uploadId
  blockStart: T;
  imuHz: number;
  imu: number[];
  hr: number[];
  temp?: number | null;
  /** Ground truth for evaluation only; the Function never reads it. First active injection. */
  injectedAnomaly?: InjectedAnomaly;
  /** Every injection active in the block (several signals can be altered at once). */
  injectedAnomalies?: InjectedAnomaly[];
  /** Written as false by the producer; the existence of results/{readingId} marks it as processed. */
  processed: boolean;
  expireAt: T; // TTL: 7 days
  schemaVersion: number;
  createdAt: T;
}

/** results/{readingId}: same id as the reading (idempotent). */
export interface ResultDoc<T = unknown> {
  readingId: string;
  dogId: string;
  ownerId: string;
  blockStart: T;
  sourceRef?: string;       // runId or uploadId of the reading (to follow a simulator run)
  predictedBehavior: Behavior | null;  // null with the provisional rule (no model, IMU rejected or no IMU statistics yet)
  behaviorProbs: number[] | null;      // 7 values, order of BEHAVIORS
  rB: number; rP: number; rT: number;
  healthScore: number;
  level: Level;
  /** Signals behind the scores, for trend charts (screen 3).. */
  signals?: { activeFraction: number; activityRatio: number | null; noveltyRatio?: number | null; hr: number | null; temp: number | null;
    /** Reconstruction error / threshold of the physiological model (null with the rule or while warming up). */
    hrRatio?: number | null };
  /** The block's heart-rate values (1 Hz from blockStart, prefiltered, in time order) for the live view. */
  hrValues?: number[];
  /** Length of the block (2 or 10 s); older results had 10 s blocks. */
  blockSeconds?: number;
  prefilterFlags: string[];
  modelVersions: { behavior: string | null; physiological: string | null };
  latencyMs: number;
  schemaVersion: number;
  createdAt: T;
}

export interface AlertReason {
  component: "behavior" | "heart_rate" | "temperature";
  code: string;
  value: number;
  normalRange: [number, number];
  message: string; // plain Spanish, shown to owners (the vet view shows the values)
}

export interface AlertDoc<T = unknown> {
  dogId: string;
  resultId: string;
  ownerId: string;
  dogName: string;
  healthScore: number;
  severity: "amber" | "red";
  reasons: AlertReason[];
  /** Code of the reason that names the alert (its title and first cause), chosen by the
   * engine when it opens (the largest deviation in band widths) and kept while it lasts unless it rises to red.
   * Absent in older alerts: the app computes it. */
  titleCode?: string | null;
  status: "open" | "acknowledged";
  acknowledgedBy?: string | null;
  acknowledgedAt?: T | null;
  /** True once FCM accepted the push for at least one of the owner's browsers. */
  notified: boolean;
  /** One entry per push attempt ("new" alert, "escalated" to red), also when it was skipped. */
  notify?: Partial<Record<"new" | "escalated", { at: T; sent: number; failed: number; skipped: string | null }>>;
  /** TP2: written only by an admin (the thesis reviewer), for Cohen's kappa. */
  expertReview?: { reviewerId: string; relevant: boolean; notes: string; reviewedAt: T };
  /** An episode keeps one alert; lastResultId and updatedAt follow it while the condition lasts. */
  lastResultId?: string;
  /** Data time of the episode (first triggering window, end of the last one); endedAt null while open. */
  startedAt?: T;
  endedAt?: T | null;
  provisional?: boolean;
  updatedAt?: T;
  schemaVersion: number;
  createdAt: T;
}

export interface ModelVersionDoc<T = unknown> {
  kind: "behavior" | "physiological";
  version: string;
  architecture: string;
  bundlePath: string;
  trainingData: string[];
  metrics: Record<string, number>;
  active: boolean;
  trainedAt: T;
}

export interface FusionConfig<T = unknown> {
  weights: { b: number; p: number; t: number };
  alertThreshold: number;
  levels: { green: number; amber: number };
  consecutiveCritical: number;
  /** Informative only; the heart-rate critical rule uses the dog's baseline. */
  hrRange: [number, number];
  tempRange: [number, number];
  tempMaxDeviation: number;
  baselineSigma: number;
  prefilter: { hrMin: number; hrMax: number; tempMin: number; tempMax: number };
  /** With the provisional rule (a dog whose baseline was not learned with the behavioral model), a 2 s window
   * is active when the std of |acc| exceeds thresholdG. With the model or the rule, the active-time ratio is an
   * exponential average with this time constant. */
  activity: { thresholdG: number; timeConstantS: number };
  /** Seconds averaged for the heart rate compared with the baseline. */
  hrAverageS: number;
  /** Exponential average of novel windows and the rate at which rB from novelty reaches 1. */
  novelty: { timeConstantS: number; fullScaleRate: number };
  /** Optional overrides. fullScaleRatio and criticalRatio default to the model's calibration (metadata);
   * levelSigma is the level rule of the heart-rate critical rule and defaults to baselineSigma. */
  physio?: { fullScaleRatio?: number; criticalRatio?: number; levelSigma?: number };
  /** Blocks of 10 s the Function collects to learn a dog's baseline (each stage). Default 360 (1 h). */
  baseline?: { minBlocks: number };
  /** An alert episode closes after this many seconds without trigger (one alert per episode, not per window). */
  episodeGapS: number;
  /** dogs.status is written at most once per this many seconds of data time, unless the level changes. */
  statusMinIntervalS: number;
  /** An alert opens only after its trigger held this many seconds without interruption (0: at once). The
   * anomalies are sustained; brief excursions of normal data are not. Optional so older config docs still read. */
  alertMinDurationS?: number;
  /** Critical rule of low activity, in standard deviations of the dog's active-time ratio below its mean
   * (null: off). Without it a drop of activity alone can never open an alert: behavior weighs 0.4, so the Health
   * Score stays at 60 or above. */
  activityCriticalSigma?: number | null;
  /** Time constant of the stable Health Score of dogs.status (exponential average per 2 s window; 0: none).
   * Display only: the alerts and their trigger use the instantaneous score. Optional so older config docs still read. */
  stableTimeConstantS?: number;
  updatedBy: string;
  updatedAt: T;
}

export const DEFAULT_FUSION_CONFIG: Omit<FusionConfig, "updatedBy" | "updatedAt"> = {
  weights: { b: 0.4, p: 0.4, t: 0.2 },
  alertThreshold: 60,
  levels: { green: 80, amber: 60 },
  consecutiveCritical: 2,
  hrRange: [100, 150],
  tempRange: [37.7, 39.5],
  tempMaxDeviation: 1.0,
  baselineSigma: 2,
  prefilter: { hrMin: 20, hrMax: 300, tempMin: 30, tempMax: 45 },
  // thresholdG fitted on the Vehkaoja training dogs by ml/src/activity.py (balanced accuracy 0.962 on validation dogs).
  activity: { thresholdG: 0.1129, timeConstantS: 1200 },
  hrAverageS: 60,
  novelty: { timeConstantS: 300, fullScaleRate: 0.5 },
  baseline: { minBlocks: 360 },
  episodeGapS: 60,
  statusMinIntervalS: 2,   // Blocks of 2 s refresh the card one by one
  alertMinDurationS: 0,
  activityCriticalSigma: null,
  stableTimeConstantS: 300, // 5 minutes, the alertMinDurationS deployed
};

export interface InjectionRequest { dogId: string; type: AnomalyType; magnitude: number; durationS: number }

export interface SimulatorRunDoc<T = unknown> {
  createdBy: string;
  dogIds: string[]; // 1–10 per run
  speed: number;    // 1–10
  state: "running" | "paused" | "stopped";
  /** Optional automatic stop after this much simulated time. */
  durationS?: number | null;
  /** "duration" when the simulator stopped the run because it reached durationS, so the
   * panel says «Terminada» and not «Detenida». Absent for runs stopped by hand and for older runs. */
  endedBy?: "duration" | null;
  seed?: number;
  pendingInjection?: InjectionRequest | null;
  injectionsLog: (InjectionRequest & { id: string; startBlock: number; endBlock: number; at: T })[];
  /** Process executing the run (simulator CLI). null until a `sim serve` worker claims a run created from the panel. */
  worker?: { id: string; host: string; heartbeatAt: T } | null;
  /** The Cloud Run job execution requested for a run created from the panel (the Function writes it). */
  cloudJob?: { job: string; requestedAt: T; operation?: string | null; error?: string | null } | null;
  stats: {
    blocksWritten: number; avgLatencyMs: number | null; startedAt: T | null; stoppedAt: T | null;
    p95LatencyMs?: number | null; maxLatencyMs?: number | null; resultsSeen?: number; lastBlockAt?: T | null;
  };
  error?: string | null;
  schemaVersion?: number;
  createdAt?: T;
}

/** csvUploads/{uploadId}. The app validates the file, creates this document and writes the blocks to
 * readings; the Function counts the processed blocks and marks it done. */
export interface CsvUploadDoc<T = unknown> {
  dogId: string;
  uploadedBy: string;
  ownerId: string;
  fileName: string;
  rows: number;
  columns: string[];
  status: "validated" | "processing" | "done" | "failed";
  /** First problems found in the file (rows left out), at most 50. */
  errors: { row: number; column: string; message: string }[];
  /** Plain-Spanish notes on data left out (incomplete seconds, impossible values). */
  warnings: string[];
  blocksExpected: number;
  /** Written by the Function, one per scored block. */
  blocksProcessed: number;
  /** Blocks that arrived after a later one of the same dog (the engine does not learn from them). */
  blocksOutOfOrder?: number;
  firstBlockAt: T;
  lastBlockAt: T;
  updatedAt?: T;
  completedAt?: T | null;
  schemaVersion: number;
  createdAt: T;
}

/** Health Score. Weights and thresholds come from config/fusion, never hardcoded at call sites. */
export function healthScore(r: { rB: number; rP: number; rT: number }, w: FusionConfig["weights"]): number {
  const v = 100 * (1 - (w.b * r.rB + w.p * r.rP + w.t * r.rT));
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function levelOf(hs: number, levels: FusionConfig["levels"]): Level {
  return hs >= levels.green ? "green" : hs >= levels.amber ? "amber" : "red";
}

/** Floors of the per-dog standard deviations: 2 percentage points of time in movement and 1 bpm. */
export const ACTIVITY_SD_FLOOR = 0.02;
export const HR_SD_FLOOR = 1;

/** The dog's normal band of a signal: its baseline mean ± `sigma` standard deviations (config/fusion baselineSigma),
 * with the floor above. The engine's alert reasons and the app («Qué es normal», chart bands, friendly vitals) both use
 * it, so «normal» is one range everywhere. */
export function normalBand(mean: number, std: number, floor: number, sigma: number): [number, number] {
  const sd = Math.max(std, floor);
  return [mean - sigma * sd, mean + sigma * sd];
}
