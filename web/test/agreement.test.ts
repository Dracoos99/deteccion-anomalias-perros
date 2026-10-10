import { describe, expect, it } from "vitest";
import { agreement, pairBlocks } from "../src/lib/agreement";

describe("annotated against predicted behavior", () => {
  it("joins the blocks by reading id and counts only those with one annotated class", () => {
    const pairs = pairBlocks(
      [{ id: "a", t: 1, behavior: "lie" }, { id: "b", t: 2, behavior: "sit" }, { id: "c", t: 3, behavior: "walk" }, { id: "d", t: 4, behavior: null }, { id: "e", t: 5, behavior: "play" }],
      [{ id: "a", predictedBehavior: "lie" }, { id: "b", predictedBehavior: "lie" }, { id: "c", predictedBehavior: "walk" }, { id: "d", predictedBehavior: "sniff" }],
    );
    // «e» has no result yet; newest first.
    expect(pairs.map((p) => p.id)).toEqual(["d", "c", "b", "a"]);
    const a = agreement(pairs);
    expect(a.compared).toBe(3);
    expect(a.exact).toBe(2);
    // Sitting predicted as lying is the same group (rest).
    expect(a.grouped).toBe(3);
    expect(a.confusions).toEqual([{ annotated: "sit", predicted: "lie", n: 1 }]);
  });
});
