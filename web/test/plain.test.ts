import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type AlertReason, type DogStatus } from "../../shared/types";
import {
  activityFriendly, alertTitle, behaviorNow, describeDog, durationText, heartFriendly, hrBand, primaryReason, tempFriendly, whatToDo,
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
    expect(describeDog(status({ level: "amber" }), baseline, cfg).phrase).toBe("Se movió de una forma poco habitual en los últimos minutos.");
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
  it("writes durations for people", () => {
    expect(durationText(20_000)).toBe("menos de 1 minuto");
    expect(durationText(15 * 60_000)).toBe("15 min");
    expect(durationText(135 * 60_000)).toBe("2 h 15 min");
  });
});
