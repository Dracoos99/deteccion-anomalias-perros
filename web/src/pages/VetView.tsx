/* Screen 5 · Vista para el veterinario: the second reading layer. Read-only, dense and technical:
   the dog, a 7- or 30-day period, minimum, maximum and mean of each signal against the dog's baseline, the anomalous
   events and the behavior distribution. Built in the client from trends, alerts and dogs.baseline;
   "Descargar PDF" opens the print dialog with print styles. */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { summarize, type TimedSlot } from "@shared/trends";
import { useAuth } from "../auth/AuthContext";
import { BarList } from "../components/charts";
import { EmptyState, Icon, Seg, fmtNum } from "../components/ui";
import { useDog, useDogAlerts, useFusionConfig } from "../data/hooks";
import { useDogTrend } from "../data/useDogTrend";
import { BEHAVIOR_LABEL, COMPONENT_LABEL, ageText, dateText, dateTimeText, durationText, reasonUnit } from "../lib/plain";
import { alertStartMs } from "./AlertsPage";

const PERIODS = [{ value: 7, label: "7 días" }, { value: 30, label: "30 días" }];
const DATASET_TEXT: Record<string, string> = {
  vehkaoja2022: "Vehkaoja et al. (2022)", invoxia2023: "Invoxia", physiozoo2018: "PhysioZoo", rri23dogs: "23 perros (intervalos RR)",
  uwbdvs2024: "UWB-DVS", synthetic: "serie sintética", csv: "carga de CSV",
};
const pm = (mean: number | null, sd: number | null, d = 0) => (mean == null ? "—" : `${fmtNum(mean, d)} ± ${fmtNum(sd ?? 0, d)}`);

function activityRange(items: TimedSlot[]): { min: number; max: number } | null {
  const v = items.filter((i) => i.slot.w > 0).map((i) => i.slot.act / i.slot.w);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}

export function VetView() {
  const { dogId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dog, loading } = useDog(dogId);
  const { data: cfg } = useFusionConfig();
  const [days, setDays] = useState(7);
  const trend = useDogTrend(dog, viewer, days * 86_400_000);
  const { data: alerts } = useDogAlerts(dog?.id, viewer, 200);

  if (loading) return <div className="boot" aria-busy="true">Cargando…</div>;
  if (!dog) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos este perro" action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
      </main>
    );
  }
  const b = dog.baseline, sum = summarize(trend.items), act = activityRange(trend.items);
  const inPeriod = trend.start == null ? [] : alerts.filter((a) => { const t = alertStartMs(a); return t >= trend.start! && t <= trend.end!; });
  const sources = dog.source
    ? [["Movimiento", dog.source.imu], ["Frecuencia cardiaca", dog.source.hr], ["Temperatura", dog.source.temp]]
      .filter(([, s]) => s && typeof s === "object" && (s as { datasetId: string | null }).datasetId)
      .map(([k, s]) => `${k}: ${DATASET_TEXT[(s as { datasetId: string }).datasetId] ?? (s as { datasetId: string }).datasetId}`)
    : [];
  const sexText = dog.sex === "female" ? "Hembra" : dog.sex === "male" ? "Macho" : "—";

  return (
    <main className="page vet-view" id="main">
      <div className="no-print row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <Link to={`/perros/${dog.id}`} className="small"><Icon name="chevron-left" size={14} /> Volver a {dog.name}</Link>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <Seg label="Periodo" options={PERIODS} value={days} onChange={setDays} />
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Icon name="database" />Descargar PDF</button>
        </div>
      </div>
      <p className="no-print xs muted" style={{ marginTop: -8 }}>Se abre el diálogo de impresión: elige «Guardar como PDF».</p>

      <header className="vet-head">
        <div className="kicker">Vista para el veterinario · solo lectura</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>{dog.name}</h1>
        <dl className="vet-facts">
          <div><dt>Raza</dt><dd>{dog.breed || "—"}</dd></div>
          <div><dt>Edad</dt><dd>{ageText(dog.birthDate) ?? "—"}</dd></div>
          <div><dt>Peso</dt><dd>{dog.weightKg ? `${fmtNum(dog.weightKg, 1)} kg` : "—"}</dd></div>
          <div><dt>Sexo</dt><dd>{sexText}</dd></div>
          <div><dt>Periodo</dt><dd>{trend.start != null ? `${dateText(trend.start)} – ${dateText(trend.end!)}` : "Sin datos"}</dd></div>
          <div><dt>Generado</dt><dd>{dateTimeText(Date.now())}</dd></div>
        </dl>
        <p className="vet-disclaimer"><Icon name="info" size={14} /> Datos de sensores y modelo predictivo. Sin diagnóstico.</p>
      </header>

      {!trend.items.length ? (
        <EmptyState icon="clock" title="Sin datos en este periodo" text={`Todavía no hay datos de ${dog.name} para este periodo.`} />
      ) : (
        <>
          <section className="vet-section" aria-labelledby="v-signals">
            <h2 className="section-title" id="v-signals">Señales del periodo</h2>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead><tr><th>Señal</th><th className="num">Mínimo</th><th className="num">Máximo</th><th className="num">Promedio</th><th className="num">Línea base del perro (media ± DE)</th><th>Referencia</th></tr></thead>
                <tbody>
                  <tr><td>Frecuencia cardiaca (lpm)</td>
                    <td className="num">{sum.hr ? fmtNum(sum.hr.min) : "—"}</td><td className="num">{sum.hr ? fmtNum(sum.hr.max) : "—"}</td>
                    <td className="num">{sum.hr ? fmtNum(sum.hr.mean) : "—"}</td><td className="num">{b ? pm(b.hrMean, b.hrStd) : "—"}</td>
                    <td>{cfg.hrRange.join("–")} (informativa; alerta respecto a la línea base)</td></tr>
                  <tr><td>Temperatura (°C)</td>
                    <td className="num">{sum.temp ? fmtNum(sum.temp.min, 1) : "—"}</td><td className="num">{sum.temp ? fmtNum(sum.temp.max, 1) : "—"}</td>
                    <td className="num">{sum.temp ? fmtNum(sum.temp.mean, 1) : "—"}</td><td className="num">{b ? pm(b.tempMean, b.tempStd, 1) : "—"}</td>
                    <td>{fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)}</td></tr>
                  <tr><td>Tiempo en movimiento (%)</td>
                    <td className="num">{act ? fmtNum(100 * act.min) : "—"}</td><td className="num">{act ? fmtNum(100 * act.max) : "—"}</td>
                    <td className="num">{sum.activity != null ? fmtNum(100 * sum.activity) : "—"}</td><td className="num">{b ? pm(100 * b.activeRatioMean, 100 * b.activeRatioStd) : "—"}</td>
                    <td>—</td></tr>
                  <tr><td>Health Score (0–100)</td>
                    <td className="num">{sum.healthScore ? fmtNum(sum.healthScore.min) : "—"}</td><td className="num">—</td>
                    <td className="num">{sum.healthScore ? fmtNum(sum.healthScore.mean) : "—"}</td><td className="num">—</td>
                    <td>≥ {cfg.levels.green} normal · {cfg.levels.amber}–{cfg.levels.green - 1} atención · &lt; {cfg.levels.amber} revisar</td></tr>
                </tbody>
              </table>
            </div>
            <p className="xs muted">Mínimo y máximo de FC sobre valores de 1 s; de temperatura, por bloque de 10 s; de movimiento, por franja de 5 minutos.
              Tiempo en cada estado: normal {fmtNum(100 * sum.levels.green)} %, atención {fmtNum(100 * sum.levels.amber)} %, revisar {fmtNum(100 * sum.levels.red)} %.</p>
          </section>

          <section className="vet-section" aria-labelledby="v-events">
            <h2 className="section-title" id="v-events">Eventos anómalos ({inPeriod.length})</h2>
            {!inPeriod.length ? <p className="small muted">Sin eventos en el periodo.</p> : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead><tr><th>Fecha y hora</th><th>Duración</th><th>Variable</th><th className="num">Valor</th><th>Rango de referencia</th><th>Estado</th></tr></thead>
                  <tbody>
                    {inPeriod.flatMap((a) => a.reasons.map((r, i) => {
                      const { unit, decimals } = reasonUnit(r), start = alertStartMs(a), end = a.endedAt?.toMillis?.();
                      return (
                        <tr key={`${a.id}-${r.code}`}>
                          <td>{i === 0 ? dateTimeText(start) : ""}</td>
                          <td>{i === 0 ? (end ? durationText(end - start) : "en curso") : ""}</td>
                          <td>{COMPONENT_LABEL[r.component]}</td>
                          <td className="num">{fmtNum(r.value, decimals)} {unit}</td>
                          <td>{fmtNum(r.normalRange[0], decimals)}–{fmtNum(r.normalRange[1], decimals)} {unit}</td>
                          <td>{i === 0 ? (a.status === "open" ? "Sin revisar" : "Revisada") : ""}</td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {sum.behaviors.length > 0 && (
            <section className="vet-section" aria-labelledby="v-beh">
              <h2 className="section-title" id="v-beh">Distribución de conductas</h2>
              <BarList items={sum.behaviors.map((x) => ({ label: BEHAVIOR_LABEL[x.behavior], value: x.share, display: `${fmtNum(100 * x.share)} %` }))} />
              <p className="xs muted">Clasificadas por el modelo CNN-LSTM en ventanas de 2 s.</p>
            </section>
          )}
        </>
      )}

      <section className="vet-section" aria-labelledby="v-method">
        <h2 className="section-title" id="v-method">Origen de los datos y método</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {sources.length > 0 && <li>Fuentes: {sources.join("; ")}.</li>}
          <li>Conducta: {dog.status?.behaviorModel ? `modelo ${dog.status.behaviorModel}` : "regla estadística provisional"}.</li>
          <li>Frecuencia cardiaca: {dog.status?.physioModel
            ? `modelo ${dog.status.physioModel} (forma del último minuto) combinado con la regla del promedio respecto a la línea base del perro`
            : "regla provisional del promedio respecto a la línea base del perro"}. Temperatura: reglas provisionales.</li>
          <li>La línea base se calcula con los datos normales del propio perro. Los valores de las alertas se comparan con ella.</li>
        </ul>
      </section>
    </main>
  );
}
