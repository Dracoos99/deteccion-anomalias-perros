// E2E of the simulator panel (/admin) with the real simulator process, then the owner screens with its data.
// Needs: emulators + seed, the web dev server and `npm run sim -- serve`, with no active run using Toby.
// Usage: npm run test:e2e:panel
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:5180";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "shots");
// The behavioral model the Function and the simulator load (A2 must list it).
const MODEL = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "functions", "models", "behavior", "metadata.json"), "utf8")).version;
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const errors = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
let browser, page;
/** A fresh browser profile per account: the Firestore emulator speaks HTTP/1.1 and the long-lived connections of the
 * previous session can exhaust the browser's per-host limit, leaving writes queued (production uses HTTP/2). */
async function openBrowser() {
  if (browser) await browser.close();
  browser = await puppeteer.launch({
    executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", userDataDir: path.join(os.tmpdir(), "edge-e2e-panel-" + Date.now()),
  });
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 1000 });
}
await openBrowser();
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (needle, t = 30000) => {
  try { await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: t }, needle); return true; } catch { return false; }
};
/** Navigate inside the app, as a person following links does: no reload, so the emulator's HTTP/1.1 connections
 * (6 per host) are not used up by the Firestore channels of earlier pages. */
const spaGo = async (p) => {
  await page.evaluate((x) => { history.pushState({}, "", x); dispatchEvent(new PopStateEvent("popstate")); }, p);
  await new Promise((r) => setTimeout(r, 1200));
};
const clickButton = async (label, scope = "body") => {
  const [btn] = await page.$$(`xpath/.//${scope === "body" ? "" : `section[@aria-labelledby='${scope}']//`}button[normalize-space(.)='${label}' or contains(., '${label}')]`);
  if (!btn) throw new Error(`button not found: ${label}`);
  await btn.click();
};

await page.goto(BASE + "/acceso", { waitUntil: "load" });
await page.waitForSelector("#a-email");
await page.type("#a-email", "admin@example.com");
await page.type("#a-pass", "demo-1234");
await page.click("button[type=submit]");
// Every account lands on Inicio; the admin reaches the research tools from «Consola Admin» in the top bar
// which opens on «Simulador & IA».
await page.waitForFunction(() => location.pathname === "/", { timeout: 15000 });
await page.waitForSelector(".topbar-nav a[href='/admin']", { timeout: 15000 });
await page.click(".topbar-nav a[href='/admin']");
await page.waitForSelector("section[aria-labelledby='new-title'] input[type=checkbox]", { timeout: 15000 });

// New run: only Toby, ×10, 30 simulated minutes.
for (const cb of await page.$$("section[aria-labelledby='new-title'] input[type=checkbox]:checked")) await cb.click();
const [toby] = await page.$$("xpath/.//section[@aria-labelledby='new-title']//label[.//strong[text()='Toby']]//input");
await toby.click();
await clickButton("×10", "new-title");
await clickButton("30 min", "new-title");
await clickButton("Crear ejecución", "new-title");
check("run created from the panel is claimed by the simulator process", await waitText("proceso ", 20000));
check("blocks are being written", await page.waitForFunction(() => {
  const el = [...document.querySelectorAll(".stat")].find((s) => s.innerText.startsWith("Bloques escritos"));
  return el && Number(el.querySelector(".stat-value").innerText.replace(/\D/g, "")) > 0;
// The first run after a model change recomputes the dog's baseline with the new model before its first block.
}, { timeout: 150000 }).then(() => true, () => false));

// Inject a fever from the form.
await page.select("#inj-type", "fever");
await clickButton("Inyectar anomalía", "inj-title");
check("injection is sent and confirmed", await waitText("Enviada a Toby", 5000));
check("the simulator takes the injection (log shows it)", await waitText("Inyecciones de esta ejecución (1)", 15000));
check("the dog row shows the active anomaly", await waitText("Temperatura alta (+1,5 °C)", 15000) || await waitText("Temperatura alta (+1.5 °C)", 1000));

// Controls.
await clickButton("Pausar");
check("pause is reflected", await waitText("En pausa", 10000));
await clickButton("Reanudar");
check("resume is reflected", await waitText("Reproduciendo", 10000));
await new Promise((r) => setTimeout(r, 8000));
// The fever must hold for config/fusion.alertMinDurationS (300 s of data) before the alert opens: wait for it in the
// emulator (REST, with the emulator's owner token) before stopping the run.
const alertOpened = await (async () => {
  const url = `http://localhost:8080/v1/projects/demo-perros-tesis/databases/(default)/documents:runQuery`;
  const body = JSON.stringify({ structuredQuery: { from: [{ collectionId: "alerts" }], where: { fieldFilter: { field: { fieldPath: "dogId" }, op: "EQUAL", value: { stringValue: "toby" } } }, limit: 1 } });
  for (const t0 = Date.now(); Date.now() - t0 < 240_000; await new Promise((r) => setTimeout(r, 3000))) {
    const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body }).then((r) => r.json()).catch(() => []);
    if (res.some?.((x) => x.document)) return true;
  }
  return false;
})();
check("the injected fever opens an alert once it has lasted 5 minutes of data", alertOpened);
const latencyText = await text();
check("latency is measured and labelled as emulator", /Promedio\s+\d+[,.]\d+ s/.test(latencyText) && latencyText.includes("Medida en los emuladores locales"));
await page.screenshot({ path: path.join(OUT, "08b-simulador-panel-1440.png"), fullPage: true });
// A run in course asks first, on the page.
await clickButton("Detener");
check("stopping a run in course asks first, on the page", await waitText("Una ejecución detenida no se puede reanudar", 5000));
await clickButton("Sí, detener");
check("stop is reflected", await waitText("Detenida", 15000));

// Owner screens with the data of this run (phase 3): banner, alert detail, review, charts and vet view.
await openBrowser();
await page.goto(BASE + "/acceso", { waitUntil: "load" });
await page.waitForSelector("#a-email");
await page.type("#a-email", "lucia.paredes@example.com");
await page.type("#a-pass", "demo-1234");
await page.click("button[type=submit]");
await page.waitForFunction(() => location.pathname === "/", { timeout: 15000 });
await page.waitForSelector(".dog-card", { timeout: 15000 });
const bannerSelector = "xpath/.//article[.//h2//a[normalize-space(.)='Toby']]//a[contains(@class, 'alert-banner')]";
check("Inicio shows Toby's open alert", !!await page.waitForSelector(bannerSelector, { timeout: 15000 }).catch(() => null));
// «Marcar todas como revisadas» in «Activas», and «Deshacer» makes the alert new again. The count of
// the tab is the number of active alerts (none: no count).
const activeCount = () => page.evaluate(() => Number(document.querySelector("#tab-activas .tab-count")?.textContent ?? 0));
await spaGo("/alertas");
check("«Activas» groups Toby's alert under its severity", await page.waitForFunction(() =>
  [...document.querySelectorAll(".severity-group")].some((g) => /Crítico|Advertencia/.test(g.innerText) && g.innerText.includes("Toby")), { timeout: 10000 }).then(() => true, () => false));
await page.screenshot({ path: path.join(OUT, "07-alertas-activas-1440.png"), fullPage: true });
await page.waitForSelector("xpath/.//button[contains(., 'Marcar todas como revisadas')]", { timeout: 10000 }).catch(() => {});
await clickButton("Marcar todas como revisadas").catch((e) => errors.push(String(e)));
check("Alertas marks every new alert as reviewed at once", await waitText("quedó revisada", 10000) && await activeCount() === 0);
await clickButton("Deshacer").catch((e) => errors.push(String(e)));
check("«Deshacer» makes it new again", await waitText("volvió a quedar como nueva", 10000)
  && await page.waitForFunction(() => Number(document.querySelector("#tab-activas .tab-count")?.textContent ?? 0) === 1, { timeout: 10000 }).then(() => true, () => false));
await spaGo("/");
const banner = await page.waitForSelector(bannerSelector, { timeout: 15000 }).catch(() => null);
if (banner) {
  await banner.click();
  await page.waitForSelector("#why", { timeout: 10000 }).catch(() => {});
  const alertText = await text();
  check("alert detail names it in plain language, with when and what to do",
    /Su temperatura (estuvo|está) alta/.test(alertText) && alertText.includes("Empezó ") && alertText.includes("Qué puedes hacer") && alertText.includes("termómetro"));
  await page.screenshot({ path: path.join(OUT, "04-detalle-alerta-1440.png"), fullPage: true });
  await clickButton("Marcar como revisada");
  check("the owner marks it as reviewed", await waitText("Revisada", 10000));
}
// The reviewed alert leaves «Activas» and stays in «Historial», a row with its dog, severity and state.
await spaGo("/alertas?vista=historial");
check("«Historial» keeps the reviewed alert with its dog, severity and state", await page.waitForFunction(() =>
  [...document.querySelectorAll("#panel-historial .history-table tbody tr")].some((r) => r.innerText.includes("Toby") && /Crítico|Advertencia/.test(r.innerText) && r.innerText.includes("Revisada")),
  { timeout: 10000 }).then(() => true, () => false));
await page.screenshot({ path: path.join(OUT, "07b-alertas-historial-1440.png"), fullPage: true });
await spaGo("/perros/toby");
await page.waitForSelector(".dog-state", { timeout: 10000 }).catch(() => {});
const [tempTab] = await page.$$("xpath/.//button[@role='tab' and normalize-space(.)='Temperatura']");
if (!tempTab) check("dog detail shows its tabs", false, (await text()).replace(/\s+/g, " ").slice(0, 600));
else {
  await tempTab.click();
  check("dog detail charts the temperature of the run", await page.waitForFunction(() =>
    [...document.querySelectorAll("svg[role=img]")].some((s) => (s.getAttribute("aria-label") ?? "").startsWith("Temperatura: último valor")), { timeout: 15000 }).then(() => true, () => false));
}
await page.screenshot({ path: path.join(OUT, "03-detalle-perro-1440.png"), fullPage: true });
await spaGo("/perros/toby/veterinario");
check("vet view summarizes signals and lists the event", await page.waitForFunction(() => {
  const t = document.body.innerText;
  return t.includes("Señales del periodo") && /Temperatura \(°C\)\s+\d/.test(t) && /Eventos anómalos \([1-9]/.test(t);
}, { timeout: 15000 }).then(() => true, () => false));
await page.screenshot({ path: path.join(OUT, "05-vista-veterinario-1440.png"), fullPage: true });

// A2 · Modelos y configuración: the admin edits config/fusion; an invalid draft cannot be saved.
await openBrowser();
await page.goto(BASE + "/acceso", { waitUntil: "load" });
await page.waitForSelector("#a-email");
await page.type("#a-email", "admin@example.com");
await page.type("#a-pass", "demo-1234");
await page.click("button[type=submit]");
await page.waitForFunction(() => location.pathname === "/", { timeout: 15000 });
await spaGo("/admin");
// «Simulador & IA» switches between the simulator and the models.
await page.waitForSelector(".console-sub a[href='/admin/configuracion']", { timeout: 15000 });
await page.click(".console-sub a[href='/admin/configuracion']");
await page.waitForSelector("#c-wb", { timeout: 15000 }).catch(() => {});
check("A2 shows the active models and the fusion form", await waitText("Fusión y umbrales", 10000) && await waitText("lstm-ae-v1", 10000) && (await text()).includes(MODEL));
await page.$eval("#c-wb", (el) => { el.value = ""; });
await page.type("#c-wb", "0.5");
const saveDisabled = await page.$eval("xpath/.//button[contains(., 'Guardar cambios')]", (b) => b.disabled).catch(() => null);
check("weights that do not add up to 1 cannot be saved", (await text()).includes("Los pesos deben sumar 1") && saveDisabled === true);
await page.$eval("#c-wb", (el) => { el.value = ""; });
await page.type("#c-wb", "0.4");
await page.$eval("#c-consec", (el) => { el.value = ""; });
await page.type("#c-consec", "3");
await clickButton("Guardar cambios");
check("a valid change is saved to config/fusion and logged with who and when", await waitText("Configuración guardada", 10000)
  && await waitText("Regla crítica: ventanas seguidas", 10000) && (await text()).includes("Tú"));
await page.$eval("#c-consec", (el) => { el.value = ""; });
await page.type("#c-consec", "2");
await clickButton("Guardar cambios");
await waitText("Configuración guardada", 10000);
await page.screenshot({ path: path.join(OUT, "a2-configuracion-1440.png"), fullPage: true });

await browser.close();
console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
console.log(errors.length ? "Browser errors:\n" + errors.join("\n") : "No browser errors.");
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
