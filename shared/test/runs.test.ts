import { describe, expect, it } from "vitest";
import { JOB_MAX_RUN_S, RUN_ABANDONED_MS, runAbandoned } from "../runs";

const T0 = Date.UTC(2026, 10, 14, 12, 0);
const beat = (t: number | null) => ({ heartbeatAt: t == null ? null : { toMillis: () => t } });

describe("abandoned simulator runs", () => {
  it("counts a run as abandoned only when its process stopped beating long ago", () => {
    expect(runAbandoned({ state: "running", worker: beat(T0) }, T0 + RUN_ABANDONED_MS)).toBe(false);
    expect(runAbandoned({ state: "running", worker: beat(T0) }, T0 + RUN_ABANDONED_MS + 1)).toBe(true);
    expect(runAbandoned({ state: "paused", worker: beat(T0) }, T0 + RUN_ABANDONED_MS + 1)).toBe(true);
  });
  it("never for a stopped run, one waiting for a process or one without a heartbeat yet", () => {
    const late = T0 + 24 * 3600_000;
    expect(runAbandoned({ state: "stopped", worker: beat(T0) }, late)).toBe(false);
    expect(runAbandoned({ state: "running", worker: null }, late)).toBe(false);
    expect(runAbandoned({ state: "running", worker: beat(null) }, late)).toBe(false);
  });
  it("stops a job's run before the 6 h task timeout of Cloud Run", () => {
    expect(JOB_MAX_RUN_S).toBeLessThan(6 * 3600);
  });
});
