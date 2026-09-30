import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Alert, Dog, Fusion } from "../data/hooks";
import { BaselineProgress } from "./BaselineProgress";
import { ageText, alertTitle, behaviorNow, describeDog, type Friendly } from "../lib/plain";
import { HealthGauge, Icon, LEVELS, LevelTag, fmtAgo } from "./ui";

function FriendlyRow({ icon, name, f, extra }: { icon: string; name: string; f: Friendly; extra?: string | null }) {
  const out = f.dev === "low" || f.dev === "high";
  const detail = [extra, f.detail].filter(Boolean).join(" · ");
  return (
    <div className="friendly-row">
      <dt><Icon name={icon} size={16} />{name}</dt>
      <dd>
        <span className={out ? "friendly-value out-of-range" : "friendly-value"}>{out && <Icon name="alert-triangle" size={13} />}{f.label}</span>
        {detail && <span className="friendly-detail">{detail}</span>}
      </dd>
    </div>
  );
}

/** Inicio card: the answer first (state and a plain phrase), then the friendly vitals, with the
 * Health Score as secondary data and a banner when an alert is waiting. */
export function DogCard({ dog, cfg, openAlert }: { dog: Dog; cfg: Fusion; openAlert?: Alert | null }) {
  const s = dog.status, level = s?.level ?? null;
  const d = describeDog(s, dog.baseline, cfg);
  const behavior = s?.lastBehavior ? behaviorNow(s.lastBehavior, dog.sex) : null;
  const { user, isAdmin } = useAuth();
  const canLoad = isAdmin || dog.ownerId === user?.uid;
  return (
    <article className="panel dog-card" style={{ ["--level-color" as string]: level ? LEVELS[level].color : "var(--color-divider)" }} aria-labelledby={`dog-${dog.id}`}>
      <div className="dog-card-head">
        <div>
          <div className="dog-meta">{[dog.breed, ageText(dog.birthDate)].filter(Boolean).join(" · ") || "Sin datos del perfil"}</div>
          <h2 className="dog-name" id={`dog-${dog.id}`}><Link to={`/perros/${dog.id}`}>{dog.name}</Link></h2>
        </div>
        <LevelTag level={level} />
      </div>
      {openAlert && (
        <Link className="alert-banner" to={`/alertas/${openAlert.id}`}>
          <Icon name="bell" size={16} /><span><strong>Alerta sin revisar:</strong> {alertTitle(openAlert.reasons).toLowerCase()}</span><Icon name="chevron-right" size={16} />
        </Link>
      )}
      <p className="dog-phrase">{d.phrase}</p>
      {s ? (
        <>
          <div className="dog-card-body">
            <dl className="friendly">
              <FriendlyRow icon="paw" name="Actividad" f={d.activity} extra={behavior} />
              <FriendlyRow icon="heart" name="Corazón" f={d.heart} />
              <FriendlyRow icon="thermometer" name="Temperatura" f={d.temp} />
            </dl>
            <div className="dog-card-score">
              <HealthGauge score={s.healthScore} level={level} levels={cfg.levels} size={108} />
              <div className="xs muted">Health Score</div>
            </div>
          </div>
          <BaselineProgress dog={dog} cfg={cfg} />
          {s.engineVersion?.startsWith("provisional") && (
            <p className="xs muted" style={{ margin: 0 }}>{s.behaviorModel && s.physioModel
              ? "Conducta y corazón según los modelos; temperatura con reglas provisionales."
              : s.behaviorModel
                ? "Conducta según el modelo; corazón y temperatura con reglas provisionales."
                : "Puntaje provisional: reglas estadísticas mientras se entrenan los modelos."}</p>
          )}
        </>
      ) : (
        <div className="well small">Todavía no hay datos de {dog.name}. Aparecerán cuando lleguen sus primeras lecturas; su patrón normal se calcula con sus primeros datos.
          {canLoad && <div style={{ marginTop: 8 }}><Link className="btn btn-secondary btn-sm" to={`/perfil/datos?perro=${dog.id}`}><Icon name="upload" size={14} />Cargar sus datos</Link></div>}
        </div>
      )}
      <div className="dog-card-foot">
        <span className="xs muted"><Icon name="clock" size={13} /> {s ? `Actualizado ${fmtAgo(s.updatedAt?.toDate?.())}` : "Sin datos"}</span>
        <Link className="small" to={`/perros/${dog.id}`}>Ver detalle <Icon name="chevron-right" size={14} /></Link>
      </div>
    </article>
  );
}
