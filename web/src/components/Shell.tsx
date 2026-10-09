import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useDogs, useOpenAlerts } from "../data/hooks";
import { sectionOf } from "../lib/nav";
import { EmulatorBanner, Icon, NOTICE_TEXT, OfflineBanner } from "./ui";

/** Scroll offset of each visited page, by history entry. */
const scrollByKey = new Map<string, number>();

/** Moving between pages: a new page opens at its top and Back returns to where the owner was (re-applied while the
 * page's data arrive, for up to 3 s or until the owner scrolls); focus moves to the content and the page's name is
 * announced, instead of staying on <body>. No page transition: navigation is frequent. */
function useNavigationEffects(contentRef: React.RefObject<HTMLDivElement | null>): string {
  const location = useLocation();
  const navType = useNavigationType();
  const keyRef = useRef(location.key);
  keyRef.current = location.key;
  const first = useRef(true);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    window.history.scrollRestoration = "manual";
    const save = () => scrollByKey.set(keyRef.current, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => window.removeEventListener("scroll", save);
  }, []);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    let stop = () => {};
    if (navType !== "POP") window.scrollTo(0, 0);
    else {
      const target = scrollByKey.get(location.key) ?? 0;
      const ro = new ResizeObserver(() => apply());
      const timer = window.setTimeout(() => stop(), 3000);
      stop = () => {
        ro.disconnect(); window.clearTimeout(timer);
        window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); window.removeEventListener("keydown", stop);
      };
      const apply = () => {
        if (document.documentElement.scrollHeight - window.innerHeight >= target) { window.scrollTo(0, target); stop(); }
      };
      ro.observe(document.body);
      window.addEventListener("wheel", stop, { passive: true });
      window.addEventListener("touchstart", stop, { passive: true });
      window.addEventListener("keydown", stop);
      apply();
    }
    contentRef.current?.focus({ preventScroll: true });
    // The page sets its title once its data arrive; announce it a moment later, without the app's name.
    const t = window.setTimeout(() => setAnnounce(document.title.split(" · ")[0]), 600);
    return () => { stop(); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  return announce;
}

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
  const { pathname, search } = useLocation();
  const section = sectionOf(pathname, search);
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
            {count > 0 && <span className="sr-only">, {count} {count === 1 ? "nueva" : "nuevas"}</span>}
          </Link>
        );
      })}
    </>
  );
}

/** Three layouts of the same navigation: a side column on wide screens, the masthead with its tab row on
 * medium ones and a bottom tab bar on phones; all three drawn as the dark environment around the content.
 * The project line goes under the name, not above it. */
export function Shell() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { data: openAll } = useOpenAlerts({ uid: user!.uid, isAdmin });
  // An archived dog («Quitar perro») leaves the count too; its alerts stay in its history.
  const { data: dogs, loading: dogsLoading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const open = dogsLoading ? openAll : openAll.filter((a) => dogs.some((d) => d.id === a.dogId));
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const name = user?.displayName || user?.email || "";
  const contentRef = useRef<HTMLDivElement | null>(null);
  const announce = useNavigationEffects(contentRef);
  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <Link className="brand-title" to="/">Detección de anomalías en perros</Link>
            <div className="brand-kicker">Proyecto de tesis · UPC</div>
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
                <Link className="brand-title" to="/">Detección de anomalías en perros</Link>
                <div className="brand-kicker">Proyecto de tesis · UPC</div>
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
          <div className="page-content" ref={contentRef} tabIndex={-1}><Outlet /></div>
          <p className="sr-only" role="status">{announce}</p>
          <footer className="footer"><div className="footer-inner">
            <span>Proyecto de tesis · Ingeniería de Sistemas de Información · UPC</span>
            <span className="footer-notice">{NOTICE_TEXT}</span>
          </div></footer>
        </div>
      </div>
      <nav className="tabbar" aria-label="Secciones">
        <NavItems linkClass="tabbar-link" iconSize={20} openCount={open.length} />
      </nav>
    </>
  );
}
