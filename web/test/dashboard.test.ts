// Inicio as a dashboard: buckets, figures and filters agree.
import { describe, expect, it } from "vitest";
import { bucketOf, dashboardKpis, matchesFilter, matchesSearch, type DogView } from "../src/lib/dashboard";

const dog = (over: Partial<DogView>): DogView => ({
  id: "d", name: "Toby", hasData: true, level: "green", learning: false, stale: false, sensorOff: false, openAlert: false, ...over,
});

describe("dashboard buckets", () => {
  it("never calls a dog without recent data «normal»", () => {
    expect(bucketOf(dog({ hasData: false, level: null }))).toBe("nodata");
    expect(bucketOf(dog({ stale: true }))).toBe("nodata");
    expect(bucketOf(dog({ sensorOff: true }))).toBe("nodata");
    expect(bucketOf(dog({ stale: true, openAlert: true }))).toBe("nodata");
  });
  it("puts new alerts and the levels that need a look in «En alerta»", () => {
    expect(bucketOf(dog({ openAlert: true }))).toBe("alert");
    expect(bucketOf(dog({ level: "amber" }))).toBe("alert");
    expect(bucketOf(dog({ level: "red" }))).toBe("alert");
    expect(bucketOf(dog({ learning: true, openAlert: true }))).toBe("alert");
  });
  it("keeps a dog that is learning out of «normal» and of «En alerta»", () => {
    expect(bucketOf(dog({ learning: true, level: null }))).toBe("learning");
    expect(bucketOf(dog({}))).toBe("normal");
  });
});

describe("dashboard figures and filters", () => {
  const dogs = [dog({ id: "a" }), dog({ id: "b", level: "amber" }), dog({ id: "c", hasData: false, level: null }), dog({ id: "d", learning: true, level: null })];
  it("counts every dog, the normal ones, the new alerts and those without data", () => {
    expect(dashboardKpis(dogs, 3)).toEqual({ total: 4, normal: 1, alerts: 3, nodata: 1 });
    expect(dashboardKpis([], 0)).toEqual({ total: 0, normal: 0, alerts: 0, nodata: 0 });
  });
  it("filters by bucket and searches names without case or accents", () => {
    expect(dogs.filter((d) => matchesFilter(d, "all")).length).toBe(4);
    expect(dogs.filter((d) => matchesFilter(d, "alert")).map((d) => d.id)).toEqual(["b"]);
    expect(dogs.filter((d) => matchesFilter(d, "nodata")).map((d) => d.id)).toEqual(["c"]);
    expect(matchesSearch("Ñuño", "nuno")).toBe(true);
    expect(matchesSearch("Rocky", "  ROC ")).toBe(true);
    expect(matchesSearch("Luna", "toby")).toBe(false);
    expect(matchesSearch("Luna", "")).toBe(true);
  });
});
