/* Screen 7 · Centro de alertas, in two tabs:
   - «Activas»: the new alerts (still to review), grouped by severity: «Crítico» (level «Revisar», red) and «Advertencia»
     (level «Atención», amber). «Marcar todas como revisadas» acts on the dog chosen in the filter and can be undone, also
     after leaving the page and coming back while the undo lasts.
   - «Historial»: an audit table of every alert, newest first, with when it started, the dog, its severity, how long it
     lasted and whether it was reviewed. Nothing is hidden from it.
   The engine has two severities (amber and red): there is no «Info» level to show. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AlertItem, ReviewTag } from "../components/AlertItem";
import { Callout, Icon, LEVELS, Notice, PageHead, useNow, usePageTitle } from "../components/ui";
import { useAlerts, useDogs, useOpenAlerts, type Alert } from "../data/hooks";
import { applyBulk, newAlertIds } from "../lib/alertActions";
import { UNDO_MS, bulkDoneText, bulkStorageKey, bulkUndoneText, restoreBulk, type BulkChange, type StoredBulk } from "../lib/bulkAlerts";
import { freshness, simulatedTime } from "../lib/live";
import { aheadTag, alertGoing, alertStartMs, alertTitle, dateTimeText, durationText, type DataSource } from "../lib/plain";

const PAGE = 50;

type Tab = "activas" | "historial";
const TABS: { id: Tab; label: string }[] = [{ id: "activas", label: "Activas" }, { id: "historial", label: "Historial" }];

const SEVERITY: Record<Alert["severity"], { label: string; level: string }> = {
  red: { label: "Crítico", level: "Nivel «Revisar»" },
  amber: { label: "Advertencia", level: "Nivel «Atención»" },
};

const newestFirst = (a: Alert, b: Alert) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);

/** The last bulk action: what it changed (to undo it) and what it said. `at`: when it was done (undo is time-limited). */
interface BulkDone { change: BulkChange; text: string; at: number; undone: boolean }

const OFFLINE_NOTE = " Sin conexión: se guardará cuando vuelvas a conectarte.";

/** The last bulk action of this tab, if its «Deshacer» still lasts. Storage may be blocked: then nothing. */
function readStoredBulk(key: string): BulkDone | null {
  try {
    const s = restoreBulk(sessionStorage.getItem(key), Date.now());
    if (!s) sessionStorage.removeItem(key);
    return s ? { ...s, undone: false } : null;
  } catch { return null; }
}

/** Tabs that move with the arrow keys, Home and End (the tab pattern), each with its panel. */
function TabList({ value, onChange, counts }: { value: Tab; onChange: (t: Tab) => void; counts: Partial<Record<Tab, number>> }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === value);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };
  return (
    <div className="tabs alert-tabs" role="tablist" aria-label="Alertas" onKeyDown={onKey}>
      {TABS.map((t) => (
        <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" type="button" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`}
          aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
          {t.label}{counts[t.id] != null && <span className="tab-count">{counts[t.id]}</span>}
        </button>
      ))}
    </div>
  );
}

/** The audit table: one row per alert, labelled blocks on a phone (table-stack). As in the alert cards, the start says
 * when it is simulated time or the hour of a file (`sources`: each dog's dogs.status.lastSource), and «En curso» only
 * while the episode still gets data: one whose data stopped has no end and is not said to go on. */
function HistoryTable({ alerts, names, sources }: { alerts: Alert[]; names: Map<string, string>; sources: Map<string, DataSource | undefined> }) {
  return (
    <div className="table-wrap" role="region" aria-label="Historial de alertas" tabIndex={0}>
      <table className="table table-stack history-table">
        <thead><tr><th scope="col">Qué pasó</th><th scope="col">Inicio</th><th scope="col">Perro</th><th scope="col">Severidad</th><th scope="col">Duración</th><th scope="col">Estado</th></tr></thead>
        <tbody>{alerts.map((a) => {
          const start = alertStartMs(a), end = a.endedAt?.toMillis?.();
          const reviewedAt = a.acknowledgedAt?.toMillis?.();
          const sev = SEVERITY[a.severity];
          return (
            <tr key={a.id}>
              <td data-title><Link to={`/alertas/${a.id}`}>{alertTitle(a.reasons, a.titleCode, alertGoing(a))}</Link></td>
              <td data-label="Inicio">{start ? <><span className="nowrap">{dateTimeText(start)}</span>{simulatedTime(start, a.createdAt?.toMillis?.(), Date.now()) && <span className="small muted"> ({aheadTag(sources.get(a.dogId))})</span>}</> : "Sin dato"}</td>
              <td data-label="Perro">{names.get(a.dogId) ?? a.dogName}</td>
              <td data-label="Severidad"><span className={`tag tag-${a.severity}`}><Icon name={LEVELS[a.severity].icon} size={12} />{sev.label}</span></td>
              <td data-label="Duración" className="nowrap">{end ? durationText(end - start) : alertGoing(a) ? "En curso" : "Sin dato"}</td>
              <td data-label="Estado"><span className="history-state"><ReviewTag open={a.status === "open"} />{reviewedAt && <span className="small muted">{dateTimeText(reviewedAt)}</span>}</span></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function AlertsPage() {
  const { user, isAdmin } = useAuth();
  usePageTitle("Alertas");
  const scope = isAdmin ? { kind: "all" as const } : { kind: "owner" as const, uid: user!.uid };
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("vista") === "historial" ? "historial" : "activas";
  const setTab = (t: Tab) => setParams(t === "historial" ? { vista: "historial" } : {}, { replace: true });
  const [max, setMax] = useState(PAGE);
  const { data: history, loading: historyLoading, error: historyError } = useAlerts(scope, max);
  const { data: openOfAll, loading: openLoading, error: openError } = useOpenAlerts({ uid: user!.uid, isAdmin });
  const { data: dogsNow, loading: dogsLoading } = useDogs(scope);
  const now = useNow(30_000);
  // The new alerts of an archived dog («Quitar perro») leave «Activas», as they leave the badge; the
  // history keeps every alert.
  const listedDog = (a: Alert) => dogsLoading || dogsNow.some((d) => d.id === a.dogId);
  const openAll = openOfAll.filter(listedDog);
  const [dog, setDog] = useState<string>("");
  const [busy, setBusy] = useState<"review" | "undo" | null>(null);
  const storageKey = bulkStorageKey(user!.uid);
  const [bulk, setBulk] = useState<BulkDone | null>(() => readStoredBulk(storageKey));
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [undoExpired, setUndoExpired] = useState<number | null>(null);
  const bulkRef = useRef<HTMLDivElement>(null);
  // The result takes the focus, so it is read aloud; one brought back from an earlier visit does not.
  const bulkKey = bulk ? `${bulk.at}|${bulk.undone}` : null;
  const restoredKey = useRef(bulkKey);
  useEffect(() => { if (bulkKey && bulkKey !== restoredKey.current) bulkRef.current?.focus(); }, [bulkKey]);
  useEffect(() => {
    try {
      if (bulk && !bulk.undone && Date.now() - bulk.at < UNDO_MS) {
        const keep: StoredBulk = { change: bulk.change, text: bulk.text, at: bulk.at };
        sessionStorage.setItem(storageKey, JSON.stringify(keep));
      } else sessionStorage.removeItem(storageKey);
    } catch { /* not stored: «Deshacer» stays on this visit only */ }
  }, [bulk, storageKey]);
  // «Deshacer» leaves before firestore.rules stops accepting it.
  useEffect(() => {
    if (!bulk || bulk.undone) return;
    const t = window.setTimeout(() => setUndoExpired(bulk.at), Math.max(0, bulk.at + UNDO_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [bulk]);

  // Current names: an alert keeps the dog's name from when it opened.
  const names = new Map<string, string>([...history, ...openAll].map((a) => [a.dogId, a.dogName]));
  for (const d of dogsNow) if (names.has(d.id)) names.set(d.id, d.name);
  const dogs = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
  const dogName = dog ? names.get(dog) ?? null : null;
  const active = [...(dog ? openAll.filter((a) => a.dogId === dog) : openAll)].sort(newestFirst);
  const bySeverity = (["red", "amber"] as const).map((sev) => ({ sev, items: active.filter((a) => a.severity === sev) })).filter((g) => g.items.length);
  const past = dog ? history.filter((a) => a.dogId === dog) : history;
  const mayHaveMore = history.length >= max;
  const canReview = active.length > 0 || busy === "review";
  const canUndo = !!bulk && !bulk.undone && undoExpired !== bulk.at && bulk.change.reviewed.length > 0;
  // «Todos los sensores…» only when it is true: no alert waiting and every dog with recent data.
  const allFresh = dogsNow.length > 0 && dogsNow.every((d) => d.status && freshness(d.status.lastBlockAt?.toMillis?.() ?? null, d.status.updatedAt?.toMillis?.() ?? null, now, d.status.lastSource) !== "stale");

  const review = async () => {
    setBulkError(null);
    if (!navigator.onLine) { setBulkError("Sin conexión. Inténtalo de nuevo cuando vuelvas a conectarte."); return; }
    setBusy("review");
    try {
      // Every new alert of the dog in the filter (or of all), not only the ones loaded on screen.
      const reviewed = await newAlertIds({ uid: user!.uid, isAdmin }, dog || null);
      if (!reviewed.length) return;
      const r = await applyBulk({ kind: "review", reviewed }, user!.uid);
      if (r.done.reviewed.length) setBulk({ change: r.done, at: Date.now(), undone: false, text: bulkDoneText(r.done, dogName) + (r.pending ? OFFLINE_NOTE : "") });
      if (r.error) setBulkError("No pudimos marcar las alertas como revisadas. Revisa tu conexión e inténtalo de nuevo.");
    } catch {
      setBulkError("No pudimos marcar las alertas como revisadas. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(null);
    }
  };
  const undo = async () => {
    if (!bulk) return;
    setBulkError(null);
    setBusy("undo");
    try {
      const r = await applyBulk(bulk.change, user!.uid, true);
      if (r.error) {
        setBulk({ ...bulk, change: { ...bulk.change, reviewed: bulk.change.reviewed.filter((id) => !r.done.reviewed.includes(id)) } });
        setBulkError("No pudimos deshacer el cambio. Revisa tu conexión e inténtalo de nuevo.");
      } else {
        setBulk({ ...bulk, undone: true, text: bulkUndoneText(bulk.change) + (r.pending ? OFFLINE_NOTE : "") });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page" id="main">
      <div className="page-intro">
        <PageHead title="Alertas" sub="Cambios respecto al patrón normal de tus perros." hero />
        <Notice />
      </div>
      <div className="alert-center">
        <div className="alert-center-bar">
          <TabList value={tab} onChange={setTab} counts={{ activas: openLoading || !active.length ? undefined : active.length }} />
          {dogs.length > 1 && (
            <label className="row alert-dog-filter">
              <span className="small">Perro</span>
              <select className="select" value={dog} onChange={(e) => setDog(e.target.value)}>
                <option value="">Todos</option>
                {dogs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          )}
        </div>

        <section id="panel-activas" role="tabpanel" aria-labelledby="tab-activas" hidden={tab !== "activas"} className="stack">
          {openError && <Callout kind="error">No pudimos cargar tus alertas. Revisa tu conexión e inténtalo de nuevo.</Callout>}
          {bulkError && <Callout kind="error">{bulkError}</Callout>}
          {bulk && (
            <div ref={bulkRef} tabIndex={-1} className="callout callout-ok appear bulk-done" role="status">
              <Icon name="check-circle" size={16} style={{ marginTop: 1, color: "var(--color-status-green)" }} />
              <div className="bulk-done-body">
                <span>{bulk.text}</span>
                {canUndo && <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={busy !== null}>{busy === "undo" ? "Deshaciendo…" : "Deshacer"}</button>}
              </div>
            </div>
          )}
          {openLoading ? (
            <div className="stack" aria-busy="true">
              <p className="sr-only" role="status">Cargando tus alertas…</p>
              <div className="panel alert-skel"><span className="skeleton" style={{ height: 14, width: "30%" }} /><span className="skeleton" style={{ height: 22, width: "70%" }} /></div>
              <div className="panel alert-skel"><span className="skeleton" style={{ height: 14, width: "25%" }} /><span className="skeleton" style={{ height: 22, width: "55%" }} /></div>
            </div>
          ) : !active.length ? (
            <div className="alerts-calm" role="status">
              <Icon name="check-circle" size={20} />
              <span>{allFresh && !dog ? "Todos los sensores están reportando dentro de los rangos normales." : dogName ? `No hay alertas activas de ${dogName}.` : "No hay alertas activas."}</span>
              {past.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTab("historial")}>Ver historial</button>}
            </div>
          ) : (
            <>
              {canReview && (
                <div className="row alert-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={review} disabled={busy !== null}>
                    <Icon name="check-circle" size={14} />{busy === "review" ? "Guardando…" : "Marcar todas como revisadas"}
                  </button>
                </div>
              )}
              {bySeverity.map((g, gi) => (
                <section key={g.sev} className="stack-sm severity-group" data-severity={g.sev} aria-labelledby={`sev-${g.sev}`}>
                  <h2 className="day-heading severity-heading" id={`sev-${g.sev}`}>
                    <span className={`tag tag-${g.sev} tag-lg`}><Icon name={LEVELS[g.sev].icon} size={16} />{SEVERITY[g.sev].label}</span>
                    <span className="severity-count">{g.items.length === 1 ? "1 alerta" : `${g.items.length} alertas`}</span>
                    <span className="small muted">{SEVERITY[g.sev].level}</span>
                  </h2>
                  <ul className="alert-list">{g.items.map((a, i) => <AlertItem key={a.id} alert={a} featured={gi === 0 && i === 0} dogName={names.get(a.dogId)} source={dogsNow.find((d) => d.id === a.dogId)?.status?.lastSource} />)}</ul>
                </section>
              ))}
            </>
          )}
        </section>

        <section id="panel-historial" role="tabpanel" aria-labelledby="tab-historial" hidden={tab !== "historial"} className="stack">
          {historyError && <Callout kind="error">No pudimos cargar el historial. Revisa tu conexión e inténtalo de nuevo.</Callout>}
          {historyLoading && !history.length ? (
            <div className="panel stack-sm" aria-busy="true">
              <p className="sr-only" role="status">Cargando el historial…</p>
              {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" style={{ display: "block", height: 18, width: `${90 - i * 12}%` }} />)}
            </div>
          ) : !past.length ? (
            <div className="alerts-calm"><Icon name="check-circle" size={20} /><span>{dogName ? `${dogName} no tiene alertas registradas.` : "Todavía no hay alertas registradas."}</span></div>
          ) : (
            <section className="panel stack-sm" aria-label="Historial de auditoría">
              <HistoryTable alerts={past} names={names} sources={new Map(dogsNow.map((d) => [d.id, d.status?.lastSource]))} />
              {mayHaveMore && (
                <div className="row more-row">
                  <p className="small muted">Se muestran las {max} alertas más recientes.</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMax(max + PAGE)} disabled={historyLoading}>{historyLoading ? "Cargando…" : `Ver ${PAGE} más`}</button>
                </div>
              )}
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
