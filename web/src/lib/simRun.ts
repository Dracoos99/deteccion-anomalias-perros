/* State of a simulator run as the research panel shows it: pure functions, no Firestore, so the rules are
   tested apart from the page (web/test/simRun.test.ts). */
import type { SimulatorRunDoc } from "@shared/types";
import { runAbandoned } from "@shared/runs";

type Millis = { toMillis?: () => number } | null | undefined;
export type RunLike = Pick<SimulatorRunDoc<Millis>, "state" | "worker" | "endedBy" | "durationS" | "speed" | "dogIds" | "stats" | "cloudJob" | "createdAt">;
export type Phase = "waiting" | "starting" | "stalled" | "running" | "paused" | "finished" | "stopped" | "interrupted";

/** How long a run taken by a local simulator process may go without its first block before
 * the panel says it did not start. The process takes a run in under a second and writes its first block a few seconds
 * later; the first run after a change of behavioral model recomputes the dogs' baselines first and can take longer,
 * which the message says. Measured with two dogs of a clean start, the first block came after 51 to 77 s
 * (models and baselines loading), so 45 s said «No arrancó» to a process that was starting; saw 135 s on a busy
 * machine, so the limit is 3 minutes. */
export const START_LIMIT_MS = 180_000;
/** The same for a run of the Cloud Run job, which takes about 3 minutes to start. */
export const CLOUD_START_LIMIT_MS = 5 * 60_000;
/** The latency goal of the system (RNF-01). */
export const LATENCY_GOAL_MS = 5_000;

/** A run that reached its duration (the simulator writes endedBy). Runs from before it: from
 * ×5 on the blocks are of 10 s, so the time simulated per dog is its blocks × 10 s. */
export function finishedByDuration(r: RunLike): boolean {
  if (r.endedBy) return r.endedBy === "duration";
  const perDog = r.dogIds.length ? Math.floor((r.stats?.blocksWritten ?? 0) / r.dogIds.length) : 0;
  return !!r.durationS && r.speed >= 5 && perDog * 10 >= r.durationS;
}

/** «Reproduciendo» only while a simulator process executes the run;: «Iniciando» until
 * its first block, and «Terminada» (its duration) apart from «Detenida» (by hand). «Iniciando» has a
 * limit, counted from the latest of its creation and the process's last sign of life (`worker.heartbeatAt`); past it,
 * «No arrancó». */
export function runPhase(r: RunLike, now: number): Phase {
  // «Se interrumpió» when its process stopped beating (shared/runs.ts), also after another process closed it.
  if (r.state === "stopped") return r.endedBy === "abandoned" ? "interrupted" : finishedByDuration(r) ? "finished" : "stopped";
  if (!r.worker) return "waiting";
  if (runAbandoned(r, now)) return "interrupted";
  if (r.state === "running" && !((r.stats?.blocksWritten ?? 0) > 0)) {
    const since = Math.max(r.createdAt?.toMillis?.() ?? 0, r.worker.heartbeatAt?.toMillis?.() ?? 0);
    const limit = r.cloudJob ? CLOUD_START_LIMIT_MS : START_LIMIT_MS;
    return since > 0 && now - since > limit ? "stalled" : "starting";
  }
  return r.state;
}

/** The runs that hold their dogs, which a new run cannot take: active and with a process alive. */
export const holdsDogs = (r: RunLike, now: number) => r.state !== "stopped" && !runAbandoned(r, now);

/** A latency over the goal says so in words, not only in colour. */
export const overGoal = (ms: number | null | undefined) => ms != null && ms > LATENCY_GOAL_MS;

/** How long one of the two stages of a dog's learning period takes (shared/baseline.ts): minBlocks blocks of
 * 10 s of data, which a run at ×speed sends in about that time divided by the speed (a little more: each block waits
 * for the result of the one before). */
export function learningStageMs(minBlocks: number, speed = 1): { dataMs: number; clockMs: number } {
  const dataMs = minBlocks * 10_000;
  return { dataMs, clockMs: dataMs / Math.max(1, speed) };
}
