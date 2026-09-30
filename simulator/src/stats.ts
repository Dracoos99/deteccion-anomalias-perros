/** Latency statistics from results.latencyMs (RNF-01), measured on the last `window` blocks. */
export class LatencyStats {
  private readonly values: number[] = [];
  private all = 0;
  private max = 0;

  constructor(private readonly window = 500) {}

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.values.push(ms);
    if (this.values.length > this.window) this.values.shift();
    this.all += 1;
    this.max = Math.max(this.max, ms);
  }

  get count(): number {
    return this.all;
  }

  summary(): { avgMs: number | null; p50Ms: number | null; p95Ms: number | null; maxMs: number | null } {
    return summarize(this.values, this.max);
  }
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function summarize(values: number[], max = Math.max(...values)) {
  if (!values.length) return { avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const s = [...values].sort((a, b) => a - b);
  return {
    avgMs: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    p50Ms: percentile(s, 50),
    p95Ms: percentile(s, 95),
    maxMs: max,
  };
}
