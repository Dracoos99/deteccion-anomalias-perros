/**
 * Scoring engine. Behavior comes from the CNN-LSTM when its output is given (phase 2): class,
 * active-time ratio and novelty; otherwise the provisional movement rule applies. Heart rate combines the level
 * rule below with the LSTM autoencoder when it is given (phase 4): the autoencoder scores the shape of the last 60
 * contiguous seconds, and r_p and the critical rule take either. The Health Score is the weighted sum of the three
 * scores, with its levels and alert triggers.
 * The ramps that turn a deviation into r ∈ [0, 1] follow the prototype with
 * the heart rate relative to the dog's baseline. Pure functions: used by Cloud Functions and the simulator.
 *
 * Per 10 s block: 5 windows of 2 s. Per window:
 *   active     = std(|acc|) > activity.thresholdG            (stand-in for the behavioral model)
 *   ratio      = exponential average of active, time constant activity.timeConstantS
 *   hr         = mean of the last hrAverageS heart-rate values
 *   rB = clamp((|z_ratio| − 1) / 3)   rT = temperature rules
 *   rP = max(clamp((|z_hr| − 1) / 4), clamp((error / threshold − 1) / (fullScaleRatio − 1)))   (second term: autoencoder)
 *   critical   = |z_hr| > levelSigma (default baselineSigma), error / threshold ≥ criticalRatio, or temperature outside
 *                tempRange; an alert needs consecutiveCritical windows
 * The block result is its last window (C8). Without a baseline only the absolute rules apply.
 */
import { healthScore, levelOf, type AlertReason, type Baseline, type Behavior, type FusionConfig, type Level } from "./types";
import { readWindow, type BehaviorOutput } from "./behavior-model";
import { ratioToScore, sequenceZ, type PhysioScorer } from "./physio-model";

export const ENGINE_VERSION = "provisional-rules-3";
export const IMU_CHANNELS = 6;
export const WINDOW_SAMPLES = 200;   // 2 s at 100 Hz
export const BLOCK_SECONDS = 10;
const ACTIVITY_SD_FLOOR = 0.02;      // 2 percentage points
const HR_SD_FLOOR = 1;               // bpm
const WINDOW_MS = (WINDOW_SAMPLES / 100) * 1000;
/** rNovelty below this still lowers the score but is not listed as an alert reason. */
export const NOVELTY_REASON_MIN = 0.1;

export type EngineConfig = Omit<FusionConfig, "updatedBy" | "updatedAt">;
export type BaselineStats = Pick<Baseline, "activeRatioMean" | "activeRatioStd" | "hrMean" | "hrStd" | "tempMean" | "tempStd">
  & Partial<Pick<Baseline, "imuMean" | "imuStd" | "activitySource">>;
type Component = AlertReason["component"];

export interface Episode {
  alertId: string;
  severity: "amber" | "red";
  minHealthScore: number;
  components: Component[];
  windowsSinceTrigger: number;
  /** Data time of the first triggering window and the end of the last one (absent in older states). */
  startMs?: number;
  lastTriggerMs?: number;
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
  lastStatusWriteMs: number | null;
  lastLevel: Level | null;
  blocks: number;
}

export function initialState(openAlerts = 0): EngineState {
  return { lastBlockStartMs: null, activityEma: null, noveltyEma: null, hrBuffer: [], hrRun: 0, streak: { hr: 0, temp: 0 }, episode: null,
    openAlerts, lastStatusWriteMs: null, lastLevel: null, blocks: 0 };
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
  tempCritical: boolean;
  trigger: boolean;
}

export interface AlertAction {
  action: "open" | "update";
  alertId: string;
  severity: "amber" | "red";
  healthScore: number;
  reasons: AlertReason[];
  /** On "open": data time of the first triggering window. */
  startedAtMs?: number;
}

/** An episode that ended in this block: its alert gets endedAt. */
export interface ClosedEpisode { alertId: string; endedAtMs: number }

export interface BlockEval {
  windows: WindowEval[];
  result: {
    rB: number; rP: number; rT: number; healthScore: number; level: Level;
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
}

function tempScore(temp: number | null, baseline: BaselineStats | null, cfg: EngineConfig): number {
  if (temp == null) return 0;
  const [lo, hi] = cfg.tempRange;
  const outside = temp < lo ? lo - temp : temp > hi ? temp - hi : 0;
  if (outside > 0) return clamp01(0.6 + 0.8 * outside);
  if (baseline?.tempMean != null && Math.abs(temp - baseline.tempMean) > cfg.tempMaxDeviation) return 0.5;
  return 0;
}

/** Plain-Spanish reasons of the deviated components. */
export function buildReasons(w: WindowEval, baseline: BaselineStats | null, cfg: EngineConfig): AlertReason[] {
  const reasons: AlertReason[] = [];
  if (baseline && w.rActivity > 0 && w.activityRatio != null && w.zActivity != null) {
    const sd = Math.max(baseline.activeRatioStd, ACTIVITY_SD_FLOOR);
    const lo = round(100 * clamp01(baseline.activeRatioMean - sd)), hi = round(100 * clamp01(baseline.activeRatioMean + sd));
    const low = w.zActivity < 0;
    reasons.push({ component: "behavior", code: low ? "activity_low" : "activity_high", value: round(100 * w.activityRatio),
      normalRange: [lo, hi],
      message: `El tiempo en movimiento (${fmt(100 * w.activityRatio)} %) está ${low ? "por debajo" : "por encima"} de su rango habitual (${fmt(lo)}–${fmt(hi)} %).` });
  }
  // Listed only when novelty weighs (it still counts in rB below this), and never as "5 % (up to 5 %)".
  if (w.rNovelty >= NOVELTY_REASON_MIN && w.noveltyRatio != null && w.noveltyExpected != null) {
    const val = 100 * w.noveltyRatio, exp = 100 * w.noveltyExpected;
    const d = fmt(val) === fmt(exp) ? 1 : 0;
    reasons.push({ component: "behavior", code: "behavior_unusual", value: round(val, d), normalRange: [0, round(exp, d)],
      message: `En los últimos minutos, el ${fmt(val, d)} % de sus movimientos no se pareció a ninguna de las conductas conocidas (lo habitual es hasta el ${fmt(exp, d)} %).` });
  }
  if (baseline?.hrMean != null && (w.rP > 0 || w.hrCritical) && w.hr != null && w.zHr != null) {
    const sd = Math.max(baseline.hrStd ?? 0, HR_SD_FLOOR);
    const lo = round(baseline.hrMean - sd), hi = round(baseline.hrMean + sd);
    const high = w.hr > baseline.hrMean;
    if (w.hrRatio != null && Math.abs(w.zHr) < 1) {
      // The autoencoder flags the shape of the last minute even when its mean is within the usual range.
      reasons.push({ component: "heart_rate", code: "hr_pattern", value: round(w.hr), normalRange: [lo, hi],
        message: `En el último minuto, su frecuencia cardiaca (${fmt(w.hr)} lpm en promedio) no siguió su patrón normal, aunque su promedio está dentro de su rango habitual (${fmt(lo)}–${fmt(hi)} lpm).` });
    } else {
      reasons.push({ component: "heart_rate", code: high ? "hr_high" : "hr_low", value: round(w.hr), normalRange: [lo, hi],
        message: `La frecuencia cardiaca de los últimos ${cfg.hrAverageS} s (${fmt(w.hr)} lpm) está ${high ? "por encima" : "por debajo"} de su rango habitual (${fmt(lo)}–${fmt(hi)} lpm).` });
    }
  }
  if (w.rT > 0 && w.temp != null) {
    const [lo, hi] = cfg.tempRange;
    if (w.temp < lo || w.temp > hi) {
      const high = w.temp > hi;
      reasons.push({ component: "temperature", code: high ? "temp_high" : "temp_low", value: round(w.temp, 1), normalRange: [lo, hi],
        message: `La temperatura (${fmt(w.temp, 1)} °C) está ${high ? "por encima" : "por debajo"} del rango de referencia (${fmt(lo, 1)}–${fmt(hi, 1)} °C).` });
    } else if (baseline?.tempMean != null) {
      const d = cfg.tempMaxDeviation;
      reasons.push({ component: "temperature", code: "temp_deviation", value: round(w.temp, 1),
        normalRange: [round(baseline.tempMean - d, 1), round(baseline.tempMean + d, 1)],
        message: `La temperatura (${fmt(w.temp, 1)} °C) se aleja más de ${fmt(d, 1)} °C de su valor habitual (${fmt(baseline.tempMean, 1)} °C).` });
    }
  }
  return reasons;
}

/** Scores one block and returns the next per-dog state. alertId is used if this block opens an alert episode. */
export function evaluateBlock(input: BlockInput, prev: EngineState, baseline: BaselineStats | null, cfg: EngineConfig,
  opts: { alertId: string; nowMs: number }): BlockEval {
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
  if (!outOfOrder && prev.lastBlockStartMs != null) {
    const gapS = (input.blockStartMs - prev.lastBlockStartMs) / 1000;
    if (gapS > 1.5 * BLOCK_SECONDS) {
      flags.push(`gap:${Math.round(gapS / BLOCK_SECONDS) - 1}`);
      st.streak = { hr: 0, temp: 0 };
      st.hrRun = 0;
      if (gapS > keepHr) st.hrBuffer = [];
    }
  }

  const samples = Math.floor(input.imu.length / IMU_CHANNELS);
  const nWin = Math.max(1, Math.floor(samples / WINDOW_SAMPLES));
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
  const fullHr = input.hr.length >= BLOCK_SECONDS;
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
  for (let w = 0; w < nWin; w++) {
    let intensity: number | null = null, active: boolean | null = null;
    const reading = model && model.probs[w] ? readWindow(model.probs[w], model.meta) : null;
    if (samples >= (w + 1) * WINDOW_SAMPLES) {
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
    const hrCritical = (zHrSigned != null && Math.abs(zHrSigned) > levelSigma) || (hrRatio != null && hrRatio >= criticalRatio);
    const tempCritical = input.temp != null && (input.temp < cfg.tempRange[0] || input.temp > cfg.tempRange[1]);
    st.streak.hr = hrCritical ? st.streak.hr + 1 : 0;
    st.streak.temp = tempCritical ? st.streak.temp + 1 : 0;
    const trigger = hs < cfg.alertThreshold || st.streak.hr >= cfg.consecutiveCritical || st.streak.temp >= cfg.consecutiveCritical;
    windows.push({ intensity, active, activityRatio: st.activityEma, predicted: reading?.predicted ?? null, maxProb: reading?.maxProb ?? null,
      novel: reading?.novel ?? null, noveltyRatio: st.noveltyEma ?? null, noveltyExpected: expected, rActivity, rNovelty,
      hr, hrRatio, temp: input.temp, zActivity, zHr: zHrSigned, rB, rP, rT, healthScore: hs, level: levelOf(hs, cfg.levels), hrCritical, tempCritical, trigger });
  }
  if (physioWarmup) flags.push("physio_warmup");

  const last = windows[windows.length - 1];
  const measured = windows.filter((w) => w.active != null);
  const result = {
    rB: round(last.rB, 3), rP: round(last.rP, 3), rT: round(last.rT, 3), healthScore: last.healthScore, level: last.level,
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
  const triggered = windows.filter((w) => w.trigger);
  if (triggered.length) {
    const firstTriggerMs = input.blockStartMs + windows.findIndex((w) => w.trigger) * WINDOW_MS;
    const lastTriggerEndMs = input.blockStartMs + (windows.map((w) => w.trigger).lastIndexOf(true) + 1) * WINDOW_MS;
    const worst = triggered.reduce((a, b) => (b.healthScore < a.healthScore ? b : a));
    const severity: "amber" | "red" = windows.some((w) => w.trigger && w.level === "red") ? "red" : "amber";
    const reasons = buildReasons(last.trigger ? last : triggered[triggered.length - 1], baseline, cfg);
    const components = reasons.map((r) => r.component);
    if (!st.episode) {
      st.episode = { alertId: opts.alertId, severity, minHealthScore: worst.healthScore, components, windowsSinceTrigger: 0,
        startMs: firstTriggerMs };
      st.openAlerts += 1;
      alert = { action: "open", alertId: opts.alertId, severity, healthScore: worst.healthScore, reasons, startedAtMs: firstTriggerMs };
    } else {
      const ep = st.episode;
      const escalates = severity === "red" && ep.severity === "amber";
      const newComponent = components.some((c) => !ep.components.includes(c));
      const worse = worst.healthScore <= ep.minHealthScore - 5;
      if (escalates || newComponent || worse) {
        ep.severity = escalates ? "red" : ep.severity;
        ep.minHealthScore = Math.min(ep.minHealthScore, worst.healthScore);
        ep.components = [...new Set([...ep.components, ...components])];
        alert = { action: "update", alertId: ep.alertId, severity: ep.severity, healthScore: ep.minHealthScore, reasons };
      }
      ep.windowsSinceTrigger = 0;
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

  const statusDue = prev.lastStatusWriteMs == null || opts.nowMs - prev.lastStatusWriteMs >= cfg.statusMinIntervalS * 1000
    || last.level !== prev.lastLevel || alert != null;
  if (statusDue) {
    st.lastStatusWriteMs = opts.nowMs;
    st.lastLevel = last.level;
  }
  st.lastBlockStartMs = input.blockStartMs;
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
