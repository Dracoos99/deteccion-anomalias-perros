/**
 * The model's behavior against the one annotated from video, block by block, for the research panel. Pure.
 * A block counts only when its annotation has one clean class; the agreement is given for the seven classes and for the
 * five groups of «Su día».
 */
import type { Behavior } from "@shared/types";
import { GROUP_OF } from "./day";

export interface Pair { id: string; t: number; annotated: Behavior | null; predicted: Behavior | null }
export interface Agreement { compared: number; exact: number; grouped: number; confusions: { annotated: Behavior; predicted: Behavior; n: number }[] }

/** Joins the annotated blocks and the results by reading id (both use it), newest first, keeping blocks with both. */
export function pairBlocks(truth: readonly { id: string; t: number; behavior: Behavior | null }[], results: readonly { id: string; predictedBehavior: Behavior | null }[]): Pair[] {
  const byId = new Map(results.map((r) => [r.id, r.predictedBehavior]));
  return truth.filter((x) => byId.has(x.id)).map((x) => ({ id: x.id, t: x.t, annotated: x.behavior, predicted: byId.get(x.id) ?? null }))
    .sort((a, b) => b.t - a.t);
}

export function agreement(pairs: readonly Pair[]): Agreement {
  let compared = 0, exact = 0, grouped = 0;
  const conf = new Map<string, number>();
  for (const p of pairs) {
    if (!p.annotated || !p.predicted) continue;
    compared++;
    if (p.annotated === p.predicted) exact++;
    else conf.set(`${p.annotated}>${p.predicted}`, (conf.get(`${p.annotated}>${p.predicted}`) ?? 0) + 1);
    if (GROUP_OF[p.annotated] === GROUP_OF[p.predicted]) grouped++;
  }
  const confusions = [...conf].map(([k, n]) => { const [a, b] = k.split(">") as [Behavior, Behavior]; return { annotated: a, predicted: b, n }; })
    .sort((a, b) => b.n - a.n).slice(0, 3);
  return { compared, exact, grouped, confusions };
}
