import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type DogStatus } from "../../shared/types";
import { attentionRank, describeDog, homeSummary } from "../src/lib/plain";

const baseline = { activeRatioMean: 0.35, activeRatioStd: 0.08, hrMean: 70, hrStd: 5, tempMean: 38.6 };
const status = (over: Partial<DogStatus<unknown>> = {}): DogStatus<unknown> => ({
  healthScore: 92, level: "green", lastBehavior: "lie", lastHr: 72, lastTemp: 38.7, openAlerts: 0, lastActivityRatio: 0.36, updatedAt: null, ...over,
});

describe("«Revisa el collar»", () => {
  it("says the collar seems off instead of anything about the dog, and what to do", () => {
    const d = describeDog(status({ sensor: "no_wear", lastActivityRatio: 0.05 }), baseline, DEFAULT_FUSION_CONFIG);
    expect(d.sensorOff).toBe(true);
    expect(d.phrase).toMatch(/no lleva puesto el collar/);
    expect(d.todo).toMatch(/Revisa que el collar esté bien puesto/);
    expect(d.levelNote).toBeNull();
    expect(describeDog(status(), baseline, DEFAULT_FUSION_CONFIG).sensorOff).toBe(false);
  });
  it("puts the dog first and says it apart in the Inicio summary", () => {
    expect(attentionRank({ name: "Toby", level: "green", sensorOff: true })).toBe(1);
    expect(homeSummary([{ name: "Luna", level: "green" }, { name: "Toby", level: "green", sensorOff: true }]))
      .toBe("Revisa el collar de Toby: no llegan su movimiento, su ritmo cardiaco ni su temperatura. Luna está como de costumbre.");
  });
});
