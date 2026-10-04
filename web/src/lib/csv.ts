/**
 * CSV in the browser: validation, preview and 10 s blocks for `readings`.
 *   timestamp,dog_id,acc_x,acc_y,acc_z,gyr_x,gyr_y,gyr_z,hr_bpm,temp_c
 * - One row per IMU sample at 100 Hz (acceleration in g, rotation in °/s); hr_bpm and temp_c are optional.
 * - A row with a bad timestamp or movement value is left out. A heart rate or temperature that is not a number, or
 *   impossible for the prefilter, drops only that value: the movement of the row is kept.
 * - Samples are grouped in runs without gaps (more than 15 ms between two samples starts a new run) and every run in
 *   blocks of 1 000 samples. The end of a run that does not fill a block is not uploaded.
 * - Heart rate of a block: the mean of each second that has values (up to 10). Temperature: the block mean.
 */
import type { FusionConfig } from "@shared/types";

export const CSV_HEADER = ["timestamp", "dog_id", "acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z", "hr_bpm", "temp_c"] as const;
export const IMU_COLUMNS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"] as const;
export const CSV_MAX_BYTES = 60 * 1024 * 1024;   // about 2.5 h of data at 100 Hz
export const SAMPLES_PER_BLOCK = 1000;
export const MAX_BLOCKS = 2000;                   // firestore.rules: csvUploads.blocksExpected <= 2000
const GAP_MS = 15;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_ISSUES = 200;

export interface CsvIssue { row: number; column: string; message: string; kind: "row" | "value" }
export interface CsvPreviewRow { row: number; cols: string[]; cellErr: Record<string, string> }
export interface CsvBlock { startMs: number; imu: number[]; hr: number[]; temp: number | null }

export interface CsvCheck {
  header: string[];
  missing: string[];
  rows: number;
  /** Rows kept (their movement is uploaded, if they fall in a complete block). */
  valid: number;
  rowsDropped: number;
  valuesDropped: number;
  issues: CsvIssue[];
  preview: CsvPreviewRow[];
  dogIds: string[];
  rateHz: number | null;
  hasHr: boolean;
  hasTemp: boolean;
  runs: number;
  blocks: CsvBlock[];
  leftoverSamples: number;
  firstMs: number | null;
  lastMs: number | null;
  /** Problems that stop the upload, in plain Spanish. */
  blocking: string[];
  /** Data that is left out, in plain Spanish. */
  warnings: string[];
  /** The header is separated by semicolons or tabs (a spreadsheet saved with another separator), not commas. */
  otherSeparator?: boolean;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-PE")} ${n === 1 ? one : many}`;
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function checkCsv(text: string, sizeBytes: number, prefilter: FusionConfig["prefilter"],
  opts: { notAfterMs?: number | null; dogName?: string } = {}): CsvCheck {
  const res: CsvCheck = {
    header: [], missing: [], rows: 0, valid: 0, rowsDropped: 0, valuesDropped: 0, issues: [], preview: [], dogIds: [], rateHz: null,
    hasHr: false, hasTemp: false, runs: 0, blocks: [], leftoverSamples: 0, firstMs: null, lastMs: null, blocking: [], warnings: [],
  };
  if (sizeBytes > CSV_MAX_BYTES) res.blocking.push(`El archivo pesa más de ${CSV_MAX_BYTES / 1024 / 1024} MB: divídelo en partes.`);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim().length > 0);
  if (headerIdx < 0) { res.blocking.push("El archivo está vacío."); return res; }
  const first = lines[headerIdx];
  if (!first.includes(",") && /[;\t]/.test(first)) {
    // Not ten missing columns: one file saved with another separator.
    res.otherSeparator = true;
    res.missing = [...CSV_HEADER];   // nothing can be read: no row checks either
    const sep = first.includes(";") ? "punto y coma (;)" : "tabulaciones";
    res.blocking.push(`El archivo usa ${sep} para separar las columnas. Guárdalo como «CSV (delimitado por comas)» e inténtalo de nuevo.`);
    return res;
  }
  res.header = first.split(",").map((s) => s.trim().toLowerCase());
  res.missing = CSV_HEADER.filter((c) => !res.header.includes(c));
  if (res.missing.length) { res.blocking.push(`Faltan columnas: ${res.missing.join(", ")}.`); return res; }
  const idx = Object.fromEntries(res.header.map((h, i) => [h, i])) as Record<string, number>;

  const ts: number[] = [], imu: number[] = [], hr: number[] = [], temp: number[] = [];
  const dogIds = new Set<string>();
  const issue = (i: CsvIssue) => { if (res.issues.length < MAX_ISSUES) res.issues.push(i); };
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    res.rows++;
    const rowNo = li + 1;
    const cols = line.split(",");
    const cellErr: Record<string, string> = {};
    if (cols.length !== res.header.length) {
      cellErr["—"] = `Tiene ${cols.length} columnas; se esperan ${res.header.length}.`;
    } else {
      const t = cols[idx.timestamp].trim();
      if (!ISO_UTC.test(t) || Number.isNaN(Date.parse(t))) cellErr.timestamp = "No es una fecha ISO 8601 en UTC (termina en Z).";
      for (const c of IMU_COLUMNS) {
        const v = cols[idx[c]].trim();
        if (v === "" || !Number.isFinite(Number(v))) cellErr[c] = "No es un número.";
      }
    }
    const rowBad = Object.keys(cellErr).length > 0;
    let h = NaN, tc = NaN;
    if (!rowBad) {
      const hv = cols[idx.hr_bpm].trim(), tv = cols[idx.temp_c].trim();
      if (hv !== "") {
        const v = Number(hv);
        if (!Number.isFinite(v)) cellErr.hr_bpm = "No es un número; se deja fuera este valor.";
        else if (v < prefilter.hrMin || v > prefilter.hrMax) cellErr.hr_bpm = `Valor imposible (${v} lpm; se admite ${prefilter.hrMin}–${prefilter.hrMax}); se deja fuera.`;
        else h = v;
      }
      if (tv !== "") {
        const v = Number(tv);
        if (!Number.isFinite(v)) cellErr.temp_c = "No es un número; se deja fuera este valor.";
        else if (v < prefilter.tempMin || v > prefilter.tempMax) cellErr.temp_c = `Valor imposible (${v} °C; se admite ${prefilter.tempMin}–${prefilter.tempMax}); se deja fuera.`;
        else tc = v;
      }
    }
    for (const [column, message] of Object.entries(cellErr)) issue({ row: rowNo, column, message, kind: rowBad ? "row" : "value" });
    if (rowBad) res.rowsDropped++;
    else {
      res.valuesDropped += Object.keys(cellErr).length;
      res.valid++;
      ts.push(Date.parse(cols[idx.timestamp].trim()));
      for (const c of IMU_COLUMNS) imu.push(Number(cols[idx[c]]));
      hr.push(h);
      temp.push(tc);
      dogIds.add(cols[idx.dog_id].trim());
    }
    if (res.preview.length < 8 || (Object.keys(cellErr).length && res.preview.length < 12)) res.preview.push({ row: rowNo, cols, cellErr });
  }
  res.dogIds = [...dogIds];
  res.hasHr = hr.some((v) => !Number.isNaN(v));
  res.hasTemp = temp.some((v) => !Number.isNaN(v));
  if (!res.valid) { res.blocking.push("No hay filas válidas."); return res; }
  if (dogIds.size > 1) res.blocking.push(`El archivo trae datos de ${dogIds.size} perros (dog_id ${res.dogIds.slice(0, 3).join(", ")}${dogIds.size > 3 ? "…" : ""}): sube un archivo por perro.`);

  // Time order: rows out of order are sorted; repeated timestamps keep the first row.
  let order = ts.map((_, i) => i);
  let sorted = true;
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) { sorted = false; break; }
  if (!sorted) {
    order = order.sort((a, b) => ts[a] - ts[b] || a - b);
    res.warnings.push("Las filas no estaban en orden de tiempo: se ordenaron.");
  }
  const keep: number[] = [];
  let repeated = 0;
  for (const i of order) {
    if (keep.length && ts[i] === ts[keep[keep.length - 1]]) { repeated++; continue; }
    keep.push(i);
  }
  if (repeated) res.warnings.push(`${plural(repeated, "fila repite", "filas repiten")} la hora de otra: se dejan fuera.`);

  const diffs: number[] = [];
  for (let k = 1; k < Math.min(keep.length, 2001); k++) diffs.push(ts[keep[k]] - ts[keep[k - 1]]);
  if (diffs.length) {
    diffs.sort((a, b) => a - b);
    const med = diffs[Math.floor(diffs.length / 2)];
    res.rateHz = med > 0 ? Math.round(1000 / med) : null;
    if (!res.rateHz || Math.abs(res.rateHz - 100) > 5) res.blocking.push(`La frecuencia de muestreo detectada es de ${res.rateHz ?? "—"} Hz; se esperan 100 Hz.`);
  }
  res.firstMs = ts[keep[0]];
  res.lastMs = ts[keep[keep.length - 1]];

  // Runs without gaps, and blocks of 1 000 samples inside each run.
  let runStart = 0;
  const flush = (from: number, to: number) => {
    res.runs++;
    let k = from;
    for (; k + SAMPLES_PER_BLOCK <= to; k += SAMPLES_PER_BLOCK) res.blocks.push(makeBlock(keep.slice(k, k + SAMPLES_PER_BLOCK), ts, imu, hr, temp));
    res.leftoverSamples += to - k;
  };
  for (let k = 1; k <= keep.length; k++) {
    if (k === keep.length || ts[keep[k]] - ts[keep[k - 1]] > GAP_MS) { flush(runStart, k); runStart = k; }
  }

  if (!res.blocks.length) res.blocking.push("Hacen falta al menos 10 s seguidos de datos (1 000 filas sin cortes).");
  if (res.blocks.length > MAX_BLOCKS) res.blocking.push(`El archivo tiene ${plural(res.blocks.length, "bloque", "bloques")} de 10 s; el máximo es ${MAX_BLOCKS} (unas 5.5 h): divídelo en partes.`);
  if (opts.notAfterMs != null && res.blocks.length && res.blocks[0].startMs <= opts.notAfterMs) {
    res.blocking.push(`Los datos empiezan el ${new Date(res.blocks[0].startMs).toLocaleString("es-PE")}, antes de los últimos datos de ${opts.dogName ?? "tu perro"} (${new Date(opts.notAfterMs).toLocaleString("es-PE")}). El sistema solo analiza datos más recientes.`);
  }
  if (res.rowsDropped) res.warnings.push(`${plural(res.rowsDropped, "fila", "filas")} con la fecha o el movimiento mal escritos no se cargan.`);
  if (res.valuesDropped) res.warnings.push(`${plural(res.valuesDropped, "valor", "valores")} de frecuencia cardiaca o temperatura imposibles o mal escritos no se cargan (el resto de la fila sí).`);
  if (res.runs > 1) res.warnings.push(`Los datos tienen ${plural(res.runs - 1, "corte", "cortes")} (más de 15 ms sin muestras).`);
  if (res.leftoverSamples) res.warnings.push(`${plural(Math.round(res.leftoverSamples / 100), "segundo", "segundos")} que no completan un bloque de 10 s no se cargan.`);
  if (!res.hasHr) res.warnings.push("El archivo no trae frecuencia cardiaca: sin ella no se vigila el corazón.");
  if (!res.hasTemp) res.warnings.push("El archivo no trae temperatura: se vigila solo si llega en otra carga.");
  return res;
}

function makeBlock(rows: number[], ts: number[], imu: number[], hr: number[], temp: number[]): CsvBlock {
  const startMs = ts[rows[0]];
  const out = new Array<number>(rows.length * 6);
  const sec = new Array<[number, number]>(10).fill([0, 0]).map(() => [0, 0] as [number, number]);
  let tSum = 0, tN = 0;
  rows.forEach((r, j) => {
    for (let c = 0; c < 6; c++) out[j * 6 + c] = imu[r * 6 + c];
    if (!Number.isNaN(hr[r])) {
      const s = Math.min(9, Math.max(0, Math.floor((ts[r] - startMs) / 1000)));
      sec[s][0] += hr[r];
      sec[s][1]++;
    }
    if (!Number.isNaN(temp[r])) { tSum += temp[r]; tN++; }
  });
  return {
    startMs, imu: out,
    hr: sec.filter(([, n]) => n > 0).map(([s, n]) => round(s / n, 1)),
    temp: tN ? round(tSum / tN, 2) : null,
  };
}

/** A 60 s example file with three planted problems, to try the validation (synthetic values, not a real dog). */
export function sampleCsv(now = Date.now()): string {
  const t0 = Math.floor((now - 65_000) / 1000) * 1000;
  const lines = [CSV_HEADER.join(",")];
  for (let i = 0; i < 6000; i++) {
    const s = Math.sin(i / 17), c = Math.cos(i / 23);
    const row = [new Date(t0 + i * 10).toISOString(), "perro_ejemplo", (0.02 * s).toFixed(3), (-0.98 + 0.03 * c).toFixed(3), (0.12 + 0.02 * s).toFixed(3),
      (1.2 * c).toFixed(2), (-0.4 * s).toFixed(2), (0.3 * c).toFixed(2), i % 100 === 0 ? String(Math.round(96 + 4 * s)) : "", i % 1000 === 0 ? (38.6 + 0.05 * c).toFixed(1) : ""];
    if (i === 1500) row[8] = "312";                 // impossible heart rate: only that value is dropped
    if (i === 2710) row[3] = "abc";                 // not a number: the row is dropped (a cut in the data)
    if (i === 4200) row[0] = "01/10/2026 10:00";    // not ISO 8601: the row is dropped
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

/** Header and two rows, to fill in. */
export function templateCsv(): string {
  return `${CSV_HEADER.join(",")}\n2026-10-01T10:00:00.000Z,perro_1,0.01,-0.98,0.12,1.2,-0.4,0.3,,\n2026-10-01T10:00:00.010Z,perro_1,0.02,-0.97,0.11,1.1,-0.5,0.3,96,38.6\n`;
}
