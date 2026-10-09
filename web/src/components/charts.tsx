/* Charts: SVG, no chart library. One series per chart, the dog's normal band shaded with thin edges, amber dots on unusual
   moments, a crosshair with the mouse, touch (tap or slide sideways) and keyboard (← → Esc, read aloud), and a text summary
   for screen readers. Look of the title and, at its right, the latest value (`showNow`); the unit above the
   axis; 12 px axes; few grid lines; the level zones in soft tints (the red one the palest, and only as tall as the data
   needs: see `healthDomain`); the legend right under the plot. The series compared with the band is the average
   the engine compares (60 s of heart rate, 20 min of movement); the raw values behind it go as a faint `detail` line,
   never marked against the band, and never stretch the axis (the axis follows the averages and the usual raw values). */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { axisTimeLabels, chartTimeText } from "../lib/plain";
import { fmtNum } from "./ui";

function useWidth(initial = 600): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(lo: number, hi: number, n = 4): { ticks: number[]; step: number } {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = [0.5, 1, 2, 2.5, 5, 10].map((m) => m * mag);
  const at = (s: number) => {
    const out: number[] = [];
    for (let v = Math.ceil(lo / s - 1e-9) * s; v <= hi + 1e-9; v += s) out.push(+v.toFixed(6));
    return out;
  };
  let i = steps.findIndex((s) => span / s <= n);
  if (i < 0) i = steps.length - 1;
  let ticks = at(steps[i]);
  // An axis with one mark says nothing (a step of 20 over 46 to 78 leaves only «60»): take the next finer step.
  while (ticks.length < 2 && i > 0) { i--; ticks = at(steps[i]); }
  return { ticks, step: steps[i] };
}

/** Decimals a tick step needs, so labels never repeat ("37.5" is not shown as "38" next to "37"). */
const stepDecimals = (step: number) => [0, 1, 2].find((d) => Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) ?? 2;

type ChartRange = "10m" | "1h" | "24h" | "7d";   // 10m: the live panel
const fmtHM = new Intl.DateTimeFormat("es-PE", { hour: "numeric", minute: "2-digit", hourCycle: "h12" });
const fmtHMS = new Intl.DateTimeFormat("es-PE", { hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h12" });
const fmtWD = new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric" });
const fmtWDHM = new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h12" });
const HOUR = 3_600_000;
/** Axis labels by what the data span, not by the period asked: a week with one day of data reads in hours, not as
 * the same weekday five times, and a few minutes of data read in seconds, not as the same minute five times.,
 * In the 12-hour clock of the texts, compact («10:54 p. m., 10:56, 10:58»; lib/plain.ts). `fmt` tells
 * two labels apart; `labels` writes them. */
const xAxis = (spanMs: number): { fmt: Intl.DateTimeFormat; labels: (ts: number[]) => string[] } =>
  spanMs > 4 * 24 * HOUR ? { fmt: fmtWD, labels: (ts) => ts.map((t) => fmtWD.format(t)) }
    : spanMs > 36 * HOUR ? { fmt: fmtWDHM, labels: (ts) => axisTimeLabels(ts, { weekday: true }) }
      : spanMs < 4 * 60_000 ? { fmt: fmtHMS, labels: (ts) => axisTimeLabels(ts, { seconds: true }) }
        : { fmt: fmtHM, labels: (ts) => axisTimeLabels(ts) };

export interface ChartPoint { t: number; v: number; mark?: boolean }
/** A shaded band of values (the Health Score levels); `tone` gives its tint and its label the colour of the level. */
export interface Zone { from: number; to: number; label: string; tone: "green" | "amber" | "red" }

/** The Health Score levels as shaded zones, with the cuts of config/fusion. */
export function healthZones(levels: { green: number; amber: number }): Zone[] {
  return [
    { from: 0, to: levels.amber, label: "Revisar", tone: "red" },
    { from: levels.amber, to: levels.green, label: "Atención", tone: "amber" },
    { from: levels.green, to: 100, label: "Normal", tone: "green" },
  ];
}

/** The axis of a Health Score chart: from the level below the lowest value (the red zone only shows when the dog went
 * there) to 100, so a dog in «Todo normal» is not drawn inside a wall of red. */
export function healthDomain(levels: { green: number; amber: number }, values: number[]): [number, number] {
  let min = Infinity;
  for (const v of values) min = Math.min(min, v);
  const floor = Number.isFinite(min) ? Math.floor(min / 10) * 10 : levels.amber;
  return [Math.max(0, Math.min(levels.amber, floor)), 100];
}

/** The p-th quantile of a sorted array (the usual raw values behind an average, without its rare spikes). */
const quantile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

export function TrendChart({ title, sub, points, detail, unit, decimals = 0, rangeKey, band, zones, domain, height,
  highlight, legendLine, legendDetail, legendBand, legendMarks, gapMs, detailGapMs = gapMs, showLast = false, showNow = false, loading = false, className }: {
  title: string; sub?: string; points: ChartPoint[]; unit: string; decimals?: number; rangeKey: ChartRange;
  /** The raw values behind the averaged series, as a faint line under it (not marked, not hovered). */
  detail?: { t: number; v: number }[];
  band?: [number, number] | null; zones?: Zone[]; domain?: [number, number];
  /** A stretch of time shaded behind the series (the alert episode). */
  highlight?: { from: number; to: number; label: string } | null;
  height?: number; legendLine?: string; legendDetail?: string; legendBand?: string; legendMarks?: string;
  /** The line breaks where two points are further apart than this (no data in between). */
  gapMs?: number;
  /** The same for the detail line (one value per second next to one average per block). */
  detailGapMs?: number;
  /** Dot on the latest point: "now" in the live panel. */
  showLast?: boolean;
  /** The latest value, large at the right of the title (it is the last point of the series that is compared). */
  showNow?: boolean;
  /** The data are still arriving: a placeholder instead of "Sin datos en este periodo". */
  loading?: boolean;
  /** A class for the figure, to place the chart in a grid (the live panel). */
  className?: string;
}) {
  const [ref, width] = useWidth();
  const figRef = useRef<HTMLElement | null>(null);
  const clipId = `clip-${useId().replace(/:/g, "")}`;
  const [hover, setHover] = useState<number | null>(null);
  const [kbd, setKbd] = useState(false);   // the crosshair moves with the keyboard: its value is read aloud
  // A tapped value stays until the next tap elsewhere (lifting the finger must not hide it).
  useEffect(() => {
    if (hover == null) return;
    const away = (e: Event) => { if (!figRef.current?.contains(e.target as Node)) setHover(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [hover]);
  // The unit sits above the axis; the zone labels get a gutter on the right, otherwise the plot runs to the edge.
  const m = { l: 40, r: zones?.length ? 64 : 12, t: 26, b: 28 };
  const W = width, H = height ?? (W < 480 ? 176 : 224), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = points.map((p) => p.v);
  const extra = detail ?? [];
  // Loops, not Math.min(...array): an hour of 1 Hz values is a lot of arguments for one call.
  let lo = Infinity, hi = -Infinity;
  for (const v of band ?? []) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  // The raw values behind an average reach the axis only up to their usual range: a one-second spike must not flatten
  // the line that is read. What goes beyond is clipped at the edge of the plot.
  if (extra.length) {
    const sorted = extra.map((p) => p.v).sort((a, b) => a - b);
    lo = Math.min(lo, quantile(sorted, 0.02)); hi = Math.max(hi, quantile(sorted, 0.98));
  }
  if (domain) [lo, hi] = domain;
  else { const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad; }
  // The axis spans the data drawn: the averaged points and the raw values behind them.
  let t0 = Infinity, t1 = -Infinity;
  for (const p of [points[0], points[points.length - 1], extra[0], extra[extra.length - 1]]) if (p) { t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t); }
  if (!Number.isFinite(t0)) { t0 = 0; t1 = 1; }
  const X = (t: number) => (t1 > t0 ? m.l + ((t - t0) / (t1 - t0)) * iw : m.l + iw / 2);
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * ih;
  // With zones, the axis marks only their edges (the level cuts), with no grid over the colours; otherwise three lines.
  const nice = niceTicks(lo, hi, 3);
  const ticks = zones?.length ? [...new Set([lo, hi, ...zones.flatMap((z) => [z.from, z.to])])].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b)
    : nice.ticks.filter((v) => v >= lo && v <= hi);
  const tickDecimals = zones?.length ? 0 : Math.max(stepDecimals(nice.step), decimals && hi - lo < 5 ? 1 : 0);
  const fractions = W < 480 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];  // fewer labels on narrow screens
  const xa = xAxis(t1 - t0);
  // Every stretch is labelled once: a label that repeats the one before it is dropped (a minute of data on a phone
  // would otherwise read «3:35 p. m.» five times).
  const xticks = (t1 > t0 ? fractions.map((f) => t0 + f * (t1 - t0)) : [t0]).filter((t, i, all) => i === 0 || xa.fmt.format(t) !== xa.fmt.format(all[i - 1]));
  const xlabels = xa.labels(xticks);
  const broken = (arr: { t: number }[], i: number, gap = gapMs) => i === 0 || (!!gap && arr[i].t - arr[i - 1].t > gap);
  const line = (arr: { t: number; v: number }[], gap = gapMs) =>
    arr.map((p, i) => (broken(arr, i, gap) ? "M" : "L") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1)).join(" ");
  const path = line(points);
  // A point with no neighbour on either side (one block between gaps, or the only one) is drawn as a dot.
  const lone = points.filter((_, i) => broken(points, i) && (i === points.length - 1 || broken(points, i + 1)));
  const last = points[points.length - 1];
  const fmtV = (v: number) => fmtNum(v, decimals);
  const marks = points.filter((p) => p.mark);
  // Many points close together: the stretches outside the normal go as an amber line over the series, not as a dot
  // per point (a quarter of an hour of seconds would be a smear of dots).
  const dense = points.length > iw / 10;
  const markRuns = dense ? points.flatMap((p, i) => (p.mark ? [{ p, start: broken(points, i) || !points[i - 1].mark }] : [])) : [];
  const markPath = markRuns.map(({ p, start }) => (start ? "M" : "L") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1)).join(" ");
  const loneMarks = dense ? markRuns.filter((r, i) => r.start && (i === markRuns.length - 1 || markRuns[i + 1].start)).map((r) => r.p) : marks;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(X(p.t) - x); if (d < bd) { bd = d; best = i; } });
    setHover(best);
    setKbd(false);
  };
  // Touch and pen: a tap shows the value; sliding sideways follows the finger (the page still scrolls vertically).
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!points.length) return;
    if (e.key === "ArrowLeft") { setHover((h) => Math.max(0, (h ?? points.length) - 1)); setKbd(true); e.preventDefault(); }
    if (e.key === "ArrowRight") { setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); setKbd(true); e.preventDefault(); }
    if (e.key === "Escape") setHover(null);
  };
  const hp = hover != null ? points[hover] : null;
  const tipTime = (t: number) => chartTimeText(t, { date: rangeKey === "7d", seconds: rangeKey === "10m" });
  const minV = vals.reduce((a, v) => Math.min(a, v), Infinity), maxV = vals.reduce((a, v) => Math.max(a, v), -Infinity);
  const summary = points.length
    ? `${title}${legendLine ? ` (${legendLine.toLowerCase()})` : ""}: último valor ${fmtV(last.v)} ${unit}, mínimo ${fmtV(minV)}, máximo ${fmtV(maxV)}` +
      (marks.length ? `, ${marks.length} ${marks.length === 1 ? "momento" : "momentos"} fuera de lo normal.` : ".")
    : `${title}: sin datos en este periodo.`;
  // The episode is named on the plot when its shade is wide enough for the word; otherwise in the legend.
  const span = highlight && highlight.to >= t0 && highlight.from <= t1
    ? { x0: Math.max(m.l, X(highlight.from)), x1: Math.min(m.l + iw, X(highlight.to)) } : null;
  const spanNamed = !!span && !!highlight && span.x1 - span.x0 >= 8 * highlight.label.length + 8;
  // The word sits above the plot, over the left edge of the shade, where no grid line, normal-band edge
  // or series can run through it (inside the plot some line always came near it).
  const spanLabelY = m.t - 8;
  const legendSpan = !!highlight && !spanNamed;
  const legend = points.length > 0 && (legendLine || legendBand || legendSpan || (legendMarks && marks.length > 0));
  const waiting = loading && !points.length;
  const showDot = (showLast || showNow) && !!last;
  return (
    <figure ref={figRef} className={className ? `chart ${className}` : "chart"} aria-busy={waiting || undefined}>
      <figcaption className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          {sub && <div className="chart-sub">{sub}</div>}
        </div>
        {showNow && last && <div className="chart-now" aria-hidden="true"><strong>{fmtV(last.v)}</strong><span>{unit}</span></div>}
      </figcaption>
      <div ref={ref} style={{ position: "relative" }}>
        {waiting ? <div className="skeleton" style={{ height: H }} aria-hidden="true" />
          : !points.length ? <div className="chart-empty small muted" style={{ height: H }}>Sin datos en este periodo.</div> : (
          <svg width={W} height={H} role="img" aria-label={summary} tabIndex={0} style={{ touchAction: "pan-y" }}
            onPointerMove={onMove} onPointerDown={onDown} onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
            onPointerCancel={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
            <defs><clipPath id={clipId}><rect x={m.l} y={m.t} width={Math.max(0, iw)} height={Math.max(0, ih)} /></clipPath></defs>
            {zones?.map((z, i) => {
              const top = Y(Math.min(hi, z.to)), bottom = Y(Math.max(lo, z.from));
              // The colour runs under the label gutter; the label sits right of the latest point, so the line never covers it.
              return bottom - top > 0 ? (
                <g key={i}>
                  <rect className={`chart-zone-bg ${z.tone}`} x={m.l} width={W - m.l} y={top} height={bottom - top} />
                  {bottom - top >= 16 && (
                    <text x={W - 4} y={(top + bottom) / 2 + 4} textAnchor="end" className={`chart-zone ${z.tone}`}>{z.label}</text>
                  )}
                </g>
              ) : null;
            })}
            <text x={0} y={12} className="chart-unit">{unit}</text>
            {ticks.map((v) => (
              <g key={v}>
                {!zones?.length && <line className="chart-grid" x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} strokeWidth="1" />}
                <text x={m.l - 8} y={Y(v) + 4} textAnchor="end" className="chart-axis">{fmtNum(v, tickDecimals)}</text>
              </g>
            ))}
            {span && highlight && (
              <g>
                <rect className="chart-highlight" x={span.x0} width={Math.max(2, span.x1 - span.x0)} y={m.t} height={ih} />
                {spanNamed && <text className="chart-label" x={span.x0} y={spanLabelY}>{highlight.label}</text>}
              </g>
            )}
            {band && <rect className="chart-band" x={m.l} width={iw} y={Y(band[1])} height={Math.max(1, Y(band[0]) - Y(band[1]))} fill="var(--chart-baseline)" />}
            {band && [band[0], band[1]].filter((v) => v >= lo && v <= hi).map((v) => (
              <line key={`edge${v}`} className="chart-band-edge" x1={m.l} x2={m.l + iw} y1={Y(v)} y2={Y(v)} />
            ))}
            {!zones?.length && <line className="chart-baseline" x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />}
            {xticks.map((t, i) => (
              <text key={i} x={X(t)} y={H - 8} textAnchor={xticks.length === 1 && t1 <= t0 ? "middle" : i === 0 ? "start" : i === xticks.length - 1 ? "end" : "middle"} className="chart-axis">{xlabels[i]}</text>
            ))}
            {/* Several raw values per pixel (an hour of seconds on a phone): fainter, so the average stays the line read. */}
            {extra.length > 1 && (
              <path className={extra.length > 3 * iw ? "chart-detail is-dense" : "chart-detail"} d={line(extra, detailGapMs)} fill="none" strokeWidth="1" strokeLinejoin="round" clipPath={`url(#${clipId})`} />
            )}
            {points.length > 1 && extra.length > 0 && <path className="chart-halo" d={path} fill="none" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />}
            {points.length > 1 && <path className="chart-series" d={path} fill="none" stroke="var(--chart-line)" strokeWidth={extra.length ? 2.25 : 1.75} strokeLinejoin="round" strokeLinecap="round" />}
            {lone.map((p) => <circle key={`lone${p.t}`} cx={X(p.t)} cy={Y(p.v)} r="2.5" fill="var(--chart-line)" />)}
            {showDot && <circle cx={X(last.t)} cy={Y(last.v)} r="4" fill="var(--chart-line)" stroke="var(--color-sheet)" strokeWidth="2" />}
            {markPath && <path className="chart-mark-run" d={markPath} fill="none" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
            {loneMarks.map((p) => <circle key={p.t} cx={X(p.t)} cy={Y(p.v)} r={dense ? 2.5 : 3.5} fill="var(--chart-mark)" stroke="var(--color-sheet)" strokeWidth={dense ? 1 : 1.5} />)}
            {hp && (
              <g>
                <line className="chart-cursor" x1={X(hp.t)} x2={X(hp.t)} y1={m.t} y2={H - m.b} strokeWidth="1" />
                <circle cx={X(hp.t)} cy={Y(hp.v)} r="5" fill="var(--chart-line)" stroke="var(--color-sheet)" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}
        {hp && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(0, X(hp.t) - 60), W - 150), top: 0 }}>
            <strong>{fmtV(hp.v)} {unit}</strong><br />{tipTime(hp.t)}
            {hp.mark && legendMarks && <span className="chart-tip-flag">{legendMarks}</span>}
          </div>
        )}
        <p className="sr-only" aria-live="polite">{kbd && hp ? `${fmtV(hp.v)} ${unit}, ${tipTime(hp.t)}` : ""}</p>
      </div>
      {legend && (
        <div className="chart-legend">
          {legendLine && <span className="legend-key"><span className="key-line" />{legendLine}</span>}
          {legendDetail && extra.length > 1 && <span className="legend-key"><span className="key-detail" />{legendDetail}</span>}
          {legendSpan && highlight && <span className="legend-key"><span className="key-span" />{highlight.label}</span>}
          {legendBand && <span className="legend-key"><span className="key-band" />{legendBand}</span>}
          {legendMarks && marks.length > 0 && <span className="legend-key"><span className="key-mark" />{legendMarks}</span>}
        </div>
      )}
    </figure>
  );
}

/** A value against its normal range: the normal band in green, the value as a marker in the colour of the alert. */
export function RangeBar({ value, range, scale, color }: { value: number; range: [number, number]; scale: [number, number]; color?: string }) {
  const [a, b] = scale;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - a) / (b - a)) * 100));
  return (
    <div className="rangebar" aria-hidden="true" style={color ? { ["--marker-color" as string]: color } : undefined}>
      <div className="rangebar-normal" style={{ left: pos(range[0]) + "%", width: pos(range[1]) - pos(range[0]) + "%" }} />
      <div className="rangebar-marker" style={{ left: pos(value) + "%" }} />
    </div>
  );
}

/** Horizontal bars in one hue. */
export function BarList({ items }: { items: { label: string; value: number; display: string }[] }) {
  const top = Math.max(...items.map((i) => i.value), 0.0001);
  return (
    <div className="bars">
      {items.map((it) => (
        <div className="bar-row" key={it.label}>
          <div>{it.label}</div>
          <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: (it.value / top) * 100 + "%" }} /></div>
          <div className="bar-value">{it.display}</div>
        </div>
      ))}
    </div>
  );
}
