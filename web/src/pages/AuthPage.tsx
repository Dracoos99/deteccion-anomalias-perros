/* Screen 1 · Sign in, sign up and password recovery. One form for everyone and no role choice. */
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword, updateProfile } from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { auth, usingEmulators } from "../firebase";
import { landingFor, useAuth } from "../auth/AuthContext";
import { Callout, EmulatorBanner, Icon, Notice, usePageTitle } from "../components/ui";
import { accountJustDeleted, clearAccountDeleted } from "../lib/myData";
import { completeSignUp } from "../auth/signup";

type Mode = "login" | "registro" | "recuperar";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accounts created by scripts/seed-emulator.mjs (fictitious people). Shown only with the emulators.
const DEMO_ACCOUNTS = [
  { label: "Lucía Paredes", email: "lucia.paredes@example.com" },
  { label: "Martín Quispe", email: "martin.quispe@example.com" },
  { label: "Investigación", email: "admin@example.com" },
];
const DEMO_PASSWORD = "demo-1234";
const NAME_MAX = 80;   // the limit setInitialRole keeps

/** The network message names the emulators only in local development. */
const OFFLINE_TEXT = "No hay conexión con el servidor. Revisa tu conexión e inténtalo de nuevo." +
  (usingEmulators ? " Con emuladores: revisa que estén encendidos." : "");

function authErrorText(e: unknown, mode: Mode): string {
  const code = e instanceof FirebaseError ? e.code : "";
  if (code === "auth/network-request-failed") return OFFLINE_TEXT;
  if (code === "auth/too-many-requests") return "Hubo demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
  if (mode === "registro" && code === "auth/email-already-in-use") return "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.";
  if (mode === "registro" && code === "auth/weak-password") return "La contraseña es demasiado débil. Usa al menos 8 caracteres.";
  if (e instanceof FirebaseError && e.code.startsWith("functions/")) return "La cuenta se creó, pero no pudimos completar tu registro. Inténtalo de nuevo en unos segundos.";
  // Same message whatever field is wrong, so the form does not reveal which accounts exist.
  return "El correo o la contraseña no son correctos. Revisa los datos e inténtalo de nuevo.";
}

/** The presentation of screen 1, on ink: what the app does, in three points. Also used by «Completa tu registro». */
export function AuthBrand() {
  return (
    <section className="auth-brand" aria-label="Presentación">
      <p className="brand-line">Proyecto de tesis · UPC</p>
      <div className="auth-intro">
        <h1 className="auth-title">Detección temprana de anomalías en perros</h1>
        <p className="auth-lead">Sigue la actividad, la frecuencia cardiaca y la temperatura de tus perros, y recibe un aviso cuando algo se aleje de su patrón normal.</p>
      </div>
      <ul className="auth-points">
        <li><Icon name="check-circle" size={16} /><span>Un estado claro para cada perro: <strong>Todo normal</strong>, <strong>Atención</strong> o <strong>Revisar</strong>.</span></li>
        <li><Icon name="info" size={16} /><span>Cada alerta explica qué cambió y qué puedes hacer.</span></li>
        <li><Icon name="stethoscope" size={16} /><span>Un resumen técnico para mostrarle a tu veterinario.</span></li>
      </ul>
    </section>
  );
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { user, role, loading, refreshRole } = useAuth();
  usePageTitle(mode === "login" ? "Iniciar sesión" : mode === "registro" ? "Crear cuenta" : "Recuperar contraseña");
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  // Right after «Borrar mi cuenta». Read once, then forgotten, so a reload does not repeat it.
  const [deleted] = useState(accountJustDeleted);
  useEffect(() => { if (deleted) clearAccountDeleted(); }, [deleted]);

  const [f, setF] = useState({ name: "", email: "", password: "", consent: false });
  const [touched, setTouched] = useState(false);
  const [submits, setSubmits] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [lastMode, setLastMode] = useState(mode);
  if (lastMode !== mode) { setLastMode(mode); setTouched(false); setMsg(null); }
  // After a submit with mistakes, the first field to fix gets the focus (its message is read with it).
  useEffect(() => { if (submits) document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus(); }, [submits]);

  if (!loading && user && role && !busy) return <Navigate to={landingFor(role, from)} replace />;
  if (!loading && user && !role && !busy && mode !== "recuperar") return <Navigate to="/acceso/completar" replace />;

  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const errors: Partial<Record<keyof typeof f, string>> = {};
  if (mode === "login") {
    // Signing in only points out what is missing; a wrong email or password gets one message from the server check.
    if (!f.email.trim()) errors.email = "Escribe tu correo.";
    if (!f.password) errors.password = "Escribe tu contraseña.";
  } else if (!EMAIL_RE.test(f.email.trim())) errors.email = "Escribe un correo válido, por ejemplo nombre@correo.com.";
  if (mode === "registro") {
    if (!f.name.trim()) errors.name = "Escribe tu nombre.";
    if (f.password.length < 8) errors.password = "Usa al menos 8 caracteres.";
    if (!f.consent) errors.consent = "Necesitamos tu autorización para tratar tus datos.";
  }
  const shown = (k: keyof typeof f) => (touched ? errors[k] : undefined);
  const err = (k: keyof typeof f) => shown(k) && <div className="field-error" id={`a-${k}-err`}><Icon name="alert-triangle" size={13} />{shown(k)}</div>;
  const inv = (k: keyof typeof f, hint?: string) => {
    const ids = [hint, shown(k) ? `a-${k}-err` : null].filter(Boolean).join(" ");
    return { ...(shown(k) ? { "aria-invalid": true } : {}), ...(ids ? { "aria-describedby": ids } : {}) };
  };
  const name = f.name.trim().slice(0, NAME_MAX);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setMsg(null);
    const email = f.email.trim().toLowerCase();
    if (Object.keys(errors).length) { setSubmits((n) => n + 1); return; }

    setBusy(true);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, f.password);
        const r = await refreshRole();
        navigate(r ? landingFor(r, from) : "/acceso/completar", { replace: true });
      } else if (mode === "registro") {
        const cred = await createUserWithEmailAndPassword(auth, email, f.password);
        await updateProfile(cred.user, { displayName: name });
        const r = await completeSignUp(name, refreshRole);
        navigate(r ? "/" : "/acceso/completar", { replace: true });
      } else {
        // Firebase does not reveal whether the account exists; the message says the same.
        await sendPasswordResetEmail(auth, email).catch((x) => { if (x instanceof FirebaseError && x.code === "auth/network-request-failed") throw x; });
        setMsg({ kind: "ok", text: "Si el correo está registrado, te enviaremos un enlace para crear una nueva contraseña." });
      }
    } catch (x) {
      setMsg({ kind: "error", text: authErrorText(x, mode) });
      if (mode === "registro" && auth.currentUser) navigate("/acceso/completar", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <EmulatorBanner />
      <main className="auth" id="main">
        <AuthBrand />
        <section className="auth-form" aria-label="Formulario de acceso">
          <div className="auth-card">
            {mode === "recuperar" ? <h2 className="section-title auth-card-title">Recuperar contraseña</h2> : (
              <nav className="tabs" aria-label="Acceso">
                <Link aria-current={mode === "login" ? "page" : undefined} to="/acceso">Iniciar sesión</Link>
                <Link aria-current={mode === "registro" ? "page" : undefined} to="/acceso/registro">Crear cuenta</Link>
              </nav>
            )}
            <form className="stack-sm" onSubmit={onSubmit} noValidate aria-busy={busy}>
              {msg ? <Callout kind={msg.kind}>{msg.text}</Callout> : deleted && <Callout kind="ok">Borramos tu cuenta y todos sus datos.</Callout>}
              {mode === "registro" && (
                <div className="field"><label htmlFor="a-name">Nombre y apellido</label>
                  <input id="a-name" className="input" autoComplete="name" maxLength={NAME_MAX} aria-required="true" value={f.name} onChange={set("name")} {...inv("name")} />{err("name")}</div>
              )}
              <div className="field"><label htmlFor="a-email">Correo electrónico</label>
                <input id="a-email" className="input" type="email" autoComplete="email" aria-required="true" value={f.email} onChange={set("email")} {...inv("email")} />{err("email")}</div>
              {mode !== "recuperar" && (
                <div className="field"><label htmlFor="a-pass">Contraseña</label>
                  {/* One message about the length: the hint, or the error in its place. */}
                  <input id="a-pass" className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"}
                    aria-required="true" value={f.password} onChange={set("password")} {...inv("password", mode === "registro" && !shown("password") ? "a-password-hint" : undefined)} />
                  {mode === "registro" && !shown("password") && <div className="field-hint" id="a-password-hint">Usa al menos 8 caracteres.</div>}{err("password")}</div>
              )}
              {mode === "registro" && (
                <div><label className="check"><input type="checkbox" checked={f.consent} onChange={set("consent")} {...inv("consent")} />
                  <span>Autorizo el tratamiento de mis datos personales conforme a la Ley N.° 29733, de Protección de Datos Personales.</span></label>{err("consent")}</div>
              )}
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? "Un momento…" : mode === "login" ? "Iniciar sesión" : mode === "registro" ? "Crear cuenta" : "Enviar enlace"}
              </button>
              {mode === "login" && <Link to="/acceso/recuperar" className="small auth-link">¿Olvidaste tu contraseña?</Link>}
              {mode === "recuperar" && <Link to="/acceso" className="small auth-link"><Icon name="chevron-left" size={14} /> Volver a iniciar sesión</Link>}
            </form>
            <Notice />
            {usingEmulators && mode === "login" && (
              <div className="well auth-demo">
                <div className="kicker">Emuladores · cuentas de demostración</div>
                <div className="row">
                  {DEMO_ACCOUNTS.map((a) => (
                    <button key={a.email} className="btn btn-secondary btn-sm" type="button"
                      onClick={() => setF({ ...f, email: a.email, password: DEMO_PASSWORD })}>{a.label}</button>
                  ))}
                </div>
                <p className="xs muted">Completa el formulario con una cuenta creada por <code>npm run emulators:seed</code>.</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
