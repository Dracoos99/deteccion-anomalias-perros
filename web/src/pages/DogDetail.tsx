/* Screen 3 · Detalle del perro: state, trends of the last hour, day or week with the dog's normal band,
   what is normal for this dog, and its alerts, then the "En vivo" panel. Charts are anchored at the dog's latest data
. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { rebucket, summarize, toPoint } from "@shared/trends";
import { useAuth } from "../auth/AuthContext";
import { BarList, TrendChart, healthDomain, healthZones, type ChartPoint } from "../components/charts";
import {
  Callout, DataTime, EmptyState, Icon, LevelTag, Notice, PageHead, PageLoading, ScoreTile, Seg, StateTag, fmtNum, levelVars, useFreshness, useNow, useOnline,
  usePageTitle, useSteadyScore,
} from "../components/ui";
import { LivePanel } from "../components/LivePanel";
import { DayView } from "../components/DayView";
import { useDog, useDogAlerts, useFusionConfig, type Dog, type Fusion } from "../data/hooks";
import { RANGES, useDogTrend, type DogTrend, type RangeKey } from "../data/useDogTrend";
import { simulatedTime } from "../lib/live";
import {
  BEHAVIOR_LABEL, DEMO_TEMP_NOTE, LEARNING_TEXT, aheadNote, activityBand, ageText, coverageText, describeDog, endSentence, hrBand, isLearning, marksNote,
  durationText, scoreNote, shownScore, whenPhrase,
} from "../lib/plain";
import { AlertBanner } from "../components/AlertBanner";
import { AlertItem } from "../components/AlertItem";
import { BaselineProgress, LearnedBanner } from "../components/BaselineProgress";

type Tab = "resumen" | "dia" | "actividad" | "corazon" | "temperatura" | "alertas";
const TABS: { key: Tab; label: string }[] = [
  { key: "resumen", label: "Resumen" }, { key: "dia", label: "Su día" }, { key: "actividad", label: "Actividad" }, { key: "corazon", label: "Corazón" },
  { key: "temperatura", label: "Temperatura" }, { key: "alertas", label: "Alertas" },
];
const ALERTS_PAGE = 50;
/** The share of time in movement behind its 20-minute average, per minute in 1 h, per 5 minutes in 24 h
 * and per hour in 7 days (finer would be a grey smear). */
const MOVEMENT_DETAIL: Record<RangeKey, { ms: number; label: string }> = {
  "1h": { ms: 60_000, label: "Cada minuto" }, "24h": { ms: 300_000, label: "Cada 5 minutos" }, "7d": { ms: 3_600_000, label: "Cada hora" },
};
const AVERAGE_LABEL: Record<RangeKey, string> = { "1h": "Promedio de 1 minuto", "24h": "Promedio de cada minuto", "7d": "Promedio de cada hora" };

const pct = (x: number) => fmtNum(100 * x);
const outside = (v: number, band: [number, number] | null | undefined) => !!band && (v < band[0] || v > band[1]);

function series(trend: DogTrend, pick: (p: DogTrend["points"][number]) => number | null, band?: [number, number] | null): ChartPoint[] {
  return trend.points.flatMap((p) => {
    const v = pick(p);
    return v == null ? [] : [{ t: p.t, v, mark: outside(v, band) }];
  });
}

function NormalForDog({ dog, cfg }: { dog: Dog; cfg: Fusion }) {
  const b = dog.baseline;
  if (!b) {
    return (
      <div className="stack-sm">
        <p className="small muted">Todavía no hay suficientes datos para saber qué es normal para {dog.name}{dog.status?.baselineProgress ? ": lo estamos aprendiendo (arriba, «Período de aprendizaje»)" : ""}.</p>
      </div>
    );
  }
  const act = activityBand(b, cfg), hr = hrBand(b, cfg);
  // In plain words; how each value is averaged is in the vet view.
  return (
    <>
    <ul className="normal-list">
      <li><span className="icon-chip"><Icon name="paw" size={16} /></span><span>Suele moverse cerca del <strong>{pct(b.activeRatioMean)} %</strong> del tiempo{act && <>. Lo normal para {dog.name} es moverse entre el {pct(act[0])} % y el {pct(act[1])} % del tiempo</>}.</span></li>
      {hr
        ? <li><span className="icon-chip"><Icon name="heart" size={16} /></span><span>Su corazón suele latir entre <strong>{hr[0]} y {hr[1]} lpm</strong>.{dog.status?.physioModel && <> El sistema también revisa si su ritmo cambia de una forma poco habitual.</>}</span></li>
        : <li><span className="icon-chip"><Icon name="heart" size={16} /></span><span>Sus datos no traían frecuencia cardiaca: por ahora no se vigila.</span></li>}
      {b.tempMean != null
        ? <li><span className="icon-chip"><Icon name="thermometer" size={16} /></span><span>Su temperatura habitual es de <strong>{fmtNum(b.tempMean, 1)} °C</strong> (lo normal para un perro: {fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>
        : <li><span className="icon-chip"><Icon name="thermometer" size={16} /></span><span>Sus datos no traían temperatura: se vigila solo si llega, con lo normal para un perro ({fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>}
    </ul>
    {/* Where this normal pattern comes from. */}
    <p className="xs muted">{b.origin === "function"
      // The data it was actually learned with (its windows of 2 s), not the current setting.
      ? <>{endSentence(`Lo aprendimos con ${durationText((b.samples ?? 0) * 2000)} de sus primeros datos por etapa${b.computedAt?.toMillis ? `; última actualización ${whenPhrase(b.computedAt.toMillis())}` : ""}`)}</>
      : <>Calculado con sus datos de demostración.</>}</p>
    </>
  );
}

function ChartPanel({ children }: { children: ReactNode }) {
  return <section className="panel stack-sm">{children}</section>;
}

/** The tab row scrolls sideways on narrow phones: a fade at the right edge says there is more. */
function useOverflowCue(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => { el.dataset.overflow = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", update); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function DogDetail() {
  const { dogId } = useParams();
  const location = useLocation();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dog, loading, error } = useDog(dogId);
  usePageTitle(dog?.name ?? "Perro");
  const { data: cfg } = useFusionConfig();
  const [range, setRange] = useState<RangeKey>("24h");
  const [tab, setTab] = useState<Tab>("resumen");
  const [alertsMax, setAlertsMax] = useState(ALERTS_PAGE);
  const r = RANGES[range];
  const trend = useDogTrend(dog, viewer, r.ms, cfg, r.bucketMs, r.tier);
  const gapMs = 3 * r.bucketMs;   // no line across missing data
  const { data: alerts, loading: alertsLoading } = useDogAlerts(dog?.id, viewer, alertsMax);
  const { freshness, shownMs } = useFreshness(dog?.status);
  const now = useNow(30_000);
  const online = useOnline();
  // The figure holds while the stable score drifts a point or two. Before any return.
  const newestOpenAll = alerts.find((a) => a.status === "open");
  const steady = useSteadyScore(shownScore(dog?.status, !!newestOpenAll && !newestOpenAll.endedAt).score, cfg.levels);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useOverflowCue(tabsRef, [loading, !!dog?.status, alerts.length > 0]);
  // «Ver qué es normal» (the notice of a learned baseline) opens the summary at «Qué es normal para …».
  useEffect(() => {
    if (loading || location.hash !== "#normal") return;
    setTab("resumen");
    // The charts above load after the page, so the section moves: scroll again once they settle.
    const go = () => document.getElementById("normal")?.scrollIntoView({ block: "start" });
    const timers = [100, 700, 1600].map((ms) => window.setTimeout(go, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [loading, location.hash]);

  if (loading) return <PageLoading text="Cargando a tu perro…" shape="detail" />;
  if (error || !dog) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos este perro" text="Puede que la dirección no sea correcta o que no tengas acceso."
          action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
      </main>
    );
  }
  const s = dog.status;
  const stale = freshness === "stale";
  // The stable level and score; a dog still learning shows a neutral state and no score.
  // Old data show no score; while an alert goes on, the phrase names its main reason.
  const newestOpen = newestOpenAll;
  const ongoing = !!newestOpen && !newestOpen.endedAt;
  const score = steady;
  const learning = !stale && isLearning(s, dog.baseline);
  // The collar seems off: a state of the sensor, shown instead of the dog's level.
  const sensorOff = !stale && s?.sensor === "no_wear";
  const neutral = stale || learning || sensorOff;
  const d = describeDog(s, dog.baseline, cfg, newestOpen, ongoing, { key: dog.id });
  const level = d.level;
  // Data written ahead of the clock keep their note after the simulation stopped.
  const simulated = !!s && simulatedTime(s.lastBlockAt?.toMillis?.(), s.updatedAt?.toMillis?.(), now);
  // The dog's own count (kept by the Function), not the open alerts among the newest 50.
  const openAlerts = s?.openAlerts ?? alerts.filter((a) => a.status === "open").length;
  // A dog without any data yet: one clear next step instead of empty tabs and charts.
  const noData = !s && !alerts.length;
  const selectTab = (k: Tab) => {
    setTab(k);
    document.getElementById(`tabbtn-${k}`)?.scrollIntoView({ inline: "center", block: "nearest" });
  };
  // Tabs pattern (WAI-ARIA): arrows, Home and End move between tabs; Tab goes into the panel.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const k = TABS[(next + TABS.length) % TABS.length].key;
    selectTab(k);
    document.getElementById(`tabbtn-${k}`)?.focus();
  };
  const canEdit = isAdmin || dog.ownerId === user!.uid;
  const firstT = Math.min(trend.points[0]?.t ?? Infinity, trend.hr?.[0]?.t ?? Infinity);
  const sub = trend.end && trend.start != null
    ? coverageText(r.text, trend.start, trend.end, Number.isFinite(firstT) ? firstT : null, Math.max(3 * r.bucketMs, 0.02 * r.ms)) : undefined;
  const aBand = activityBand(dog.baseline, cfg), hBand = hrBand(dog.baseline, cfg);
  const aBandPct: [number, number] | null = aBand && [100 * aBand[0], 100 * aBand[1]];
  const avgMin = cfg.activity.timeConstantS / 60;
  const moveDetail = MOVEMENT_DETAIL[range];
  const movement = rebucket(trend.items, moveDetail.ms).map(toPoint)
    .flatMap((p) => (p.activity == null ? [] : [{ t: p.t, v: 100 * p.activity }]));
  const summary = summarize(trend.items);
  const empty = !trend.loading && !trend.points.length;
  const weight = dog.weightKg ? `${fmtNum(dog.weightKg, Number.isInteger(dog.weightKg) ? 0 : 1)} kg` : null;
  const savedOffline = (location.state as { offlineSaved?: boolean } | null)?.offlineSaved;
  const levels = cfg.levels;
  const stableMin = Math.round((cfg.stableTimeConstantS ?? 300) / 60);

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/">Inicio</Link><span aria-hidden="true">›</span><span>{dog.name}</span></nav>
      <PageHead title={dog.name} sub={[dog.breed, ageText(dog.birthDate), weight].filter(Boolean).join(" · ") || undefined}
        actions={<>
          <Link className="btn btn-secondary btn-sm" to={`/perros/${dog.id}/veterinario`}><Icon name="stethoscope" size={14} />Vista para el veterinario</Link>
          {canEdit && <Link className="btn btn-secondary btn-sm" to={`/perros/${dog.id}/editar`}>Editar perfil</Link>}
        </>} />
      <div className="stack">
        {savedOffline && <Callout kind="ok">Sin conexión: guardaremos los cambios cuando vuelvas a conectarte.</Callout>}
        <div className="bezel">
          <section className="panel dog-state" aria-label="Estado actual" data-level={stale ? "stale" : sensorOff ? "sensor" : learning ? "learning" : level ?? "none"} style={levelVars(neutral ? null : level)}>
            {/* On wide screens the state and its phrase are one column and the figure with what explains it is
                the other; on a phone both wrappers disappear and the places are the ones of the grid areas. */}
            <div className="dog-state-left">
              <div className="dog-state-tag"><StateTag level={level} learning={learning} stale={stale} sensorOff={sensorOff} /></div>
              <div className="stack-sm dog-state-main">
                <p className="dog-phrase">{stale && shownMs != null ? endSentence(`No recibimos datos de ${dog.name} desde ${whenPhrase(shownMs)}`) : d.phrase}</p>
                {stale && <div className="last-state small">Último estado: {isLearning(s, dog.baseline) ? LEARNING_TEXT : <LevelTag level={level} iconSize={12} />}</div>}
                {!stale && d.todo && <p className="small">{d.todo}</p>}
                {/* The alert waiting for the owner is part of the state, so it shows on the
                    first screen of the detail, not only as a tab that a phone cuts off. */}
                {newestOpen && <AlertBanner alert={newestOpen} dogLevel={neutral ? null : level} source={s?.lastSource} present={d.titleStill !== false} />}
                {!s && (
                  <>
                    <p className="small muted">Sus gráficos y su patrón normal aparecerán cuando lleguen sus primeras lecturas.</p>
                    {canEdit && <div><Link className="btn btn-primary" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" />Cargar sus datos</Link></div>}
                  </>
                )}
              </div>
            </div>
            {s && !learning && !stale && !sensorOff && (
              <div className="dog-state-aside">
                <ScoreTile score={score} variant="glass" average={stableMin} />
                {/* Why the level is «Atención» first, then what the figure is (the average of the last
                    minutes, apart from the «ahora» of the «En vivo» panel). */}
                <div className="dog-state-notes">
                  {d.levelNote && <p className="dog-note-why">{d.levelNote}</p>}
                  <p>{scoreNote(cfg)}</p>
                </div>
              </div>
            )}
            {s && freshness && (
              <div className="dog-state-meta">
                <div className="data-time"><DataTime freshness={sensorOff && freshness === "live" ? "recent" : freshness} shownMs={shownMs} /></div>
                {simulated && <p className="xs muted">{aheadNote(s?.lastSource)}</p>}
              </div>
            )}
          </section>
        </div>
        {/* The learning period in full right under the state, and the notice for a day after it ended. */}
        {!stale && s?.baselineProgress && <div className="panel"><BaselineProgress dog={dog} cfg={cfg} full /></div>}
        <LearnedBanner dog={dog} linkToNormal={false} />

        {noData ? (
          <section className="panel stack-sm" id="normal">
            <h2 className="section-title">Qué es normal para {dog.name}</h2>
            <NormalForDog dog={dog} cfg={cfg} />
          </section>
        ) : <>
        <div className="detail-controls">
        <div className="tabs" role="tablist" aria-label="Secciones del detalle" onKeyDown={onTabKey} ref={tabsRef}>
            {TABS.map((t) => (
              <button key={t.key} id={`tabbtn-${t.key}`} type="button" role="tab" aria-selected={tab === t.key} aria-controls={tab === t.key ? `tab-${t.key}` : undefined}
                tabIndex={tab === t.key ? 0 : -1} onClick={() => selectTab(t.key)}>{t.label}{t.key === "alertas" && openAlerts > 0 && <span className="tab-count">{openAlerts}<span className="sr-only"> {openAlerts === 1 ? "nueva" : "nuevas"}</span></span>}</button>
            ))}
        </div>
        {tab !== "alertas" && tab !== "dia" && (
          <div className="period-row"><Seg label="Periodo" options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({ value: k, label: RANGES[k].label }))} value={range} onChange={setRange} /></div>
        )}
        </div>

        <div id={`tab-${tab}`} role="tabpanel" aria-labelledby={`tabbtn-${tab}`} className="stack">
          {trend.error && <Callout kind="error">No pudimos cargar las tendencias. Revisa tu conexión e inténtalo de nuevo.</Callout>}
          {tab !== "alertas" && tab !== "dia" && empty && (
            <EmptyState icon="clock" title="Sin datos en este periodo" text={`Cuando lleguen datos de ${dog.name}, aquí verás cómo evolucionan.`}
              action={canEdit && !s ? <Link className="btn btn-secondary" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" />Cargar sus datos</Link> : undefined} />
          )}

          {tab === "resumen" && !empty && (
            <div className="detail-two">
              {/* While it learns its normal pattern the dog has no Health Score (its state
                  says «Aprendiendo»), so no chart draws one at 100 over «Normal». */}
              {learning ? (
                <ChartPanel>
                  <h2 className="section-title">Health Score</h2>
                  <p className="small muted">El Health Score aparece cuando aprendamos el patrón normal de {dog.name}. Mientras tanto, solo se revisan los rangos de referencia.</p>
                </ChartPanel>
              ) : (
              <ChartPanel>
                <TrendChart title="Health Score" sub={sub} rangeKey={range} gapMs={gapMs} unit="puntos" domain={healthDomain(levels, trend.points.flatMap((p) => (p.healthScore == null ? [] : [p.healthScore])))} loading={trend.loading}
                  points={trend.points.flatMap((p) => (p.healthScore == null ? [] : [{ t: p.t, v: p.healthScore, mark: p.healthScore < levels.green }]))}
                  zones={healthZones(levels)} legendMarks="Momentos fuera de lo normal" />
                <p className="chart-note"><strong>Puede estar en «Atención» con {levels.green} o más.</strong> Pasa si la temperatura o el corazón salen de lo normal, si se mueve menos de lo habitual o si hay una alerta en curso.</p>
                <p className="chart-note">El número va de 0 a 100: «Todo normal» desde {levels.green}, «Atención» de {levels.amber} a {levels.green - 1} y «Revisar» bajo {levels.amber}. Un momento bajo que dura poco no cambia el estado de arriba.</p>
              </ChartPanel>
              )}
              <section className="panel stack-sm" id="normal">
                <h2 className="section-title">Qué es normal para {dog.name}</h2>
                <NormalForDog dog={dog} cfg={cfg} />
              </section>
            </div>
          )}
          {tab === "resumen" && empty && (
            <section className="panel stack-sm" id="normal">
              <h2 className="section-title">Qué es normal para {dog.name}</h2>
              <NormalForDog dog={dog} cfg={cfg} />
            </section>
          )}

          {/* The dog's day by behavior and against the usual days. It reads its own week of slots. */}
          {tab === "dia" && <DayView dog={dog} cfg={cfg} viewer={viewer} alerts={alerts} />}

          {tab === "actividad" && !empty && (
            <div className="detail-two">
              <ChartPanel>
                <TrendChart title="Tiempo en movimiento" sub={sub} rangeKey={range} gapMs={gapMs} unit="%" domain={[0, 100]} loading={trend.loading} showNow
                  points={series(trend, (p) => (p.activityAvg == null ? null : 100 * p.activityAvg), aBandPct)} detail={movement} detailGapMs={3 * moveDetail.ms}
                  band={aBandPct} legendLine={`Promedio de ${avgMin} minutos`} legendDetail={moveDetail.label}
                  legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
                <p className="chart-note">La línea oscura es el promedio de los últimos {avgMin} minutos: es la que se compara con lo normal para {dog.name}. La clara sube y baja con cada paseo o siesta.</p>
                <p className="chart-note">{marksNote(dog.name)}</p>
              </ChartPanel>
              {summary.behaviors.length > 0 && (
                <section className="panel stack-sm">
                  <h2 className="section-title">Qué hizo en este periodo</h2>
                  <BarList items={summary.behaviors.map((b) => ({ label: BEHAVIOR_LABEL[b.behavior], value: b.share, display: `${pct(b.share)} %` }))} />
                  <p className="chart-note">Lo que estuvo haciendo, según lo que el sistema reconoce en sus movimientos.</p>
                </section>
              )}
            </div>
          )}

          {tab === "corazon" && !empty && (
            <ChartPanel>
              {trend.hr && trend.hr.length > 0 ? <>
                <TrendChart title="Frecuencia cardiaca" sub={sub} rangeKey={range} unit="lpm" gapMs={3_000} loading={trend.loading} showNow
                  points={(trend.hrAvg ?? []).map((p) => ({ ...p, mark: outside(p.v, hBand) }))} detail={trend.hr} band={hBand}
                  legendLine={AVERAGE_LABEL["1h"]} legendDetail="Segundo a segundo" legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
                <p className="chart-note">La línea oscura es el promedio del último minuto: es la que se compara con lo normal para {dog.name}, así que un pico de unos segundos no la saca de su rango. La clara muestra cada segundo.</p>
              </> : <TrendChart title="Frecuencia cardiaca" sub={sub} rangeKey={range} unit="lpm" gapMs={gapMs} loading={trend.loading} showNow
                  points={series(trend, (p) => p.hr, hBand)} band={hBand} legendLine={AVERAGE_LABEL[range]} legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />}
              {/* The dog's own rhythm, never the general 100–150 lpm (it stays in the vet view). */}
              <p className="chart-note">Se compara con el ritmo habitual de {dog.name}: cada perro tiene el suyo, y muchos perros sanos laten más lento en reposo.</p>
              <p className="chart-note">{marksNote(dog.name)}</p>
            </ChartPanel>
          )}

          {tab === "temperatura" && !empty && (
            <ChartPanel>
              <TrendChart title="Temperatura" sub={sub} rangeKey={range} gapMs={gapMs} unit="°C" decimals={1} loading={trend.loading} showNow
                points={series(trend, (p) => p.temp, cfg.tempRange)} band={cfg.tempRange}
                legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
              {dog.source?.temp?.datasetId === "synthetic" && <p className="chart-note">{DEMO_TEMP_NOTE}</p>}
            </ChartPanel>
          )}

          {tab === "alertas" && (
            alerts.length ? <>
              <ul className="alert-list">{alerts.map((a) => <AlertItem key={a.id} alert={a} showDog={false} source={s?.lastSource} />)}</ul>
              {alerts.length >= alertsMax && (
                <div className="row more-row">
                  <p className="small muted">Se muestran las {alertsMax} alertas más recientes.</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAlertsMax(alertsMax + ALERTS_PAGE)} disabled={alertsLoading}>
                    {alertsLoading ? "Cargando…" : `Ver ${ALERTS_PAGE} más`}
                  </button>
                </div>
              )}
            </> : <EmptyState icon="check-circle" title="Sin alertas" text={`${dog.name} no tiene alertas registradas.`} />
          )}
        </div>
        {/* Only while data keep arriving from a live source, never for a CSV upload. Under «Resumen»
            only: under every tab it repeated the charts of the tab itself. */}
        {/* Offline, nothing is shown as live. */}
        {/* With the collar off what arrives is not the dog's, so there is nothing live to show. */}
        {freshness === "live" && online && tab === "resumen" && !sensorOff && <LivePanel dog={dog} cfg={cfg} viewer={viewer} live />}
        </>}
        <Notice />
      </div>
    </main>
  );
}
