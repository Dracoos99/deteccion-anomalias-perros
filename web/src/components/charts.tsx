/* Charts in the Broadsheet style: SVG, no chart library. One series per chart, the dog's normal band shaded,
   dashed reference lines, marks on unusual moments, crosshair with pointer and keyboard (← → Esc), and a text
   summary for screen readers. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
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
export interface Zone { from: number; to: number; fill: string; label: string }

export function TrendChart({ title, sub, points, unit, decimals = 0, rangeKey, band, refs = [], zones, domain, height = 190,
  legendBand, legendRefs, legendMarks, gapMs }: {
  title: string; sub?: string; points: ChartPoint[]; unit: string; decimals?: number; rangeKey: RangeKey;
  band?: [number, number] | null; refs?: { value: number; label: string }[]; zones?: Zone[]; domain?: [number, number];
  height?: number; legendBand?: string; legendRefs?: string; legendMarks?: string;
  /** The line breaks where two points are further apart than this (no data in between). */
  gapMs?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 40, r: 44, t: 12, b: 26 };
  const W = width, H = height, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = points.map((p) => p.v);
  let lo = Math.min(...vals, ...(band ?? []), ...refs.map((r) => r.value));
  let hi = Math.max(...vals, ...(band ?? []), ...refs.map((r) => r.value));
  if (domain) [lo, hi] = domain;
  else { const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad; }
  const t0 = points.length ? points[0].t : 0, t1 = points.length ? points[points.length - 1].t : 1;
  const X = (t: number) => m.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * ih;
  const ticks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
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
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!points.length) return;
    if (e.key === "ArrowLeft") { setHover((h) => Math.max(0, (h ?? points.length) - 1)); e.preventDefault(); }
    if (e.key === "ArrowRight") { setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); e.preventDefault(); }
    if (e.key === "Escape") setHover(null);
  };
  const hp = hover != null ? points[hover] : null;
  const summary = points.length
    ? `${title}: último valor ${fmtV(last.v)} ${unit}, mínimo ${fmtV(Math.min(...vals))}, máximo ${fmtV(Math.max(...vals))}` +
      (marks.length ? `, ${marks.length} momentos fuera de lo normal.` : ".")
    : `${title}: sin datos en este periodo.`;
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption>
        <div className="chart-title">{title}</div>
        {sub && <div className="chart-sub">{sub}</div>}
        {(legendBand || legendRefs || (legendMarks && marks.length > 0)) && (
          <div className="chart-legend">
            <span className="legend-key"><span className="key-line" />{title}</span>
            {legendBand && <span className="legend-key"><span className="key-band" />{legendBand}</span>}
            {legendRefs && <span className="legend-key"><span className="key-dash" />{legendRefs}</span>}
            {legendMarks && marks.length > 0 && <span className="legend-key"><span className="key-mark" />{legendMarks}</span>}
          </div>
        )}
      </figcaption>
      <div ref={ref} style={{ position: "relative", marginTop: 6 }}>
        {!points.length ? <div className="chart-empty small muted" style={{ height: H }}>Sin datos en este periodo.</div> : (
          <svg width={W} height={H} role="img" aria-label={summary} tabIndex={0}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
            {zones?.map((z, i) => (
              <g key={i}>
                <rect x={m.l} width={iw} y={Y(Math.min(hi, z.to))} height={Math.max(0, Y(Math.max(lo, z.from)) - Y(Math.min(hi, z.to)))} fill={z.fill} opacity="0.55" />
                <text x={W - m.r + 6} y={(Y(Math.min(hi, z.to)) + Y(Math.max(lo, z.from))) / 2 + 3} className="chart-axis">{z.label}</text>
              </g>
            ))}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--chart-grid)" strokeWidth="1" />
                <text x={m.l - 6} y={Y(v) + 3.5} textAnchor="end" className="chart-axis">{fmtNum(v, decimals && Math.abs(hi - lo) < 5 ? 1 : 0)}</text>
              </g>
            ))}
            {band && <rect x={m.l} width={iw} y={Y(band[1])} height={Math.max(1, Y(band[0]) - Y(band[1]))} fill="var(--chart-baseline)" />}
            {refs.map((r) => (
              <g key={r.label}>
                <line x1={m.l} x2={W - m.r} y1={Y(r.value)} y2={Y(r.value)} stroke="var(--chart-ref)" strokeWidth="1.2" strokeDasharray="4 3" />
                {!zones && <text x={W - m.r + 6} y={Y(r.value) + 3.5} className="chart-axis">{r.label}</text>}
              </g>
            ))}
            <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--color-divider)" />
            {xticks.map((t, i) => (
              <text key={i} x={X(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === xticks.length - 1 ? "end" : "middle"} className="chart-axis">{xLabel(t, rangeKey)}</text>
            ))}
            {points.length > 1 && <path d={path} fill="none" stroke="var(--chart-line)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
            {marks.map((p) => <circle key={p.t} cx={X(p.t)} cy={Y(p.v)} r="4" fill="var(--color-sheet)" stroke="var(--color-status-red)" strokeWidth="2" />)}
            {last && <circle cx={X(last.t)} cy={Y(last.v)} r="4.5" fill="var(--chart-line)" stroke="var(--color-sheet)" strokeWidth="2" />}
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
            <strong>{fmtV(hp.v)} {unit}</strong><br />{rangeKey === "7d" ? `${fmtDM.format(hp.t)}, ${fmtHM.format(hp.t)}` : rangeKey === "10m" ? fmtHMS.format(hp.t) : fmtHM.format(hp.t)}
          </div>
        )}
      </div>
    </figure>
  );
}

/** A value against its normal range. */
export function RangeBar({ value, range, scale, unit, decimals = 0 }: { value: number; range: [number, number]; scale: [number, number]; unit: string; decimals?: number }) {
  const [a, b] = scale;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - a) / (b - a)) * 100));
  return (
    <div>
      <div className="rangebar" aria-hidden="true">
        <div className="rangebar-track" />
        <div className="rangebar-normal" style={{ left: pos(range[0]) + "%", width: pos(range[1]) - pos(range[0]) + "%" }} />
        <div className="rangebar-marker" style={{ left: pos(value) + "%" }} />
      </div>
      <div className="rangebar-labels"><span>{fmtNum(a, decimals)} {unit}</span><span>{fmtNum(b, decimals)} {unit}</span></div>
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
