/**
 * Plain-Spanish alert titles, shared by the app and the push notifications of the
 * Function. Wording rules: no diagnosis, no alarm, "se aleja de su patrón normal".
 */
import type { AlertReason } from "./types";

const TITLE: Record<string, string> = {
  temp_high: "Su temperatura estuvo alta", temp_low: "Su temperatura estuvo baja",
  temp_deviation: "Su temperatura se alejó de su valor habitual",
  hr_high: "Su frecuencia cardiaca estuvo alta", hr_low: "Su frecuencia cardiaca estuvo baja",
  hr_pattern: "Su frecuencia cardiaca tuvo un patrón poco habitual",
  activity_low: "Se movió menos de lo habitual", activity_high: "Se movió más de lo habitual",
  behavior_unusual: "Se movió de una forma poco habitual",
};
const FALLBACK = "Algo se alejó de su patrón normal";
/** The same titles in the present, for an alert whose episode has not ended. The cause that
 * names the alert is the same; only the tense follows the episode, so the title never says «estuvo» of a dog that still is. */
const TITLE_NOW: Record<string, string> = {
  temp_high: "Su temperatura está alta", temp_low: "Su temperatura está baja",
  temp_deviation: "Su temperatura se aleja de su valor habitual",
  hr_high: "Su frecuencia cardiaca está alta", hr_low: "Su frecuencia cardiaca está baja",
  hr_pattern: "Su frecuencia cardiaca tiene un patrón poco habitual",
  activity_low: "Se mueve menos de lo habitual", activity_high: "Se mueve más de lo habitual",
  behavior_unusual: "Se mueve de una forma poco habitual",
};
const FALLBACK_NOW = "Algo se aleja de su patrón normal";
const PRIORITY: AlertReason["component"][] = ["temperature", "heart_rate", "behavior"];
/** Reasons about the shape of a signal whose level stays inside the dog's band (the heart-rate autoencoder, movements
 * unlike any known behavior): they name the alert only when no variable left its band. */
const SHAPE_ONLY = new Set(["hr_pattern", "behavior_unusual"]);

/** How far a reason's value is out of its normal range, in widths of that range (0 inside
 * it). It makes the variables comparable: 20 % of movement against 52–64 % is 2.7 widths out, 48 lpm against 49–87 lpm
 * only 0.03. */
export function bandWidths(r: AlertReason): number {
  const [lo, hi] = r.normalRange;
  const out = r.value < lo ? lo - r.value : r.value > hi ? r.value - hi : 0;
  return out / Math.max(hi - lo, 1e-6);
}

/** Order of the reasons of an alert: a variable out of its band before the shape-only reasons; among the first, the
 * largest deviation in band widths; ties, and the shape-only reasons (their value sits inside the band), by priority:
 * temperature, heart rate, movement. The engine stores them in this order too (after the one that
 * names the alert). */
export function compareReasons(a: AlertReason, b: AlertReason): number {
  const aShape = SHAPE_ONLY.has(a.code), bShape = SHAPE_ONLY.has(b.code);
  if (aShape !== bShape) return aShape ? 1 : -1;
  if (!aShape) {
    const d = bandWidths(b) - bandWidths(a);
    if (Math.abs(d) > 1e-9) return d;
  }
  return PRIORITY.indexOf(a.component) - PRIORITY.indexOf(b.component);
}

/** The reason that names an alert, computed from its reasons: the variable furthest out of its band,
 * so a heart rate 1 lpm out never names an alert of a movement 20 points under its band. Since the engine
 * keeps every variable that left its range during the episode, so a fever that ended while the activity stayed low
 * still counts. */
export function primaryReason(reasons: AlertReason[]): AlertReason | null {
  return reasons.length ? [...reasons].sort(compareReasons)[0] : null;
}

/** The reason that names an alert: the one the engine chose when it opened and keeps until it rises to «Revisar»
 * so the title does not change while the owner reads it. Alerts written
 * before it have no titleCode: their largest deviation. */
export function titleReason(reasons: AlertReason[], titleCode?: string | null): AlertReason | null {
  return (titleCode ? reasons.find((r) => r.code === titleCode) : undefined) ?? primaryReason(reasons);
}

/** The two directions of one variable: an episode can leave the band on both sides (more movement, then less). */
const OPPOSITE: Record<string, string> = {
  activity_low: "activity_high", activity_high: "activity_low", hr_high: "hr_low", hr_low: "hr_high", temp_high: "temp_low", temp_low: "temp_high",
};

/** One entry per variable for the owner and the vet: when an episode left the band on both sides, the
 * one that names the alert stays, or else the larger deviation. The engine keeps both (display only). */
function oneDirection(reasons: AlertReason[], titleCode?: string | null): AlertReason[] {
  return reasons.filter((r) => {
    const other = reasons.find((x) => x.code === OPPOSITE[r.code]);
    if (!other) return true;
    if (r.code === titleCode || other.code === titleCode) return r.code === titleCode;
    const d = bandWidths(r) - bandWidths(other);
    return Math.abs(d) > 1e-9 ? d > 0 : r.code < other.code;
  });
}

/** Every reason of an alert: the one that names it first, then the others by deviation; one entry per variable. */
export function orderReasons(reasons: AlertReason[], titleCode?: string | null): AlertReason[] {
  const kept = oneDirection(reasons, titleCode);
  const first = titleReason(kept, titleCode);
  return first ? [first, ...kept.filter((r) => r !== first).sort(compareReasons)] : kept;
}

/** How far out of its band (in band widths) a variable must be to be shown as a cause of its own: a
 * tenth of the width of its normal range (1.2 points of movement against a band of 12, 0.18 °C against 37.7–39.5 °C).
 * Closer to the bound it is context: a value at 0.2 of the limit does not weigh as the cause of the alert. */
export const MIN_CAUSE_WIDTHS = 0.1;

/** The causes of an alert as the owner reads them: the one that names it (it opened the alert or rose it to «Revisar»),
 * the variables out of their band by MIN_CAUSE_WIDTHS or more and the shape of the heart rate (listed only when it fired
 * the critical rule); the rest, near the bound of their band, as context in one line. In the order of orderReasons. */
export function splitReasons(reasons: AlertReason[], titleCode?: string | null): { causes: AlertReason[]; context: AlertReason[] } {
  const ordered = orderReasons(reasons, titleCode);
  const first = ordered[0];
  const isCause = (r: AlertReason) => r === first || r.code === "hr_pattern" || bandWidths(r) >= MIN_CAUSE_WIDTHS;
  return { causes: ordered.filter(isCause), context: ordered.filter((r) => !isCause(r)) };
}

/** The title of an alert. `ongoing` (its episode has not ended) writes it in the present, otherwise in the past. */
export function alertTitle(reasons: AlertReason[], titleCode?: string | null, ongoing = false): string {
  const r = titleReason(reasons, titleCode);
  const [table, fallback] = ongoing ? [TITLE_NOW, FALLBACK_NOW] : [TITLE, FALLBACK];
  return r ? table[r.code] ?? fallback : fallback;
}

/** Title and body of the push notification of a new alert, or of one that rose to "Revisar". Both go out while the
 * episode goes on, so the title is in the present. */
export function pushText(dogName: string, reasons: AlertReason[], kind: "new" | "escalated", titleCode?: string | null): { title: string; body: string } {
  const t = alertTitle(reasons, titleCode, true);
  return {
    title: `${dogName}: ${t.charAt(0).toLowerCase()}${t.slice(1)}`,
    body: kind === "new"
      ? "Se alejó de su patrón normal. Abre la app para ver qué pasó y qué puedes hacer."
      : "La alerta pasó a «Revisar». Abre la app para ver qué pasó y qué puedes hacer.",
  };
}
