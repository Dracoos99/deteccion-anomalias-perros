/* Screen 8 · Perfil: the account only. The person's name and mail, the appearance and the credentials (the name, and a link by mail to change the password). The dogs went to «Perros»;
   the notices, the app on the home screen and «Tus datos», to «Configuración»; the research tools, to the Consola Admin
   of the top bar. No role is ever shown. */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sendPasswordResetEmail, updateProfile } from "firebase/auth";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "../auth/AuthContext";
import { Callout, Icon, PageHead, Seg, usePageTitle } from "../components/ui";
import { auth, db } from "../firebase";
import { applyPalette, applyTheme, storedTheme, usePalette, type Palette, type Theme } from "../lib/theme";

const NAME_MAX = 60;

/** The three styles, each shown with a preview in its own colours and title font. */
const STYLES: { id: Palette; name: string; icon: string; desc: string }[] = [
  { id: "sereno", name: "Sereno", icon: "check", desc: "El de siempre: sobrio y claro." },
  { id: "calido", name: "Cálido", icon: "heart", desc: "Crema, índigo y títulos con serifa suave. El índigo está entre los colores que tu perro distingue mejor." },
  { id: "extravagante", name: "Extravagante", icon: "zap", desc: "Para divertirse: colores de juguete, bordes gruesos y un poco de humor donde no hay nada serio." },
];

/** The mode (automatic, light or dark) and the style, both kept in this browser. */
function AppearancePanel() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const palette = usePalette();
  const choose = (t: Theme) => { applyTheme(t); setTheme(t); };
  return (
    <section className="profile-section" aria-labelledby="p-appearance">
      <h2 className="section-title" id="p-appearance">Apariencia</h2>
      <div className="field">
        <span className="field-label" id="p-mode">Modo</span>
        <p className="small muted">Automática sigue el modo claro u oscuro de tu equipo. Se guarda en este navegador.</p>
        <Seg label="Modo" value={theme} onChange={choose} options={[{ value: "auto", label: "Automática" }, { value: "light", label: "Clara" }, { value: "dark", label: "Oscura" }]} />
      </div>
      <fieldset className="style-picker">
        <legend className="field-label">Estilo</legend>
        <p className="small muted">Los niveles, las alertas y la Vista para el veterinario se ven igual en todos los estilos.</p>
        <div className="style-options">
          {STYLES.map((s) => (
            <div key={s.id} className="style-option" data-style={s.id}>
              <input type="radio" name="style" id={`style-${s.id}`} value={s.id} checked={palette === s.id}
                onChange={() => applyPalette(s.id)} aria-describedby={`style-${s.id}-desc`} />
              <label htmlFor={`style-${s.id}`}>
                <span className="style-preview" aria-hidden="true">
                  <span className="sp-bar" />
                  <span className="sp-card"><span className="sp-title">Toby</span><span className="sp-pill">Ver detalle</span></span>
                </span>
                <span className="style-name"><Icon name={s.icon} size={16} />{s.name}</span>
              </label>
              <span className="style-desc" id={`style-${s.id}-desc`}>{s.desc}</span>
            </div>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

/** The credentials: the name (the account's and the profile's), and the password, changed through a link sent by mail
 * (the same flow as «Recuperar contraseña», so no password is typed here). The mail is the sign-in and is not changed. */
function CredentialsPanel() {
  const { user, refreshProfile } = useAuth();
  const [name, setName] = useState(user?.displayName ?? "");
  const [nameMsg, setNameMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [pwd, setPwd] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const trimmed = name.trim();
  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !trimmed || trimmed === user.displayName) return;
    setSavingName(true); setNameMsg(null);
    try {
      await updateProfile(user, { displayName: trimmed });
      refreshProfile();
      await updateDoc(doc(db, "users", user.uid), { displayName: trimmed });
      setNameMsg({ kind: "ok", text: "Listo: se guardó tu nombre." });
    } catch {
      setNameMsg({ kind: "error", text: "No pudimos guardar tu nombre. Revisa tu conexión e inténtalo de nuevo." });
    } finally {
      setSavingName(false);
    }
  };
  const resetPassword = async () => {
    if (!user?.email) return;
    setPwd("busy");
    try { await sendPasswordResetEmail(auth, user.email); setPwd("sent"); }
    catch { setPwd("error"); }
  };
  return (
    <section className="profile-section sober" aria-labelledby="p-credentials">
      <h2 className="section-title" id="p-credentials">Datos de acceso</h2>
      <form className="stack-sm" onSubmit={saveName}>
        <div className="field">
          <label htmlFor="p-name">Nombre</label>
          <div className="row profile-name-row">
            <input id="p-name" className="input" value={name} maxLength={NAME_MAX} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-secondary" type="submit" disabled={savingName || !trimmed || trimmed === user?.displayName}>{savingName ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
        {nameMsg && <Callout kind={nameMsg.kind}>{nameMsg.text}</Callout>}
      </form>
      <div className="field">
        <span className="field-label">Correo electrónico</span>
        <span className="profile-value">{user?.email}</span>
        <span className="field-hint">Es tu usuario para entrar; no se cambia desde aquí.</span>
      </div>
      <div className="stack-sm">
        <span className="field-label">Contraseña</span>
        <div><button className="btn btn-secondary btn-sm" type="button" onClick={() => void resetPassword()} disabled={pwd === "busy"}>{pwd === "busy" ? "Enviando…" : "Cambiar contraseña"}</button></div>
        {pwd === "sent" && <Callout kind="ok">Te enviamos un correo a {user?.email} con un enlace para cambiar tu contraseña.</Callout>}
        {pwd === "error" && <Callout kind="error">No pudimos enviar el correo. Revisa tu conexión e inténtalo de nuevo.</Callout>}
      </div>
    </section>
  );
}

export function ProfilePage() {
  const { user, logout } = useAuth();
  usePageTitle("Mi perfil");
  const navigate = useNavigate();
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const initial = (user?.displayName?.trim() || user?.email || "?").charAt(0).toUpperCase();
  return (
    <main className="page page-profile page-account" id="main">
      <PageHead title="Mi perfil" hero />
      {/* The account is the protagonist. Its labels stay for screen readers; sighted people read a name and a mail. */}
      <section className="profile-identity" aria-labelledby="p-account">
        <h2 className="sr-only" id="p-account">Tu cuenta</h2>
        <span className="profile-avatar" aria-hidden="true">{initial}</span>
        <dl className="profile-id">
          <div><dt className="sr-only">Nombre</dt><dd className="profile-name">{user?.displayName || "—"}</dd></div>
          <div><dt className="sr-only">Correo</dt><dd className="profile-mail">{user?.email}</dd></div>
        </dl>
      </section>
      <div className="panel profile-settings account-panel">
        <AppearancePanel />
        <CredentialsPanel />
      </div>
      <div className="row account-foot">
        <Link className="btn btn-ghost" to="/configuracion"><Icon name="sliders" size={16} />Avisos, app y tus datos</Link>
        <button type="button" className="btn btn-secondary" onClick={onLogout}><Icon name="log-out" />Cerrar sesión</button>
      </div>
    </main>
  );
}
