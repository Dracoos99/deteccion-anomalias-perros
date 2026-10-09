/* Which section of the owner navigation (Inicio · Alertas · Perfil) a page belongs to, so a sub-page keeps its
   section marked, as in the v3 mockups: a dog and its vet view under Inicio, an alert under Alertas, the
   dog form and the data upload under Perfil. The research tools (/admin) mark none. The dog form and
   the data upload opened from the first-use guide of Inicio carry `?desde=inicio` and stay under Inicio. */
export type Section = "/" | "/alertas" | "/perfil";

/** The query that says a page was opened from Inicio. */
export const FROM_HOME = "desde=inicio";
export const fromHome = (search: string) => new URLSearchParams(search).get("desde") === "inicio";

export function sectionOf(pathname: string, search = ""): Section | null {
  if (pathname.startsWith("/admin")) return null;
  if (pathname.startsWith("/alertas")) return "/alertas";
  if ((pathname === "/perros/nuevo" || pathname === "/perfil/datos") && fromHome(search)) return "/";
  if (pathname.startsWith("/perfil") || pathname === "/perros/nuevo" || pathname.endsWith("/editar")) return "/perfil";
  if (pathname === "/" || pathname.startsWith("/perros/")) return "/";
  return null;
}
