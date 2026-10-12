import { describe, expect, it } from "vitest";
import { UNDO_MS, bulkDoneText, bulkStorageKey, bulkUndoneText, restoreBulk } from "../src/lib/bulkAlerts";

const T = Date.UTC(2026, 9, 3, 15, 0, 0);

describe("what the owner reads after «Marcar todas como revisadas»", () => {
  it("names how many new alerts were reviewed, and of which dog", () => {
    expect(bulkDoneText({ kind: "review", reviewed: ["a"] })).toBe("La alerta nueva quedó revisada.");
    expect(bulkDoneText({ kind: "review", reviewed: ["a", "b", "c"] }, "Toby")).toBe("Las 3 alertas nuevas de Toby quedaron revisadas.");
    expect(bulkUndoneText({ kind: "review", reviewed: ["a"] })).toBe("La alerta volvió a quedar como nueva.");
    expect(bulkUndoneText({ kind: "review", reviewed: ["a", "b"] })).toBe("Las 2 alertas volvieron a quedar como nuevas.");
  });
});

describe("«Deshacer» after leaving Alertas and coming back", () => {
  const review = { change: { kind: "review" as const, reviewed: ["a", "b"] }, text: "Las 2 alertas nuevas quedaron revisadas.", at: T };

  it("brings back the last action of the person while its «Deshacer» lasts", () => {
    expect(bulkStorageKey("lucia")).toBe("alerts-bulk:lucia");
    expect(restoreBulk(JSON.stringify(review), T + 60_000)).toEqual(review);
    expect(restoreBulk(JSON.stringify(review), T + UNDO_MS - 1)).toEqual(review);
  });
  it("forgets it once «Deshacer» expired, and anything that is not an action", () => {
    expect(restoreBulk(JSON.stringify(review), T + UNDO_MS)).toBeNull();
    expect(restoreBulk(null, T)).toBeNull();
    expect(restoreBulk("{no es json", T)).toBeNull();
    expect(restoreBulk(JSON.stringify({ ...review, change: { kind: "delete", reviewed: [] } }), T)).toBeNull();
    expect(restoreBulk(JSON.stringify({ ...review, change: { kind: "review", reviewed: [] } }), T)).toBeNull();   // nothing to undo
  });
  it("does not bring back a «Limpiar lista» stored before retired it", () => {
    const clear = { change: { kind: "clear", reviewed: ["a"], mark: { dogId: "toby", previous: null } }, text: "Quitamos de la lista las alertas de Toby.", at: T };
    expect(restoreBulk(JSON.stringify(clear), T + 60_000)).toBeNull();
  });
});
