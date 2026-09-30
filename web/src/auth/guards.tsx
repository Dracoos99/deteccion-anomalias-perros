import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

/** Client-side gates. The real enforcement is in firestore.rules; these only avoid showing empty screens. */

/** Any account that finished sign-up. */
export function RequireAccount({ children }: { children: ReactNode }) {
  const { user, role, loading, loggedOut } = useAuth();
  const location = useLocation();
  if (loading) return <div className="boot">Cargando…</div>;
  if (!user) return <Navigate to="/acceso" replace state={loggedOut ? null : { from: location.pathname }} />;
  if (!role) return <Navigate to="/acceso/completar" replace />;
  return <>{children}</>;
}

/** Research tools: a non-admin account is sent to Inicio without any message, so the route stays unseen. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <div className="boot">Cargando…</div>;
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}
