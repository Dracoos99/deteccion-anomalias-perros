/* Screen 7 · Alertas: newest first, in plain language, with their state; each opens its detail (screen 4). */
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, LevelTag, PageHead } from "../components/ui";
import { useAlerts, type Alert } from "../data/hooks";
import { alertTitle, dateTimeText, durationText } from "../lib/plain";

/** Data time of the episode; alerts from before it only have the write time. */
export const alertStartMs = (a: Alert) => a.startedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;

export function AlertItem({ alert, showDog = true }: { alert: Alert; showDog?: boolean }) {
  const open = alert.status === "open";
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  return (
    <li>
      <Link className="panel alert-item" to={`/alertas/${alert.id}`}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <LevelTag level={alert.severity} />
          <span className="small muted tabular">{start ? dateTimeText(start) : ""}{end ? ` · ${durationText(end - start)}` : ""}</span>
        </div>
        <div className="alert-item-title">{showDog && <span className="alert-item-dog">{alert.dogName}: </span>}{alertTitle(alert.reasons).toLowerCase()}</div>
        <div className="row xs muted" style={{ justifyContent: "space-between" }}>
          <span>{open ? "Sin revisar" : "Revisada"}</span>
          <span>Ver detalle <Icon name="chevron-right" size={13} /></span>
        </div>
      </Link>
    </li>
  );
}

export function AlertsPage() {
  const { user, isAdmin } = useAuth();
  const { data: alerts, loading, error } = useAlerts(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  return (
    <main className="page" id="main">
      <PageHead title="Alertas" sub="Avisos de cambios respecto al patrón normal de tus perros." />
      <div className="stack">
        {error && <Callout kind="error">No pudimos cargar tus alertas. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {loading ? <div className="boot" style={{ minHeight: 200 }} aria-busy="true">Cargando tus alertas…</div>
          : !alerts.length ? (
            <EmptyState icon="check-circle" title="Sin alertas" text="Cuando algo se aleje del patrón normal de tus perros, lo verás aquí." />
          ) : <ul className="alert-list">{alerts.map((a) => <AlertItem key={a.id} alert={a} />)}</ul>}
      </div>
    </main>
  );
}
