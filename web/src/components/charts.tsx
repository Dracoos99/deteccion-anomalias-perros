/* Charts in the Broadsheet style: SVG, no chart library. One series per chart, the dog's normal band shaded with thin
   edges, dashed reference lines, amber dots on unusual moments, crosshair with mouse, touch (tap or slide sideways)
   and keyboard (← → Esc, read aloud), and a text summary for screen readers. Look of the v3 mockups: serif
   title, legend under the plot, zone labels in their level colour inside the plot. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
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

function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export type RangeKey = "10m" | "1h" | "24h" | "7d";   // 10m: the live panel
const fmtHM = new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtHMS = new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const fmtWD = new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric" });
const fmtDM = new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short" });
const xLabel = (t: number, r: RangeKey) => (r === "7d" ? fmtWD.format(t) : fmtHM.format(t));

export interface ChartPoint { t: number; v: number; mark?: boolean }
/** A shaded band of values (the Health Score levels); `tone` gives its label the colour of the level. */
export interface Zone { from: number; to: number; fill: string; label: string; tone?: "green" | "amber" | "red" }

/** The Health Score levels as shaded zones, with the cuts of config/fusion. */
export function healthZones(levels: { green: number; amber: number }): Zone[] {
  return [
    { from: 0, to: levels.amber, fill: "var(--color-status-red-bg)", label: "Revisar", tone: "red" },
    { from: levels.amber, to: levels.green, fill: "var(--color-status-amber-bg)", label: "Atención", tone: "amber" },
    { from: levels.green, to: 100, fill: "var(--color-status-green-bg)", label: "Normal", tone: "green" },
  ];
}

export function TrendChart({ title, sub, points, unit, decimals = 0, rangeKey, band, refs = [], zones, domain, height,
  legendBand, legendRefs, legendMarks, gapMs, showLast = false, loading = false }: {
  title: string; sub?: string; points: ChartPoint[]; unit: string; decimals?: number; rangeKey: RangeKey;
  band?: [number, number] | null; refs?: { value: number; label: string }[]; zones?: Zone[]; domain?: [number, number];
  height?: number; legendBand?: string; legendRefs?: string; legendMarks?: string;
  /** The line breaks where two points are further apart than this (no data in between). */
  gapMs?: number;
  /** Dot on the latest point: "now" in the live panel. */
  showLast?: boolean;
  /** The data are still arriving: a placeholder instead of "Sin datos en este periodo". */
  loading?: boolean;
}) {
  const [ref, width] = useWidth();
  const figRef = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [kbd, setKbd] = useState(false);   // the crosshair moves with the keyboard: its value is read aloud
  // A tapped value stays until the next tap elsewhere (lifting the finger must not hide it).
  useEffect(() => {
    if (hover == null) return;
    const away = (e: Event) => { if (!figRef.current?.contains(e.target as Node)) setHover(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [hover]);
  // Zone labels and labelled reference lines get a gutter on the right; otherwise the plot runs to the edge.
  const m = { l: 36, r: zones?.length ? 56 : refs.length ? 44 : 10, t: 10, b: 24 };
  const W = width, H = height ?? (W < 480 ? 150 : 190), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = points.map((p) => p.v);
  let lo = Math.min(...vals, ...(band ?? []), ...refs.map((r) => r.value));
  let hi = Math.max(...vals, ...(band ?? []), ...refs.map((r) => r.value));
  if (domain) [lo, hi] = domain;
  else { const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad; }
  const t0 = points.length ? points[0].t : 0, t1 = points.length ? points[points.length - 1].t : 1;
  const X = (t: number) => m.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * ih;
  // With zones, the axis marks only their edges (the level cuts), with no grid over the colours.
  const ticks = zones?.length ? [...new Set([lo, hi, ...zones.flatMap((z) => [z.from, z.to])])].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b)
    : niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
  const fractions = W < 480 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];  // fewer labels on narrow screens
  const xticks = points.length > 1 ? fractions.map((f) => t0 + f * (t1 - t0)) : points.map((p) => p.t);
  const path = points.map((p, i) => (i && !(gapMs && p.t - points[i - 1].t > gapMs) ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1)).join(" ");
  const last = points[points.length - 1];
  const fmtV = (v: number) => fmtNum(v, decimals);
  const marks = points.filter((p) => p.mark);
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
  const tipTime = (t: number) => (rangeKey === "7d" ? `${fmtDM.format(t)}, ${fmtHM.format(t)}` : rangeKey === "10m" ? fmtHMS.format(t) : fmtHM.format(t));
  const summary = points.length
    ? `${title}: último valor ${fmtV(last.v)} ${unit}, mínimo ${fmtV(Math.min(...vals))}, máximo ${fmtV(Math.max(...vals))}` +
      (marks.length ? `, ${marks.length} ${marks.length === 1 ? "momento" : "momentos"} fuera de lo normal.` : ".")
    : `${title}: sin datos en este periodo.`;
  const legend = points.length > 0 && (legendBand || legendRefs || (legendMarks && marks.length > 0));
  const waiting = loading && !points.length;
  return (
    <figure ref={figRef} className="chart" style={{ margin: 0 }} aria-busy={waiting || undefined}>
      <figcaption>
        <div className="chart-title">{title}</div>
        {sub && <div className="chart-sub">{sub}</div>}
      </figcaption>
      <div ref={ref} style={{ position: "relative" }}>
        {waiting ? <div className="skeleton" style={{ height: H }} aria-hidden="true" />
          : !points.length ? <div className="chart-empty small muted" style={{ height: H }}>Sin datos en este periodo.</div> : (
          <svg width={W} height={H} role="img" aria-label={summary} tabIndex={0} style={{ touchAction: "pan-y" }}
            onPointerMove={onMove} onPointerDown={onDown} onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
            onPointerCancel={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {zones?.map((z, i) => {
              const top = Y(Math.min(hi, z.to)), bottom = Y(Math.max(lo, z.from));
              // The colour runs under the label gutter; the label sits right of the latest point, so the line never covers it.
              return (
                <g key={i}>
                  <rect x={m.l} width={W - m.l} y={top} height={Math.max(0, bottom - top)} fill={z.fill} />
                  {bottom - top >= 12 && (
                    <text x={W - 4} y={(top + bottom) / 2 + 3.5} textAnchor="end" className={`chart-zone${z.tone ? ` ${z.tone}` : ""}`}>{z.label}</text>
                  )}
                </g>
              );
            })}
            {ticks.map((v) => (
              <g key={v}>
                {!zones?.length && <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--chart-grid)" strokeWidth="1" />}
                <text x={m.l - 6} y={Y(v) + 3.5} textAnchor="end" className="chart-axis">{fmtNum(v, decimals && Math.abs(hi - lo) < 5 ? 1 : 0)}</text>
              </g>
            ))}
            {band && <rect className="chart-band" x={m.l} width={iw} y={Y(band[1])} height={Math.max(1, Y(band[0]) - Y(band[1]))} fill="var(--chart-baseline)" />}
            {band && [band[0], band[1]].filter((v) => v >= lo && v <= hi).map((v) => (
              <line key={`edge${v}`} className="chart-band-edge" x1={m.l} x2={m.l + iw} y1={Y(v)} y2={Y(v)} />
            ))}
            {refs.map((r) => (
              <g key={r.label}>
                <line x1={m.l} x2={W - m.r} y1={Y(r.value)} y2={Y(r.value)} stroke="var(--chart-ref)" strokeWidth="1.2" strokeDasharray="4 3" />
                {!zones && <text x={W - m.r + 6} y={Y(r.value) + 3.5} className="chart-axis">{r.label}</text>}
              </g>
            ))}
            {!zones?.length && <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--color-divider)" />}
            {xticks.map((t, i) => (
              <text key={i} x={X(t)} y={H - 7} textAnchor={i === 0 ? "start" : i === xticks.length - 1 ? "end" : "middle"} className="chart-axis">{xLabel(t, rangeKey)}</text>
            ))}
            {points.length > 1 && <path className="chart-series" d={path} fill="none" stroke="var(--chart-line)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}
            {showLast && last && <circle cx={X(last.t)} cy={Y(last.v)} r="3.5" fill="var(--chart-line)" stroke="var(--color-sheet)" strokeWidth="1.5" />}
            {marks.map((p) => <circle key={p.t} cx={X(p.t)} cy={Y(p.v)} r="3.5" fill="var(--chart-mark)" stroke="var(--color-sheet)" strokeWidth="1.5" />)}
            {hp && (
              <g>
                <line x1={X(hp.t)} x2={X(hp.t)} y1={m.t} y2={H - m.b} stroke="var(--color-text)" strokeWidth="1" />
                <circle cx={X(hp.t)} cy={Y(hp.v)} r="5" fill="var(--chart-line)" stroke="var(--color-sheet)" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}
        {hp && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(0, X(hp.t) - 60), W - 150), top: 0 }}>
            <strong>{fmtV(hp.v)} {unit}</strong><br />{tipTime(hp.t)}
          </div>
        )}
        <p className="sr-only" aria-live="polite">{kbd && hp ? `${fmtV(hp.v)} ${unit}, ${tipTime(hp.t)}` : ""}</p>
      </div>
      {legend && (
        <div className="chart-legend">
          {legendBand && <span className="legend-key"><span className="key-band" />{legendBand}</span>}
          {legendRefs && <span className="legend-key"><span className="key-dash" />{legendRefs}</span>}
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
