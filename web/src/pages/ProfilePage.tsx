/* Screen 8 · Perfil: account, dogs (register and edit), data upload (CSV), notifications and logout.
   The research tools entry exists only for admin accounts: it is not rendered for owners at all.
 The account is the protagonist (an identity head, not a card), the dogs are a list with the state each one has on
   Inicio, and the settings are one panel of sections separated by hairlines, not four identical cards. */
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, Icon, LevelTag, PageHead, Seg, StateTag, useNow, usePageTitle } from "../components/ui";
import { db } from "../firebase";
import { useDogs, useFusionConfig, useOpenAlerts, useUserProfile, type Alert, type Dog, type Fusion } from "../data/hooks";
import { freshness } from "../lib/live";
import { ageText, describeDog, isLearning } from "../lib/plain";
import { disablePush, enablePush, permission, pushOnHere, pushSupport, type PushSupport } from "../lib/push";
import { applyTheme, storedTheme, type Theme } from "../lib/theme";

/** Avisos: browser notifications of new alerts and which ones to receive. */
/** Automatic, light or dark, kept in this browser. */
function AppearancePanel() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const choose = (t: Theme) => { applyTheme(t); setTheme(t); };
  return (
    <section className="profile-section" aria-labelledby="p-appearance">
      <h2 className="section-title" id="p-appearance">Apariencia</h2>
      <p className="small muted">Automática sigue el modo claro u oscuro de tu equipo. Se guarda en este navegador.</p>
      <Seg label="Apariencia" value={theme} onChange={choose} options={[{ value: "auto", label: "Automática" }, { value: "light", label: "Clara" }, { value: "dark", label: "Oscura" }]} />
    </section>
  );
}

function NotificationsPanel({ uid }: { uid: string }) {
  const { data: profile } = useUserProfile(uid);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => { void pushSupport().then(setSupport); }, []);
  const on = pushOnHere(profile?.fcmTokens);
  const prefs = profile?.notificationPrefs ?? { red: true, amber: true };
  const denied = permission() === "denied";

  const toggle = async () => {
    setBusy(true); setMsg(null);
    try {
      if (on) { await disablePush(uid); setMsg({ kind: "ok", text: "Listo: este navegador ya no recibirá avisos." }); }
      else if ((await enablePush(uid)) === "granted") setMsg({ kind: "ok", text: "Listo: este navegador recibirá un aviso cuando haya una alerta." });
      else setMsg({ kind: "error", text: "El navegador no dio permiso para mostrar avisos." });
    } catch {
      setMsg({ kind: "error", text: "No pudimos cambiar los avisos. Inténtalo de nuevo." });
    } finally {
      setBusy(false);
    }
  };
  const setAmber = async (amber: boolean) => {
    try { await updateDoc(doc(db, "users", uid), { notificationPrefs: { red: true, amber } }); }
    catch { setMsg({ kind: "error", text: "No pudimos guardar tu preferencia." }); }
  };

  return (
    <section className="profile-section" aria-labelledby="p-notif">
      <h2 className="section-title" id="p-notif">Avisos</h2>
      {support === null ? <p className="small muted">Revisando este navegador…</p>
        : support !== "ok" ? (
          <div className="callout"><Icon name="bell-off" size={16} style={{ marginTop: 1 }} /><div>
            {support === "unsupported" ? "Este navegador no permite avisos. Verás las alertas cada vez que abras la app."
              : "Los avisos en el navegador todavía no están disponibles. Verás las alertas cada vez que abras la app."}
            {support === "emulator" && <span className="xs muted"> (Modo de desarrollo: los avisos no funcionan con los emuladores.)</span>}
          </div></div>
        ) : (
          <>
            {on ? <div className="callout callout-ok"><Icon name="check-circle" size={16} style={{ color: "var(--color-status-green)", marginTop: 1 }} /><div>Activados en este navegador. Te avisaremos aunque no tengas la app abierta.</div></div>
              : denied ? <div className="callout callout-warn"><Icon name="alert-triangle" size={16} style={{ color: "var(--color-status-amber)", marginTop: 1 }} /><div>Bloqueaste los avisos. Para activarlos, cambia el permiso de notificaciones en la configuración del navegador (el ícono junto a la dirección).</div></div>
              : <div className="callout"><Icon name="bell" size={16} style={{ marginTop: 1 }} /><div>Actívalos para enterarte de una alerta aunque no tengas la app abierta.</div></div>}
            <div><button className={`btn btn-secondary${on ? " btn-sm" : ""}`} type="button" onClick={toggle} disabled={busy || (denied && !on)}>
              {!on && <Icon name="bell" />}{busy ? "Un momento…" : on ? "Desactivar en este navegador" : "Activar avisos"}</button></div>
          </>
        )}
      {/* The preferences wait until this browser can receive avisos. */}
      <fieldset className="stack-sm profile-field-set" disabled={support !== "ok"} aria-describedby={support !== "ok" ? "p-notif-off" : undefined}>
        <legend className="field-label">Qué quieres recibir</legend>
        <label className="check"><input type="checkbox" checked disabled /><span><LevelTag level="red" /> Siempre activos.</span></label>
        <label className="check"><input type="checkbox" checked={prefs.amber !== false} onChange={(e) => void setAmber(e.target.checked)} />
          <span><LevelTag level="amber" /> Cambios leves respecto a su patrón normal.</span></label>
        {support !== null && support !== "ok" && <p className="xs muted" id="p-notif-off">Podrás elegirlo cuando los avisos estén disponibles en este navegador.</p>}
      </fieldset>
      {msg && <Callout kind={msg.kind}>{msg.text}</Callout>}
    </section>
  );
}

/** The state a dog has on Inicio, from the same data (its status, its normal pattern, its open alert and the fusion
 * configuration), so Perfil never says another thing. A dog with no data yet says «Sin datos». */
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

export function ProfilePage() {
  const { user, isAdmin, logout } = useAuth();
  usePageTitle("Perfil");
  const navigate = useNavigate();
  const archived = (useLocation().state as { archived?: { id: string; name: string } } | null)?.archived ?? null;
  const { data: dogs, loading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const { data: cfg } = useFusionConfig();
  const { data: open } = useOpenAlerts({ uid: user!.uid, isAdmin });
  const now = useNow(5000);
  const newestOpen = new Map<string, Alert>();
  for (const a of open) {
    const prev = newestOpen.get(a.dogId);
    if (!prev || (a.createdAt?.toMillis?.() ?? 0) > (prev.createdAt?.toMillis?.() ?? 0)) newestOpen.set(a.dogId, a);
  }
  const sorted = [...dogs].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const initial = (user?.displayName?.trim() || user?.email || "?").charAt(0).toUpperCase();
  return (
    <main className="page page-profile" id="main">
      <PageHead title="Perfil" hero />
      {archived && <ArchivedNotice key={archived.id} archived={archived} />}
      {/* The account is the protagonist. Its labels stay for screen readers; sighted people read a name and a mail. */}
      <section className="profile-identity" aria-labelledby="p-account">
        <h2 className="sr-only" id="p-account">Tu cuenta</h2>
        <span className="profile-avatar" aria-hidden="true">{initial}</span>
        <dl className="profile-id">
          <div><dt className="sr-only">Nombre</dt><dd className="profile-name">{user?.displayName || "—"}</dd></div>
          <div><dt className="sr-only">Correo</dt><dd className="profile-mail">{user?.email}</dd></div>
        </dl>
      </section>
      {/* With fewer than two dogs the list is shorter than the settings: the grid becomes one column. */}
      <div className={`profile-grid${!loading && sorted.length < 2 ? " profile-grid-short" : ""}`}>
        <section className="profile-dogs" aria-labelledby="p-dogs">
          <div className="row-between profile-section-head">
            {/* The research account sees every person's dogs. */}
            <h2 className="section-title" id="p-dogs">{isAdmin ? "Todos los perros" : "Mis perros"}</h2>
            <Link className="btn btn-secondary btn-sm" to="/perros/nuevo"><Icon name="plus" size={14} />Agregar perro</Link>
          </div>
          {loading ? <p className="small muted">Cargando…</p>
            : !sorted.length ? <p className="small muted">Todavía no registras perros.</p>
            : (
              <ul className="dog-list panel">
                {sorted.map((d) => {
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
        </section>
        <div className="profile-side">
          <div className="panel profile-settings">
            {/* One filled action on the page (rule 5): «Cargar datos»; «Activar avisos» is outlined. */}
            <section className="profile-section" aria-labelledby="p-data">
              <h2 className="section-title" id="p-data">Datos de tus perros</h2>
              <p className="small muted">Sube un archivo CSV con las lecturas del sensor de tu perro. Las revisamos antes de guardarlas.</p>
              <div><Link className="btn btn-primary" to="/perfil/datos"><Icon name="upload" />Cargar datos</Link></div>
            </section>
            <NotificationsPanel uid={user!.uid} />
            <AppearancePanel />
            {isAdmin && (
              <section className="profile-section" aria-labelledby="p-research">
                <h2 className="section-title" id="p-research">Herramientas de investigación</h2>
                <p className="small muted">Simulador, modelos y configuración de la fusión, y la revisión experta a ciegas.</p>
                <div className="row">
                  <Link className="btn btn-secondary btn-sm" to="/admin"><Icon name="flask" size={14} />Abrir herramientas</Link>
                  <Link className="btn btn-ghost btn-sm" to="/admin/configuracion"><Icon name="sliders" size={14} />Modelos y configuración</Link>
                  <Link className="btn btn-ghost btn-sm" to="/admin/revision"><Icon name="check" size={14} />Revisión experta</Link>
                </div>
              </section>
            )}
          </div>
          {/* On wider screens «Cerrar sesión» is already in the side column or the masthead. */}
          <div className="profile-logout"><button type="button" className="btn btn-secondary" onClick={onLogout}><Icon name="log-out" />Cerrar sesión</button></div>
        </div>
      </div>
    </main>
  );
}
