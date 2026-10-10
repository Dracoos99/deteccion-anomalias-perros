/**
 * Scoring engine. Behavior comes from the CNN-LSTM when its output is given (phase 2): class,
 * active-time ratio and novelty; otherwise the provisional movement rule applies. Heart rate combines the level
 * rule below with the LSTM autoencoder when it is given (phase 4): the autoencoder scores the shape of the last 60
 * contiguous seconds, and r_p and the critical rule take either. The Health Score is the weighted sum of the three
 * scores, with its levels and alert triggers.
 * The ramps that turn a deviation into r ∈ [0, 1] follow the prototype with
 * the heart rate relative to the dog's baseline. Pure functions: used by Cloud Functions and the simulator.
 *
 * Per block: 1 to 5 windows of 2 s.
 * Per window:
 *   active     = std(|acc|) > activity.thresholdG            (stand-in for the behavioral model)
 *   ratio      = exponential average of active, time constant activity.timeConstantS
 *   hr         = mean of the last hrAverageS heart-rate values
 *   rB = clamp((|z_ratio| − 1) / 3)   rT = temperature rules
 *   rP = max(clamp((|z_hr| − 1) / 4), clamp((error / threshold − 1) / (fullScaleRatio − 1)))   (second term: autoencoder)
 *   critical   = |z_hr| > levelSigma (default baselineSigma), error / threshold ≥ criticalRatio, or temperature outside
 *                tempRange; an alert needs consecutiveCritical windows
 * The block result is its last window (C8). Without a baseline only the absolute rules apply.
 * An alert lists every variable that left its range while its trigger held (before it opened and while it
 * lasts), each with its most extreme value; and a stable Health Score (exponential average, stableTimeConstantS) goes to
 * dogs.status for the owner screens. Neither changes when an alert opens or closes. The alert keeps the reason
 * that names it (titleCode) while it lasts.
 */
import {
  ACTIVITY_SD_FLOOR, HR_SD_FLOOR, healthScore, levelOf, normalBand, type AlertReason, type Baseline, type Behavior, type FusionConfig, type Level,
} from "./types";
import { readWindow, type BehaviorOutput } from "./behavior-model";
import { compareReasons, primaryReason } from "./alert-text";
import { ratioToScore, sequenceZ, type PhysioScorer } from "./physio-model";

export const ENGINE_VERSION = "provisional-rules-4";
export const IMU_CHANNELS = 6;
export const WINDOW_SAMPLES = 200;   // 2 s at 100 Hz
/** Length of the blocks of CSV uploads and older readings; live blocks may be shorter. */
export const BLOCK_SECONDS = 10;
export const WINDOW_S = 2;
const WINDOW_MS = (WINDOW_SAMPLES / 100) * 1000;
/** rNovelty below this still lowers the score but is not listed as an alert reason. */
export const NOVELTY_REASON_MIN = 0.1;

export type EngineConfig = Omit<FusionConfig, "updatedBy" | "updatedAt">;
export type BaselineStats = Pick<Baseline, "activeRatioMean" | "activeRatioStd" | "hrMean" | "hrStd" | "tempMean" | "tempStd">
  & Partial<Pick<Baseline, "imuMean" | "imuStd" | "activitySource">>;
type Component = AlertReason["component"];

/** Reasons of one window or of an episode. `fallback`: no variable left its range, so they describe the deviation that
 * triggered inside it (an unusual configuration); a real reason replaces them. */
export interface ReasonSet { reasons: AlertReason[]; fallback: boolean }

export interface Episode {
  alertId: string;
  severity: "amber" | "red";
  minHealthScore: number;
  components: Component[];
  windowsSinceTrigger: number;
  /** Data time of the first triggering window and the end of the last one (absent in older states). */
  startMs?: number;
  lastTriggerMs?: number;
  /** The reasons last written to the alert (every variable out of its range so far, the most extreme value of
   * each). Absent in states from before it. */
  reasons?: AlertReason[];
  fallback?: boolean;
  /** Code of the reason that names the alert, kept while it lasts (see titleCodeFor). */
  titleCode?: string | null;
}

/** dogState/{dogId}: per-dog memory between blocks, written only by Functions. */
export interface EngineState {
  lastBlockStartMs: number | null;
  activityEma: number | null;
  /** Exponential average of novel windows (max softmax below the model threshold). */
  noveltyEma?: number | null;
  hrBuffer: number[];
  /** Trailing heart-rate values known to be contiguous (full blocks with no gap between them). */
  hrRun?: number;
  streak: { hr: number; temp: number };
  episode: Episode | null;
  openAlerts: number;
  /** BlockStart of the block that last wrote dogs.status (data time, not wall clock). */
  lastStatusBlockMs?: number | null;
  /** End of the last block (blocks of 2 to 10 s); absent in older states, which had 10 s blocks. */
  lastBlockEndMs?: number | null;
  /** Causal average of the behavioral softmax, for the class shown. */
  behaviorEma?: number[] | null;
  /** Consecutive windows with an alert trigger, and data time of the first one. */
  triggerRun?: number;
  triggerRunStartMs?: number | null;
  /** Reasons of the trigger run that has not opened an alert yet, so the alert names what left its range
   * before it opened (a fever that held 5 minutes, also if another variable is the one out of range at that moment). */
  runReasons?: ReasonSet | null;
  /** Exponential average of the Health Score (stableTimeConstantS), and the level last written with it. */
  stableScore?: number | null;
  lastStableLevel?: Level | null;
  lastLevel: Level | null;
  blocks: number;
}

export function initialState(openAlerts = 0): EngineState {
  return { lastBlockStartMs: null, activityEma: null, noveltyEma: null, hrBuffer: [], hrRun: 0, streak: { hr: 0, temp: 0 }, episode: null,
    openAlerts, lastStatusBlockMs: null, lastBlockEndMs: null, behaviorEma: null, triggerRun: 0, triggerRunStartMs: null, runReasons: null,
    stableScore: null, lastStableLevel: null, lastLevel: null, blocks: 0 };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number, d = 0) => x.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/** Population standard deviation of the accelerometer magnitude over one window, in g (same as ml/src/activity.py). */
export function windowIntensity(imu: ArrayLike<number>, startSample: number, n = WINDOW_SAMPLES): number {
  let s = 0, s2 = 0;
  for (let i = startSample; i < startSample + n; i++) {
    const o = i * IMU_CHANNELS;
    const m = Math.sqrt(imu[o] * imu[o] + imu[o + 1] * imu[o + 1] + imu[o + 2] * imu[o + 2]);
    s += m;
    s2 += m * m;
  }
  const mu = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mu * mu));
}

export function emaAlpha(cfg: EngineConfig, timeConstantS = cfg.activity.timeConstantS): number {
  return 1 - Math.exp(-(WINDOW_SAMPLES / 100) / timeConstantS);
}

export interface WindowEval {
  intensity: number | null;
  active: boolean | null;
  activityRatio: number | null;
  predicted: Behavior | null;
  maxProb: number | null;
  novel: boolean | null;
  noveltyRatio: number | null;
  noveltyExpected: number | null;
  rActivity: number;
  rNovelty: number;
  hr: number | null;
  /** Reconstruction error / threshold of the physiological model; null with the rule. */
  hrRatio: number | null;
  temp: number | null;
  zActivity: number | null;
  zHr: number | null;
  rB: number; rP: number; rT: number;
  healthScore: number;
  level: Level;
  hrCritical: boolean;
  /** The autoencoder alone fired the heart-rate critical rule (error / threshold ≥ criticalRatio). */
  hrShapeCritical?: boolean;
  tempCritical: boolean;
  trigger: boolean;
  /** The trigger has held alertMinDurationS, so it may open an alert; runStartMs is where it began. */
  armed: boolean;
  runStartMs: number | null;
  /** The stable Health Score after this window and its level. */
  stableHealthScore?: number;
  stableLevel?: Level;
}

export interface AlertAction {
  action: "open" | "update";
  alertId: string;
  severity: "amber" | "red";
  healthScore: number;
  reasons: AlertReason[];
  /** The reason that names the alert (its title and first cause). */
  titleCode: string | null;
  /** On "open": data time of the first triggering window. */
  startedAtMs?: number;
}

/** An episode that ended in this block: its alert gets endedAt. */
export interface ClosedEpisode { alertId: string; endedAtMs: number }

export interface BlockEval {
  windows: WindowEval[];
  result: {
    rB: number; rP: number; rT: number; healthScore: number; level: Level;
    /** For dogs.status only (the owner screens); results keep the instantaneous score. */
    stableHealthScore: number; stableLevel: Level;
    predictedBehavior: Behavior | null;
    behaviorProbs: number[] | null;
    signals: { activeFraction: number; activityRatio: number | null; noveltyRatio: number | null; hr: number | null; temp: number | null; hrRatio: number | null };
  };
  state: EngineState;
  flags: string[];
  alert: AlertAction | null;
  closed: ClosedEpisode | null;
  statusDue: boolean;
}

export interface BlockInput {
  imu: ArrayLike<number>;   // sample-major, already prefiltered
  hr: number[];             // prefiltered values of the block, in time order
  temp: number | null;      // prefiltered
  blockStartMs: number;
  /** Softmax of each 2 s window from the behavioral model; absent: provisional movement rule. */
  behavior?: BehaviorOutput | null;
  /** Heart-rate autoencoder; absent: provisional heart-rate rule. */
  physio?: PhysioScorer | null;
  /** The collar seems off the dog (prefilter «imu_no_wear»): its windows count as time without movement data,
   * not as a dog lying still, so a collar left on a table does not open an alert of low activity. */
  sensorOff?: boolean;
}

function tempScore(temp: number | null, baseline: BaselineStats | null, cfg: EngineConfig): number {
  if (temp == null) return 0;
  const [lo, hi] = cfg.tempRange;
  const outside = temp < lo ? lo - temp : temp > hi ? temp - hi : 0;
  if (outside > 0) return clamp01(0.6 + 0.8 * outside);
  if (baseline?.tempMean != null && Math.abs(temp - baseline.tempMean) > cfg.tempMaxDeviation) return 0.5;
  return 0;
}

/** Decimals that keep a value shown out of its range off its bounds: 46.70 % against 46.75–58.87 % is
 * «46,7 %» and «46,8–58,9 %», never «47 %» against «47–59 %». */
export function outsideDecimals(value: number, lo: number, hi: number, base: number): number {
  for (let d = base; d < base + 2; d++) {
    const v = round(value, d);
    if (v < round(lo, d) || v > round(hi, d)) return d;
  }
  return base + 2;
}

/** A value out of [lo, hi], rounded together with its range so the alert never reads «inside». */
function outOfRange(value: number, lo: number, hi: number, base: number): { d: number; value: number; range: [number, number] } {
  const d = outsideDecimals(value, lo, hi, base);
  return { d, value: round(value, d), range: [round(lo, d), round(hi, d)] };
}

/** Plain-Spanish reasons of one window. Only the variables
 * out of their range: movement and heart rate out of the dog's normal band (baseline ± baselineSigma, the band the app
 * shows), the temperature out of the reference range or far from its usual value, unusual movements above their
 * expected rate, and the shape of the heart rate only when the autoencoder fired the critical rule. Smaller deviations
 * still lower the score through rB and rP. When nothing is out of its range (an unusual configuration: a critical rule
 * or an alert threshold tighter than the band), `fallback` describes the deviation inside it, so an alert always names
 * a variable. */
export function windowReasons(w: WindowEval, baseline: BaselineStats | null, cfg: EngineConfig): ReasonSet {
  const k = cfg.baselineSigma;
  const reasons: AlertReason[] = [];
  if (baseline && w.rActivity > 0 && w.activityRatio != null && w.zActivity != null && Math.abs(w.zActivity) > k) {
    const [lo, hi] = normalBand(baseline.activeRatioMean, baseline.activeRatioStd, ACTIVITY_SD_FLOOR, k).map((x) => 100 * clamp01(x));
    const low = w.zActivity < 0, o = outOfRange(100 * w.activityRatio, lo, hi, 0);
    reasons.push({ component: "behavior", code: low ? "activity_low" : "activity_high", value: o.value, normalRange: o.range,
      message: `El tiempo en movimiento (${fmt(o.value, o.d)} %) está ${low ? "por debajo" : "por encima"} de su rango habitual (${fmt(o.range[0], o.d)}–${fmt(o.range[1], o.d)} %).` });
  }
  // Listed only when novelty weighs (it still counts in rB below this), and never as "5 % (up to 5 %)".
  if (w.rNovelty >= NOVELTY_REASON_MIN && w.noveltyRatio != null && w.noveltyExpected != null) {
    const val = 100 * w.noveltyRatio, exp = 100 * w.noveltyExpected;
    const d = fmt(val) === fmt(exp) ? 1 : 0;
    reasons.push({ component: "behavior", code: "behavior_unusual", value: round(val, d), normalRange: [0, round(exp, d)],
      message: `En los últimos minutos, el ${fmt(val, d)} % de sus movimientos no se pareció a ninguna de las conductas conocidas (lo habitual es hasta el ${fmt(exp, d)} %).` });
  }
  const hrb = baseline?.hrMean != null && (w.rP > 0 || w.hrCritical) && w.hr != null && w.zHr != null
    ? normalBand(baseline.hrMean, baseline.hrStd ?? 0, HR_SD_FLOOR, k) : null;
  if (hrb) {
    const high = w.hr! > baseline!.hrMean!;
    if (Math.abs(w.zHr!) > k) {
      const o = outOfRange(w.hr!, hrb[0], hrb[1], 0);
      reasons.push({ component: "heart_rate", code: high ? "hr_high" : "hr_low", value: o.value, normalRange: o.range,
        message: `La frecuencia cardiaca de los últimos ${cfg.hrAverageS} s (${fmt(o.value, o.d)} lpm) está ${high ? "por encima" : "por debajo"} de su rango habitual (${fmt(o.range[0], o.d)}–${fmt(o.range[1], o.d)} lpm).` });
    } else if (w.hrShapeCritical) {
      reasons.push(hrPatternReason(w, hrb));
    }
  }
  if (w.rT > 0 && w.temp != null) {
    const [lo, hi] = cfg.tempRange;
    if (w.temp < lo || w.temp > hi) {
      const high = w.temp > hi, o = outOfRange(w.temp, lo, hi, 1);
      reasons.push({ component: "temperature", code: high ? "temp_high" : "temp_low", value: o.value, normalRange: o.range,
        message: `La temperatura (${fmt(o.value, o.d)} °C) está ${high ? "por encima" : "por debajo"} del rango de referencia (${fmt(o.range[0], o.d)}–${fmt(o.range[1], o.d)} °C).` });
    } else if (baseline?.tempMean != null) {
      const dev = cfg.tempMaxDeviation, o = outOfRange(w.temp, baseline.tempMean - dev, baseline.tempMean + dev, 1);
      reasons.push({ component: "temperature", code: "temp_deviation", value: o.value, normalRange: o.range,
        message: `La temperatura (${fmt(o.value, o.d)} °C) se aleja más de ${fmt(dev, 1)} °C de su valor habitual (${fmt(baseline.tempMean, 1)} °C).` });
    }
  }
  if (reasons.length) return { reasons, fallback: false };
  // Nothing out of its range: describe the deviation inside it. The shape of the heart rate first (the model flagged
  // it), then a heart rate away from its average, then the movement.
  if (hrb && w.hrRatio != null && w.hrRatio > 1) return { reasons: [hrPatternReason(w, hrb)], fallback: true };
  if (hrb && Math.abs(w.zHr!) > 1) {
    const high = w.hr! > baseline!.hrMean!;
    return { fallback: true, reasons: [{ component: "heart_rate", code: high ? "hr_high" : "hr_low", value: round(w.hr!), normalRange: [round(hrb[0]), round(hrb[1])],
      message: `La frecuencia cardiaca de los últimos ${cfg.hrAverageS} s (${fmt(w.hr!)} lpm) está ${high ? "más alta" : "más baja"} que su promedio habitual (${fmt(baseline!.hrMean!)} lpm).` }] };
  }
  if (baseline && w.rActivity > 0 && w.activityRatio != null && w.zActivity != null) {
    const act = normalBand(baseline.activeRatioMean, baseline.activeRatioStd, ACTIVITY_SD_FLOOR, k).map((x) => round(100 * clamp01(x))) as [number, number];
    const low = w.zActivity < 0;
    return { fallback: true, reasons: [{ component: "behavior", code: low ? "activity_low" : "activity_high", value: round(100 * w.activityRatio), normalRange: act,
      message: `El tiempo en movimiento (${fmt(100 * w.activityRatio)} %) está ${low ? "por debajo" : "por encima"} de su promedio habitual (${fmt(100 * baseline.activeRatioMean)} %).` }] };
  }
  return { reasons: [], fallback: true };
}

/** The autoencoder flags the shape of the last minute even when its mean is within the usual range. */
function hrPatternReason(w: WindowEval, band: [number, number]): AlertReason {
  const lo = round(band[0]), hi = round(band[1]);
  return { component: "heart_rate", code: "hr_pattern", value: round(w.hr!), normalRange: [lo, hi],
    message: `En el último minuto, su frecuencia cardiaca (${fmt(w.hr!)} lpm en promedio) no siguió su patrón normal, aunque su promedio está dentro de su rango habitual (${fmt(lo)}–${fmt(hi)} lpm).` };
}

/** The reasons of one window (see windowReasons). */
export function buildReasons(w: WindowEval, baseline: BaselineStats | null, cfg: EngineConfig): AlertReason[] {
  return windowReasons(w, baseline, cfg).reasons;
}

// ── Reasons of an episode ───────────────────────────────────────────────────────────────────────────

/** How much further out of its range a value must go before the alert is rewritten with it. */
const REASON_STEP: Record<Component, number> = { temperature: 0.2, heart_rate: 5, behavior: 5 };

/** How far a reason's value is out of its range, in its own unit (0 inside it, and for the shape of the heart rate). */
function outside(r: AlertReason): number {
  const [lo, hi] = r.normalRange;
  return r.value < lo ? lo - r.value : r.value > hi ? r.value - hi : 0;
}

/** Same order as the alert's causes (shared/alert-text.ts): out of range before shape-only, then by how far out of its
 * band each one is. A level reason of a signal makes its weaker one redundant. */
function tidy(reasons: AlertReason[]): AlertReason[] {
  const has = (code: string) => reasons.some((r) => r.code === code);
  return reasons
    .filter((r) => !(r.code === "hr_pattern" && (has("hr_high") || has("hr_low"))) && !(r.code === "temp_deviation" && (has("temp_high") || has("temp_low"))))
    .sort(compareReasons);
}

/** The reasons as the alert stores them: the one that names it first, then the others by deviation. */
function titleFirst(reasons: AlertReason[], titleCode: string | null): AlertReason[] {
  const first = reasons.find((r) => r.code === titleCode);
  return first ? [first, ...reasons.filter((r) => r !== first)] : reasons;
}

/** Every reason of both sets, keeping the most extreme value of each code; real reasons replace fallback ones. */
export function mergeReasons(prev: ReasonSet | null, next: ReasonSet): ReasonSet {
  if (!prev || (prev.fallback && !next.fallback)) return { reasons: tidy([...next.reasons]), fallback: next.fallback };
  if (!prev.fallback && next.fallback) return prev;
  const byCode = new Map(prev.reasons.map((r) => [r.code, r]));
  for (const r of next.reasons) {
    const p = byCode.get(r.code);
    if (!p || outside(r) > outside(p)) byCode.set(r.code, r);
  }
  return { reasons: tidy([...byCode.values()]), fallback: prev.fallback };
}

/** Whether the merged reasons are worth rewriting the alert: a new reason, real reasons replacing fallback ones, or a
 * value REASON_STEP further out of its range than the one written. */
export function reasonsChanged(written: ReasonSet, next: ReasonSet): boolean {
  if (written.fallback !== next.fallback || written.reasons.length !== next.reasons.length) return true;
  return next.reasons.some((r) => {
    const w = written.reasons.find((x) => x.code === r.code);
    return !w || outside(r) - outside(w) >= REASON_STEP[r.component];
  });
}

/** The reason that names an alert. When it opens, the variable furthest out of its band (in
 * band widths, shared/alert-text.ts); while it lasts, the same one, so its title and first cause do not change under
 * the owner's eyes when another variable joins. It is chosen again when the alert rises to «Revisar» (`escalates`) or
 * when its reason left the list (a fallback replaced by a real reason, a shape replaced by a level). */
export function titleCodeFor(prev: string | null | undefined, reasons: AlertReason[], escalates: boolean): string | null {
  if (prev && !escalates && reasons.some((r) => r.code === prev)) return prev;
  return primaryReason(reasons)?.code ?? null;
}

/** Scores one block and returns the next per-dog state. alertId is used if this block opens an alert episode. */
export function evaluateBlock(input: BlockInput, prev: EngineState, baseline: BaselineStats | null, cfg: EngineConfig,
  opts: { alertId: string }): BlockEval {
  const flags: string[] = [];
  const outOfOrder = prev.lastBlockStartMs != null && input.blockStartMs <= prev.lastBlockStartMs;
  const st: EngineState = structuredClone(prev);
  if (outOfOrder) flags.push("out_of_order");
  if (!baseline) flags.push("no_baseline");
  const model = input.behavior ?? null;
  // Activity from the model only if the dog's baseline ratio was computed with the same model (same definition).
  const modelActivity = model != null && baseline?.activitySource === model.meta.version;
  if (!model) flags.push("behavior_rules");
  else if (!modelActivity) flags.push("activity_rules");
  const physio = input.physio ?? null;
  if (!physio) flags.push("physio_rules");
  const fullScaleRatio = cfg.physio?.fullScaleRatio ?? physio?.meta.fullScaleRatio ?? 3;
  const criticalRatio = cfg.physio?.criticalRatio ?? physio?.meta.criticalRatio ?? 2;
  let physioWarmup = false;
  // The buffer keeps what the level rule averages and what the autoencoder reads, whichever is longer.
  const keepHr = Math.max(cfg.hrAverageS, physio?.meta.sequenceLength ?? 0);
  const samples = Math.floor(input.imu.length / IMU_CHANNELS);
  const nWin = Math.max(1, Math.floor(samples / WINDOW_SAMPLES));
  const blockSeconds = nWin * WINDOW_S;
  // Seconds of data missing before this block, so the stable score weighs its first window by the time passed.
  let missingS = 0;
  if (!outOfOrder && prev.lastBlockStartMs != null) {
    // Blocks of 2 to 10 s, so the gap is measured from where the previous block ended; states from before
    // it had 10 s blocks. gap:n counts the missing 2 s windows.
    const prevEnd = prev.lastBlockEndMs ?? prev.lastBlockStartMs + BLOCK_SECONDS * 1000;
    const gapS = (input.blockStartMs - prevEnd) / 1000;
    if (gapS > WINDOW_S / 2) {
      flags.push(`gap:${Math.round(gapS / WINDOW_S)}`);
      st.streak = { hr: 0, temp: 0 };
      st.hrRun = 0;
      st.behaviorEma = null;
      st.triggerRun = 0;
      st.triggerRunStartMs = null;
      st.runReasons = null;
      missingS = gapS;
      if (gapS > keepHr) st.hrBuffer = [];
    }
  }
  const alpha = emaAlpha(cfg);
  const alphaNovelty = emaAlpha(cfg, cfg.novelty.timeConstantS);
  const expected = model?.meta.noveltyQuantile ?? null;
  st.noveltyEma = st.noveltyEma ?? null;
  // Heart-rate buffer after each window. The pushes depend on nothing else, so the autoencoder scores the whole block
  // in one batch before the window loop. It reads only 60 contiguous seconds: a block with fewer than 10
  // values (the sensor lost the signal) or a gap between blocks restarts the count, because joining two stretches
  // makes a jump the model never saw in training.
  const hrAfter: number[][] = [];
  const runAfter: number[] = [];
  const fullHr = input.hr.length >= blockSeconds;
  let run = st.hrRun ?? 0;
  for (let w = 0; w < nWin; w++) {
    const lo = Math.floor((w * input.hr.length) / nWin), hi = Math.floor(((w + 1) * input.hr.length) / nWin);
    st.hrBuffer.push(...input.hr.slice(lo, hi));
    if (st.hrBuffer.length > keepHr) st.hrBuffer.splice(0, st.hrBuffer.length - keepHr);
    hrAfter.push(st.hrBuffer.slice());
    run = fullHr ? run + hi - lo : 0;
    runAfter.push(run);
  }
  st.hrRun = run;
  const hrRatios: (number | null)[] = new Array(nWin).fill(null);
  // A baseline without heart rate leaves both heart-rate rules off.
  const hrMean = baseline?.hrMean ?? null, hrStd = baseline?.hrStd ?? 0;
  if (physio && hrMean != null) {
    const L = physio.meta.sequenceLength;
    const seqs = hrAfter.map((b, w) => (runAfter[w] >= L ? sequenceZ(b, hrMean, hrStd, L) : null));
    const ready = seqs.flatMap((z, i) => (z ? [i] : []));
    if (ready.length < nWin) physioWarmup = true;
    if (ready.length) {
      const errors = physio.score(ready.map((i) => seqs[i]!));
      ready.forEach((i, j) => { hrRatios[i] = errors[j] / physio.meta.threshold; });
    }
  }

  const windows: WindowEval[] = [];
  const tauB = model?.meta.smoothingTimeConstantS ?? 0;
  const alphaB = tauB > 0 ? 1 - Math.exp(-WINDOW_S / tauB) : 1;
  const minRun = Math.max(1, Math.ceil((cfg.alertMinDurationS ?? 0) / WINDOW_S));
  st.triggerRun = st.triggerRun ?? 0;
  st.triggerRunStartMs = st.triggerRunStartMs ?? null;
  // Reasons of each triggering window, and of the trigger run after each window (earlier blocks included).
  const winReasons: (ReasonSet | null)[] = new Array(nWin).fill(null);
  const runAfterW: (ReasonSet | null)[] = new Array(nWin).fill(null);
  let runAcc: ReasonSet | null = st.triggerRun > 0 ? st.runReasons ?? null : null;
  const stableTau = cfg.stableTimeConstantS ?? 300;
  st.stableScore = st.stableScore ?? null;
  for (let w = 0; w < nWin; w++) {
    let intensity: number | null = null, active: boolean | null = null;
    const reading = model && model.probs[w] ? readWindow(model.probs[w], model.meta) : null;
    // The class shown is the argmax of a causal average of the softmax (a posture lasts many seconds).
    // Activity and novelty keep the raw window, as the dog's baseline and the novelty threshold were made with it.
    let shown = reading?.predicted ?? null;
    if (model && model.probs[w] && tauB > 0) {
      const p = model.probs[w];
      st.behaviorEma = st.behaviorEma && st.behaviorEma.length === p.length
        ? st.behaviorEma.map((e, i) => round(e + alphaB * (p[i] - e), 4)) : p.map((x) => round(x, 4));
      let best = 0;
      for (let i = 1; i < st.behaviorEma.length; i++) if (st.behaviorEma[i] > st.behaviorEma[best]) best = i;
      shown = model.meta.classes[best];
    }
    if (!input.sensorOff && samples >= (w + 1) * WINDOW_SAMPLES) {
      intensity = windowIntensity(input.imu, w * WINDOW_SAMPLES);
      active = modelActivity && reading ? reading.active : intensity > cfg.activity.thresholdG;
      const a = active ? 1 : 0;
      st.activityEma = st.activityEma == null ? (baseline?.activeRatioMean ?? a) : st.activityEma + alpha * (a - st.activityEma);
    }
    if (reading && expected != null) {
      const n = reading.novel ? 1 : 0;
      st.noveltyEma = st.noveltyEma == null ? expected : st.noveltyEma + alphaNovelty * (n - st.noveltyEma);
    }
    const recentHr = hrAfter[w].length > cfg.hrAverageS ? hrAfter[w].slice(-cfg.hrAverageS) : hrAfter[w];
    const hr = recentHr.length >= cfg.hrAverageS / 2 ? mean(recentHr) : null;

    const zActivity = baseline && st.activityEma != null ? (st.activityEma - baseline.activeRatioMean) / Math.max(baseline.activeRatioStd, ACTIVITY_SD_FLOOR) : null;
    const zHrSigned = hrMean != null && hr != null ? (hr - hrMean) / Math.max(hrStd, HR_SD_FLOOR) : null;
    const rActivity = zActivity == null ? 0 : clamp01((Math.abs(zActivity) - 1) / 3);
    const rNovelty = st.noveltyEma == null || expected == null ? 0
      : clamp01((st.noveltyEma - expected) / Math.max(1e-6, cfg.novelty.fullScaleRate - expected));
    const rB = Math.max(rActivity, rNovelty);
    // The autoencoder adds the shape of the last minute to the level rule, it does not replace it:
    // it misses smooth level shifts that the rule catches, and the rule confuses normal activity with tachycardia.
    // r_p is the larger of both; the critical rule fires on either. Without the model (or in the first minute) only
    // the level rule applies.
    const hrRatio = hrRatios[w];
    const rLevel = zHrSigned == null ? 0 : clamp01((Math.abs(zHrSigned) - 1) / 4);
    const rP = hrRatio != null ? Math.max(rLevel, ratioToScore(hrRatio, fullScaleRatio)) : rLevel;
    const rT = tempScore(input.temp, baseline, cfg);
    const hs = healthScore({ rB, rP, rT }, cfg.weights);
    const levelSigma = cfg.physio?.levelSigma ?? cfg.baselineSigma;
    const hrShapeCritical = hrRatio != null && hrRatio >= criticalRatio;
    const hrCritical = (zHrSigned != null && Math.abs(zHrSigned) > levelSigma) || hrShapeCritical;
    const tempCritical = input.temp != null && (input.temp < cfg.tempRange[0] || input.temp > cfg.tempRange[1]);
    // Sustained low activity (lethargy, immobility) opens an alert by itself.
    const actCritical = cfg.activityCriticalSigma != null && zActivity != null && zActivity < -cfg.activityCriticalSigma;
    st.streak.hr = hrCritical ? st.streak.hr + 1 : 0;
    st.streak.temp = tempCritical ? st.streak.temp + 1 : 0;
    const trigger = hs < cfg.alertThreshold || st.streak.hr >= cfg.consecutiveCritical || st.streak.temp >= cfg.consecutiveCritical || actCritical;
    // The trigger must hold alertMinDurationS before it can open an alert.
    if (trigger) {
      st.triggerRun += 1;
      st.triggerRunStartMs ??= input.blockStartMs + w * WINDOW_MS;
    } else {
      st.triggerRun = 0;
      st.triggerRunStartMs = null;
    }
    const armed = trigger && st.triggerRun >= minRun;
    // The stable score, an exponential average in data time (the first window after a gap weighs the time
    // that passed). Display only: nothing below reads it.
    const dtS = WINDOW_S + (w === 0 ? missingS : 0);
    const stableK = stableTau > 0 ? 1 - Math.exp(-dtS / stableTau) : 1;
    st.stableScore = round(st.stableScore == null ? hs : st.stableScore + stableK * (hs - st.stableScore), 3);
    const stableHs = Math.round(st.stableScore);
    const we: WindowEval = { intensity, active, activityRatio: st.activityEma, predicted: shown, maxProb: reading?.maxProb ?? null,
      novel: reading?.novel ?? null, noveltyRatio: st.noveltyEma ?? null, noveltyExpected: expected, rActivity, rNovelty,
      hr, hrRatio, temp: input.temp, zActivity, zHr: zHrSigned, rB, rP, rT, healthScore: hs, level: levelOf(hs, cfg.levels), hrCritical, hrShapeCritical,
      tempCritical, trigger, armed, runStartMs: st.triggerRunStartMs, stableHealthScore: stableHs, stableLevel: levelOf(stableHs, cfg.levels) };
    windows.push(we);
    if (trigger) {
      winReasons[w] = windowReasons(we, baseline, cfg);
      runAcc = mergeReasons(runAcc, winReasons[w]!);
    } else runAcc = null;
    runAfterW[w] = runAcc;
  }
  if (physioWarmup) flags.push("physio_warmup");

  const last = windows[windows.length - 1];
  const measured = windows.filter((w) => w.active != null);
  const result = {
    rB: round(last.rB, 3), rP: round(last.rP, 3), rT: round(last.rT, 3), healthScore: last.healthScore, level: last.level,
    stableHealthScore: last.stableHealthScore!, stableLevel: last.stableLevel!,
    predictedBehavior: last.predicted,
    behaviorProbs: model?.probs[windows.length - 1]?.map((p) => round(p, 4)) ?? null,
    signals: {
      activeFraction: measured.length ? measured.filter((w) => w.active).length / measured.length : 0,
      activityRatio: last.activityRatio == null ? null : round(last.activityRatio, 4),
      noveltyRatio: last.noveltyRatio == null ? null : round(last.noveltyRatio, 4),
      hr: last.hr == null ? null : round(last.hr, 1),
      temp: input.temp,
      hrRatio: last.hrRatio == null ? null : round(last.hrRatio, 3),
    },
  };

  if (outOfOrder) return { windows, result, state: prev, flags, alert: null, closed: null, statusDue: false };

  // Alert episodes.
  let alert: AlertAction | null = null;
  let closed: ClosedEpisode | null = null;
  // Without an open episode, only windows from the first armed one count; the alert starts where its
  // uninterrupted trigger began (possibly in an earlier block).
  const openAt = st.episode ? 0 : windows.findIndex((w) => w.armed);
  const counted = openAt < 0 ? [] : windows.slice(openAt);
  const triggered = counted.filter((w) => w.trigger);
  if (triggered.length) {
    const runStart = windows[openAt].runStartMs;
    const firstTriggerMs = st.episode ? input.blockStartMs + windows.findIndex((w) => w.trigger) * WINDOW_MS
      : runStart ?? input.blockStartMs + openAt * WINDOW_MS;
    const lastTriggerEndMs = input.blockStartMs + (windows.map((w) => w.trigger).lastIndexOf(true) + 1) * WINDOW_MS;
    const worst = triggered.reduce((a, b) => (b.healthScore < a.healthScore ? b : a));
    const severity: "amber" | "red" = counted.some((w) => w.trigger && w.level === "red") ? "red" : "amber";
    // The alert names every variable that left its range while the trigger held, not only those of
    // its last window. Before, a fever that ended while low activity kept the trigger alive was replaced by the
    // activity in the next update, and the alert of a fever stopped naming the temperature.
    const ep0 = st.episode;
    let set: ReasonSet | null = ep0 ? (ep0.reasons ? { reasons: ep0.reasons, fallback: ep0.fallback ?? false } : null) : runAfterW[openAt];
    for (let i = ep0 ? 0 : openAt + 1; i < windows.length; i++) if (winReasons[i]) set = mergeReasons(set, winReasons[i]!);
    const merged = set?.reasons ?? [];
    const components = [...new Set(merged.map((r) => r.component))];
    if (!ep0) {
      const titleCode = titleCodeFor(null, merged, false);
      const reasons = titleFirst(merged, titleCode);
      st.episode = { alertId: opts.alertId, severity, minHealthScore: worst.healthScore, components, windowsSinceTrigger: 0,
        startMs: firstTriggerMs, reasons, fallback: set?.fallback ?? false, titleCode };
      st.openAlerts += 1;
      alert = { action: "open", alertId: opts.alertId, severity, healthScore: worst.healthScore, reasons, titleCode, startedAtMs: firstTriggerMs };
    } else {
      const escalates = severity === "red" && ep0.severity === "amber";
      // States from before have no reasons: a new component rewrites the alert, as it did then.
      const changed = ep0.reasons
        ? reasonsChanged({ reasons: ep0.reasons, fallback: ep0.fallback ?? false }, set!)
        : components.some((c) => !ep0.components.includes(c));
      const worse = worst.healthScore <= ep0.minHealthScore - 5;
      if (escalates || changed || worse) {
        ep0.severity = escalates ? "red" : ep0.severity;
        ep0.minHealthScore = Math.min(ep0.minHealthScore, worst.healthScore);
        ep0.components = [...new Set([...ep0.components, ...components])];
        ep0.fallback = set?.fallback ?? false;
        // States from before it have no titleCode; the first update chooses it.
        ep0.titleCode = titleCodeFor(ep0.titleCode, merged, escalates);
        ep0.reasons = titleFirst(merged, ep0.titleCode);
        alert = { action: "update", alertId: ep0.alertId, severity: ep0.severity, healthScore: ep0.minHealthScore, reasons: ep0.reasons, titleCode: ep0.titleCode };
      }
      ep0.windowsSinceTrigger = 0;
    }
    // Windows after the last trigger inside this block still count towards closing the episode.
    const lastTrigger = windows.map((w) => w.trigger).lastIndexOf(true);
    st.episode!.windowsSinceTrigger = windows.length - 1 - lastTrigger;
    st.episode!.lastTriggerMs = lastTriggerEndMs;
  } else if (st.episode) {
    st.episode.windowsSinceTrigger += windows.length;
    if (st.episode.windowsSinceTrigger * (WINDOW_SAMPLES / 100) >= cfg.episodeGapS) {
      // The episode ends where its last triggering window ended.
      closed = { alertId: st.episode.alertId, endedAtMs: st.episode.lastTriggerMs ?? input.blockStartMs };
      st.episode = null;
    }
  }

  // The trigger run that has not opened an alert yet carries its reasons to the next block.
  st.runReasons = st.episode ? null : runAcc;

  // Measured in data time. At ×1 (one block every 10 s) the card refreshes with every block, as before; a
  // faster simulation or a CSV upload no longer skips blocks. Also when the stable level changes.
  const statusDue = prev.lastStatusBlockMs == null || input.blockStartMs - prev.lastStatusBlockMs >= cfg.statusMinIntervalS * 1000
    || last.level !== prev.lastLevel || last.stableLevel !== (prev.lastStableLevel ?? null) || alert != null;
  if (statusDue) {
    st.lastStatusBlockMs = input.blockStartMs;
    st.lastLevel = last.level;
    st.lastStableLevel = last.stableLevel ?? null;
  }
  st.lastBlockStartMs = input.blockStartMs;
  st.lastBlockEndMs = input.blockStartMs + nWin * WINDOW_MS;
  st.blocks += 1;
  return { windows, result, state: st, flags, alert, closed, statusDue };
}

// ── Baselines from a dog's normal data (used by the simulator for simulated dogs; same code as the live engine) ──

/** Active-time baseline with the provisional movement rule (dogs without the behavioral model). */
export function activityBaseline(imu: ArrayLike<number>, cfg: EngineConfig): { mean: number; std: number; windows: number } {
  const nWin = Math.floor(imu.length / IMU_CHANNELS / WINDOW_SAMPLES);
  const active = new Array<number>(nWin);
  for (let w = 0; w < nWin; w++) active[w] = windowIntensity(imu, w * WINDOW_SAMPLES) > cfg.activity.thresholdG ? 1 : 0;
  return activityBaselineFromFlags(active, cfg);
}

/** Mean and std of the active-time ratio over two passes of the recording (the second pass is the steady state).
 * `active` holds one 0/1 per consecutive 2 s window, from the model or from the rule. */
export function activityBaselineFromFlags(active: number[], cfg: EngineConfig): { mean: number; std: number; windows: number } {
  const nWin = active.length;
  const alpha = emaAlpha(cfg);
  let ema = mean(active);
  const values: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let w = 0; w < nWin; w++) {
      ema += alpha * (active[w] - ema);
      if (pass === 1) values.push(ema);
    }
  }
  const m = mean(values);
  return { mean: m, std: Math.sqrt(mean(values.map((v) => (v - m) ** 2))), windows: nWin };
}

/** Mean and std of the hrAverageS-second average heart rate, evaluated every 2 s like the live engine. */
export function hrBaseline(values: number[], cfg: EngineConfig): { mean: number; std: number; n: number } {
  const k = cfg.hrAverageS;
  const cs = [0];
  for (const v of values) cs.push(cs[cs.length - 1] + v);
  const avgs: number[] = [];
  for (let end = k; end <= values.length; end += 2) avgs.push((cs[end] - cs[end - k]) / k);
  const m = mean(avgs);
  return { mean: m, std: Math.sqrt(mean(avgs.map((v) => (v - m) ** 2))), n: avgs.length };
}
