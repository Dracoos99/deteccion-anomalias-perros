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
const noRoleWords = async () => { const t = await text(); return ROLE_WORDS.filter((w) => t.includes(w)); };
const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true }); };
const logout = async () => {
  for (const btn of await page.$$("xpath/.//button[contains(., 'Cerrar sesión')]")) {
    if (await btn.isVisible()) { await btn.click(); break; }
  }
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

// 3. Owner: Inicio with her dogs, fixed notice, three sections, no roles anywhere
await login("lucia.paredes@example.com");
check("owner lands on Inicio (/)", await waitPath("/"));
await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
const ownerDogs = await page.$$eval(".dog-name", (els) => els.map((e) => e.textContent));
check("owner sees her 3 dogs only", JSON.stringify(ownerDogs) === JSON.stringify(["Luna", "Rocky", "Toby"]), JSON.stringify(ownerDogs));
check("fixed notice with the v3 wording", (await text()).includes(NOTICE));
check("wide screens show the side navigation Inicio · Alertas · Perfil",
  await page.$eval(".sidebar", (el) => getComputedStyle(el).display !== "none")
  && JSON.stringify(await navLabels(".sidebar .side-link .nav-label")) === JSON.stringify(["Inicio", "Alertas", "Perfil"]));
check("the side navigation names the account and offers to sign out", (await page.$eval(".sidebar", (el) => el.innerText)).includes("Lucía Paredes")
  && (await page.$eval(".sidebar", (el) => el.innerText)).includes("Cerrar sesión"));
check("no role is shown on Inicio", !(await noRoleWords()).length, (await noRoleWords()).join(", "));
await shot("02-inicio-1440");
await page.setViewport({ width: 390, height: 844 });
check("mobile shows the bottom tab bar with the three sections", await page.$eval(".tabbar", (t) => getComputedStyle(t).display !== "none")
  && JSON.stringify(await navLabels(".tabbar .tabbar-link .nav-label")) === JSON.stringify(["Inicio", "Alertas", "Perfil"])
  && await page.$eval(".sidebar", (el) => getComputedStyle(el).display === "none"));
const wideOnPhone = [];
for (const p of ["/", "/perros/toby", "/alertas", "/perfil", "/perfil/datos", "/perros/toby/veterinario"]) {
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
await page.goto(BASE + "/admin", { waitUntil: "load" });
check("owner opening /admin is sent to Inicio without a message", await waitPath("/") && !(await text()).includes("No tienes acceso"));
await page.goto(BASE + "/perfil", { waitUntil: "load" });
await page.waitForSelector("#p-account", { timeout: 10000 }).catch(() => {});
check("owner Perfil shows the account and dogs, without research tools",
  (await text()).includes("lucia.paredes@example.com") && (await text()).includes("Mis perros") && !(await page.$("#p-research")));
await page.goto(BASE + "/alertas", { waitUntil: "load" });
await sleep(1200);
check("Alertas loads (empty state or list)", /Sin alertas|Sin revisar|Revisada/.test(await text()));
await shot("07-alertas-1440");
await logout();
check("logout returns to /acceso", path_() === "/acceso");

// 5. Admin: same Inicio (all dogs), research tools only from Perfil
await login("admin@example.com");
check("admin also lands on Inicio", await waitPath("/"));
await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
check("admin sees every dog on Inicio (the 10 of the seed at least)", (await page.$$(".dog-card")).length >= 10, String((await page.$$(".dog-card")).length));
check("no role is shown to the admin either", !(await noRoleWords()).length, (await noRoleWords()).join(", "));
await page.goto(BASE + "/perfil", { waitUntil: "load" });
await page.waitForSelector("#p-research", { timeout: 10000 }).catch(() => {});
check("admin Perfil offers the research tools", (await text()).includes("Herramientas de investigación"));
await page.waitForSelector("section[aria-labelledby='p-research'] a", { visible: true, timeout: 10000 });
await page.click("section[aria-labelledby='p-research'] a");
check("research tools open at /admin", await waitPath("/admin"));
await sleep(1500);
const adminText = await text();
check("simulator panel shows config/fusion values", adminText.includes("0.4 · 0.4 · 0.2") && adminText.includes("Health Score < 60"));
check("simulator panel lists runs or offers to create one", adminText.includes("Nueva ejecución") && (adminText.includes("Ejecuciones recientes") || adminText.includes("Todavía no hay ejecuciones")));
await shot("a1-simulador-1440");
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
  check("detail of a dog without data explains it", (await text()).includes("Todavía no hay datos.") && (await text()).includes("Qué es normal para Mora"));
  await shot("03-detalle-sin-datos-1440");
  await clickText("a", "Editar perfil");
  await page.waitForSelector("#d-name");
  await page.$eval("#d-name", (el) => { el.value = ""; });
  await page.type("#d-name", "Mora Luna");
  await page.click("button[type=submit]");
  check("edited name is saved", await waitPath(dogPath) && await page.waitForFunction(() => document.body.innerText.includes("Mora Luna"), { timeout: 10000 }).then(() => true, () => false));
  await page.goto(BASE + dogPath + "/veterinario", { waitUntil: "load" });
  // The kicker is uppercased by CSS, and innerText returns it transformed: compare case-insensitively.
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("vista para el veterinario"), { timeout: 10000 }).catch(() => {});
  const vetText = await text();
  check("vet view shows the dog's data read-only", vetText.toLowerCase().includes("vista para el veterinario") && vetText.includes("Hembra") && vetText.includes("12.5 kg")
    && vetText.includes("Sin diagnóstico") && vetText.includes("Descargar PDF"));
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForSelector(".dog-card", { timeout: 10000 }).catch(() => {});
  check("the new dog appears on Inicio with a plain phrase", (await text()).includes("Mora Luna") && (await text()).includes("Todavía no hay datos."));

  // 7b. Phase 5: first-use guide, CSV upload of the example file, and the notifications section.
  check("Inicio guides the owner to load the dog's data (screen 9)", (await text()).includes("Conecta sus datos") && !!(await page.$("a[href^='/perfil/datos']")));
  await clickText("a", "Cargar datos");
  check("the guide opens the upload with the dog chosen", await waitPath("/perfil/datos")
    && await page.$eval("#csv-dog", (el) => el.options[el.selectedIndex].text.startsWith("Mora Luna")));
  await clickText("button", "Probar con un archivo de ejemplo");
  await page.waitForFunction(() => document.body.innerText.includes("bloques de 10 s"), { timeout: 10000 }).catch(() => {});
  const checkText = await text();
  check("the example file is checked: problems listed, 4 blocks", checkText.includes("Revisión de ejemplo_60s.csv") && checkText.includes("se crearán 4 bloques de 10 s")
    && checkText.includes("Fila 2712") && checkText.includes("cortes"));
  await shot("07-carga-csv-revision-1440");
  await clickText("button", "Confirmar y cargar 4 bloques");
  const analysed = await page.waitForFunction(() => document.body.innerText.includes("Listo: 4 bloques analizados"), { timeout: 180000 }).then(() => true, () => false);
  check("the 4 blocks are written in order and scored by the Function", analysed, analysed ? "" : (await text()).replace(/\s+/g, " ").slice(0, 600));
  await shot("07b-carga-csv-lista-1440");
  check("the upload is listed as analysed", (await text()).includes("Cargas recientes") && (await text()).includes("Analizada"));
  await page.goto(BASE + dogPath, { waitUntil: "load" });
  const learning = await page.waitForFunction(() => document.body.innerText.includes("Aprendiendo qué es normal para Mora Luna"), { timeout: 15000 }).then(() => true, () => false);
  check("the dog now has data and is learning its normal pattern", learning && (await text()).includes("Estamos aprendiendo su patrón normal"));
  await page.waitForSelector("#tabbtn-resumen", { timeout: 10000 }).catch(() => {});
  await page.focus("#tabbtn-resumen"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  check("the detail tabs move with the arrow keys", await page.evaluate(() => document.activeElement?.id === "tabbtn-corazon"
    && document.getElementById("tabbtn-corazon")?.getAttribute("aria-selected") === "true"));
  check("the browser tab is named after the dog", (await page.title()).startsWith("Mora Luna · "));
  await shot("03b-detalle-aprendiendo-1440");
  await page.goto(BASE + "/perfil", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.innerText.includes("Qué quieres recibir"), { timeout: 10000 }).catch(() => {});
  check("Perfil offers the data upload and the notification settings", (await text()).includes("Cargar datos") && (await text()).includes("Avisos")
    && (await text()).includes("los avisos no funcionan con los emuladores"));
} catch (e) {
  check("dog registration flow", false, e.message);
}

// 8. Unknown and retired routes inside the shell
await page.goto(BASE + "/veterinario", { waitUntil: "load" }); await sleep(600);
check("retired vet route shows not-found", (await text()).includes("No encontramos esta página"));

await browser.close();
console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
const relevant = errors.filter((e) => !/Failed to load resource: the server responded with a status of 400/.test(e));
console.log(relevant.length ? "Browser errors:\n" + relevant.join("\n") : "No browser errors.");
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
