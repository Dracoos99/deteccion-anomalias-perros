import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { EmulatorBanner, Icon, NOTICE_TEXT, OfflineBanner } from "./ui";

/** Owner navigation: the same three sections for every account; no role is ever shown.
 * The research tools (/admin) are reached from Perfil, only by admin accounts. */
const NAV = [
  { to: "/", label: "Inicio", icon: "home", end: true },
  { to: "/alertas", label: "Alertas", icon: "bell", end: false },
  { to: "/perfil", label: "Perfil", icon: "user", end: false },
];

/** Masthead with the navigation and a bottom tab bar on small screens. */
export function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const name = user?.displayName || user?.email || "";
  return (
    <>
      <EmulatorBanner />
      <OfflineBanner />
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <div className="brand-kicker">Proyecto de tesis · UPC</div>
            <Link className="brand-title" to="/">Detección de anomalías en perros</Link>
          </div>
          <div className="masthead-actions">
            <div className="user-chip"><span className="user-chip-name">{name}</span></div>
            <button type="button" className="btn btn-ghost logout-btn" onClick={onLogout}><Icon name="log-out" />Cerrar sesión</button>
          </div>
        </div>
        <nav className="nav" aria-label="Principal"><div className="nav-inner">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className="nav-link"><Icon name={n.icon} />{n.label}</NavLink>)}
        </div></nav>
      </header>
      <Outlet />
      <footer className="footer"><div className="footer-inner">
        <span>Proyecto de tesis · Ingeniería de Sistemas de Información · UPC</span>
        <span>{NOTICE_TEXT}</span>
      </div></footer>
      <nav className="tabbar" aria-label="Secciones">
        {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className="tabbar-link"><Icon name={n.icon} size={20} />{n.label}</NavLink>)}
      </nav>
    </>
  );
}
