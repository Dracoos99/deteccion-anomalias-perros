/* "En vivo" panel of the dog detail: while data keep arriving, the last 10 minutes from the dog's results,
   with the heart rate second by second and movement and Health Score per block. Hidden when no data arrived in
   the last 2 minutes (a CSV loaded earlier, a stopped simulation): the trend tabs below cover that. */
import { useLiveResults, type Dog, type Fusion, type Viewer } from "../data/hooks";
import { isLive, liveSeries, type LiveBlock } from "../lib/live";
import { behaviorNow, hrBand } from "../lib/plain";
import { TrendChart } from "./charts";
import { fmtNum, useNow } from "./ui";

export function LivePanel({ dog, cfg, viewer }: { dog: Dog; cfg: Fusion; viewer: Viewer }) {
  const { data, error } = useLiveResults(dog.id, viewer);
  const now = useNow(5000);
  const blocks: LiveBlock[] = data.map((r) => ({
    blockStartMs: r.blockStart.toMillis(), createdMs: r.createdAt?.toMillis?.() ?? null, hrValues: r.hrValues ?? null,
    hr: r.signals?.hr ?? null, activeFraction: r.signals?.activeFraction ?? null, healthScore: r.healthScore, behavior: r.predictedBehavior,
  }));
  const live = liveSeries(blocks);
  if (error || !live.latest || !isLive(live.latest.createdMs, now)) return null;
  const band = hrBand(dog.baseline, cfg);
  return (
    <section className="panel stack-sm live-panel" aria-labelledby="live-title">
      <div>
        <h2 className="section-title" id="live-title" style={{ margin: 0 }}><span className="live-dot" aria-hidden="true" />En vivo</h2>
        <p className="xs muted" style={{ margin: 0 }}>Últimos 10 minutos de datos de {dog.name}, actualizados con cada bloque nuevo (cada 2 s en tiempo real).</p>
      </div>
      <dl className="live-now">
        <div><dt>Ahora</dt><dd>{live.latest.behavior ? behaviorNow(live.latest.behavior, dog.sex) : "—"}</dd></div>
        <div><dt>Corazón</dt><dd>{live.lastHr != null ? `${fmtNum(live.lastHr)} lpm` : "Sin datos"}</dd></div>
        <div><dt>Movimiento</dt><dd>{live.lastActivity != null ? `${fmtNum(live.lastActivity)} % del bloque` : "—"}</dd></div>
        <div><dt>Health Score</dt><dd>{fmtNum(live.latest.healthScore)}</dd></div>
      </dl>
      {live.hr.length > 0 && (
        <TrendChart title="Frecuencia cardiaca, segundo a segundo" rangeKey="10m" unit="lpm" points={live.hr} band={band} height={150} gapMs={3_000}
          legendBand={band ? `Lo normal para ${dog.name}` : undefined} />
      )}
      <TrendChart title="Movimiento en cada bloque" rangeKey="10m" unit="%" domain={[0, 100]} points={live.activity} height={120} gapMs={30_000} />
      <TrendChart title="Health Score de cada bloque" rangeKey="10m" unit="puntos" domain={[0, 100]} points={live.health} height={120} gapMs={30_000}
        zones={[
          { from: 0, to: cfg.levels.amber, fill: "var(--color-status-red-bg)", label: "Revisar" },
          { from: cfg.levels.amber, to: cfg.levels.green, fill: "var(--color-status-amber-bg)", label: "Atención" },
          { from: cfg.levels.green, to: 100, fill: "var(--color-status-green-bg)", label: "Normal" },
        ]} />
      <p className="xs muted" style={{ margin: 0 }}>El estado, la tarjeta de Inicio y las alertas usan el promedio del último minuto para no reaccionar a un pico aislado. Por eso pueden diferir un poco de estos valores.</p>
    </section>
  );
}
