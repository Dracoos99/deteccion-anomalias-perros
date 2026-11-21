/* The learning period of a dog: while the Function learns its baseline from its first blocks
   (dogs.status.baselineProgress), and the notice when it finished, in plain Spanish. */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Dog, Fusion } from "../data/hooks";
import { durationText, learnedNotice, learningInfo } from "../lib/plain";
import { Icon, fmtNum } from "./ui";

/** The two stages of the learning period, for the steps of the full panel. */
const STAGES = ["Qué es normal: corazón, temperatura y movimiento", "Cómo se mueve, con el modelo de conducta"];

/** Progress of the learning period. `full` (the dog's detail) shows both stages, what is checked meanwhile and the time
 * left; the compact one (Inicio cards, «Qué es normal») is a line and the bar. */
export function BaselineProgress({ dog, cfg, full = false }: { dog: Dog; cfg: Fusion; full?: boolean }) {
  const info = learningInfo(dog.status?.baselineProgress, cfg.baseline?.minBlocks ?? 360);
  if (!info) return null;
  // «Casi listo» under a minute and a half, never «unos menos de 1 minuto» or «unos 1 min»; the percent stays with
  // its number.
  const left = info.leftMs >= 90_000 ? `Faltan unos ${durationText(info.leftMs)} de sus datos.` : "Casi listo.";
  const pct = `${info.pct}\u00a0%`;
  const line = info.stage === 1
    ? `Aprendiendo qué es normal para ${dog.name}: etapa 1 de 2, ${pct}. ${left}`
    : `Afinando cómo se mueve ${dog.name} con el modelo de conducta: etapa 2 de 2, ${pct}. ${left}`;
  const bar = (
    <div className="progress" role="progressbar" aria-valuenow={info.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Período de aprendizaje, etapa ${info.stage} de 2`}>
      <div className="progress-fill" style={{ ["--p" as string]: info.pct / 100 }} />
    </div>
  );
  if (!full) {
    return (
      <div className="baseline-progress">
        <span className="xs muted">{line}</span>
        {bar}
      </div>
    );
  }
  const [lo, hi] = cfg.tempRange;
  return (
    <section className="learning-panel" aria-labelledby={`learning-${dog.id}`}>
      <div className="learning-head">
        <h2 className="section-title" id={`learning-${dog.id}`}>Período de aprendizaje</h2>
        <span className="tag tag-outline"><Icon name="info" size={12} />Etapa {info.stage} de 2 · {pct}</span>
      </div>
      {bar}
      <ol className="learning-steps">
        {STAGES.map((label, i) => {
          const state = i + 1 < info.stage ? "done" : i + 1 === info.stage ? "current" : "next";
          return (
            <li key={label} data-state={state}>
              <span className="learning-step-mark" aria-hidden="true">{state === "done" ? <Icon name="check" size={14} /> : i + 1}</span>
              <span>{label}{state === "current" ? <span className="sr-only"> (en curso)</span> : state === "done" ? <span className="sr-only"> (lista)</span> : null}</span>
            </li>
          );
        })}
      </ol>
      <p className="small">{info.stage === 1
        ? <>Estamos aprendiendo qué es normal para {dog.name} con sus primeros datos ({durationText(info.stageMs)} por etapa). {left}</>
        : <>Ya comparamos su corazón, su temperatura y su movimiento con lo normal para {dog.name}. Ahora afinamos cómo se mueve con el modelo de conducta. {left}</>}</p>
      {info.stage === 1 && (
        <p className="small muted">Mientras tanto, solo revisamos que su temperatura esté en lo normal para un perro ({fmtNum(lo, 1)}–{fmtNum(hi, 1)} °C): todavía no podemos comparar su corazón ni su movimiento con lo suyo, así que no habrá alertas por ellos.</p>
      )}
    </section>
  );
}

const DISMISS_KEY = (dogId: string, at: number) => `learned-seen:${dogId}:${at}`;

/** «Ya conocemos su patrón normal», on the dog's card and detail for a day after the Function learned its
 * baseline (lib/plain.ts, learnedNotice), until the owner closes it. */
export function LearnedBanner({ dog, linkToNormal = true }: { dog: Dog; linkToNormal?: boolean }) {
  const kind = learnedNotice(dog.baseline);
  const at = dog.baseline?.computedAt?.toMillis?.() ?? 0;
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(DISMISS_KEY(dog.id, at)) === "1"; } catch { return false; } });
  if (!kind || seen) return null;
  const close = () => { try { localStorage.setItem(DISMISS_KEY(dog.id, at), "1"); } catch { /* not stored */ } setSeen(true); };
  const refining = kind === "basic" && dog.status?.baselineProgress?.stage === "model";
  return (
    <div className="learned-banner" role="status">
      <Icon name="check" size={18} />
      <div className="learned-banner-text">
        <strong>{kind === "final" ? `Terminamos de aprender el patrón normal de ${dog.name}.` : `Ya conocemos el patrón normal de ${dog.name}.`}</strong>
        <span> Desde ahora comparamos sus datos con lo que es normal en {dog.name} y te avisaremos si algo cambia.{refining ? " Seguimos afinando cómo se mueve." : ""}</span>
        {linkToNormal && <> <Link to={`/perros/${dog.id}#normal`}>Ver qué es normal</Link></>}
      </div>
      <button className="btn btn-ghost btn-sm" type="button" onClick={close}>Entendido</button>
    </div>
  );
}
