import { describe, expect, it } from "vitest";
import { LEARNED_NOTICE_MS, learnedNotice, learningInfo } from "../src/lib/plain";
import { learningStageMs } from "../src/lib/simRun";

const ms = (t: number) => ({ toMillis: () => t });

describe("learning period of a new dog", () => {
  it("says the stage, the share and the data time left", () => {
    // 360 blocks of 10 s per stage: 1 h of data.
    expect(learningInfo({ stage: "initial", share: 0.25 }, 360)).toEqual({ stage: 1, pct: 25, leftMs: 2_700_000, stageMs: 3_600_000 });
    expect(learningInfo({ stage: "model", share: 0.999 }, 360)).toMatchObject({ stage: 2, pct: 100, leftMs: 3_600 });
    // A first block shows 1 %, not 0 %; nothing learned yet is 0 %.
    expect(learningInfo({ stage: "initial", share: 0.001 }, 360)!.pct).toBe(1);
    expect(learningInfo({ stage: "initial", share: 0 }, 360)!.pct).toBe(0);
    expect(learningInfo(null, 360)).toBeNull();
  });

  it("announces a baseline the Function learned for a day, and never one the simulator computed", () => {
    const now = 10_000_000_000;
    expect(learnedNotice({ origin: "function", activitySource: "rules", computedAt: ms(now - 60_000) }, now)).toBe("basic");
    expect(learnedNotice({ origin: "function", activitySource: "cnn-lstm-v2", computedAt: ms(now - 60_000) }, now)).toBe("final");
    expect(learnedNotice({ origin: "function", activitySource: "cnn-lstm-v2", computedAt: ms(now - LEARNED_NOTICE_MS - 1) }, now)).toBeNull();
    expect(learnedNotice({ activitySource: "cnn-lstm-v2", computedAt: ms(now - 60_000) }, now)).toBeNull();
    expect(learnedNotice({ origin: "function", activitySource: "rules", computedAt: null }, now)).toBeNull();
    expect(learnedNotice(null, now)).toBeNull();
  });

  it("tells the admin how long a stage takes at each speed", () => {
    expect(learningStageMs(360, 10)).toEqual({ dataMs: 3_600_000, clockMs: 360_000 });
    expect(learningStageMs(30, 1)).toEqual({ dataMs: 300_000, clockMs: 300_000 });
  });
});
