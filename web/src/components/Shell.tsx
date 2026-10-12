import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

/** The sections of the top navigation. «Consola Admin» joins them only for the admin account: an owner's
 * page never contains it. No role is ever named. */
const NAV = [
  { to: "/", label: "Inicio", icon: "home" },
  { to: "/perros", label: "Perros", icon: "paw" },
  { to: "/alertas", label: "Alertas", icon: "bell" },
] as const;
const ADMIN_NAV = { to: "/admin", label: "Consola Admin", icon: "flask" } as const;

/** New alerts on «Alertas»: after the label in the top bar, on the icon in the tab bar. Screen readers get the
 * meaning after the label. */
function NavBadge({ count, end = false }: { count: number; end?: boolean }) {
  if (!count) return null;
  return <span className={end ? "nav-badge nav-badge-end" : "nav-badge"} aria-hidden="true">{count > 99 ? "99+" : count}</span>;
}

function NavItems({ linkClass, iconSize, openCount, admin, badgeAtEnd = false }: { linkClass: string; iconSize: number; openCount: number; admin: boolean; badgeAtEnd?: boolean }) {
  const { pathname, search } = useLocation();
  const section = sectionOf(pathname, search);
  const items = admin ? [...NAV, ADMIN_NAV] : NAV;
  return (
    <>
      {items.map((n) => {
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

/** The avatar and its menu: the person's name and mail, «Mi perfil», «Configuración» and «Cerrar sesión». A disclosure
 * (a button that opens a list of links): Escape, a click outside or a navigation close it, and the focus goes back to
 * the button. */
function UserMenu({ name, email, onLogout }: { name: string; email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const initial = (name.trim() || email || "?").charAt(0).toUpperCase();
  const current = (to: string) => (pathname === to ? "page" : undefined);
  return (
    <div className="user-menu" ref={wrap}>
      <button ref={button} type="button" className="user-menu-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <span className="user-avatar" aria-hidden="true">{initial}</span>
        <span className="user-menu-name">{name || email}</span>
        <Icon name="chevron-down" size={14} />
        <span className="sr-only">Menú de la cuenta</span>
      </button>
      {open && (
        <div className="user-menu-panel appear" id={panelId}>
          <div className="user-menu-head">
            <strong>{name || email}</strong>
            {name && <span>{email}</span>}
          </div>
          <Link className="user-menu-item" to="/perfil" aria-current={current("/perfil")}><Icon name="user" size={16} />Mi perfil</Link>
          <Link className="user-menu-item" to="/configuracion" aria-current={current("/configuracion")}><Icon name="sliders" size={16} />Configuración</Link>
          <div className="user-menu-sep" role="separator" />
          <button type="button" className="user-menu-item" onClick={onLogout}><Icon name="log-out" size={16} />Cerrar sesión</button>
        </div>
      )}
    </div>
  );
}

/** The frame of every page: a dark top bar fixed to the top, with the name of the system, the sections and the
 * account menu; on phones the sections go to a floating tab bar at the bottom. The content below it is centred. */
export function Shell() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { data: openAll } = useOpenAlerts({ uid: user!.uid, isAdmin });
  // An archived dog («Quitar perro») leaves the count too; its alerts stay in its history.
  const { data: dogs, loading: dogsLoading } = useDogs(isAdmin ? { kind: "all" } : { kind: "owner", uid: user!.uid });
  const open = dogsLoading ? openAll : openAll.filter((a) => dogs.some((d) => d.id === a.dogId));
  const onLogout = async () => { await logout(); navigate("/acceso", { replace: true }); };
  const name = user?.displayName || "";
  const email = user?.email || "";
  const contentRef = useRef<HTMLDivElement | null>(null);
  const announce = useNavigationEffects(contentRef);
  return (
    <>
      <EmulatorBanner />
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="topbar-brand" to="/" aria-label="Detección de anomalías, tesis UPC: ir al inicio">
            <span className="topbar-name">Detección de anomalías</span>
            <span className="topbar-badge">Tesis UPC</span>
          </Link>
          <nav className="topbar-nav" aria-label="Principal">
            <NavItems linkClass="topbar-link" iconSize={16} openCount={open.length} admin={isAdmin} badgeAtEnd />
          </nav>
          <UserMenu name={name} email={email} onLogout={onLogout} />
        </div>
      </header>
      <OfflineBanner />
      <div className="page-content" ref={contentRef} tabIndex={-1}><Outlet /></div>
      <p className="sr-only" role="status">{announce}</p>
      <footer className="footer"><div className="footer-inner">
        <span>Proyecto de tesis · Ingeniería de Sistemas de Información · UPC</span>
        <span className="footer-notice">{NOTICE_TEXT}</span>
      </div></footer>
      <nav className="tabbar" aria-label="Secciones" style={{ "--tabs": isAdmin ? 4 : 3 } as React.CSSProperties}>
        <NavItems linkClass="tabbar-link" iconSize={20} openCount={open.length} admin={isAdmin} />
      </nav>
    </>
  );
}
