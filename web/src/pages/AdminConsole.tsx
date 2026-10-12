/* Consola Admin: the research tools of the thesis behind one entry of the top bar, only for the admin
   account (RequireAdmin; an owner never sees the entry nor downloads this code). Three tabs, each with its own address:
   «Ingesta CSV» (a file into any dog: the page of the owner's «Cargar datos»), «Simulador & IA» (the simulator, A1, and
   the models and fusion configuration, A2) and «Revisión experta» (A3). The pages inside drop their own <main>, crumbs
   and page title (InConsole): the console gives them. */
import { Suspense } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Icon, InConsole, PageHead, PageLoading } from "../components/ui";
import { consoleTabOf, type ConsoleTab } from "../lib/nav";

const TABS: { id: ConsoleTab; to: string; label: string; icon: string }[] = [
  { id: "ingesta", to: "/admin/ingesta", label: "Ingesta CSV", icon: "upload" },
  { id: "simulador", to: "/admin", label: "Simulador & IA", icon: "play" },
  { id: "revision", to: "/admin/revision", label: "Revisión experta", icon: "check-circle" },
];

/** The two pages of «Simulador & IA». */
const SIM_VIEWS = [
  { to: "/admin", label: "Simulador" },
  { to: "/admin/configuracion", label: "Modelos y configuración" },
];

export function AdminConsole() {
  const { pathname } = useLocation();
  const tab = consoleTabOf(pathname);
  return (
    <main className="page page-admin console" id="main">
      <PageHead title="Consola Admin" sub="Herramientas de investigación de la tesis: carga de datos, simulador, modelos y revisión experta." />
      <nav className="tabs console-tabs" aria-label="Herramientas de la consola">
        {TABS.map((t) => (
          <Link key={t.id} to={t.to} aria-current={tab === t.id ? "page" : undefined}><Icon name={t.icon} size={14} />{t.label}</Link>
        ))}
      </nav>
      {tab === "simulador" && (
        <nav className="seg console-sub" aria-label="Simulador & IA">
          {SIM_VIEWS.map((v) => <Link key={v.to} to={v.to} aria-current={pathname === v.to ? "page" : undefined}>{v.label}</Link>)}
        </nav>
      )}
      <InConsole.Provider value={true}>
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </InConsole.Provider>
    </main>
  );
}
