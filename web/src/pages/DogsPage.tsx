/* Perros: the list of the owner's dogs (every person's for the admin account) with the state each one has on
   Inicio, to open, edit or register a dog and to load data from a CSV (RF-02). It was the «Mis perros» part of Perfil.
   Right after «Quitar perro» it offers «Deshacer»; after «Borrar sus datos» it says so. */
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, LevelTag, PageHead, StateTag, useNow, usePageTitle } from "../components/ui";
import { db } from "../firebase";
import { useDogs, useFusionConfig, useOpenAlerts, type Alert, type Dog, type Fusion } from "../data/hooks";
import { matchesSearch } from "../lib/dashboard";
import { freshness } from "../lib/live";
import { ageText, describeDog, isLearning } from "../lib/plain";

/** The state a dog has on Inicio, from the same data, so this list never says another thing. No data: «Sin datos». */
function DogState({ dog, cfg, alert, now }: { dog: Dog; cfg: Fusion; alert?: Alert; now: number }) {
  const s = dog.status;
  if (!s) return <LevelTag level={null} iconSize={12} />;
  const stale = freshness(s.lastBlockAt?.toMillis?.() ?? null, s.updatedAt?.toMillis?.() ?? null, now, s.lastSource) === "stale";
  const learning = !stale && isLearning(s, dog.baseline);
  const level = describeDog(s, dog.baseline, cfg, undefined, !!alert && !alert.endedAt, { key: dog.id }).level;
  return <StateTag level={level} learning={learning} stale={stale} sensorOff={!stale && s.sensor === "no_wear"} iconSize={12} />;
}

/** «Deshacer» right after «Quitar perro»: the dog was archived, so it comes back with active: true. */
function ArchivedNotice({ archived }: { archived: { id: string; name: string } }) {
  const [state, setState] = useState<"idle" | "busy" | "undone" | "error">("idle");
  const undo = async () => {
    setState("busy");
    try { await updateDoc(doc(db, "dogs", archived.id), { active: true, updatedAt: serverTimestamp() }); setState("undone"); }
    catch { setState("error"); }
  };
  if (state === "undone") return <Callout kind="ok">{archived.name} volvió a tus perros.</Callout>;
  return (
    <div className="callout callout-ok appear" role="status">
      <Icon name="check-circle" size={16} style={{ marginTop: 1, color: "var(--color-status-green)" }} />
      <div className="bulk-done-body">
        <span>Quitamos a {archived.name} de tus perros. Sus datos y sus alertas se guardan.{state === "error" ? " No pudimos deshacerlo: inténtalo de nuevo." : ""}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={state === "busy"}>{state === "busy" ? "Deshaciendo…" : "Deshacer"}</button>
      </div>
    </div>
  );
}

export function DogsPage() {
  const { user, isAdmin } = useAuth();
  const title = isAdmin ? "Todos los perros" : "Tus perros";
  usePageTitle(title);
  const navState = useLocation().state as { archived?: { id: string; name: string }; deletedDog?: string } | null;
  const { data: dogs, loading, error } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const { data: cfg } = useFusionConfig();
  const { data: open } = useOpenAlerts({ uid: user!.uid, isAdmin });
  const now = useNow(5000);
  const [search, setSearch] = useState("");
  const newestOpen = new Map<string, Alert>();
  for (const a of open) {
    const prev = newestOpen.get(a.dogId);
    if (!prev || (a.createdAt?.toMillis?.() ?? 0) > (prev.createdAt?.toMillis?.() ?? 0)) newestOpen.set(a.dogId, a);
  }
  const sorted = [...dogs].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const shown = sorted.filter((d) => matchesSearch(d.name, search));
  return (
    <main className="page page-dogs" id="main">
      <PageHead title={title} sub={isAdmin ? "Los perros de todas las cuentas: ábrelos, edítalos o carga sus datos." : "Ábrelos, edita su ficha o carga los datos de su sensor."} hero
        actions={<>
          <Link className="btn btn-secondary" to="/perfil/datos"><Icon name="upload" />Cargar datos</Link>
          <Link className="btn btn-primary" to="/perros/nuevo"><Icon name="plus" />Registrar perro</Link>
        </>} />
      <div className="stack">
        {navState?.archived && <ArchivedNotice key={navState.archived.id} archived={navState.archived} />}
        {navState?.deletedDog && <Callout kind="ok">Borramos a {navState.deletedDog} y todos sus datos.</Callout>}
        {error && <Callout kind="error">No pudimos cargar tus perros. Revisa tu conexión e inténtalo de nuevo.</Callout>}
        {sorted.length > 6 && (
          <div className="dash-search dogs-search">
            <Icon name="search" size={16} />
            <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre" aria-label="Buscar un perro por su nombre" autoComplete="off" />
          </div>
        )}
        {loading ? (
          <div className="dog-list panel" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="dog-list-skel"><span className="skeleton avatar-skel" /><span className="skeleton" style={{ height: 16, width: "40%" }} /></div>)}
            <p className="sr-only" role="status">Cargando tus perros…</p>
          </div>
        ) : !sorted.length ? (
          <EmptyState icon="paw" title="Todavía no registras perros" text="Registra a tu perro para empezar a ver cómo está respecto a su patrón normal."
            action={<Link className="btn btn-primary" to="/perros/nuevo"><Icon name="plus" />Registrar perro</Link>} />
        ) : !shown.length ? (
          <EmptyState icon="search" title="Ningún perro se llama así" text="Revisa el nombre o borra la búsqueda." />
        ) : (
          <ul className="dog-list panel">
            {shown.map((d) => {
              const meta = [d.breed, ageText(d.birthDate)].filter(Boolean).join(" · ");
              return (
                <li key={d.id}>
                  <Link to={`/perros/${d.id}`} className="dog-list-name">
                    <span className="avatar" aria-hidden="true">{d.name.trim().charAt(0).toUpperCase()}</span>
                    <span className="dog-list-text">
                      <strong className="dog-list-title">{d.name}</strong>
                      {meta && <span className="dog-list-meta">{meta}</span>}
                      <span className="dog-list-state"><DogState dog={d} cfg={cfg} alert={newestOpen.get(d.id)} now={now} /></span>
                    </span>
                  </Link>
                  {(isAdmin || d.ownerId === user!.uid) && <Link className="btn btn-secondary btn-sm dog-list-edit" to={`/perros/${d.id}/editar`} aria-label={`Editar el perfil de ${d.name}`}>Editar</Link>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
