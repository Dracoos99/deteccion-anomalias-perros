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
// Every account lands on Inicio; the admin reaches the research tools at /admin.
await page.waitForFunction(() => location.pathname === "/", { timeout: 15000 });
await page.goto(BASE + "/admin", { waitUntil: "load" });
await page.waitForSelector("section[aria-labelledby='new-title'] input[type=checkbox]", { timeout: 15000 });

// New run: only Toby, ×10, 10 minutes.
for (const cb of await page.$$("section[aria-labelledby='new-title'] input[type=checkbox]:checked")) await cb.click();
const [toby] = await page.$$("xpath/.//section[@aria-labelledby='new-title']//label[.//strong[text()='Toby']]//input");
await toby.click();
await clickButton("×10", "new-title");
await clickButton("10 min", "new-title");
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
const latencyText = await text();
check("latency is measured and labelled as emulator", /Promedio\s+\d+[,.]\d+ s/.test(latencyText) && latencyText.includes("Medida en los emuladores locales"));
await page.screenshot({ path: path.join(OUT, "08b-simulador-panel-1440.png"), fullPage: true });
await clickButton("Detener");
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
const banner = await page.waitForSelector("xpath/.//article[.//h2//a[normalize-space(.)='Toby']]//a[contains(@class, 'alert-banner')]", { timeout: 15000 }).catch(() => null);
check("Inicio shows Toby's open alert", !!banner);
if (banner) {
  await banner.click();
  await page.waitForSelector("#why", { timeout: 10000 }).catch(() => {});
  const alertText = await text();
  check("alert detail names it in plain language, with when and what to do",
    alertText.includes("Su temperatura estuvo alta") && alertText.includes("Empezó el") && alertText.includes("Qué puedes hacer") && alertText.includes("termómetro"));
  await page.screenshot({ path: path.join(OUT, "04-detalle-alerta-1440.png"), fullPage: true });
  await clickButton("Marcar como revisada");
  check("the owner marks it as reviewed", await waitText("Revisada", 10000));
}
await page.goto(BASE + "/perros/toby", { waitUntil: "load" });
await page.waitForSelector(".dog-state", { timeout: 10000 }).catch(() => {});
const [tempTab] = await page.$$("xpath/.//button[@role='tab' and normalize-space(.)='Temperatura']");
await tempTab.click();
check("dog detail charts the temperature of the run", await page.waitForFunction(() =>
  [...document.querySelectorAll("svg[role=img]")].some((s) => (s.getAttribute("aria-label") ?? "").startsWith("Temperatura: último valor")), { timeout: 15000 }).then(() => true, () => false));
await page.screenshot({ path: path.join(OUT, "03-detalle-perro-1440.png"), fullPage: true });
await page.goto(BASE + "/perros/toby/veterinario", { waitUntil: "load" });
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
await page.goto(BASE + "/admin/configuracion", { waitUntil: "load" });
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
