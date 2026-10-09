import { describe, expect, it } from "vitest";
import { CLOUD_START_LIMIT_MS, START_LIMIT_MS, overGoal, runPhase, type RunLike } from "../src/lib/simRun";

const T0 = Date.UTC(2026, 9, 8, 23, 0);
const ms = (t: number) => ({ toMillis: () => t });
const run = (over: Partial<RunLike> = {}): RunLike => ({
  state: "running", worker: { id: "equipo-1", host: "equipo", heartbeatAt: ms(T0) }, endedBy: null, durationS: null, speed: 10, dogIds: ["toby"],
  stats: { blocksWritten: 0, avgLatencyMs: null, startedAt: null, stoppedAt: null }, cloudJob: null, createdAt: ms(T0), ...over,
});

describe("phase of a simulator run", () => {
  it("says «Iniciando» for a while and «No arrancó» past the limit without blocks", () => {
    expect(runPhase(run(), T0 + 10_000)).toBe("starting");
    expect(runPhase(run(), T0 + START_LIMIT_MS + 1)).toBe("stalled");
    // A newer sign of life of the process starts the count again.
    expect(runPhase(run({ worker: { id: "equipo-1", host: "equipo", heartbeatAt: ms(T0 + 40_000) } }), T0 + START_LIMIT_MS + 1)).toBe("starting");
    // Without the server time of its creation yet, never «No arrancó».
    expect(runPhase(run({ createdAt: null, worker: { id: "equipo-1", host: "equipo", heartbeatAt: null } }), T0 + 600_000)).toBe("starting");
  });
  it("waits longer for the Cloud Run job, which takes some 3 minutes to start", () => {
    const cloud = run({ cloudJob: { job: "simulator", requestedAt: ms(T0) } });
    expect(runPhase(cloud, T0 + 3 * 60_000)).toBe("starting");
    expect(runPhase(cloud, T0 + CLOUD_START_LIMIT_MS + 1)).toBe("stalled");
  });
  it("keeps the other phases", () => {
    const later = T0 + 600_000;
    expect(runPhase(run({ stats: { blocksWritten: 3, avgLatencyMs: 400, startedAt: null, stoppedAt: null } }), later)).toBe("running");
    expect(runPhase(run({ state: "paused" }), later)).toBe("paused");
    expect(runPhase(run({ worker: null }), later)).toBe("waiting");
    expect(runPhase(run({ state: "stopped", endedBy: "duration" }), later)).toBe("finished");
    expect(runPhase(run({ state: "stopped" }), later)).toBe("stopped");
  });
  it("marks a latency over the goal of 5 s", () => {
    expect(overGoal(5_660)).toBe(true);
    expect(overGoal(5_000)).toBe(false);
    expect(overGoal(null)).toBe(false);
  });
});
