/**
 * Plain-language layer of the owner app: a phrase per dog, friendly vitals, alert titles
 * and "Qué puedes hacer". Wording rules: no diagnosis, no alarm, "se desvía de su patrón normal", and no
 * gendered adjectives about the dog unless its sex is known. The thresholds are those of the engine and config/fusion.
 */
import { ACTIVITY_SD_FLOOR, HR_SD_FLOOR, normalBand, type AlertReason, type Baseline, type Behavior, type DogStatus, type FusionConfig } from "@shared/types";
import { primaryReason } from "@shared/alert-text";

export type Dev = "low" | "normal" | "high" | "unknown";
export interface Friendly { dev: Dev; label: string; detail: string | null }
type Cfg = Pick<FusionConfig, "baselineSigma" | "tempRange" | "tempMaxDeviation">;
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

export function activityFriendly(ratio: number | null | undefined, b: BaselineLike, cfg: Cfg): Friendly {
  const dev = devOf(ratio, activityBand(b, cfg));
  const detail = ratio == null ? null : `${num(100 * ratio)} % del tiempo en movimiento`;
  const label = { low: "Menos que de costumbre", normal: "Como de costumbre", high: "Más que de costumbre", unknown: ratio == null ? "Sin datos" : "Sin referencia todavía" }[dev];
  return { dev, label, detail };
}

export function heartFriendly(hr: number | null | undefined, b: BaselineLike, cfg: Cfg): Friendly {
  const dev = devOf(hr, hrBand(b, cfg));
  const label = { low: "Más lento de lo habitual", normal: "Normal", high: "Más rápido de lo habitual", unknown: hr == null ? "Sin datos" : "Sin referencia todavía" }[dev];
  return { dev, label, detail: hr == null ? null : `${num(hr)} lpm` };
}

export function tempFriendly(t: number | null | undefined, b: BaselineLike, cfg: Cfg): Friendly {
  let dev: Dev = t == null ? "unknown" : t < cfg.tempRange[0] ? "low" : t > cfg.tempRange[1] ? "high" : "normal";
  // Inside the reference range but far from its own usual value also counts.
  if (dev === "normal" && t != null && b?.tempMean != null && Math.abs(t - b.tempMean) > cfg.tempMaxDeviation) dev = t > b.tempMean ? "high" : "low";
  const label = { low: "Más baja de lo normal", normal: "Normal", high: "Más alta de lo normal", unknown: "Sin datos" }[dev];
  return { dev, label, detail: t == null ? null : `${num(t, 1)} °C` };
}

export interface DogSummary { phrase: string; activity: Friendly; heart: Friendly; temp: Friendly }

/** The one-line answer to "¿está bien mi perro?" plus the three friendly vitals of the Inicio card. `reasons` are those
 * of the dog's open alert, if any: they say what lowered the level when no vital is out of its band. */
export function describeDog(status: DogStatus<unknown> | null | undefined, b: BaselineLike, cfg: Cfg, reasons?: AlertReason[] | null): DogSummary {
  const activity = activityFriendly(status?.lastActivityRatio, b, cfg);
  const heart = heartFriendly(status?.lastHr, b, cfg);
  const temp = tempFriendly(status?.lastTemp, b, cfg);
  let phrase: string;
  if (!status) phrase = "Todavía no hay datos.";
  else if (temp.dev === "high") phrase = "Su temperatura está más alta de lo normal.";
  else if (temp.dev === "low") phrase = "Su temperatura está más baja de lo normal.";
  // Without a baseline nothing is "habitual" yet; only the reference ranges apply.
  else if (!b) phrase = "Estamos aprendiendo su patrón normal. Mientras tanto, solo se revisan los rangos de referencia.";
  else if (heart.dev === "high") phrase = "Su corazón late más rápido de lo habitual.";
  else if (heart.dev === "low") phrase = "Su corazón late más lento de lo habitual.";
  else if (activity.dev === "low") phrase = "Se está moviendo menos de lo habitual.";
  else if (activity.dev === "high") phrase = "Se está moviendo más de lo habitual.";
  else if (status.level !== "green") {
    // No vital is out of its band: the level dropped for the shape of the heart rate (autoencoder), for unusual
    // movements (novelty) or for a deviation inside the band. Name it only when an alert says which.
    const code = reasons ? primaryReason(reasons)?.code : undefined;
    phrase = code === "hr_pattern" ? "Su frecuencia cardiaca tuvo un patrón poco habitual en el último minuto."
      : code === "behavior_unusual" ? "Se movió de una forma poco habitual en los últimos minutos."
        : "Algo se alejó un poco de su patrón normal en los últimos minutos.";
  } else phrase = "Todo en orden: se mueve y descansa como de costumbre.";
  return { phrase, activity, heart, temp };
}

/** "Luna", "Luna y Toby", "Bruno, Luna y Toby". */
export function namesText(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** A dog for the Inicio summary: `stale` when its newest data are old (not its current state), `openAlert` when it has
 * an alert still to review. */
type DogLevel = { name: string; level: DogStatus<unknown>["level"] | null; learning?: boolean; stale?: boolean; openAlert?: boolean };
const LEVEL_ORDER = { red: 0, amber: 1, green: 2 } as const;

/** Inicio order: the dogs that need a look first (Revisar, Atención), then the rest, then those without data; by name. */
export function byAttention<T extends DogLevel>(dogs: T[]): T[] {
  const rank = (d: DogLevel) => (d.level ? LEVEL_ORDER[d.level] : 3);
  return [...dogs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "es"));
}

/** One sentence above the Inicio cards: how the owner's dogs are, the ones that need a look first. Null without data.
 * A dog still learning its normal pattern is never said to be "within its normal pattern"; a
 * dog whose data stopped is not described in the present; and nothing reads "Todo en orden" while an alert waits. */
export function homeSummary(dogs: DogLevel[]): string | null {
  const withData = byAttention(dogs.filter((d) => d.level));
  if (!withData.length) return null;
  const current = withData.filter((d) => !d.stale);
  const of = (l: string) => current.filter((d) => d.level === l && !(l === "green" && d.learning)).map((d) => d.name);
  const red = of("red"), amber = of("amber"), green = of("green");
  const learning = current.filter((d) => d.level === "green" && d.learning).map((d) => d.name);
  const withAlert = withData.filter((d) => d.openAlert).map((d) => d.name);
  const stale = withData.filter((d) => d.stale).map((d) => d.name);
  const flagged = red.length + amber.length;
  // A dog already named above for its level needs no second sentence for its alert (its card shows the banner).
  const alertOnly = withAlert.filter((n) => !red.includes(n) && !amber.includes(n));
  const parts: string[] = [];
  if (red.length) parts.push(`${namesText(red)} ${red.length > 1 ? "se alejaron" : "se alejó"} de su patrón normal; revisa cómo ${red.length > 1 ? "están" : "está"}.`);
  if (amber.length) parts.push(`${namesText(amber)} ${amber.length > 1 ? "tienen" : "tiene"} un cambio leve.`);
  if (!flagged && !withAlert.length) {
    if (green.length === 1) parts.push(`${green[0]} está dentro de su patrón normal.`);
    else if (green.length > 1) parts.push(`Todo en orden: tus ${green.length} perros están dentro de su patrón normal.`);
  } else if (green.length > 3) parts.push(flagged ? `Los otros ${green.length} están como de costumbre.` : `Tus ${green.length} perros están como de costumbre.`);
  else if (green.length) parts.push(`${namesText(green)} ${green.length > 1 ? "están" : "está"} como de costumbre.`);
  if (alertOnly.length) parts.push(`${namesText(alertOnly)} ${alertOnly.length > 1 ? "tienen alertas nuevas" : "tiene una alerta nueva"}.`);
  if (stale.length) parts.push(`No recibimos datos recientes de ${namesText(stale)}.`);
  if (learning.length) parts.push(`Estamos aprendiendo el patrón normal de ${namesText(learning)}.`);
  return parts.join(" ");
}

const NOW_TEXT: Record<Behavior, [string, string]> = {
  sit: ["Sentado", "Sentada"], stand: ["Parado", "Parada"], lie: ["Echado", "Echada"],
  trot: ["Trotando", "Trotando"], walk: ["Caminando", "Caminando"], play: ["Jugando", "Jugando"], sniff: ["Olfateando", "Olfateando"],
};
/** Current behavior, agreeing with the dog's sex when it is known. */
export const behaviorNow = (b: Behavior, sex: Sex) => NOW_TEXT[b][sex === "female" ? 1 : 0];

export const BEHAVIOR_LABEL: Record<Behavior, string> = {
  sit: "Sentarse", stand: "Pararse", lie: "Echarse", trot: "Trotar", walk: "Caminar", play: "Jugar", sniff: "Olfatear",
};

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────

// Titles live in shared/alert-text.ts: the Function uses them for push notifications.
export { alertTitle, primaryReason } from "@shared/alert-text";

/** "Qué puedes hacer": observation steps only, never a diagnosis or a treatment. An episode that
 * ended more than a day ago is not something to watch "durante las próximas horas". */
export function whatToDo(reasons: AlertReason[], dogName: string, cfg: Pick<FusionConfig, "tempRange">,
  opts: { endedAtMs?: number | null; now?: number } = {}): string[] {
  const has = (c: AlertReason["component"]) => reasons.some((r) => r.component === c);
  const old = opts.endedAtMs != null && (opts.now ?? Date.now()) - opts.endedAtMs > 86_400_000;
  const out = [old ? "Fíjate si el cambio vuelve a aparecer." : `Observa a ${dogName} durante las próximas horas.`];
  if (has("temperature")) {
    out.push(`Si puedes, mide su temperatura con un termómetro. Si sigue fuera de ${num(cfg.tempRange[0], 1)}–${num(cfg.tempRange[1], 1)} °C, consulta a tu veterinario.`);
  }
  if (has("heart_rate")) out.push("Observa su respiración mientras descansa: si la notas agitada o el aviso se repite, consulta a tu veterinario.");
  if (has("behavior")) out.push("Fíjate si come, bebe y juega como siempre, y si le cuesta moverse.");
  out.push("Si notas otros cambios o el aviso se repite, consulta a tu veterinario y muéstrale la Vista para el veterinario.");
  return out;
}

export const COMPONENT_LABEL: Record<AlertReason["component"], string> = {
  behavior: "Actividad y conducta", heart_rate: "Frecuencia cardiaca", temperature: "Temperatura",
};

/** Unit and decimals of a reason's value, from its code. */
export function reasonUnit(r: AlertReason): { unit: string; decimals: number } {
  if (r.component === "temperature") return { unit: "°C", decimals: 1 };
  if (r.component === "heart_rate") return { unit: "lpm", decimals: 0 };
  return { unit: "%", decimals: r.code === "behavior_unusual" && !Number.isInteger(r.value) ? 1 : 0 };
}

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

/** Ends a sentence with its period, unless it already ends with one ("… a las 5:20 p. m." does not get a second). */
export const endSentence = (s: string) => (s.endsWith(".") ? s : `${s}.`);

type Millis = { toMillis?: () => number } | null | undefined;
/** Data time of an alert's episode; alerts from before it only have the write time. */
export const alertStartMs = (a: { startedAt?: Millis; createdAt?: Millis }) => a.startedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;

/** Heading of a day in a list: "Hoy", "Ayer" or "jueves, 1 de octubre de 2026". */
export function dayHeading(ms: number, now = Date.now()): string {
  const ago = daysAgo(ms, now);
  if (ago === 0) return "Hoy";
  if (ago === 1) return "Ayer";
  const t = new Date(ms).toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export const timeText = (ms: number) => glueTime(new Date(ms).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }));
export const dateText = (ms: number) => new Date(ms).toLocaleDateString("es-PE", { dateStyle: "medium" });

export function ageText(birthDate: string | null | undefined, now = new Date()): string | null {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  let y = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) y--;
  return y <= 0 ? "menos de 1 año" : y === 1 ? "1 año" : `${y} años`;
}
