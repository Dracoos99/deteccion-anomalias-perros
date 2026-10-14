// Accessibility audit of the owner screens with axe-core (WCAG 2.1 A and AA): contrast, names, labels, landmarks…
// Needs the emulators with the seed and the web dev server; with a simulator run for Lucía's dogs the charts, the
// live panel and an alert are audited too. Usage: node tests/e2e/a11y.mjs   (fails on serious or critical issues)
import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180";
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", userDataDir: path.join(os.tmpdir(), "edge-a11y-" + Date.now()),
});
const page = await browser.newPage();
const found = [];

/** In-app navigation, without a reload (the emulator allows 6 connections per host). */
const spaGo = async (p) => {
  await page.evaluate((x) => { history.pushState({}, "", x); dispatchEvent(new PopStateEvent("popstate")); }, p);
  await sleep(1800);
};

async function audit(label) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"], resultTypes: ["violations"] }));
  for (const v of res.violations) {
    found.push({ page: label, id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0]?.target?.join(" ") ?? "" });
  }
  console.log(`${label}: ${res.violations.length ? res.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length})`).join(", ") : "sin problemas"}`);
}

for (const width of [390, 1440]) {
  await page.setViewport({ width, height: width < 720 ? 844 : 900, isMobile: width < 720, hasTouch: width < 720 });
  await page.goto(BASE + "/acceso", { waitUntil: "load" });
  await page.waitForSelector("#a-email");
  await audit(`${width} /acceso`);
  await page.goto(BASE + "/acceso/registro", { waitUntil: "load" });
  await page.waitForSelector("#a-name");
  await audit(`${width} /acceso/registro`);
  await page.goto(BASE + "/acceso", { waitUntil: "load" });
  await page.waitForSelector("#a-email");
  await page.type("#a-email", "lucia.paredes@example.com"); await page.type("#a-pass", "demo-1234");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
  await sleep(2000);
  await audit(`${width} /`);
  // The account menu open, over Inicio.
  await page.click(".user-menu-button");
  await page.waitForSelector(".user-menu-panel", { visible: true });
  await sleep(500);   // the panel fades in (250 ms): measure its contrast once it is opaque
  await audit(`${width} / (menú de la cuenta)`);
  await page.keyboard.press("Escape");
  for (const p of ["/perros", "/alertas", "/alertas?vista=historial", "/perros/toby", "/perros/rocky/veterinario", "/perfil", "/configuracion", "/perfil/datos", "/perros/nuevo"]) {
    await spaGo(p);
    await audit(`${width} ${p}`);
  }
  await spaGo("/alertas?vista=historial");
  const first = await page.$eval("#panel-historial td[data-title] a", (a) => a.getAttribute("href")).catch(() => null);
  if (first) { await spaGo(first); await audit(`${width} ${first.replace(/[^/]+$/, ":alerta")}`); }
  await spaGo("/perfil");
  for (const b of await page.$$("xpath/.//button[contains(., 'Cerrar sesión')]")) if (await b.isVisible()) { await b.click(); break; }
  await sleep(1500);
}
// The two styles, light and dark at 1440 px and light at 390 px, on the owner's main screens.
await page.setViewport({ width: 1440, height: 900 });
await page.goto(BASE + "/acceso", { waitUntil: "load" });
await page.waitForSelector("#a-email");
await page.type("#a-email", "lucia.paredes@example.com"); await page.type("#a-pass", "demo-1234");
await page.click("button[type=submit]");
await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
await sleep(1500);
const firstAlert = await (async () => { await spaGo("/alertas?vista=historial"); return page.$eval("#panel-historial td[data-title] a", (a) => a.getAttribute("href")).catch(() => null); })();
const stylePages = ["/", "/perros", "/alertas", "/alertas?vista=historial", "/perfil", "/configuracion", "/perros/toby", ...(firstAlert ? [firstAlert] : [])];
for (const [width, schemes] of [[1440, ["light", "dark"]], [390, ["light"]]]) {
  await page.setViewport({ width, height: width < 720 ? 844 : 900, isMobile: width < 720, hasTouch: width < 720 });
  for (const palette of ["calido", "extravagante"]) {
    for (const scheme of schemes) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.evaluate((p) => { localStorage.setItem("palette", p); document.documentElement.setAttribute("data-palette", p); }, palette);
      for (const p of stylePages) { await spaGo(p); await audit(`${width} ${palette} ${scheme} ${p.replace(/\/alertas\/[^/?]+$/, "/alertas/:alerta")}`); }
    }
  }
}
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.evaluate(() => { localStorage.removeItem("palette"); document.documentElement.removeAttribute("data-palette"); });
await spaGo("/perfil");
for (const b of await page.$$("xpath/.//button[contains(., 'Cerrar sesión')]")) if (await b.isVisible()) { await b.click(); break; }
await sleep(1500);

// Research tools (admin, wide screen only).
await page.goto(BASE + "/acceso", { waitUntil: "load" });
await page.waitForSelector("#a-email");
await page.type("#a-email", "admin@example.com"); await page.type("#a-pass", "demo-1234");
await page.click("button[type=submit]");
await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
for (const p of ["/admin", "/admin/configuracion", "/admin/ingesta", "/admin/revision"]) { await spaGo(p); await sleep(1500); await audit(`1440 ${p}`); }
await browser.close();

const serious = found.filter((f) => f.impact === "serious" || f.impact === "critical");
if (found.length) {
  console.log("\nDetalle:");
  for (const f of found) console.log(`- [${f.impact}] ${f.page} · ${f.id} × ${f.nodes}: ${f.help} — ${f.sample}`);
}
console.log(`\n${serious.length ? `${serious.length} problemas graves o críticos` : "Sin problemas graves ni críticos"} (${found.length} en total)`);
process.exitCode = serious.length ? 1 : 0;
