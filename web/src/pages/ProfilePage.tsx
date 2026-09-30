/* Screen 8 · Perfil: account, dogs (register and edit), data upload (CSV), notifications and logout.
   The research tools entry exists only for admin accounts: it is not rendered for owners at all. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, EmptyState, Icon, LevelTag, PageHead } from "../components/ui";
import { db } from "../firebase";
import { useDogs, useUserProfile } from "../data/hooks";
import { disablePush, enablePush, permission, pushOnHere, pushSupport, type PushSupport } from "../lib/push";

/** Avisos: browser notifications of new alerts and which ones to receive. */
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
    <section className="panel stack-sm" aria-labelledby="p-notif">
      <h2 className="section-title" id="p-notif">Avisos</h2>
      {support === null ? <p className="small muted" style={{ margin: 0 }}>Revisando este navegador…</p>
        : support !== "ok" ? (
          <div className="callout"><Icon name="bell-off" size={18} style={{ marginTop: 2 }} /><div>
            {support === "unsupported" ? "Este navegador no permite avisos. Verás las alertas cada vez que abras la app."
              : "Los avisos en el navegador todavía no están disponibles. Verás las alertas cada vez que abras la app."}
            {support === "emulator" && <span className="xs muted"> (Modo de desarrollo: los avisos no funcionan con los emuladores.)</span>}
          </div></div>
        ) : (
          <>
            {on ? <div className="callout callout-ok"><Icon name="check-circle" size={18} style={{ color: "var(--color-status-green)", marginTop: 2 }} /><div>Activados en este navegador. Te avisaremos aunque no tengas la app abierta.</div></div>
              : denied ? <div className="callout callout-warn"><Icon name="alert-triangle" size={18} style={{ marginTop: 2 }} /><div>Bloqueaste los avisos. Para activarlos, cambia el permiso de notificaciones en la configuración del navegador (el ícono junto a la dirección).</div></div>
              : <div className="callout"><Icon name="bell" size={18} style={{ marginTop: 2 }} /><div>Actívalos para enterarte de una alerta aunque no tengas la app abierta.</div></div>}
            <div><button className={`btn ${on ? "btn-secondary" : "btn-primary"}`} type="button" onClick={toggle} disabled={busy || (denied && !on)}>
              <Icon name={on ? "bell-off" : "bell"} />{busy ? "Un momento…" : on ? "Desactivar en este navegador" : "Activar avisos"}</button></div>
          </>
        )}
      <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">Qué quieres recibir</legend>
        <label className="check"><input type="checkbox" checked disabled /><span><LevelTag level="red" /> Siempre activos.</span></label>
        <label className="check"><input type="checkbox" checked={prefs.amber !== false} onChange={(e) => void setAmber(e.target.checked)} />
          <span><LevelTag level="amber" /> Cambios leves respecto a su patrón normal.</span></label>
      </fieldset>
      {msg && <Callout kind={msg.kind}>{msg.text}</Callout>}
    </section>
  );
}

export function ProfilePage() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { data: dogs, loading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const sorted = [...dogs].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  return (
    <main className="page" id="main" style={{ maxWidth: 760 }}>
      <PageHead title="Perfil" />
      <div className="stack">
        <section className="panel stack-sm" aria-labelledby="p-account">
          <h2 className="section-title" id="p-account">Tu cuenta</h2>
          <dl className="dl">
            <div className="dl-row"><dt>Nombre</dt><dd>{user?.displayName || "—"}</dd></div>
            <div className="dl-row"><dt>Correo</dt><dd>{user?.email}</dd></div>
          </dl>
        </section>
        <section className="panel stack-sm" aria-labelledby="p-dogs">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h2 className="section-title" id="p-dogs">Mis perros</h2>
            <Link className="btn btn-secondary btn-sm" to="/perros/nuevo"><Icon name="plus" />Agregar perro</Link>
          </div>
          {loading ? <div className="small muted">Cargando…</div>
            : !sorted.length ? <EmptyState title="Todavía no registras perros" />
            : (
              <ul className="dog-list">
                {sorted.map((d) => (
                  <li key={d.id}>
                    <Link to={`/perros/${d.id}`} className="dog-list-name"><Icon name="paw" size={15} /><strong>{d.name}</strong></Link>
                    <span className="small muted">{d.breed ?? ""}</span>
                    {(isAdmin || d.ownerId === user!.uid) && <Link className="small" to={`/perros/${d.id}/editar`}>Editar</Link>}
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section className="panel stack-sm" aria-labelledby="p-data">
          <h2 className="section-title" id="p-data">Datos de tus perros</h2>
          <p className="small muted" style={{ margin: 0 }}>Sube un archivo CSV con las lecturas del sensor de tu perro. Las revisamos antes de guardarlas.</p>
          <div><Link className="btn btn-secondary" to="/perfil/datos"><Icon name="upload" />Cargar datos</Link></div>
        </section>
        <NotificationsPanel uid={user!.uid} />
        {isAdmin && (
          <section className="panel stack-sm" aria-labelledby="p-research">
            <h2 className="section-title" id="p-research">Herramientas de investigación</h2>
            <p className="small muted" style={{ margin: 0 }}>Simulador, modelos y configuración de la fusión.</p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link className="btn btn-secondary" to="/admin"><Icon name="flask" />Abrir herramientas</Link>
              <Link className="btn btn-ghost" to="/admin/configuracion"><Icon name="sliders" />Modelos y configuración</Link>
            </div>
          </section>
        )}
        <div><button type="button" className="btn btn-ghost" onClick={onLogout}><Icon name="log-out" />Cerrar sesión</button></div>
      </div>
    </main>
  );
}
