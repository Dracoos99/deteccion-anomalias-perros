import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG } from "../../shared/types";
import { CSV_HEADER, checkCsv, sampleCsv, templateCsv } from "../src/lib/csv";

const pf = DEFAULT_FUSION_CONFIG.prefilter;
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

/** n rows at 100 Hz from `start`, with a heart rate every `hrEvery` rows (0: none). */
function rows(n: number, opts: { start?: number; dog?: string; hrEvery?: number; hr?: (i: number) => number; stepMs?: number; temp?: string } = {}): string[] {
  const { start = T0, dog = "perro_1", hrEvery = 100, hr = () => 90, stepMs = 10, temp = "" } = opts;
  return Array.from({ length: n }, (_, i) =>
    [new Date(start + i * stepMs).toISOString(), dog, "0.01", "-0.98", "0.12", "1.2", "-0.4", "0.3", hrEvery && i % hrEvery === 0 ? String(hr(i)) : "", temp].join(","));
}
const csv = (lines: string[]) => [CSV_HEADER.join(","), ...lines].join("\n");
const check = (text: string, opts = {}) => checkCsv(text, text.length, pf, opts);

describe("checkCsv", () => {
  it("cuts the example file into blocks at its planted problems", () => {
    const r = check(sampleCsv(T0 + 65_000));
    expect(r.blocking).toEqual([]);
    expect(r.rows).toBe(6000);
    expect(r.rowsDropped).toBe(2);        // a letter in acc_x and a date that is not ISO 8601
    expect(r.valuesDropped).toBe(1);      // the impossible heart rate (312 lpm) only
    expect(r.runs).toBe(3);
    expect(r.blocks).toHaveLength(4);     // 2710 + 1489 + 1799 samples → 2 + 1 + 1 blocks
    expect(r.leftoverSamples).toBe(710 + 489 + 799);
    expect(r.rateHz).toBe(100);
    expect(r.dogIds).toEqual(["perro_ejemplo"]);
    expect(r.blocks[0].imu).toHaveLength(6000);
    expect(r.blocks[0].hr).toHaveLength(10);
    expect(r.blocks[0].temp).not.toBeNull();
    expect(r.blocks[0].startMs).toBe(T0);
    expect(r.warnings.join(" ")).toMatch(/cortes/);
  });

  it("averages the heart rate of each second and the temperature of the block", () => {
    const lines = rows(1000, { hrEvery: 50, hr: (i) => (i % 100 === 0 ? 80 : 90), temp: "38.4" });
    const r = check(csv(lines));
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hr).toEqual(Array(10).fill(85));
    expect(r.blocks[0].temp).toBe(38.4);
  });

  it("keeps the movement of a row whose heart rate is impossible", () => {
    const lines = rows(1000);
    lines[100] = lines[100].replace(",90,", ",400,");
    const r = check(csv(lines));
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hr).toHaveLength(9);
    expect(r.issues[0]).toMatchObject({ row: 102, column: "hr_bpm", kind: "value" });
  });

  it("sorts rows out of order and drops repeated timestamps", () => {
    const lines = rows(1000);
    [lines[10], lines[11]] = [lines[11], lines[10]];
    lines.push(lines[999]);
    const r = check(csv(lines));
    expect(r.blocks).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/orden de tiempo/);
    expect(r.warnings.join(" ")).toMatch(/repite/);
  });

  it("stops files that cannot be analysed", () => {
    expect(check("timestamp,dog_id\n").blocking[0]).toMatch(/Faltan columnas/);
    expect(check(csv([...rows(1000), ...rows(1000, { start: T0 + 20_000, dog: "perro_2" })])).blocking.join(" ")).toMatch(/2 perros/);
    expect(check(csv(rows(1000, { stepMs: 20 }))).blocking.join(" ")).toMatch(/50 Hz/);
    expect(check(csv(rows(900))).blocking.join(" ")).toMatch(/al menos 10 s/);
    expect(check(csv(rows(1000)), { notAfterMs: T0 + 5_000, dogName: "Toby" }).blocking.join(" ")).toMatch(/antes de los últimos datos de Toby/);
    expect(checkCsv(csv(rows(10)), 70 * 1024 * 1024, pf).blocking.join(" ")).toMatch(/pesa más/);
  });

  it("notes a file without heart rate or temperature", () => {
    const r = check(csv(rows(1000, { hrEvery: 0 })));
    expect(r.blocking).toEqual([]);
    expect(r.hasHr).toBe(false);
    expect(r.blocks[0].hr).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no trae frecuencia cardiaca/);
  });

  it("offers a template with the header", () => {
    expect(templateCsv().split("\n")[0]).toBe(CSV_HEADER.join(","));
  });
});
