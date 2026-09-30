/* Screen 3 · Detalle del perro: state, trends of the last hour, day or week with the dog's normal band,
   what is normal for this dog, and its alerts. Charts are anchored at the dog's latest data. */
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { summarize } from "@shared/trends";
import { useAuth } from "../auth/AuthContext";
import { BarList, TrendChart, type ChartPoint } from "../components/charts";
import { Callout, EmptyState, HealthGauge, Icon, LevelTag, Notice, PageHead, Seg, fmtAgo, fmtNum } from "../components/ui";
import { useDog, useDogAlerts, useFusionConfig, type Dog, type Fusion } from "../data/hooks";
import { RANGES, useDogTrend, type DogTrend, type RangeKey } from "../data/useDogTrend";
import { BEHAVIOR_LABEL, activityBand, ageText, dateTimeText, describeDog, hrBand } from "../lib/plain";
import { AlertItem } from "./AlertsPage";
import { BaselineProgress } from "../components/BaselineProgress";

type Tab = "resumen" | "actividad" | "corazon" | "temperatura" | "alertas";
const TABS: { key: Tab; label: string }[] = [
  { key: "resumen", label: "Resumen" }, { key: "actividad", label: "Actividad" }, { key: "corazon", label: "Corazón" },
  { key: "temperatura", label: "Temperatura" }, { key: "alertas", label: "Alertas" },
];

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
        <p className="small muted" style={{ margin: 0 }}>Todavía no hay suficientes datos para saber qué es normal para {dog.name}.</p>
        <BaselineProgress dog={dog} cfg={cfg} />
      </div>
    );
  }
  const act = activityBand(b, cfg), hr = hrBand(b, cfg);
  return (
    <>
    <BaselineProgress dog={dog} cfg={cfg} />
    <ul className="normal-list">
      <li><Icon name="paw" size={16} /><span>Suele moverse cerca del <strong>{pct(b.activeRatioMean)} %</strong> del tiempo{act && <> (lo normal para {dog.name}: entre {pct(act[0])} % y {pct(act[1])} %)</>}.</span></li>
      {hr
        ? <li><Icon name="heart" size={16} /><span>Su frecuencia cardiaca habitual está entre <strong>{hr[0]} y {hr[1]} lpm</strong>.{dog.status?.physioModel && <> También se vigila cómo cambia a lo largo de cada minuto.</>}</span></li>
        : <li><Icon name="heart" size={16} /><span>Sus datos no traían frecuencia cardiaca: por ahora no se vigila.</span></li>}
      {b.tempMean != null
        ? <li><Icon name="thermometer" size={16} /><span>Su temperatura habitual es de <strong>{fmtNum(b.tempMean, 1)} °C</strong> (referencia para perros: {fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>
        : <li><Icon name="thermometer" size={16} /><span>Sus datos no traían temperatura: se vigila solo si llega, con el rango de referencia para perros ({fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)} °C).</span></li>}
    </ul>
    </>
  );
}

function ChartPanel({ children }: { children: ReactNode }) {
  return <section className="panel">{children}</section>;
}

export function DogDetail() {
  const { dogId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dog, loading, error } = useDog(dogId);
  const { data: cfg } = useFusionConfig();
  const [range, setRange] = useState<RangeKey>("24h");
  const [tab, setTab] = useState<Tab>("resumen");
  const r = RANGES[range];
  const trend = useDogTrend(dog, viewer, r.ms, r.bucketMs);
  const { data: alerts } = useDogAlerts(dog?.id, viewer, 50);

  if (loading) return <div className="boot" aria-busy="true">Cargando…</div>;
  if (error || !dog) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos este perro" text="Puede que la dirección no sea correcta o que no tengas acceso."
          action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
      </main>
    );
  }
  const s = dog.status, d = describeDog(s, dog.baseline, cfg);
  const canEdit = isAdmin || dog.ownerId === user!.uid;
  const sub = trend.end ? `Datos de ${r.text}, hasta el ${dateTimeText(trend.end)}` : undefined;
  const aBand = activityBand(dog.baseline, cfg), hBand = hrBand(dog.baseline, cfg);
  const summary = summarize(trend.items);
  const empty = !trend.loading && !trend.points.length;

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/">Inicio</Link><span aria-hidden="true">›</span><span>{dog.name}</span></nav>
      <PageHead title={dog.name} sub={[dog.breed, ageText(dog.birthDate), dog.weightKg ? `${fmtNum(dog.weightKg, 1)} kg` : null].filter(Boolean).join(" · ") || undefined}
        actions={<>
          <Link className="btn btn-primary" to={`/perros/${dog.id}/veterinario`}><Icon name="stethoscope" />Vista para el veterinario</Link>
          {canEdit && <Link className="btn btn-secondary" to={`/perros/${dog.id}/editar`}>Editar perfil</Link>}
        </>} />
      <div className="stack">
        <section className="panel dog-state" aria-label="Estado actual">
          <div className="stack-sm" style={{ minWidth: 0 }}>
            <LevelTag level={s?.level ?? null} />
            <p className="dog-phrase" style={{ margin: 0 }}>{d.phrase}</p>
            <div className="xs muted">{s ? `Actualizado ${fmtAgo(s.updatedAt?.toDate?.())}` : "Sin datos todavía"}</div>
          </div>
          {s && <HealthGauge score={s.healthScore} level={s.level} levels={cfg.levels} size={120} />}
        </section>

        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div className="tabs" role="tablist" aria-label="Secciones del detalle" style={{ marginBottom: 0 }}>
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-controls={`tab-${t.key}`} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
          {tab !== "alertas" && <Seg label="Periodo" options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({ value: k, label: RANGES[k].label }))} value={range} onChange={setRange} />}
        </div>

        <div id={`tab-${tab}`} role="tabpanel" className="stack">
          {trend.error && <Callout kind="error">No pudimos cargar las tendencias. Revisa tu conexión e inténtalo de nuevo.</Callout>}
          {tab !== "alertas" && empty && (
            <EmptyState icon="clock" title="Sin datos en este periodo" text={`Cuando lleguen datos de ${dog.name}, aquí verás cómo evolucionan.`}
              action={canEdit && !s ? <Link className="btn btn-secondary" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" />Cargar sus datos</Link> : undefined} />
          )}

          {tab === "resumen" && !empty && (
            <>
              <ChartPanel>
                <TrendChart title="Salud general (Health Score)" sub={sub} rangeKey={range} unit="puntos" domain={[0, 100]}
                  points={trend.points.flatMap((p) => (p.healthScore == null ? [] : [{ t: p.t, v: p.healthScore, mark: p.level !== "green" }]))}
                  zones={[
                    { from: 0, to: cfg.levels.amber, fill: "var(--color-status-red-bg)", label: "Revisar" },
                    { from: cfg.levels.amber, to: cfg.levels.green, fill: "var(--color-status-amber-bg)", label: "Atención" },
                    { from: cfg.levels.green, to: 100, fill: "var(--color-status-green-bg)", label: "Normal" },
                  ]} legendMarks="Momentos fuera de lo normal" />
              </ChartPanel>
              <section className="panel stack-sm">
                <h2 className="section-title">Qué es normal para {dog.name}</h2>
                <NormalForDog dog={dog} cfg={cfg} />
              </section>
            </>
          )}
          {tab === "resumen" && empty && (
            <section className="panel stack-sm">
              <h2 className="section-title">Qué es normal para {dog.name}</h2>
              <NormalForDog dog={dog} cfg={cfg} />
            </section>
          )}

          {tab === "actividad" && !empty && (
            <>
              <ChartPanel>
                <TrendChart title="Tiempo en movimiento" sub={sub} rangeKey={range} unit="%" domain={[0, 100]}
                  points={series(trend, (p) => (p.activity == null ? null : 100 * p.activity), aBand && [100 * aBand[0], 100 * aBand[1]])}
                  band={aBand && [100 * aBand[0], 100 * aBand[1]]} legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
              </ChartPanel>
              {summary.behaviors.length > 0 && (
                <section className="panel stack-sm">
                  <h2 className="section-title">Qué hizo en este periodo</h2>
                  <BarList items={summary.behaviors.map((b) => ({ label: BEHAVIOR_LABEL[b.behavior], value: b.share, display: `${pct(b.share)} %` }))} />
                  <p className="xs muted" style={{ margin: 0 }}>Conductas reconocidas por el modelo en ventanas de 2 s.</p>
                </section>
              )}
            </>
          )}

          {tab === "corazon" && !empty && (
            <ChartPanel>
              <TrendChart title="Frecuencia cardiaca" sub={sub} rangeKey={range} unit="lpm"
                points={series(trend, (p) => p.hr, hBand)} band={hBand} legendBand={`Lo normal para ${dog.name}`} legendMarks="Fuera de lo normal" />
              <p className="xs muted" style={{ margin: "8px 0 0" }}>Se compara con el ritmo habitual de {dog.name}. El rango de referencia general ({cfg.hrRange.join("–")} lpm) es solo informativo.</p>
            </ChartPanel>
          )}

          {tab === "temperatura" && !empty && (
            <ChartPanel>
              <TrendChart title="Temperatura" sub={sub} rangeKey={range} unit="°C" decimals={1}
                points={series(trend, (p) => p.temp, cfg.tempRange)} band={cfg.tempRange}
                legendBand={`Rango de referencia (${fmtNum(cfg.tempRange[0], 1)}–${fmtNum(cfg.tempRange[1], 1)} °C)`} legendMarks="Fuera del rango" />
              {dog.source?.temp?.datasetId === "synthetic" && <p className="xs muted" style={{ margin: "8px 0 0" }}>Temperatura simulada: no existen series públicas de temperatura de perros.</p>}
            </ChartPanel>
          )}

          {tab === "alertas" && (
            alerts.length
              ? <ul className="alert-list">{alerts.map((a) => <AlertItem key={a.id} alert={a} showDog={false} />)}</ul>
              : <EmptyState icon="check-circle" title="Sin alertas" text={`${dog.name} no tiene alertas registradas.`} />
          )}
        </div>
        <Notice />
      </div>
    </main>
  );
}
