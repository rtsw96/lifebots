// End-to-end check of the water card in the Health app, in Chromium with the real
// app.js and the Worker's CSP: a tap queues a drink, the total and the pet answer at
// once (the pet's mood is half water), and Undo queues the drink's removal.
//
//   node health/app/preview/water.mjs <data.json> [screenshot-dir]

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dataPath, outDir] = process.argv.slice(2);
if (!dataPath) { console.error("usage: water.mjs <data.json> [screenshot-dir]"); process.exit(2); }
if (outDir) mkdirSync(outDir, { recursive: true });
// Works from any snapshot, even an empty one: a past day of water is added when there is
// none, so the Progress chart has something to show (synthetic, never saved).
const raw = JSON.parse(readFileSync(resolve(dataPath)));
if (raw.snap && raw.snap.water && !(raw.snap.water.days || []).length) {
  const past = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  raw.snap.water.days = [{ date: past, ml: raw.snap.water.goal_ml || 2000 }];
}
const DATA = JSON.stringify(raw);
const PUB = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const CSP = (readFileSync(resolve(PUB, "../worker.js"), "utf8").match(/const PAGE_CSP = \[([\s\S]*?)\]\.join/) || [])[1];
const csp = CSP ? CSP.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).join("; ") : "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml" };
const sent = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname !== "/api/do") { res.end(url.pathname === "/api/data" ? DATA : JSON.stringify({ ok: true })); return; }
      const b = JSON.parse(body);
      sent.push(b);
      // like the Worker: the queued item, with an id like 1792058000000-0a1b2c3d
      res.end(JSON.stringify({ ok: true, item: { id: `${Date.now()}-0a1b2c${String(sent.length).padStart(2, "0")}`, kind: b.kind, at: new Date().toISOString(), data: b.data } }));
    });
    return;
  }
  const p = normalize(join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!p.startsWith(PUB) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream", ...(extname(p) === ".html" && csp ? { "Content-Security-Policy": csp } : {}) });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || join(execSync("npm root -g").toString().trim(), "playwright"));
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" })).newPage();
const problems = [];
const ok = (c, m) => (c ? console.log(`ok   ${m}`) : (problems.push(m), console.error(`FAIL ${m}`)));
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
await page.route("https://telegram.org/**", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}`));
  const noop = () => {};
  window.Telegram = { WebApp: { initData: "preview", colorScheme: "light", themeParams: {}, ready: noop, expand: noop, onEvent: noop, setHeaderColor: noop, setBackgroundColor: noop,
    showConfirm: (t, cb) => cb(true), HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop } } };
  try { localStorage.clear(); } catch { /* ignore */ }
});
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#tabs:not([hidden])");
const total = () => page.locator(".water-now b").textContent();
const mood = () => page.locator(".need").first().locator(".m").textContent();
const before = { total: await total(), water: await mood(), band: await page.locator(".pet-name .mood").textContent() };

await page.locator(".water-add").nth(1).click();          // a bottle, 500 ml
await page.waitForTimeout(250);
const d = sent[0];
ok(d && d.kind === "water" && d.data.ml === 500 && /^\d{4}-\d{2}-\d{2}$/.test(d.data.date) && /^\d{2}:\d{2}$/.test(d.data.time), "a tap queues 500 ml with today's date and time");
const after = { total: await total(), water: await mood() };
const L = (t) => Number(t.replace(" L", ""));
ok(Math.abs(L(after.total) - L(before.total) - 0.5) < 0.001, `the total goes up at once (${before.total} -> ${after.total})`);
ok(parseInt(after.water, 10) > parseInt(before.water, 10), `the pet's water need rises (${before.water} -> ${after.water})`);
const said = await page.locator(".pet-sec .bubble").textContent();
ok(/Gulp|refreshing|water|Splash/.test(said), `the pet says thanks ("${said}")`);
ok(await page.locator(".pet-sec .pet-puff .pet-pop-wrap").count() === 4, "and puffs droplets");
ok(/ · last 500 ml at \d{2}:\d{2}$/.test(await page.locator(".water-log .tiny").textContent()), "the new drink is the last one in today's list");
if (outDir) await page.screenshot({ path: join(outDir, "water-tap.png") });

// many drinks in a row: the card keeps its width (a long list once pushed it off screen)
for (let i = 0; i < 12; i++) { await page.locator(".water-add").first().click(); await page.waitForTimeout(60); }
const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: innerWidth,
  card: Math.max(...[...document.querySelectorAll(".sec")].map((x) => x.getBoundingClientRect().right)) }));
ok(wide.doc <= wide.view && wide.card <= wide.view, `after 12 more glasses nothing is pushed sideways (page ${wide.doc}, cards end at ${Math.round(wide.card)}, screen ${wide.view})`);
const n = await page.locator(".water-log .tiny").textContent();
ok(/^\d+ drinks · last 250 ml at \d{2}:\d{2}$/.test(n), `the list is a short summary ("${n}")`);
for (let i = 0; i < 12; i++) { await page.click(".water-log .textbtn"); await page.waitForTimeout(60); }

await page.click(".water-log .textbtn");                   // Undo last
await page.waitForTimeout(250);
const undo = sent[sent.length - 1];
ok(undo && undo.kind === "water_delete" && undo.data.id === `${undo.data.id}` && /^\d{13}-[0-9a-f]{8}$/.test(undo.data.id), "Undo queues the drink's removal by its id");
ok(await total() === before.total, `and the total is back (${await total()})`);

// a low mood has its own bag of tricks, and a thirsty pet fans itself
const low = await page.evaluate(async () => {
  const m = await import("/pet.js");
  const out = new Set(), lines = [];
  for (let i = 0; i < 40; i++) {
    const svg = m.drawPet("owl", { mood: 20, thirsty: true });
    document.body.append(svg);
    lines.push(m.poke(svg, "owl"));
    out.add([...svg.classList].find((c) => c.startsWith("trick-")));
    svg.remove();
  }
  return { tricks: [...out].sort(), lines };
});
const lowBag = ["trick-fan", "trick-melt", "trick-shiver", "trick-sigh", "trick-sulk", "trick-tear"];
ok(low.tricks.every((t) => lowBag.includes(t)) && low.tricks.length >= 5, `a low, thirsty pet answers a pat from its low bag (${low.tricks.join(", ")})`);
ok(low.lines.every((l) => typeof l === "string" && l.length), "and always says something");

await page.click(".pet-info");
await page.waitForSelector("#sheet:not([hidden])");
ok(/Half its mood is water/.test(await page.$eval("#sheet", (s) => s.textContent)), "the pet sheet says water is half its mood");
await page.keyboard.press("Escape");
await page.click('#tabs [data-tab="progress"]');
await page.waitForTimeout(300);
ok(/goal hit on/.test(await page.$eval("#view", (v) => v.textContent).catch(() => page.textContent("body"))), "Progress shows the water history");
if (outDir) await page.screenshot({ path: join(outDir, "water-progress.png"), fullPage: true });

await browser.close();
server.close();
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`); process.exit(1); }
console.log("\nThe water card works end to end.");
