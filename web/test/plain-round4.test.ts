import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type AlertReason, type DogStatus } from "../../shared/types";
import {
  SETTLE_FORGET_MS, SETTLE_HOLD_MS, alertGoing, alertTitle, contextLine, describeDog, homeSummary, messageInPast, reasonHolds, resetSettled, settleDev,
} from "../src/lib/plain";

const cfg = DEFAULT_FUSION_CONFIG;
const baseline = { activeRatioMean: 0.35, activeRatioStd: 0.08, hrMean: 70, hrStd: 5, tempMean: 38.6 };
const status = (over: Partial<DogStatus<unknown>> = {}): DogStatus<unknown> => ({
  healthScore: 92, level: "green", lastBehavior: "walk", lastHr: 72, lastTemp: 38.7, openAlerts: 0, lastActivityRatio: 0.36,
  updatedAt: null, ...over,
});
const reason = (component: AlertReason["component"], code: string): AlertReason =>
  ({ component, code, value: 1, normalRange: [0, 1], message: "" });

describe(" of the seal that does not blink, the present tense and the summary", () => {
  beforeEach(() => resetSettled());
  const green = { level: "green" as const, healthScore: 94, stableLevel: "green" as const, stableHealthScore: 94 };
  const at = (st: DogStatus<unknown>, t: number, key = "toby") => describeDog(st, baseline, cfg, undefined, false, { key, now: t });

  it("holds a judgement for SETTLE_HOLD_MS before it changes, and shows the true one at first sight or after a pause", () => {
    expect(settleDev("d:activity", "normal", 0)).toBe("normal");
    // A pulse that grazes the edge and goes back changes nothing.
    expect(settleDev("d:activity", "low", 2_000)).toBe("normal");
    expect(settleDev("d:activity", "normal", 5_000)).toBe("normal");
    // A new judgement that holds without interruption replaces it, and then the same way back.
    expect(settleDev("d:activity", "low", 6_000)).toBe("normal");
    expect(settleDev("d:activity", "low", 6_000 + SETTLE_HOLD_MS - 1)).toBe("normal");
    expect(settleDev("d:activity", "low", 6_000 + SETTLE_HOLD_MS)).toBe("low");
    expect(settleDev("d:activity", "normal", 27_000)).toBe("low");
    expect(settleDev("d:activity", "normal", 27_000 + SETTLE_HOLD_MS)).toBe("normal");
    // Not asked for in a while (another page): what is true now. Without data or reference there is nothing to hold.
    const later = 27_000 + SETTLE_HOLD_MS + SETTLE_FORGET_MS + 1;
    expect(settleDev("d:activity", "low", later)).toBe("low");
    expect(settleDev("d:activity", "unknown", later + 1_000)).toBe("unknown");
    expect(settleDev("d:activity", "normal", later + 1_500)).toBe("normal");
    // Each dog and each signal has its own.
    expect(settleDev("e:activity", "high", later + 1_500)).toBe("high");
    expect(settleDev("d:heart", "low", later + 1_500)).toBe("low");
  });

  it("keeps «Todo normal» while the movement grazes its band, and shows «Atención» once it stays under", () => {
    const ok = status({ ...green, lastActivityRatio: 0.3 }), low = status({ ...green, lastActivityRatio: 0.18 });   // band 0.19–0.51
    expect(at(ok, 0).level).toBe("green");
    for (const [st, t] of [[low, 2_000], [ok, 4_000], [low, 6_000], [ok, 8_000]] as const) {
      const d = at(st, t);
      expect(d.level).toBe("green");
      expect(d.phrase).toBe("Todo en orden: se mueve y descansa como de costumbre.");
      expect(d.levelNote).toBeNull();
    }
    at(low, 10_000);
    const held = at(low, 10_000 + SETTLE_HOLD_MS);
    expect(held.level).toBe("amber");
    expect(held.levelNote).toBe("Atención porque se mueve menos de lo habitual, aunque el número esté sobre 80.");
    expect(held.activity.label).toBe("Menos que de costumbre");
    // Another screen asks for the same dog right after and gets the same answer.
    expect(at(low, 10_000 + SETTLE_HOLD_MS + 1).level).toBe("amber");
    // Without a key (a one-off use) nothing is held.
    expect(describeDog(low, baseline, cfg).level).toBe("amber");
  });

  it("marks a dog in «Todo normal» with a vital just out of its band, and the summary does not call it «dentro de su patrón normal»", () => {
    expect(describeDog(status({ ...green, lastHr: 95 }), baseline, cfg).slight).toBe(true);
    expect(describeDog(status({ ...green, lastHr: 72 }), baseline, cfg).slight).toBe(false);
    expect(describeDog(status({ ...green, lastHr: 130 }), baseline, cfg).slight).toBe(false);   // far: «Atención», not slight
    expect(describeDog(null, baseline, cfg).slight).toBe(false);
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Rocky", level: "green", slight: true }, { name: "Toby", level: "green" }]))
      .toBe("Rocky tiene un dato un poco fuera de lo habitual. Luna y Toby están como de costumbre.");
    expect(homeSummary([{ name: "Luna", level: "green", slight: true }, { name: "Rocky", level: "green", slight: true }]))
      .toBe("Luna y Rocky tienen un dato un poco fuera de lo habitual.");
    // «Todo en orden» only when no dog has one.
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Toby", level: "green" }])).toBe("Todo en orden: tus 2 perros están dentro de su patrón normal.");
    // A dog with an alert waiting keeps the sentence of its alert, and is not said to be «como de costumbre».
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Rocky", level: "green", slight: true, openAlert: true }]))
      .toBe("Rocky tiene un dato un poco fuera de lo habitual. Luna está como de costumbre. Rocky tiene una alerta nueva.");
    // Nor «ahora están como de costumbre» when its alert already ended but a vital is still out of its band.
    expect(homeSummary([{ name: "Luna", level: "green", openAlert: true, alertEnded: true }, { name: "Rocky", level: "green", slight: true, openAlert: true, alertEnded: true }]))
      .toBe("Rocky tiene un dato un poco fuera de lo habitual. Luna tiene una alerta nueva que ya pasó; ahora está como de costumbre. Rocky tiene una alerta nueva.");
  });

  it("speaks, while an alert goes on, of what holds the level now and not of a variable that already calmed", () => {
    const hr = { ...reason("heart_rate", "hr_high"), value: 140, normalRange: [60, 80] as [number, number] };
    const act = { ...reason("behavior", "activity_low"), value: 0.1, normalRange: [0.19, 0.51] as [number, number] };
    const alert = { reasons: [hr, act], titleCode: "hr_high" };
    const red = { level: "red" as const, healthScore: 50, stableLevel: "red" as const, stableHealthScore: 50 };
    // The heart rate that named the alert is back in its band and the movement is still low: the phrase says so.
    expect(describeDog(status({ ...red, lastHr: 70, lastActivityRatio: 0.1 }), baseline, cfg, alert, true).phrase).toBe("Se está moviendo menos de lo habitual.");
    // Still high: the one that names the alert, in the present.
    expect(describeDog(status({ ...red, lastHr: 100, lastActivityRatio: 0.1 }), baseline, cfg, alert, true).phrase).toBe("Su corazón late más rápido de lo habitual.");
    // Nothing out of its band now: the reason that names the alert, in the past.
    expect(describeDog(status({ ...red, lastHr: 70, lastActivityRatio: 0.3 }), baseline, cfg, alert, true).phrase).toBe("Su corazón latió más rápido de lo habitual en los últimos minutos.");
  });

  it("writes the title of an alert in the present while its episode goes on and in the past after", () => {
    const temp = [{ component: "temperature" as const, code: "temp_high", value: 40.1, normalRange: [37.7, 39.5] as [number, number], message: "" }];
    expect(alertTitle(temp)).toBe("Su temperatura estuvo alta");
    expect(alertTitle(temp, null, true)).toBe("Su temperatura está alta");
    expect(alertTitle([reason("heart_rate", "hr_low")], null, true)).toBe("Su frecuencia cardiaca está baja");
    expect(alertTitle([reason("behavior", "activity_low")], null, true)).toBe("Se mueve menos de lo habitual");
    expect(alertTitle([], null, true)).toBe("Algo se aleja de su patrón normal");
    const now = 10_000_000, ms = (t: number) => ({ toMillis: () => t });
    expect(alertGoing({ endedAt: null, updatedAt: ms(now - 60_000) }, now)).toBe(true);
    expect(alertGoing({ endedAt: ms(now - 1_000), updatedAt: ms(now - 1_000) }, now)).toBe(false);
    // No end, but the engine stopped writing to it: its data stopped, so it is not said to continue.
    expect(alertGoing({ endedAt: null, updatedAt: ms(now - 11 * 60_000) }, now)).toBe(false);
    expect(alertGoing({ endedAt: null, createdAt: ms(now - 30_000) }, now)).toBe(true);
  });

  it("gives the bound that was crossed in the context line, never a range with a useless «.0»", () => {
    const low = { component: "behavior" as const, code: "activity_low", value: 46.7, normalRange: [47, 59] as [number, number], message: "" };
    expect(contextLine([low])).toBe("Cerca del límite de lo normal: tiempo en movimiento 46.7 % (apenas bajo lo normal: desde 47 %).");
    const unusual = { component: "behavior" as const, code: "behavior_unusual", value: 7, normalRange: [0, 5] as [number, number], message: "" };
    expect(contextLine([unusual])).toBe("Cerca del límite de lo normal: movimientos poco habituales 7 % (lo habitual: hasta el 5 %).");
  });
});

describe(" of the heart row follows the seal, the title follows its variable, the past tense of an ended alert", () => {
  beforeEach(() => resetSettled());
  const green = { level: "green" as const, healthScore: 94, stableLevel: "green" as const, stableHealthScore: 94 };
  const at = (st: DogStatus<unknown>, t: number) => describeDog(st, baseline, cfg, undefined, false, { key: "rocky", now: t });

  it("shows a heart rate far from its band as «Más rápido» at once, and does not drop the seal when the mean grazes the margin", () => {
    // band 60–80 (20 wide): «far» is over 110.
    expect(at(status({ ...green, lastHr: 72 }), 0).heart.label).toBe("Normal");
    const far = at(status({ ...green, lastHr: 146 }), 2_000);
    expect(far.level).toBe("amber");
    expect(far.heart.label).toBe("Más rápido de lo habitual");   // not «Normal» for 20 s next to «mucho más rápido»
    expect(far.phrase).toBe("Su corazón late mucho más rápido de lo habitual.");
    // The 60-second mean falls just under the margin for a second: still «Atención», the row still «Más rápido».
    const graze = at(status({ ...green, lastHr: 108 }), 4_000);
    expect(graze.level).toBe("amber");
    expect(graze.phrase).toBe("Su corazón late mucho más rápido de lo habitual.");
    expect(graze.heart.label).toBe("Más rápido de lo habitual");
    expect(homeSummary([{ name: "Rocky", level: graze.level, slight: graze.slight }])).toBe("Rocky tiene un cambio leve.");
    // Back for SETTLE_HOLD_MS: the seal goes down, the heart is still out of its band («un poco»).
    const later = at(status({ ...green, lastHr: 108 }), 4_000 + SETTLE_HOLD_MS);
    expect(later.level).toBe("green");
    expect(later.phrase).toBe("Su corazón late un poco más rápido de lo habitual.");
    expect(later.slight).toBe(true);
    // Without a key (a one-off use) it is the judgement of this moment.
    expect(describeDog(status({ ...green, lastHr: 146 }), baseline, cfg).heart.label).toBe("Más rápido de lo habitual");
  });

  it("says whether the variable that names an alert in course is still out of its band, for its title", () => {
    const hr = { ...reason("heart_rate", "hr_high"), value: 140, normalRange: [60, 80] as [number, number] };
    const temp = { ...reason("temperature", "temp_high"), value: 40.2, normalRange: [37.7, 39.5] as [number, number] };
    const alert = { reasons: [hr, temp], titleCode: "hr_high" };
    const red = { level: "red" as const, healthScore: 50, stableLevel: "red" as const, stableHealthScore: 50 };
    expect(describeDog(status({ ...red, lastHr: 100, lastTemp: 40.2 }), baseline, cfg, alert, true).titleStill).toBe(true);
    // The heart calmed and the alert goes on for the temperature: its title is not in the present.
    expect(describeDog(status({ ...red, lastHr: 70, lastTemp: 40.2 }), baseline, cfg, alert, true).titleStill).toBe(false);
    expect(describeDog(status({ ...red, lastHr: 70, lastTemp: 40.2 }), baseline, cfg).titleStill).toBeNull();
    // A shape-only reason has no band to look at: it holds with the episode.
    const shape = { reasons: [reason("heart_rate", "hr_pattern")], titleCode: "hr_pattern" };
    expect(describeDog(status({ ...red }), baseline, cfg, shape, true).titleStill).toBe(true);
  });

  it("writes the explanation of an ended alert in the past", () => {
    expect(messageInPast("La frecuencia cardiaca de los últimos 60 s (184 lpm) está por encima de su rango habitual (49–75 lpm).")).toBe("La frecuencia cardiaca de los últimos 60 s (184 lpm) estuvo por encima de su rango habitual (49–75 lpm).");
    expect(messageInPast("La temperatura (40.3 °C) está por encima del rango de referencia (37.7–39.5 °C).")).toBe("La temperatura (40.3 °C) estuvo por encima del rango de referencia (37.7–39.5 °C).");
    expect(messageInPast("En el último minuto, su frecuencia cardiaca no siguió su patrón normal, aunque su promedio está dentro de su rango habitual (49–75 lpm).")).toContain("estuvo dentro");
    expect(messageInPast("Se movió menos de lo habitual.")).toBe("Se movió menos de lo habitual.");
  });
});

describe(" of deep deviations change at once, the tense of a cause that calmed", () => {
  beforeEach(() => resetSettled());
  const green = { level: "green" as const, healthScore: 94, stableLevel: "green" as const, stableHealthScore: 94 };
  const at = (st: DogStatus<unknown>, t: number) => describeDog(st, baseline, cfg, undefined, false, { key: "toby", now: t });

  it("holds only the judgements that graze the edge of the band, not a value well beyond it", () => {
    // band 60–80 (20 wide): 0.25 widths are 5 lpm, so 90 lpm is well beyond it and 83 lpm grazes the edge.
    expect(at(status({ ...green, lastHr: 72 }), 0).heart.label).toBe("Normal");
    expect(at(status({ ...green, lastHr: 83 }), 2_000).heart.label).toBe("Normal");
    expect(at(status({ ...green, lastHr: 90 }), 4_000).heart.label).toBe("Más rápido de lo habitual");
    // The same for the movement (band 0.19–0.51, 0.32 wide: 0.08 beyond): 0.15 is beyond, 0.18 grazes.
    expect(at(status({ ...green, lastActivityRatio: 0.18 }), 6_000).activity.label).toBe("Como de costumbre");
    expect(at(status({ ...green, lastActivityRatio: 0.1 }), 8_000).activity.label).toBe("Menos que de costumbre");
  });

  it("knows whether the cause of an alert in course still holds, for the tense of its explanation", () => {
    const hr = { ...reason("heart_rate", "hr_high"), value: 140, normalRange: [60, 80] as [number, number] };
    const temp = { ...reason("temperature", "temp_high"), value: 40.2, normalRange: [37.7, 39.5] as [number, number] };
    const red = { level: "red" as const, healthScore: 50, stableLevel: "red" as const, stableHealthScore: 50 };
    const now = describeDog(status({ ...red, lastHr: 70, lastTemp: 40.2 }), baseline, cfg, { reasons: [hr, temp], titleCode: "hr_high" }, true);
    expect(reasonHolds(hr, now)).toBe(false);    // the heart calmed
    expect(reasonHolds(temp, now)).toBe(true);   // the fever goes on
    expect(reasonHolds(reason("heart_rate", "hr_pattern"), now)).toBe(true);
  });
});
