/* Completes a sign-up whose profile could not be saved (e.g. the Functions emulator was off). Second half of screen 1:
   the same presentation on ink and the form on paper. */
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { completeSignUp } from "../auth/signup";
import { Callout, EmulatorBanner, Icon, usePageTitle } from "../components/ui";
import { AuthBrand } from "./AuthPage";

export function CompleteProfile() {
  const { user, role, loading, refreshRole, logout } = useAuth();
  usePageTitle("Completa tu perfil");
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? "");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <div className="boot">Cargando…</div>;
  if (!user) return <Navigate to="/acceso" replace />;
  if (role) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("Escribe tu nombre."); return; }
    if (!consent) { setError("Necesitamos tu autorización para tratar tus datos."); return; }
    setBusy(true); setError(null);
    try {
      if (await completeSignUp(name.trim(), refreshRole)) navigate("/", { replace: true });
    } catch {
      setError("No pudimos completar tu registro. Revisa tu conexión (o que los emuladores estén encendidos) e inténtalo de nuevo.");
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
            <input id="r-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Autorizo el tratamiento de mis datos personales conforme a la Ley N.° 29733, de Protección de Datos Personales.</span></label>
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>{busy ? "Un momento…" : "Continuar"}</button>
          <button className="btn btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={() => logout()}><Icon name="log-out" />Cerrar sesión</button>
        </form>
          </div>
        </section>
      </main>
    </div>
  );
}
