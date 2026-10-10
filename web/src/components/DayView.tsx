/* «El día de …» and «Hoy frente a lo habitual»: a 24-hour band of the dog's day by behavior, with its alerts
   and its heart rate, and the day against the usual ones. From the 5-minute trend slots (lib/day.ts). */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DAY_MS, SLOT_MS, collectSlots, dayKey } from "@shared/trends";
import { useTrendDocs, type Alert, type Dog, type Fusion, type Viewer } from "../data/hooks";
import {
  DAY_GROUPS, GROUP_LABEL, compare, dayPhrase, daySegments, dayTotals, groupShares, localDayStart, restingHr, weekDays, weekPhrase, FULL_DAY_MS,
  type Comparison, type DayGroup, type DaySegment, type WeekDay,
} from "../lib/day";
import { alertStartMs, dayHeading, durationText, glueTime, hrBand } from "../lib/plain";
import { Icon, LEVELS, fmtNum } from "./ui";

const SLOTS = DAY_MS / SLOT_MS;   // 288
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const hourLabel = (h: number) => (h === 0 ? "12 a. m." : h === 12 ? "12 p. m." : String(h % 12));
const clock = (ms: number) => glueTime(new Date(ms).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" }));
const DAYS_BACK = 6;

export function DayView({ dog, cfg, viewer, alerts }: { dog: Dog; cfg: Fusion; viewer: Viewer; alerts: Alert[] }) {
  const anchor = dog.status?.lastBlockAt?.toMillis?.() ?? null;
  const anchorDay = anchor != null ? localDayStart(anchor) : null;
  const [back, setBack] = useState(0);
  const firstDay = anchorDay != null ? anchorDay - DAYS_BACK * DAY_MS : null;
  // One query for the week: the selected day and the usual ones (the days before it).
  const docs = useTrendDocs(dog.id, viewer, firstDay != null ? dayKey(firstDay) : null);
  const dayStart = anchorDay != null ? anchorDay - back * DAY_MS : null;
  const model = useMemo(() => {
    if (dayStart == null || firstDay == null) return null;
    const slots = collectSlots(docs.data, firstDay, anchorDay! + DAY_MS);
    const segments = daySegments(slots, dayStart);
    const totals = dayTotals(segments);
    // The usual days: those before the selected one, within the week, with enough classified time.
    const usual = [];
    for (let d = firstDay; d < dayStart; d += DAY_MS) {
      const seg = daySegments(slots, d);
      usual.push({ shares: groupShares(dayTotals(seg)), hr: restingHr(seg) });
    }
    const shares = groupShares(totals);
    const cmp: Partial<Record<DayGroup, Comparison | null>> = {};
    // At least a point and a half of the day, so 1 % against 2 % of play reads «como de costumbre».
    for (const g of DAY_GROUPS) cmp[g] = shares ? compare(shares[g], usual.map((u) => u.shares?.[g] ?? null), 0.015) : null;
    const hrToday = shares ? restingHr(segments) : null;
    const hrCmp = compare(hrToday, usual.map((u) => (u.shares ? u.hr : null)), 5, 0.1);
    // The week up to the dog's latest day, for «La semana».
    const week = weekDays(slots, anchorDay!, DAYS_BACK + 1);
    return { segments, totals, cmp, hrCmp, hasUsual: usual.some((u) => u.shares), week };
  }, [docs.data, dayStart, firstDay, anchorDay]);

  if (anchorDay == null) return null;
  if (docs.loading && !docs.data.length) return <section className="panel day-view" aria-busy="true"><div className="skeleton" style={{ height: 180 }} /></section>;
  if (!model) return null;
  const { segments, totals, cmp, hrCmp } = model;
  const isToday = back === 0;
  const heading = dayHeading(dayStart!);
  const phrase = dayPhrase(dog.name, cmp, isToday);
  return (
    <section className="panel stack-sm day-view" aria-labelledby="day-title">
      <div className="day-head">
        <div className="stack-xs">
          <h2 className="section-title" id="day-title">El día de {dog.name}</h2>
          <p className="small muted">{heading}{totals.dataMs > 0 ? ` · con datos de ${durationText(totals.dataMs)}` : " · sin datos"}</p>
        </div>
        <div className="day-nav" role="group" aria-label="Elegir el día">
          <button className="btn btn-secondary btn-icon" type="button" onClick={() => setBack((b) => Math.min(DAYS_BACK, b + 1))} disabled={back >= DAYS_BACK} aria-label="Día anterior"><Icon name="chevron-left" size={16} /></button>
          <button className="btn btn-secondary btn-icon" type="button" onClick={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} aria-label="Día siguiente"><Icon name="chevron-right" size={16} /></button>
        </div>
      </div>
      {segments.length ? (
        <>
          {phrase && <p className="day-phrase">{phrase}</p>}
          <DayBand segments={segments} dayStart={dayStart!} alerts={alerts} name={dog.name} />
          <HeartLine segments={segments} band={hrBand(dog.baseline, cfg)} />
          <ul className="day-legend" aria-label="Tiempo por conducta">
            {DAY_GROUPS.map((g) => (
              <li key={g}><span className="day-swatch" data-group={g} aria-hidden="true" />{GROUP_LABEL[g]}<strong>{totals.ms[g] > 0 ? durationText(totals.ms[g]) : "—"}</strong></li>
            ))}
          </ul>
          {totals.classifiedMs < totals.dataMs * 0.5 && (
            <p className="xs muted">Parte del día no tiene conducta: el modelo la reconoce cuando ya aprendió el patrón normal de {dog.name}.</p>
          )}
          <p className="xs muted">Sentado, parado y echado se muestran juntos como «Descansando»: el collar las distingue sobre todo por la inclinación del cuello y el modelo las confunde entre sí; caminar, trotar, jugar y olfatear las reconoce bien.</p>
          <UsualPanel name={dog.name} cmp={cmp} hrCmp={hrCmp} isToday={isToday} hasUsual={model.hasUsual} />
          <WeekPanel name={dog.name} week={model.week} selected={dayStart!} onPick={(d) => {
            setBack(Math.round((anchorDay - d) / DAY_MS));
            // The chosen day opens above: bring it into view.
            window.requestAnimationFrame(() => document.getElementById("day-title")?.scrollIntoView({ block: "start", behavior: "smooth" }));
          }} />
        </>
      ) : (
        <p className="small muted">No hay datos de {dog.name} en este día.</p>
      )}
    </section>
  );
}

/** The 24-hour band: one cell per 5-minute slot coloured by its main behavior (lighter when mixed), the alerts on top,
 * and the slot under the pointer or the arrow keys described in words. */
function DayBand({ segments, dayStart, alerts, name }: { segments: DaySegment[]; dayStart: number; alerts: Alert[]; name: string }) {
  const [sel, setSel] = useState<number | null>(null);
  const byIndex = useMemo(() => new Map(segments.map((s) => [Math.round((s.t - dayStart) / SLOT_MS), s])), [segments, dayStart]);
  const indices = useMemo(() => [...byIndex.keys()].sort((a, b) => a - b), [byIndex]);
  const episodes = alerts.flatMap((a) => {
    const from = alertStartMs(a), to = a.endedAt?.toMillis?.() ?? from + SLOT_MS;
    if (to < dayStart || from >= dayStart + DAY_MS) return [];
    return [{ id: a.id, severity: a.severity, x0: Math.max(0, (from - dayStart) / SLOT_MS), x1: Math.min(SLOTS, Math.max((to - dayStart) / SLOT_MS, (from - dayStart) / SLOT_MS + 1)) }];
  });
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * SLOTS);
    setSel(byIndex.has(i) ? i : nearest(indices, i));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!indices.length) return;
    const pos = sel == null ? -1 : indices.indexOf(sel);
    const next = { ArrowRight: pos + 1, ArrowLeft: pos <= 0 ? 0 : pos - 1, Home: 0, End: indices.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    setSel(indices[Math.max(0, Math.min(indices.length - 1, next))]);
  };
  const s = sel != null ? byIndex.get(sel) ?? null : null;
  return (
    <div className="day-band-wrap">
      <div className="day-band" tabIndex={0} role="group" aria-label={`Día de ${name} por conducta. Usa las flechas para recorrerlo.`}
        onPointerMove={pick} onPointerDown={pick} onKeyDown={onKey}>
        <svg viewBox={`0 0 ${SLOTS} 40`} preserveAspectRatio="none" aria-hidden="true">
          <rect className="day-empty" x={0} y={8} width={SLOTS} height={32} />
          {segments.map((g) => {
            const i = Math.round((g.t - dayStart) / SLOT_MS);
            return <rect key={i} className="day-cell" data-group={g.group ?? "none"} x={i} y={8} width={1.02} height={32} style={{ opacity: g.group ? 0.45 + 0.55 * g.share : 1 }} />;
          })}
          {episodes.map((ep) => <rect key={ep.id} className="day-alert" data-level={ep.severity} x={ep.x0} y={0} width={ep.x1 - ep.x0} height={5} />)}
          {sel != null && <rect className="day-sel" x={sel} y={6} width={1.02} height={34} />}
        </svg>
      </div>
      <div className="day-hours" aria-hidden="true">{HOURS.map((h) => <span key={h} style={{ left: `${(100 * h) / 24}%` }}>{hourLabel(h)}</span>)}</div>
      <p className="day-caption small" aria-live="polite">{s ? captionOf(s) : episodes.length
        ? <><span className="day-alert-key" aria-hidden="true" />Marcas de arriba: alertas, del color de su nivel. Toca la banda o usa las flechas para ver cada tramo.</>
        : "Toca la banda o usa las flechas para ver cada tramo de 5 minutos."}</p>
      {episodes.length > 0 && <span className="sr-only">{`${episodes.length} ${episodes.length === 1 ? "alerta" : "alertas"} este día: ${episodes.map((ep) => LEVELS[ep.severity].text).join(", ")}.`}</span>}
    </div>
  );
}

function nearest(sorted: number[], i: number): number | null {
  if (!sorted.length) return null;
  return sorted.reduce((best, x) => (Math.abs(x - i) < Math.abs(best - i) ? x : best), sorted[0]);
}

function captionOf(s: DaySegment): string {
  const range = `${clock(s.t)} – ${clock(s.t + SLOT_MS)}`;
  const classified = DAY_GROUPS.reduce((a, g) => a + s.counts[g], 0);
  const parts = classified
    ? DAY_GROUPS.filter((g) => s.counts[g] > 0).sort((a, b) => s.counts[b] - s.counts[a])
      .map((g) => `${GROUP_LABEL[g].toLowerCase()} ${Math.round((100 * s.counts[g]) / classified)} %`).join(", ")
    : "sin conducta reconocida";
  return `${range}: ${parts}${s.hr != null ? ` · corazón ${fmtNum(s.hr)} lpm` : ""}.`;
}

/** The heart rate of the day (mean of each slot) as a thin line over the dog's normal band. */
function HeartLine({ segments, band }: { segments: DaySegment[]; band: [number, number] | null }) {
  const pts = segments.filter((s) => s.hr != null);
  if (pts.length < 2) return null;
  const values = pts.map((s) => s.hr!);
  const lo = Math.min(...values, band?.[0] ?? Infinity) - 5, hi = Math.max(...values, band?.[1] ?? -Infinity) + 5;
  const dayStart = localDayStart(pts[0].t);
  const y = (v: number) => 30 - (28 * (v - lo)) / Math.max(1, hi - lo);
  let d = "", prev: number | null = null;
  for (const s of pts) {
    const x = (s.t - dayStart) / SLOT_MS + 0.5;
    d += `${prev != null && x - prev > 3 ? "M" : d ? "L" : "M"}${x.toFixed(1)} ${y(s.hr!).toFixed(1)} `;
    prev = x;
  }
  return (
    <div className="day-heart">
      <span className="xs muted day-heart-label"><Icon name="heart" size={12} />Corazón: {fmtNum(Math.min(...values))}–{fmtNum(Math.max(...values))} lpm{band ? ` · lo normal, ${band[0]}–${band[1]}` : ""}</span>
      <svg viewBox={`0 0 ${SLOTS} 32`} preserveAspectRatio="none" aria-hidden="true">
        {band && <rect className="day-heart-band" x={0} y={y(band[1])} width={SLOTS} height={Math.max(0.5, y(band[0]) - y(band[1]))} />}
        <path className="day-heart-line" d={d} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const pct = (x: number) => `${fmtNum(100 * x)} %`;
const ARROW: Record<NonNullable<Comparison["trend"]>, string> = { more: "Más que de costumbre", less: "Menos que de costumbre", same: "Como de costumbre" };

/** «Hoy frente a lo habitual»: each group's share of the day against the usual days of the week, and the resting heart
 * rate. Only with an hour of classified data on both sides (lib/day.ts, MIN_COMPARE_MS). */
function UsualPanel({ name, cmp, hrCmp, isToday, hasUsual }: { name: string; cmp: Partial<Record<DayGroup, Comparison | null>>; hrCmp: Comparison | null; isToday: boolean; hasUsual: boolean }) {
  const shown = DAY_GROUPS.filter((g) => cmp[g]);
  if (!shown.length) return <p className="xs muted">Para comparar {isToday ? "hoy" : "este día"} con lo habitual hace falta al menos 1 h de conducta reconocida en el día.</p>;
  return (
    <div className="usual" aria-labelledby="usual-title">
      <h3 className="usual-title" id="usual-title">{isToday ? "Hoy" : "Este día"} frente a lo habitual</h3>
      {!hasUsual && <p className="xs muted">Todavía no hay otros días con datos suficientes esta semana: por ahora solo se ve cómo repartió {isToday ? "hoy" : "este día"} su tiempo.</p>}
      <ul className="usual-grid">
        {shown.map((g) => {
          const c = cmp[g]!;
          return (
            <li key={g} className="usual-tile" data-trend={c.trend ?? "none"}>
              <span className="usual-name"><span className="day-swatch" data-group={g} aria-hidden="true" />{GROUP_LABEL[g]}</span>
              <span className="usual-value">{pct(c.today)}</span>
              <span className="xs muted">{c.usual != null ? <>de costumbre {pct(c.usual)}{c.trend ? <> · {ARROW[c.trend].toLowerCase()}</> : null}</> : "del tiempo con conducta"}</span>
            </li>
          );
        })}
        {hrCmp && (
          <li className="usual-tile" data-trend={hrCmp.trend ?? "none"}>
            <span className="usual-name"><Icon name="heart" size={12} />Corazón en reposo</span>
            <span className="usual-value">{fmtNum(hrCmp.today)} lpm</span>
            <span className="xs muted">{hrCmp.usual != null ? <>de costumbre {fmtNum(hrCmp.usual)} lpm{hrCmp.trend ? <> · {ARROW[hrCmp.trend].toLowerCase()}</> : null}</> : "promedio mientras descansa"}</span>
          </li>
        )}
      </ul>
      <p className="xs muted">Compara la parte del tiempo de cada conducta, no los minutos, así un día con menos datos se compara igual. Lo habitual es el promedio de los días anteriores de la semana con al menos 1 h de datos. No es un diagnóstico: solo dice si {name} repartió su tiempo distinto de costumbre.</p>
    </div>
  );
}

const weekday = (ms: number) => new Date(ms).toLocaleDateString("es-PE", { weekday: "long" });
/** «53 min», «1 h 5»: short enough for seven bars on a phone. */
const compact = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}`; };
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("es-PE", { weekday: "short" }).replace(".", "");

/** «La semana»: the time in movement of each of the last 7 days as bars (a bar opens its day above), and one
 * sentence with the mean, the most active day and the trend of the last days. */
function WeekPanel({ name, week, selected, onPick }: { name: string; week: WeekDay[]; selected: number; onPick: (dayStart: number) => void }) {
  const max = Math.max(...week.map((d) => d.movingMs), 1);
  const phrase = weekPhrase(name, week, weekday, durationText);
  return (
    <div className="week" aria-labelledby="week-title">
      <h3 className="week-title" id="week-title">La semana</h3>
      {phrase ? <p className="small">{phrase}</p> : <p className="xs muted">Con al menos 1 h de datos en dos días de la semana, aquí verás cómo se movió cada día.</p>}
      <ul className="week-bars" aria-label="Tiempo en movimiento por día">
        {week.map((d) => {
          const empty = d.dataMs === 0;
          // A day with data for only part of it is drawn lighter, so its minutes are not read as a full day.
          const partial = !empty && d.dataMs < FULL_DAY_MS;
          return (
            <li key={d.dayStart}>
              <button type="button" className="week-bar btn-plain" data-current={d.dayStart === selected ? "true" : undefined} data-empty={empty ? "true" : undefined} data-partial={partial ? "true" : undefined}
                onClick={() => onPick(d.dayStart)} aria-pressed={d.dayStart === selected}
                aria-label={`${weekday(d.dayStart)}: ${empty ? "sin datos" : `${durationText(d.movingMs)} en movimiento${partial ? `, con datos de ${durationText(d.dataMs)}` : ""}`}`}>
                <span className="week-value">{empty ? "—" : compact(d.movingMs)}</span>
                <span className="week-bar-track" aria-hidden="true"><span className="week-bar-fill" style={{ height: `${Math.round((100 * d.movingMs) / max)}%` }} /></span>
                <span>{shortDay(d.dayStart)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="xs muted">Movimiento: caminar, trotar, jugar y olfatear. Más claras, los días con datos de solo una parte del día (no se comparan en minutos). Toca un día para verlo arriba.</p>
    </div>
  );
}
