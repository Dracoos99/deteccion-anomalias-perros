import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useOpenAlerts } from "../data/hooks";
import { sectionOf } from "../lib/nav";
import { EmulatorBanner, Icon, NOTICE_TEXT, OfflineBanner } from "./ui";

/** Owner navigation: the same three sections for every account; no role is ever shown.
 * The research tools (/admin) are reached from Perfil, only by admin accounts. */
const NAV = [
  { to: "/", label: "Inicio", icon: "home" },
  { to: "/alertas", label: "Alertas", icon: "bell" },
  { to: "/perfil", label: "Perfil", icon: "user" },
];

/** Unreviewed alerts on "Alertas": on the icon in the tab bar, after the label in the side column and the masthead
 * row. Screen readers get the meaning after the label (see NavItems). */
function NavBadge({ count, end = false }: { count: number; end?: boolean }) {
  if (!count) return null;
  return <span className={end ? "nav-badge nav-badge-end" : "nav-badge"} aria-hidden="true">{count > 99 ? "99+" : count}</span>;
}

function NavItems({ linkClass, iconSize, openCount, badgeAtEnd = false }: { linkClass: string; iconSize: number; openCount: number; badgeAtEnd?: boolean }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  return (
    <>
      {NAV.map((n) => {
        const count = n.to === "/alertas" ? openCount : 0;
        // "page" for the section's own page, "true" for a page inside it.
        const current = pathname === n.to ? "page" : section === n.to ? "true" : undefined;
        return (
          <Link key={n.to} to={n.to} className={linkClass} aria-current={current}>
            <span className="nav-icon"><Icon name={n.icon} size={iconSize} />{!badgeAtEnd && <NavBadge count={count} />}</span>
            <span className="nav-label">{n.label}</span>
            {badgeAtEnd && <NavBadge count={count} end />}
            {count > 0 && <span className="sr-only">, {count} sin revisar</span>}
          </Link>
        );
      })}
    </>
  );
}

/** Three layouts of the same navigation: a side column on wide screens, the masthead with its tab row on
 * medium ones and a bottom tab bar on phones. */
export function Shell() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { data: open } = useOpenAlerts({ uid: user!.uid, isAdmin });
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const name = user?.displayName || user?.email || "";
  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-kicker">Proyecto de tesis · UPC</div>
            <Link className="brand-title" to="/">Detección de anomalías en perros</Link>
          </div>
          <nav className="sidebar-nav" aria-label="Principal">
            <NavItems linkClass="side-link" iconSize={16} openCount={open.length} badgeAtEnd />
          </nav>
          <div className="sidebar-foot">
            <div className="sidebar-user" title={user?.email ?? undefined}>
              <span className="sidebar-user-name">{name}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm logout-btn" onClick={onLogout}><Icon name="log-out" size={14} />Cerrar sesión</button>
          </div>
        </aside>
        <div className="shell-main">
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
                <button type="button" className="btn btn-ghost btn-sm logout-btn" onClick={onLogout}><Icon name="log-out" size={14} />Cerrar sesión</button>
              </div>
            </div>
            <nav className="nav" aria-label="Principal"><div className="nav-inner">
              <NavItems linkClass="nav-link" iconSize={16} openCount={open.length} badgeAtEnd />
            </div></nav>
          </header>
          <Outlet />
          <footer className="footer"><div className="footer-inner">
            <span>Proyecto de tesis · Ingeniería de Sistemas de Información · UPC</span>
            <span>{NOTICE_TEXT}</span>
          </div></footer>
        </div>
      </div>
      <nav className="tabbar" aria-label="Secciones">
        <NavItems linkClass="tabbar-link" iconSize={20} openCount={open.length} />
      </nav>
    </>
  );
}
