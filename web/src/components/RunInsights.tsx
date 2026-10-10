/* Research panel of a simulator run: the path of its latest blocks through the system, and the behavior the
   model predicted beside the one annotated from video. Admin only. */
import { useState } from "react";
import type { Behavior } from "@shared/types";
import { useRunResults, useRunTruth, type Dog, type Run } from "../data/hooks";
import { agreement, pairBlocks } from "../lib/agreement";
import { GROUP_OF } from "../lib/day";
import { BEHAVIOR_LABEL, glueTime } from "../lib/plain";
import { LATENCY_GOAL_MS } from "../lib/simRun";
import { Icon, LEVELS, fmtNum } from "./ui";

const clock = (ms: number) => glueTime(new Date(ms).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", second: "2-digit" }));

/** The latest blocks of the run, each with its latency against the goal, its Health Score and what the model saw. */
export function RunPipeline({ run, dogs }: { run: Run; dogs: Map<string, Dog> }) {
  const { data, loading } = useRunResults(run.id, null, 8);
  return (
    <section className="panel stack-sm" aria-labelledby="pipe-title">
      <h2 className="panel-title" id="pipe-title">Recorrido de los últimos bloques</h2>
      <ol className="pipe-steps" aria-label="Qué pasa con cada bloque">
        <li><Icon name="upload" size={14} />El simulador escribe el bloque</li>
        <li><Icon name="paw" size={14} />La Function corre los modelos y el motor</li>
        <li><Icon name="heart" size={14} />Resultado, estado del perro y, si dura, alerta</li>
      </ol>
      {loading ? <div className="skeleton" style={{ height: 120 }} /> : !data.length ? <p className="small muted">Todavía no hay bloques con resultado.</p> : (
        <ul className="pipe-list">
          {data.map((r) => {
            const ms = r.latencyMs ?? null;
            const over = ms != null && ms > LATENCY_GOAL_MS;
            const flags = r.prefilterFlags ?? [];
            const note = flags.includes("imu_no_wear") ? "collar quitado" : flags.includes("no_baseline") ? "sin línea base" : null;
            return (
              <li key={r.id} className="pipe-row">
                <span className="pipe-dog">{dogs.get(r.dogId)?.name ?? r.dogId}</span>
                <span className="pipe-time xs muted">{clock(r.blockStart.toMillis())}</span>
                <span className="pipe-bar" aria-hidden="true"><span className="pipe-fill" data-over={over ? "true" : undefined} style={{ width: `${Math.min(100, ((ms ?? 0) / LATENCY_GOAL_MS) * 100)}%` }} /></span>
                <span className="pipe-ms tabular">{ms == null ? "—" : `${fmtNum(ms / 1000, 2)} s`}{over && <span className="sr-only"> (sobre la meta de 5 s)</span>}</span>
                {/* A block of a collar off, or of a dog still learning, has no Health Score of the dog. */}
                <span className="pipe-hs tabular">{note ? <span className="muted">—</span> : <><span className="pipe-dot" style={{ background: LEVELS[r.level].color }} aria-hidden="true" />{r.healthScore}</>}</span>
                <span className="pipe-beh xs">{r.predictedBehavior ? BEHAVIOR_LABEL[r.predictedBehavior] : "—"}{note && <span className="muted"> · {note}</span>}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="xs muted">La barra es la latencia de cada bloque, desde que se escribe hasta que hay resultado, frente a la meta de 5 s (llena = 5 s). La hora es la de los datos{run.speed > 1 ? `: a ×${run.speed} es tiempo simulado y va por delante del reloj` : ""}.</p>
    </section>
  );
}

const SPLIT_TEXT: Record<string, string> = {
  test: "Perro de prueba: el modelo no lo vio al entrenar. Esta coincidencia es la que vale.",
  val: "Perro de validación: se usó para elegir el modelo, no para entrenarlo.",
  train: "Perro de entrenamiento: el modelo vio sus datos, así que la coincidencia sale más alta que con un perro nuevo.",
};

/** The behavior of each block, annotated from video and predicted by the model, side by side, with the agreement. */
export function BehaviorCompare({ run, dogs }: { run: Run; dogs: Map<string, Dog> }) {
  const [dogId, setDogId] = useState(run.dogIds[0]);
  const truth = useRunTruth(run.recordTruth ? run.id : undefined, dogId, 120);
  const results = useRunResults(run.recordTruth ? run.id : undefined, dogId, 120);
  if (!run.recordTruth) {
    return (
      <section className="panel stack-sm" aria-labelledby="cmp-title">
        <h2 className="panel-title" id="cmp-title">Conducta anotada frente a la del modelo</h2>
        <p className="small muted">Esta ejecución no guarda la conducta anotada en el video. Activa «Guardar la conducta anotada» al crear una ejecución para ver aquí, bloque a bloque, la conducta real junto a la que reconoce el modelo.</p>
      </section>
    );
  }
  const pairs = pairBlocks(truth.data.map((x) => ({ id: x.id, t: x.blockStart.toMillis(), behavior: x.behavior })), results.data).reverse();
  const a = agreement(pairs);
  const split = truth.data[0]?.subject?.split ?? null;
  return (
    <section className="panel stack-sm" aria-labelledby="cmp-title">
      <div className="row-between">
        <h2 className="panel-title" id="cmp-title">Conducta anotada frente a la del modelo</h2>
        <select className="select" aria-label="Perro" value={dogId} onChange={(e) => setDogId(e.target.value)}>
          {run.dogIds.map((id) => <option key={id} value={id}>{dogs.get(id)?.name ?? id}</option>)}
        </select>
      </div>
      {split && <p className={split === "test" ? "small cmp-split" : "small muted cmp-split"}>{SPLIT_TEXT[split]}</p>}
      {!pairs.length ? <p className="small muted">Todavía no hay bloques con anotación y resultado.</p> : (
        <>
          <div className="cmp-rows" role="img" aria-label={`Últimos ${pairs.length} bloques: arriba la conducta anotada en el video, abajo la del modelo.`}>
            <span className="xs muted">Anotada (video)</span>
            <div className="cmp-row">{pairs.map((p) => <Cell key={p.id} b={p.annotated} title={`${clock(p.t)} · anotada: ${p.annotated ? BEHAVIOR_LABEL[p.annotated] : "sin anotación"}`} />)}</div>
            <span className="xs muted">Modelo</span>
            <div className="cmp-row">{pairs.map((p) => <Cell key={p.id} b={p.predicted} miss={!!p.annotated && !!p.predicted && p.annotated !== p.predicted}
              title={`${clock(p.t)} · modelo: ${p.predicted ? BEHAVIOR_LABEL[p.predicted] : "—"}`} />)}</div>
          </div>
          <ul className="day-legend" aria-label="Colores">
            {(["rest", "walk", "trot", "play", "sniff"] as const).map((g) => (
              <li key={g}><span className="day-swatch" data-group={g} aria-hidden="true" />{{ rest: "Sentarse, pararse o echarse", walk: "Caminar", trot: "Trotar", play: "Jugar", sniff: "Olfatear" }[g]}</li>
            ))}
            <li><span className="cmp-cell cmp-key" data-group="none" aria-hidden="true" />Sin una sola conducta anotada</li>
            <li><span className="cmp-miss-key" aria-hidden="true" />No coincide</li>
          </ul>
          {a.compared > 0 ? (
            <p className="small"><strong>Coincide en {fmtNum((100 * a.exact) / a.compared)} %</strong> de los {a.compared} bloques anotados con las siete conductas, y en {fmtNum((100 * a.grouped) / a.compared)} % juntando las tres posturas quietas.
              {a.confusions.length > 0 && <> Confusiones más comunes: {a.confusions.map((c) => `${BEHAVIOR_LABEL[c.annotated].toLowerCase()} → ${BEHAVIOR_LABEL[c.predicted].toLowerCase()} (${c.n})`).join(", ")}.</>}</p>
          ) : <p className="small muted">Ningún bloque reciente tiene una sola conducta anotada.</p>}
          <p className="xs muted">Solo cuentan los bloques cuya anotación tiene una sola conducta (los demás quedan rayados arriba). La conducta del modelo es la que muestra la app, con su suavizado de 6 s.</p>
        </>
      )}
    </section>
  );
}

function Cell({ b, miss = false, title }: { b: Behavior | null; miss?: boolean; title: string }) {
  return <span className="cmp-cell" data-group={b ? GROUP_OF[b] : "none"} data-miss={miss ? "true" : undefined} title={title} />;
}
