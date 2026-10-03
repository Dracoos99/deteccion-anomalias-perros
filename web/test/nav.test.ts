import { describe, expect, it } from "vitest";
import { sectionOf } from "../src/lib/nav";

describe("sectionOf", () => {
  it("marks the section of each owner page", () => {
    expect(sectionOf("/")).toBe("/");
    expect(sectionOf("/perros/rocky")).toBe("/");
    expect(sectionOf("/perros/rocky/veterinario")).toBe("/");
    expect(sectionOf("/alertas")).toBe("/alertas");
    expect(sectionOf("/alertas/abc123")).toBe("/alertas");
    expect(sectionOf("/perfil")).toBe("/perfil");
    expect(sectionOf("/perfil/datos")).toBe("/perfil");
    expect(sectionOf("/perros/nuevo")).toBe("/perfil");
    expect(sectionOf("/perros/rocky/editar")).toBe("/perfil");
  });

  it("marks no section for the research tools or unknown pages", () => {
    expect(sectionOf("/admin")).toBeNull();
    expect(sectionOf("/admin/configuracion")).toBeNull();
    expect(sectionOf("/veterinario")).toBeNull();
  });
});
