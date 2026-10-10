/* Screen 7 · Alertas: newest first, in plain language, with their state; each opens its detail (screen 4).
   Grouped by day, with a filter for the new ones (still to review) and, with more than one dog, one per dog.
   Two bulk actions act on the dog chosen in the filter: «Marcar todas como revisadas», and «Limpiar lista»,
   which takes the alerts off this list (they stay in the dog's history and in the vet view). Both can be undone, also
   after leaving the page and coming back while the undo lasts. */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { AlertItem } from "../components/AlertItem";
import { Callout, EmptyState, Icon, Notice, PageHead, Seg, Skeleton, usePageTitle } from "../components/ui";
import { useAlerts, useClearMarks, useDogs, useOpenAlerts, type Alert } from "../data/hooks";
import { applyBulk, newAlertIds } from "../lib/alertActions";
import { NO_MARKS, UNDO_MS, bulkDoneText, bulkStorageKey, bulkUndoneText, onList, restoreBulk, type BulkChange, type BulkKind, type StoredBulk } from "../lib/bulkAlerts";
import { alertStartMs, dayHeading } from "../lib/plain";

const PAGE = 50;

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

const newestFirst = (a: Alert, b: Alert) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);

/** The last bulk action: what it changed (to undo it) and what it said. `at`: when it was done (undo is time-limited). */
interface BulkDone { change: BulkChange; text: string; at: number; undone: boolean }

const BULK_ERROR: Record<BulkKind | "undo", string> = {
  review: "No pudimos marcar las alertas como revisadas. Revisa tu conexión e inténtalo de nuevo.",
  clear: "No pudimos quitar las alertas de la lista. Revisa tu conexión e inténtalo de nuevo.",
  undo: "No pudimos deshacer el cambio. Revisa tu conexión e inténtalo de nuevo.",
};
const OFFLINE_NOTE = " Sin conexión: se guardará cuando vuelvas a conectarte.";

/** The last bulk action of this tab, if its «Deshacer» still lasts. Storage may be blocked: then nothing. */
function readStoredBulk(key: string): BulkDone | null {
  try {
    const s = restoreBulk(sessionStorage.getItem(key), Date.now());
    if (!s) sessionStorage.removeItem(key);
    return s ? { ...s, undone: false } : null;
  } catch { return null; }
}

export function AlertsPage() {
  const { user, isAdmin } = useAuth();
  usePageTitle("Alertas");
  const scope = isAdmin ? { kind: "all" as const } : { kind: "owner" as const, uid: user!.uid };
  const [max, setMax] = useState(PAGE);
  // The list starts after the person last cleared it for every dog; a clear for one dog is applied below.
  const clearState = useClearMarks(user!.uid);
  const marks = clearState?.marks ?? null;
  const { data: alertsAll, loading, error } = useAlerts(scope, max, clearState ? clearState.since : undefined);
  // New alerts come from their own query: the 50 newest may not hold all of them, and the counts must match the badge.
  const { data: openOfAll } = useOpenAlerts({ uid: user!.uid, isAdmin });
  const { data: dogsNow, loading: dogsLoading } = useDogs(scope);
  // The alerts of an archived dog («Quitar perro») leave this list; they stay in its history.
  const listedDog = (a: Alert) => dogsLoading || dogsNow.some((d) => d.id === a.dogId);
  const alerts = alertsAll.filter(listedDog);
  const openAll = openOfAll.filter(listedDog);
  const [filter, setFilter] = useState<Filter>("all");
  const [dog, setDog] = useState<string>("");
  const [busy, setBusy] = useState<BulkKind | "undo" | null>(null);
  const storageKey = bulkStorageKey(user!.uid);
  const [bulk, setBulk] = useState<BulkDone | null>(() => readStoredBulk(storageKey));
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [undoExpired, setUndoExpired] = useState<number | null>(null);
  const [hintOpen, setHintOpen] = useState(false);
  const bulkRef = useRef<HTMLDivElement>(null);
  // The result takes the focus, so it is read aloud: the button that was pressed may have gone with the alerts. A
  // result brought back from an earlier visit does not take it: the page keeps the focus of the navigation.
  const bulkKey = bulk ? `${bulk.at}|${bulk.undone}` : null;
  const restoredKey = useRef(bulkKey);
  useEffect(() => { if (bulkKey && bulkKey !== restoredKey.current) bulkRef.current?.focus(); }, [bulkKey]);
  // The action stays in this tab while it can be undone; undone, it goes.
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
  const names = new Map<string, string>([...alerts, ...openAll].map((a) => [a.dogId, a.dogName]));
  for (const d of dogsNow) if (names.has(d.id)) names.set(d.id, d.name);
  const dogs = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
  const dogName = dog ? names.get(dog) ?? null : null;
  // Alerts from before a clear leave the list; the dog's history and the vet view still show them.
  const listed = alerts.filter((a) => onList({ dogId: a.dogId, createdAtMs: a.createdAt?.toMillis?.() ?? null }, marks ?? NO_MARKS));
  const ofDog = dog ? listed.filter((a) => a.dogId === dog) : listed;
  // Whether older alerts may remain to load. Right after a clear the previous query is still on screen: its alerts from
  // before the mark do not count.
  const loadedSinceMark = marks?.all != null ? alertsAll.filter((a) => (a.createdAt?.toMillis?.() ?? Infinity) > marks.all!) : alertsAll;
  const mayHaveMore = loadedSinceMark.length >= max;
  const openOfDog = [...(dog ? openAll.filter((a) => a.dogId === dog) : openAll)].sort(newestFirst);
  const shown = filter === "open" ? openOfDog : ofDog;
  // The first new alert of the list is the protagonist of the page; the reviewed ones are quieter.
  const featuredId = shown.find((a) => a.status === "open")?.id;
  const cleared = !!marks && (marks.all != null || Object.keys(marks.byDog).length > 0);
  // A pressed button stays, with its progress, until the server confirms: the list itself changes at once.
  const canReview = openOfDog.length > 0 || busy === "review";
  const canClear = (filter === "all" && ofDog.length > 0) || busy === "clear";
  const canUndo = !!bulk && !bulk.undone && undoExpired !== bulk.at && (bulk.change.reviewed.length > 0 || !!bulk.change.mark);

  const run = async (kind: BulkKind) => {
    setBulkError(null);
    if (!navigator.onLine) { setBulkError("Sin conexión. Inténtalo de nuevo cuando vuelvas a conectarte."); return; }
    setBusy(kind);
    try {
      // Every new alert of the dog in the filter (or of all), not only the ones loaded on screen.
      const reviewed = await newAlertIds({ uid: user!.uid, isAdmin }, dog || null);
      if (kind === "review" && !reviewed.length) return;
      const change: BulkChange = kind === "review" ? { kind, reviewed }
        : { kind, reviewed, mark: { dogId: dog || null, previous: (dog ? marks?.byDog[dog] : marks?.all) ?? null } };
      const r = await applyBulk(change, user!.uid);
      if (r.done.reviewed.length || r.done.mark) {
        setBulk({ change: r.done, at: Date.now(), undone: false, text: bulkDoneText(r.done, dogName) + (r.pending ? OFFLINE_NOTE : "") });
      }
      if (r.error) setBulkError(BULK_ERROR[kind]);
    } catch {
      setBulkError(BULK_ERROR[kind]);
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
        // What was undone stays undone; «Deshacer» retries the rest (the mark goes with the last batch).
        setBulk({ ...bulk, change: { ...bulk.change, reviewed: bulk.change.reviewed.filter((id) => !r.done.reviewed.includes(id)) } });
        setBulkError(BULK_ERROR.undo);
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
      <div className="stack">
        {error && <Callout kind="error">No pudimos cargar tus alertas. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {/* After an action the page keeps its controls and its message while the list reloads. */}
        {loading && !alerts.length && !bulk ? (
          <div className="stack" aria-busy="true">
            <p className="small muted">Cargando tus alertas…</p>
            <Skeleton lines={[30, 70, 45]} />
          </div>
        )
          : !alerts.length && !openAll.length && !cleared && !bulk ? (
            <EmptyState icon="check-circle" title="Sin alertas" text="Cuando algo se aleje del patrón normal de tus perros, lo verás aquí." />
          ) : (
            <div className="alerts-layout">
              {/* The filters and the two bulk actions are one toolbar over the list, not a card beside it. */}
              <div className="alert-tools">
                <div className="alert-bar">
                  <div className="row alert-filters">
                    <Seg label="Mostrar" value={filter} onChange={setFilter}
                      options={[{ value: "open", label: `Nuevas (${openOfDog.length})` }, { value: "all", label: filter === "all" && mayHaveMore ? "Todas" : `Todas (${ofDog.length})` }]} />
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
                  {(canReview || canClear) && (
                    <div className="row alert-actions">
                      {canReview && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => run("review")} disabled={busy !== null}>
                          <Icon name="check-circle" size={14} />{busy === "review" ? "Guardando…" : "Marcar todas como revisadas"}
                        </button>
                      )}
                      {canClear && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => run("clear")} disabled={busy !== null} aria-describedby="clear-hint">
                          <Icon name="archive" size={14} />{busy === "clear" ? "Quitando…" : "Limpiar lista"}
                        </button>
                      )}
                      {/* On a phone the sentence below is folded behind this button, which saves two lines of the first
                          screen; from 721 px the button is not shown and the sentence is always there. */}
                      {canClear && (
                        <button type="button" className="btn btn-ghost alert-hint-toggle" aria-expanded={hintOpen} aria-controls="clear-hint" aria-label="Qué hace «Limpiar lista»" onClick={() => setHintOpen((o) => !o)}>
                          <Icon name="info" size={18} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {/* What «Limpiar lista» does is said before pressing it. */}
                {canClear && <p className="small muted alert-hint" id="clear-hint" data-open={hintOpen ? "true" : undefined}>Limpiar quita las alertas de esta lista y deja revisadas las nuevas. Siguen en el historial de cada perro.</p>}
              </div>
              <div className="alerts-main stack">
                {bulkError && <Callout kind="error">{bulkError}</Callout>}
                {bulk && (
                  <div ref={bulkRef} tabIndex={-1} className="callout callout-ok appear bulk-done" role="status">
                    <Icon name="check-circle" size={16} style={{ marginTop: 1, color: "var(--color-status-green)" }} />
                    <div className="bulk-done-body">
                      <span>{bulk.text}</span>
                      {canUndo && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={busy !== null}>
                          {busy === "undo" ? "Deshaciendo…" : "Deshacer"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {!shown.length ? (loading && !alerts.length ? <Skeleton lines={[30, 70, 45]} /> : filter === "open" ? (
                  ofDog.length ? (
                    <EmptyState icon="check-circle" title="Sin alertas nuevas" text="No tienes alertas nuevas. Las anteriores siguen en «Todas»."
                      action={<button type="button" className="btn btn-secondary" onClick={() => setFilter("all")}>Ver todas</button>} />
                  ) : <EmptyState icon="check-circle" title="Sin alertas nuevas" text="No tienes alertas nuevas." />
                ) : (
                  <EmptyState icon="check-circle" title="Lista limpia"
                    text={dogName
                      ? `Las alertas de ${dogName} que quitaste siguen en su historial y en la Vista para el veterinario.`
                      : "Las alertas que quitaste siguen en el historial de cada perro y en la Vista para el veterinario."} />
                )) : byDay(shown).map((g) => (
                  <section key={g.day} className="stack-sm alert-day" aria-label={g.day}>
                    <h2 className="day-heading">{g.day}</h2>
                    <ul className="alert-list">{g.items.map((a) => <AlertItem key={a.id} alert={a} featured={a.id === featuredId} dogName={names.get(a.dogId)} source={dogsNow.find((d) => d.id === a.dogId)?.status?.lastSource} />)}</ul>
                  </section>
                ))}
                {filter === "all" && mayHaveMore && (
                  <div className="row more-row">
                    {/* Cleared alerts and those of other dogs count among the newest loaded, so the list may show fewer. */}
                    <p className="small muted">{shown.length === loadedSinceMark.length ? `Se muestran las ${max} alertas más recientes.` : "Hay alertas más antiguas."}</p>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMax(max + PAGE)} disabled={loading}>
                      {loading ? "Cargando…" : `Ver ${PAGE} más`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
      </div>
    </main>
  );
}
