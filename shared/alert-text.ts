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
const PRIORITY: AlertReason["component"][] = ["temperature", "heart_rate", "behavior"];
/** Reasons about the shape of a signal whose level stays inside the dog's band (the heart-rate autoencoder, movements
 * unlike any known behavior): they name the alert only when no variable left its band. */
const SHAPE_ONLY = new Set(["hr_pattern", "behavior_unusual"]);

/** The reason that names the alert: a variable out of its band first (temperature, then heart rate, then movement),
 * then the shape-only reasons in the same order. */
export function primaryReason(reasons: AlertReason[]): AlertReason | null {
  for (const shape of [false, true]) {
    for (const c of PRIORITY) {
      const r = reasons.find((x) => x.component === c && SHAPE_ONLY.has(x.code) === shape);
      if (r) return r;
    }
  }
  return reasons[0] ?? null;
}

export function alertTitle(reasons: AlertReason[]): string {
  const r = primaryReason(reasons);
  return r ? TITLE[r.code] ?? FALLBACK : FALLBACK;
}

/** Title and body of the push notification of a new alert, or of one that rose to "Revisar". */
export function pushText(dogName: string, reasons: AlertReason[], kind: "new" | "escalated"): { title: string; body: string } {
  const t = alertTitle(reasons);
  return {
    title: `${dogName}: ${t.charAt(0).toLowerCase()}${t.slice(1)}`,
    body: kind === "new"
      ? "Se alejó de su patrón normal. Abre la app para ver qué pasó y qué puedes hacer."
      : "El aviso pasó a «Revisar». Abre la app para ver qué pasó y qué puedes hacer.",
  };
}
