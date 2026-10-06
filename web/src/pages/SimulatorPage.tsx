/* Screen A1 · Simulator panel, connected to simulatorRuns/{runId}. The runs are executed by the simulator
   process (`npm run sim -- serve` picks up the ones created here); this page creates and controls them. */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addDoc, collection, doc, serverTimestamp, updateDoc, type Timestamp } from "firebase/firestore";
import { ANOMALY_CATALOG, ANOMALY_TYPES, blocksFor, validateInjection } from "@shared/anomalies";
import type { AnomalyType } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { db, usingEmulators } from "../firebase";
import { Ago, Callout, EmptyState, Icon, LevelTag, PageHead, Seg, fmtNum, usePageTitle } from "../components/ui";
import { useActiveModels, useDogs, useFusionConfig, useRuns, type Dog, type Run } from "../data/hooks";

const SPEEDS = [1, 2, 5, 10];
const MAX_DOGS = 10;
const DURATION_LABELS: Record<number, string> = { 30: "30 s", 120: "2 min", 600: "10 min", 1800: "30 min", 3600: "1 h", 21600: "6 h" };
const RUN_LIMITS = [{ value: 0, label: "Sin límite" }, { value: 600, label: "10 min" }, { value: 1800, label: "30 min" }, { value: 3600, label: "1 h" }];
const STATE_TEXT: Record<string, string> = { running: "Reproduciendo", paused: "En pausa", stopped: "Detenida" };

/** State of a run as a tag: colour, icon and text (playing in green, paused in amber, stopped neutral). */
function RunStateTag({ state }: { state: string }) {
  const [cls, icon] = state === "running" ? ["tag-green", "play"] : state === "paused" ? ["tag-amber", "pause"] : ["tag-outline", "square"];
  return <span className={`tag ${cls}`}><Icon name={icon} size={12} />{STATE_TEXT[state] ?? state}</span>;
}

/** Magnitude as the person reads it: percentage of movement removed, change of heart rate, degrees. */
function magnitudeText(type: AnomalyType, m: number): string {
  const unit = ANOMALY_CATALOG.types[type].unit;
  if (unit === "fraction") return `${fmtNum(m * 100)} % menos movimiento`;
  if (unit === "relative") return `${type === "tachycardia" ? "+" : "−"}${fmtNum(m * 100)} % de su FC`;
  return `${type === "fever" ? "+" : "−"}${fmtNum(m, 1)} °C`;
}

const simulable = (d: Dog) => d.source?.imu?.datasetId === "vehkaoja2022" && !!d.source?.hr?.subjectId;

function NewRun({ dogs, uid }: { dogs: Dog[]; uid: string }) {
  const [selected, setSelected] = useState<string[]>(() => dogs.filter(simulable).slice(0, 3).map((d) => d.id));
  const [speed, setSpeed] = useState(10);
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_DOGS ? [...s, id] : s));
  const create = async () => {
    setBusy(true); setError(null);
    try {
      await addDoc(collection(db, "simulatorRuns"), {
        createdBy: uid, dogIds: selected, speed, state: "running", durationS: limit || null, seed: 0,
        pendingInjection: null, injectionsLog: [], worker: null, error: null,
        stats: { blocksWritten: 0, avgLatencyMs: null, p95LatencyMs: null, maxLatencyMs: null, resultsSeen: 0, startedAt: null, stoppedAt: null, lastBlockAt: null },
        schemaVersion: 1, createdAt: serverTimestamp(),
      });
    } catch {
      setError("No se pudo crear la ejecución. Revisa tu conexión y tu rol de administrador.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="new-title">
      <h2 className="panel-title" id="new-title">Nueva ejecución</h2>
      <p className="small muted">Cada perro combina un sujeto de Vehkaoja 2022 (movimiento), uno de Invoxia (FC) y una temperatura sintética, porque ningún dataset público trae las tres señales del mismo perro.</p>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">Perros ({selected.length} de {MAX_DOGS} máx.)</legend>
        <div className="stack-sm" style={{ gap: 4 }}>
          {dogs.map((d) => (
            <label className="check" key={d.id}>
              <input type="checkbox" checked={selected.includes(d.id)} disabled={!simulable(d) || (!selected.includes(d.id) && selected.length >= MAX_DOGS)} onChange={() => toggle(d.id)} />
              <span><strong>{d.name}</strong> <span className="xs muted">{simulable(d) ? `Vehkaoja ${d.source!.imu.subjectId} · ${d.source!.hr.datasetId} ${d.source!.hr.subjectId}` : "sin fuente de datos simulables"}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <div className="stack-sm" style={{ gap: 4 }}><span className="xs muted">Velocidad</span>
          <Seg label="Velocidad inicial" value={speed} onChange={setSpeed} options={SPEEDS.map((x) => ({ value: x, label: `×${x}` }))} /></div>
        <div className="stack-sm" style={{ gap: 4 }}><span className="xs muted">Duración simulada</span>
          <Seg label="Duración simulada" value={limit} onChange={setLimit} options={RUN_LIMITS} /></div>
      </div>
      {error && <Callout kind="error">{error}</Callout>}
      <button className="btn btn-primary" type="button" disabled={busy || !selected.length} onClick={create}><Icon name="play" />Crear ejecución</button>
      <p className="xs muted">A ×1 y ×2 cada perro envía bloques de 2 s (la app se actualiza cada 2 s en tiempo real); desde ×5, bloques de 10 s.</p>
      <p className="xs muted">En el proyecto real, la ejecución arranca sola en la nube (Cloud Run). Con los emuladores, la toma el proceso local del simulador (<span className="mono">npm run sim -- serve</span>).</p>
    </section>
  );
}

function InjectForm({ run, dogs }: { run: Run; dogs: Map<string, Dog> }) {
  const [dogId, setDogId] = useState(run.dogIds[0]);
  const [type, setType] = useState<AnomalyType>("tachycardia");
  const [magnitude, setMagnitude] = useState(ANOMALY_CATALOG.types.tachycardia.default);
  const [durationS, setDurationS] = useState(600);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = ANOMALY_CATALOG.types[type];
  const chooseType = (t: AnomalyType) => { setType(t); setMagnitude(ANOMALY_CATALOG.types[t].default); };
  const inject = async () => {
    setError(null); setSent(null);
    try {
      validateInjection(type, magnitude, durationS);
      await updateDoc(doc(db, "simulatorRuns", run.id), { pendingInjection: { dogId, type, magnitude, durationS } });
      setSent(`Enviada a ${dogs.get(dogId)?.name ?? dogId}: ${spec.label.toLowerCase()}, ${magnitudeText(type, magnitude)}, ${DURATION_LABELS[durationS]}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar la inyección.");
    }
  };
  const bySignal: Record<string, AnomalyType[]> = {};
  for (const t of ANOMALY_TYPES) (bySignal[ANOMALY_CATALOG.types[t].signal] ??= []).push(t);
  const signalText: Record<string, string> = { imu: "Movimiento", hr: "Frecuencia cardiaca", temp: "Temperatura" };
  const step = spec.unit === "celsius" ? 0.1 : 0.01;
  return (
    <section className="panel stack-sm" aria-labelledby="inj-title">
      <h2 className="panel-title" id="inj-title">Inyectar anomalía</h2>
      <div className="field"><label htmlFor="inj-dog">Perro</label>
        <select id="inj-dog" className="select" value={dogId} onChange={(e) => setDogId(e.target.value)}>
          {run.dogIds.map((id) => <option key={id} value={id}>{dogs.get(id)?.name ?? id}</option>)}</select></div>
      <div className="field"><label htmlFor="inj-type">Tipo</label>
        <select id="inj-type" className="select" value={type} onChange={(e) => chooseType(e.target.value as AnomalyType)}>
          {Object.entries(bySignal).map(([sig, items]) => <optgroup key={sig} label={signalText[sig]}>{items.map((t) => <option key={t} value={t}>{ANOMALY_CATALOG.types[t].label}</option>)}</optgroup>)}
        </select></div>
      <div className="field"><label htmlFor="inj-mag">Magnitud</label>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input id="inj-mag" type="range" min={spec.min} max={spec.max} step={step} value={magnitude} onChange={(e) => setMagnitude(Number(e.target.value))} />
          <span className="tabular nowrap" style={{ fontWeight: 600, minWidth: 150, textAlign: "right" }}>{magnitudeText(type, magnitude)}</span>
        </div>
        <div className="field-hint">Rango del catálogo: {spec.min}–{spec.max}. {spec.rampS ? `Llega a su magnitud en ${spec.rampS} s.` : "Efecto inmediato."}</div></div>
      <div className="field"><label htmlFor="inj-dur">Duración</label>
        <select id="inj-dur" className="select" value={durationS} onChange={(e) => setDurationS(Number(e.target.value))}>
          {ANOMALY_CATALOG.durationsS.map((s) => <option key={s} value={s}>{DURATION_LABELS[s] ?? `${s} s`}</option>)}</select>
        <div className="field-hint">{blocksFor(durationS)} bloques de 10 s.</div></div>
      {error && <Callout kind="error">{error}</Callout>}
      {sent && <Callout kind="ok">{sent}</Callout>}
      <button className="btn btn-primary" type="button" onClick={inject} disabled={run.state === "stopped"}><Icon name="flask" />Inyectar anomalía</button>
      <p className="xs muted">Cada bloque afectado guarda <span className="mono">injectedAnomaly</span> como verdad de referencia para la evaluación. La Cloud Function nunca la usa.</p>
    </section>
  );
}

function RunDetail({ run, dogs }: { run: Run; dogs: Map<string, Dog> }) {
  const ref = doc(db, "simulatorRuns", run.id);
  const setState = (state: string) => updateDoc(ref, { state });
  const s = run.stats;
  const perDog = run.dogIds.length ? Math.floor((s.blocksWritten ?? 0) / run.dogIds.length) : 0;
  const active = (run.injectionsLog ?? []).filter((j) => perDog >= j.startBlock && perDog < j.endBlock);
  const waiting = run.state !== "stopped" && !run.worker;
  const sec = (ms: number | null | undefined) => (ms == null ? "—" : `${fmtNum(ms / 1000, 2)} s`);
  return (
    <div className="split">
      <div className="stack">
      <section className="panel stack-sm" aria-label="Controles de la ejecución">
        <div className="sim-bar">
          <div className="sim-status">
            <RunStateTag state={run.state} />
            <span className="small muted">{run.worker ? <>proceso <span className="mono">{run.worker.id}</span></> : "sin proceso"} · <span className="mono">simulatorRuns/{run.id}</span></span>
          </div>
          <div className="sim-controls">
            {run.state === "running"
              ? <button className="btn btn-secondary" type="button" onClick={() => setState("paused")}><Icon name="pause" />Pausar</button>
              : <button className="btn btn-primary" type="button" disabled={run.state === "stopped"} onClick={() => setState("running")}><Icon name="play" />Reanudar</button>}
            <Seg label="Velocidad de reproducción" value={run.speed} onChange={(v) => updateDoc(ref, { speed: v })} options={SPEEDS.map((x) => ({ value: x, label: `×${x}` }))} />
            <button className="btn btn-ghost" type="button" disabled={run.state === "stopped"} onClick={() => setState("stopped")}><Icon name="square" />Detener</button>
          </div>
        </div>
        {waiting && (run.cloudJob && !run.cloudJob.error
          ? <div className="callout"><Icon name="clock" size={16} style={{ marginTop: 1 }} /><div>Iniciando el simulador en la nube. La primera vez puede tardar alrededor de un minuto.</div></div>
          : <Callout kind="error">{run.cloudJob?.error
            ? <>No se pudo iniciar el simulador en la nube ({run.cloudJob.error}). Puedes ejecutarlo desde un equipo con <span className="mono">npm run sim -- serve</span>.</>
            : <>Esperando al proceso del simulador. Ejecuta <span className="mono">npm run sim -- serve</span> en una terminal.</>}</Callout>)}
        {run.error && <Callout kind="error">{run.error}</Callout>}
        <div className="stats">
          <div className="stat"><div className="stat-label">Perros</div><div className="stat-value">{run.dogIds.length}</div></div>
          <div className="stat"><div className="stat-label">Bloques escritos</div><div className="stat-value tabular">{fmtNum(s.blocksWritten)}</div>
            <div className="stat-note">{fmtNum((perDog * 10) / 60, 1)} min simulados por perro{run.durationS ? ` de ${run.durationS / 60}` : ""}</div></div>
          <div className="stat"><div className="stat-label">Resultados</div><div className="stat-value tabular">{fmtNum(s.resultsSeen ?? 0)}</div></div>
          <div className="stat"><div className="stat-label">Último bloque</div><div className="stat-value stat-value-sm"><Ago t={s.lastBlockAt?.toDate?.()} /></div></div>
        </div>
      </section>

        <section className="panel stack-sm" aria-labelledby="dogs-title">
          <h2 className="panel-title" id="dogs-title">Perros de la ejecución</h2>
          <div className="table-wrap" role="region" aria-label="Perros de la ejecución" tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Perro</th><th scope="col">Estado</th><th scope="col" className="num">HS</th><th scope="col">Anomalía activa</th></tr></thead>
              <tbody>{run.dogIds.map((id) => {
                const d = dogs.get(id), st = d?.status;
                const inj = active.filter((j) => j.dogId === id);
                return (
                  <tr key={id}>
                    <td><strong>{d?.name ?? id}</strong><div className="xs muted">{d?.breed}</div></td>
                    <td><LevelTag level={st?.level} /></td>
                    <td className="num tabular" style={{ fontWeight: 600 }}>{st?.healthScore ?? "—"}</td>
                    <td>{inj.length ? inj.map((j) => `${ANOMALY_CATALOG.types[j.type].label} (${magnitudeText(j.type, j.magnitude)})`).join(" + ") : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
        <section className="panel stack-sm" aria-labelledby="log-title">
          <h2 className="panel-title" id="log-title">Inyecciones de esta ejecución ({run.injectionsLog?.length ?? 0})</h2>
          {!run.injectionsLog?.length ? <p className="small muted">Todavía no hay inyecciones.</p> : (
            <div className="log" role="log" aria-label="Inyecciones de la ejecución" tabIndex={0}>
              {[...run.injectionsLog].reverse().map((j) => (
                <div className="log-line" key={j.id}>
                  <span className="log-time">{(j.at as Timestamp)?.toDate?.().toLocaleTimeString("es-PE") ?? ""}</span>
                  <span className="log-dog">{dogs.get(j.dogId)?.name ?? j.dogId}</span>
                  <span className="log-msg">{ANOMALY_CATALOG.types[j.type].label}, {magnitudeText(j.type, j.magnitude)}, {DURATION_LABELS[j.durationS] ?? `${j.durationS} s`} · bloques {j.startBlock}–{j.endBlock - 1}{perDog >= j.startBlock && perDog < j.endBlock ? " · en curso" : perDog >= j.endBlock ? " · terminada" : ""}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="stack">
        <InjectForm key={run.id} run={run} dogs={dogs} />
        <section className="panel stack-sm" aria-labelledby="lat-title">
          <h2 className="panel-title" id="lat-title">Latencia medida</h2>
          <div className="stats stats-3">
            <div className="stat"><div className="stat-label">Promedio</div><div className="stat-value tabular">{sec(s.avgLatencyMs)}</div></div>
            <div className="stat"><div className="stat-label">Percentil 95</div><div className="stat-value tabular">{sec(s.p95LatencyMs)}</div></div>
            <div className="stat"><div className="stat-label">Máxima</div><div className="stat-value tabular">{sec(s.maxLatencyMs)}</div></div>
          </div>
          <p className="xs muted">Desde la escritura de cada bloque en <span className="mono">readings</span> hasta su resultado (<span className="mono">results.latencyMs</span>), últimos 500 bloques.
            {usingEmulators ? <strong> Medida en los emuladores locales:</strong> : null}{usingEmulators ? " no representa la latencia en la nube." : null}</p>
          <div className="row small latency-goal"><Icon name="zap" size={15} />Meta del sistema: menos de 5 s (RNF-01).</div>
        </section>
      </div>
    </div>
  );
}

function ModelsPanel() {
  const { data: models, loading } = useActiveModels();
  const behavior = models.find((m) => m.kind === "behavior");
  const physio = models.find((m) => m.kind === "physiological");
  const m = behavior?.metrics ?? {};
  const p = physio?.metrics ?? {};
  const pct = (v: number | undefined) => (v == null ? "—" : `${fmtNum(100 * v, 1)} %`);
  return (
    <section className="panel stack-sm" aria-labelledby="model-title">
      <h2 className="panel-title" id="model-title">Modelos activos</h2>
      {loading ? <p className="small">Cargando…</p> : (
        <>
          <h3 className="form-group-title">Conducta</h3>
          {!behavior ? (
            <p className="small muted">No hay un modelo registrado en <span className="mono">modelVersions</span>: la conducta usa la regla provisional de movimiento.</p>
          ) : (
            <dl className="dl">
              <div className="dl-row"><dt>Versión</dt><dd className="mono">{behavior.version}</dd></div>
              <div className="dl-row"><dt>F1 macro (perros de prueba · validación)</dt><dd>{fmtNum(m.test_macro_f1, 3)} · {fmtNum(m.val_macro_f1, 3)} <span className="xs muted">meta ≥ 0.75</span></dd></div>
              <div className="dl-row"><dt>Actividad frente a reposo</dt><dd>{fmtNum(100 * (m.test_active_balanced_accuracy ?? 0), 1)} % de exactitud balanceada</dd></div>
              <div className="dl-row"><dt>Datos de entrenamiento</dt><dd className="small">{behavior.trainingData.join("; ")}</dd></div>
              <div className="dl-row"><dt>Entrenado</dt><dd>{behavior.trainedAt?.toDate?.().toLocaleDateString("es-PE") ?? "—"}</dd></div>
            </dl>
          )}
          <h3 className="form-group-title">Frecuencia cardiaca</h3>
          {!physio ? (
            <p className="small muted">No hay un modelo fisiológico registrado: la frecuencia cardiaca usa la regla provisional del promedio respecto a la línea base.</p>
          ) : (
            <dl className="dl">
              <div className="dl-row"><dt>Versión</dt><dd className="mono">{physio.version} <span className="xs muted">autoencoder combinado con la regla del promedio</span></dd></div>
              <div className="dl-row"><dt>Combinado (perros de prueba)</dt><dd>F1 {fmtNum(p.combined_test_f1, 3)} · {pct(p.combined_test_normal_flagged)} de secuencias normales marcadas <span className="xs muted">meta ≥ 0.75</span></dd></div>
              <div className="dl-row"><dt>Solo el autoencoder (AUROC)</dt><dd>taquicardia {fmtNum(p.tachycardia_auroc, 3)} · bradicardia {fmtNum(p.bradycardia_auroc, 3)}</dd></div>
              <div className="dl-row"><dt>Marcadas durante actividad (estudio de 4 perros)</dt><dd>autoencoder {pct(p.activity_flagged_autoencoder)} · regla {pct(p.activity_flagged_rule)}</dd></div>
              <div className="dl-row"><dt>Datos de entrenamiento</dt><dd className="small">{physio.trainingData.join("; ")}</dd></div>
              <div className="dl-row"><dt>Entrenado</dt><dd>{physio.trainedAt?.toDate?.().toLocaleDateString("es-PE") ?? "—"}</dd></div>
            </dl>
          )}
          <p className="xs muted">La temperatura sigue con reglas provisionales (no hay series caninas públicas).</p>
        </>
      )}
    </section>
  );
}

function FusionConfigPanel() {
  const { data: c, loading, error } = useFusionConfig();
  const rows: [string, string][] = [
    ["Pesos (conducta · FC · temperatura)", `${c.weights.b} · ${c.weights.p} · ${c.weights.t}`],
    ["Umbral de alerta", `Health Score < ${c.alertThreshold}`],
    ["Niveles", `verde ≥ ${c.levels.green} · ámbar ${c.levels.amber}–${c.levels.green - 1} · rojo < ${c.levels.amber}`],
    ["Ventanas consecutivas para regla crítica", String(c.consecutiveCritical)],
    ["Rango de FC de referencia (informativo)", `${c.hrRange[0]}–${c.hrRange[1]} lpm`],
    ["Rango de temperatura", `${fmtNum(c.tempRange[0], 1)}–${fmtNum(c.tempRange[1], 1)} °C`],
    ["Sigmas respecto a la línea base", String(c.baselineSigma)],
    ["Umbral de movimiento (regla provisional)", `${fmtNum(c.activity.thresholdG, 3)} g · promedio de ${c.activity.timeConstantS / 60} min`],
    ["FC promediada", `${c.hrAverageS} s`],
    ["Cierre de un episodio de alerta", `${c.episodeGapS} s sin disparo`],
    ["Duración mínima de una alerta", c.alertMinDurationS ? `${c.alertMinDurationS} s de disparo seguido` : "sin mínimo"],
    ["Regla de actividad baja", c.activityCriticalSigma != null ? `media − ${c.activityCriticalSigma} σ del perro` : "sin regla"],
    ["Prefiltro", `FC ${c.prefilter.hrMin}–${c.prefilter.hrMax} lpm · temperatura ${c.prefilter.tempMin}–${c.prefilter.tempMax} °C`],
  ];
  return (
    <section className="panel stack-sm" aria-labelledby="cfg-title">
      <h2 className="panel-title" id="cfg-title">Configuración de fusión vigente</h2>
      <p className="small muted">Se lee de <span className="mono">config/fusion</span>. <Link to="/admin/configuracion">Editar en Modelos y configuración</Link>.</p>
      {error && <Callout kind="error">No pudimos leer la configuración.</Callout>}
      {loading ? <p className="small">Cargando…</p> : <dl className="dl">{rows.map(([k, v]) => <div className="dl-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    </section>
  );
}

export function SimulatorPage() {
  usePageTitle("Simulador");
  const { user } = useAuth();
  const { data: runs, loading, error } = useRuns();
  const { data: allDogs } = useDogs({ kind: "all" });
  const dogs = useMemo(() => new Map(allDogs.map((d) => [d.id, d])), [allDogs]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selectedId) ?? runs.find((r) => r.state !== "stopped") ?? runs[0];
  return (
    <main className="page" id="main">
      <PageHead kicker="Herramientas de investigación" title="Simulador"
        sub="Reproduce sujetos de los datasets públicos al ritmo real (o hasta 10 veces más rápido), escribe un bloque de 2 a 10 s por documento en readings e inyecta anomalías con su verdad de referencia." />
      <div className="stack">
        <div className="callout"><Icon name="info" size={16} style={{ marginTop: 1 }} /><div>La conducta la clasifica el <strong>modelo CNN-LSTM</strong> y la frecuencia cardiaca, el <strong>autoencoder LSTM</strong> junto con la regla del promedio; la temperatura sigue con <strong>reglas provisionales</strong>. La latencia se mide en cada bloque.</div></div>
        {error && <Callout kind="error">No pudimos cargar las ejecuciones.</Callout>}
        {loading ? <p className="small">Cargando ejecuciones…</p>
          : selected ? <RunDetail run={selected} dogs={dogs} />
          : <EmptyState icon="flask" title="Todavía no hay ejecuciones" text="Crea una ejecución abajo o desde la terminal con npm run sim -- start." />}
        {!loading && runs.length > 0 && (
          <section className="panel stack-sm" aria-labelledby="runs-title">
            <h2 className="panel-title" id="runs-title">Ejecuciones recientes</h2>
            <div className="table-wrap" role="region" aria-label="Ejecuciones recientes" tabIndex={0}>
              <table className="table">
                <thead><tr><th scope="col">Ejecución</th><th scope="col">Estado</th><th scope="col">Perros</th><th scope="col" className="num">Bloques</th><th scope="col" className="num">Latencia media</th><th scope="col"><span className="sr-only">Abrir</span></th></tr></thead>
                <tbody>{runs.map((r) => (
                  <tr key={r.id} aria-current={r.id === selected?.id ? "true" : undefined} className={r.id === selected?.id ? "row-current" : undefined}>
                    <td className="mono">{r.id}</td>
                    <td>{STATE_TEXT[r.state]}{r.state !== "stopped" && !r.worker ? " · en espera" : ""}</td>
                    <td>{r.dogIds.map((id) => dogs.get(id)?.name ?? id).join(", ")}</td>
                    <td className="num tabular">{fmtNum(r.stats?.blocksWritten ?? 0)}</td>
                    <td className="num tabular">{r.stats?.avgLatencyMs == null ? "—" : `${fmtNum(r.stats.avgLatencyMs / 1000, 2)} s`}</td>
                    <td><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelectedId(r.id)}>Ver</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
        <div className="split">
          {user && <NewRun dogs={allDogs} uid={user.uid} />}
          <div className="stack">
            <ModelsPanel />
            <FusionConfigPanel />
          </div>
        </div>
      </div>
    </main>
  );
}
