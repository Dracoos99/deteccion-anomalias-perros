// Drive the web app step by step as a person would: a headless Edge that stays open between commands, so a session
// (login, page, scroll) carries over from one command to the next. For exploratory testing of the owner's journey.
//
//   node tests/e2e/browse.mjs open                      start the browser (keeps running; stop it with `close`)
//   node tests/e2e/browse.mjs <step> [<step> ...]       run steps on the open page, then print what it shows
//   node tests/e2e/browse.mjs close
//
// Steps (quote the ones with spaces):
//   size:390x844 | size:1280x800      viewport (kept for the next commands)
//   go:/perros/toby                    open a path of the app (BASE_URL, default http://localhost:5180)
//   login:lucia.paredes@example.com    sign in with the demo password (demo-1234), or login:email:password
//   logout                             sign out through Perfil or the masthead
//   click:Texto visible                click the button, link, tab or label whose text contains it
//   css:selector                       click the first element matching a CSS selector
//   type:#selector=texto               clear a field and type into it
//   key:Enter | key:Tab                press a key
//   scroll:600 | scroll:bottom         scroll the page
//   wait:1500                          wait in milliseconds
//   until:Texto                        wait (up to 30 s) until the page shows that text
//   shot:name                          full-page screenshot to tests/e2e/shots/browse/<name>.png
//   view:name                          screenshot of the visible part only
//   text                               print the visible text of <main> (default at the end)
//   focus                              print the element that has the keyboard focus
//   check                              print layout problems: horizontal overflow, small tap targets, buttons without a name
//   offline:on | offline:off           cut or restore the network (the app should say "Sin conexión")
//   pdf:name                           print the page to tests/e2e/shots/browse/<name>.pdf (as "Descargar PDF" does)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:5180";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "shots", "browse");
const STATE = path.join(os.tmpdir(), "perros-browse.json");
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

const args = process.argv.slice(2);
const cmd = args[0];
const steps = cmd === "open" || cmd === "close" ? [] : args;

if (cmd === "open") {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: "new", userDataDir: path.join(os.tmpdir(), "edge-browse-" + Date.now()),
    args: ["--lang=es-PE"], defaultViewport: null,
  });
  writeState({ ws: browser.wsEndpoint(), width: 390, height: 844 });
  console.log("browser open:", browser.wsEndpoint());
  browser.on("disconnected", () => process.exit(0));
  await new Promise(() => {});   // keep the process (and the browser) alive
}

const state = readState();
if (!state) { console.error("No browser: run `node tests/e2e/browse.mjs open` first (in the background)."); process.exit(1); }
let browser;
try { browser = await puppeteer.connect({ browserWSEndpoint: state.ws, defaultViewport: null }); }
catch { console.error("The browser is not running: open it again."); process.exit(1); }

if (cmd === "close") { await browser.close(); fs.rmSync(STATE, { force: true }); console.log("closed"); process.exit(0); }

const page = (await browser.pages())[0] ?? (await browser.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/status of 400/.test(m.text())) errors.push("console: " + m.text()); });
await page.setViewport({ width: state.width, height: state.height, deviceScaleFactor: 1, isMobile: state.width < 720, hasTouch: state.width < 720 });

const mainText = () => page.evaluate(() => (document.querySelector("main") ?? document.body).innerText.replace(/\n{3,}/g, "\n\n").trim());
const xpathText = (t) => `//*[self::button or self::a or self::label or self::summary or @role='tab' or @role='button'][contains(normalize-space(.), ${JSON.stringify(t)})]`;

async function clickText(t) {
  // Prefer the innermost visible match, so "Corazón" picks the tab and not a whole card that contains the word.
  let visible = [];
  for (let tries = 0; tries < 20 && !visible.length; tries++) {   // up to 5 s: the page may still be loading
    if (tries) await sleep(250);
    visible = [];
    for (const h of await page.$$(`xpath/${xpathText(t)}`)) if (await h.isVisible()) visible.push(h);
  }
  if (!visible.length) throw new Error(`nothing clickable with the text «${t}»`);
  const exact = [];
  for (const h of visible) if ((await h.evaluate((e) => e.innerText.trim())) === t) exact.push(h);
  const el = exact[0] ?? visible[visible.length - 1];
  await el.scrollIntoView();
  await el.click();
}

async function layoutCheck() {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`horizontal scroll: page is ${document.documentElement.scrollWidth}px for a ${vw}px viewport`);
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      const scroller = (() => { for (let a = el.parentElement; a; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX)) return true; return false; })();
      if (r.width && r.right > vw + 1 && getComputedStyle(el).position !== "fixed" && !scroller && !el.closest("svg")) {
        out.push(`overflows to the right (${Math.round(r.right)}px): <${el.tagName.toLowerCase()} class="${el.className}"> ${el.innerText?.slice(0, 40) ?? ""}`);
        if (out.length > 12) break;
      }
    }
    const small = [...document.querySelectorAll("a, button, input, select, [role=tab]")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) && !el.closest(".crumbs, p, li, .footer, .sr-only, .skip-link");
    }).map((el) => `small target ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}: ${el.tagName.toLowerCase()} «${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}»`);
    const noLabel = [...document.querySelectorAll("button, a")].filter((el) => !(el.innerText.trim() || el.getAttribute("aria-label") || el.getAttribute("title")))
      .map((el) => `no accessible name: ${el.outerHTML.slice(0, 80)}`);
    return [...out, ...small.slice(0, 10), ...noLabel.slice(0, 10)];
  });
}

let printedText = false;
for (const step of steps) {
  const i = step.indexOf(":");
  const verb = i < 0 ? step : step.slice(0, i);
  const arg = i < 0 ? "" : step.slice(i + 1);
  try {
    switch (verb) {
      case "size": {
        const [w, h] = arg.split("x").map(Number);
        state.width = w; state.height = h; writeState(state);
        await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 720, hasTouch: w < 720 });
        break;
      }
      case "go": await page.goto(BASE + arg, { waitUntil: "load" }); await sleep(1200); break;
      case "login": {
        const [email, pass = "demo-1234"] = arg.split(":");
        await page.goto(BASE + "/acceso", { waitUntil: "load" });
        await page.waitForSelector("#a-email", { timeout: 15000 });
        await page.type("#a-email", email); await page.type("#a-pass", pass);
        await page.click("button[type=submit]");
        await page.waitForFunction(() => location.pathname !== "/acceso", { timeout: 15000 }).catch(() => {});
        await sleep(1500);
        break;
      }
      case "logout": {
        await page.goto(BASE + "/perfil", { waitUntil: "load" }); await sleep(1000);
        await clickText("Cerrar sesión");
        await page.waitForFunction(() => location.pathname.startsWith("/acceso"), { timeout: 10000 }).catch(() => {});
        break;
      }
      case "click": await clickText(arg); await sleep(900); break;
      case "css": { const el = await page.waitForSelector(arg, { visible: true, timeout: 10000 }); await el.scrollIntoView(); await el.click(); await sleep(900); break; }
      case "type": {
        const j = arg.indexOf("=");
        const sel = arg.slice(0, j);
        const el = await page.waitForSelector(sel, { visible: true, timeout: 10000 });
        await el.click({ clickCount: 3 });
        await page.$eval(sel, (e) => { if ("value" in e) e.value = ""; });
        await el.type(arg.slice(j + 1));
        break;
      }
      case "key": await page.keyboard.press(arg); await sleep(300); break;
      case "scroll": await page.evaluate((a) => window.scrollTo(0, a === "bottom" ? document.body.scrollHeight : Number(a)), arg); await sleep(300); break;
      case "wait": await sleep(Number(arg) || 1000); break;
      case "until": await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 30000 }, arg); break;
      case "shot": case "view": {
        fs.mkdirSync(SHOTS, { recursive: true });
        const file = path.join(SHOTS, `${arg || "shot"}.png`);
        await sleep(300);
        await page.screenshot({ path: file, fullPage: verb === "shot" });
        console.log("screenshot:", file);
        break;
      }
      case "text": console.log(await mainText()); printedText = true; break;
      case "focus": console.log("focus:", await page.evaluate(() => { const e = document.activeElement; return e ? `${e.tagName.toLowerCase()} «${(e.innerText || e.getAttribute("aria-label") || e.id || "").trim().slice(0, 60)}»` : "none"; })); break;
      case "check": { const p = await layoutCheck(); console.log(p.length ? p.join("\n") : "layout: no problems found"); break; }
      case "offline": await page.setOfflineMode(arg !== "off"); await sleep(800); break;
      case "pdf": {
        fs.mkdirSync(SHOTS, { recursive: true });
        const file = path.join(SHOTS, `${arg || "page"}.pdf`);
        await page.emulateMediaType("print");
        await page.pdf({ path: file, format: "A4", printBackground: true, preferCSSPageSize: true });
        await page.emulateMediaType(null);
        console.log("pdf:", file);
        break;
      }
      default: throw new Error(`unknown step ${verb}`);
    }
  } catch (e) {
    console.log(`STEP FAILED ${step}: ${e.message}`);
    break;
  }
}
console.log(`\n— ${new URL(page.url()).pathname} · ${state.width}×${state.height}`);
if (!printedText && !steps.some((s) => s.startsWith("shot") || s.startsWith("view"))) console.log((await mainText()).slice(0, 2500));
if (errors.length) console.log("Browser errors:\n" + errors.join("\n"));
await browser.disconnect();
