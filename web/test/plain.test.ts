import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type AlertReason, type DogStatus } from "../../shared/types";
import {
  activityFriendly, alertTitle, behaviorNow, byAttention, dayHeading, describeDog, durationText, endSentence, heartFriendly, homeSummary, hrBand,
  glueTime, namesText, primaryReason, tempFriendly, whatToDo, whenPhrase, whenText,
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

describe("describeDog", () => {
  it("answers in plain language, temperature first, without diagnosing", () => {
    expect(describeDog(status(), baseline, cfg).phrase).toBe("Todo en orden: se mueve y descansa como de costumbre.");
    expect(describeDog(status({ lastTemp: 40.2, lastHr: 90 }), baseline, cfg).phrase).toBe("Su temperatura está más alta de lo normal.");
    expect(describeDog(status({ lastHr: 90 }), baseline, cfg).phrase).toBe("Su corazón late más rápido de lo habitual.");
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

describe("Inicio summary and order", () => {
  const dogs = [
    { name: "Toby", level: "green" as const }, { name: "Rocky", level: "red" as const },
    { name: "Luna", level: "amber" as const }, { name: "Mora", level: null },
  ];
  it("puts the dogs that need a look first, then the rest, then those without data", () => {
    expect(byAttention(dogs).map((d) => d.name)).toEqual(["Rocky", "Luna", "Toby", "Mora"]);
  });
  it("says first which dogs moved away from their normal pattern, without gendered words", () => {
    expect(homeSummary(dogs)).toBe("Rocky se alejó de su patrón normal; revisa cómo está. Luna tiene un cambio leve. Toby está como de costumbre.");
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

describe("times in words", () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  const sp = (x: string) => x.replace(/\s/g, " ");   // ICU puts no-break spaces before "a. m."
  it("says today or yesterday with the time, and the date otherwise", () => {
    expect(sp(whenText(new Date(2026, 9, 2, 9, 5).getTime(), now))).toBe("hoy a las 9:05 a. m.");
    expect(sp(whenText(new Date(2026, 9, 1, 13, 30).getTime(), now))).toBe("ayer a la 1:30 p. m.");
    expect(whenText(new Date(2026, 8, 28, 13, 30).getTime(), now)).toMatch(/^28 set\. 2026/);
    expect(whenPhrase(new Date(2026, 8, 28, 13, 30).getTime(), now)).toMatch(/^el 28 set\. 2026/);
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
