/* Which section of the owner navigation (Inicio · Alertas · Perfil) a page belongs to, so a sub-page keeps its
   section marked, as in the v3 mockups: a dog and its vet view under Inicio, an alert under Alertas, the
   dog form and the data upload under Perfil. The research tools (/admin) mark none. */
export type Section = "/" | "/alertas" | "/perfil";

export function sectionOf(pathname: string): Section | null {
  if (pathname.startsWith("/admin")) return null;
  if (pathname.startsWith("/alertas")) return "/alertas";
  if (pathname.startsWith("/perfil") || pathname === "/perros/nuevo" || pathname.endsWith("/editar")) return "/perfil";
  if (pathname === "/" || pathname.startsWith("/perros/")) return "/";
  return null;
}
