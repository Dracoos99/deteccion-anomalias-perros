import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Alert, Dog, Fusion } from "../data/hooks";
import { BaselineProgress } from "./BaselineProgress";
import { ageText, alertStartMs, alertTitle, behaviorNow, describeDog, endSentence, whenPhrase, type Friendly } from "../lib/plain";
import { DataTime, HealthGauge, Icon, LEVELS, LevelTag, levelVars, useFreshness } from "./ui";

/** One friendly vital: its name with an icon, the plain value and, small, the exact number. */
function FriendlyRow({ icon, name, f, extra }: { icon: string; name: string; f: Friendly; extra?: string | null }) {
  const out = f.dev === "low" || f.dev === "high";
  const detail = [extra, f.detail].filter(Boolean).join(" · ");
  return (
    <div className="friendly-row">
      <dt><Icon name={icon} size={14} />{name}</dt>
      <dd>
        <span className={out ? "friendly-value out-of-range" : "friendly-value"}>{out && <Icon name="alert-triangle" size={12} />}{f.label}</span>
        {detail && <span className="friendly-detail">{detail}</span>}
      </dd>
    </div>
  );
}

/** Inicio card: the answer first (state and a plain phrase), then the friendly vitals, with the
 * Health Score as secondary data and a banner when an alert is waiting. Data that stopped arriving are shown as the
 * last state, never as the current one. The whole card opens the dog (its name is the link). */
export function DogCard({ dog, cfg, openAlert, alertIsNew = false }: { dog: Dog; cfg: Fusion; openAlert?: Alert | null; alertIsNew?: boolean }) {
  const s = dog.status, level = s?.level ?? null;
  const { freshness, shownMs } = useFreshness(s);
  const stale = freshness === "stale";
  const d = describeDog(s, dog.baseline, cfg, openAlert?.reasons);
  const behavior = s?.lastBehavior ? behaviorNow(s.lastBehavior, dog.sex) : null;
  const { user, isAdmin } = useAuth();
  const canLoad = isAdmin || dog.ownerId === user?.uid;
  const A = openAlert ? LEVELS[openAlert.severity] : null;
  return (
    <article className="panel dog-card" style={levelVars(stale ? null : level)} aria-labelledby={`dog-${dog.id}`}>
      <div className="dog-card-head">
        <div>
          <div className="dog-meta">{[dog.breed, ageText(dog.birthDate)].filter(Boolean).join(" · ") || "Sin datos del perfil"}</div>
          <h2 className="dog-name" id={`dog-${dog.id}`}><Link to={`/perros/${dog.id}`}>{dog.name}</Link></h2>
        </div>
        {stale ? <span className="tag tag-outline"><Icon name="clock" size={14} />Sin datos recientes</span> : <LevelTag level={level} />}
      </div>
      {openAlert && A && (
        <Link key={openAlert.id} className={alertIsNew ? "alert-banner appear" : "alert-banner"} data-level={openAlert.severity} to={`/alertas/${openAlert.id}`}>
          <Icon name={A.icon} size={16} style={{ color: A.color }} />
          <span>
            <strong>Alerta nueva:</strong> {alertTitle(openAlert.reasons).toLowerCase()}
            <span className="sr-only">. Nivel de la alerta: {A.text}</span>
            <span className="alert-banner-when"> · {whenPhrase(alertStartMs(openAlert))}</span>
          </span>
          <Icon name="chevron-right" size={16} />
        </Link>
      )}
      <p className="dog-phrase">{stale && shownMs != null ? endSentence(`No recibimos datos de ${dog.name} desde ${whenPhrase(shownMs)}`) : d.phrase}</p>
      {stale && <div className="last-state small">Último estado: <LevelTag level={level} iconSize={12} /></div>}
      <BaselineProgress dog={dog} cfg={cfg} />
      {s ? (
        <>
          <div className="dog-card-body">
            <dl className="friendly">
              <FriendlyRow icon="paw" name="Actividad" f={d.activity} extra={behavior} />
              <FriendlyRow icon="heart" name="Corazón" f={d.heart} />
              <FriendlyRow icon="thermometer" name="Temperatura" f={d.temp} />
            </dl>
            <div className="dog-card-score">
              <HealthGauge score={s.healthScore} level={level} levels={cfg.levels} size={88} />
              <div className="xs muted">Health Score</div>
            </div>
          </div>
        </>
      ) : (
        <div className="well">Sus datos aparecerán cuando lleguen sus primeras lecturas; con ellas aprendemos su patrón normal.
          {canLoad && <div className="well-action"><Link className="btn btn-secondary btn-sm" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" size={14} />Cargar sus datos</Link></div>}
        </div>
      )}
      <div className="dog-card-foot">
        <span className="xs muted">{s && freshness ? <><Icon name="clock" size={12} /> <DataTime freshness={freshness} shownMs={shownMs} /></> : "Esperando sus primeros datos"}</span>
        <Link className="card-more" to={`/perros/${dog.id}`} aria-label={`Ver detalle de ${dog.name}`}>Ver detalle <Icon name="chevron-right" size={14} /></Link>
      </div>
    </article>
  );
}
