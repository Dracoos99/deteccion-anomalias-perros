import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Alert, Dog, Fusion } from "../data/hooks";
import { BaselineProgress, LearnedBanner } from "./BaselineProgress";
import { AlertBanner } from "./AlertBanner";
import {
  LEARNING_TEXT, ageText, behaviorShown, describeDog, endSentence, isLearning, lastValue, scoreNote as scoreNoteText, shownScore, whenPhrase, type Friendly,
} from "../lib/plain";
import { DataTime, Icon, LevelTag, ScoreTile, StateTag, averageMinutes, levelVars, useFreshness, useOnline, useSteadyScore } from "./ui";

/** One friendly vital: its name with an icon, the plain value and, small, the exact numbers, one per line. */
/** With the collar off nothing that arrives is the dog's, not even as a last value. */
const NO_DOG_DATA: Friendly = { dev: "unknown", label: "Sin datos del perro", detail: null };

function FriendlyRow({ icon, name, f, extra, last = false }: { icon: string; name: string; f: Friendly; extra?: string | null; last?: boolean }) {
  const out = f.dev === "low" || f.dev === "high";
  return (
    <div className="friendly-row" data-last={last ? "true" : undefined}>
      <dt><Icon name={icon} size={16} />{name}</dt>
      <dd>
        <span className={out ? "friendly-value out-of-range" : "friendly-value"}>{out && <Icon name="alert-triangle" size={14} />}{f.label}</span>
        {extra && <span className="friendly-detail">{extra}</span>}
        {f.detail && <span className="friendly-detail">{f.detail}</span>}
      </dd>
    </div>
  );
}

/** Inicio card: who and how first (the name and the level), then the plain phrase, a
 * banner when an alert is waiting, the friendly vitals and, as secondary data, the Health Score in a quiet tile. Data
 * that stopped arriving are shown as the last state, never as the current one. The whole card opens the dog (its name
 * is the link). The level and the score are the stable ones (5 minutes); a dog still learning its normal
 * pattern shows a neutral state and no score; `scoreNote` adds the line that says what the Health Score is.
 * `featured` is the one dog that needs a look (or the only dog): a wide card with the
 * phrase large, the score on a glass pane and the vitals as tiles; every other card is compact and quieter.
 * Old data (10 minutes) show no score and no «Ahora», only the last state; while an alert
 * goes on, the phrase names its main reason, as the banner does; the score holds while it drifts a point or two
 * and a dog without data says it once, in its well. The vitals of old data are their last
 * values, not «Normal» in the present; why the level is «Atención» comes before what the figure is, which says
 * it is the average of the last minutes. */
export function DogCard({ dog, cfg, openAlert, alertIsNew = false, scoreNote = false, featured = false }: {
  dog: Dog; cfg: Fusion; openAlert?: Alert | null; alertIsNew?: boolean; scoreNote?: boolean; featured?: boolean;
}) {
  const s = dog.status;
  const ongoing = !!openAlert && !openAlert.endedAt;
  const score = useSteadyScore(shownScore(s, ongoing).score, cfg.levels);
  const { freshness, shownMs } = useFreshness(s);
  const stale = freshness === "stale";
  const learning = !stale && isLearning(s, dog.baseline);
  // The collar seems off: nothing arriving is the dog's.
  const sensorOff = !stale && s?.sensor === "no_wear";
  const d = describeDog(s, dog.baseline, cfg, openAlert, ongoing, { key: dog.id });
  const level = d.level;
  const behavior = s?.lastBehavior && !stale && !sensorOff ? `Ahora: ${behaviorShown(s.lastBehavior, s.lastBehaviorProb, dog.sex).toLowerCase()}` : null;
  const { user, isAdmin } = useAuth();
  const canLoad = isAdmin || dog.ownerId === user?.uid;
  const meta = [dog.breed, ageText(dog.birthDate)].filter(Boolean).join(" · ");
  const neutral = stale || learning || sensorOff;
  // Offline, the time of the data says so with its own icon, not the clock of a live card.
  const online = useOnline();
  const tile = !!s && !learning && !stale && !sensorOff;
  const notes = tile && (scoreNote || !!d.levelNote);
  return (
    <article className="panel dog-card" data-variant={featured ? "featured" : "compact"} data-level={stale ? "stale" : sensorOff ? "sensor" : learning ? "learning" : level ?? "none"} style={levelVars(neutral ? null : level)} aria-labelledby={`dog-${dog.id}`}>
      <div className="dog-card-head">
        <div className="dog-card-id">
          <h2 className="dog-name" id={`dog-${dog.id}`}><Link to={`/perros/${dog.id}`}>{dog.name}</Link></h2>
          {meta && <div className="dog-meta">{meta}</div>}
          <StateTag level={level} learning={learning} stale={stale} sensorOff={sensorOff} />
        </div>
        {tile && <ScoreTile score={score} variant={featured ? "glass" : "quiet"} average={averageMinutes(cfg)} />}
      </div>
      {s && (
        <div className="dog-card-state">
          <p className="dog-phrase">{stale && shownMs != null ? endSentence(`No recibimos datos de ${dog.name} desde ${whenPhrase(shownMs)}`) : d.phrase}</p>
          {stale && <div className="last-state">Último estado: {isLearning(s, dog.baseline) ? LEARNING_TEXT : <LevelTag level={level} iconSize={12} />}</div>}
          {!stale && d.todo && <p className="small">{d.todo}</p>}
        </div>
      )}
      {openAlert && <AlertBanner key={openAlert.id} alert={openAlert} isNew={alertIsNew} dogLevel={neutral ? null : level} source={s?.lastSource} present={d.titleStill !== false} />}
      {/* What the figure is, and why the level is another when it is: on a phone, after the phrase (the
          protagonist); on wide screens, in the featured card, right under the figure. */}
      {notes && (
        <div className="dog-score-notes">
          {d.levelNote && <p className="dog-score-note dog-note-why">{d.levelNote}</p>}
          {scoreNote && <p className="dog-score-note">{scoreNoteText(cfg)}</p>}
        </div>
      )}
      <BaselineProgress dog={dog} cfg={cfg} />
      <LearnedBanner dog={dog} />
      {s ? (
        <dl className="friendly">
          <FriendlyRow icon="paw" name="Actividad" f={sensorOff ? NO_DOG_DATA : stale ? lastValue(d.activity) : d.activity} extra={behavior} last={stale || sensorOff} />
          <FriendlyRow icon="heart" name="Corazón" f={sensorOff ? NO_DOG_DATA : stale ? lastValue(d.heart) : d.heart} last={stale || sensorOff} />
          <FriendlyRow icon="thermometer" name="Temperatura" f={sensorOff ? NO_DOG_DATA : stale ? lastValue(d.temp) : d.temp} last={stale || sensorOff} />
        </dl>
      ) : (
        <div className="well">Sus datos aparecerán cuando lleguen sus primeras lecturas; con ellas aprendemos su patrón normal.
          {canLoad && <div className="well-action"><Link className="btn btn-secondary btn-sm" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" size={14} />Cargar sus datos</Link></div>}
        </div>
      )}
      <div className="dog-card-foot">
        <span className="card-time" data-offline={!online && freshness !== "stale" ? "true" : undefined}>{s && freshness ? <><Icon name={!online && freshness !== "stale" ? "wifi-off" : "clock"} size={14} /> <DataTime freshness={sensorOff && freshness === "live" ? "recent" : freshness} shownMs={shownMs} /></> : "Esperando sus primeros datos"}</span>
        <Link className="card-more" to={`/perros/${dog.id}`} aria-label={`Ver detalle de ${dog.name}`}>Ver detalle <Icon name="chevron-right" size={14} /></Link>
      </div>
    </article>
  );
}

/** The dogs that have no data yet, together: one card with a row for each (its name, which opens it, and
 * the action that loads its data), instead of as many identical cards. What every one of them is waiting for is said once. */
export function DogGroup({ dogs }: { dogs: Dog[] }) {
  const { user, isAdmin } = useAuth();
  return (
    <section className="panel dog-group" aria-labelledby="dog-group-title">
      <div className="dog-group-head">
        <h2 className="section-title" id="dog-group-title">Sin datos <span className="dog-group-count">({dogs.length})</span></h2>
        <p className="small muted">Sus datos aparecerán cuando lleguen sus primeras lecturas; con ellas aprendemos su patrón normal.</p>
      </div>
      <div className="dog-rows">
        {dogs.map((dog) => {
          const meta = [dog.breed, ageText(dog.birthDate)].filter(Boolean).join(" · ");
          const canLoad = isAdmin || dog.ownerId === user?.uid;
          return (
            <article className="dog-card dog-row" data-variant="row" data-level="none" key={dog.id} aria-labelledby={`dog-${dog.id}`}>
              <div className="dog-row-id">
                <h3 className="dog-name" id={`dog-${dog.id}`}><Link to={`/perros/${dog.id}`}>{dog.name}</Link></h3>
                {meta && <div className="dog-meta">{meta}</div>}
              </div>
              {canLoad && <Link className="btn btn-secondary btn-sm" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" size={14} />Cargar sus datos</Link>}
              <Icon name="chevron-right" size={14} />
            </article>
          );
        })}
      </div>
    </section>
  );
}
