/* Completes a sign-up whose profile could not be saved (e.g. the Functions emulator was off). Second half of screen 1:
   the same presentation on ink and the form on paper. */
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { completeSignUp } from "../auth/signup";
import { Callout, EmulatorBanner, Icon, usePageTitle } from "../components/ui";
import { usingEmulators } from "../firebase";
import { AuthBrand } from "./AuthPage";

const NAME_MAX = 80;   // the limit setInitialRole keeps

export function CompleteProfile() {
  const { user, role, loading, refreshRole, logout } = useAuth();
  usePageTitle("Completa tu perfil");
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? "");
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submits, setSubmits] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a submit with mistakes, the first field to fix gets the focus (its message is read with it).
  useEffect(() => { if (submits) document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus(); }, [submits]);

  if (loading) return <div className="boot">Cargando…</div>;
  if (!user) return <Navigate to="/acceso" replace />;
  if (role) return <Navigate to="/" replace />;

  const errors: { name?: string; consent?: string } = {};
  if (!name.trim()) errors.name = "Escribe tu nombre.";
  if (!consent) errors.consent = "Necesitamos tu autorización para tratar tus datos.";
  const shown = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  const err = (k: keyof typeof errors) => shown(k) && <div className="field-error" id={`r-${k}-err`}><Icon name="alert-triangle" size={13} />{shown(k)}</div>;
  const inv = (k: keyof typeof errors) => (shown(k) ? { "aria-invalid": true, "aria-describedby": `r-${k}-err` } : {});

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) { setSubmits((n) => n + 1); return; }
    setBusy(true); setError(null);
    try {
      if (await completeSignUp(name.trim().slice(0, NAME_MAX), refreshRole)) navigate("/", { replace: true });
    } catch {
      setError("No pudimos completar tu registro. Revisa tu conexión e inténtalo de nuevo." + (usingEmulators ? " Con emuladores: revisa que estén encendidos." : ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <EmulatorBanner />
      <main className="auth" id="main">
        <AuthBrand />
        <section className="auth-form" aria-labelledby="r-title">
          <div className="auth-card">
        <div className="auth-card-title">
          <div className="kicker">Crear cuenta</div>
          <h2 className="section-title" id="r-title">Completa tu registro</h2>
          <p className="small muted">Sesión iniciada como {user.email}. Falta un paso para empezar.</p>
        </div>
        <form className="stack-sm" onSubmit={onSubmit} noValidate aria-busy={busy}>
          {error && <Callout kind="error">{error}</Callout>}
          <div className="field"><label htmlFor="r-name">Nombre y apellido</label>
            <input id="r-name" className="input" autoComplete="name" maxLength={NAME_MAX} aria-required="true" value={name} onChange={(e) => setName(e.target.value)} {...inv("name")} />{err("name")}</div>
          <div><label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} {...inv("consent")} />
            <span>Autorizo el tratamiento de mis datos personales conforme a la Ley N.° 29733, de Protección de Datos Personales.</span></label>{err("consent")}</div>
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>{busy ? "Un momento…" : "Continuar"}</button>
          <button className="btn btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={() => logout()}><Icon name="log-out" />Cerrar sesión</button>
        </form>
          </div>
        </section>
      </main>
    </div>
  );
}
