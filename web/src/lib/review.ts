/**
 * Blind expert review: the stretches the reviewer judges and Cohen's kappa between the system and the
 * reviewer. Pure functions.
 *
 * To measure agreement both ways, the queue mixes the alert episodes (the system said «yes») with control stretches of
 * the same dogs where the system opened no alert («no»), in a shuffled order and without the system's verdict.
 */
import { mulberry32 } from "@shared/synthetic";

export type Verdict = "relevant" | "not_relevant" | "unsure";

/** Cohen's kappa of two raters on yes/no; «unsure» answers are left out (and counted apart). */
export interface Kappa { n: number; agree: number; po: number; pe: number; kappa: number | null; table: { yy: number; yn: number; ny: number; nn: number }; unsure: number }
export function cohenKappa(items: readonly { system: boolean; verdict: Verdict | null | undefined }[]): Kappa {
  const t = { yy: 0, yn: 0, ny: 0, nn: 0 };
  let unsure = 0;
  for (const it of items) {
    if (!it.verdict) continue;
    if (it.verdict === "unsure") { unsure++; continue; }
    const e = it.verdict === "relevant";
    if (it.system && e) t.yy++; else if (it.system && !e) t.yn++; else if (!it.system && e) t.ny++; else t.nn++;
  }
  const n = t.yy + t.yn + t.ny + t.nn;
  if (!n) return { n, agree: 0, po: 0, pe: 0, kappa: null, table: t, unsure };
  const po = (t.yy + t.nn) / n;
  const sysYes = (t.yy + t.yn) / n, expYes = (t.yy + t.ny) / n;
  const pe = sysYes * expYes + (1 - sysYes) * (1 - expYes);
  // With stretches of only one kind (only alerts, or only controls) the agreement says nothing about
  // the system: kappa is not computed.
  const oneKind = t.yy + t.yn === 0 || t.ny + t.nn === 0;
  return { n, agree: t.yy + t.nn, po, pe, kappa: oneKind || pe >= 1 ? null : (po - pe) / (1 - pe), table: t, unsure };
}

/** How a kappa reads (Landis and Koch's usual bands), in plain words. */
export function kappaText(k: number | null): string {
  if (k == null) return "Sin datos suficientes";
  if (k < 0) return "Peor que el azar";
  if (k < 0.2) return "Acuerdo leve";
  if (k < 0.4) return "Acuerdo aceptable";
  if (k < 0.6) return "Acuerdo moderado";
  if (k < 0.8) return "Acuerdo sustancial";
  return "Acuerdo casi perfecto";
}

/** The stretch shown for an alert episode: from `marginMs` before it starts to `marginMs` after it ends (or after its start
 * plus `marginMs` while it goes on). */
export function alertWindow(startMs: number, endMs: number | null, marginMs = 15 * 60_000): { fromMs: number; toMs: number } {
  return { fromMs: startMs - marginMs, toMs: (endMs ?? startMs + marginMs) + marginMs };
}

/**
 * Control stretches: windows fully inside a dog's data (at least 80 % of their 5-minute slots with data), at least
 * `clearMs` away from any of its alert episodes and not overlapping each other, taken from the dogs in turn.
 * Their lengths are those of the alert stretches (`lengthsMs`, used in turn), so the length of a stretch
 * does not tell the reviewer whether the system flagged it. Deterministic for a seed, so the queue can be rebuilt.
 */
export function controlWindows(dogs: readonly { dogId: string; slots: readonly number[]; episodes: readonly { fromMs: number; toMs: number }[] }[],
  count: number, opts: { lengthsMs?: readonly number[]; lengthMs?: number; clearMs?: number; slotMs?: number; seed?: number } = {}): { dogId: string; fromMs: number; toMs: number }[] {
  const clearMs = opts.clearMs ?? 30 * 60_000, slotMs = opts.slotMs ?? 300_000;
  const lengths = opts.lengthsMs?.length ? opts.lengthsMs : [opts.lengthMs ?? 40 * 60_000];
  const rnd = mulberry32(opts.seed ?? 7);
  const per = dogs.map((d) => {
    const have = new Set(d.slots);
    const starts = [...have].sort((a, b) => a - b);
    for (let i = starts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [starts[i], starts[j]] = [starts[j], starts[i]]; }
    return { dogId: d.dogId, have, starts, episodes: d.episodes, chosen: [] as { fromMs: number; toMs: number }[] };
  });
  const fits = (p: (typeof per)[number], t: number, len: number) => {
    const need = Math.max(1, Math.round(len / slotMs));
    let n = 0;
    for (let k = 0; k < need; k++) if (p.have.has(t + k * slotMs)) n++;
    return n >= 0.8 * need
      && p.episodes.every((e) => t + len <= e.fromMs - clearMs || t >= e.toMs + clearMs)
      && p.chosen.every((c) => t + len <= c.fromMs || t >= c.toMs);
  };
  const out: { dogId: string; fromMs: number; toMs: number }[] = [];
  let stuck = 0, k = 0;
  while (out.length < count && stuck < per.length) {
    const p = per[k % per.length];
    const len = lengths[out.length % lengths.length];
    const t = p.starts.find((s) => fits(p, s, len));
    if (t == null) stuck++;
    else { p.chosen.push({ fromMs: t, toMs: t + len }); out.push({ dogId: p.dogId, fromMs: t, toMs: t + len }); stuck = 0; }
    k++;
  }
  return out;
}

/** A shuffled order for the queue (blind: alerts and controls mixed), deterministic for a seed. */
export function shuffledOrder(n: number, seed = 11): number[] {
  const rnd = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}
