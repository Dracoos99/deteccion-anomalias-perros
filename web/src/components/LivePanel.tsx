/* "En vivo" panel of the dog detail: while data keep arriving, the last 10 minutes from the dog's results,
   with the heart rate second by second and movement and Health Score per block. Hidden when no data arrived in
   the last 2 minutes or the data are old (a CSV loaded now with yesterday's data, a stopped simulation): the trend
   tabs above cover that. The detail renders it only while the dog's state is live, which a CSV upload
   never is. It goes after the trends, open on wide screens and folded into one line on phones, so the owner's state,
   tabs and «Qué es normal» come first. Its Health Score is the instantaneous one (the state above is the stable one).
   The detail shows it under the «Resumen» tab only. ofits Health Score says it is the one of this moment, apart from the average of the state above. */
import { useState } from "react";
import { useLiveResults, type Dog, type Fusion, type Viewer } from "../data/hooks";
import { isLiveBlock, liveSeries, type LiveBlock } from "../lib/live";
import { behaviorNow, hrBand } from "../lib/plain";
import { TrendChart, healthDomain, healthZones } from "./charts";
import { Icon, fmtNum, useNow } from "./ui";

const wideScreen = () => typeof window === "undefined" || window.matchMedia("(min-width: 721px)").matches;

export function LivePanel({ dog, cfg, viewer, live: dogLive }: { dog: Dog; cfg: Fusion; viewer: Viewer; live: boolean }) {
  const { data, loading, error } = useLiveResults(dog.id, viewer);
  const now = useNow(5000);
  const [open, setOpen] = useState(wideScreen);
  if (error) return null;
  if (loading) {
    // The final size from the first frame (the panel used to push the page down when its results arrived).
    if (!dogLive) return null;
    return (
      <section className="panel stack-sm live-panel" aria-busy="true" aria-label="En vivo">
        <div className="skeleton" style={{ height: 22, width: "30%" }} />
        {open && <><div className="skeleton" style={{ height: 61 }} /><div className="live-charts"><div className="skeleton" style={{ height: 203 }} />
          <div className="skeleton" style={{ height: 203 }} /><div className="skeleton" style={{ height: 203 }} /></div></>}
      </section>
    );
  }
  const blocks: LiveBlock[] = data.map((r) => ({
    blockStartMs: r.blockStart.toMillis(), blockSeconds: r.blockSeconds ?? null, createdMs: r.createdAt?.toMillis?.() ?? null, hrValues: r.hrValues ?? null,
    hr: r.signals?.hr ?? null, activeFraction: r.signals?.activeFraction ?? null, healthScore: r.healthScore, behavior: r.predictedBehavior,
  }));
  const live = liveSeries(blocks);
  if (!live.latest || !isLiveBlock(live.latest, now)) return null;
  const band = hrBand(dog.baseline, cfg);
  const behavior = live.latest.behavior ? behaviorNow(live.latest.behavior, dog.sex) : null;
  const heart = live.lastHr != null ? `${fmtNum(live.lastHr)} lpm` : null;
  const every = live.latest.blockSeconds ?? 10;
  const stableMin = Math.round((cfg.stableTimeConstantS ?? 300) / 60);
  // A dog replayed by the simulator: its movement and heart rate come from different dogs of the datasets.
  const simulated = !!dog.source?.imu?.datasetId && !!dog.source?.hr?.datasetId && dog.source.imu.datasetId !== dog.source.hr.datasetId;
  return (
    <details className="panel live-panel" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="live-summary">
        <h2 className="section-title live-title"><span className="live-dot" aria-hidden="true" />En vivo</h2>
        {!open && <span className="live-summary-now">{[behavior, heart].filter(Boolean).join(" · ")}</span>}
        <span className="live-summary-hint">{open ? "Ocultar" : "Ver los últimos 10 minutos"}<Icon name="chevron-down" size={14} /></span>
      </summary>
      <div className="stack-sm live-body">
        <p className="chart-note">Últimos 10 minutos de {dog.name}. Se actualiza cada {every} s.</p>
        <dl className="live-now">
          <div><dt>Ahora</dt><dd>{behavior ?? "—"}</dd></div>
          <div><dt>Corazón</dt><dd>{heart ? <>{heart}{live.latest.hr != null && <span className="live-now-note">promedio del último minuto</span>}</> : "Sin datos"}</dd></div>
          <div><dt>Movimiento</dt><dd>{live.lastActivity != null ? <>{fmtNum(live.lastActivity)} %<span className="live-now-note">del último minuto</span></> : "—"}</dd></div>
          <div><dt>Health Score ahora</dt><dd>{fmtNum(live.latest.healthScore)}<span className="live-now-note">{stableMin > 0 ? `de 100; el estado de arriba usa el promedio de ${stableMin} min` : "de 100"}</span></dd></div>
        </dl>
        {/* The three charts side by side on wide screens, so the panel is one band and not a
            column that doubles the page. */}
        <div className="live-charts">
          {(live.hrAvg.length > 0 || live.hr.length > 0) && (
            <TrendChart className="live-chart-hr" title="Frecuencia cardiaca" rangeKey="10m" unit="lpm" height={150} gapMs={live.hrAvg.length ? 30_000 : 3_000} detailGapMs={3_000} showLast
              points={(live.hrAvg.length ? live.hrAvg : live.hr).map((p) => ({ ...p, mark: !!band && live.hrAvg.length > 0 && (p.v < band[0] || p.v > band[1]) }))}
              detail={live.hrAvg.length ? live.hr : undefined} band={band}
              legendLine={live.hrAvg.length ? "Promedio de 1 minuto" : undefined} legendDetail="Segundo a segundo"
              legendBand={band ? `Lo normal para ${dog.name}` : undefined} legendMarks="Fuera de lo normal" />
          )}
          <TrendChart title="Tiempo en movimiento en el último minuto" rangeKey="10m" unit="%" domain={[0, 100]} points={live.activity} height={150} gapMs={30_000} showLast />
          <TrendChart title="Health Score de cada momento, últimos 10 minutos" rangeKey="10m" unit="puntos" domain={healthDomain(cfg.levels, live.health.map((p) => p.v))} points={live.health} height={150} gapMs={30_000}
            zones={healthZones(cfg.levels)} showLast />
        </div>
        <details className="disclosure">
          <summary><Icon name="chevron-right" size={14} />¿Qué muestran estos gráficos?</summary>
          <div className="stack-sm disclosure-body">
            <p className="chart-note">En la frecuencia cardiaca, la línea oscura es el promedio del último minuto, el mismo que usan el estado, la tarjeta de Inicio y las alertas para no reaccionar a un pico aislado; la clara muestra cada segundo. Los cortes son segundos en que el sensor no la midió.</p>
            <p className="chart-note">El movimiento de este panel es el del último minuto; lo normal para {dog.name} se compara con el promedio de {cfg.activity.timeConstantS / 60} minutos, en la pestaña Actividad.</p>
            {simulated && (
              <p className="chart-note">Datos de demostración: el movimiento y la frecuencia cardiaca vienen de perros distintos de los datasets públicos (ninguno trae las dos señales del mismo perro), así que la frecuencia puede subir mientras el perro está quieto.</p>
            )}
          </div>
        </details>
      </div>
    </details>
  );
}
