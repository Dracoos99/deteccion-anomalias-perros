/* Screen 7 · Alertas: newest first, in plain language, with their state; each opens its detail (screen 4).
   Grouped by day, with a filter for the ones still to review and, with more than one dog, one per dog. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, LevelTag, PageHead, Seg, usePageTitle } from "../components/ui";
import { useAlerts, type Alert } from "../data/hooks";
import { alertTitle, dayHeading, durationText, whenText } from "../lib/plain";

/** Data time of the episode; alerts from before it only have the write time. */
export const alertStartMs = (a: Alert) => a.startedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;

export function AlertItem({ alert, showDog = true }: { alert: Alert; showDog?: boolean }) {
  const open = alert.status === "open";
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  return (
    <li>
      <Link className="panel alert-item" to={`/alertas/${alert.id}`} data-open={open}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <LevelTag level={alert.severity} />
          <span className="small muted tabular">{start ? whenText(start) : ""}{end ? ` · duró ${durationText(end - start)}` : ""}</span>
        </div>
        <div className="alert-item-title">{showDog && <span className="alert-item-dog">{alert.dogName}: </span>}{alertTitle(alert.reasons).toLowerCase()}</div>
        <div className="row xs" style={{ justifyContent: "space-between" }}>
          <span className={open ? "alert-state alert-state-open" : "alert-state"}>{open ? <><span className="dot" aria-hidden="true" />Sin revisar</> : <><Icon name="check" size={12} />Revisada</>}</span>
          <span className="muted">Ver detalle <Icon name="chevron-right" size={13} /></span>
        </div>
      </Link>
    </li>
  );
}

type Filter = "open" | "all";

/** Alerts grouped by the day they started, keeping the newest-first order. */
function byDay(alerts: Alert[]): { day: string; items: Alert[] }[] {
  const groups: { day: string; items: Alert[] }[] = [];
  for (const a of alerts) {
    const day = dayHeading(alertStartMs(a));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(a);
    else groups.push({ day, items: [a] });
  }
  return groups;
}

export function AlertsPage() {
  const { user, isAdmin } = useAuth();
  usePageTitle("Alertas");
  const { data: alerts, loading, error } = useAlerts(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const [filter, setFilter] = useState<Filter>("all");
  const [dog, setDog] = useState<string>("");
  const dogs = [...new Map(alerts.map((a) => [a.dogId, a.dogName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
  const ofDog = dog ? alerts.filter((a) => a.dogId === dog) : alerts;
  const openCount = ofDog.filter((a) => a.status === "open").length;
  const shown = filter === "open" ? ofDog.filter((a) => a.status === "open") : ofDog;
  return (
    <main className="page" id="main">
      <PageHead title="Alertas" sub="Avisos de cambios respecto al patrón normal de tus perros." />
      <div className="stack">
        {error && <Callout kind="error">No pudimos cargar tus alertas. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {loading ? <div className="boot" style={{ minHeight: 200 }} aria-busy="true">Cargando tus alertas…</div>
          : !alerts.length ? (
            <EmptyState icon="check-circle" title="Sin alertas" text="Cuando algo se aleje del patrón normal de tus perros, lo verás aquí." />
          ) : (
            <>
              <div className="row alert-filters">
                <Seg label="Mostrar" value={filter} onChange={setFilter}
                  options={[{ value: "open", label: `Sin revisar (${openCount})` }, { value: "all", label: `Todas (${ofDog.length})` }]} />
                {dogs.length > 1 && (
                  <label className="row" style={{ gap: 6 }}>
                    <span className="small">Perro</span>
                    <select className="select" style={{ width: "auto", minHeight: 38 }} value={dog} onChange={(e) => setDog(e.target.value)}>
                      <option value="">Todos</option>
                      {dogs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {!shown.length ? (
                <EmptyState icon="check-circle" title="Todo revisado" text="No tienes alertas sin revisar. Las anteriores siguen en «Todas»."
                  action={<button type="button" className="btn btn-secondary" onClick={() => setFilter("all")}>Ver todas</button>} />
              ) : byDay(shown).map((g) => (
                <section key={g.day} className="stack-sm" aria-label={g.day}>
                  <h2 className="day-heading">{g.day}</h2>
                  <ul className="alert-list">{g.items.map((a) => <AlertItem key={a.id} alert={a} />)}</ul>
                </section>
              ))}
              {alerts.length >= 50 && <p className="xs muted" style={{ margin: 0 }}>Se muestran las 50 alertas más recientes.</p>}
            </>
          )}
      </div>
    </main>
  );
}
