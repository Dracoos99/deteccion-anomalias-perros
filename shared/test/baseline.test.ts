import { describe, expect, it } from "vitest";
import {
  addToBaseline, baselineFromParts, baselineShare, finishInitial, learnBaseline, meanStd, newBaselineAcc, type BaselineValues,
} from "../baseline";
import { activityBaselineFromFlags, hrBaseline, windowIntensity, type EngineConfig } from "../engine";
import { imuStats } from "../behavior-model";
import { pushText } from "../alert-text";
import { DEFAULT_FUSION_CONFIG } from "../types";

const cfg = DEFAULT_FUSION_CONFIG as EngineConfig;

/** A 10 s block: still or moving (3 Hz vertical oscillation), with a heart rate and a temperature. */
function block(k: number, moving: boolean, hr = 70 + (k % 3), temp: number | null = 38.5 + 0.01 * k) {
  const imu: number[] = [];
  for (let i = 0; i < 1000; i++) imu.push(0.01 * k, -0.02, 1 + (moving ? 0.4 * Math.sin((2 * Math.PI * 3 * i) / 100) : 0), 0.5, -0.5, 0.1 * k);
  const ruleFlags = Array.from({ length: 5 }, (_, w) => windowIntensity(imu, w * 200) > cfg.activity.thresholdG);
  return { imu, hr: Array(10).fill(hr), temp, ruleFlags };
}

describe("baseline learned from the first blocks", () => {
  const blocks = Array.from({ length: 12 }, (_, k) => block(k, k % 4 === 0));

  it("gives the same baseline as computing it at once from all the data (simulator)", () => {
    let acc = newBaselineAcc("initial");
    for (const b of blocks) acc = addToBaseline(acc, { imu: b.imu, hr: b.hr, temp: b.temp, activeFlags: b.ruleFlags });
    const learned = finishInitial(acc, cfg);
    const allImu = blocks.flatMap((b) => b.imu), allHr = blocks.flatMap((b) => b.hr);
    const act = activityBaselineFromFlags(blocks.flatMap((b) => b.ruleFlags.map((f) => (f ? 1 : 0))), cfg);
    const hr = hrBaseline(allHr, cfg);
    const stats = imuStats(allImu);
    expect(learned.activeRatioMean).toBeCloseTo(act.mean, 4);
    expect(learned.activeRatioStd).toBeCloseTo(act.std, 4);
    expect(learned.hrMean).toBeCloseTo(hr.mean, 1);
    expect(learned.hrStd).toBeCloseTo(hr.std, 1);
    expect(learned.tempMean).toBe(Math.round(meanStd(blocks.map((b) => b.temp!))!.mean * 100) / 100);
    learned.imuMean!.forEach((m, c) => expect(m).toBeCloseTo(stats.mean[c], 5));
    learned.imuStd!.forEach((s, c) => expect(s).toBeCloseTo(stats.std[c], 5));
    expect(learned).toMatchObject({ origin: "function", activitySource: "rules", samples: 60 });
    expect(baselineFromParts({ activeFlags: [], hr: [], temp: null, activitySource: "rules" }, cfg)).toMatchObject({ hrMean: null, tempMean: null });
  });

  it("stage 1 until minBlocks, then stage 2 with the model's activity, then nothing", () => {
    let acc = null, current: BaselineValues | null = null;
    const steps: string[] = [];
    for (let k = 0; k < 14; k++) {
      const b = block(k, k % 2 === 0);
      const model = { version: "cnn-test", flags: [true, true, true, false, false] };
      const r = learnBaseline(current, acc, { imu: b.imu, hr: b.hr, temp: b.temp, ruleFlags: b.ruleFlags, model }, cfg, 7);
      acc = r.acc;
      if (r.learned) { current = r.learned; steps.push(`${k}:${r.learned.activitySource}`); }
    }
    expect(steps).toEqual(["6:rules", "13:cnn-test"]);   // 7 blocks = 70 s: enough for the 60 s heart-rate average
    expect(current!.activeRatioMean).toBeCloseTo(0.6, 2);           // 3 of every 5 windows active for the model
    expect(current!.hrMean).not.toBeNull();                          // stage 2 keeps heart rate, temperature and IMU statistics
    expect(current!.imuMean).toHaveLength(6);
    expect(acc).toBeNull();
  });

  it("restarts stage 2 when the model version changes, and never touches a baseline from the simulator", () => {
    const b = block(0, true);
    const learned = { ...finishInitial(addToBaseline(newBaselineAcc("initial"), { imu: b.imu, hr: b.hr, temp: b.temp, activeFlags: b.ruleFlags }), cfg) };
    const step = (acc: ReturnType<typeof newBaselineAcc> | null, version: string) =>
      learnBaseline(learned, acc, { imu: b.imu, hr: b.hr, temp: b.temp, ruleFlags: b.ruleFlags, model: { version, flags: Array(5).fill(true) } }, cfg, 10).acc;
    let acc = step(null, "v1");
    acc = step(acc, "v1");
    expect(acc!.blocks).toBe(2);
    expect(step(acc, "v2")!.blocks).toBe(1);
    const fromSimulator = { ...learned, origin: undefined };
    expect(learnBaseline(fromSimulator, null, { imu: b.imu, hr: b.hr, temp: b.temp, ruleFlags: b.ruleFlags, model: { version: "v1", flags: [true] } }, cfg, 10))
      .toEqual({ acc: null, learned: null });
    expect(baselineShare(acc!, 4)).toBe(0.5);
  });

  it("a dog without heart rate or temperature in its data gets a baseline without them", () => {
    let acc = newBaselineAcc("initial");
    for (let k = 0; k < 3; k++) { const b = block(k, false, 0, null); acc = addToBaseline(acc, { imu: b.imu, hr: [], temp: null, activeFlags: b.ruleFlags }); }
    expect(finishInitial(acc, cfg)).toMatchObject({ hrMean: null, hrStd: null, tempMean: null, tempStd: null, activeRatioMean: 0 });
  });
});

describe("push text", () => {
  it("names the dog and the variable in plain language, without alarm", () => {
    const reasons = [{ component: "temperature" as const, code: "temp_high", value: 40.1, normalRange: [37.7, 39.5] as [number, number], message: "" }];
    expect(pushText("Toby", reasons, "new")).toEqual({
      title: "Toby: su temperatura estuvo alta",
      body: "Se alejó de su patrón normal. Abre la app para ver qué pasó y qué puedes hacer.",
    });
    expect(pushText("Luna", [], "escalated").body).toContain("«Revisar»");
  });
});
