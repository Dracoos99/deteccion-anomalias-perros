import { describe, expect, it } from "vitest";
import { NO_MARKS, UNDO_MS, bulkDoneText, bulkStorageKey, bulkUndoneText, clearedUntil, onList, restoreBulk, type ClearMarks } from "../src/lib/bulkAlerts";

const T = Date.UTC(2026, 9, 3, 15, 0, 0);

describe("which alerts stay on the Alertas list", () => {
  const marks: ClearMarks = { all: T, byDog: { toby: T + 60_000, luna: T - 60_000 } };

  it("applies the later of the mark for every dog and the dog's own", () => {
    expect(clearedUntil(marks, "toby")).toBe(T + 60_000);
    expect(clearedUntil(marks, "luna")).toBe(T);
    expect(clearedUntil(marks, "rocky")).toBe(T);
    expect(clearedUntil({ all: null, byDog: { toby: T } }, "toby")).toBe(T);
    expect(clearedUntil(NO_MARKS, "toby")).toBeNull();
  });

  it("keeps the alerts created after the mark, and those still being written", () => {
    expect(onList({ dogId: "rocky", createdAtMs: T + 1 }, marks)).toBe(true);
    expect(onList({ dogId: "rocky", createdAtMs: T }, marks)).toBe(false);
    expect(onList({ dogId: "toby", createdAtMs: T + 30_000 }, marks)).toBe(false);
    expect(onList({ dogId: "toby", createdAtMs: null }, marks)).toBe(true);
    expect(onList({ dogId: "toby", createdAtMs: 0 }, NO_MARKS)).toBe(true);
  });
});

describe("what the owner reads after a bulk action", () => {
  it("names how many new alerts were reviewed, and of which dog", () => {
    expect(bulkDoneText({ kind: "review", reviewed: ["a"] })).toBe("La alerta nueva quedó revisada.");
    expect(bulkDoneText({ kind: "review", reviewed: ["a", "b", "c"] }, "Toby")).toBe("Las 3 alertas nuevas de Toby quedaron revisadas.");
    expect(bulkUndoneText({ kind: "review", reviewed: ["a"] })).toBe("La alerta volvió a quedar como nueva.");
    expect(bulkUndoneText({ kind: "review", reviewed: ["a", "b"] })).toBe("Las 2 alertas volvieron a quedar como nuevas.");
  });

  it("says which list was cleared and which new alerts were reviewed on the way", () => {
    const mark = { dogId: null, previous: null };
    expect(bulkDoneText({ kind: "clear", reviewed: [], mark })).toBe("Quitamos las alertas de la lista.");
    expect(bulkDoneText({ kind: "clear", reviewed: ["a", "b"], mark })).toBe("Quitamos las alertas de la lista. Las 2 nuevas quedaron revisadas.");
    expect(bulkDoneText({ kind: "clear", reviewed: ["a"], mark: { dogId: "toby", previous: null } }, "Toby"))
      .toBe("Quitamos de la lista las alertas de Toby. La nueva quedó revisada.");
    expect(bulkUndoneText({ kind: "clear", reviewed: ["a"], mark })).toBe("Las alertas volvieron a la lista, como estaban.");
  });
});

describe("«Deshacer» after leaving Alertas and coming back", () => {
  const review = { change: { kind: "review" as const, reviewed: ["a", "b"] }, text: "Las 2 alertas nuevas quedaron revisadas.", at: T };
  const clear = { change: { kind: "clear" as const, reviewed: [], mark: { dogId: "toby", previous: T - 3_600_000 } }, text: "Quitamos de la lista las alertas de Toby.", at: T };

  it("brings back the last action of the person while its «Deshacer» lasts", () => {
    expect(bulkStorageKey("lucia")).toBe("alerts-bulk:lucia");
    expect(restoreBulk(JSON.stringify(review), T + 60_000)).toEqual(review);
    expect(restoreBulk(JSON.stringify(clear), T + UNDO_MS - 1)).toEqual(clear);
  });
  it("forgets it once «Deshacer» expired, and anything that is not an action", () => {
    expect(restoreBulk(JSON.stringify(review), T + UNDO_MS)).toBeNull();
    expect(restoreBulk(null, T)).toBeNull();
    expect(restoreBulk("{no es json", T)).toBeNull();
    expect(restoreBulk(JSON.stringify({ ...review, change: { kind: "delete", reviewed: [] } }), T)).toBeNull();
    expect(restoreBulk(JSON.stringify({ ...review, change: { kind: "review", reviewed: [] } }), T)).toBeNull();   // nothing to undo
    expect(restoreBulk(JSON.stringify({ ...clear, change: { ...clear.change, mark: { dogId: 3, previous: null } } }), T)).toBeNull();
  });
});
