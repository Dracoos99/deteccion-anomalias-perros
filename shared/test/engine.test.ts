import { describe, expect, it } from "vitest";
import {
  activityBaseline, activityBaselineFromFlags, buildReasons, evaluateBlock, hrBaseline, initialState, mergeReasons, outsideDecimals, reasonsChanged,
  titleCodeFor, windowIntensity, type BaselineStats, type EngineState, type WindowEval,
} from "../engine";
import { DEFAULT_FUSION_CONFIG, type AlertReason } from "../types";
import { alertTitle, bandWidths } from "../alert-text";
import { imuStats, normalizeWindows, readWindow, type BehaviorModelMeta } from "../behavior-model";
import { packSequences, ratioToScore, sequenceZ, type PhysioModelMeta, type PhysioScorer } from "../physio-model";

const cfg = DEFAULT_FUSION_CONFIG;
const baseline: BaselineStats = { activeRatioMean: 0.4, activeRatioStd: 0.08, hrMean: 70, hrStd: 5, tempMean: 38.6, tempStd: 0.15 };

/** 1 000 samples: still sensor (inactive) or a 3 Hz vertical oscillation of 0.4 g (active: std |acc| ≈ 0.28 g). */
function imuBlock(active: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1000; i++) out.push(0, 0, 1 + (active ? 0.4 * Math.sin((2 * Math.PI * 3 * i) / 100) : 0), 0, 0, 0);
  return out;
}

function run(blocks: { hr?: number[]; temp?: number | null; active?: boolean }[], base: BaselineStats | null = baseline, start: EngineState = initialState()) {
  let state = start;
  const out = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const e = evaluateBlock({ imu: imuBlock(b.active ?? false), hr: b.hr ?? Array(10).fill(70), temp: b.temp === undefined ? 38.6 : b.temp,
      blockStartMs: 1_000_000 + k * 10_000 }, state, base, cfg, { alertId: `r${k}` });
    state = e.state;
    out.push(e);
  }
  return out;
}

describe("windowIntensity", () => {
  it("is 0 for a still sensor and grows with movement", () => {
    expect(windowIntensity(imuBlock(false), 0)).toBeCloseTo(0, 12);
    expect(windowIntensity(imuBlock(true), 0)).toBeGreaterThan(cfg.activity.thresholdG);
  });
});

describe("evaluateBlock", () => {
  it("scores a normal dog as green with no alert", () => {
    const [e] = run([{}], baseline, { ...initialState(), activityEma: 0.4, hrBuffer: Array(60).fill(70) });
    expect(e.windows).toHaveLength(5);
    expect(e.result).toMatchObject({ rB: 0, rP: 0, rT: 0, healthScore: 100, level: "green" });
    expect(e.alert).toBeNull();
    expect(e.flags).toEqual(["behavior_rules", "physio_rules"]);
    expect(e.result.predictedBehavior).toBeNull();
  });

  it("without baseline applies only absolute rules", () => {
    const [e] = run([{ hr: Array(10).fill(200) }], null);
    expect(e.flags).toContain("no_baseline");
    expect(e.result.rP).toBe(0);
    expect(e.result.rB).toBe(0);
  });

  it("temperature outside the range fires the critical rule within the block (C4: windows of 2 s)", () => {
    const [e] = run([{ temp: 39.8 }]);
    expect(e.result.rT).toBeCloseTo(0.6 + 0.8 * 0.3, 3);
    expect(e.result.healthScore).toBe(Math.round(100 * (1 - 0.2 * e.result.rT)));
    expect(e.alert?.action).toBe("open");
    expect(e.alert?.severity).toBe("amber"); // HS stays ≥ 60 with one signal (C3); severity follows the level (C5)
    expect(e.alert?.reasons[0]).toMatchObject({ component: "temperature", code: "temp_high", normalRange: [37.7, 39.5] });
    expect(e.alert?.reasons[0].message).toContain("por encima del rango de referencia");
    expect(e.state.openAlerts).toBe(1);
  });

  it("keeps one alert per episode and closes it after episodeGapS without trigger", () => {
    const hot = Array(6).fill({ temp: 40.3 });
    const normal = Array(7).fill({ temp: 38.6 });
    const res = run([...hot, ...normal, { temp: 40.3 }]);
    expect(res.filter((e) => e.alert?.action === "open")).toHaveLength(2); // first block and after the 60 s gap
    expect(res[5].state.episode?.alertId).toBe("r0");
    expect(res[12].state.episode).toBeNull();
    expect(res[13].alert).toMatchObject({ action: "open", alertId: "r13" });
    expect(res[13].state.openAlerts).toBe(2);
  });

  it("detects tachycardia relative to the dog's baseline once the 60 s average moves", () => {
    const res = run([...Array(6).fill({ hr: Array(10).fill(70) }), ...Array(8).fill({ hr: Array(10).fill(98) })]);
    const first = res.findIndex((e) => e.alert);
    expect(first).toBeGreaterThan(5);
    expect(res[first].alert?.reasons.find((r) => r.component === "heart_rate")).toMatchObject({ code: "hr_high", normalRange: [60, 80] });
    expect(res[res.length - 1].result.rP).toBeGreaterThan(0.9);
  });

  it("a 70-bpm dog is not flagged although 70 is below the 100-150 reference", () => {
    const res = run(Array(10).fill({ hr: Array(10).fill(70) }));
    expect(res.every((e) => e.alert == null && e.result.rP === 0)).toBe(true);
  });

  it("a prolonged activity drop lowers the ratio and raises rB, but alone never alerts (C3)", () => {
    const res = run(Array(360).fill({ active: false }));
    const last = res[res.length - 1];
    expect(last.result.signals.activityRatio!).toBeLessThan(0.1);
    expect(last.result.rB).toBe(1);
    expect(last.result.healthScore).toBe(60);
    expect(res.some((e) => e.alert)).toBe(false);
  });

  it("combined deviations reach red and the alert escalates", () => {
    const res = run([...Array(6).fill({ hr: Array(10).fill(70) }), ...Array(12).fill({ hr: Array(10).fill(120), temp: 40.5 })],
      baseline, { ...initialState(), activityEma: 0.05 });
    expect(res[res.length - 1].result.level).toBe("red");
    expect(res.some((e) => e.alert?.severity === "red")).toBe(true);
    expect(res.filter((e) => e.alert?.action === "open")).toHaveLength(1);
  });

  it("ignores out-of-order blocks for the state and flags gaps", () => {
    const [a] = run([{}]);
    const late = evaluateBlock({ imu: imuBlock(false), hr: [70], temp: 38.6, blockStartMs: 900_000 }, a.state, baseline, cfg, { alertId: "x" });
    expect(late.flags).toContain("out_of_order");
    expect(late.state).toBe(a.state);
    const gap = evaluateBlock({ imu: imuBlock(false), hr: [70], temp: 38.6, blockStartMs: 1_000_000 + 60_000 }, a.state, baseline, cfg, { alertId: "y" });
    expect(gap.flags).toContain("gap:25");   // Missing 2 s windows (50 s after the end of the block)
  });

  it("throttles dogs.status to statusMinIntervalS of data time unless the level changes", () => {
    const s0 = { ...initialState(), activityEma: 0.4, hrBuffer: Array(60).fill(70) };
    const blk = { imu: imuBlock(false), hr: Array(10).fill(70), temp: 38.6 };
    // Default 2 s: every block refreshes the card, however fast the blocks arrive.
    const x = evaluateBlock({ ...blk, blockStartMs: 0 }, s0, baseline, cfg, { alertId: "x" });
    const y = evaluateBlock({ ...blk, blockStartMs: 10_000 }, x.state, baseline, cfg, { alertId: "y" });
    expect([x.statusDue, y.statusDue]).toEqual([true, true]);
    const c30 = { ...cfg, statusMinIntervalS: 30 };
    const a = evaluateBlock({ ...blk, blockStartMs: 0 }, s0, baseline, c30, { alertId: "a" });
    const b = evaluateBlock({ ...blk, blockStartMs: 10_000 }, a.state, baseline, c30, { alertId: "b" });
    const c = evaluateBlock({ ...blk, blockStartMs: 30_000 }, b.state, baseline, c30, { alertId: "c" });
    const d = evaluateBlock({ ...blk, temp: 41, blockStartMs: 40_000 }, c.state, baseline, c30, { alertId: "d" });
    expect([a.statusDue, b.statusDue, c.statusDue, d.statusDue]).toEqual([true, false, true, true]);
  });
});

describe("evaluateBlock with the behavioral model", () => {
  const meta: BehaviorModelMeta = {
    version: "cnn-lstm-test", classes: ["sit", "stand", "lie", "trot", "walk", "play", "sniff"], activeClasses: ["trot", "walk", "play", "sniff"],
    windowSamples: 200, imuHz: 100, channels: [], noveltyThreshold: 0.5, noveltyQuantile: 0.05, metrics: {}, architecture: "", trainingData: [], trainedAt: "",
  };
  const onehot = (i: number, p = 0.9) => Array.from({ length: 7 }, (_, j) => (j === i ? p : (1 - p) / 6));
  const withModel = { ...baseline, activitySource: "cnn-lstm-test" };
  const block = (probs: number[][], k: number, state: EngineState, base: BaselineStats | null = withModel) =>
    evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp: 38.6, blockStartMs: k * 10_000, behavior: { meta, probs } },
      state, base, cfg, { alertId: `m${k}` });

  it("takes the class of the last window and activity from the model", () => {
    const e = block([onehot(2), onehot(2), onehot(4), onehot(4), onehot(3)], 0, initialState());
    expect(e.result.predictedBehavior).toBe("trot");
    expect(e.result.behaviorProbs).toHaveLength(7);
    expect(e.windows.map((w) => w.active)).toEqual([false, false, true, true, true]); // the IMU is still: activity comes from the model
    expect(e.flags).toEqual(["physio_rules"]);
  });

  it("uses the movement rule for activity when the baseline was not computed with this model", () => {
    const e = block([onehot(4), onehot(4), onehot(4), onehot(4), onehot(4)], 0, initialState(), baseline);
    expect(e.flags).toContain("activity_rules");
    expect(e.windows.every((w) => w.active === false)).toBe(true);
    expect(e.result.predictedBehavior).toBe("walk");
  });

  it("raises rB when novel windows (low confidence) exceed the expected rate", () => {
    let st = { ...initialState(), activityEma: 0.4 };
    let last;
    for (let k = 0; k < 90; k++) { last = block(Array(5).fill(onehot(0, 0.3)), k, st); st = last.state; }
    expect(last!.result.signals.noveltyRatio!).toBeGreaterThan(0.5);
    expect(last!.result.rB).toBe(1);
    expect(last!.windows[4].novel).toBe(true);
  });

  it("shows the argmax of a causal average of the softmax when the model asks for smoothing", () => {
    const smooth = { ...meta, smoothingTimeConstantS: 6 };
    const b = (probs: number[][], k: number, st: EngineState) =>
      evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp: 38.6, blockStartMs: k * 10_000, behavior: { meta: smooth, probs } },
        st, withModel, cfg, { alertId: `s${k}` });
    // Lying for a whole block, then one window that looks like sitting: the class shown stays "lie".
    const first = b(Array(5).fill(onehot(2)), 0, initialState());
    const blip = b([onehot(0, 0.6), onehot(2), onehot(2), onehot(2), onehot(2)], 1, first.state);
    expect(blip.windows[0].predicted).toBe("lie");
    expect(blip.windows[0].maxProb).toBeCloseTo(0.6);             // the raw window is kept for novelty
    // A sustained change wins within a few windows.
    const change = b(Array(5).fill(onehot(0)), 2, blip.state);
    expect(change.result.predictedBehavior).toBe("sit");
    // Without smoothing each window shows its own class (v1).
    expect(block([onehot(0, 0.6), onehot(2), onehot(2), onehot(2), onehot(2)], 1, first.state).windows[0].predicted).toBe("sit");
  });

  it("keeps rB at 0 with confident, habitual behavior", () => {
    let st = { ...initialState(), activityEma: 0.4 };
    let last;
    for (let k = 0; k < 30; k++) { last = block([onehot(2), onehot(2), onehot(4), onehot(4), onehot(2)], k, st); st = last.state; }
    expect(last!.result.signals.noveltyRatio!).toBeLessThan(0.05);
    expect(last!.result.rB).toBe(0);
  });
});

describe("blocks of 2 s and alert rules", () => {
  /** 200 samples (one 2 s window). */
  const short = (k: number, st: EngineState, hr = [70, 70], c = cfg) =>
    evaluateBlock({ imu: imuBlock(false).slice(0, 1200), hr, temp: 38.6, blockStartMs: 1_000_000 + k * 2_000 }, st, baseline, c, { alertId: `w${k}` });

  it("evaluates one window per 2 s block and detects gaps from where the last block ended", () => {
    const a = short(0, initialState());
    expect(a.windows).toHaveLength(1);
    expect(a.state.lastBlockEndMs).toBe(1_002_000);
    const b = short(1, a.state);
    expect(b.flags.some((f) => f.startsWith("gap"))).toBe(false);
    const c = short(4, b.state);                                       // windows 2 and 3 missing
    expect(c.flags).toContain("gap:2");
  });

  it("counts 2 heart-rate values as a full 2 s block for the contiguous minute", () => {
    let st = initialState();
    for (let k = 0; k < 30; k++) st = short(k, st).state;
    expect(st.hrRun).toBe(60);
    expect(short(30, st, [70]).state.hrRun).toBe(0);                  // a short block restarts it
  });

  it("opens an alert only after its trigger held alertMinDurationS", () => {
    const c60 = { ...cfg, alertMinDurationS: 60 };
    let st = initialState();
    const opened: number[] = [];
    for (let k = 0; k < 40; k++) {
      const e = short(k, st, [70, 70], c60);
      st = e.state;
      if (k >= 5) { /* fever from block 5 on */ }
      if (e.alert?.action === "open") opened.push(k);
    }
    expect(opened).toEqual([]);                                        // no trigger, no alert
    let s2 = initialState();
    const hot = (k: number) => evaluateBlock({ imu: imuBlock(false).slice(0, 1200), hr: [70, 70], temp: 40.5, blockStartMs: 1_000_000 + k * 2_000 },
      s2, baseline, c60, { alertId: `h${k}` });
    let at = -1;
    for (let k = 0; k < 60; k++) { const e = hot(k); s2 = e.state; if (e.alert?.action === "open" && at < 0) { at = k; expect(e.alert.startedAtMs).toBe(1_002_000); } }
    // The temperature rule fires from the second window (consecutiveCritical 2); 30 windows later it has held 60 s.
    expect(at).toBe(30);
  });

  it("a brief trigger shorter than alertMinDurationS opens nothing", () => {
    const c60 = { ...cfg, alertMinDurationS: 60 };
    let st = initialState();
    let opened = false;
    for (let k = 0; k < 60; k++) {
      const e = evaluateBlock({ imu: imuBlock(false).slice(0, 1200), hr: [70, 70], temp: k >= 10 && k < 25 ? 40.5 : 38.6,
        blockStartMs: 1_000_000 + k * 2_000 }, st, baseline, c60, { alertId: `b${k}` });
      st = e.state;
      opened ||= e.alert?.action === "open";
    }
    expect(opened).toBe(false);
  });

  it("low activity alone alerts with activityCriticalSigma (it never did before, C3)", () => {
    const withRule = { ...cfg, activityCriticalSigma: 2 };
    let st = initialState();
    let alert = null;
    for (let k = 0; k < 360 && !alert; k++) {
      const e = evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp: 38.6, blockStartMs: 1_000_000 + k * 10_000 }, st, baseline, withRule, { alertId: `a${k}` });
      st = e.state;
      if (e.alert?.action === "open") alert = e.alert;
    }
    expect(alert?.reasons.map((r) => r.code)).toContain("activity_low");
    expect(alert?.severity).toBe("amber");
  });
});

describe("baselines", () => {
  it("activity baseline of an always-active recording is 1 with no spread", () => {
    const imu = Array.from({ length: 30 }, () => imuBlock(true)).flat();
    expect(activityBaseline(imu, cfg)).toMatchObject({ mean: 1, std: 0, windows: 150 });
  });
  it("activity baseline from model flags", () => {
    expect(activityBaselineFromFlags(Array(300).fill(1), cfg)).toMatchObject({ mean: 1, std: 0, windows: 300 });
  });
  it("heart-rate baseline uses 60 s averages", () => {
    const values = [...Array(120).fill(60), ...Array(120).fill(80)];
    const b = hrBaseline(values, cfg);
    expect(b.mean).toBeCloseTo(70, 0);
    expect(b.std).toBeGreaterThan(5);
    expect(b.n).toBe(91);
  });
});

describe("behavior-model helpers", () => {
  it("z-scores per dog and cuts consecutive windows", () => {
    const imu = Array.from({ length: 400 * 6 }, (_, i) => (i % 6) + 1);
    const [data, n] = normalizeWindows(imu, [1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 1, 2], 200);
    expect(n).toBe(2);
    expect(Array.from(data.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("reads class, activity and novelty from a softmax", () => {
    const meta = { classes: ["sit", "stand", "lie", "trot", "walk", "play", "sniff"], activeClasses: ["trot", "walk", "play", "sniff"], noveltyThreshold: 0.4 } as unknown as BehaviorModelMeta;
    expect(readWindow([0.05, 0.05, 0.05, 0.6, 0.1, 0.1, 0.05], meta)).toMatchObject({ predicted: "trot", active: true, novel: false });
    expect(readWindow([0.3, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1], meta)).toMatchObject({ predicted: "sit", active: false, novel: true });
  });
  it("computes per-channel IMU statistics", () => {
    const s = imuStats([0, 0, 1, 0, 0, 0, 2, 0, 1, 0, 0, 0]);
    expect(s.mean[0]).toBe(1);
    expect(s.std[0]).toBe(1);
    expect(s.std[2]).toBe(0);
  });
});

describe("episode timing", () => {
  it("records when the episode started (first triggering window) and when it ended", () => {
    const res = run([...Array(6).fill({ temp: 40.3 }), ...Array(7).fill({ temp: 38.6 })]);
    // The critical rule needs 2 consecutive windows: the first trigger is the second window of block 0.
    expect(res[0].alert).toMatchObject({ action: "open", alertId: "r0", startedAtMs: 1_002_000 });
    // Closed once 30 windows (episodeGapS = 60 s) pass without trigger: in block 11, dated at the end of the last
    // triggering window (block 5, window 5).
    expect(res.findIndex((e) => e.closed)).toBe(11);
    expect(res[11].closed).toEqual({ alertId: "r0", endedAtMs: 1_060_000 });
  });
});

describe("evaluateBlock with the physiological model", () => {
  const meta: PhysioModelMeta = {
    version: "lstm-ae-test", sequenceLength: 60, threshold: 1, criticalRatio: 2.4, fullScaleRatio: 3.8, metrics: {}, architecture: "", trainingData: [], trainedAt: "",
  };
  /** Fake autoencoder: a fixed error per call, and a record of the batches it received. */
  function scorer(error: number | ((z: Float32Array) => number)) {
    const batches: Float32Array[][] = [];
    const s: PhysioScorer = { meta, score: (batch) => { batches.push(batch); return batch.map((z) => (typeof error === "number" ? error : error(z))); } };
    return { s, batches };
  }
  const full = () => ({ ...initialState(), activityEma: 0.4, hrBuffer: Array(60).fill(70), hrRun: 60 });
  function runP(physio: PhysioScorer, n: number, hr = 70, start: EngineState = full(), c = cfg) {
    let state = start;
    const out = [];
    for (let k = 0; k < n; k++) {
      const e = evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(hr), temp: 38.6, blockStartMs: 1_000_000 + k * 10_000, physio },
        state, baseline, c, { alertId: `p${k}` });
      state = e.state;
      out.push(e);
    }
    return out;
  }

  it("scores the 5 windows of a block in one batch and reports error / threshold", () => {
    const { s, batches } = scorer(0.5);
    const [e] = runP(s, 1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0][0]).toHaveLength(60);
    expect(e.windows.map((w) => w.hrRatio)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(e.result.signals.hrRatio).toBe(0.5);
    expect(e.result.rP).toBe(0);
    expect(e.flags).not.toContain("physio_rules");
    expect(e.alert).toBeNull();
  });

  it("waits for 60 s of heart rate before using the model (physio_warmup)", () => {
    const { s, batches } = scorer(0.5);
    const res = runP(s, 7, 70, { ...initialState(), activityEma: 0.4 });
    expect(res[0].flags).toContain("physio_warmup");
    expect(res[0].result.signals.hrRatio).toBeNull();
    // The buffer reaches 60 values in the last window of block 5: only that window is scored, then every window.
    expect(res[5].flags).toContain("physio_warmup");
    expect(res[5].result.signals.hrRatio).toBe(0.5);
    expect(res[6].flags).not.toContain("physio_warmup");
    expect(batches.map((b) => b.length)).toEqual([1, 5]);
  });

  it("an unusual shape within the usual range raises r_p and, above criticalRatio, alerts as hr_pattern", () => {
    const { s } = scorer(3);
    const res = runP(s, 1);
    expect(res[0].result.rP).toBeCloseTo(ratioToScore(3, meta.fullScaleRatio), 3);
    expect(res[0].windows.every((w) => w.hrCritical)).toBe(true);
    expect(res[0].alert?.action).toBe("open");
    expect(res[0].alert?.reasons.find((r) => r.component === "heart_rate")).toMatchObject({ code: "hr_pattern", normalRange: [60, 80] });
    expect(res[0].alert?.reasons[0].message).toContain("no siguió su patrón normal");
  });

  it("keeps the level rule: a sustained shift is caught even when the model reconstructs it well", () => {
    const { s } = scorer(0.2);
    const res = runP(s, 8, 98);
    const hr = res[res.length - 1];
    expect(hr.result.signals.hrRatio).toBe(0.2);
    expect(hr.result.rP).toBeGreaterThan(0.9);   // rP = max(level rule, model)
    expect(res.some((e) => e.alert?.reasons.some((r) => r.code === "hr_high"))).toBe(true);
  });

  it("reads criticalRatio, fullScaleRatio and levelSigma from config/fusion when present", () => {
    const { s } = scorer(3);
    const c = { ...cfg, physio: { criticalRatio: 5, fullScaleRatio: 5 } };
    const [e] = runP(s, 1, 70, full(), c);
    expect(e.windows.every((w) => !w.hrCritical)).toBe(true);
    expect(e.result.rP).toBeCloseTo(0.5, 6);
    // With levelSigma 4 the level rule no longer fires at 88 bpm (+3.6 sigma for this baseline).
    const { s: calm } = scorer(0.1);
    const lvl = runP(calm, 8, 88, full(), { ...cfg, physio: { levelSigma: 4 } });
    expect(lvl.every((e2) => e2.windows.every((w) => !w.hrCritical))).toBe(true);
  });

  it("reads only contiguous heart rate: a short block or a gap between blocks restarts the minute", () => {
    const { s, batches } = scorer(0.5);
    const blk = (hr: number[], k: number, st: EngineState) => evaluateBlock({ imu: imuBlock(false), hr, temp: 38.6, blockStartMs: 1_000_000 + k * 10_000, physio: s },
      st, baseline, cfg, { alertId: `c${k}` });
    const a = blk(Array(10).fill(70), 0, full());
    expect(a.result.signals.hrRatio).toBe(0.5);
    const short = blk(Array(7).fill(70), 1, a.state);         // the sensor lost the signal inside the block
    expect(short.state.hrRun).toBe(0);
    expect(short.result.signals.hrRatio).toBeNull();
    expect(short.flags).toContain("physio_warmup");
    let st = short.state;
    let last = short;
    for (let k = 2; k < 8; k++) { last = blk(Array(10).fill(70), k, st); st = last.state; }
    expect(last.state.hrRun).toBe(60);                         // 6 full blocks later
    expect(last.result.signals.hrRatio).toBe(0.5);
    const afterGap = blk(Array(10).fill(70), 10, st);          // two blocks missing
    expect(afterGap.flags).toContain("gap:10");                // 20 s missing: ten 2 s windows
    expect(afterGap.state.hrRun).toBe(10);
    expect(afterGap.result.signals.hrRatio).toBeNull();
    expect(batches.every((b) => b.length > 0)).toBe(true);     // the model is not called for a block with nothing to score
    expect(afterGap.result.signals.hr).not.toBeNull();         // the level rule still averages the buffer
  });

  it("keeps enough heart rate for the model when the level rule averages less", () => {
    const { s, batches } = scorer(0.5);
    const c = { ...cfg, hrAverageS: 30 };
    const [e] = runP(s, 1, 90, full(), c);
    expect(e.state.hrBuffer).toHaveLength(60);
    expect(batches[0]).toHaveLength(5);
    expect(e.windows[4].hr).toBeCloseTo((20 * 70 + 10 * 90) / 30, 6);  // mean of the last 30 s only
  });
});

describe("physio-model helpers", () => {
  it("z-scores the last sequence with the dog's baseline and a 1 bpm floor", () => {
    expect(sequenceZ([1, 2, 3], 0, 1, 4)).toBeNull();
    expect(Array.from(sequenceZ([50, 60, 80, 90], 70, 10, 3)!)).toEqual([-1, 1, 2]);
    expect(Array.from(sequenceZ([72, 74], 70, 0.2, 2)!)).toEqual([2, 4]);
  });
  it("maps error / threshold to r_p and packs batches", () => {
    expect(ratioToScore(0.8, 3)).toBe(0);
    expect(ratioToScore(2, 3)).toBe(0.5);
    expect(ratioToScore(9, 3)).toBe(1);
    expect(Array.from(packSequences([Float32Array.of(1, 2), Float32Array.of(3, 4)], 2))).toEqual([1, 2, 3, 4]);
  });
});

describe("alert reasons name the dog's normal band, the one the app shows (baseline ± baselineSigma)", () => {
  // baseline: movement 40 % ± 8, heart rate 70 ± 5 lpm; baselineSigma 2: normal 24–56 % and 60–80 lpm.
  const w = (over: Partial<WindowEval>): WindowEval => ({
    intensity: null, active: null, activityRatio: 0.4, predicted: null, maxProb: null, novel: null, noveltyRatio: null, noveltyExpected: null,
    rActivity: 0, rNovelty: 0, hr: 70, hrRatio: null, temp: null, zActivity: 0, zHr: 0, rB: 0, rP: 0, rT: 0, healthScore: 50, level: "red",
    hrCritical: false, tempCritical: false, trigger: true, armed: true, runStartMs: null, ...over,
  });
  it("lists a signal only when it leaves the band, with the band as its range", () => {
    const rs = buildReasons(w({ activityRatio: 0.28, zActivity: -1.5, rActivity: 0.17, hr: 85, zHr: 3, rP: 0.5, hrCritical: true }), baseline, cfg);
    expect(rs.map((r) => r.code)).toEqual(["hr_high"]);
    expect(rs[0]).toMatchObject({ normalRange: [60, 80], value: 85 });
    expect(rs[0].message).toContain("(60–80 lpm)");
    expect(buildReasons(w({ activityRatio: 0.2, zActivity: -2.5, rActivity: 0.5 }), baseline, cfg)[0])
      .toMatchObject({ code: "activity_low", normalRange: [24, 56], value: 20 });
  });
  it("names the shape of the heart rate when its mean stays inside the band", () => {
    const rs = buildReasons(w({ hr: 77, zHr: 1.4, hrRatio: 1.8, rP: 0.4 }), baseline, cfg);
    expect(rs).toEqual([expect.objectContaining({ code: "hr_pattern", normalRange: [60, 80] })]);
  });
  it("still names a variable when a trigger comes from a deviation inside the band (unusual configuration)", () => {
    const rs = buildReasons(w({ activityRatio: 0.28, zActivity: -1.5, rActivity: 0.17 }), baseline, cfg);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ code: "activity_low", normalRange: [24, 56] });
    expect(rs[0].message).toBe("El tiempo en movimiento (28 %) está por debajo de su promedio habitual (40 %).");
  });
});

describe("reasons of an episode", () => {
  // Rocky in the emulator run of (8 Oct): movement 52.81 % ± 3.03 (band 46.75–58.87 %), heart rate 61.8 ± 6.5,
  // temperature 38.77 °C; config/fusion as deployed.
  const rocky: BaselineStats = { activeRatioMean: 0.5281, activeRatioStd: 0.0303, hrMean: 61.8, hrStd: 6.5, tempMean: 38.77, tempStd: 0.15 };
  const deployed = { ...cfg, alertMinDurationS: 300, activityCriticalSigma: 2 };
  type Plan = (k: number) => { temp: number; active: boolean };
  function replay(plan: Plan, n: number, c = deployed, base = rocky) {
    let st = initialState();
    const out: ReturnType<typeof evaluateBlock>[] = [];
    for (let k = 0; k < n; k++) {
      const p = plan(k);
      const e = evaluateBlock({ imu: imuBlock(p.active), hr: Array(10).fill(62), temp: p.temp, blockStartMs: 1_000_000 + k * 10_000 }, st, base, c, { alertId: `k${k}` });
      st = e.state;
      out.push(e);
    }
    return out;
  }
  /** The reasons the alert document ends with: those of its opening, rewritten by each update. */
  const written = (res: ReturnType<typeof replay>) => res.reduce<AlertReason[] | null>((acc, e) => (e.alert ? e.alert.reasons : acc), null);

  it("keeps naming a fever that ended while low activity kept the episode open", () => {
    // A fever of +1.5 °C for 10 minutes; the dog rests from minute 8 on, so its 20-minute movement average leaves its
    // band only after the fever ended, as Rocky's did at 20:38:54.
    const plan: Plan = (k) => ({ temp: k >= 6 && k < 66 ? 40.3 : 38.7, active: k < 55 ? k % 2 === 0 : k >= 90 });
    const res = replay(plan, 130);
    const open = res.find((e) => e.alert?.action === "open")!;
    expect(open.alert!.reasons.map((r) => r.code)).toEqual(["temp_high"]);
    const joined = res.findIndex((e) => !!e.alert?.reasons.some((r) => r.code === "activity_low"));
    expect(joined).toBeGreaterThan(0);
    expect(res[joined].windows.at(-1)!.temp).toBeLessThan(39.5);       // the activity joined after the fever ended
    expect(res[joined].alert!.action).toBe("update");
    const final = written(res)!;
    expect(final.map((r) => r.code)).toEqual(["temp_high", "activity_low"]);
    expect(final[0]).toMatchObject({ value: 40.3, normalRange: [37.7, 39.5] });
    // Every write of the alert keeps the reason that named it when it opened, also once the 20-minute
    // movement average is further out of its band (in band widths) than the fever was.
    expect(res.filter((e) => e.alert).every((e) => e.alert!.titleCode === "temp_high")).toBe(true);
    expect(alertTitle(final, "temp_high")).toBe("Su temperatura estuvo alta");
    // The value is printed out of its range: never «47 %» against «47–59 %».
    const act = final[1];
    expect(act.value).toBeLessThan(act.normalRange[0]);
    expect(act.message).toContain(`(${act.value.toLocaleString("es-PE")} %)`);
  });

  it("names what left its range before the alert opened, with its most extreme value", () => {
    // The temperature leaves its range for 3 minutes; low activity keeps the trigger alive until the alert opens.
    const plan: Plan = (k) => ({ temp: k >= 2 && k < 20 ? (k < 10 ? 40.1 : 40.6) : 38.7, active: false });
    const res = replay(plan, 60);
    const open = res.find((e) => e.alert?.action === "open")!;
    expect(open.windows.at(-1)!.temp).toBeLessThan(39.5);
    expect(open.alert!.reasons.find((r) => r.code === "temp_high")?.value).toBe(40.6);
    expect(alertTitle(open.alert!.reasons)).toBe("Su temperatura estuvo alta");
  });

  it("lists only the variables out of their range: a non-critical autoencoder stays out of a fever alert", () => {
    const meta: PhysioModelMeta = { version: "t", sequenceLength: 60, threshold: 1, criticalRatio: 2.4, fullScaleRatio: 3.8, metrics: {}, architecture: "", trainingData: [], trainedAt: "" };
    const physio: PhysioScorer = { meta, score: (b) => b.map(() => 1.5) };   // above its threshold, below criticalRatio
    const st = { ...initialState(), activityEma: 0.4, hrBuffer: Array(60).fill(70), hrRun: 60 };
    const e = evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp: 40.3, blockStartMs: 1_000_000, physio }, st, baseline, cfg, { alertId: "f" });
    expect(e.windows[0].hrRatio).toBe(1.5);
    expect(e.alert?.reasons.map((r) => r.code)).toEqual(["temp_high"]);
  });

  it("merges reasons: the most extreme value, real reasons over fallback ones, a level reason over a weaker one", () => {
    const r = (code: string, component: AlertReason["component"], value: number, range: [number, number]): AlertReason =>
      ({ code, component, value, normalRange: range, message: code });
    const a = mergeReasons(null, { reasons: [r("temp_high", "temperature", 40.0, [37.7, 39.5])], fallback: false });
    const b = mergeReasons(a, { reasons: [r("temp_high", "temperature", 40.4, [37.7, 39.5]), r("hr_pattern", "heart_rate", 70, [60, 80])], fallback: false });
    expect(b.reasons.map((x) => [x.code, x.value])).toEqual([["temp_high", 40.4], ["hr_pattern", 70]]);
    expect(reasonsChanged(a, b)).toBe(true);
    const c = mergeReasons(b, { reasons: [r("hr_high", "heart_rate", 90, [60, 80])], fallback: false });
    expect(c.reasons.map((x) => x.code)).toEqual(["temp_high", "hr_high"]);
    const fb = { reasons: [r("activity_low", "behavior", 30, [24, 56])], fallback: true };
    expect(mergeReasons(c, fb)).toBe(c);
    expect(mergeReasons(fb, a).reasons.map((x) => x.code)).toEqual(["temp_high"]);
    // A value a little further out does not rewrite the alert; one a step further does.
    const near = mergeReasons(a, { reasons: [r("temp_high", "temperature", 40.1, [37.7, 39.5])], fallback: false });
    expect(reasonsChanged(a, near)).toBe(false);
  });

  it("orders the reasons by how far out of their band they are, after the one that names the alert", () => {
    const r = (code: string, component: AlertReason["component"], value: number, range: [number, number]): AlertReason =>
      ({ code, component, value, normalRange: range, message: code });
    // A heart rate 0.2 lpm over its band no longer goes before a movement far under its band (it was temperature,
    // heart rate, movement).
    const merged = mergeReasons(null, { reasons: [r("hr_high", "heart_rate", 76.7, [54.5, 76.5]), r("activity_low", "behavior", 20, [52, 64])], fallback: false });
    expect(merged.reasons.map((x) => x.code)).toEqual(["activity_low", "hr_high"]);
    // The fever case: the movement average ends further out of its band than the fever was, and the alert still
    // stores the fever first, because it named the alert when it opened.
    const plan: Plan = (k) => ({ temp: k >= 6 && k < 66 ? 40.3 : 38.7, active: k < 55 ? k % 2 === 0 : k >= 90 });
    const final = written(replay(plan, 130))!;
    expect(final.map((x) => x.code)).toEqual(["temp_high", "activity_low"]);
    expect(bandWidths(final[1])).toBeGreaterThan(bandWidths(final[0]));
  });

  it("keeps the reason that names an alert while it lasts, unless it rises to «Revisar»", () => {
    const r = (code: string, component: AlertReason["component"], value: number, range: [number, number]): AlertReason =>
      ({ code, component, value, normalRange: range, message: code });
    // Toby in: 20 % of movement against 52–64 % (2.7 band widths out) and 48 lpm against 49–87 lpm (0.03).
    const act = r("activity_low", "behavior", 20, [52, 64]), hrLow = r("hr_low", "heart_rate", 48, [49, 87]);
    expect(titleCodeFor(null, [hrLow, act], false)).toBe("activity_low");
    // An alert opened by the heart rate keeps its name when the movement, further out of its band, joins later...
    expect(titleCodeFor("hr_low", [hrLow, act], false)).toBe("hr_low");
    // ...until it rises to «Revisar»: then the largest deviation names it.
    expect(titleCodeFor("hr_low", [hrLow, act], true)).toBe("activity_low");
    // A reason that left the list (the shape of the heart rate replaced by its level) is replaced.
    expect(titleCodeFor("hr_pattern", [r("hr_high", "heart_rate", 95, [60, 80])], false)).toBe("hr_high");
    expect(titleCodeFor(null, [], false)).toBeNull();
  });

  it("prints a value out of its range with the decimals that keep it off the bounds", () => {
    expect(outsideDecimals(46.7, 46.75, 58.87, 0)).toBe(1);
    expect(outsideDecimals(40, 46.75, 58.87, 0)).toBe(0);
    expect(outsideDecimals(39.54, 37.7, 39.5, 1)).toBe(2);
    const rs = buildReasons({
      intensity: null, active: null, activityRatio: 0.467, predicted: null, maxProb: null, novel: null, noveltyRatio: null, noveltyExpected: null,
      rActivity: 0.34, rNovelty: 0, hr: 62, hrRatio: null, temp: null, zActivity: -2.02, zHr: 0, rB: 0.34, rP: 0, rT: 0, healthScore: 86, level: "green",
      hrCritical: false, tempCritical: false, trigger: true, armed: true, runStartMs: null,
    }, rocky, deployed);
    expect(rs[0]).toMatchObject({ code: "activity_low", value: 46.7, normalRange: [46.8, 58.9] });
    expect(rs[0].message).toBe("El tiempo en movimiento (46.7 %) está por debajo de su rango habitual (46.8–58.9 %).");
  });
});

describe("stable Health Score of dogs.status", () => {
  // With «Todo normal» from 90, a fever alone (Health Score 80) is «Atención» at once.
  const strict = { ...cfg, levels: { green: 90, amber: 60 } };
  function feed(temps: number[], c = strict, start: EngineState = initialState()) {
    let st = start;
    return temps.map((temp, k) => {
      const e = evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp, blockStartMs: 1_000_000 + k * 10_000 }, st, baseline, c, { alertId: `s${k}` });
      st = e.state;
      return e;
    });
  }

  it("stays at its level through a minute of change and moves when the change lasts minutes", () => {
    const brief = feed([...Array(6).fill(38.6), ...Array(6).fill(40.3), ...Array(6).fill(38.6)]);
    expect(brief.slice(6, 12).every((e) => e.result.level === "amber")).toBe(true);
    expect(brief.every((e) => e.result.stableLevel === "green")).toBe(true);
    const long = feed([...Array(6).fill(38.6), ...Array(40).fill(40.3)]);
    const turned = long.findIndex((e) => e.result.stableLevel === "amber");
    // 100 → 80 with a 300 s time constant crosses 90 after 300 · ln 2 ≈ 208 s.
    expect(turned).toBeGreaterThanOrEqual(6 + 20);
    expect(turned).toBeLessThanOrEqual(6 + 22);
    expect(long[turned].statusDue).toBe(true);
    expect(long[turned].state.lastStableLevel).toBe("amber");
    // The alert does not wait for the stable level: the temperature rule opens it in the first hot block.
    expect(long[6].alert?.action).toBe("open");
  });

  it("follows the instantaneous score with a time constant of 0, and weighs a gap by the time that passed", () => {
    const now = feed([38.6, 40.3], { ...strict, stableTimeConstantS: 0 });
    expect(now[1].result.stableHealthScore).toBe(now[1].result.healthScore);
    const before = feed(Array(3).fill(40.3))[2].state;
    const back = evaluateBlock({ imu: imuBlock(false), hr: Array(10).fill(70), temp: 38.6, blockStartMs: 1_000_000 + 3 * 10_000 + 3_600_000 },
      before, baseline, strict, { alertId: "g" });
    expect(back.result.stableHealthScore).toBe(100);               // an hour later the old score weighs nothing
  });
});
