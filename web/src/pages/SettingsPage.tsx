/* Configuración: what was the second half of Perfil, reached from the avatar menu. Avisos, the app on the home screen and «Tus datos». Nothing was removed: Perfil keeps only the account, the appearance and the credentials. */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, Icon, LevelTag, PageHead, usePageTitle } from "../components/ui";
import { callFunction, db } from "../firebase";
import { useUserProfile } from "../data/hooks";
import { disablePush, enablePush, permission, pushOnHere, pushSupport, type PushSupport } from "../lib/push";
import { isIos, isStandalone, promptInstall, useInstallState } from "../lib/install";
import { CONFIRM_WORD, downloadMyData, markAccountDeleted } from "../lib/myData";
import { DEFAULT_QUIET, DEFAULT_TZ, validTime, type QuietHours } from "@shared/quiet";

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
  const savePrefs = async (next: { amber: boolean; quiet: QuietHours | null }) => {
    try { await updateDoc(doc(db, "users", uid), { notificationPrefs: { red: true, ...next } }); }
    catch { setMsg({ kind: "error", text: "No pudimos guardar tu preferencia." }); }
  };
  const quiet = prefs.quiet ?? null;
  const setAmber = (amber: boolean) => savePrefs({ amber, quiet });
  // The window is kept with this browser's time zone, so the Function reads the hours as the person meant them.
  const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ; } catch { return DEFAULT_TZ; } };
  const setQuiet = (on: boolean) => savePrefs({ amber: prefs.amber !== false, quiet: on ? { ...DEFAULT_QUIET, tz: browserTz() } : null });
  const setQuietTime = (key: "from" | "to", value: string) => {
    if (quiet && validTime(value)) void savePrefs({ amber: prefs.amber !== false, quiet: { ...quiet, [key]: value, tz: browserTz() } });
  };
  // On the iPhone, pushes work only in the app added to the home screen.
  const iosBrowser = support === "unsupported" && isIos() && !isStandalone();

  return (
    <section className="profile-section" aria-labelledby="p-notif">
      <h2 className="section-title" id="p-notif">Avisos</h2>
      {support === null ? <p className="small muted">Revisando este navegador…</p>
        : support !== "ok" ? (
          <div className="callout"><Icon name="bell-off" size={16} style={{ marginTop: 1 }} /><div>
            {iosBrowser ? "En iPhone, los avisos llegan solo a la app instalada: más abajo, en «App en tu celular», te decimos cómo instalarla."
              : support === "unsupported" ? "Este navegador no permite avisos. Verás las alertas cada vez que abras la app."
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
        {prefs.amber !== false && (
          <>
            <label className="check"><input type="checkbox" checked={!!quiet} onChange={(e) => void setQuiet(e.target.checked)} aria-describedby="p-quiet-help" />
              <span>Horario silencioso</span></label>
            {quiet && (
              <div className="quiet-hours">
                <div className="field"><label htmlFor="p-quiet-from">Desde</label>
                  <input id="p-quiet-from" className="input" type="time" value={quiet.from} onChange={(e) => setQuietTime("from", e.target.value)} /></div>
                <div className="field"><label htmlFor="p-quiet-to">Hasta</label>
                  <input id="p-quiet-to" className="input" type="time" value={quiet.to} onChange={(e) => setQuietTime("to", e.target.value)} /></div>
              </div>
            )}
            <p className="xs muted" id="p-quiet-help">En ese horario solo te avisamos de lo que hay que revisar; los cambios leves quedan en la app.</p>
          </>
        )}
        {support !== null && support !== "ok" && <p className="xs muted" id="p-notif-off">Podrás elegirlo cuando los avisos estén disponibles en este navegador.</p>}
      </fieldset>
      {msg && <Callout kind={msg.kind}>{msg.text}</Callout>}
    </section>
  );
}

/** The app on the home screen. Hidden where the browser cannot install it. */
function InstallPanel() {
  const state = useInstallState();
  const [declined, setDeclined] = useState(false);
  if (state === "unavailable") return null;
  const install = async () => { setDeclined(!(await promptInstall())); };
  return (
    <section className="profile-section" aria-labelledby="p-install">
      <h2 className="section-title" id="p-install">App en tu celular</h2>
      {state === "installed" ? <p className="small muted">Estás usando la app instalada.</p>
        : state === "prompt" ? (
          <>
            <p className="small muted">Instálala para abrirla desde la pantalla de inicio, como cualquier app.</p>
            <div><button className="btn btn-secondary btn-sm" type="button" onClick={() => void install()}><Icon name="download" size={14} />Instalar la app</button></div>
            {declined && <p className="xs muted">Puedes instalarla cuando quieras desde aquí.</p>}
          </>
        ) : (
          <p className="small muted">En iPhone: toca <strong>Compartir</strong> y luego <strong>Agregar a inicio</strong>. Ábrela desde tu pantalla de inicio para recibir los avisos.</p>
        )}
    </section>
  );
}

/** «Tus datos». Download in the browser; deleting the account goes through the deleteMyData function. */
function PrivacyPanel({ uid }: { uid: string }) {
  const { data: profile } = useUserProfile(uid);
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [download, setDownload] = useState<{ state: "idle" | "busy" | "error" } | { state: "done"; name: string }>({ state: "idle" });
  const [del, setDel] = useState<"idle" | "confirm" | "busy">("idle");
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const consent = profile?.privacyConsentAt?.toDate?.();
  const onDownload = async () => {
    setDownload({ state: "busy" });
    try { setDownload({ state: "done", name: await downloadMyData(uid) }); }
    catch { setDownload({ state: "error" }); }
  };
  const onDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (word.trim().toUpperCase() !== CONFIRM_WORD) return;
    setDel("busy"); setError(null);
    try {
      await callFunction("deleteMyData", { scope: "account", confirm: CONFIRM_WORD });
      // Signing out sends every page to /acceso on its own: the sign-in reads the notice from here, not from the route.
      markAccountDeleted();
      await logout().catch(() => undefined);
      navigate("/acceso", { replace: true });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      setError(code.endsWith("failed-precondition") ? (err as Error).message : "No pudimos borrar tu cuenta. Revisa tu conexión e inténtalo de nuevo.");
      setDel("confirm");
    }
  };
  return (
    <section className="profile-section sober" aria-labelledby="p-privacy">
      <h2 className="section-title" id="p-privacy">Tus datos</h2>
      <p className="small muted">
        {consent ? `Autorizaste el tratamiento de tus datos personales el ${consent.toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" })}. ` : ""}
        Puedes descargarlos o borrarlos cuando quieras (Ley{" "}N.°{" "}29733).
      </p>
      <div><button className="btn btn-secondary btn-sm" type="button" onClick={() => void onDownload()} disabled={download.state === "busy"}>
        <Icon name="download" size={14} />{download.state === "busy" ? "Preparando…" : "Descargar mis datos"}</button></div>
      {download.state === "done" && <Callout kind="ok">Listo: descargamos «{download.name}». Incluye tu perfil, tus perros, sus alertas, sus cargas y sus tendencias.</Callout>}
      {download.state === "error" && <Callout kind="error">No pudimos preparar tus datos. Revisa tu conexión e inténtalo de nuevo.</Callout>}
      {del === "idle" ? (
        <div><button className="btn btn-danger btn-sm" type="button" onClick={() => { setDel("confirm"); setWord(""); setError(null); }}><Icon name="trash" size={14} />Borrar mi cuenta</button></div>
      ) : (
        <form className="callout callout-warn stack-sm" onSubmit={onDelete} aria-labelledby="p-delete-q">
          <p id="p-delete-q">Se borran para siempre tu cuenta, tus perros y todos sus datos: lecturas, alertas, tendencias y cargas. No se puede deshacer. Las copias de seguridad del sistema los conservan hasta 7 días más y después se borran solas. Si quieres guardarlos, descárgalos antes.</p>
          <div className="field"><label htmlFor="p-delete-word">Escribe {CONFIRM_WORD} para confirmar</label>
            <input id="p-delete-word" className="input" autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} disabled={del === "busy"} autoFocus /></div>
          {error && <p className="small" role="alert">{error}</p>}
          <div className="row">
            <button className="btn btn-danger-solid btn-sm" type="submit" disabled={del === "busy" || word.trim().toUpperCase() !== CONFIRM_WORD}>{del === "busy" ? "Borrando…" : "Borrar mi cuenta para siempre"}</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDel("idle")} disabled={del === "busy"}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  usePageTitle("Configuración");
  return (
    <main className="page page-profile" id="main">
      <PageHead title="Configuración" sub="Avisos, la app en tu celular y tus datos." hero />
      <div className="panel profile-settings settings-panel">
        <NotificationsPanel uid={user!.uid} />
        <InstallPanel />
        <PrivacyPanel uid={user!.uid} />
      </div>
    </main>
  );
}
