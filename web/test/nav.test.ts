import { describe, expect, it } from "vitest";
import { consoleTabOf, sectionOf } from "../src/lib/nav";

describe("sectionOf", () => {
  it("marks the section of each page of the top navigation", () => {
    expect(sectionOf("/")).toBe("/");
    expect(sectionOf("/perros")).toBe("/perros");
    expect(sectionOf("/perros/rocky")).toBe("/perros");
    expect(sectionOf("/perros/rocky/veterinario")).toBe("/perros");
    expect(sectionOf("/perros/nuevo")).toBe("/perros");
    expect(sectionOf("/perros/rocky/editar")).toBe("/perros");
    expect(sectionOf("/perfil/datos")).toBe("/perros");
    expect(sectionOf("/alertas")).toBe("/alertas");
    expect(sectionOf("/alertas/abc123")).toBe("/alertas");
  });

  it("keeps the first-use guide's pages under Inicio", () => {
    expect(sectionOf("/perros/nuevo", "?desde=inicio")).toBe("/");
    expect(sectionOf("/perfil/datos", "?perro=nina&desde=inicio")).toBe("/");
    expect(sectionOf("/perfil/datos", "?perro=nina")).toBe("/perros");
    expect(sectionOf("/perros/rocky/editar", "?desde=inicio")).toBe("/perros");
  });

  it("puts the console and the account pages in their own sections", () => {
    expect(sectionOf("/admin")).toBe("/admin");
    expect(sectionOf("/admin/configuracion")).toBe("/admin");
    expect(sectionOf("/admin/ingesta")).toBe("/admin");
    expect(sectionOf("/perfil")).toBe("/cuenta");
    expect(sectionOf("/configuracion")).toBe("/cuenta");
    expect(sectionOf("/veterinario")).toBeNull();
  });
});

describe("consoleTabOf", () => {
  it("puts each research page in its tab of the console", () => {
    expect(consoleTabOf("/admin")).toBe("simulador");
    expect(consoleTabOf("/admin/configuracion")).toBe("simulador");
    expect(consoleTabOf("/admin/ingesta")).toBe("ingesta");
    expect(consoleTabOf("/admin/revision")).toBe("revision");
  });
});
