/**
 * Plain-language layer of the owner app: a phrase per dog, friendly vitals, alert titles
 * and "Qué puedes hacer". Wording rules: no diagnosis, no alarm, "se desvía de su patrón normal", and no
 * gendered adjectives about the dog unless its sex is known. The thresholds are those of the engine and config/fusion.
 */
import { ACTIVITY_SD_FLOOR, BEHAVIORS as BEHAVIOR_ORDER, HR_SD_FLOOR, levelOf, normalBand, type AlertReason, type Baseline, type Behavior, type DogStatus, type FusionConfig, type Level } from "@shared/types";
import { orderReasons, titleReason } from "@shared/alert-text";
import { STALE_AFTER_MS } from "./live";

export type Dev = "low" | "normal" | "high" | "unknown";
export interface Friendly { dev: Dev; label: string; detail: string | null }
/** `activity` names the span of the movement average in the friendly vitals («Últimos 20 min»). */
type Cfg = Pick<FusionConfig, "baselineSigma" | "tempRange" | "tempMaxDeviation"> & { activity?: Pick<FusionConfig["activity"], "timeConstantS"> }
  & Partial<Pick<FusionConfig, "activityCriticalSigma" | "physio">>;
/** The span of the stable Health Score (config/fusion.stableTimeConstantS, 300 s by default). */
type StableCfg = Partial<Pick<FusionConfig, "stableTimeConstantS">>;
type Sex = "female" | "male" | null | undefined;
type BaselineLike = Pick<Baseline, "activeRatioMean" | "activeRatioStd" | "hrMean" | "hrStd" | "tempMean"> | null | undefined;

const num = (x: number, d = 0) => x.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Normal band of the heart rate for this dog: its baseline ± baselineSigma standard deviations, the same
 * band the engine names in its alerts. */
export function hrBand(b: BaselineLike, cfg: Cfg): [number, number] | null {
  if (!b || b.hrMean == null || b.hrStd == null) return null;   // no heart rate in the dog's data
  const [lo, hi] = normalBand(b.hrMean, b.hrStd, HR_SD_FLOOR, cfg.baselineSigma);
  return [Math.round(lo), Math.round(hi)];
}

/** Normal band of the time in movement (fraction), same rule. */
export function activityBand(b: BaselineLike, cfg: Cfg): [number, number] | null {
  if (!b) return null;
  const [lo, hi] = normalBand(b.activeRatioMean, b.activeRatioStd, ACTIVITY_SD_FLOOR, cfg.baselineSigma);
  return [Math.max(0, lo), Math.min(1, hi)];
}

function devOf(value: number | null | undefined, band: [number, number] | null): Dev {
  if (value == null) return "unknown";
  if (!band) return "unknown";
  return value < band[0] ? "low" : value > band[1] ? "high" : "normal";
}

/** The share in movement is that of the last minutes (the engine's average), not of this moment. */
export function activityFriendly(ratio: number | null | undefined, b: BaselineLike, cfg: Cfg, shown?: Dev): Friendly {
  const dev = shown ?? devOf(ratio, activityBand(b, cfg));
  const minutes = cfg.activity ? Math.round(cfg.activity.timeConstantS / 60) : null;
  const detail = ratio == null ? null : minutes ? `Últimos ${minutes} min: ${num(100 * ratio)} % en movimiento` : `${num(100 * ratio)} % del tiempo en movimiento`;
  const label = { low: "Menos que de costumbre", normal: "Como de costumbre", high: "Más que de costumbre", unknown: ratio == null ? "Sin datos" : "Sin referencia todavía" }[dev];
  return { dev, label, detail };
}

export function heartFriendly(hr: number | null | undefined, b: BaselineLike, cfg: Cfg, shown?: Dev): Friendly {
  const dev = shown ?? devOf(hr, hrBand(b, cfg));
  const label = { low: "Más lento de lo habitual", normal: "Normal", high: "Más rápido de lo habitual", unknown: hr == null ? "Sin datos" : "Sin referencia todavía" }[dev];
  return { dev, label, detail: hr == null ? null : `${num(hr)} lpm` };
}

/** How long a movement or heart-rate judgement must hold before the screens change it,
 * and how long without being asked for a dog before the held judgement is forgotten. The movement average and the heart
 * rate of the last minute graze the edge of their band for minutes: with the raw judgement the seal, the phrase and the
 * summary went «Todo normal» · «Atención» · «Todo normal» every few seconds for a dog that had not changed. */
export const SETTLE_HOLD_MS = 20_000;
export const SETTLE_FORGET_MS = 30_000;
/** The hold is for the edge, where the judgement blinks. A value this many widths of the band beyond it
 * (Toby at 140 lpm against 49–87) is not grazing the edge: its judgement changes at once. */
export const SETTLE_DEEP_WIDTHS = 0.25;
const beyondEdge = (v: number | null | undefined, band: [number, number] | null) =>
  v != null && !!band && (v < band[0] - SETTLE_DEEP_WIDTHS * (band[1] - band[0]) || v > band[1] + SETTLE_DEEP_WIDTHS * (band[1] - band[0]));
const settledDevs = new Map<string, { shown: Dev; raw: Dev; since: number; seen: number }>();

/** The judgement of one signal of one dog as the screens show it: a new one (`raw`) replaces the shown one only after it
 * held SETTLE_HOLD_MS without interruption. The first sight of a dog (or one after SETTLE_FORGET_MS without being asked
 * for it, as when the owner opens a page) shows what is true now. Display only, shared by every screen so none disagrees
 * with another; the thresholds, the engine and the alerts do not change. */
export function settleDev(key: string, raw: Dev, now = Date.now(), holdMs = SETTLE_HOLD_MS): Dev {
  const e = settledDevs.get(key);
  if (!e || raw === "unknown" || e.shown === "unknown" || now - e.seen > SETTLE_FORGET_MS) {
    settledDevs.set(key, { shown: raw, raw, since: now, seen: now });
    return raw;
  }
  e.seen = now;
  if (raw !== e.raw) { e.raw = raw; e.since = now; }
  if (e.shown !== e.raw && now - e.since >= holdMs) e.shown = e.raw;
  return e.shown;
}
/** Forget every held judgement (tests, signing out). */
export const resetSettled = () => settledDevs.clear();

/** How many widths of its normal band the heart rate must be beyond the band before it changes
 * the level shown by itself. A walk or a game raise it some 20 to 30 lpm, inside this margin; a sustained tachycardia
 * of +100 % is far beyond it (Rocky: 132 to 140 lpm against 49–75). */
export const HEART_FAR_WIDTHS = 1.5;

/** Whether the heart rate (status.lastHr, the engine's mean of the last 60 s, the same value heartFriendly judges) is
 * far from the dog's band: more than HEART_FAR_WIDTHS widths of the band above its top or below its bottom. */
export function heartFar(hr: number | null | undefined, b: BaselineLike, cfg: Cfg): "high" | "low" | null {
  const band = hrBand(b, cfg);
  if (hr == null || !band) return null;
  const w = band[1] - band[0];
  return hr > band[1] + HEART_FAR_WIDTHS * w ? "high" : hr < band[0] - HEART_FAR_WIDTHS * w ? "low" : null;
}

/** A vital of data that stopped arriving is its last value, not a judgement of the present. */
export function lastValue(f: Friendly): Friendly {
  return { dev: "unknown", label: f.detail ? "Último dato" : "Sin datos", detail: f.detail?.replace(/^Últimos \d+ min: /, "") ?? null };
}

export function tempFriendly(t: number | null | undefined, b: BaselineLike, cfg: Cfg): Friendly {
  let dev: Dev = t == null ? "unknown" : t < cfg.tempRange[0] ? "low" : t > cfg.tempRange[1] ? "high" : "normal";
  // Inside the reference range but far from its own usual value also counts.
  if (dev === "normal" && t != null && b?.tempMean != null && Math.abs(t - b.tempMean) > cfg.tempMaxDeviation) dev = t > b.tempMean ? "high" : "low";
  const label = { low: "Más baja de lo normal", normal: "Normal", high: "Más alta de lo normal", unknown: "Sin datos" }[dev];
  return { dev, label, detail: t == null ? null : `${num(t, 1)} °C` };
}

export interface DogSummary { phrase: string; activity: Friendly; heart: Friendly; temp: Friendly;
  /** What to do when the level dropped and no alert explains it yet; null otherwise. It
   * follows the cause of the level. */
  todo: string | null;
  /** The level the owner screens show. The stable one from the Health Score, but never «Todo
   * normal» while an alert episode goes on, the temperature is out of its range, the movement is low or
   * the heart rate is far from its band: with weights 0.4/0.4/0.2 a fever alone leaves the score at 80 or more. */
  level: Level | null;
  /** Why the level is «Atención» although the score alone would say «Todo normal»; null when they agree. */
  levelNote: string | null;
  /** «Todo normal», but the movement or the heart rate is just out of its band. */
  slight: boolean;
  /** While the alert goes on, whether the variable that names it is still out of its band (so its title
   * may be in the present); null without an alert in course. */
  titleStill: boolean | null;
  /** The collar seems off the dog (dogs.status.sensor «no_wear»). */
  sensorOff: boolean }

/** The level and the Health Score the owner screens show: the stable ones (a 5-minute average) when the
 * Function wrote them, the instantaneous ones in status docs from before. The «En vivo» panel keeps the instantaneous. */
export function shownScore(s: Pick<DogStatus<unknown>, "level" | "healthScore" | "stableLevel" | "stableHealthScore"> | null | undefined, ongoingAlert = false): { level: Level | null; score: number | null } {
  if (!s) return { level: null, score: null };
  const level = s.stableLevel ?? s.level;
  // While an alert episode is still going (its last trigger has not ended), the dog is never shown as «Todo normal»:
  // a critical rule can hold the alert open with a Health Score still at 80 or more (weights 0.4/0.4/0.2).
  return { level: ongoingAlert && level === "green" ? "amber" : level, score: s.stableHealthScore ?? s.healthScore ?? null };
}

/** A dog still learning its normal pattern (no baseline) with nothing out of the reference ranges is
 * shown as «Aprendiendo su patrón normal», never as «Todo normal» with a green score. */
export function isLearning(s: Parameters<typeof shownScore>[0], b: unknown): boolean {
  return !!s && !b && shownScore(s).level === "green";
}

/** The neutral state of a dog still learning its normal pattern. */
export const LEARNING_TEXT = "Aprendiendo su patrón normal";

/** The one line that says what the Health Score is, where the number first appears. It
 * also says which one it is, the average of the last minutes, apart from the «ahora» of the «En vivo» panel. */
export function scoreNote(cfg: StableCfg): string {
  const minutes = Math.round((cfg.stableTimeConstantS ?? 300) / 60);
  return minutes > 0
    ? `Es el promedio de los últimos ${minutes} minutos y resume qué tan cerca está de su patrón normal. No es una nota de salud.`
    : "Resume qué tan cerca está de su patrón normal. No es una nota de salud.";
}

/** How long a shown Health Score may hold while the stable score drifts. */
export const SCORE_HOLD_MS = 60_000;
const SCORE_STEP = 3;
export interface Steady { score: number; at: number }

/** The figure the owner screens show. The stable score is an average updated with every block, so it moves a point
 * every few seconds (53, 54, 55, 54 in half a minute): the figure changes only when it moved SCORE_STEP points, when
 * it crossed a level cut (so the number and the level always agree) or after SCORE_HOLD_MS. Display only. */
export function steadyScore(prev: Steady | null, next: number | null, now: number, levels: FusionConfig["levels"]): Steady | null {
  if (next == null) return null;
  if (!prev) return { score: next, at: now };
  if (next === prev.score) return prev;
  const crossed = levelOf(next, levels) !== levelOf(prev.score, levels);
  return crossed || Math.abs(next - prev.score) >= SCORE_STEP || now - prev.at >= SCORE_HOLD_MS ? { score: next, at: now } : prev;
}

/** An alert as describeDog reads it: its reasons and the one that names it (shared/alert-text.ts). */
export type AlertLike = { reasons: AlertReason[]; titleCode?: string | null };

/** The phrase of a dog whose alert is still going names the reason that names the alert,
 * like the banner under it: in the present while that variable is still out of its band, in the past otherwise. */
const ALERT_PHRASE: Record<string, [string, string]> = {
  temp_high: ["Su temperatura está más alta de lo normal.", "Su temperatura estuvo más alta de lo normal en los últimos minutos."],
  temp_low: ["Su temperatura está más baja de lo normal.", "Su temperatura estuvo más baja de lo normal en los últimos minutos."],
  temp_deviation: ["Su temperatura se aleja de su valor habitual.", "Su temperatura se alejó de su valor habitual en los últimos minutos."],
  hr_high: ["Su corazón late más rápido de lo habitual.", "Su corazón latió más rápido de lo habitual en los últimos minutos."],
  hr_low: ["Su corazón late más lento de lo habitual.", "Su corazón latió más lento de lo habitual en los últimos minutos."],
  activity_low: ["Se está moviendo menos de lo habitual.", "Se movió menos de lo habitual en los últimos minutos."],
  activity_high: ["Se está moviendo más de lo habitual.", "Se movió más de lo habitual en los últimos minutos."],
  hr_pattern: ["", "Su frecuencia cardiaca tuvo un patrón poco habitual en los últimos minutos."],
  behavior_unusual: ["", "Se movió de una forma poco habitual en los últimos minutos."],
};

export type Vitals = { temp: Friendly; heart: Friendly; activity: Friendly };

/** Whether the variable of an alert reason is out of its band right now. */
function reasonStill(r: AlertReason, v: Vitals): boolean {
  const out = (f: Friendly) => f.dev === "high" || f.dev === "low";
  return ({
    temp_high: v.temp.dev === "high", temp_low: v.temp.dev === "low", temp_deviation: out(v.temp),
    hr_high: v.heart.dev === "high", hr_low: v.heart.dev === "low", activity_low: v.activity.dev === "low", activity_high: v.activity.dev === "high",
  } as Record<string, boolean>)[r.code] ?? false;
}

/** Whether the cause of an alert in course still holds, for the tense of its explanation: its variable is
 * out of its band now, or it is a reason of shape (no band to look at), which holds with the episode. */
export const reasonHolds = (r: AlertReason, v: Vitals): boolean =>
  r.code === "hr_pattern" || r.code === "behavior_unusual" || reasonStill(r, v);

function alertPhrase(r: AlertReason, v: Vitals): string {
  const p = ALERT_PHRASE[r.code];
  return !p ? "Algo se alejó de su patrón normal en los últimos minutos." : reasonStill(r, v) ? p[0] : p[1];
}

/** The one-line answer to "¿está bien mi perro?" plus the three friendly vitals of the Inicio card. `alert` is the dog's
 * open alert, if any (or only its reasons). The phrase agrees with the level shown and does
 * not jump between causes: while the alert goes on (`ongoingAlert`), it names the alert's main reason,
 * as the banner under it does; otherwise a fixed order, temperature, movement (a 20-minute average) and heart. */
export function describeDog(status: DogStatus<unknown> | null | undefined, b: BaselineLike, cfg: Cfg, alert?: AlertReason[] | AlertLike | null, ongoingAlert = false,
  opts: { key?: string; now?: number } = {}): DogSummary {
  const reasons = Array.isArray(alert) ? alert : alert?.reasons ?? null;
  const titleCode = Array.isArray(alert) ? null : alert?.titleCode ?? null;
  // With a `key` (the dog's id) the movement and heart judgements hold SETTLE_HOLD_MS before they
  // change, the same on every screen; without it, the judgement of this moment (tests, one-off uses).
  const settle = (signal: string, raw: Dev, holdMs?: number) => (opts.key ? settleDev(`${opts.key}:${signal}`, raw, opts.now, holdMs) : raw);
  // A fast heart rate rises with play, so it counts only far from its band: a walk or a game stays inside
  // that margin, a sustained tachycardia does not. It enters at once (a real change must show at once)
  // and leaves after SETTLE_HOLD_MS, so the seal does not drop for a second when the 60-second mean grazes the margin.
  const farRaw = heartFar(status?.lastHr, b, cfg);
  const farHeld = settle("far", farRaw ?? "normal", farRaw ? 0 : undefined);
  const far = farHeld === "high" || farHeld === "low" ? farHeld : null;
  const actBand = activityBand(b, cfg), hrb = hrBand(b, cfg);
  const activity = activityFriendly(status?.lastActivityRatio, b, cfg, settle("activity", devOf(status?.lastActivityRatio, actBand), beyondEdge(status?.lastActivityRatio, actBand) ? 0 : undefined));
  // The heart row says the same as the seal: far from its band, it is «Más rápido» at once, not «Normal» for 20 s.
  const heartSettled = settle("heart", devOf(status?.lastHr, hrb), farRaw || beyondEdge(status?.lastHr, hrb) ? 0 : undefined);
  const heart = heartFriendly(status?.lastHr, b, cfg, far ?? heartSettled);
  const temp = tempFriendly(status?.lastTemp, b, cfg);
  // Temperature and low movement are steady signals (a 20-minute average, a stable temperature): they do not make the
  // level flicker.
  const tempOut = temp.dev === "high" || temp.dev === "low";
  const lowMovement = activity.dev === "low";
  const forced = ongoingAlert || tempOut || !!far || lowMovement;
  const level = shownScore(status, forced).level;
  const byScore = shownScore(status).level;
  const farText = `su corazón late mucho más ${far === "low" ? "lento" : "rápido"} de lo habitual`;
  const levelNote = !!status && byScore === "green" && level === "amber"
    ? ongoingAlert ? "Atención porque hay una alerta en curso, aunque el número esté sobre 80."
      : tempOut ? "Atención porque su temperatura salió de lo normal, aunque el número esté sobre 80."
        : far ? `Atención porque ${farText}, aunque el número esté sobre 80.`
          : "Atención porque se mueve menos de lo habitual, aunque el número esté sobre 80."
    : null;
  // While the alert goes on, the phrase speaks of what holds the level now: the reason that names the
  // alert while its variable is out of its band, otherwise the first other reason that still is; only when none is,
  // the one that names the alert, in the past («latió más rápido»), as before.
  const vitals = { temp, heart, activity };
  const main = status && ongoingAlert && reasons?.length
    ? orderReasons(reasons, titleCode).find((r) => reasonStill(r, vitals)) ?? titleReason(reasons, titleCode) : null;
  let phrase: string;
  // The collar seems off the dog: what arrives is not the dog's, so nothing about the dog is said.
  const sensorOff = status?.sensor === "no_wear";
  if (!status) phrase = "Todavía no hay datos.";
  else if (sensorOff) phrase = "Parece que no lleva puesto el collar: no llegan su ritmo cardiaco ni su temperatura, y el sensor no registra ningún movimiento.";
  else if (main) phrase = alertPhrase(main, vitals);
  else if (temp.dev === "high") phrase = "Su temperatura está más alta de lo normal.";
  else if (temp.dev === "low") phrase = "Su temperatura está más baja de lo normal.";
  // Without a baseline nothing is "habitual" yet; only the reference ranges apply.
  // In plain words what the learning period checks (the temperature only), as its panel says.
  else if (!b) phrase = "Estamos aprendiendo su patrón normal. Mientras tanto, solo revisamos su temperatura.";
  // A heart rate far from its band goes before the movement: it is what changed the level, and
  // it stays far while the change lasts, so the phrase does not alternate with the movement of the moment.
  else if (far) phrase = `${farText.charAt(0).toUpperCase()}${farText.slice(1)}.`;
  // A vital just out of its band can leave the score at "Todo normal"; the phrase then says it is a little.
  // Movement before heart: the movement average is steady, the heart rate goes in and out of its band.
  else if (activity.dev !== "normal" && activity.dev !== "unknown") phrase = `Se está moviendo ${level === "green" ? "un poco " : ""}${activity.dev === "low" ? "menos" : "más"} de lo habitual.`;
  else if (heart.dev !== "normal" && heart.dev !== "unknown") phrase = `Su corazón late ${level === "green" ? "un poco " : ""}más ${heart.dev === "high" ? "rápido" : "lento"} de lo habitual.`;
  else if (level !== "green") {
    // No vital is out of its band: the level dropped for the shape of the heart rate (autoencoder), for unusual
    // movements (novelty) or for a deviation inside the band. Name it only when an alert says which.
    const code = reasons ? titleReason(reasons, titleCode)?.code : undefined;
    phrase = code === "hr_pattern" ? "Su frecuencia cardiaca tuvo un patrón poco habitual en el último minuto."
      : code === "behavior_unusual" ? "Se movió de una forma poco habitual en los últimos minutos."
        : "Algo se alejó un poco de su patrón normal en los últimos minutos.";
  } else phrase = "Todo en orden: se mueve y descansa como de costumbre.";
  // «Atención» or «Revisar» without an alert still says what to do, in one line. What to look at
  // follows the cause, never «no hace falta hacer nada» with a fever or a racing heart; and the alert is promised only
  // when a rule would open one if the change lasts.
  let todo: string | null = sensorOff ? "Revisa que el collar esté bien puesto y encendido. Mientras no llegan sus datos, no podemos avisarte de cambios." : null;
  if (!sensorOff && status && !reasons && (level === "amber" || level === "red")) {
    const step = tempOut ? "Mide su temperatura cuando esté en reposo y fíjate cómo está."
      : far ? "Deja que descanse unos minutos, cuenta sus latidos con la mano sobre su pecho y fíjate cómo está."
        : lowMovement ? "Fíjate cómo está y si come, bebe y juega como siempre."
          : "Fíjate cómo está en los próximos minutos.";
    todo = level === "red" || alertWouldOpen(status, b, cfg) ? `${step} Si el cambio sigue unos minutos, verás una alerta con los pasos a seguir.` : step;
  }
  // «Todo normal» with a vital just out of its band (the card shows it in amber): the Inicio summary
  // does not call that dog «dentro de su patrón normal».
  const slight = !!status && level === "green" && [activity, heart].some((f) => f.dev === "high" || f.dev === "low");
  // Whether the variable that names the alert is still out of its band; the shape reasons (the
  // heart-rate pattern, unusual movements) have no band to look at and hold with the episode. Null without an alert.
  const named = status && ongoingAlert && reasons?.length ? titleReason(reasons, titleCode) : null;
  const titleStill = named ? (named.code === "hr_pattern" || named.code === "behavior_unusual" ? true : reasonStill(named, vitals)) : null;
  return { phrase, activity, heart, temp, todo, level, levelNote: sensorOff ? null : levelNote, slight: sensorOff ? false : slight, titleStill, sensorOff };
}

/** The explanation of a cause of an alert that already ended, in the past («estuvo por encima»);
 * the engine writes it in the present, while the episode goes on. */
export const messageInPast = (m: string) => m.replace(/(^|\s)está(?=[\s.,;]|$)/g, "$1estuvo");

/** Whether a critical rule of the engine holds now, so the change opens an alert if it lasts
 * (shared/engine.ts): the temperature out of its reference range, the heart rate beyond its level rule (levelSigma,
 * baselineSigma by default) or the movement under the low-activity rule (activityCriticalSigma). «Revisar» is under
 * the alert threshold and always counts. */
function alertWouldOpen(status: DogStatus<unknown>, b: BaselineLike, cfg: Cfg): boolean {
  const t = status.lastTemp;
  if (t != null && (t < cfg.tempRange[0] || t > cfg.tempRange[1])) return true;
  if (b && b.hrMean != null && status.lastHr != null) {
    const [lo, hi] = normalBand(b.hrMean, b.hrStd ?? 0, HR_SD_FLOOR, cfg.physio?.levelSigma ?? cfg.baselineSigma);
    if (status.lastHr < lo || status.lastHr > hi) return true;
  }
  if (b && cfg.activityCriticalSigma != null && status.lastActivityRatio != null) {
    const z = (status.lastActivityRatio - b.activeRatioMean) / Math.max(b.activeRatioStd, ACTIVITY_SD_FLOOR);
    if (z < -cfg.activityCriticalSigma) return true;
  }
  return false;
}

/** "Luna", "Luna y Toby", "Bruno, Luna y Toby". */
export function namesText(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** A dog for the Inicio summary: `stale` when its newest data are old (not its current state), `openAlert` when it has
 * an alert still to review, `alertEnded` when that alert's episode already ended (its banner says «ya pasó»). */
type DogLevel = { name: string; level: DogStatus<unknown>["level"] | null; learning?: boolean; stale?: boolean; openAlert?: boolean; alertEnded?: boolean;
  /** «Todo normal» with the movement or the heart rate just out of its band (DogSummary.slight). */
  slight?: boolean;
  /** The collar seems off: «Revisa el collar». */
  sensorOff?: boolean };

/** Place of a dog in the Inicio order (lower first): «Revisar», «Atención», a new alert, the rest, those still learning
 * their pattern or whose data stopped (an old level is not a reason to go first), and those without data. */
export function attentionRank(d: DogLevel): number {
  if (!d.level) return 5;
  // A dog still learning (or with old data) that has an alert waiting goes with the new alerts, not at the end.
  if (d.stale || d.learning) return d.openAlert ? 2 : 4;
  if (d.sensorOff) return 1;
  return d.level === "red" ? 0 : d.level === "amber" ? 1 : d.openAlert ? 2 : 3;
}

/** Inicio order: the dogs that need a look first (Revisar, Atención, then a new alert), then the rest, those still
 * learning their pattern, and those without data; by name. `level` is the stable one. */
export function byAttention<T extends DogLevel>(dogs: T[]): T[] {
  return [...dogs].sort((a, b) => attentionRank(a) - attentionRank(b) || a.name.localeCompare(b.name, "es"));
}

/** How long a dog that needs a look less than before keeps its place on Inicio. */
export const ORDER_HOLD_MS = 120_000;
/** The place each dog holds in the Inicio order, and since when it needs less than that place. */
export type HeldRanks = Map<string, { rank: number; calmSince: number | null }>;

/** The Inicio order while the page is open. It was fixed when the page opened, so a dog whose
 * level rose a minute later (Toby, «Atención», 76) stayed under one in «Todo normal» (Rocky, 94). Now a dog that starts
 * to need a look moves up at once; one that needs it less keeps its place for ORDER_HOLD_MS, so a level that hovers on
 * a cut does not move cards back and forth under the owner's eyes. Returns the ids in order and the ranks to keep. */
export function attentionOrder<T extends DogLevel & { id: string }>(dogs: T[], held: HeldRanks, now: number): { ids: string[]; held: HeldRanks } {
  const next: HeldRanks = new Map();
  for (const d of dogs) {
    const rank = attentionRank(d), prev = held.get(d.id);
    if (!prev || rank <= prev.rank) next.set(d.id, { rank, calmSince: null });
    else {
      const calmSince = prev.calmSince ?? now;
      next.set(d.id, now - calmSince >= ORDER_HOLD_MS ? { rank, calmSince: null } : { rank: prev.rank, calmSince });
    }
  }
  const ids = [...dogs].sort((a, b) => next.get(a.id)!.rank - next.get(b.id)!.rank || a.name.localeCompare(b.name, "es")).map((d) => d.id);
  return { ids, held: next };
}

/** One sentence above the Inicio cards: how the owner's dogs are, the ones that need a look first. Null without data.
 * A dog still learning its normal pattern is never said to be "within its normal pattern"; a
 * dog whose data stopped is not described in the present; and nothing reads "Todo en orden" while an alert waits.
 * A dog whose new alert already ended gets its own sentence and is not counted again among those
 * «como de costumbre»; counts use the real total, «tus» for an owner and «los» for the research account
 * (`all`), and the dogs without data yet are said apart. */
export function homeSummary(dogs: DogLevel[], opts: { all?: boolean } = {}): string | null {
  // Grouped by level below; within each group, by name.
  const byName = [...dogs].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const withData = byName.filter((d) => d.level);
  if (!withData.length) return null;
  const noData = byName.filter((d) => !d.level).map((d) => d.name);
  // A collar that seems off is said apart, before anything about the dogs whose data do arrive.
  const collar = withData.filter((d) => !d.stale && d.sensorOff).map((d) => d.name);
  const current = withData.filter((d) => !d.stale && !d.sensorOff);
  const of = (l: string) => current.filter((d) => d.level === l && !(l === "green" && d.learning)).map((d) => d.name);
  const red = of("red"), amber = of("amber");
  // Back to its usual after an alert that already ended: one sentence says both.
  // A dog in «Todo normal» whose card shows a vital in amber is not said to be «dentro de su patrón normal» nor
  // «como de costumbre» (also when its alert already ended); its alert, if any, gets its own sentence below.
  const slight = current.filter((d) => d.level === "green" && !d.learning && d.slight).map((d) => d.name);
  const passed = current.filter((d) => d.level === "green" && !d.learning && d.openAlert && d.alertEnded && !slight.includes(d.name)).map((d) => d.name);
  const green = of("green").filter((n) => !passed.includes(n) && !slight.includes(n));
  const learning = current.filter((d) => d.level === "green" && d.learning).map((d) => d.name);
  const withAlert = withData.filter((d) => d.openAlert).map((d) => d.name);
  const stale = withData.filter((d) => d.stale).map((d) => d.name);
  const flagged = red.length + amber.length;
  // A dog already named above for its level needs no second sentence for its alert (its card shows the banner).
  const alertOnly = withAlert.filter((n) => !red.includes(n) && !amber.includes(n) && !passed.includes(n));
  const named = flagged + passed.length + slight.length + collar.length > 0;
  const yours = opts.all ? "los" : "tus";
  const parts: string[] = [];
  if (collar.length) parts.push(`Revisa el collar de ${namesText(collar)}: no llegan su movimiento, su ritmo cardiaco ni su temperatura.`);
  if (red.length) parts.push(`${namesText(red)} ${red.length > 1 ? "se alejaron" : "se alejó"} de su patrón normal; revisa cómo ${red.length > 1 ? "están" : "está"}.`);
  if (amber.length) parts.push(`${namesText(amber)} ${amber.length > 1 ? "tienen" : "tiene"} un cambio leve.`);
  if (slight.length) parts.push(`${namesText(slight)} ${slight.length > 1 ? "tienen" : "tiene"} un dato un poco fuera de lo habitual.`);
  if (passed.length) parts.push(`${namesText(passed)} ${passed.length > 1 ? "tienen alertas nuevas que ya pasaron; ahora están" : "tiene una alerta nueva que ya pasó; ahora está"} como de costumbre.`);
  if (!named && !withAlert.length) {
    // «Todo en orden» only when it is true of every dog.
    if (green.length > 1 && green.length === dogs.length) parts.push(`Todo en orden: ${yours} ${green.length} perros están dentro de su patrón normal.`);
    else if (green.length > 3) parts.push(`De ${yours} ${dogs.length} perros, ${green.length} están dentro de su patrón normal.`);
    else if (green.length) parts.push(`${namesText(green)} ${green.length > 1 ? "están" : "está"} dentro de su patrón normal.`);
  } else if (green.length > 3) parts.push(named ? `Los otros ${green.length} están como de costumbre.` : `De ${yours} ${dogs.length} perros, ${green.length} están como de costumbre.`);
  else if (green.length) parts.push(`${namesText(green)} ${green.length > 1 ? "están" : "está"} como de costumbre.`);
  if (alertOnly.length) parts.push(`${namesText(alertOnly)} ${alertOnly.length > 1 ? "tienen alertas nuevas" : "tiene una alerta nueva"}.`);
  if (stale.length) parts.push(`No recibimos datos recientes de ${namesText(stale)}.`);
  if (learning.length) parts.push(`Estamos aprendiendo el patrón normal de ${namesText(learning)}.`);
  if (noData.length) parts.push(`Todavía no hay datos de ${noData.length > 3 ? `${noData.length} perros` : namesText(noData)}.`);
  return parts.join(" ");
}

const NOW_TEXT: Record<Behavior, [string, string]> = {
  sit: ["Sentado", "Sentada"], stand: ["Parado", "Parada"], lie: ["Echado", "Echada"],
  trot: ["Trotando", "Trotando"], walk: ["Caminando", "Caminando"], play: ["Jugando", "Jugando"], sniff: ["Olfateando", "Olfateando"],
};
/** Current behavior, agreeing with the dog's sex when it is known. */
export const behaviorNow = (b: Behavior, sex: Sex) => NOW_TEXT[b][sex === "female" ? 1 : 0];

/** Below this probability the shown behavior is not stated as sure. A display rule, not a calibration: the
 * quiet postures are the model's weak spot (F1 of 0.67 to 0.76), its novelty threshold is 0.41, and the line is meant to
 * be reviewed with the expert reviewer of the thesis. */
export const BEHAVIOR_SURE = 0.6;
const QUIET: readonly Behavior[] = ["sit", "stand", "lie"];

/** The current behavior as the owner reads it, with the model's confidence (status.lastBehaviorProb): a quiet posture
 * it doubts is «En reposo» (all three are rest, and that it tells apart almost perfectly); a moving behavior it doubts is
 * «Probablemente caminando»; without a probability, the behavior as before. */
/** The confidence of what is shown: for «En reposo», the three quiet postures together; otherwise the behavior's. */
export function shownConfidence(b: Behavior, probs: readonly number[] | null | undefined): number | null {
  if (!probs) return null;
  const p = probs[BEHAVIOR_ORDER.indexOf(b)];
  if (p == null) return null;
  if (p >= BEHAVIOR_SURE || !QUIET.includes(b)) return p;
  return QUIET.reduce((a, q) => a + (probs[BEHAVIOR_ORDER.indexOf(q)] ?? 0), 0);
}

export function behaviorShown(b: Behavior, p: number | null | undefined, sex: Sex): string {
  if (p == null || p >= BEHAVIOR_SURE) return behaviorNow(b, sex);
  return QUIET.includes(b) ? "En reposo" : `Probablemente ${behaviorNow(b, sex).toLowerCase()}`;
}

export const BEHAVIOR_LABEL: Record<Behavior, string> = {
  sit: "Sentarse", stand: "Pararse", lie: "Echarse", trot: "Trotar", walk: "Caminar", play: "Jugar", sniff: "Olfatear",
};

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────

// Titles live in shared/alert-text.ts: the Function uses them for push notifications.
export { alertTitle, orderReasons, primaryReason, splitReasons, titleReason } from "@shared/alert-text";

/** "Qué puedes hacer": observation steps only, never a diagnosis or a treatment. An episode that
 * ended more than a day ago is not something to watch "durante las próximas horas". The
 * steps follow the alert's level. In «Atención», watch and measure at rest; in «Revisar», the vet comes first if the
 * change goes on, and what the owner notices is what to bring to the visit. */
export function whatToDo(reasons: AlertReason[], dogName: string, cfg: Pick<FusionConfig, "tempRange">,
  opts: { endedAtMs?: number | null; now?: number; severity?: "amber" | "red" } = {}): string[] {
  const has = (c: AlertReason["component"]) => reasons.some((r) => r.component === c);
  const old = opts.endedAtMs != null && (opts.now ?? Date.now()) - opts.endedAtMs > 86_400_000;
  const range = `${num(cfg.tempRange[0], 1)}–${num(cfg.tempRange[1], 1)} °C`;
  const vetView = "consulta a tu veterinario y muéstrale la Vista para el veterinario.";
  if (opts.severity === "red") {
    // In «Revisar» the vet is the first step, not a condition, while the change goes on; after it
    // ended, telling the vet about it; days later, only if it comes back.
    const going = opts.endedAtMs == null;
    const out = [old ? `Si el cambio vuelve a aparecer, ${vetView}` : going ? "Consulta a tu veterinario y muéstrale la Vista para el veterinario."
      : "Cuéntale este cambio a tu veterinario y muéstrale la Vista para el veterinario."];
    if (!old) out.push(`${going ? "Mientras tanto, observa" : "Observa"} a ${dogName} y anota lo que notes: te servirá en la consulta.`);
    if (has("temperature")) out.push(`Si puedes, mide su temperatura con un termómetro cuando esté en reposo y anota el valor (lo normal para un perro: ${range}).`);
    if (has("heart_rate")) out.push("Cuando descanse, observa su respiración y anota si la notas agitada.");
    if (has("behavior")) out.push("Fíjate si come, bebe y juega como siempre, y si le cuesta moverse.");
    return out;
  }
  const out = [old ? "Fíjate si el cambio vuelve a aparecer." : `Observa a ${dogName} durante las próximas horas.`];
  if (has("temperature")) out.push(`Si puedes, mide su temperatura con un termómetro cuando esté en reposo. Si sigue fuera de ${range}, consulta a tu veterinario.`);
  if (has("heart_rate")) out.push("Cuando descanse, observa su respiración: si la notas agitada o la alerta se repite, consulta a tu veterinario.");
  if (has("behavior")) out.push("Fíjate si come, bebe y juega como siempre, y si le cuesta moverse.");
  out.push(`Si notas otros cambios o la alerta se repite, ${vetView}`);
  return out;
}

/** The name of a cause of an alert. Two causes never share a name: the time in movement and
 * the movements unlike any known behavior are different measures of the same sensor. */
export function reasonLabel(r: AlertReason): string {
  if (r.code === "behavior_unusual") return "Movimientos poco habituales";
  return ({ behavior: "Tiempo en movimiento", heart_rate: "Frecuencia cardiaca", temperature: "Temperatura" } as const)[r.component];
}

/** Decimals written in a stored number (at most 2). */
const places = (x: number) => { const s = String(x), i = s.indexOf("."); return i < 0 ? 0 : Math.min(2, s.length - i - 1); };

/** Unit and decimals of a reason's value. As many decimals as the engine stored, so a value out of its range
 * is never printed on its bound («46.7 %» against «46.8–58.9 %», not «47 %» against «47–59 %»). */
export function reasonUnit(r: AlertReason): { unit: string; decimals: number } {
  const unit = r.component === "temperature" ? "°C" : r.component === "heart_rate" ? "lpm" : "%";
  const base = r.component === "temperature" ? 1 : 0;
  return { unit, decimals: Math.max(base, places(r.value), places(r.normalRange[0]), places(r.normalRange[1])) };
}

/** The normal range of a cause as the owner reads it: unusual movements have only a ceiling, so
 * «Lo habitual: hasta el 5 %» and not «Normal: 0–5 %». */
export function reasonRangeText(r: AlertReason, decimals = reasonUnit(r).decimals): string {
  const { unit } = reasonUnit(r);
  const [lo, hi] = r.normalRange;
  return r.code === "behavior_unusual" ? `Lo habitual: hasta el ${num(hi, decimals)} %` : `Normal: ${num(lo, decimals)}–${num(hi, decimals)} ${unit}`;
}

/** The variables of an alert near the bound of their band, in one line of context under its
 * causes (shared/alert-text.ts, splitReasons). It names the bound that was crossed, not the whole range
 * («47.0–58.6 %» next to the «47 % y 59 %» of the detail): «Cerca del límite de lo normal: tiempo en movimiento 58.9 %
 * (apenas sobre lo normal: hasta 58.6 %) y frecuencia cardiaca 76.7 lpm (apenas sobre lo normal: hasta 76.5 lpm).» The
 * decimals stay, so a value is never printed on its bound. Null without any. */
export function contextLine(reasons: AlertReason[]): string | null {
  if (!reasons.length) return null;
  const item = (r: AlertReason) => {
    const { unit, decimals } = reasonUnit(r);
    const [lo, hi] = r.normalRange;
    // The bound keeps the decimals it has, no more («47», not «47.0»); the value keeps those of the whole reason.
    const bound = (x: number) => num(x, Math.min(decimals, places(x)));
    const value = `${reasonLabel(r).toLowerCase()} ${num(r.value, decimals)} ${unit}`;
    if (r.code === "behavior_unusual") return `${value} (lo habitual: hasta el ${bound(hi)} %)`;
    return r.value > hi ? `${value} (apenas sobre lo normal: hasta ${bound(hi)} ${unit})`
      : r.value < lo ? `${value} (apenas bajo lo normal: desde ${bound(lo)} ${unit})`
        : `${value} (normal: ${bound(lo)}–${bound(hi)} ${unit})`;
  };
  return `Cerca del límite de lo normal: ${namesText(reasons.map(item))}.`;
}

// ── Notes shared by the owner screens ───────────────────────────────────────────────────────────

/** What an amber point on a chart means. */
export const marksNote = (dogName: string) =>
  `Un punto «Fuera de lo normal» marca un momento en que la línea oscura salió de lo normal para ${dogName}. Si dura poco, no genera una alerta.`;

/** The owner's note on the demonstration temperature; the full method goes in the vet view. */
export const DEMO_TEMP_NOTE = "Temperatura de demostración: los datos de temperatura de esta etapa no son de sensores reales.";

/** Data of a simulation faster than real time carry hours later than now. A CSV with hours ahead
 * of the clock is the owner's file, not a demonstration, so the note and the tag follow the dog's source
 * (dogs.status.lastSource). */
export type DataSource = "simulator" | "csv" | null | undefined;
export const aheadNote = (source: DataSource) => source === "csv"
  ? "Horas del archivo: los datos que cargaste tú traen horas posteriores a la hora en que llegaron, y se muestran tal como vienen en el archivo."
  : "Tiempo simulado: esta demostración avanza más rápido que el reloj, por eso sus horas pueden ser posteriores a la hora actual.";
/** The tag after a time ahead of the clock: «(tiempo simulado)» or «(hora del archivo)». */
export const aheadTag = (source: DataSource) => (source === "csv" ? "hora del archivo" : "tiempo simulado");

// ── Data sources (Vista para el veterinario and research tools) ───────────────────────────────────────────

/** Every source by its citation, never by a company's name. */
export const DATASET_TEXT: Record<string, string> = {
  vehkaoja2022: "Vehkaoja et al. (2022)", invoxia2023: "dataset público de frecuencia cardiaca (2023)", physiozoo2018: "PhysioZoo",
  rri23dogs: "23 perros (intervalos RR)", uwbdvs2024: "UWB-DVS", synthetic: "serie sintética de demostración", csv: "carga de CSV",
};
export const datasetText = (id: string | null | undefined) => (id ? DATASET_TEXT[id] ?? id : "—");

// ── Time ───────────────────────────────────────────────────────────────────────────────────────────────────

export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "menos de 1 minuto";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Keeps a time and its "a. m." / "p. m." on one line ("8:28 p." at the end of a line and "m." on the next reads badly). */
export const glueTime = (s: string) => s.replace(/(\d)\s+([ap])\.\s*m\./g, "$1\u00a0$2.\u00a0m.");

export const dateTimeText = (ms: number) => glueTime(new Date(ms).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }));

const calendarDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Whole calendar days from `ms` to `now` (0 = the same day), in local time. */
const daysAgo = (ms: number, now: number) => Math.round((calendarDay(now) - calendarDay(ms)) / 86_400_000);

/** "hoy a las 9:05 a. m.", "ayer a la 1:30 p. m." or the full date: when something happened, in words. */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms), ago = daysAgo(ms, now);
  if (ago !== 0 && ago !== 1) return dateTimeText(ms);
  const time = glueTime(d.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" }));
  return `${ago === 0 ? "hoy" : "ayer"} ${d.getHours() % 12 === 1 ? "a la" : "a las"} ${time}`;
}

/** The same, to follow a verb or a preposition: "Empezó hoy a las 9:05 a. m.", "desde el 2 oct. 2026, 9:05 a. m.". */
export function whenPhrase(ms: number, now = Date.now()): string {
  const w = whenText(ms, now);
  return /^(hoy|ayer)/.test(w) ? w : `el ${w}`;
}

/** Times on a chart axis in the 12-hour clock of the texts, compact: «a. m.» or «p. m.» only on
 * the first label and where it changes (crossing noon or midnight), so «10:54 p. m., 10:56, 10:58, 11:00». `seconds`
 * adds them (a few minutes of data); `weekday` puts the day before the time (a few days of data). */
export function axisTimeLabels(ts: number[], opts: { seconds?: boolean; weekday?: boolean } = {}): string[] {
  const f = new Intl.DateTimeFormat("es-PE", { hour: "numeric", minute: "2-digit", second: opts.seconds ? "2-digit" : undefined, hourCycle: "h12" });
  const day = new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric" });
  let prevPeriod = "", prevDay = "";
  return ts.map((t, i) => {
    const parts = f.formatToParts(t);
    const period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
    const time = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    const d = opts.weekday ? day.format(t) : "";
    const label = `${d ? `${d}, ` : ""}${time}${period && (i === 0 || period !== prevPeriod || d !== prevDay) ? `\u00a0${period.replace(/\s+/g, "\u00a0")}` : ""}`;
    prevPeriod = period; prevDay = d;
    return label;
  });
}

/** One time in the 12-hour clock of the texts, for a chart's tooltip: «10:54 p. m.», with seconds or the date. */
export function chartTimeText(t: number, opts: { seconds?: boolean; date?: boolean } = {}): string {
  const time = glueTime(new Date(t).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", second: opts.seconds ? "2-digit" : undefined, hourCycle: "h12" }));
  return opts.date ? `${new Date(t).toLocaleDateString("es-PE", { day: "numeric", month: "short" })}, ${time}` : time;
}

/** Ends a sentence with its period, unless it already ends with one ("… a las 5:20 p. m." does not get a second). */
export const endSentence = (s: string) => (s.endsWith(".") ? s : `${s}.`);

type Millis = { toMillis?: () => number } | null | undefined;
/** Data time of an alert's episode; alerts from before it only have the write time. */
export const alertStartMs = (a: { startedAt?: Millis; createdAt?: Millis }) => a.startedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;

/** Whether an alert's episode is going on now, so its title is in the present. No end yet and
 * the engine wrote to it (updatedAt, with every block of the episode) within STALE_AFTER_MS: an alert whose data stopped
 * arriving has no end either, and it is not said to continue. */
export const alertGoing = (a: { endedAt?: Millis; updatedAt?: Millis; createdAt?: Millis }, now = Date.now()) =>
  !a.endedAt && now - (a.updatedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0) < STALE_AFTER_MS;

/** Heading of a day in a list: "Hoy", "Ayer" or "jueves, 1 de octubre de 2026". */
export function dayHeading(ms: number, now = Date.now()): string {
  const ago = daysAgo(ms, now);
  if (ago === 0) return "Hoy";
  if (ago === 1) return "Ayer";
  const t = new Date(ms).toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export const dateText = (ms: number) => new Date(ms).toLocaleDateString("es-PE", { dateStyle: "medium" });

/** Subtitle of a trend chart: the period asked, or, when its data start well inside it, the stretch that has data
 * (the axis spans the data, so "las últimas 24 h" over 40 minutes of data would misread the chart). */
export function coverageText(rangeText: string, periodStart: number, end: number, first: number | null, slackMs: number): string {
  if (first == null || first - periodStart <= slackMs) return `Datos de ${rangeText}, hasta el ${dateTimeText(end)}`;
  const hm = (ms: number) => glueTime(new Date(ms).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" }));
  return calendarDay(first) === calendarDay(end)
    ? `Solo hay datos del ${dateText(first)}, de ${hm(first)} a ${hm(end)}`
    : `Solo hay datos desde el ${dateTimeText(first)} hasta el ${dateTimeText(end)}`;
}

export function ageText(birthDate: string | null | undefined, now = new Date()): string | null {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  let y = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) y--;
  return y <= 0 ? "menos de 1 año" : y === 1 ? "1 año" : `${y} años`;
}

// ── Learning period of a new dog ──────────────────────────────────────────────────────

/** Where a dog is in its learning period: stage 1 (what is normal: heart, temperature and movement by rule) or 2 (how it
 * moves, with the behavioral model), the share of the stage, the data time left and the whole stage. Null when the
 * Function is not learning its baseline. `minBlocks` is config/fusion.baseline.minBlocks (blocks of 10 s per stage). */
export interface LearningInfo { stage: 1 | 2; pct: number; leftMs: number; stageMs: number }
export function learningInfo(progress: { stage: "initial" | "model"; share: number } | null | undefined, minBlocks: number): LearningInfo | null {
  if (!progress) return null;
  const share = Math.min(1, Math.max(0, progress.share));
  const stageMs = minBlocks * 10_000;
  return { stage: progress.stage === "initial" ? 1 : 2, pct: share > 0 ? Math.max(1, Math.round(100 * share)) : 0, leftMs: Math.round((1 - share) * stageMs), stageMs };
}

/** How long a «learned» notice stays on the dog's card and detail after the Function wrote its baseline. */
export const LEARNED_NOTICE_MS = 24 * 3_600_000;

/** The notice when the Function finished learning a dog's baseline, for
 * LEARNED_NOTICE_MS: «basic» after stage 1 (its activity is still the rule's: from then on the dog is compared with its
 * own normal pattern while stage 2 refines its movement), «final» after stage 2 (the activity of the behavioral model).
 * Never for a baseline the simulator computed. */
export function learnedNotice(baseline: { origin?: string; activitySource?: string; computedAt?: { toMillis?: () => number } | null } | null | undefined,
  now = Date.now()): "basic" | "final" | null {
  const at = baseline?.computedAt?.toMillis?.();
  if (baseline?.origin !== "function" || at == null || now - at > LEARNED_NOTICE_MS || now < at - 60_000) return null;
  return (baseline.activitySource ?? "rules") === "rules" ? "basic" : "final";
}
