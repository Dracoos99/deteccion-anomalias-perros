/**
 * When a simulator run was abandoned. Its process (a `sim serve`, the CLI or the Cloud Run job) stopped writing
 * its heartbeat (worker.heartbeatAt, every few seconds, also while paused or computing baselines) without marking the run
 * as stopped: the job killed at its task timeout, a laptop closed. Such a run no longer holds its dogs: the simulator
 * stops it before starting another run with them, and the research panel says so.
 */

/** No heartbeat for this long and the run counts as abandoned (the simulator beats every 5 s, and after each baseline). */
export const RUN_ABANDONED_MS = 15 * 60_000;

/** How long a run of the Cloud Run job lasts at most when it has no duration: it stops itself before the 6 h task
 * timeout of the job (.github/workflows/deploy.yml) kills the process and leaves the run behind. */
export const JOB_MAX_RUN_S = 5.5 * 3600;

type Millis = { toMillis?: () => number } | null | undefined;

export function runAbandoned(run: { state: string; worker?: { heartbeatAt?: Millis } | null }, now: number): boolean {
  if (run.state === "stopped" || !run.worker) return false;
  const beat = run.worker.heartbeatAt?.toMillis?.();
  return beat != null && now - beat > RUN_ABANDONED_MS;
}
