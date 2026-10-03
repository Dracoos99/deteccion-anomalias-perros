/* "En vivo" panel of the dog detail: while data keep arriving, the last 10 minutes from the dog's results,
   with the heart rate second by second and movement and Health Score per block. Hidden when no data arrived in
   the last 2 minutes (a CSV loaded earlier, a stopped simulation): the trend tabs below cover that. */
import { useLiveResults, type Dog, type Fusion, type Viewer } from "../data/hooks";
import { isLive, liveSeries, type LiveBlock } from "../lib/live";
import { behaviorNow, hrBand } from "../lib/plain";
import { TrendChart, healthZones } from "./charts";
import { Icon, fmtNum, useNow } from "./ui";

export function LivePanel({ dog, cfg, viewer }: { dog: Dog; cfg: Fusion; viewer: Viewer }) {
  const { data, error } = useLiveResults(dog.id, viewer);
  const now = useNow(5000);
  const blocks: LiveBlock[] = data.map((r) => ({
    blockStartMs: r.blockStart.toMillis(), blockSeconds: r.blockSeconds ?? null, createdMs: r.createdAt?.toMillis?.() ?? null, hrValues: r.hrValues ?? null,
    hr: r.signals?.hr ?? null, activeFraction: r.signals?.activeFraction ?? null, healthScore: r.healthScore, behavior: r.predictedBehavior,
  }));
  const live = liveSeries(blocks);
  if (error || !live.latest || !isLive(live.latest.createdMs, now)) return null;
  const band = hrBand(dog.baseline, cfg);
  // A dog replayed by the simulator: its movement and heart rate come from different dogs of the datasets.
  const simulated = !!dog.source?.imu?.datasetId && !!dog.source?.hr?.datasetId && dog.source.imu.datasetId !== dog.source.hr.datasetId;
  return (
    <section className="panel stack-sm live-panel" aria-labelledby="live-title">
      <div>
        <h2 className="section-title" id="live-title"><span className="live-dot" aria-hidden="true" />En vivo</h2>
        <p className="xs muted">Últimos 10 minutos de datos de {dog.name}, actualizados con cada bloque que llega{live.latest.blockSeconds === 2 ? " (cada 2 s)" : ""}.</p>
      </div>
      <dl className="live-now">
        <div><dt>Ahora</dt><dd>{live.latest.behavior ? behaviorNow(live.latest.behavior, dog.sex) : "—"}</dd></div>
        <div><dt>Corazón</dt><dd>{live.lastHr != null ? `${fmtNum(live.lastHr)} lpm` : "Sin datos"}</dd></div>
        <div><dt>Movimiento</dt><dd>{live.lastActivity != null ? <>{fmtNum(live.lastActivity)} %<span className="live-now-note">del último minuto</span></> : "—"}</dd></div>
        <div><dt>Health Score</dt><dd>{fmtNum(live.latest.healthScore)}</dd></div>
      </dl>
      {live.hr.length > 0 && (
        <TrendChart title="Frecuencia cardiaca, segundo a segundo" rangeKey="10m" unit="lpm" points={live.hr} band={band} height={150} gapMs={3_000} showLast
          legendBand={band ? `Lo normal para ${dog.name}` : undefined} />
      )}
      <TrendChart title="Tiempo en movimiento en el último minuto" rangeKey="10m" unit="%" domain={[0, 100]} points={live.activity} height={120} gapMs={30_000} showLast />
      <TrendChart title="Health Score de cada bloque" rangeKey="10m" unit="puntos" domain={[0, 100]} points={live.health} height={120} gapMs={30_000}
        zones={healthZones(cfg.levels)} showLast />
      <details className="disclosure">
        <summary><Icon name="chevron-right" size={14} />¿Qué muestran estos gráficos?</summary>
        <div className="stack-sm" style={{ marginTop: 8 }}>
          <p className="xs muted">Los cortes en la frecuencia cardiaca son segundos en que el sensor no la midió. El estado, la tarjeta de Inicio y las alertas usan el promedio del último minuto para no reaccionar a un pico aislado; por eso pueden diferir un poco de estos valores.</p>
          {simulated && (
            <p className="xs muted">Datos simulados: el movimiento y la frecuencia cardiaca vienen de perros distintos de los datasets públicos (ninguno trae las dos señales del mismo perro), así que la frecuencia puede subir mientras el perro simulado está quieto.</p>
          )}
        </div>
      </details>
    </section>
  );
}
