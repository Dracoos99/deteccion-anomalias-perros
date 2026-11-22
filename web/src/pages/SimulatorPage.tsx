/* Screen A1 · Simulator panel, connected to simulatorRuns/{runId}. The runs are executed by the simulator
   process (`npm run sim -- serve` picks up the ones created here); this page creates and controls them. */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addDoc, arrayUnion, collection, doc, serverTimestamp, updateDoc, type Timestamp } from "firebase/firestore";
import { ANOMALY_CATALOG, ANOMALY_TYPES, blocksFor, validateInjection } from "@shared/anomalies";
import type { AnomalyType } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { db, usingEmulators } from "../firebase";
import { Ago, Callout, EmptyState, Icon, LevelTag, PageFrame, PageHead, Seg, StateTag, fmtNum, useNow, usePageTitle } from "../components/ui";
import { useActiveModels, useDogs, useFusionConfig, useRuns, type Dog, type Run } from "../data/hooks";
import { datasetText, durationText } from "../lib/plain";
import { holdsDogs, learningStageMs, overGoal, runPhase, type Phase, type RunLike } from "../lib/simRun";
import { BehaviorCompare, RunPipeline } from "../components/RunInsights";

const SPEEDS = [1, 2, 5, 10];
const MAX_DOGS = 10;
const DURATION_LABELS: Record<number, string> = { 30: "30 s", 120: "2 min", 600: "10 min", 1800: "30 min", 3600: "1 h", 21600: "6 h" };
const RUN_LIMITS = [{ value: 0, label: "Sin límite" }, { value: 600, label: "10 min" }, { value: 1800, label: "30 min" }, { value: 3600, label: "1 h" }];
const PHASE: Record<Phase, { text: string; cls: string; icon: string }> = {
  waiting: { text: "Esperando al proceso", cls: "tag-outline", icon: "clock" },
  starting: { text: "Iniciando", cls: "tag-outline", icon: "clock" },
  stalled: { text: "No arrancó", cls: "tag-amber", icon: "alert-triangle" },
  running: { text: "Reproduciendo", cls: "tag-green", icon: "play" },
  paused: { text: "En pausa", cls: "tag-amber", icon: "pause" },
  finished: { text: "Terminada", cls: "tag-outline", icon: "check" },
  stopped: { text: "Detenida", cls: "tag-outline", icon: "square" },
  interrupted: { text: "Se interrumpió", cls: "tag-amber", icon: "alert-triangle" },
};

/** State of a run as a tag: colour, icon and text (playing in green, paused and not started in amber, the rest
 * neutral). The phase rules are in lib/simRun.ts. */
function RunStateTag({ run, now, large = false }: { run: RunLike; now: number; large?: boolean }) {
  const p = PHASE[runPhase(run, now)];
  return <span className={`tag ${p.cls}${large ? " tag-lg" : ""}`}><Icon name={p.icon} size={large ? 16 : 12} />{p.text}</span>;
}

/** Magnitude as the person reads it: percentage of movement removed, change of heart rate, degrees. `short` is the
 * value beside the slider. */
function magnitudeText(type: AnomalyType, m: number, short = false): string {
  const unit = ANOMALY_CATALOG.types[type].unit;
  if (unit === "fraction") return short ? `−${fmtNum(m * 100)} % de movimiento` : `${fmtNum(m * 100)} % menos movimiento`;
  if (unit === "relative") return `${type === "tachycardia" ? "+" : "−"}${fmtNum(m * 100)} % de ${short ? "FC" : "su FC"}`;
  // The collar off the dog reads the room's temperature.
  if (type === "collar_off") return `${short ? "" : "temperatura ambiente "}${fmtNum(m, 0)} °C`;
  return `${type === "fever" ? "+" : "−"}${fmtNum(m, 1)} °C`;
}

/** The active injections of a dog in one line; two equal ones read «… ×2», not the same text twice. */
function injectionsText(inj: { type: AnomalyType; magnitude: number }[]): string {
  const counts = new Map<string, number>();
  for (const j of inj) {
    const text = `${ANOMALY_CATALOG.types[j.type].label} (${magnitudeText(j.type, j.magnitude)})`;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, n]) => (n > 1 ? `${text} ×${n}` : text)).join(" + ");
}

const simulable = (d: Dog) => d.source?.imu?.datasetId === "vehkaoja2022" && !!d.source?.hr?.subjectId;

/** A dog in another active run cannot be chosen (the simulator refuses a dog in two active runs). */
function NewRun({ dogs, uid, busyDogs, onCreated, minBlocks }: { dogs: Dog[]; uid: string; busyDogs: Set<string>; onCreated: (runId: string) => void; minBlocks: number }) {
  const [picked, setSelected] = useState<string[]>(() => dogs.filter(simulable).filter((d) => !busyDogs.has(d.id)).slice(0, 3).map((d) => d.id));
  const selected = picked.filter((id) => !busyDogs.has(id));
  const [speed, setSpeed] = useState(10);
  const [limit, setLimit] = useState(0);
  // A «new dog» run: the Function learns the dogs' baselines from the stream, as for a dog an owner registers.
  const [learn, setLearn] = useState(false);
  // Also write the behavior annotated from video, for «Conducta anotada frente a la del modelo».
  const [truth, setTruth] = useState(false);
  const stage = learningStageMs(minBlocks, speed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_DOGS ? [...s, id] : s));
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const ref = await addDoc(collection(db, "simulatorRuns"), {
        createdBy: uid, dogIds: selected, speed, state: "running", durationS: limit || null, seed: 0, learnBaseline: learn, recordTruth: truth,
        pendingInjections: [], injectionsLog: [], worker: null, error: null,
        stats: { blocksWritten: 0, avgLatencyMs: null, p95LatencyMs: null, maxLatencyMs: null, resultsSeen: 0, startedAt: null, stoppedAt: null, lastBlockAt: null },
        schemaVersion: 1, createdAt: serverTimestamp(),
      });
      // The new run takes the panel at the top, in view, and its dogs leave this form.
      onCreated(ref.id);
      setSelected([]);
    } catch {
      setError("No se pudo crear la ejecución. Revisa tu conexión y tu rol de administrador.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel stack-sm" aria-labelledby="new-title">
      <h2 className="panel-title" id="new-title">Nueva ejecución</h2>
      <p className="small muted">Cada perro combina un sujeto de Vehkaoja 2022 (movimiento), uno del dataset público de frecuencia cardiaca (2023) y una temperatura sintética, porque ningún dataset público trae las tres señales del mismo perro.</p>
      <fieldset className="field fieldset-plain">
        <legend className="field-label">Perros ({selected.length} de {MAX_DOGS} máx.)</legend>
        <div className="stack-sm field-stack">
          {dogs.map((d) => {
            const inRun = busyDogs.has(d.id);
            return (
              <label className="check" key={d.id}>
                <input type="checkbox" checked={selected.includes(d.id)} disabled={!simulable(d) || inRun || (!selected.includes(d.id) && selected.length >= MAX_DOGS)} onChange={() => toggle(d.id)} />
                <span><strong>{d.name}</strong> <span className={inRun ? "tag tag-outline" : "xs muted"}>{inRun ? <><Icon name="play" size={12} />en otra ejecución activa</>
                  : simulable(d) ? `Vehkaoja ${d.source!.imu.subjectId} · FC: ${datasetText(d.source!.hr.datasetId)}, sujeto ${d.source!.hr.subjectId}` : "sin fuente de datos simulables"}</span></span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="row">
        <div className="stack-sm field-stack"><span className="xs muted">Velocidad</span>
          <Seg label="Velocidad inicial" value={speed} onChange={setSpeed} options={SPEEDS.map((x) => ({ value: x, label: `×${x}` }))} /></div>
        <div className="stack-sm field-stack"><span className="xs muted">Duración simulada</span>
          <Seg label="Duración simulada" value={limit} onChange={setLimit} options={RUN_LIMITS} /></div>
      </div>
      <label className="check">
        <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} />
        <span><strong>Perro nuevo</strong> <span className="xs muted">El sistema aprende su patrón normal con sus primeros datos, como con un perro recién registrado. Se borra la línea base de los perros elegidos.</span></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={truth} onChange={(e) => setTruth(e.target.checked)} />
        <span><strong>Guardar la conducta anotada</strong> <span className="xs muted">Para comparar, bloque a bloque, la conducta anotada en el video del dataset con la que reconoce el modelo. Duplica las escrituras de la ejecución.</span></span>
      </label>
      {learn && <p className="xs muted">Son dos etapas de {durationText(stage.dataMs)} de datos cada una: a ×{speed}, {stage.clockMs < 90_000 ? "un minuto o menos" : `unos ${durationText(stage.clockMs)}`} de reloj por etapa. Se acorta en Modelos y configuración, «Bloques de 10 s por etapa»{minBlocks < 360 ? <>; con menos de 1 h, el patrón normal sale más estrecho y el perro puede leerse distinto de lo habitual al terminar</> : null}.</p>}
      {error && <Callout kind="error">{error}</Callout>}
      <button className="btn btn-primary" type="button" disabled={busy || !selected.length} onClick={create}><Icon name="play" />Crear ejecución</button>
      <p className="xs muted">A ×1 y ×2 cada perro envía bloques de 2 s (la app se actualiza cada 2 s en tiempo real); desde ×5, bloques de 10 s.</p>
      <p className="xs muted">En el proyecto real, la ejecución arranca sola en la nube (Cloud Run). Con los emuladores, la toma el proceso local del simulador (<span className="mono">npm run sim -- serve</span>).</p>
    </section>
  );
}

/** The scenarios of the demonstration, within the catalog's ranges. */
interface Scenario { label: string; type: AnomalyType; magnitude: number; durationS: number }
const SCENARIOS: Scenario[] = [
  { label: "Fiebre (+1.5 °C, 30 min)", type: "fever", magnitude: 1.5, durationS: 1800 },
  { label: "Taquicardia (+60 %, 30 min)", type: "tachycardia", magnitude: 0.6, durationS: 1800 },
  { label: "Se mueve menos (−60 %, 1 h)", type: "activity_drop", magnitude: 0.6, durationS: 3600 },
  { label: "Inmovilidad (1 h)", type: "immobility", magnitude: 0.97, durationS: 3600 },
  { label: "Collar quitado (10 min)", type: "collar_off", magnitude: 24, durationS: 600 },
];

function InjectForm({ run, dogs }: { run: Run; dogs: Map<string, Dog> }) {
  const [dogId, setDogId] = useState(run.dogIds[0]);
  const [type, setType] = useState<AnomalyType>("tachycardia");
  const [magnitude, setMagnitude] = useState(ANOMALY_CATALOG.types.tachycardia.default);
  const [durationS, setDurationS] = useState(600);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = ANOMALY_CATALOG.types[type];
  const chooseType = (t: AnomalyType) => { setType(t); setMagnitude(ANOMALY_CATALOG.types[t].default); };
  const inject = async (preset?: Scenario) => {
    setError(null); setSent(null);
    const [t, m, d] = preset ? [preset.type, preset.magnitude, preset.durationS] : [type, magnitude, durationS];
    if (preset) { setType(t); setMagnitude(m); setDurationS(d); }
    try {
      validateInjection(t, m, d);
      // Queued with arrayUnion: several sent in a row all apply (one slot kept only the last one).
      await updateDoc(doc(db, "simulatorRuns", run.id), {
        pendingInjections: arrayUnion({ dogId, type: t, magnitude: m, durationS: d, requestId: crypto.randomUUID() }),
      });
      const what = `${ANOMALY_CATALOG.types[t].label.toLowerCase()}, ${magnitudeText(t, m)}, ${DURATION_LABELS[d]}`;
      // Without a process nothing applies it yet; the panel says so instead of «Enviada».
      setSent(run.worker
        ? `Enviada a ${dogs.get(dogId)?.name ?? dogId}: ${what}.`
        : `Guardada para ${dogs.get(dogId)?.name ?? dogId} (${what}): se aplicará cuando el proceso del simulador tome la ejecución.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar la inyección.");
    }
  };
  const bySignal: Record<string, AnomalyType[]> = {};
  for (const t of ANOMALY_TYPES) (bySignal[ANOMALY_CATALOG.types[t].signal] ??= []).push(t);
  const signalText: Record<string, string> = { imu: "Movimiento", hr: "Frecuencia cardiaca", temp: "Temperatura", sensor: "Sensor (no es del perro)" };
  const step = spec.unit === "celsius" ? 0.1 : 0.01;
  return (
    <section className="panel stack-sm" aria-labelledby="inj-title">
      <h2 className="panel-title" id="inj-title">Inyectar anomalía</h2>
      <div className="field"><label htmlFor="inj-dog">Perro</label>
        <select id="inj-dog" className="select" value={dogId} onChange={(e) => setDogId(e.target.value)}>
          {run.dogIds.map((id) => <option key={id} value={id}>{dogs.get(id)?.name ?? id}</option>)}</select></div>
      {/* The scenarios of the demonstration, one click each on the dog chosen above. */}
      <div className="stack-sm">
        <span className="xs muted">Escenarios de demostración (un clic)</span>
        <div className="scenario-chips">
          {SCENARIOS.map((sc) => (
            <button key={sc.label} className="btn btn-secondary btn-sm" type="button" onClick={() => inject(sc)} disabled={run.state === "stopped"}>{sc.label}</button>
          ))}
        </div>
      </div>
      <div className="field"><label htmlFor="inj-type">Tipo</label>
        <select id="inj-type" className="select" value={type} onChange={(e) => chooseType(e.target.value as AnomalyType)}>
          {Object.entries(bySignal).map(([sig, items]) => <optgroup key={sig} label={signalText[sig]}>{items.map((t) => <option key={t} value={t}>{ANOMALY_CATALOG.types[t].label}</option>)}</optgroup>)}
        </select></div>
      <div className="field"><label htmlFor="inj-mag">Magnitud</label>
        <div className="row slider-row">
          <input id="inj-mag" type="range" min={spec.min} max={spec.max} step={step} value={magnitude} onChange={(e) => setMagnitude(Number(e.target.value))} />
          <span className="tabular nowrap slider-value">{magnitudeText(type, magnitude, true)}</span>
        </div>
        <div className="field-hint">Rango del catálogo: {spec.min}–{spec.max}. {spec.rampS ? `Llega a su magnitud en ${spec.rampS} s.` : "Efecto inmediato."}</div></div>
      <div className="field"><label htmlFor="inj-dur">Duración</label>
        <select id="inj-dur" className="select" value={durationS} onChange={(e) => setDurationS(Number(e.target.value))}>
          {ANOMALY_CATALOG.durationsS.map((s) => <option key={s} value={s}>{DURATION_LABELS[s] ?? `${s} s`}</option>)}</select>
        <div className="field-hint">{blocksFor(durationS)} bloques de 10 s.</div></div>
      {error && <Callout kind="error">{error}</Callout>}
      {sent && <Callout kind="ok">{sent}</Callout>}
      {(run.pendingInjections?.length ?? 0) > 1 && (
        <p className="xs muted" role="status">{run.pendingInjections!.length} inyecciones en espera: se aplican todas juntas cuando el simulador las tome.</p>
      )}
      <button className="btn btn-primary" type="button" onClick={() => inject()} disabled={run.state === "stopped"}><Icon name="flask" />Inyectar anomalía</button>
      <p className="xs muted">Cada bloque afectado guarda <span className="mono">injectedAnomaly</span> como verdad de referencia para la evaluación. La Cloud Function nunca la usa.</p>
    </section>
  );
}

/** What the run needs said about its process: waiting for one, not started, interrupted, stopped at the job's
 * limit, or an error. */
function RunNotices({ run, phase }: { run: Run; phase: Phase }) {
  const waiting = run.state !== "stopped" && !run.worker;
  const stalled = phase === "stalled";
  return (
    <>
      {waiting && (run.cloudJob && !run.cloudJob.error
        ? <div className="callout"><Icon name="clock" size={16} style={{ marginTop: 1 }} /><div>Iniciando el simulador en la nube. La primera vez puede tardar alrededor de un minuto.</div></div>
        : <Callout kind="error">{run.cloudJob?.error
          ? <>No se pudo iniciar el simulador en la nube ({run.cloudJob.error}). Puedes ejecutarlo desde un equipo con <span className="mono">npm run sim -- serve</span>.</>
          : <>Esperando al proceso del simulador. Ejecuta <span className="mono">npm run sim -- serve</span> en una terminal.</>}</Callout>)}
      {stalled && (
        <div className="callout callout-warn"><Icon name="alert-triangle" size={16} style={{ marginTop: 1, color: "var(--color-status-amber)" }} /><div>
          <strong>No arrancó:</strong> revisa que el proceso del simulador esté encendido{run.cloudJob ? " (el trabajo de Cloud Run)" : <> (<span className="mono">npm run sim -- serve</span>)</>}. La primera ejecución después de cambiar el modelo de conducta recalcula la línea base de los perros y puede tardar unos minutos más.
        </div></div>
      )}
      {/* A process that stopped beating, and the job's own limit. */}
      {phase === "interrupted" && (
        <div className="callout callout-warn"><Icon name="alert-triangle" size={16} style={{ marginTop: 1, color: "var(--color-status-amber)" }} /><div>
          <strong>Se interrumpió:</strong> el proceso del simulador dejó de dar señales hace más de 15 minutos (por ejemplo, el trabajo de Cloud Run llegó a su límite de 6 horas). Sus perros quedan libres para otra ejecución{run.state !== "stopped" ? "; detenla para cerrarla" : ""}.
        </div></div>
      )}
      {run.endedBy === "limit" && <div className="callout"><Icon name="info" size={16} style={{ marginTop: 1 }} /><div>Se detuvo sola al llegar al límite de 5 h 30 min del simulador en la nube. Para más tiempo, crea otra ejecución.</div></div>}
      {run.error && <Callout kind="error">{run.error}</Callout>}
    </>
  );
}

/** The dogs of the run: the state of their last block and the anomaly being injected now. */
function RunDogsTable({ run, dogs, active }: { run: Run; dogs: Map<string, Dog>; active: Run["injectionsLog"] }) {
  return (
    <section className="panel stack-sm" aria-labelledby="dogs-title">
      <h2 className="panel-title" id="dogs-title">Perros de la ejecución</h2>
      <div className="table-wrap" role="region" aria-label="Perros de la ejecución" tabIndex={0}>
        <table className="table table-stack">
          <thead><tr><th scope="col">Perro</th><th scope="col">Estado del último bloque</th><th scope="col" className="num">HS</th><th scope="col">Anomalía activa</th></tr></thead>
          <tbody>{run.dogIds.map((id) => {
            const d = dogs.get(id), st = d?.status;
            const inj = active.filter((j) => j.dogId === id);
            return (
              <tr key={id}>
                <td data-title><strong>{d?.name ?? id}</strong><div className="xs muted">{d?.breed}</div></td>
                {/* A collar that seems off is a state of the sensor, and a dog still learning has no level yet. */}
                <td data-label="Estado del último bloque">{st?.sensor === "no_wear" ? <StateTag level={st.level} sensorOff iconSize={12} />
                  : st && !d?.baseline ? <StateTag level={st.level} learning iconSize={12} /> : <LevelTag level={st?.level} />}</td>
                <td className="num tabular strong" data-label="HS">{st?.sensor === "no_wear" || (st && !d?.baseline) ? "—" : st?.healthScore ?? "—"}</td>
                <td data-label="Anomalía activa" data-wide>{inj.length ? injectionsText(inj) : <span className="muted">—</span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

/** Latency of the run, from the write of each block to its result; over the goal (RNF-01) it says so in words. */
function LatencyPanel({ stats: s }: { stats: Run["stats"] }) {
  const sec = (ms: number | null | undefined) => (ms == null ? "—" : `${fmtNum(ms / 1000, 2)} s`);
  const goalNote = (ms: number | null | undefined) => (overGoal(ms) ? <div className="stat-note out-of-range"><Icon name="alert-triangle" size={12} /> sobre la meta de 5 s</div> : null);
  return (
    <section className="panel stack-sm" aria-labelledby="lat-title">
      <h2 className="panel-title" id="lat-title">Latencia medida</h2>
      <div className="stats stats-3">
        <div className="stat"><div className="stat-label">Promedio</div><div className="stat-value tabular">{sec(s.avgLatencyMs)}</div>{goalNote(s.avgLatencyMs)}</div>
        <div className="stat"><div className="stat-label">Percentil 95</div><div className="stat-value tabular">{sec(s.p95LatencyMs)}</div>{goalNote(s.p95LatencyMs)}</div>
        <div className="stat"><div className="stat-label">Máxima</div><div className="stat-value tabular">{sec(s.maxLatencyMs)}</div>{goalNote(s.maxLatencyMs)}</div>
      </div>
      <p className="xs muted">Desde la escritura de cada bloque en <span className="mono">readings</span> hasta su resultado (<span className="mono">results.latencyMs</span>), últimos 500 bloques.
        {usingEmulators ? <strong> Medida en los emuladores locales:</strong> : null}{usingEmulators ? " no representa la latencia en la nube." : null}</p>
      <div className="row small latency-goal"><Icon name="zap" size={15} />Meta del sistema: menos de 5 s (RNF-01).</div>
    </section>
  );
}

/** «Detener» asks first, on the page, when the run is in course or was created by another account; and
 * the panel stays on the stopped run, so the button never lands on another run under the pointer. */
function RunDetail({ run, dogs, uid, onKeep }: { run: Run; dogs: Map<string, Dog>; uid: string; onKeep: (runId: string) => void }) {
  const ref = doc(db, "simulatorRuns", run.id);
  // «Iniciando» turns into «No arrancó» with the clock, not only with a new snapshot of the run.
  const now = useNow(5000);
  const phase = runPhase(run, now);
  const setState = (state: string) => updateDoc(ref, { state });
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const own = run.createdBy === uid;
  const stop = async () => {
    onKeep(run.id);
    setStopping(true);
    try { await setState("stopped"); } finally { setStopping(false); setConfirmStop(false); }
  };
  const askStop = () => (run.state === "running" || !own ? setConfirmStop(true) : void stop());
  const s = run.stats;
  const perDog = run.dogIds.length ? Math.floor((s.blocksWritten ?? 0) / run.dogIds.length) : 0;
  // A run that ended writes no more data: nothing is «activa» in it, and an injection that did not fit
  // in what was left of the run says so.
  const ended = run.state === "stopped";
  const active = ended ? [] : (run.injectionsLog ?? []).filter((j) => perDog >= j.startBlock && perDog < j.endBlock);
  const injectionState = (j: { startBlock: number; endBlock: number }) =>
    perDog >= j.endBlock ? " · terminada"
      : ended ? (perDog >= j.startBlock ? " · cortada: la ejecución terminó antes" : " · no llegó a aplicarse: la ejecución terminó antes")
        : perDog >= j.startBlock ? " · en curso" : "";
  return (
    <>
    <div className="split split-run">
      <div className="stack">
      {/* The controls of the run are the protagonist of the panel (the one bezel of the screen), with the figures of
          the run as numerals under them. */}
      <div className="bezel">
      <section className="panel stack-sm run-controls" aria-label="Controles de la ejecución" id="run-controls" tabIndex={-1}>
        <div className="sim-bar">
          <div className="sim-status">
            <RunStateTag run={run} now={now} large />
            {run.learnBaseline && <span className="tag tag-outline"><Icon name="info" size={12} />Perro nuevo: aprende su patrón normal</span>}
            <span className="small muted">{run.worker ? <>proceso <span className="mono">{run.worker.id}</span></> : "sin proceso"} · <span className="mono">simulatorRuns/{run.id}</span>{!own && " · creada por otra cuenta"}</span>
          </div>
          <div className="sim-controls">
            {run.state === "running"
              ? <button className="btn btn-secondary" type="button" onClick={() => setState("paused")}><Icon name="pause" />Pausar</button>
              : <button className="btn btn-primary" type="button" disabled={run.state === "stopped"} onClick={() => setState("running")}><Icon name="play" />Reanudar</button>}
            <Seg label="Velocidad de reproducción" value={run.speed} onChange={(v) => updateDoc(ref, { speed: v })} options={SPEEDS.map((x) => ({ value: x, label: `×${x}` }))} />
            {!confirmStop && <button className="btn btn-danger" type="button" disabled={run.state === "stopped"} onClick={askStop}><Icon name="square" />Detener</button>}
          </div>
        </div>
        {confirmStop && run.state !== "stopped" && (
          <div className="callout callout-warn stack-sm" role="group" aria-label="Confirmar que se detiene la ejecución">
            <p>¿Detener esta ejecución ({run.dogIds.map((id) => dogs.get(id)?.name ?? id).join(", ")})?{own ? "" : " La creó otra cuenta."} Una ejecución detenida no se puede reanudar.</p>
            <div className="row">
              <button className="btn btn-danger-solid btn-sm" type="button" onClick={() => void stop()} disabled={stopping}><Icon name="square" size={14} />{stopping ? "Deteniendo…" : "Sí, detener"}</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirmStop(false)} disabled={stopping}>Cancelar</button>
            </div>
          </div>
        )}
        <RunNotices run={run} phase={phase} />
        <div className="stats">
          <div className="stat"><div className="stat-label">Perros</div><div className="stat-value">{run.dogIds.length}</div></div>
          <div className="stat"><div className="stat-label">Bloques escritos</div><div className="stat-value tabular">{fmtNum(s.blocksWritten)}</div>
            <div className="stat-note">{fmtNum((perDog * (run.speed <= 2 ? 2 : 10)) / 60, 1)} min simulados por perro{run.durationS ? ` de ${run.durationS / 60}` : ""}</div></div>
          <div className="stat"><div className="stat-label">Resultados</div><div className="stat-value tabular">{fmtNum(s.resultsSeen ?? 0)}</div></div>
          <div className="stat"><div className="stat-label">Último bloque</div><div className="stat-value stat-value-sm"><Ago t={s.lastBlockAt?.toDate?.()} /></div></div>
        </div>
      </section>
      </div>

        <RunDogsTable run={run} dogs={dogs} active={active} />
      </div>

      <div className="stack">
        <InjectForm key={run.id} run={run} dogs={dogs} />
        <LatencyPanel stats={s} />
      </div>
    </div>

    {/* The log of injections grows with the run, so it takes the whole width under the two columns instead of
        lengthening the left one (the right column ended short of it by hundreds of pixels). */}
    <section className="panel stack-sm" aria-labelledby="log-title">
      <h2 className="panel-title" id="log-title">Inyecciones de esta ejecución ({run.injectionsLog?.length ?? 0})</h2>
      {!run.injectionsLog?.length ? <p className="small muted">Todavía no hay inyecciones.</p> : (
        <div className="log" role="log" aria-label="Inyecciones de la ejecución" tabIndex={0}>
          {[...run.injectionsLog].reverse().map((j) => (
            <div className="log-line" key={j.id}>
              <span className="log-time">{(j.at as Timestamp)?.toDate?.().toLocaleTimeString("es-PE") ?? ""}</span>
              <span className="log-dog">{dogs.get(j.dogId)?.name ?? j.dogId}</span>
              <span className="log-msg">{ANOMALY_CATALOG.types[j.type].label}, {magnitudeText(j.type, j.magnitude)}, {DURATION_LABELS[j.durationS] ?? `${j.durationS} s`} · bloques {j.startBlock}–{j.endBlock - 1}{injectionState(j)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
    {/* What happens to each block, and the model's behavior beside the one annotated from video. */}
    <div className="split split-insights">
      <RunPipeline run={run} dogs={dogs} />
      <BehaviorCompare key={run.id} run={run} dogs={dogs} />
    </div>
    </>
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
    ["Estado estable de Inicio", c.stableTimeConstantS ? `promedio de ${fmtNum(c.stableTimeConstantS / 60, 1)} min del Health Score` : "sin promedio"],
    ["Prefiltro", `FC ${c.prefilter.hrMin}–${c.prefilter.hrMax} lpm · temperatura ${c.prefilter.tempMin}–${c.prefilter.tempMax} °C`],
  ];
  return (
    <section className="panel stack-sm" aria-labelledby="cfg-title">
      <h2 className="panel-title" id="cfg-title">Configuración de fusión vigente</h2>
      <p className="small muted">Se lee de <span className="mono">config/fusion</span>. <Link to="/admin/configuracion">Editar en Modelos y configuración</Link> · <Link to="/admin/revision">Revisión experta</Link>.</p>
      {error && <Callout kind="error">No pudimos leer la configuración.</Callout>}
      {loading ? <p className="small">Cargando…</p> : <dl className="dl dl-cols">{rows.map(([k, v]) => <div className="dl-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    </section>
  );
}

export function SimulatorPage() {
  usePageTitle("Simulador");
  const now = useNow(5000);
  const { data: cfg } = useFusionConfig();
  const { user } = useAuth();
  const { data: runs, loading, error } = useRuns();
  const { data: allDogs } = useDogs({ kind: "all" });
  const dogs = useMemo(() => new Map(allDogs.map((d) => [d.id, d])), [allDogs]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selectedId) ?? runs.find((r) => holdsDogs(r, now)) ?? runs[0];
  // The dogs of the active runs, which a new run cannot take. Not those of a run whose process stopped beating.
  const busyDogs = useMemo(() => new Set(runs.filter((r) => holdsDogs(r, now)).flatMap((r) => r.dogIds)), [runs, now]);
  const showRun = (runId: string) => {
    setSelectedId(runId);
    window.requestAnimationFrame(() => {
      const el = document.getElementById("run-controls");
      el?.scrollIntoView({ block: "start" });
      el?.focus({ preventScroll: true });
    });
  };
  return (
    <PageFrame className="page-admin">
      <PageHead title="Simulador"
        sub="Reproduce sujetos de los datasets públicos al ritmo real (o hasta 10 veces más rápido), escribe un bloque de 2 a 10 s por documento en readings e inyecta anomalías con su verdad de referencia." />
      <div className="stack">
        <div className="callout"><Icon name="info" size={16} style={{ marginTop: 1 }} /><div>La conducta la clasifica el <strong>modelo CNN-LSTM</strong> y la frecuencia cardiaca, el <strong>autoencoder LSTM</strong> junto con la regla del promedio; la temperatura sigue con <strong>reglas provisionales</strong>. La latencia se mide en cada bloque.</div></div>
        {error && <Callout kind="error">No pudimos cargar las ejecuciones.</Callout>}
        {loading ? <p className="small">Cargando ejecuciones…</p>
          : selected ? <RunDetail key={selected.id} run={selected} dogs={dogs} uid={user?.uid ?? ""} onKeep={setSelectedId} />
          : <EmptyState icon="flask" title="Todavía no hay ejecuciones" text="Crea una ejecución abajo o desde la terminal con npm run sim -- start." />}
        {!loading && runs.length > 0 && (
          <section className="panel stack-sm" aria-labelledby="runs-title">
            <h2 className="panel-title" id="runs-title">Ejecuciones recientes</h2>
            <div className="table-wrap" role="region" aria-label="Ejecuciones recientes" tabIndex={0}>
              <table className="table table-stack">
                <thead><tr><th scope="col">Ejecución</th><th scope="col">Estado</th><th scope="col">Perros</th><th scope="col" className="num">Bloques</th><th scope="col" className="num">Latencia media</th><th scope="col"><span className="sr-only">Abrir</span></th></tr></thead>
                <tbody>{runs.map((r) => (
                  <tr key={r.id} aria-current={r.id === selected?.id ? "true" : undefined} className={r.id === selected?.id ? "row-current" : undefined}>
                    <td className="mono" data-title>{r.id}</td>
                    <td data-label="Estado"><RunStateTag run={r} now={now} /></td>
                    <td data-label="Perros" data-wide>{r.dogIds.map((id) => dogs.get(id)?.name ?? id).join(", ")}</td>
                    <td className="num tabular" data-label="Bloques">{fmtNum(r.stats?.blocksWritten ?? 0)}</td>
                    <td className="num tabular" data-label="Latencia media">{r.stats?.avgLatencyMs == null ? "—" : `${fmtNum(r.stats.avgLatencyMs / 1000, 2)} s`}{overGoal(r.stats?.avgLatencyMs) && <span className="out-of-range"> (sobre la meta de 5 s)</span>}</td>
                    <td data-wide><button className="btn btn-secondary btn-sm" type="button" onClick={() => setSelectedId(r.id)}>Ver</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
        {/* The new run and the models are two panels of about the same height, side by side; the fusion
            configuration (the tallest, a list of 14 lines) goes under both, full width, in two columns. Before, the two
            went in a column beside the new run and left about 540 px empty under it. Same order in the document. */}
        <div className="split split-even">
          {user && <NewRun dogs={allDogs} uid={user.uid} busyDogs={busyDogs} onCreated={showRun} minBlocks={cfg.baseline?.minBlocks ?? 360} />}
          <ModelsPanel />
        </div>
        <FusionConfigPanel />
      </div>
    </PageFrame>
  );
}
