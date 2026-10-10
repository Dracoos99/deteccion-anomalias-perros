import { describe, expect, it } from "vitest";
import { behaviorProb } from "../../src/readings";

describe("the probability of the shown behavior", () => {
  it("takes the shown behavior's probability from the block's seven, rounded to two decimals", () => {
    // Order of BEHAVIORS: sit, stand, lie, trot, walk, play, sniff.
    expect(behaviorProb("lie", [0.1, 0.2, 0.6543, 0, 0.05, 0, 0])).toBe(0.65);
    expect(behaviorProb("play", [0, 0, 0, 0.1, 0, 0.9, 0])).toBe(0.9);
    expect(behaviorProb(null, [0.1, 0.2, 0.7, 0, 0, 0, 0])).toBeNull();
    expect(behaviorProb("walk", null)).toBeNull();
  });
});
