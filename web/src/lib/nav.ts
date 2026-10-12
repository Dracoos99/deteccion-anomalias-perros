/* Which section of the top navigation a page belongs to, so a sub-page keeps its section marked:
   Inicio, Perros (the list, a dog and its pages, the dog form and the data upload), Alertas, the Consola Admin (only for
   the admin account) and the account (Mi perfil and Configuración, reached from the avatar menu). The dog form and the
   data upload opened from the first-use guide of Inicio carry `?desde=inicio` and stay under Inicio. */
export type Section = "/" | "/perros" | "/alertas" | "/admin" | "/cuenta";

/** The query that says a page was opened from Inicio. */
export const FROM_HOME = "desde=inicio";
export const fromHome = (search: string) => new URLSearchParams(search).get("desde") === "inicio";

export function sectionOf(pathname: string, search = ""): Section | null {
  if (pathname.startsWith("/admin")) return "/admin";
  if (pathname.startsWith("/alertas")) return "/alertas";
  if ((pathname === "/perros/nuevo" || pathname === "/perfil/datos") && fromHome(search)) return "/";
  if (pathname === "/perfil/datos" || pathname === "/perros" || pathname.startsWith("/perros/")) return "/perros";
  if (pathname.startsWith("/perfil") || pathname.startsWith("/configuracion")) return "/cuenta";
  if (pathname === "/") return "/";
  return null;
}

/** The tab of the Consola Admin a research page belongs to: «Ingesta CSV», «Simulador & IA» (the simulator and the
 * models and configuration) or «Revisión experta». */
export type ConsoleTab = "ingesta" | "simulador" | "revision";

export function consoleTabOf(pathname: string): ConsoleTab {
  if (pathname.startsWith("/admin/ingesta")) return "ingesta";
  if (pathname.startsWith("/admin/revision")) return "revision";
  return "simulador";
}
