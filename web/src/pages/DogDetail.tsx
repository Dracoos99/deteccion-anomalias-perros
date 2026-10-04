/* Screen 3 · Detalle del perro: state, trends of the last hour, day or week with the dog's normal band,
   what is normal for this dog, and its alerts, then the "En vivo" panel. Charts are anchored at the dog's latest data
. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { rebucket, summarize, toPoint } from "@shared/trends";
import { useAuth } from "../auth/AuthContext";
import { BarList, TrendChart, healthZones, type ChartPoint } from "../components/charts";
import { Callout, DataTime, EmptyState, HealthGauge, Icon, LevelTag, Notice, PageHead, PageLoading, Seg, fmtNum, useFreshness, usePageTitle } from "../components/ui";
import { LivePanel } from "../components/LivePanel";
import { useActiveModels, useDog, useDogAlerts, useFusionConfig, type Dog, type Fusion, type ModelVersion } from "../data/hooks";
import { RANGES, useDogTrend, type DogTrend, type RangeKey } from "../data/useDogTrend";
import { BEHAVIOR_LABEL, activityBand, ageText, coverageText, describeDog, endSentence, hrBand, whenPhrase } from "../lib/plain";
import { AlertItem } from "./AlertsPage";
import { BaselineProgress } from "../components/BaselineProgress";

type Tab = "resumen" | "actividad" | "corazon" | "temperatura" | "alertas";
const TABS: { key: Tab; label: string }[] = [
  { key: "resumen", label: "Resumen" }, { key: "actividad", label: "Actividad" }, { key: "corazon", label: "Corazón" },
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
        <p className="small muted">Todavía no hay suficientes datos para saber qué es normal para {dog.name}.</p>
        <BaselineProgress dog={dog} cfg={cfg} />
      </div>
    );
  }
  const act = activityBand(b, cfg), hr = hrBand(b, cfg);
  return (
    <>
    <BaselineProgress dog={dog} cfg={cfg} />
    <ul className="normal-list">
      <li><Icon name="paw" size={16} /><span>Suele moverse cerca del <strong>{pct(b.activeRatioMean)} %</strong> del tiempo{act && <>; en promedios de {cfg.activity.timeConstantS / 60} minutos, lo normal para {dog.name} es entre {pct(act[0])} % y {pct(act[1])} %</>}.</span></li>
      {hr
        ? <li><Icon name="heart" size={16} /><span>Su frecuencia cardiaca habitual, en promedios de {cfg.hrAverageS === 60 ? "1 minuto" : `${cfg.hrAverageS} s`}, está entre <strong>{hr[0]} y {hr[1]} lpm</strong>.{dog.status?.physioModel && <> También se vigila cómo cambia a lo largo de cada minuto.</>}</span></li>
        : <li><Icon name="heart" size={16} /><span>Sus datos no traían frecuencia cardiaca: por ahora no se vigila.</span></li>}
      {b.tempMean != null
        ? <li><Icon name="thermometer" size={16} /><span>Su temperatura habitual es de <strong>{fmtNum(b.tempMean, 1)} °C</strong> (referencia para perros: {fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>
        : <li><Icon name="thermometer" size={16} /><span>Sus datos no traían temperatura: se vigila solo si llega, con el rango de referencia para perros ({fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>}
    </ul>
    </>
  );
}

/** How the score is computed, in one line. From the active models (modelVersions), not from the latest block: the
 * heart-rate autoencoder only reads 60 s in a row, so a single block may have been scored without it. */
function methodNote(dog: Dog, models: ModelVersion[]): string | null {
  if (!dog.status) return null;
  const has = (kind: string) => models.some((m) => m.kind === kind);
  const behavior = !!dog.status.behaviorModel || has("behavior");
  const heart = dog.baseline?.hrMean != null && (!!dog.status.physioModel || has("physiological"));
  if (behavior && heart) return "Conducta y corazón según los modelos; temperatura con reglas provisionales.";
  if (behavior) return "Conducta según el modelo; corazón y temperatura con reglas estadísticas.";
  return "Puntaje provisional: reglas estadísticas mientras se entrenan los modelos.";
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
  const { data: models } = useActiveModels();
  const { freshness, shownMs } = useFreshness(dog?.status);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useOverflowCue(tabsRef, [loading, !!dog?.status, alerts.length > 0]);

  if (loading) return <PageLoading text="Cargando a tu perro…" />;
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
  const newestOpen = alerts.find((a) => a.status === "open");
  const d = describeDog(s, dog.baseline, cfg, newestOpen?.reasons);
  // The dog's own count (kept by the Function), not the open alerts among the newest 50.
  const openAlerts = s?.openAlerts ?? alerts.filter((a) => a.status === "open").length;
  // A dog without any data yet: one clear next step instead of empty tabs and charts.
  const noData = !s && !alerts.length;
  const selectTab = (k: Tab) => {
    setTab(k);
    document.getElementById(`tabbtn-${k}`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
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

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/">Inicio</Link><span aria-hidden="true">›</span><span>{dog.name}</span></nav>
      <PageHead title={dog.name} sub={[dog.breed, ageText(dog.birthDate), weight].filter(Boolean).join(" · ") || undefined}
        actions={<>
          <Link className="btn btn-primary btn-sm" to={`/perros/${dog.id}/veterinario`}><Icon name="stethoscope" size={14} />Vista para el veterinario</Link>
          {canEdit && <Link className="btn btn-secondary btn-sm" to={`/perros/${dog.id}/editar`}>Editar perfil</Link>}
        </>} />
      <div className="stack">
        {savedOffline && <Callout kind="ok">Sin conexión: guardaremos los cambios cuando vuelvas a conectarte.</Callout>}
        <section className="panel dog-state" aria-label="Estado actual">
          <div className="stack-sm dog-state-main">
            {stale ? <span className="tag tag-outline"><Icon name="clock" size={14} />Sin datos recientes</span> : <LevelTag level={s?.level ?? null} />}
            <p className="dog-phrase">{stale && shownMs != null ? endSentence(`No recibimos datos de ${dog.name} desde ${whenPhrase(shownMs)}`) : d.phrase}</p>
            {stale && <div className="last-state small">Último estado: <LevelTag level={s?.level ?? null} iconSize={12} /></div>}
            {s && freshness ? (
              <div className="xs muted row data-time"><span><DataTime freshness={freshness} shownMs={shownMs} /></span></div>
            ) : (
              <>
                <p className="small muted">Sus gráficos y su patrón normal aparecerán cuando lleguen sus primeras lecturas.</p>
                {canEdit && <div><Link className="btn btn-primary" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" />Cargar sus datos</Link></div>}
              </>
            )}
          </div>
          {s && <HealthGauge score={s.healthScore} level={s.level} levels={levels} size={96} />}
        </section>

        {noData ? (
          <section className="panel stack-sm">
            <h2 className="section-title">Qué es normal para {dog.name}</h2>
            <NormalForDog dog={dog} cfg={cfg} />
          </section>
        ) : <>
        <div className="tabs" role="tablist" aria-label="Secciones del detalle" onKeyDown={onTabKey} ref={tabsRef}>
            {TABS.map((t) => (
              <button key={t.key} id={`tabbtn-${t.key}`} type="button" role="tab" aria-selected={tab === t.key} aria-controls={tab === t.key ? `tab-${t.key}` : undefined}
                tabIndex={tab === t.key ? 0 : -1} onClick={() => selectTab(t.key)}>{t.label}{t.key === "alertas" && openAlerts > 0 && <span className="tab-count">{openAlerts}<span className="sr-only"> {openAlerts === 1 ? "nueva" : "nuevas"}</span></span>}</button>
            ))}
        </div>
        {tab !== "alertas" && (
          <div className="period-row"><Seg label="Periodo" options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({ value: k, label: RANGES[k].label }))} value={range} onChange={setRange} /></div>
        )}

        <div id={`tab-${tab}`} role="tabpanel" aria-labelledby={`tabbtn-${tab}`} className="stack">
          {trend.error && <Callout kind="error">No pudimos cargar las tendencias. Revisa tu conexión e inténtalo de nuevo.</Callout>}
          {tab !== "alertas" && empty && (
            <EmptyState icon="clock" title="Sin datos en este periodo" text={`Cuando lleguen datos de ${dog.name}, aquí verás cómo evolucionan.`}
              action={canEdit && !s ? <Link className="btn btn-secondary" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" />Cargar sus datos</Link> : undefined} />
          )}

          {tab === "resumen" && !empty && (
            <div className="detail-two">
              <ChartPanel>
                <TrendChart title="Salud general (Health Score)" sub={sub} rangeKey={range} gapMs={gapMs} unit="puntos" domain={[0, 100]} loading={trend.loading}
                  points={trend.points.flatMap((p) => (p.healthScore == null ? [] : [{ t: p.t, v: p.healthScore, mark: p.healthScore < levels.green }]))}
                  zones={healthZones(levels)} legendMarks="Momentos fuera de lo normal" />
                <p className="xs muted">El Health Score resume de 0 a 100 qué tan cerca están sus datos de su patrón normal: desde {levels.green} es «Todo normal», de {levels.amber} a {levels.green - 1} «Atención» y debajo de {levels.amber} «Revisar».</p>
                {methodNote(dog, models) && <p className="xs muted">{methodNote(dog, models)}</p>}
              </ChartPanel>
              <section className="panel stack-sm">
                <h2 className="section-title">Qué es normal para {dog.name}</h2>
                <NormalForDog dog={dog} cfg={cfg} />
              </section>
            </div>
          )}
          {tab === "resumen" && empty && (
            <section className="panel stack-sm">
              <h2 className="section-title">Qué es normal para {dog.name}</h2>
              <NormalForDog dog={dog} cfg={cfg} />
            </section>
          )}

          {tab === "actividad" && !empty && (
            <div className="detail-two">
              <ChartPanel>
                <TrendChart title="Tiempo en movimiento" sub={sub} rangeKey={range} gapMs={gapMs} unit="%" domain={[0, 100]} loading={trend.loading}
                  points={series(trend, (p) => (p.activityAvg == null ? null : 100 * p.activityAvg), aBandPct)} detail={movement} detailGapMs={3 * moveDetail.ms}
                  band={aBandPct} legendLine={`Promedio de ${avgMin} minutos`} legendDetail={moveDetail.label}
                  legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
                <p className="xs muted">La línea oscura es el promedio de los últimos {avgMin} minutos: es la que se compara con lo normal para {dog.name}. La clara sube y baja con cada paseo o siesta.</p>
              </ChartPanel>
              {summary.behaviors.length > 0 && (
                <section className="panel stack-sm">
                  <h2 className="section-title">Qué hizo en este periodo</h2>
                  <BarList items={summary.behaviors.map((b) => ({ label: BEHAVIOR_LABEL[b.behavior], value: b.share, display: `${pct(b.share)} %` }))} />
                  <p className="xs muted">Conductas reconocidas por el modelo en ventanas de 2 s.</p>
                </section>
              )}
            </div>
          )}

          {tab === "corazon" && !empty && (
            <ChartPanel>
              {trend.hr && trend.hr.length > 0 ? <>
                <TrendChart title="Frecuencia cardiaca" sub={sub} rangeKey={range} unit="lpm" gapMs={3_000} loading={trend.loading}
                  points={(trend.hrAvg ?? []).map((p) => ({ ...p, mark: outside(p.v, hBand) }))} detail={trend.hr} band={hBand}
                  legendLine={AVERAGE_LABEL["1h"]} legendDetail="Segundo a segundo" legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
                <p className="xs muted">La línea oscura es el promedio del último minuto: es la que se compara con lo normal para {dog.name}, así que un pico de unos segundos no la saca de su rango. La clara muestra cada segundo.</p>
              </> : <TrendChart title="Frecuencia cardiaca" sub={sub} rangeKey={range} unit="lpm" gapMs={gapMs} loading={trend.loading}
                  points={series(trend, (p) => p.hr, hBand)} band={hBand} legendLine={AVERAGE_LABEL[range]} legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />}
              <p className="xs muted">Se compara con el ritmo habitual de {dog.name}. El rango de referencia general ({cfg.hrRange.join("–")} lpm) es solo informativo.</p>
            </ChartPanel>
          )}

          {tab === "temperatura" && !empty && (
            <ChartPanel>
              <TrendChart title="Temperatura" sub={sub} rangeKey={range} gapMs={gapMs} unit="°C" decimals={1} loading={trend.loading}
                points={series(trend, (p) => p.temp, cfg.tempRange)} band={cfg.tempRange}
                legendBand={`Rango de referencia (${fmtNum(cfg.tempRange[0], 1)}–${fmtNum(cfg.tempRange[1], 1)} °C)`} legendMarks="Fuera del rango" />
              {dog.source?.temp?.datasetId === "synthetic" && <p className="xs muted">Temperatura simulada: no existen series públicas de temperatura de perros.</p>}
            </ChartPanel>
          )}

          {tab === "alertas" && (
            alerts.length ? <>
              <ul className="alert-list">{alerts.map((a) => <AlertItem key={a.id} alert={a} showDog={false} />)}</ul>
              {alerts.length >= alertsMax && (
                <div className="row more-row">
                  <p className="xs muted">Se muestran las {alertsMax} alertas más recientes.</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAlertsMax(alertsMax + ALERTS_PAGE)} disabled={alertsLoading}>
                    {alertsLoading ? "Cargando…" : `Ver ${ALERTS_PAGE} más`}
                  </button>
                </div>
              )}
            </> : <EmptyState icon="check-circle" title="Sin alertas" text={`${dog.name} no tiene alertas registradas.`} />
          )}
        </div>
        <LivePanel dog={dog} cfg={cfg} viewer={viewer} live={freshness === "live"} />
        </>}
        <Notice />
      </div>
    </main>
  );
}
