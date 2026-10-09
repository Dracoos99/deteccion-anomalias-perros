/* Screen 5 · Vista para el veterinario: the second reading layer. Read-only, dense and technical:
   the dog, a 7- or 30-day period, minimum, maximum and mean of each signal against the dog's baseline, the anomalous
   events and the behavior distribution. Built in the client from trends, alerts and dogs.baseline;
   "Descargar PDF" opens the print dialog with print styles. It says how many days have data, and the full
   method (the source of each signal, the model versions, the demonstration temperature) goes in «Método y fuentes».
 A missing value reads «Sin dato» and one that does not exist «No aplica»; the time it was made and
   the time of the data are apart, with a note when the data are simulated time; the heart-rate reference says
   the dog's own range first; and a dog without a baseline has no Health Score. «Últimos
   datos» is the time Inicio shows (dogs.status, never later than when the data arrived; it was the end of the latest
   5-minute slot of the trends, up to 5 minutes later), and data ahead of the clock are a demonstration or, for a CSV,
   the hours of the owner's file. Each variable is one row of an event, with its largest deviation. */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { summarize, type TimedSlot } from "@shared/trends";
import { useAuth } from "../auth/AuthContext";
import { BarList } from "../components/charts";
import { EmptyState, Icon, PageLoading, Seg, Skeleton, fmtNum, usePageTitle } from "../components/ui";
import { useActiveModels, useDog, useDogAlerts, useFusionConfig } from "../data/hooks";
import { useDogTrend } from "../data/useDogTrend";
import { shownDataMs, simulatedTime } from "../lib/live";
import {
  BEHAVIOR_LABEL, LEARNING_TEXT, activityBand, aheadTag, ageText, alertStartMs, dateText, dateTimeText, datasetText, durationText, hrBand, orderReasons,
  reasonLabel, reasonUnit,
} from "../lib/plain";

const PERIODS = [{ value: 7, label: "7 días" }, { value: 30, label: "30 días" }];
/** A value that is missing, and one that does not exist for that row; never a dash. Both read quieter
 * than a value (a regular muted word), so the figures of the table are what the eye finds. */
const NO_DATA = <span className="vet-missing">Sin dato</span>, NOT_APPLICABLE = <span className="vet-missing">No aplica</span>;
const pm = (mean: number | null, sd: number | null, d = 0) => (mean == null ? NO_DATA : `${fmtNum(mean, d)} ± ${fmtNum(sd ?? 0, d)}`);
/** a share that is not zero is never printed as «0 %». */
const share = (x: number) => (x > 0 && x < 0.005 ? "menos de 1 %" : `${fmtNum(100 * x)} %`);

/** the calendar days of the period that have data, and the first one. */
function daysWithData(items: TimedSlot[]): { days: number; first: number | null } {
  const days = new Set<string>();
  for (const { t } of items) { const d = new Date(t); days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`); }
  return { days: days.size, first: items.length ? items[0].t : null };
}

/** Lowest and highest 20-minute average of time in movement over the 5-minute slots: the quantity of the
 * baseline, so the row compares like with like. */
function activityRange(items: TimedSlot[]): { min: number; max: number } | null {
  const v = items.filter((i) => i.slot.aeN).map((i) => i.slot.aeSum! / i.slot.aeN!);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}

export function VetView() {
  const { dogId } = useParams();
  const { user, isAdmin } = useAuth();
  const viewer = { uid: user!.uid, isAdmin };
  const { data: dog, loading } = useDog(dogId);
  usePageTitle(dog ? `${dog.name} · Vista para el veterinario` : "Vista para el veterinario");
  const { data: cfg } = useFusionConfig();
  const [days, setDays] = useState(7);
  const trend = useDogTrend(dog, viewer, days * 86_400_000, cfg);
  const { data: alerts } = useDogAlerts(dog?.id, viewer, 200);
  const { data: models } = useActiveModels();

  if (loading) return <PageLoading shape="sheet" />;
  if (!dog) {
    return (
      <main className="page" id="main">
        <EmptyState icon="info" title="No encontramos este perro" action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
      </main>
    );
  }
  const b = dog.baseline, sum = summarize(trend.items), act = activityRange(trend.items);
  const avgMin = fmtNum(cfg.activity.timeConstantS / 60);
  const hb = hrBand(b, cfg), ab = activityBand(b, cfg);
  const bands = [hb && `FC ${hb[0]}–${hb[1]} lpm`, ab && `movimiento ${fmtNum(100 * ab[0])}–${fmtNum(100 * ab[1])} %`].filter(Boolean).join("; ");
  // The models the system applies (modelVersions), not only the ones that scored the latest block: the autoencoder
  // only reads 60 s of heart rate in a row, so the latest block may have been scored without it.
  const activeModel = (kind: string) => models.find((m) => m.kind === kind)?.version ?? null;
  const behaviorModel = dog.status?.behaviorModel ?? activeModel("behavior");
  const physioModel = dog.status?.physioModel ?? (b?.hrMean != null ? activeModel("physiological") : null);
  const inPeriod = trend.start == null ? [] : alerts.filter((a) => { const t = alertStartMs(a); return t >= trend.start! && t <= trend.end!; });
  const sources = dog.source
    ? [["Movimiento", dog.source.imu], ["Frecuencia cardiaca", dog.source.hr], ["Temperatura", dog.source.temp]]
      .filter(([, s]) => s && typeof s === "object" && (s as { datasetId: string | null }).datasetId)
      .map(([k, s]) => `${k}: ${datasetText((s as { datasetId: string }).datasetId)}`)
    : [];
  const sexText = dog.sex === "female" ? "Hembra" : dog.sex === "male" ? "Macho" : NO_DATA;
  const cover = daysWithData(trend.items);
  const hasData = trend.items.length > 0;
  const baselineAt = b?.computedAt?.toMillis?.();
  const syntheticTemp = dog.source?.temp?.datasetId === "synthetic";
  // The time the sheet is made (the clock) and the time of its data; a simulation faster than the
  // clock dates its data and events later than the sheet.
  const madeAt = Date.now();
  const st = dog.status;
  const dataMs = st?.lastBlockAt?.toMillis?.() ?? null, receivedMs = st?.updatedAt?.toMillis?.() ?? null;
  const lastData = st ? shownDataMs(dataMs, receivedMs) : null;
  const simulated = simulatedTime(dataMs, receivedMs, madeAt)
    || inPeriod.some((a) => simulatedTime(alertStartMs(a), a.createdAt?.toMillis?.(), madeAt));
  const csv = st?.lastSource === "csv";

  return (
    <main className="page vet-view" id="main">
      <div className="no-print vet-bar">
        <Link to={`/perros/${dog.id}`} className="back-link"><Icon name="chevron-left" size={14} /> Volver a {dog.name}</Link>
        <div className="vet-actions">
          <div className="row">
            <Seg label="Periodo" options={PERIODS} value={days} onChange={setDays} />
            {/* An empty period has nothing to download. */}
            <button type="button" className="btn btn-primary" aria-describedby="pdf-hint" onClick={() => window.print()} disabled={!hasData}><Icon name="download" />Descargar PDF</button>
          </div>
          <p className="xs muted" id="pdf-hint">{hasData || trend.loading ? "Se abre el diálogo de impresión: elige «Guardar como PDF»." : "No hay datos en este periodo: el PDF estaría vacío."}</p>
        </div>
      </div>

      {/* On paper the sheet sits in a one-cell table whose header repeats on every page: the dog and the period. On screen it is
          a plain block. */}
      <table className="vet-frame" role="presentation">
      <thead className="vet-runhead" aria-hidden="true"><tr><th scope="col">{dog.name} · Vista para el veterinario · {trend.start != null ? `${dateText(trend.start)} – ${dateText(trend.end!)}` : "Sin datos"}</th></tr></thead>
      <tbody><tr><td>
      <div className="vet-paper">
      <header className="vet-head">
        <h1 className="page-title">{dog.name}</h1>
        <p className="vet-doc"><Icon name="stethoscope" size={16} />Vista para el veterinario · solo lectura</p>
        <dl className="vet-facts">
          <div><dt>Raza</dt><dd>{dog.breed || NO_DATA}</dd></div>
          <div><dt>Edad</dt><dd>{ageText(dog.birthDate) ?? NO_DATA}</dd></div>
          <div><dt>Peso</dt><dd>{dog.weightKg ? `${fmtNum(dog.weightKg, Number.isInteger(dog.weightKg) ? 0 : 1)} kg` : NO_DATA}</dd></div>
          <div><dt>Sexo</dt><dd>{sexText}</dd></div>
          <div><dt>Periodo</dt><dd>{trend.start != null ? `${dateText(trend.start)} – ${dateText(trend.end!)}` : "Sin datos"}</dd></div>
          <div><dt>Días con datos</dt><dd>{cover.first != null ? `${cover.days} (desde el ${dateText(cover.first)})` : NO_DATA}</dd></div>
          <div><dt>Patrón normal</dt><dd>{b ? (baselineAt ? `Aprendido el ${dateText(baselineAt)}` : "Aprendido") : `${LEARNING_TEXT} (sin línea base)`}</dd></div>
          <div><dt>Últimos datos</dt><dd>{lastData != null ? dateTimeText(lastData) : NO_DATA}</dd></div>
          <div><dt>Generado</dt><dd>{dateTimeText(madeAt)}{simulated ? " (hora real)" : ""}</dd></div>
        </dl>
        <p className="vet-disclaimer"><Icon name="info" size={14} /> Datos de sensores y modelo predictivo. Sin diagnóstico.</p>
        {simulated && (csv ? (
          <p className="vet-disclaimer vet-flag"><Icon name="clock" size={14} /><span><strong>Horas del archivo:</strong> estos son datos que cargaste tú, y sus horas son posteriores a la hora en que llegaron. «Últimos datos» es la hora en que llegaron; los eventos llevan la hora del archivo.</span></p>
        ) : (
          <p className="vet-disclaimer vet-flag"><Icon name="clock" size={14} /><span><strong>Tiempo simulado:</strong> estos datos vienen de una demostración que avanza más rápido que el reloj. «Últimos datos» es la hora en que llegaron; los eventos llevan la hora de la demostración, que puede ser posterior a la hora en que se generó esta vista.</span></p>
        ))}
        {hasData && cover.days < days && (
          <p className="vet-disclaimer vet-flag"><Icon name="alert-triangle" size={14} /><span><strong>Resumen parcial:</strong> {cover.days} {cover.days === 1 ? "día" : "días"} con datos de los {days} del periodo.</span></p>
        )}
        {!b && <p className="vet-disclaimer vet-flag"><Icon name="info" size={14} /><span><strong>Todavía sin línea base:</strong> solo se aplican los rangos de referencia y no hay alertas respecto al patrón del perro.</span></p>}
      </header>

      {trend.loading && !trend.items.length ? <div aria-busy="true"><Skeleton lines={[30, 60, 100]} /></div> : !trend.items.length ? (
        <EmptyState icon="clock" title="Sin datos en este periodo" text={`Todavía no hay datos de ${dog.name} para este periodo.`} />
      ) : (
        <>
          <section className="vet-section vet-signals" aria-labelledby="v-signals">
            <h2 className="section-title" id="v-signals">Señales del periodo</h2>
            <div className="table-wrap" role="region" aria-label="Señales del periodo" tabIndex={0}>
              <table className="table table-compact table-stack" role="table">
                <thead role="rowgroup"><tr role="row"><th role="columnheader">Señal</th><th role="columnheader" className="num">Mínimo</th><th role="columnheader" className="num">Máximo</th><th role="columnheader" className="num">Promedio</th><th role="columnheader" className="num">Línea base del perro (media ± DE)</th><th role="columnheader">Referencia</th></tr></thead>
                <tbody role="rowgroup">
                  {/* The dog's own range first; the general 100–150 lpm stays as information. */}
                  <tr role="row"><td role="cell" data-title>Frecuencia cardiaca (lpm)</td>
                    <td role="cell" className="num" data-label="Mínimo">{sum.hr ? fmtNum(sum.hr.min) : NO_DATA}</td><td role="cell" className="num" data-label="Máximo">{sum.hr ? fmtNum(sum.hr.max) : NO_DATA}</td>
                    <td role="cell" className="num" data-label="Promedio">{sum.hr ? fmtNum(sum.hr.mean) : NO_DATA}</td><td role="cell" className="num" data-label="Línea base">{b ? pm(b.hrMean, b.hrStd) : NO_DATA}</td>
                    <td role="cell" data-label="Referencia" data-wide>{hb ? `Del perro: ${hb[0]}–${hb[1]}. General: ${cfg.hrRange.join("–")} (solo informativa)` : `General: ${cfg.hrRange.join("–")} (solo informativa; el sistema compara con el patrón del perro)`}</td></tr>
                  <tr role="row"><td role="cell" data-title>Temperatura (°C)</td>
                    <td role="cell" className="num" data-label="Mínimo">{sum.temp ? fmtNum(sum.temp.min, 1) : NO_DATA}</td><td role="cell" className="num" data-label="Máximo">{sum.temp ? fmtNum(sum.temp.max, 1) : NO_DATA}</td>
                    <td role="cell" className="num" data-label="Promedio">{sum.temp ? fmtNum(sum.temp.mean, 1) : NO_DATA}</td><td role="cell" className="num" data-label="Línea base">{b ? pm(b.tempMean, b.tempStd, 1) : NO_DATA}</td>
                    <td role="cell" data-label="Referencia" data-wide>{fmtNum(cfg.tempRange[0], 1)}–{fmtNum(cfg.tempRange[1], 1)}</td></tr>
                  <tr role="row"><td role="cell" data-title>Tiempo en movimiento (%)</td>
                    <td role="cell" className="num" data-label="Mínimo">{act ? fmtNum(100 * act.min) : NO_DATA}</td><td role="cell" className="num" data-label="Máximo">{act ? fmtNum(100 * act.max) : NO_DATA}</td>
                    <td role="cell" className="num" data-label="Promedio">{sum.activity != null ? fmtNum(100 * sum.activity) : NO_DATA}</td><td role="cell" className="num" data-label="Línea base">{b ? pm(100 * b.activeRatioMean, 100 * b.activeRatioStd) : NO_DATA}</td>
                    <td role="cell" data-label="Referencia" data-wide>{ab ? `Del perro: ${fmtNum(100 * ab[0])}–${fmtNum(100 * ab[1])}` : NOT_APPLICABLE}</td></tr>
                  {/* Without a baseline there is no Health Score respect to the dog's pattern. */}
                  <tr role="row"><td role="cell" data-title>Health Score (0–100)</td>
                    <td role="cell" className="num" data-label="Mínimo">{!b ? NOT_APPLICABLE : sum.healthScore ? fmtNum(sum.healthScore.min) : NO_DATA}</td><td role="cell" className="num" data-label="Máximo">{NOT_APPLICABLE}</td>
                    <td role="cell" className="num" data-label="Promedio">{!b ? NOT_APPLICABLE : sum.healthScore ? fmtNum(sum.healthScore.mean) : NO_DATA}</td><td role="cell" className="num" data-label="Línea base">{NOT_APPLICABLE}</td>
                    <td role="cell" data-label="Referencia" data-wide>≥ {cfg.levels.green} normal · {cfg.levels.amber}–{cfg.levels.green - 1} atención · &lt; {cfg.levels.amber} revisar</td></tr>
                </tbody>
              </table>
            </div>
            {/* Three notes, each one whole in its column (a sentence never breaks across the two). */}
            <div className="vet-notes">
              <p className="vet-note">Mínimo y máximo de FC sobre valores de 1 s; de temperatura, por bloque de datos (2 o 10 s); de movimiento, del promedio de {avgMin} minutos en cada franja de 5 minutos.</p>
              <p className="vet-note">La línea base de FC es la de sus promedios de {cfg.hrAverageS} s, y la de movimiento, la de sus promedios de {avgMin} minutos: el sistema compara esos promedios con la media ± {fmtNum(cfg.baselineSigma)} DE{bands ? ` (${bands})` : ""}.</p>
              <p className="vet-note">{b ? <>Tiempo en cada nivel, por bloque de datos: normal {share(sum.levels.green)}, atención {share(sum.levels.amber)}, revisar {share(sum.levels.red)}.
              El mínimo del Health Score es el de un solo bloque (instantáneo); el estado que ve el dueño es un promedio de {fmtNum((cfg.stableTimeConstantS ?? 300) / 60)} minutos.</>
                : <>Sin línea base todavía, el Health Score no se compara con el patrón del perro: solo se aplican los rangos de referencia.</>}</p>
            </div>
          </section>

          <div className="vet-two">
          <section className="vet-section" aria-labelledby="v-events">
            <h2 className="section-title" id="v-events">Eventos anómalos ({inPeriod.length})</h2>
            {!inPeriod.length ? <p className="small muted">Sin eventos en el periodo.</p> : (
              <div className="table-wrap" role="region" aria-label="Eventos anómalos" tabIndex={0}>
                <table className="table table-compact table-stack" role="table">
                  <thead role="rowgroup"><tr role="row"><th role="columnheader">Fecha y hora</th><th role="columnheader">Duración</th><th role="columnheader">Variable</th><th role="columnheader" className="num">Valor</th><th role="columnheader">Rango normal</th></tr></thead>
                  <tbody role="rowgroup">
                    {inPeriod.flatMap((a) => orderReasons(a.reasons, a.titleCode).map((r, i) => {
                      const { unit, decimals } = reasonUnit(r), start = alertStartMs(a), end = a.endedAt?.toMillis?.();
                      const ahead = i === 0 && simulatedTime(start, a.createdAt?.toMillis?.(), madeAt);
                      return (
                        <tr key={`${a.id}-${r.code}`} role="row">
                          {/* The tag of simulated time is its own line on a wide screen (class `vet-ahead`), so the
                              date column stays as narrow as the date and the table fits its column. The text is the same. */}
                          <td role="cell" className="nowrap" data-label="Fecha y hora" data-wide>{i === 0 ? <>{dateTimeText(start)}{ahead && <span className="vet-ahead"> ({aheadTag(st?.lastSource)})</span>}</> : ""}</td>
                          <td role="cell" className="nowrap" data-label="Duración">{i === 0 ? (end ? durationText(end - start) : "en curso") : ""}</td>
                          <td role="cell" data-label="Variable" data-title>{reasonLabel(r)}</td>
                          <td role="cell" className="num" data-label="Valor">{fmtNum(r.value, decimals)} {unit}</td>
                          <td role="cell" className="nowrap" data-label="Rango normal">{fmtNum(r.normalRange[0], decimals)}–{fmtNum(r.normalRange[1], decimals)} {unit}</td>
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
              <p className="vet-note">Clasificadas por el modelo de conducta en ventanas de 2 s (ver «Método y fuentes»).</p>
            </section>
          )}
          </div>
        </>
      )}

      {/* The full method, at the end, for the vet: the source of each signal (by its citation,
          never a company's name), the model versions and the demonstration temperature. */}
      <section className="vet-section" aria-labelledby="v-method">
        <h2 className="section-title" id="v-method">Método y fuentes</h2>
        <ul className="vet-sources">
          {sources.length > 0 && <li>Fuente de cada señal: {sources.join("; ")}.</li>}
          {syntheticTemp && <li>Temperatura de demostración: no existen series públicas de temperatura de perros, así que en esta etapa es una serie sintética alrededor de 38.6 °C (Dorn et al., 2024). No proviene de un sensor.</li>}
          <li>Conducta: {behaviorModel ? `modelo ${behaviorModel} (CNN-LSTM), en ventanas de 2 s` : "regla estadística provisional"}.</li>
          <li>Frecuencia cardiaca: {physioModel
            ? `modelo ${physioModel} (forma de cada minuto, cuando hay 60 s seguidos de datos) combinado con la regla del promedio respecto a la línea base del perro`
            : "regla provisional del promedio respecto a la línea base del perro"}. Temperatura: reglas provisionales (rango de referencia y desviación respecto a su valor habitual).</li>
          <li>La línea base se calcula con los datos normales del propio perro. Los valores de las alertas se comparan con ella; la referencia general de FC ({cfg.hrRange.join("–")} lpm) es solo informativa.</li>
        </ul>
      </section>
      </div>
      </td></tr></tbody>
      </table>
    </main>
  );
}
