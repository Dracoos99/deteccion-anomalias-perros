/* A2 · Modelos y configuración: the fusion weights and thresholds of config/fusion, editable by an
   admin, with a probe of the Health Score formula. Layout of the v2 prototype
. The values stay provisional until the team decides C3-C5. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, writeBatch, type Timestamp } from "firebase/firestore";
import { DEFAULT_FUSION_CONFIG, healthScore, levelOf, type FusionConfig } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { Callout, HealthGauge, Icon, LevelTag, PageHead, fmtNum } from "../components/ui";
import { db } from "../firebase";
import { useActiveModels, useFusionConfig, type Fusion } from "../data/hooks";
import { dateTimeText, durationText } from "../lib/plain";

type Draft = Record<string, string>;
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const opt = (v: number | undefined) => (v == null ? "" : String(v));

function toDraft(c: Fusion): Draft {
  return {
    wb: String(c.weights.b), wp: String(c.weights.p), wt: String(c.weights.t),
    green: String(c.levels.green), amber: String(c.levels.amber), alert: String(c.alertThreshold),
    consec: String(c.consecutiveCritical), sigma: String(c.baselineSigma), episodeGap: String(c.episodeGapS),
    tMin: String(c.tempRange[0]), tMax: String(c.tempRange[1]), tDev: String(c.tempMaxDeviation),
    hrMin: String(c.hrRange[0]), hrMax: String(c.hrRange[1]),
    critical: opt(c.physio?.criticalRatio), fullScale: opt(c.physio?.fullScaleRatio), levelSigma: opt(c.physio?.levelSigma),
    minBlocks: String(c.baseline?.minBlocks ?? 360),
    minDuration: String(c.alertMinDurationS ?? 0), actSigma: opt(c.activityCriticalSigma ?? undefined),
  };
}

function validate(d: Draft): { errors: string[]; next: (base: Fusion) => Fusion } {
  const n = (k: string) => num(d[k]);
  const errors: string[] = [];
  const w = [n("wb"), n("wp"), n("wt")];
  if (!w.every((x) => x >= 0 && x <= 1)) errors.push("Cada peso debe estar entre 0 y 1.");
  else if (Math.abs(w[0] + w[1] + w[2] - 1) > 0.001) errors.push(`Los pesos deben sumar 1 (ahora suman ${fmtNum(w[0] + w[1] + w[2], 2)}).`);
  if (!(n("amber") > 0 && n("amber") < n("green") && n("green") <= 100)) errors.push("Los cortes deben cumplir 0 < Atención < Todo normal ≤ 100.");
  if (!(n("alert") > 0 && n("alert") <= 100)) errors.push("El umbral de alerta debe estar entre 1 y 100.");
  if (!(Number.isInteger(n("consec")) && n("consec") >= 1 && n("consec") <= 60)) errors.push("Las ventanas seguidas de la regla crítica deben ser un entero entre 1 y 60 (2 s cada una).");
  if (!(n("sigma") >= 1 && n("sigma") <= 4)) errors.push("La desviación respecto a la línea base debe estar entre 1 y 4 σ.");
  if (!(Number.isInteger(n("episodeGap")) && n("episodeGap") >= 10 && n("episodeGap") <= 3600)) errors.push("El cierre de un episodio debe estar entre 10 y 3 600 s.");
  if (!(n("tMin") >= 30 && n("tMin") < n("tMax") && n("tMax") <= 45)) errors.push("El rango de temperatura debe estar dentro de 30–45 °C, con el mínimo menor que el máximo.");
  if (!(n("tDev") > 0 && n("tDev") <= 3)) errors.push("La desviación máxima de temperatura debe estar entre 0.1 y 3 °C.");
  if (!(n("hrMin") >= 20 && n("hrMin") < n("hrMax") && n("hrMax") <= 300)) errors.push("El rango de FC de referencia debe estar dentro de 20–300 lpm, con el mínimo menor que el máximo.");
  const optional = (k: string, ok: (x: number) => boolean, msg: string) => {
    if (d[k].trim() === "") return undefined;
    if (!ok(n(k))) errors.push(msg);
    return n(k);
  };
  const critical = optional("critical", (x) => x > 1 && x <= 50, "El umbral crítico del autoencoder debe estar entre 1 y 50 veces su umbral (o vacío para usar el del modelo).");
  const fullScale = optional("fullScale", (x) => x > 1 && x <= 100, "La escala del autoencoder debe estar entre 1 y 100 (o vacía para usar la del modelo).");
  const levelSigma = optional("levelSigma", (x) => x >= 1 && x <= 5, "La regla del promedio de FC debe estar entre 1 y 5 σ (o vacía para usar la de la línea base).");
  if (!(Number.isInteger(n("minBlocks")) && n("minBlocks") >= 30 && n("minBlocks") <= 1080)) errors.push("Los bloques para aprender el patrón normal deben ser un entero entre 30 (5 min) y 1 080 (3 h).");
  if (!(Number.isInteger(n("minDuration")) && n("minDuration") >= 0 && n("minDuration") <= 1800)) errors.push("La duración mínima de una alerta debe ser un entero entre 0 y 1 800 s.");
  const actSigma = optional("actSigma", (x) => x >= 1 && x <= 5, "La regla de actividad baja debe estar entre 1 y 5 σ (o vacía para no usarla).");
  const next = (base: Fusion): Fusion => {
    const physio = Object.fromEntries(Object.entries({ criticalRatio: critical, fullScaleRatio: fullScale, levelSigma }).filter(([, v]) => v != null));
    const out: Fusion = {
      ...base, weights: { b: w[0], p: w[1], t: w[2] }, levels: { green: n("green"), amber: n("amber") }, alertThreshold: n("alert"),
      consecutiveCritical: n("consec"), baselineSigma: n("sigma"), episodeGapS: n("episodeGap"),
      tempRange: [n("tMin"), n("tMax")], tempMaxDeviation: n("tDev"), hrRange: [n("hrMin"), n("hrMax")],
      baseline: { minBlocks: n("minBlocks") },
      alertMinDurationS: n("minDuration"), activityCriticalSigma: actSigma ?? null,
    };
    if (Object.keys(physio).length) out.physio = physio; else delete out.physio;
    return out;
  };
  return { errors, next };
}

/** Human-readable differences between two configurations, for the change log (HU27). */
export function configChanges(before: Fusion, after: Fusion): { field: string; before: string; after: string }[] {
  const show: [string, (c: Fusion) => string][] = [
    ["Pesos (conducta · FC · temperatura)", (c) => `${c.weights.b} · ${c.weights.p} · ${c.weights.t}`],
    ["Niveles (Todo normal · Atención)", (c) => `${c.levels.green} · ${c.levels.amber}`],
    ["Umbral de alerta", (c) => String(c.alertThreshold)],
    ["Regla crítica: ventanas seguidas", (c) => String(c.consecutiveCritical)],
    ["Desviación respecto a la línea base (σ)", (c) => String(c.baselineSigma)],
    ["Cierre de un episodio (s)", (c) => String(c.episodeGapS)],
    ["Rango de temperatura (°C)", (c) => c.tempRange.join("–")],
    ["Desviación máxima de temperatura (°C)", (c) => String(c.tempMaxDeviation)],
    ["FC de referencia (lpm)", (c) => c.hrRange.join("–")],
    ["Autoencoder: umbral crítico", (c) => (c.physio?.criticalRatio == null ? "del modelo" : String(c.physio.criticalRatio))],
    ["Autoencoder: escala de r_p", (c) => (c.physio?.fullScaleRatio == null ? "del modelo" : String(c.physio.fullScaleRatio))],
    ["Autoencoder: regla del promedio (σ)", (c) => (c.physio?.levelSigma == null ? "la de la línea base" : String(c.physio.levelSigma))],
    ["Bloques para aprender el patrón normal", (c) => String(c.baseline?.minBlocks ?? 360)],
    ["Duración mínima de una alerta (s)", (c) => String(c.alertMinDurationS ?? 0)],
    ["Regla de actividad baja (σ)", (c) => (c.activityCriticalSigma == null ? "sin regla" : String(c.activityCriticalSigma))],
  ];
  return show.flatMap(([field, f]) => (f(before) === f(after) ? [] : [{ field, before: f(before), after: f(after) }]));
}

interface HistoryEntry { id: string; changes: { field: string; before: string; after: string }[]; updatedBy: string; updatedAt?: Timestamp }

function ChangeLog({ uid }: { uid: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => onSnapshot(query(collection(db, "configHistory"), orderBy("updatedAt", "desc"), limit(10)),
    (snap) => setEntries(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<HistoryEntry, "id">) })))), []);
  return (
    <section className="panel" aria-labelledby="log-title">
      <h2 className="panel-title" id="log-title">Bitácora de cambios</h2>
      {!entries.length ? <p className="small muted" style={{ margin: 0 }}>Todavía no hay cambios guardados desde esta pantalla.</p> : (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead><tr><th scope="col">Fecha</th><th scope="col">Quién</th><th scope="col">Parámetro</th><th scope="col">Antes</th><th scope="col">Después</th></tr></thead>
            <tbody>{entries.flatMap((e) => e.changes.map((c, i) => (
              <tr key={`${e.id}-${i}`}>
                <td className="small nowrap">{i === 0 && e.updatedAt ? dateTimeText(e.updatedAt.toMillis()) : ""}</td>
                <td className="small">{i === 0 ? (e.updatedBy === uid ? "Tú" : <span className="mono">{e.updatedBy.slice(0, 8)}</span>) : ""}</td>
                <td className="small">{c.field}</td><td className="small">{c.before}</td><td className="small">{c.after}</td>
              </tr>
            )))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelsSummary() {
  const { data: models, loading } = useActiveModels();
  if (loading) return <p className="small">Cargando…</p>;
  const b = models.find((m) => m.kind === "behavior"), p = models.find((m) => m.kind === "physiological");
  return (
    <div className="grid-3">
      <article className="panel stack-sm">
        <h3 className="panel-title" style={{ margin: 0 }}>Conducta</h3>
        {b ? <><div className="mono small">{b.version}</div><div className="small">F1 macro {fmtNum(b.metrics.test_macro_f1, 3)} en prueba · {fmtNum(b.metrics.val_macro_f1, 3)} en validación <span className="xs muted">(meta ≥ 0,75)</span></div></>
          : <div className="small muted">Sin modelo registrado: regla provisional de movimiento.</div>}
      </article>
      <article className="panel stack-sm">
        <h3 className="panel-title" style={{ margin: 0 }}>Frecuencia cardiaca</h3>
        {p ? <><div className="mono small">{p.version}</div><div className="small">Combinado con la regla del promedio: F1 {fmtNum(p.metrics.combined_test_f1, 3)} en prueba <span className="xs muted">(meta ≥ 0,75)</span></div></>
          : <div className="small muted">Sin modelo registrado: regla del promedio respecto a la línea base.</div>}
      </article>
      <article className="panel stack-sm">
        <h3 className="panel-title" style={{ margin: 0 }}>Temperatura</h3>
        <div className="small">Reglas: rango de referencia y desviación respecto al patrón del perro. Se editan abajo.</div>
      </article>
    </div>
  );
}

export function ConfigPage() {
  const { user } = useAuth();
  const { data: cfg, loading } = useFusionConfig();
  const [meta, setMeta] = useState<{ updatedAt?: Timestamp; updatedBy?: string } | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [probe, setProbe] = useState({ b: 0.5, p: 0.8, t: 0 });
  const [saved, setSaved] = useState<"ok" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSnapshot(doc(db, "config", "fusion"), (s) => setMeta((s.data() as Partial<FusionConfig<Timestamp>> | undefined) ?? null)), []);
  useEffect(() => { if (!loading && d == null) setD(toDraft(cfg)); }, [loading, cfg, d]);
  if (!d) return <div className="boot" aria-busy="true">Cargando…</div>;

  const { errors, next } = validate(d);
  const candidate = next(cfg);
  const dirty = JSON.stringify(toDraft(cfg)) !== JSON.stringify(d);
  const hs = errors.length ? null : healthScore({ rB: probe.b, rP: probe.p, rT: probe.t }, candidate.weights);
  const level = hs == null ? null : levelOf(hs, candidate.levels);
  const singleMin = errors.length ? null : Math.round(100 * (1 - Math.max(candidate.weights.b, candidate.weights.p, candidate.weights.t)));

  const save = async () => {
    setBusy(true); setSaved(null);
    try {
      // The configuration and its log entry in one batch: a change is never saved without its record (HU27).
      const batch = writeBatch(db);
      batch.set(doc(db, "config", "fusion"), { ...candidate, updatedBy: user!.uid, updatedAt: serverTimestamp() });
      batch.set(doc(collection(db, "configHistory")), { changes: configChanges(cfg, candidate), updatedBy: user!.uid, updatedAt: serverTimestamp() });
      await batch.commit();
      setD(toDraft(candidate));
      setSaved("ok");
    } catch {
      setSaved("error");
    } finally {
      setBusy(false);
    }
  };
  const inp = (k: string, label: string, unit?: string, hint?: string) => (
    <div className="field"><label htmlFor={`c-${k}`}>{label}</label>
      <div className="input-group"><input id={`c-${k}`} className="input" inputMode="decimal" value={d[k]} onChange={(e) => { setD({ ...d, [k]: e.target.value }); setSaved(null); }} />
        {unit && <span className="input-addon">{unit}</span>}</div>
      {hint && <div className="field-hint">{hint}</div>}</div>
  );

  return (
    <main className="page" id="main">
      <nav className="crumbs" aria-label="Ruta"><Link to="/perfil">Perfil</Link><span aria-hidden="true">›</span><Link to="/admin">Herramientas de investigación</Link><span aria-hidden="true">›</span><span>Modelos y configuración</span></nav>
      <PageHead kicker="Herramientas de investigación" title="Modelos y configuración"
        sub="Modelos activos y los pesos y umbrales de la fusión (config/fusion). Los cambios se aplican a los bloques siguientes, en menos de 15 s." />
      <div className="stack">
        <ModelsSummary />
        <div className="callout callout-warn small"><Icon name="info" size={16} style={{ marginTop: 2 }} />
          <div>Valores provisionales: las reglas críticas, los pesos y la severidad (C3–C5) los decide el equipo con los barridos del simulador (npm run sim -- sweep).</div></div>
        <div className="split">
          <section className="panel stack" aria-labelledby="fusion-title">
            <h2 className="panel-title" id="fusion-title" style={{ margin: 0 }}>Fusión y umbrales</h2>
            <div>
              <h3 className="field-label" style={{ fontSize: 15, marginBottom: 8 }}>Pesos de cada señal</h3>
              <div className="grid-3">{inp("wb", "Conducta y actividad (b)")}{inp("wp", "Frecuencia cardiaca (p)")}{inp("wt", "Temperatura (t)")}</div>
            </div>
            <div className="codeblock">HealthScore = 100 × (1 − ({fmtNum(num(d.wb), 2)}·r_b + {fmtNum(num(d.wp), 2)}·r_p + {fmtNum(num(d.wt), 2)}·r_t))</div>
            <div>
              <h3 className="field-label" style={{ fontSize: 15, marginBottom: 8 }}>Niveles y alertas</h3>
              <div className="grid-3">
                {inp("green", "«Todo normal» desde", undefined, "Health Score mínimo")}
                {inp("amber", "«Atención» desde", undefined, "Por debajo, «Revisar»")}
                {inp("alert", "Alerta si el Health Score es menor que")}
              </div>
              <div className="grid-3" style={{ marginTop: 12 }}>
                {inp("consec", "Regla crítica: ventanas seguidas", undefined, "Ventanas de 2 s")}
                {inp("sigma", "Desviación respecto a la línea base", "σ", "Actividad, FC y bandas del patrón normal")}
                {inp("episodeGap", "Cierre de un episodio", "s", "Sin disparos durante este tiempo")}
              </div>
              <div className="grid-3" style={{ marginTop: 12 }}>
                {inp("minDuration", "Duración mínima de una alerta", "s", "El disparo debe sostenerse este tiempo antes de avisar")}
                {inp("actSigma", "Regla de actividad baja", "σ", "Bajo el patrón del perro. Vacío: sin regla")}
              </div>
            </div>
            <div>
              <h3 className="field-label" style={{ fontSize: 15, marginBottom: 8 }}>Temperatura y frecuencia cardiaca</h3>
              <div className="grid-3">{inp("tMin", "Temperatura mínima", "°C")}{inp("tMax", "Temperatura máxima", "°C")}{inp("tDev", "Desviación máxima del patrón", "°C")}</div>
              <div className="grid-3" style={{ marginTop: 12 }}>
                {inp("hrMin", "FC de referencia mínima", "lpm", "Solo informativa")}
                {inp("hrMax", "FC de referencia máxima", "lpm")}
              </div>
            </div>
            <div>
              <h3 className="field-label" style={{ fontSize: 15, marginBottom: 8 }}>Autoencoder de FC</h3>
              <div className="grid-3">
                {inp("critical", "Umbral crítico", "×", "Veces su umbral. Vacío: el del modelo (percentil 99.9)")}
                {inp("fullScale", "Escala de r_p", "×", "Veces su umbral. Vacío: la del modelo")}
                {inp("levelSigma", "Regla del promedio", "σ", "Vacío: la desviación de arriba")}
              </div>
            </div>
            <div>
              <h3 className="field-label" style={{ fontSize: 15, marginBottom: 8 }}>Patrón normal de perros nuevos</h3>
              <div className="grid-3">{inp("minBlocks", "Bloques de 10 s por etapa", undefined, Number.isFinite(num(d.minBlocks)) ? `${durationText(num(d.minBlocks) * 10_000)} de datos` : undefined)}</div>
            </div>
            <dl className="kv">
              <dt>Prefiltro</dt><dd>FC {cfg.prefilter.hrMin}–{cfg.prefilter.hrMax} lpm · temperatura {cfg.prefilter.tempMin}–{cfg.prefilter.tempMax} °C</dd>
              <dt>Regla de movimiento</dt><dd>{fmtNum(cfg.activity.thresholdG, 3)} g · promedio de {cfg.activity.timeConstantS / 60} min</dd>
              <dt>FC promediada</dt><dd>{cfg.hrAverageS} s</dd>
              <dt>Última actualización</dt><dd>{meta?.updatedAt ? `${dateTimeText(meta.updatedAt.toMillis())}${meta.updatedBy === user!.uid ? " · por ti" : ""}` : "valores iniciales"}</dd>
            </dl>
            {errors.length > 0 && <div className="callout callout-error" role="alert"><Icon name="alert-triangle" size={18} style={{ marginTop: 2 }} /><ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
            {saved === "ok" && <Callout kind="ok">Configuración guardada. Se aplica a los bloques siguientes.</Callout>}
            {saved === "error" && <Callout kind="error">No pudimos guardar la configuración.</Callout>}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" type="button" disabled={!dirty || errors.length > 0 || busy} onClick={save}><Icon name="check" />{busy ? "Guardando…" : "Guardar cambios"}</button>
              <button className="btn btn-secondary" type="button" disabled={!dirty} onClick={() => setD(toDraft(cfg))}>Descartar</button>
              <button className="btn btn-ghost" type="button" onClick={() => setD(toDraft(DEFAULT_FUSION_CONFIG))}>Volver a los valores iniciales</button>
            </div>
          </section>
          <aside className="panel stack-sm" aria-labelledby="probe-title">
            <h2 className="panel-title" id="probe-title">Probar la fórmula</h2>
            <p className="small muted" style={{ margin: 0 }}>Mueve la desviación de cada señal (0 = igual a su patrón, 1 = máxima) para ver el Health Score con los pesos de la izquierda.</p>
            {([["b", "Conducta y actividad (r_b)"], ["p", "Frecuencia cardiaca (r_p)"], ["t", "Temperatura (r_t)"]] as const).map(([k, label]) => (
              <div className="field" key={k}><label htmlFor={`p-${k}`}>{label}: <span className="tabular">{fmtNum(probe[k], 2)}</span></label>
                <input id={`p-${k}`} type="range" min="0" max="1" step="0.05" value={probe[k]} onChange={(e) => setProbe({ ...probe, [k]: Number(e.target.value) })} /></div>
            ))}
            <div className="stack-sm" style={{ alignItems: "center" }}>
              <HealthGauge score={hs} level={level} levels={candidate.levels} size={150} />
              <LevelTag level={level} />
              <div className="small">{hs == null ? "Corrige la configuración para calcular." : hs < candidate.alertThreshold ? "Generaría una alerta." : "No genera alerta por puntaje (puede generarla una regla crítica)."}</div>
            </div>
            {singleMin != null && (
              <div className="callout callout-warn small"><Icon name="info" size={16} style={{ marginTop: 2 }} />
                <div>Con estos pesos, si una sola señal se desvía al máximo, el Health Score no baja de <strong>{singleMin}</strong>{singleMin >= candidate.levels.amber ? ": ninguna señal por sí sola lleva a «Revisar» ni genera alerta por puntaje. Esos casos dependen de las reglas críticas." : "."}</div></div>
            )}
          </aside>
        </div>
        <ChangeLog uid={user!.uid} />
      </div>
    </main>
  );
}
