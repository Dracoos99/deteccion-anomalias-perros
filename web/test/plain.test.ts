import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type AlertReason, type DogStatus } from "../../shared/types";
import {
  DATASET_TEXT, ORDER_HOLD_MS, SCORE_HOLD_MS, activityFriendly, aheadNote, aheadTag, alertTitle, attentionOrder, attentionRank, axisTimeLabels, behaviorNow, byAttention,
  chartTimeText, contextLine, dayHeading, datasetText, describeDog, durationText, endSentence, heartFar, heartFriendly, homeSummary, hrBand, coverageText, glueTime,
  isLearning, lastValue, namesText, orderReasons, primaryReason, reasonLabel, reasonRangeText, reasonUnit, scoreNote, shownScore, splitReasons, steadyScore,
  tempFriendly, titleReason, whatToDo, whenPhrase, whenText,
} from "../src/lib/plain";

const cfg = DEFAULT_FUSION_CONFIG;
const baseline = { activeRatioMean: 0.35, activeRatioStd: 0.08, hrMean: 70, hrStd: 5, tempMean: 38.6 };
const status = (over: Partial<DogStatus<unknown>> = {}): DogStatus<unknown> => ({
  healthScore: 92, level: "green", lastBehavior: "walk", lastHr: 72, lastTemp: 38.7, openAlerts: 0, lastActivityRatio: 0.36,
  updatedAt: null, ...over,
});
const reason = (component: AlertReason["component"], code: string): AlertReason =>
  ({ component, code, value: 1, normalRange: [0, 1], message: "" });

describe("friendly vitals", () => {
  it("uses the dog's own band (baseline ± 2σ) for heart rate and movement", () => {
    expect(hrBand(baseline, cfg)).toEqual([60, 80]);
    expect(heartFriendly(85, baseline, cfg)).toMatchObject({ dev: "high", label: "Más rápido de lo habitual", detail: "85 lpm" });
    expect(heartFriendly(58, baseline, cfg).dev).toBe("low");
    expect(activityFriendly(0.1, baseline, cfg)).toMatchObject({ dev: "low", label: "Menos que de costumbre" });
    expect(activityFriendly(0.4, baseline, cfg).label).toBe("Como de costumbre");
  });
  it("judges temperature against the reference range and its usual value", () => {
    expect(tempFriendly(40.1, baseline, cfg).dev).toBe("high");
    expect(tempFriendly(37.5, baseline, cfg).dev).toBe("low");
    expect(tempFriendly(38.9, baseline, cfg).dev).toBe("normal");
    expect(tempFriendly(39.5, { ...baseline, tempMean: 38.2 }, cfg).dev).toBe("high"); // 1.3 °C above its usual value
  });
  it("says so when there is no baseline or no data yet", () => {
    expect(heartFriendly(72, null, cfg).label).toBe("Sin referencia todavía");
    expect(heartFriendly(null, baseline, cfg).label).toBe("Sin datos");
  });
});

describe("describeDog: the level shown to the owner", () => {
  it("is never «Todo normal» with the temperature out of its range, an alert going on or low movement", () => {
    const green = { level: "green" as const, healthScore: 86, stableLevel: "green" as const, stableHealthScore: 86 };
    expect(describeDog(status({ ...green }), baseline, cfg).level).toBe("green");
    const fever = describeDog(status({ ...green, lastTemp: 40.2 }), baseline, cfg);
    expect(fever.level).toBe("amber");
    expect(fever.levelNote).toMatch(/temperatura/);
    const going = describeDog(status({ ...green }), baseline, cfg, null, true);
    expect(going.level).toBe("amber");
    expect(going.levelNote).toMatch(/alerta en curso/);
    // A red level stays red, and a score already in «Atención» needs no note.
    expect(describeDog(status({ level: "red", healthScore: 40, stableLevel: "red", stableHealthScore: 40, lastTemp: 40.2 }), baseline, cfg).level).toBe("red");
    expect(describeDog(status({ level: "amber", healthScore: 70, stableLevel: "amber", stableHealthScore: 70, lastTemp: 40.2 }), baseline, cfg).levelNote).toBeNull();
  });
});

describe("describeDog", () => {
  it("answers in plain language, temperature first, without diagnosing", () => {
    expect(describeDog(status(), baseline, cfg).phrase).toBe("Todo en orden: se mueve y descansa como de costumbre.");
    expect(describeDog(status({ lastTemp: 40.2, lastHr: 90 }), baseline, cfg).phrase).toBe("Su temperatura está más alta de lo normal.");
    expect(describeDog(status({ lastHr: 90, level: "amber" }), baseline, cfg).phrase).toBe("Su corazón late más rápido de lo habitual.");
    expect(describeDog(status({ lastActivityRatio: 0.05, level: "red" }), baseline, cfg).phrase).toBe("Se está moviendo menos de lo habitual.");
    // Just out of its band while the score stays at "Todo normal": "un poco", so tag and phrase agree.
    expect(describeDog(status({ lastHr: 90 }), baseline, cfg).phrase).toBe("Su corazón late un poco más rápido de lo habitual.");
    expect(describeDog(status({ lastActivityRatio: 0.05 }), baseline, cfg).phrase).toBe("Se está moviendo menos de lo habitual.");
    // Amber with every vital inside its band: neutral unless the open alert says what lowered it.
    expect(describeDog(status({ level: "amber" }), baseline, cfg).phrase).toBe("Algo se alejó un poco de su patrón normal en los últimos minutos.");
    expect(describeDog(status({ level: "amber" }), baseline, cfg, [reason("heart_rate", "hr_pattern")]).phrase)
      .toBe("Su frecuencia cardiaca tuvo un patrón poco habitual en el último minuto.");
    expect(describeDog(status({ level: "amber" }), baseline, cfg, [reason("behavior", "behavior_unusual")]).phrase)
      .toBe("Se movió de una forma poco habitual en los últimos minutos.");
    expect(describeDog(null, baseline, cfg).phrase).toBe("Todavía no hay datos.");
    expect(describeDog(status(), null, cfg).phrase).toContain("aprendiendo su patrón normal");
    expect(describeDog(status({ lastTemp: 40.2 }), null, cfg).phrase).toBe("Su temperatura está más alta de lo normal.");
    const all = ["enferm", "diagnóstico", "peligro", "grave"];
    for (const s of [status(), status({ lastTemp: 40.2 }), status({ level: "red" })]) {
      expect(all.some((w) => describeDog(s, baseline, cfg).phrase.toLowerCase().includes(w))).toBe(false);
    }
  });
  it("agrees the current behavior with the dog's sex", () => {
    expect(behaviorNow("lie", "female")).toBe("Echada");
    expect(behaviorNow("lie", "male")).toBe("Echado");
    expect(behaviorNow("walk", "female")).toBe("Caminando");
  });
});

describe("alerts in plain language", () => {
  it("names the alert by its most relevant variable", () => {
    const rs = [reason("behavior", "behavior_unusual"), reason("heart_rate", "hr_high"), reason("temperature", "temp_high")];
    expect(primaryReason(rs)?.code).toBe("temp_high");
    expect(alertTitle(rs)).toBe("Su temperatura estuvo alta");
    expect(alertTitle([reason("heart_rate", "hr_low")])).toBe("Su frecuencia cardiaca estuvo baja");
    expect(alertTitle([reason("heart_rate", "hr_pattern")])).toBe("Su frecuencia cardiaca tuvo un patrón poco habitual");
  });
  it("names it by a variable out of its band before the shape of the heart rate or unusual movements", () => {
    // An activity drop with a heart rate inside its band whose shape the autoencoder flagged.
    expect(alertTitle([reason("heart_rate", "hr_pattern"), reason("behavior", "activity_low")])).toBe("Se movió menos de lo habitual");
    expect(primaryReason([reason("behavior", "behavior_unusual"), reason("heart_rate", "hr_pattern")])?.code).toBe("hr_pattern");
    expect(primaryReason([reason("heart_rate", "hr_pattern"), reason("temperature", "temp_deviation")])?.code).toBe("temp_deviation");
  });
  it("suggests observation steps for each variable and always the vet view", () => {
    const steps = whatToDo([reason("temperature", "temp_high")], "Toby", cfg);
    expect(steps[0]).toBe("Observa a Toby durante las próximas horas.");
    expect(steps.some((s) => s.includes("termómetro") && s.includes("37.7–39.5"))).toBe(true);
    expect(steps.at(-1)).toContain("Vista para el veterinario");
  });
  it("does not ask to watch the next hours for an episode that ended days ago", () => {
    const now = Date.UTC(2026, 9, 3, 12);
    expect(whatToDo([reason("heart_rate", "hr_high")], "Toby", cfg, { endedAtMs: now - 2 * 86_400_000, now })[0]).toBe("Fíjate si el cambio vuelve a aparecer.");
    expect(whatToDo([reason("heart_rate", "hr_high")], "Toby", cfg, { endedAtMs: now - 3_600_000, now })[0]).toBe("Observa a Toby durante las próximas horas.");
  });
  it("writes durations for people", () => {
    expect(durationText(20_000)).toBe("menos de 1 minuto");
    expect(durationText(15 * 60_000)).toBe("15 min");
    expect(durationText(135 * 60_000)).toBe("2 h 15 min");
  });
});

describe("stable level, learning and what to do", () => {
  it("shows the stable level and score when the Function wrote them, the instantaneous ones otherwise", () => {
    expect(shownScore(status({ healthScore: 68, level: "amber", stableHealthScore: 91, stableLevel: "green" }))).toEqual({ level: "green", score: 91 });
    expect(shownScore(status({ healthScore: 68, level: "amber" }))).toEqual({ level: "amber", score: 68 });
    expect(shownScore(null)).toEqual({ level: null, score: null });
    // An alert episode still going never shows «Todo normal», even with a score of 80 or more.
    expect(shownScore(status({ healthScore: 80, level: "green" }), true)).toEqual({ level: "amber", score: 80 });
    expect(shownScore(status({ healthScore: 80, level: "green" }), false)).toEqual({ level: "green", score: 80 });
    expect(shownScore(status({ healthScore: 40, level: "red" }), true)).toEqual({ level: "red", score: 40 });
    // The phrase agrees with the level shown: «un poco» while the stable level is «Todo normal».
    expect(describeDog(status({ lastHr: 90, level: "amber", stableLevel: "green" }), baseline, cfg).phrase).toBe("Su corazón late un poco más rápido de lo habitual.");
  });
  it("is learning, not «Todo normal», while the dog has no normal pattern", () => {
    expect(isLearning(status(), null)).toBe(true);
    expect(isLearning(status(), baseline)).toBe(false);
    expect(isLearning(status({ level: "amber" }), null)).toBe(false);   // a temperature out of range still shows its level
    expect(isLearning(null, null)).toBe(false);
  });
  it("says what to do when «Atención» or «Revisar» has no alert yet, and nothing when an alert explains it", () => {
    // Never «no hace falta hacer nada»; without a known cause, a look in the next minutes.
    expect(describeDog(status({ level: "amber" }), baseline, cfg).todo).toBe("Fíjate cómo está en los próximos minutos.");
    expect(describeDog(status({ level: "red" }), baseline, cfg).todo).toMatch(/^Fíjate cómo está/);
    expect(describeDog(status({ level: "amber" }), baseline, cfg, [reason("heart_rate", "hr_high")]).todo).toBeNull();
    expect(describeDog(status(), baseline, cfg).todo).toBeNull();
  });
  it("names the span of the movement average apart from the posture of the moment", () => {
    expect(activityFriendly(0.59, baseline, cfg).detail).toBe("Últimos 20 min: 59 % en movimiento");
  });
  it("prints a reason with the decimals the engine stored, so it never sits on its bound", () => {
    const r = (value: number, normalRange: [number, number], component: AlertReason["component"] = "behavior"): AlertReason =>
      ({ component, code: "activity_low", value, normalRange, message: "" });
    expect(reasonUnit(r(46.7, [46.8, 58.9])).decimals).toBe(1);
    expect(reasonUnit(r(40, [47, 59])).decimals).toBe(0);
    expect(reasonUnit(r(40.3, [37.7, 39.5], "temperature"))).toEqual({ unit: "°C", decimals: 1 });
    expect(reasonUnit(r(39.54, [37.7, 39.5], "temperature")).decimals).toBe(2);
  });
  it("calls an alert an alert, and keeps «aviso» for the notifications", () => {
    const steps = whatToDo([reason("heart_rate", "hr_high"), reason("behavior", "activity_low")], "Toby", cfg).join(" ");
    expect(steps).not.toMatch(/aviso/i);
    expect(steps).toContain("la alerta se repite");
  });
  it("names every data source by its citation, never by a company", () => {
    expect(datasetText("invoxia2023")).toBe("dataset público de frecuencia cardiaca (2023)");
    expect(Object.values(DATASET_TEXT).join(" ")).not.toMatch(/invoxia/i);
  });
});

describe("Inicio summary and order", () => {
  const dogs = [
    { name: "Toby", level: "green" as const }, { name: "Rocky", level: "red" as const },
    { name: "Luna", level: "amber" as const }, { name: "Mora", level: null },
  ];
  it("puts the dogs that need a look first, then the rest, then those without data", () => {
    expect(byAttention(dogs).map((d) => d.name)).toEqual(["Rocky", "Luna", "Toby", "Mora"]);
  });
  it("puts a dog with a new alert before the others in «Todo normal», and one still learning after them", () => {
    const more = [
      { name: "Bruno", level: "green" as const }, { name: "Rocky", level: "green" as const, openAlert: true },
      { name: "Nina", level: "green" as const, learning: true }, { name: "Luna", level: "amber" as const }, { name: "Max", level: null },
    ];
    expect(byAttention(more).map((d) => d.name)).toEqual(["Luna", "Rocky", "Bruno", "Nina", "Max"]);
  });
  it("says first which dogs moved away from their normal pattern, without gendered words", () => {
    // The dog without data is said apart.
    expect(homeSummary(dogs)).toBe("Rocky se alejó de su patrón normal; revisa cómo está. Luna tiene un cambio leve. Toby está como de costumbre. Todavía no hay datos de Mora.");
    expect(homeSummary([{ name: "Toby", level: "green" }])).toBe("Toby está dentro de su patrón normal.");
    expect(homeSummary([{ name: "Toby", level: "green" }, { name: "Luna", level: "green" }])).toBe("Todo en orden: tus 2 perros están dentro de su patrón normal.");
    expect(homeSummary([{ name: "Mora", level: null }])).toBeNull();
    const many = ["Bruno", "Coco", "Kira", "Max"].map((name) => ({ name, level: "green" as const }));
    expect(homeSummary([...many, { name: "Nala", level: "red" }, { name: "Simba", level: "red" }]))
      .toBe("Nala y Simba se alejaron de su patrón normal; revisa cómo están. Los otros 4 están como de costumbre.");
    expect(namesText(["Bruno", "Coco", "Kira"])).toBe("Bruno, Coco y Kira");
    // A dog without a baseline is learning, never "within its normal pattern".
    expect(homeSummary([{ name: "Pelusa", level: "green", learning: true }])).toBe("Estamos aprendiendo el patrón normal de Pelusa.");
    expect(homeSummary([{ name: "Toby", level: "green" }, { name: "Pelusa", level: "green", learning: true }]))
      .toBe("Toby está dentro de su patrón normal. Estamos aprendiendo el patrón normal de Pelusa.");
  });
  it("never says «Todo en orden» while an alert waits, and does not describe old data in the present", () => {
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Rocky", level: "green", openAlert: true }, { name: "Toby", level: "green" }]))
      .toBe("Luna, Rocky y Toby están como de costumbre. Rocky tiene una alerta nueva.");
    expect(homeSummary([{ name: "Bartolomé", level: "green", stale: true }])).toBe("No recibimos datos recientes de Bartolomé.");
    expect(homeSummary([{ name: "Toby", level: "green" }, { name: "Bartolomé", level: "red", stale: true }]))
      .toBe("Toby está dentro de su patrón normal. No recibimos datos recientes de Bartolomé.");
    // A dog named for its level is not named again for its alert.
    expect(homeSummary([{ name: "Rocky", level: "red", openAlert: true }, { name: "Luna", level: "green" }]))
      .toBe("Rocky se alejó de su patrón normal; revisa cómo está. Luna está como de costumbre.");
  });
});

describe(" of the alert's name, the phrase and what to do", () => {
  const r = (component: AlertReason["component"], code: string, value: number, normalRange: [number, number]): AlertReason =>
    ({ component, code, value, normalRange, message: "" });
  // Toby in: 20 % of movement against 52–64 % and 48 lpm against 49–87 lpm.
  const act = r("behavior", "activity_low", 20, [52, 64]), hrLow = r("heart_rate", "hr_low", 48, [49, 87]);
  const unusual = r("behavior", "behavior_unusual", 31, [0, 5]);

  it("names the alert by the variable furthest out of its band, not by a fixed order", () => {
    expect(primaryReason([hrLow, act])?.code).toBe("activity_low");
    expect(alertTitle([hrLow, act])).toBe("Se movió menos de lo habitual");
    // Shape-only reasons still come after a variable out of its band, even when their share is large.
    expect(primaryReason([unusual, hrLow])?.code).toBe("hr_low");
    // A fever of 40.2 °C (0.4 band widths) over a movement 0.2 points under its band.
    expect(primaryReason([r("behavior", "activity_low", 53.5, [53.7, 64.6]), r("temperature", "temp_high", 40.2, [37.7, 39.5])])?.code).toBe("temp_high");
  });
  it("keeps the name the engine fixed for the alert, and puts that cause first", () => {
    expect(alertTitle([hrLow, act], "hr_low")).toBe("Su frecuencia cardiaca estuvo baja");
    expect(titleReason([hrLow, act], "hr_low")?.code).toBe("hr_low");
    // A code no longer among the reasons falls back to the largest deviation.
    expect(titleReason([hrLow, act], "temp_high")?.code).toBe("activity_low");
    expect(orderReasons([hrLow, unusual, act]).map((x) => x.code)).toEqual(["activity_low", "hr_low", "behavior_unusual"]);
    expect(orderReasons([unusual, act, hrLow], "hr_low").map((x) => x.code)).toEqual(["hr_low", "activity_low", "behavior_unusual"]);
  });
  it("gives two causes of the same sensor two names and says the ceiling of unusual movements", () => {
    expect(reasonLabel(act)).toBe("Tiempo en movimiento");
    expect(reasonLabel(unusual)).toBe("Movimientos poco habituales");
    expect(reasonLabel(hrLow)).toBe("Frecuencia cardiaca");
    expect(reasonRangeText(act)).toBe("Normal: 52–64 %");
    expect(reasonRangeText(unusual)).toBe("Lo habitual: hasta el 5 %");
  });
  it("orders the phrase temperature, movement and heart, and names the alert going on", () => {
    // Movement (a 20-minute average) before a heart rate that goes in and out of its band.
    expect(describeDog(status({ lastHr: 58, lastActivityRatio: 0.05, level: "red" }), baseline, cfg).phrase).toBe("Se está moviendo menos de lo habitual.");
    // While an alert goes on, its main reason, in the present while it is still out of its band...
    const alert = { reasons: [hrLow, act], titleCode: "activity_low" };
    expect(describeDog(status({ lastHr: 58, lastActivityRatio: 0.05, level: "red" }), baseline, cfg, alert, true).phrase).toBe("Se está moviendo menos de lo habitual.");
    //...when it is back, the other reason of the alert that still is out of its band, what holds the level
    // now, not a variable that already calmed); and in the past only when none is.
    expect(describeDog(status({ lastHr: 58, level: "amber" }), baseline, cfg, alert, true).phrase).toBe("Su corazón late más lento de lo habitual.");
    expect(describeDog(status({ lastHr: 70, level: "amber" }), baseline, cfg, alert, true).phrase).toBe("Se movió menos de lo habitual en los últimos minutos.");
    // A fever that names its alert wins over the movement of the moment.
    const fever = { reasons: [r("temperature", "temp_high", 40.2, [37.7, 39.5]), act], titleCode: "temp_high" };
    expect(describeDog(status({ lastTemp: 40.1, lastActivityRatio: 0.05, level: "amber" }), baseline, cfg, fever, true).phrase).toBe("Su temperatura está más alta de lo normal.");
    // An alert that already ended does not drive the phrase: the present does.
    expect(describeDog(status(), baseline, cfg, alert, false).phrase).toBe("Todo en orden: se mueve y descansa como de costumbre.");
  });
  it("puts the vet first in «Revisar» and watching and measuring at rest in «Atención»", () => {
    const amber = whatToDo([act], "Toby", cfg, { severity: "amber" });
    expect(amber[0]).toBe("Observa a Toby durante las próximas horas.");
    const red = whatToDo([act, r("temperature", "temp_high", 40.2, [37.7, 39.5])], "Toby", cfg, { severity: "red" });
    // While the change goes on, the vet is the first step, not a condition.
    expect(red[0]).toBe("Consulta a tu veterinario y muéstrale la Vista para el veterinario.");
    expect(red.some((s) => s.includes("termómetro") && s.includes("reposo"))).toBe(true);
    expect(red.join(" ")).not.toContain("Observa a Toby durante las próximas horas");
    const now = Date.UTC(2026, 9, 3, 12);
    expect(whatToDo([act], "Toby", cfg, { severity: "red", endedAtMs: now - 2 * 86_400_000, now })[0]).toMatch(/^Si el cambio vuelve a aparecer, consulta/);
    for (const s of [...amber, ...red]) expect(/enferm|diagnóstic|grave|urgente|peligro/i.test(s)).toBe(false);
  });
  it("holds the shown Health Score while it drifts a point or two, never across a level cut", () => {
    const levels = cfg.levels;   // green 80, amber 60
    let s = steadyScore(null, 54, 0, levels);
    expect(s).toEqual({ score: 54, at: 0 });
    for (const [v, t] of [[55, 4_000], [54, 8_000], [55, 12_000]] as const) { s = steadyScore(s, v, t, levels); expect(s!.score).toBe(54); }
    expect(steadyScore(s, 57, 16_000, levels)!.score).toBe(57);                  // three points
    expect(steadyScore(s, 55, SCORE_HOLD_MS, levels)!.score).toBe(55);           // a minute later
    expect(steadyScore({ score: 61, at: 0 }, 59, 1_000, levels)!.score).toBe(59); // crosses into «Revisar»
    expect(steadyScore({ score: 80, at: 0 }, 79, 1_000, levels)!.score).toBe(79); // crosses into «Atención»
    expect(steadyScore(s, null, 20_000, levels)).toBeNull();
  });
});

describe(" of the Inicio summary", () => {
  it("says a dog whose new alert already ended is back to its usual, and does not count it twice", () => {
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Rocky", level: "green" }, { name: "Toby", level: "green", openAlert: true, alertEnded: true }]))
      .toBe("Toby tiene una alerta nueva que ya pasó; ahora está como de costumbre. Luna y Rocky están como de costumbre.");
  });
  it("counts with the real total, «los» for the research account, and the dogs without data apart", () => {
    const withData = ["Luna", "Max", "Rocky", "Toby"].map((name) => ({ name, level: "green" as const }));
    const without = ["Bruno", "Coco", "Kira", "Mora", "Nala", "Simba"].map((name) => ({ name, level: null }));
    expect(homeSummary([...withData, { name: "Nina", level: "green", learning: true }, ...without], { all: true }))
      .toBe("De los 11 perros, 4 están dentro de su patrón normal. Estamos aprendiendo el patrón normal de Nina. Todavía no hay datos de 6 perros.");
    expect(homeSummary(withData, { all: true })).toBe("Todo en orden: los 4 perros están dentro de su patrón normal.");
    expect(homeSummary([{ name: "Toby", level: "green" }, { name: "Luna", level: "green" }, { name: "Nina", level: null }]))
      .toBe("Luna y Toby están dentro de su patrón normal. Todavía no hay datos de Nina.");
  });
});

describe("times in words", () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  const sp = (x: string) => x.replace(/\s/g, " ");   // ICU puts no-break spaces before "a. m."
  it("says today or yesterday with the time, and the date otherwise", () => {
    expect(sp(whenText(new Date(2026, 9, 2, 9, 5).getTime(), now))).toBe("hoy a las 9:05 a. m.");
    expect(sp(whenText(new Date(2026, 9, 1, 13, 30).getTime(), now))).toBe("ayer a la 1:30 p. m.");
    expect(whenText(new Date(2026, 8, 28, 13, 30).getTime(), now)).toMatch(/^28 set\. 2026/);
    expect(whenPhrase(new Date(2026, 8, 28, 13, 30).getTime(), now)).toMatch(/^el 28 set\. 2026/);
  });
  it("says which stretch has data when it covers only part of the chart's period", () => {
    const end = new Date(2026, 9, 4, 10, 41).getTime();
    expect(sp(coverageText("las últimas 24 h", end - 86_400_000, end, end - 86_300_000, 180_000))).toBe("Datos de las últimas 24 h, hasta el 4 oct. 2026, 10:41 a. m.");
    expect(sp(coverageText("las últimas 24 h", end - 86_400_000, end, new Date(2026, 9, 4, 10, 3).getTime(), 180_000)))
      .toBe("Solo hay datos del 4 oct. 2026, de 10:03 a. m. a 10:41 a. m.");
    expect(sp(coverageText("los últimos 7 días", end - 7 * 86_400_000, end, new Date(2026, 9, 2, 8, 0).getTime(), 3_600_000)))
      .toBe("Solo hay datos desde el 2 oct. 2026, 8:00 a. m. hasta el 4 oct. 2026, 10:41 a. m.");
  });
  it("keeps a time and its «p. m.» on one line", () => {
    expect(glueTime("1 oct. 2026, 8:28 p. m.")).toBe("1 oct. 2026, 8:28 p. m.");
    expect(glueTime("9:05 a. m.")).toBe("9:05 a. m.");
  });
  it("ends a sentence after a time without a second period", () => {
    expect(endSentence("Revisada hoy a las 5:20 p. m.")).toBe("Revisada hoy a las 5:20 p. m.");
    expect(endSentence("Revisada")).toBe("Revisada.");
  });
  it("heads each day of the alert list", () => {
    expect(dayHeading(new Date(2026, 9, 2, 1).getTime(), now)).toBe("Hoy");
    expect(dayHeading(new Date(2026, 9, 1, 23).getTime(), now)).toBe("Ayer");
    expect(dayHeading(new Date(2026, 8, 29, 8).getTime(), now)).toBe("Martes, 29 de setiembre de 2026");
  });
});

describe(" of the heart rate in the level shown and what to do", () => {
  // baseline: heart rate 70 ± 5 lpm, band 60–80 (20 wide): «far» is over 110 or under 30.
  const green = { level: "green" as const, healthScore: 90, stableLevel: "green" as const, stableHealthScore: 90 };
  it("leaves a heart rate raised by play alone, and shows «Atención» when it is far from its band", () => {
    // Playing: +25 lpm over its usual 70 (95 lpm) is out of its band, «un poco», still «Todo normal».
    const play = describeDog(status({ ...green, lastHr: 95 }), baseline, cfg);
    expect(heartFar(95, baseline, cfg)).toBeNull();
    expect(play.level).toBe("green");
    expect(play.levelNote).toBeNull();
    expect(play.phrase).toBe("Su corazón late un poco más rápido de lo habitual.");
    // +60 lpm (130 lpm), beyond 1.5 band widths over its top: «Atención», with its note and its phrase.
    const tachy = describeDog(status({ ...green, lastHr: 130 }), baseline, cfg);
    expect(heartFar(130, baseline, cfg)).toBe("high");
    expect(tachy.level).toBe("amber");
    expect(tachy.levelNote).toBe("Atención porque su corazón late mucho más rápido de lo habitual, aunque el número esté sobre 80.");
    expect(tachy.phrase).toBe("Su corazón late mucho más rápido de lo habitual.");
    // The edge of the margin does not count yet; far below the band does; without a heart-rate baseline, nothing.
    expect(heartFar(110, baseline, cfg)).toBeNull();
    expect(heartFar(29, baseline, cfg)).toBe("low");
    expect(describeDog(status({ ...green, lastHr: 29 }), baseline, cfg).levelNote).toMatch(/mucho más lento/);
    expect(heartFar(130, null, cfg)).toBeNull();
    expect(heartFar(130, { ...baseline, hrMean: null, hrStd: null }, cfg)).toBeNull();
    // Rocky in: 132 lpm against 49–75.
    expect(heartFar(132, { ...baseline, hrMean: 62, hrStd: 6.5 }, cfg)).toBe("high");
    // A red level stays red.
    expect(describeDog(status({ level: "red", healthScore: 40, stableLevel: "red", stableHealthScore: 40, lastHr: 130 }), baseline, cfg).level).toBe("red");
  });
  it("names the far heart rate before the movement of the moment and agrees with the Inicio summary", () => {
    expect(describeDog(status({ ...green, lastHr: 130, lastActivityRatio: 0.6 }), baseline, cfg).phrase).toBe("Su corazón late mucho más rápido de lo habitual.");
    const level = (name: string, over: Partial<DogStatus<unknown>>) => ({ name, level: describeDog(status({ ...green, ...over }), baseline, cfg).level });
    expect(homeSummary([level("Luna", {}), level("Rocky", { lastHr: 135 }), level("Toby", {})])).toBe("Rocky tiene un cambio leve. Luna y Toby están como de costumbre.");
    expect(homeSummary([level("Luna", {}), level("Rocky", { lastHr: 95 }), level("Toby", {})])).toBe("Todo en orden: tus 3 perros están dentro de su patrón normal.");
  });
  it("says what to look at by the cause, and promises an alert only when a rule would open one", () => {
    const next = " Si el cambio sigue unos minutos, verás una alerta con los pasos a seguir.";
    expect(describeDog(status({ ...green, lastTemp: 40.6 }), baseline, cfg).todo).toBe(`Mide su temperatura cuando esté en reposo y fíjate cómo está.${next}`);
    // 1.2 °C over its usual value but inside the reference range: no rule opens an alert.
    expect(describeDog(status({ ...green, lastTemp: 39.4 }), { ...baseline, tempMean: 38.2 }, cfg).todo).toBe("Mide su temperatura cuando esté en reposo y fíjate cómo está.");
    expect(describeDog(status({ ...green, lastHr: 144 }), baseline, cfg).todo)
      .toBe(`Deja que descanse unos minutos, cuenta sus latidos con la mano sobre su pecho y fíjate cómo está.${next}`);
    // Low movement: the alert only with the low-activity rule (activityCriticalSigma, 2 in the deployed config).
    expect(describeDog(status({ ...green, lastActivityRatio: 0.1 }), baseline, cfg).todo).toBe("Fíjate cómo está y si come, bebe y juega como siempre.");
    expect(describeDog(status({ ...green, lastActivityRatio: 0.1 }), baseline, { ...cfg, activityCriticalSigma: 2 }).todo)
      .toBe(`Fíjate cómo está y si come, bebe y juega como siempre.${next}`);
    expect(describeDog(status({ level: "red", healthScore: 50, stableLevel: "red", stableHealthScore: 50 }), baseline, cfg).todo).toBe(`Fíjate cómo está en los próximos minutos.${next}`);
    for (const over of [{ lastTemp: 40.6 }, { lastHr: 144 }, { lastActivityRatio: 0.1 }, { level: "amber" as const, stableLevel: "amber" as const, stableHealthScore: 70 }]) {
      const todo = describeDog(status({ ...green, ...over }), baseline, cfg).todo!;
      expect(todo).not.toMatch(/no hace falta/i);
      expect(/enferm|diagnóstic|grave|urgente|peligro/i.test(todo)).toBe(false);
    }
  });
});

describe(" of two Health Scores, old data and the order of Inicio", () => {
  it("says that the figure of the state is the average of the last minutes", () => {
    expect(scoreNote(cfg)).toBe("Es el promedio de los últimos 5 minutos y resume qué tan cerca está de su patrón normal. No es una nota de salud.");
    expect(scoreNote({ stableTimeConstantS: 600 })).toMatch(/últimos 10 minutos/);
    expect(scoreNote({ stableTimeConstantS: 0 })).not.toMatch(/promedio/);
  });
  it("shows the vitals of data that stopped as their last values", () => {
    expect(lastValue(activityFriendly(0.61, baseline, cfg))).toEqual({ dev: "unknown", label: "Último dato", detail: "61 % en movimiento" });
    expect(lastValue(heartFriendly(130, baseline, cfg))).toEqual({ dev: "unknown", label: "Último dato", detail: "130 lpm" });
    expect(lastValue(heartFriendly(null, baseline, cfg))).toEqual({ dev: "unknown", label: "Sin datos", detail: null });
  });
  it("moves a dog that starts to need a look up at once, and back only after a while", () => {
    const t0 = 1_000_000;
    const lucia = (toby: "green" | "amber") => [
      { id: "luna", name: "Luna", level: "green" as const }, { id: "rocky", name: "Rocky", level: "green" as const }, { id: "toby", name: "Toby", level: toby },
    ];
    let r = attentionOrder(lucia("green"), new Map(), t0);
    expect(r.ids).toEqual(["luna", "rocky", "toby"]);
    // Toby's level rises a minute after the page opened: first at once (he stayed under Rocky in «Todo normal»).
    r = attentionOrder(lucia("amber"), r.held, t0 + 60_000);
    expect(r.ids).toEqual(["toby", "luna", "rocky"]);
    // Back to «Todo normal», he keeps his place for ORDER_HOLD_MS, so a level on a cut does not move the cards back and
    // forth (a return to «Atención» starts the wait again)...
    r = attentionOrder(lucia("green"), r.held, t0 + 70_000);
    expect(r.ids[0]).toBe("toby");
    r = attentionOrder(lucia("amber"), r.held, t0 + 80_000);
    r = attentionOrder(lucia("green"), r.held, t0 + 90_000);
    r = attentionOrder(lucia("green"), r.held, t0 + 90_000 + ORDER_HOLD_MS - 1);
    expect(r.ids[0]).toBe("toby");
    // ...and goes back once the calm lasted.
    r = attentionOrder(lucia("green"), r.held, t0 + 90_000 + ORDER_HOLD_MS);
    expect(r.ids).toEqual(["luna", "rocky", "toby"]);
  });
  it("does not put a dog first for the level of data that stopped arriving", () => {
    expect(attentionRank({ name: "Bruno", level: "amber", stale: true })).toBe(4);
    expect(byAttention([{ name: "Bruno", level: "red" as const, stale: true }, { name: "Toby", level: "green" as const }]).map((d) => d.name)).toEqual(["Toby", "Bruno"]);
  });
});

describe(" of causes, sources and times", () => {
  const r = (component: AlertReason["component"], code: string, value: number, normalRange: [number, number]): AlertReason =>
    ({ component, code, value, normalRange, message: "" });
  it("shows as causes the one that names the alert and the variables clearly out of their band; the rest in one line", () => {
    // Luna's fever in: 40.7 °C, and movement and heart rate 0.2 over their bands.
    const luna = [r("heart_rate", "hr_high", 76.7, [54.5, 76.5]), r("behavior", "activity_high", 58.8, [47, 58.6]),
      r("temperature", "temp_high", 40.7, [37.7, 39.5]), r("behavior", "behavior_unusual", 10, [0, 5])];
    expect(orderReasons(luna, "temp_high").map((x) => x.code)).toEqual(["temp_high", "activity_high", "hr_high", "behavior_unusual"]);
    const { causes, context } = splitReasons(luna, "temp_high");
    expect(causes.map((x) => x.code)).toEqual(["temp_high", "behavior_unusual"]);
    expect(context.map((x) => x.code)).toEqual(["activity_high", "hr_high"]);
    expect(contextLine(context)).toBe("Cerca del límite de lo normal: tiempo en movimiento 58.8 % (apenas sobre lo normal: hasta 58.6 %) y frecuencia cardiaca 76.7 lpm (apenas sobre lo normal: hasta 76.5 lpm).");
    expect(contextLine([])).toBeNull();
    // The reason that names the alert is a cause even near its bound.
    expect(splitReasons([r("behavior", "activity_low", 46.7, [46.8, 58.9])], "activity_low").causes).toHaveLength(1);
  });
  it("lists a variable once when the episode left its band on both sides", () => {
    // Toby's vet view in: 66 % against 52–64 % and 51.9 % against 52.1–63.8 % in the same event.
    const both = [r("behavior", "activity_high", 66, [52, 64]), r("behavior", "activity_low", 51.9, [52.1, 63.8]), r("temperature", "temp_high", 40.3, [37.7, 39.5])];
    expect(orderReasons(both, "temp_high").map((x) => x.code)).toEqual(["temp_high", "activity_high"]);
    // The one that names the alert stays.
    expect(orderReasons(both, "activity_low").map((x) => x.code)).toEqual(["activity_low", "temp_high"]);
  });
  it("calls hours ahead of the clock a demonstration only for the simulator", () => {
    expect(aheadTag("csv")).toBe("hora del archivo");
    expect(aheadTag("simulator")).toBe("tiempo simulado");
    expect(aheadTag(undefined)).toBe("tiempo simulado");
    expect(aheadNote("csv")).toMatch(/cargaste tú/);
    expect(aheadNote("csv")).not.toMatch(/demostración/);
    expect(aheadNote("simulator")).toMatch(/demostración/);
  });
  it("writes the hours of a chart axis in the 12-hour clock of the texts, compact", () => {
    const sp = (x: string[]) => x.map((s) => s.replace(/\s/g, " "));
    const at = (h: number, m: number, s = 0, d = 8) => new Date(2026, 9, d, h, m, s).getTime();
    expect(sp(axisTimeLabels([at(22, 54), at(22, 56), at(22, 58)]))).toEqual(["10:54 p. m.", "10:56", "10:58"]);
    expect(sp(axisTimeLabels([at(23, 58), at(0, 0, 0, 9)]))).toEqual(["11:58 p. m.", "12:00 a. m."]);
    expect(sp(axisTimeLabels([at(11, 59), at(12, 1)]))).toEqual(["11:59 a. m.", "12:01 p. m."]);
    expect(sp(axisTimeLabels([at(22, 54, 0), at(22, 54, 30)], { seconds: true }))).toEqual(["10:54:00 p. m.", "10:54:30"]);
    expect(sp(axisTimeLabels([at(22, 0), at(10, 0, 0, 9)], { weekday: true }))).toEqual(["jue 8, 10:00 p. m.", "vie 9, 10:00 a. m."]);
    expect(chartTimeText(at(22, 54)).replace(/\s/g, " ")).toBe("10:54 p. m.");
    expect(chartTimeText(at(22, 54), { date: true }).replace(/\s/g, " ")).toBe("8 oct., 10:54 p. m.");
  });
  it("differs in «Atención» and «Revisar», and in «Revisar» after the change ended", () => {
    const now = Date.UTC(2026, 9, 8, 23);
    const act = r("behavior", "activity_low", 20, [52, 64]);
    const amber = whatToDo([act], "Toby", cfg, { severity: "amber", endedAtMs: null, now });
    const red = whatToDo([act], "Toby", cfg, { severity: "red", endedAtMs: null, now });
    // Only the observation step of the variable is shared.
    expect(amber.filter((s) => red.includes(s))).toEqual(["Fíjate si come, bebe y juega como siempre, y si le cuesta moverse."]);
    const ended = whatToDo([act], "Toby", cfg, { severity: "red", endedAtMs: now - 3_600_000, now });
    expect(ended[0]).toBe("Cuéntale este cambio a tu veterinario y muéstrale la Vista para el veterinario.");
    expect(ended[1]).toBe("Observa a Toby y anota lo que notes: te servirá en la consulta.");
  });
});
