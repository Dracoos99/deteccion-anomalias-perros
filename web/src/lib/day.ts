/**
 * A dog's day from its 5-minute trend slots, for «El día de …» and «Hoy frente a lo habitual».
 * Pure functions: the slots already count the 2 s windows of each behavior the model classified (TrendSlot.beh).
 *
 * The three quiet postures (sitting, standing, lying) are one group, «Descansando»: the collar tells them apart mostly by
 * the angle of the neck and the model confuses them (F1 of 0.67 to 0.76 in the test dogs; grouped, 0.98 for five
 * classes, docs of the behavioral model). Moving behaviors keep their own name (F1 of 0.96 or more).
 */
import { BEHAVIORS, type Behavior } from "@shared/types";
import { DAY_MS, SLOT_MS, type TimedSlot } from "@shared/trends";

export type DayGroup = "rest" | "walk" | "trot" | "play" | "sniff";
export const DAY_GROUPS: DayGroup[] = ["rest", "walk", "trot", "play", "sniff"];
export const GROUP_OF: Record<Behavior, DayGroup> = { sit: "rest", stand: "rest", lie: "rest", walk: "walk", trot: "trot", play: "play", sniff: "sniff" };
export const GROUP_LABEL: Record<DayGroup, string> = { rest: "Descansando", walk: "Caminando", trot: "Trotando", play: "Jugando", sniff: "Olfateando" };
/** Lower case, for sentences («jugó menos que de costumbre» is said by groupVerb). */
export const GROUP_NOUN: Record<DayGroup, string> = { rest: "descanso", walk: "caminata", trot: "trote", play: "juego", sniff: "olfateo" };

const WINDOW_MS = 2_000;
type Counts = Record<DayGroup, number>;
const zero = (): Counts => ({ rest: 0, walk: 0, trot: 0, play: 0, sniff: 0 });

/** Windows of each group in a slot's counts per behavior (order of BEHAVIORS). */
export function groupCounts(beh: readonly number[] | undefined): Counts {
  const c = zero();
  (beh ?? []).forEach((n, i) => { const b = BEHAVIORS[i]; if (b && n > 0) c[GROUP_OF[b]] += n; });
  return c;
}

/** One 5-minute slot of the day: its main group (null without classified windows: no data, or a dog still learning,
 * whose behavior the model cannot read yet), how much of the slot that group is, every group's windows, the mean heart
 * rate and the windows with data. */
export interface DaySegment { t: number; group: DayGroup | null; share: number; counts: Counts; hr: number | null; windows: number }

/** Local midnight of the day that holds `ms` (the owner's day, not the UTC day of the trend documents). */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The slots of [dayStart, dayStart + 24 h) as segments, in time order; slots without data are left out. */
export function daySegments(slots: readonly TimedSlot[], dayStart: number): DaySegment[] {
  const end = dayStart + DAY_MS;
  return slots.filter(({ t }) => t >= dayStart && t < end).map(({ t, slot }) => {
    const counts = groupCounts(slot.beh);
    const classified = DAY_GROUPS.reduce((a, g) => a + counts[g], 0);
    const main = classified ? DAY_GROUPS.reduce((best, g) => (counts[g] > counts[best] ? g : best), "rest" as DayGroup) : null;
    return { t, group: main, share: main ? counts[main] / classified : 0, counts, hr: slot.hrN > 0 ? slot.hrSum / slot.hrN : null, windows: slot.w };
  });
}

/** Time in each group (from its windows), time with data and time with classified behavior. */
export interface DayTotals { ms: Counts; dataMs: number; classifiedMs: number }
export function dayTotals(segments: readonly DaySegment[]): DayTotals {
  const ms = zero();
  let data = 0;
  for (const s of segments) {
    for (const g of DAY_GROUPS) ms[g] += s.counts[g] * WINDOW_MS;
    data += Math.min(s.windows * WINDOW_MS, SLOT_MS);
  }
  return { ms, dataMs: data, classifiedMs: DAY_GROUPS.reduce((a, g) => a + ms[g], 0) };
}

/** Mean heart rate of the slots spent resting (at least `restShare` of their classified windows), or null. */
export function restingHr(segments: readonly DaySegment[], restShare = 0.9): number | null {
  let sum = 0, n = 0;
  for (const s of segments) {
    const classified = DAY_GROUPS.reduce((a, g) => a + s.counts[g], 0);
    if (s.hr == null || !classified || s.counts.rest / classified < restShare) continue;
    sum += s.hr; n += 1;
  }
  return n ? sum / n : null;
}

/** The least classified time a day needs before it is compared (and before it counts as a usual day). */
export const MIN_COMPARE_MS = 3_600_000;

/** One line of «Hoy frente a lo habitual»: the share of the day's classified time in a group (or the resting heart rate)
 * against the mean of the usual days, and how it reads. «same» inside a margin: `rel` of the usual value (30 % for the
 * shares of time, 10 % for the heart rate) and at least `minDiff` (half a point of share, or 5 lpm): play, a few percent
 * of the day, halving is a change; rest going from 89 to 92 % is not. */
export interface Comparison { today: number; usual: number | null; days: number; trend: "more" | "less" | "same" | null }
export function compare(today: number | null, usualDays: readonly (number | null)[], minDiff: number, rel = 0.3): Comparison | null {
  if (today == null) return null;
  const known = usualDays.filter((v): v is number => v != null);
  if (!known.length) return { today, usual: null, days: 0, trend: null };
  const usual = known.reduce((a, b) => a + b, 0) / known.length;
  const diff = today - usual;
  const trend = Math.abs(diff) < Math.max(minDiff, rel * Math.abs(usual)) ? "same" : diff > 0 ? "more" : "less";
  return { today, usual, days: known.length, trend };
}

/** Each group's share of the classified time of a day (0–1), or null below MIN_COMPARE_MS. */
export function groupShares(t: DayTotals): Counts | null {
  if (t.classifiedMs < MIN_COMPARE_MS) return null;
  const s = zero();
  for (const g of DAY_GROUPS) s[g] = t.ms[g] / t.classifiedMs;
  return s;
}

const VERB: Record<DayGroup, [string, string]> = {
  rest: ["descansó más que de costumbre", "descansó menos que de costumbre"],
  walk: ["caminó más que de costumbre", "caminó menos que de costumbre"],
  trot: ["trotó más que de costumbre", "trotó menos que de costumbre"],
  play: ["jugó más que de costumbre", "jugó menos que de costumbre"],
  sniff: ["olfateó más que de costumbre", "olfateó menos que de costumbre"],
};

/** The sentence over the comparison: the groups that moved, in plain words, without judging («Hoy jugó menos que de
 * costumbre y descansó más»), or that the day looks like the usual ones. Null when there is nothing to compare. */
export function dayPhrase(name: string, cmp: Partial<Record<DayGroup, Comparison | null>>, isToday: boolean): string | null {
  const known = DAY_GROUPS.filter((g) => cmp[g]?.trend != null);
  if (!known.length) return null;
  const moved = known.filter((g) => cmp[g]!.trend !== "same");
  const when = isToday ? "Hoy" : "Ese día";
  if (!moved.length) return `${when} ${name} repartió su tiempo como de costumbre.`;
  const parts = moved.map((g, i) => {
    const text = VERB[g][cmp[g]!.trend === "more" ? 0 : 1];
    return i === 0 ? text : text.replace(" que de costumbre", "");
  });
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
  return `${when} ${name} ${list}.`;
}

// ── The week ─────────────────────────────────────────────────────────────────────────────────────

/** One cell of the weekly heat map: the share of the hour's windows in movement and how much of the hour has data. */
export interface HourCell { dayStart: number; hour: number; moving: number | null; coverage: number; hr: number | null }

/** Day × hour grid of the last `days` local days up to the one holding `endMs`: oldest day first, 24 cells each. */
export function hourlyGrid(slots: readonly TimedSlot[], endMs: number, days = 7): HourCell[][] {
  const last = localDayStart(endMs);
  const rows: HourCell[][] = [];
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = last - d * DAY_MS;
    const cells: HourCell[] = Array.from({ length: 24 }, (_, hour) => ({ dayStart, hour, moving: null, coverage: 0, hr: null }));
    const acc = cells.map(() => ({ w: 0, act: 0, hrSum: 0, hrN: 0, slots: 0 }));
    for (const { t, slot } of slots) {
      if (t < dayStart || t >= dayStart + DAY_MS) continue;
      const h = new Date(t).getHours();
      const a = acc[h];
      a.w += slot.w; a.act += slot.act; a.hrSum += slot.hrSum; a.hrN += slot.hrN; a.slots += 1;
    }
    acc.forEach((a, h) => {
      cells[h].coverage = Math.min(1, a.slots / (3_600_000 / SLOT_MS));
      cells[h].moving = a.w ? a.act / a.w : null;
      cells[h].hr = a.hrN ? a.hrSum / a.hrN : null;
    });
    rows.push(cells);
  }
  return rows;
}

/** The hours of the day with the most movement over the grid (mean share of the hours with data), best first. */
export function activeHours(grid: readonly HourCell[][], top = 2): number[] {
  const mean = Array.from({ length: 24 }, (_, h) => {
    const v = grid.map((r) => r[h].moving).filter((x): x is number => x != null);
    return { h, v: v.length ? v.reduce((a, b) => a + b, 0) / v.length : -1 };
  });
  return mean.filter((m) => m.v > 0).sort((a, b) => b.v - a.v).slice(0, top).map((m) => m.h);
}

/** Time in movement of each day of the week (walking, trotting, playing and sniffing), for «La semana». */
export interface WeekDay { dayStart: number; movingMs: number; dataMs: number }
export function weekDays(slots: readonly TimedSlot[], endMs: number, days = 7): WeekDay[] {
  const last = localDayStart(endMs);
  const out: WeekDay[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const t = dayTotals(daySegments(slots, last - d * DAY_MS));
    out.push({ dayStart: last - d * DAY_MS, movingMs: t.ms.walk + t.ms.trot + t.ms.play + t.ms.sniff, dataMs: t.dataMs });
  }
  return out;
}

/** «La semana» in words: the mean time in movement per day with data, the most active day, and whether the last three
 * days moved more or less than the days before (with compare's margins: 30 % and at least 10 minutes). */
/** A day with data for most of it: its minutes can be compared with those of other full days. */
export const FULL_DAY_MS = 20 * 3_600_000;

export function weekPhrase(name: string, week: readonly WeekDay[], weekday: (ms: number) => string, fmt: (ms: number) => string): string | null {
  const withData = week.filter((d) => d.dataMs >= MIN_COMPARE_MS);
  // Minutes are compared between days with data for most of the day; a day under way (or with gaps) is left out
  // while there are at least two full days.
  const full = withData.filter((d) => d.dataMs >= FULL_DAY_MS);
  const known = full.length >= 2 ? full : withData;
  if (known.length < 2) return null;
  const mean = known.reduce((a, d) => a + d.movingMs, 0) / known.length;
  const best = known.reduce((a, d) => (d.movingMs > a.movingMs ? d : a));
  let text = `Esta semana ${name} se movió en promedio ${fmt(mean)} por día${known === full ? "" : " con datos"}; el día que más se movió fue el ${weekday(best.dayStart)} (${fmt(best.movingMs)}).`;
  if (known.length >= 5) {
    const recent = known.slice(-3), before = known.slice(0, -3);
    const c = compare(recent.reduce((a, d) => a + d.movingMs, 0) / recent.length, before.map((d) => d.movingMs), 600_000);
    if (c?.trend === "less") text += " En los últimos 3 días se movió menos que en los anteriores.";
    else if (c?.trend === "more") text += " En los últimos 3 días se movió más que en los anteriores.";
  }
  return text;
}
