// Smoke test of the web app against the local emulators.
// Needs: npm run emulators, npm run emulators:seed and the web dev server (cd web && npm run dev).
// Usage: npm run test:e2e   (EDGE_PATH and BASE_URL can be overridden; screenshots go to tests/e2e/shots/, gitignored)
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:5180";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "shots");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const errors = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTICE = "Detecta cambios respecto al patrón normal de tu perro. No diagnostica ni reemplaza la evaluación veterinaria.";
// No role is ever shown to the person: none of these words may appear in the interface.
const ROLE_WORDS = ["Propietario", "Propietaria", "Administrador", "Médico veterinario", "Veterinario:", "Rol "];

let browser, page;
/** A fresh browser profile. The Firestore emulator speaks HTTP/1.1: the long-lived connections left by earlier
 * sessions can exhaust the browser's per-host limit (6) and leave new writes queued. Production uses HTTP/2. */
async function openBrowser() {
  if (browser) await browser.close();
  browser = await puppeteer.launch({
    executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", userDataDir: path.join(os.tmpdir(), "edge-e2e-web-" + Date.now()),
  });
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
}
await openBrowser();

const path_ = () => new URL(page.url()).pathname;
const waitPath = async (p, t = 15000) => { try { await page.waitForFunction((x) => location.pathname === x, { timeout: t }, p); return true; } catch { return false; } };
const text = () => page.evaluate(() => document.body.innerText);
const waitText = (needle, t = 10000) => page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: t }, needle).then(() => true, () => false);
const noRoleWords = async () => { const t = await text(); return ROLE_WORDS.filter((w) => t.includes(w)); };
const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true }); };
/** «Cerrar sesión» is in the account menu of the top bar (and at the foot of Mi perfil). */
const openUserMenu = async () => {
  if (!(await page.$(".user-menu-panel"))) await page.click(".user-menu-button");
  return page.waitForSelector(".user-menu-panel", { visible: true, timeout: 5000 }).then(() => true, () => false);
};
const logout = async () => {
  await openUserMenu();
  await page.click(".user-menu-panel button");
  await waitPath("/acceso");
};
/** Navigate inside the app, as a person following links does: no reload, so the emulator's HTTP/1.1 connections
 * (6 per host) are not used up by new Firestore channels on every page. */
const spaGo = async (p) => {
  await page.evaluate((x) => { history.pushState({}, "", x); dispatchEvent(new PopStateEvent("popstate")); }, p);
  await sleep(1200);
};
/** No horizontal scroll at the current width (a phone must never scroll sideways). */
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const login = async (email, password = "demo-1234") => {
  await page.goto(BASE + "/acceso", { waitUntil: "load" });
  await page.waitForSelector("#a-email");
  await page.type("#a-email", email); await page.type("#a-pass", password);
  await page.click("button[type=submit]");
};
const navLabels = (selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));

// 1. Guard: unauthenticated users go to /acceso
await page.goto(BASE + "/", { waitUntil: "load" });
check("unauthenticated / redirects to /acceso", await waitPath("/acceso"));
await shot("01-acceso-1440");

// 2. Wrong password shows the generic message
await login("lucia.paredes@example.com", "wrong-pass");
await page.waitForSelector(".callout-error", { timeout: 10000 }).catch(() => {});
check("wrong password shows generic error", (await text()).includes("El correo o la contraseña no son correctos"));

// 3. Owner: Inicio as a dashboard, fixed notice, the top bar with three sections and the account menu, no roles anywhere
await login("lucia.paredes@example.com");
check("owner lands on Inicio (/)", await waitPath("/"));
await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
const ownerDogs = await page.$$eval(".dog-name", (els) => els.map((e) => e.textContent).sort());
check("owner sees her 3 dogs only", JSON.stringify(ownerDogs) === JSON.stringify(["Luna", "Rocky", "Toby"]), JSON.stringify(ownerDogs));
check("fixed notice with the v3 wording", (await text()).includes(NOTICE));
const kpiLabels = await page.$$eval(".kpi .kpi-label", (els) => els.map((e) => e.textContent.trim()));
check("Inicio opens with four figures: total, normal, active alerts and without data", kpiLabels.length === 4
  && kpiLabels[0] === "Total de perros" && kpiLabels[1] === "En estado normal" && /^Alertas? activas?$/.test(kpiLabels[2]) && kpiLabels[3] === "Sin datos recientes",
  JSON.stringify(kpiLabels));
check("the first figure counts her 3 dogs", await page.$eval(".kpi .kpi-value", (el) => el.textContent.trim()) === "3");
await page.type("#dog-search", "roc");
await sleep(300);
check("the search narrows the cards by name", JSON.stringify(await page.$$eval(".dog-name", (els) => els.map((e) => e.textContent))) === JSON.stringify(["Rocky"]));
await page.focus("#dog-search");
for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
await sleep(300);
check("clearing the search brings every card back", (await page.$$(".dog-card")).length === 3);
check("the state filter offers Todos, En alerta and Sin datos", JSON.stringify(await navLabels(".dash-tools .seg button")) === JSON.stringify(["Todos", "En alerta", "Sin datos"]));
check("wide screens show the top bar Inicio · Perros · Alertas",
  await page.$eval(".topbar-nav", (el) => getComputedStyle(el).display !== "none")
  && JSON.stringify(await navLabels(".topbar-nav .topbar-link .nav-label")) === JSON.stringify(["Inicio", "Perros", "Alertas"]));
check("the top bar names the system without a brand", (await page.$eval(".topbar-brand", (el) => el.innerText)).includes("Detección de anomalías")
  && (await page.$eval(".topbar-brand", (el) => el.innerText)).includes("Tesis UPC"));
await openUserMenu();
const menuText = await page.$eval(".user-menu-panel", (el) => el.innerText);
check("the account menu names the account and offers Mi perfil, Configuración and Cerrar sesión", menuText.includes("Lucía Paredes")
  && menuText.includes("Mi perfil") && menuText.includes("Configuración") && menuText.includes("Cerrar sesión"));
await page.keyboard.press("Escape");
check("Escape closes the account menu and gives the focus back", !(await page.$(".user-menu-panel"))
  && await page.evaluate(() => document.activeElement?.classList.contains("user-menu-button")));
check("no role is shown on Inicio", !(await noRoleWords()).length, (await noRoleWords()).join(", "));
await shot("02-inicio-1440");
await page.setViewport({ width: 390, height: 844 });
check("mobile shows the bottom tab bar with the three sections", await page.$eval(".tabbar", (t) => getComputedStyle(t).display !== "none")
  && JSON.stringify(await navLabels(".tabbar .tabbar-link .nav-label")) === JSON.stringify(["Inicio", "Perros", "Alertas"])
  && await page.$eval(".topbar-nav", (el) => getComputedStyle(el).display === "none"));
const wideOnPhone = [];
for (const p of ["/", "/perros", "/perros/toby", "/alertas", "/alertas?vista=historial", "/perfil", "/configuracion", "/perfil/datos", "/perros/toby/veterinario"]) {
  await spaGo(p);
  if (!(await noSideScroll())) wideOnPhone.push(p);
}
check("no page scrolls sideways on a 390 px phone", !wideOnPhone.length, wideOnPhone.join(", "));
check("the browser tab is named after the page (and the saved PDF too)", (await page.title()).startsWith("Toby · Vista para el veterinario · "));
await spaGo("/perros/toby");
await page.waitForFunction(() => document.body.innerText.includes("Cargar sus datos"), { timeout: 15000 }).catch(() => {});
check("a dog without data shows one next step instead of empty tabs", !(await page.$("[role=tablist]")) && (await text()).includes("Cargar sus datos"),
  `${path_()} · tabs: ${!!(await page.$("[role=tablist]"))} · ${(await text()).replace(/\s+/g, " ").slice(0, 300)}`);
await shot("02-inicio-390");
await page.setViewport({ width: 1440, height: 900 });

// 4. Research tools stay hidden from owners
await spaGo("/admin");
check("owner opening /admin is sent to Inicio without a message", await waitPath("/") && !(await text()).includes("No tienes acceso"));
check("owner pages carry no link to the Consola Admin", !(await page.$("a[href^='/admin']")));
await spaGo("/perfil");
await page.waitForSelector("#p-account", { timeout: 10000 }).catch(() => {});
const profileText = await text();
check("Mi perfil shows the account, the appearance and the credentials only",
  profileText.includes("lucia.paredes@example.com") && profileText.includes("Apariencia") && profileText.includes("Datos de acceso")
  && profileText.includes("Cambiar contraseña") && !profileText.includes("Tus datos") && !profileText.includes("Qué quieres recibir"));
await spaGo("/perros");
await page.waitForSelector(".dog-list li", { timeout: 10000 }).catch(() => {});
check("Perros lists her dogs with their state", (await page.$$(".dog-list li")).length === 3 && (await text()).includes("Cargar datos"));
await spaGo("/alertas");
check("Alertas has two tabs, Activas and Historial",
  JSON.stringify((await navLabels("[role=tab]")).map((t) => t.replace(/\d+$/, ""))) === JSON.stringify(["Activas", "Historial"]));
check("Activas lists alerts by severity or says nothing is active", await page.waitForFunction(() =>
  /Crítico|Advertencia|No hay alertas activas|Todos los sensores están reportando/.test(document.querySelector("#panel-activas")?.innerText ?? ""), { timeout: 10000 }).then(() => true, () => false));
const shown = () => page.evaluate(() => ["#panel-activas", "#panel-historial"].map((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none"; }));
check("only the panel of the chosen tab is shown", JSON.stringify(await shown()) === JSON.stringify([true, false]));
await shot("07-alertas-1440");
await page.click("#tab-historial");
check("Historial shows the audit table or says there is nothing yet", await page.waitForFunction(() => location.search.includes("vista=historial")
  && (!!document.querySelector("#panel-historial .history-table") || document.body.innerText.includes("Todavía no hay alertas registradas")), { timeout: 10000 }).then(() => true, () => false)
  && JSON.stringify(await shown()) === JSON.stringify([false, true]));
await logout();
check("logout returns to /acceso", path_() === "/acceso");

// 5. Admin: same Inicio (all dogs), and the Consola Admin in the top bar, with its three tabs
await login("admin@example.com");
check("admin also lands on Inicio", await waitPath("/"));
await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
check("admin sees every dog on Inicio (the 10 of the seed at least)", (await page.$$(".dog-card")).length >= 10, String((await page.$$(".dog-card")).length));
check("no role is shown to the admin either", !(await noRoleWords()).length, (await noRoleWords()).join(", "));
check("the admin's top bar adds «Consola Admin»", JSON.stringify(await navLabels(".topbar-nav .topbar-link .nav-label")) === JSON.stringify(["Inicio", "Perros", "Alertas", "Consola Admin"]));
await page.click(".topbar-nav a[href='/admin']");
check("the console opens at /admin on «Simulador & IA»", await waitPath("/admin")
  && await page.waitForSelector(".console-tabs a[aria-current=page]", { timeout: 10000 }).then((el) => el.evaluate((a) => a.textContent.trim())).catch(() => "") === "Simulador & IA");
check("the console has the tabs Ingesta CSV, Simulador & IA and Revisión experta",
  JSON.stringify(await navLabels(".console-tabs a")) === JSON.stringify(["Ingesta CSV", "Simulador & IA", "Revisión experta"]));
await page.waitForFunction(() => document.body.innerText.includes("Nueva ejecución"), { timeout: 15000 }).catch(() => {});
const adminText = await text();
check("simulator panel shows config/fusion values", adminText.includes("0.4 · 0.4 · 0.2") && adminText.includes("Health Score < 60"));
check("simulator panel lists runs or offers to create one", adminText.includes("Nueva ejecución") && (adminText.includes("Ejecuciones recientes") || adminText.includes("Todavía no hay ejecuciones")));
await shot("a1-simulador-1440");
await page.click(".console-tabs a[href='/admin/ingesta']");
check("«Ingesta CSV» opens the upload for any dog", await waitPath("/admin/ingesta")
  && !!(await page.waitForSelector("#csv-dog", { timeout: 15000 }).catch(() => null)) && (await page.$$eval("#csv-dog option", (o) => o.length)) >= 10);
await page.click(".console-tabs a[href='/admin/revision']");
check("«Revisión experta» opens the blind review", await waitPath("/admin/revision")
  && await page.waitForFunction(() => document.body.innerText.includes("Acuerdo con el sistema"), { timeout: 15000 }).then(() => true, () => false));
check("the console has one main landmark", (await page.$$("main")).length === 1);
await logout();

await openBrowser();

// 6. Sign-up: no role choice; consent is mandatory; the new account is an owner on an empty Inicio
await page.goto(BASE + "/acceso/registro", { waitUntil: "load" });
await page.waitForSelector("#a-name");
check("sign-up has no role selector", !(await page.$("input[name=role]")) && !(await noRoleWords()).length);
await page.type("#a-name", "Carmen Vidal");
const email = `carmen.vidal.${Date.now()}@example.com`;
await page.type("#a-email", email); await page.type("#a-pass", "clave-segura-1");
await page.click("button[type=submit]");
await sleep(500);
check("sign-up without consent is blocked", (await text()).includes("Necesitamos tu autorización") && path_() === "/acceso/registro");
await shot("01b-registro-error-1440");
await page.click("label.check input[type=checkbox]");
await page.click("button[type=submit]");
check("new account lands on Inicio", await waitPath("/", 20000), path_());
await sleep(1200);
check("new account sees the empty state", (await text()).includes("Todavía no registras perros"));
await shot("02b-inicio-vacio-1440");

// 7. Dog registration and editing (screen 6), and the detail and vet view of a dog without data yet (phase 3)
const clickText = async (tag, label) => {
  const sel = `xpath/.//${tag}[normalize-space(.)='${label}' or contains(., '${label}')]`;
  const el = await page.waitForSelector(sel, { visible: true, timeout: 10000 }).catch(() => null);
  if (!el) throw new Error(`${tag} not found: ${label} — page shows: ${(await text()).replace(/\s+/g, " ").slice(0, 400)}`);
  await el.click();
};
let newDogPath = null;
try {
  await clickText("a", "Registrar a mi perro");
  check("empty Inicio leads to the dog registration", await waitPath("/perros/nuevo"));
  await page.waitForSelector("#d-name");
  await page.click("button[type=submit]"); await sleep(300);
  check("dog form requires a name", (await text()).includes("Escribe el nombre de tu perro."));
  await page.type("#d-name", "Mora"); await page.type("#d-breed", "Mestiza"); await page.type("#d-weight", "12,5");
  await clickText("button", "Hembra");
  await page.click("button[type=submit]");
  const opened = await page.waitForFunction(() => /^\/perros\/(?!nuevo)[^/]+$/.test(location.pathname), { timeout: 10000 }).then(() => true, () => false);
  check("registered dog opens its detail", opened, opened ? "" : (await text()).replace(/\s+/g, " ").slice(300, 900));
  await page.waitForSelector(".dog-state", { timeout: 10000 }).catch(() => {});
  const dogPath = path_();
  newDogPath = dogPath;
  check("detail of a dog without data explains it", (await text()).includes("Todavía no hay datos.") && (await text()).includes("Qué es normal para Mora"));
  await shot("03-detalle-sin-datos-1440");
  await clickText("a", "Editar perfil");
  await page.waitForSelector("#d-name");
  await page.$eval("#d-name", (el) => { el.value = ""; });
  await page.type("#d-name", "Mora Luna");
  await page.click("button[type=submit]");
  check("edited name is saved", await waitPath(dogPath) && await page.waitForFunction(() => document.body.innerText.includes("Mora Luna"), { timeout: 10000 }).then(() => true, () => false));
  await spaGo(dogPath + "/veterinario");
  // The kicker is uppercased by CSS, and innerText returns it transformed: compare case-insensitively.
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("vista para el veterinario"), { timeout: 10000 }).catch(() => {});
  const vetText = await text();
  check("vet view shows the dog's data read-only", vetText.toLowerCase().includes("vista para el veterinario") && vetText.includes("Hembra") && vetText.includes("12.5 kg")
    && vetText.includes("Sin diagnóstico") && vetText.includes("Descargar PDF"));
  await spaGo("/");
  await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
  // A dog without data says it once, in its well.
  check("the new dog appears on Inicio with a plain phrase", (await text()).includes("Mora Luna") && (await text()).includes("Sus datos aparecerán cuando lleguen sus primeras lecturas"));

  // 7b. Phase 5: first-use guide, CSV upload of the example file, and the notifications section.
  check("Inicio guides the owner to load the dog's data (screen 9)", (await text()).includes("Conecta sus datos") && !!(await page.$("a[href^='/perfil/datos']")));
  await clickText("a", "Cargar datos");
  // Pages other than Inicio load on first use: wait for the form, not only for the address.
  check("the guide opens the upload with the dog chosen", await waitPath("/perfil/datos")
    && !!(await page.waitForSelector("#csv-dog", { timeout: 10000 }).catch(() => null))
    && await page.$eval("#csv-dog", (el) => el.options[el.selectedIndex].text.startsWith("Mora Luna")));
  await clickText("button", "Probar con un archivo de ejemplo");
  await page.waitForFunction(() => document.body.innerText.includes("bloques de 10 s"), { timeout: 10000 }).catch(() => {});
  const checkText = await text();
  check("the example file is checked: problems listed, 4 blocks", checkText.includes("Revisión de ejemplo_60s.csv") && checkText.includes("se crearán 4 bloques de 10 s")
    && checkText.includes("Fila 2712") && checkText.includes("cortes"));
  await shot("07-carga-csv-revision-1440");
  // The button names the dog the data go to.
  await clickText("button", "Cargar 4 bloques para Mora Luna");
  const analysed = await page.waitForFunction(() => document.body.innerText.includes("Listo: 4 bloques analizados"), { timeout: 180000 }).then(() => true, () => false);
  check("the 4 blocks are written in order and scored by the Function", analysed, analysed ? "" : (await text()).replace(/\s+/g, " ").slice(0, 600));
  await shot("07b-carga-csv-lista-1440");
  check("the upload is listed as analysed", (await text()).includes("Cargas recientes") && (await text()).includes("Analizada"));
  await spaGo(dogPath);
  // The learning period of the dog, with its stage, under its state.
  const learning = await page.waitForFunction(() => document.body.innerText.includes("Período de aprendizaje") && document.body.innerText.includes("qué es normal para Mora Luna"), { timeout: 15000 }).then(() => true, () => false);
  check("the dog now has data and is learning its normal pattern", learning && (await text()).includes("Estamos aprendiendo su patrón normal"),
    learning ? "" : (await text()).replace(/\s+/g, " ").slice(0, 500));
  if (!learning) await shot("03b-detalle-aprendiendo-fallo-1440");
  await page.waitForSelector("#tabbtn-resumen", { timeout: 10000 }).catch(() => {});
  // Resumen, Su día, Actividad, Corazón…
  await page.focus("#tabbtn-resumen"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  check("the detail tabs move with the arrow keys", await page.evaluate(() => document.activeElement?.id === "tabbtn-corazon"
    && document.getElementById("tabbtn-corazon")?.getAttribute("aria-selected") === "true"));
  check("the browser tab is named after the dog", (await page.title()).startsWith("Mora Luna · "));
  await shot("03b-detalle-aprendiendo-1440");
  await spaGo("/perros");
  await page.waitForSelector(".dog-list li", { timeout: 10000 }).catch(() => {});
  check("Perros lists the new dog and offers the data upload", (await text()).includes("Mora Luna") && !!(await page.$("a[href='/perfil/datos']")));
  // The notices, the app and «Tus datos» moved from Perfil to Configuración, in the account menu.
  await openUserMenu();
  await page.click(".user-menu-panel a[href='/configuracion']");
  await page.waitForFunction(() => document.body.innerText.includes("Qué quieres recibir"), { timeout: 10000 }).catch(() => {});
  check("Configuración offers the notification settings", path_() === "/configuracion" && (await text()).includes("Avisos")
    && (await text()).includes("los avisos no funcionan con los emuladores"));
  check("Configuración offers «Tus datos»: the download and the deletion", (await text()).includes("Tus datos")
    && (await text()).includes("Descargar mis datos") && (await text()).includes("Borrar mi cuenta"));
  // Mi perfil changes the name, and the account menu of the top bar shows the new one at once.
  await spaGo("/perfil");
  await page.waitForSelector("#p-name");
  await page.focus("#p-name");
  await page.$eval("#p-name", (el) => el.select());
  await page.keyboard.type("Carmen Vidal Ruiz");
  await clickText("button", "Guardar");
  check("Mi perfil saves the name and the top bar shows it", await waitText("Listo: se guardó tu nombre.")
    && await page.waitForFunction(() => document.querySelector(".user-menu-name")?.textContent === "Carmen Vidal Ruiz", { timeout: 10000 }).then(() => true, () => false));

  // The styles. «Cálido» is applied and kept, the vet view stays serene, levels and figures keep their font.
  const palette = () => page.evaluate(() => document.documentElement.dataset.palette ?? "sereno");
  const fontOf = (sel) => page.$eval(sel, (el) => getComputedStyle(el).fontFamily).catch(() => "");
  await page.click("label[for='style-calido']");
  check("choosing «Cálido» applies the warm style and keeps it in this browser",
    await palette() === "calido" && await page.evaluate(() => localStorage.getItem("palette")) === "calido");
  await spaGo("/perros");
  await page.waitForSelector(".dog-list .tag", { timeout: 10000 }).catch(() => {});
  check("the warm style puts Fraunces in the titles and keeps the level tags in Source Sans 3",
    (await fontOf("h1")).includes("Fraunces") && (await fontOf(".dog-list .tag")).includes("Source Sans 3"));
  await page.goto(BASE + "/perros", { waitUntil: "load" });
  await page.waitForSelector(".dog-list li", { timeout: 15000 }).catch(() => {});
  check("the style survives a reload, with its title font preloaded", await palette() === "calido"
    && await page.evaluate(() => !!document.querySelector('link[rel="preload"][href*="Fraunces"]')));
  await spaGo(newDogPath + "/veterinario");
  check("the vet view keeps the serene look", await palette() === "sereno");
  await spaGo("/perfil");
  check("leaving the vet view brings the chosen style back", await palette() === "calido");
  await page.waitForSelector("label[for='style-extravagante']");
  await page.click("label[for='style-extravagante']");
  check("«Extravagante» puts Lilita One in the titles", await palette() === "extravagante" && (await fontOf("h1")).includes("Lilita One"));
  await spaGo("/no-existe");
  check("the eccentric style jokes only in a neutral moment: the page not found", await waitText("Aquí no hay ningún hueso enterrado"));
  await spaGo("/perfil");
  await page.waitForSelector("label[for='style-sereno']");
  await page.click("label[for='style-sereno']");
  check("«Sereno» goes back to the usual look", await palette() === "sereno" && await page.evaluate(() => localStorage.getItem("palette")) === null);
} catch (e) {
  check("dog registration flow", false, e.message);
}

// 8. Unknown and retired routes inside the shell
await page.goto(BASE + "/veterinario", { waitUntil: "load" }); await sleep(600);
check("retired vet route shows not-found", (await text()).includes("No encontramos esta página"));

// 9. The new account deletes its dog, then itself, and can no longer sign in.
try {
  if (!newDogPath) throw new Error("the new dog was not registered");
  await page.goto(BASE + "/acceso", { waitUntil: "load" }); await sleep(800);
  if (path_() === "/acceso") await login(email, "clave-segura-1");
  await spaGo(newDogPath + "/editar");
  await clickText("button", "Borrar sus datos");
  await page.waitForSelector("#d-delete-word");
  check("deleting a dog waits for the confirmation word", await page.$eval("form[aria-labelledby=d-delete-q] button[type=submit]", (b) => b.disabled));
  await page.type("#d-delete-word", "borrar");
  await clickText("button", "para siempre");
  check("the dog is deleted for good and Perros says so", await waitPath("/perros", 30000)
    && await page.waitForFunction(() => document.body.innerText.includes("Borramos a Mora Luna y todos sus datos"), { timeout: 10000 }).then(() => true, () => false));
  check("the deleted dog is no longer in the list", await page.waitForFunction(() => document.body.innerText.includes("Todavía no registras perros"), { timeout: 10000 }).then(() => true, () => false));
  await spaGo("/configuracion");
  await clickText("button", "Borrar mi cuenta");
  await page.waitForSelector("#p-delete-word");
  await page.type("#p-delete-word", "BORRAR");
  await shot("08-borrar-cuenta-1440");
  await clickText("button", "Borrar mi cuenta para siempre");
  check("the account is deleted and the sign-in says so", await waitPath("/acceso", 30000)
    && await page.waitForFunction(() => document.body.innerText.includes("Borramos tu cuenta y todos sus datos"), { timeout: 10000 }).then(() => true, () => false));
  await page.type("#a-email", email); await page.type("#a-pass", "clave-segura-1");
  await page.click("button[type=submit]"); await sleep(3000);
  check("the deleted account can no longer sign in", path_() === "/acceso");
} catch (e) {
  check("data deletion flow", false, e.message);
}

await browser.close();
console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
const relevant = errors.filter((e) => !/Failed to load resource: the server responded with a status of 400/.test(e));
console.log(relevant.length ? "Browser errors:\n" + relevant.join("\n") : "No browser errors.");
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
