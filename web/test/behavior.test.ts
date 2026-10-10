import { describe, expect, it } from "vitest";
import { BEHAVIOR_SURE, behaviorShown } from "../src/lib/plain";

describe("the current behavior with the model's confidence", () => {
  it("states a sure behavior, says «En reposo» for a doubted posture and «Probablemente» for a doubted movement", () => {
    expect(behaviorShown("lie", 0.88, "male")).toBe("Echado");
    expect(behaviorShown("lie", 0.45, "female")).toBe("En reposo");
    expect(behaviorShown("sit", BEHAVIOR_SURE - 0.01, null)).toBe("En reposo");
    expect(behaviorShown("walk", 0.5, null)).toBe("Probablemente caminando");
    expect(behaviorShown("play", BEHAVIOR_SURE, null)).toBe("Jugando");
    // Without a probability (older status documents), as before.
    expect(behaviorShown("stand", null, "female")).toBe("Parada");
  });
});
