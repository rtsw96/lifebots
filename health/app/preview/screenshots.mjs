// Screenshot the Health app's tabs at 390x844, light and dark, and check for
// CSP violations, script errors and sideways scroll (at 360 and 390 wide).
//
//   node health/app/preview/screenshots.mjs <out-dir> <data.json>
//
// <data.json> is what /api/data returns ({snap, queue, draft, apple, oura, ...}).
// Build one in a scratch folder outside the repo, never in it:
//   python3 -c "import sys,json; sys.path.insert(0,'health/foodbot'); import app_sync; \
//     print(json.dumps({'ok': True, 'snap': app_sync.snapshot(), 'queue': [], 'draft': None}))" > /tmp/x/data.json
// The page is served with the Worker's own CSP; Telegram is stubbed and /api/* answered
// from the file, so nothing leaves the machine. Uses the machine's Playwright and Chromium.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outDir, dataPath] = process.argv.slice(2);
if (!outDir || !dataPath) { console.error("usage: screenshots.mjs <out-dir> <data.json>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const DATA = readFileSync(resolve(dataPath));
const PUB = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const CSP = (readFileSync(resolve(PUB, "../worker.js"), "utf8").match(/const PAGE_CSP = \[([\s\S]*?)\]\.join/) || [])[1];
const csp = CSP ? CSP.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).join("; ") : "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(url.pathname === "/api/data" ? DATA : JSON.stringify({ ok: true }));
    return;
  }
  const p = normalize(join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!p.startsWith(PUB) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream", ...(extname(p) === ".html" && csp ? { "Content-Security-Policy": csp } : {}) });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || join(execSync("npm root -g").toString().trim(), "playwright"));
const exe = existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const problems = [];

async function shot(name, { tab = "today", scheme = "light", width = 390, save = true, act = null, full = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name}: console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  await page.route("https://telegram.org/**", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.addInitScript((sch) => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}: ${e.sample || e.blockedURI || ""}`));
    const noop = () => {};
    window.Telegram = { WebApp: { initData: "preview", colorScheme: sch, themeParams: {}, ready: noop, expand: noop, onEvent: noop, setHeaderColor: noop, setBackgroundColor: noop, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop } } };
    try { localStorage.clear(); } catch { /* ignore */ }
  }, scheme);
  await page.goto(base);
  await page.waitForSelector("#tabs:not([hidden])");
  await page.evaluate(() => document.fonts.ready);
  if (tab !== "today") await page.click(`#tabs [data-tab="${tab}"]`);
  if (act) await act(page);
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) problems.push(`${name} @${width}: page scrolls sideways by ${over}px`);
  if (save) {
    const sheetOpen = await page.evaluate(() => !document.getElementById("sheet").hidden);
    const path = join(outDir, `${name}.png`);
    if (sheetOpen) {
      const h = await page.evaluate(() => document.querySelector(".sheet-card").scrollHeight + 40);
      await page.setViewportSize({ width, height: Math.max(844, Math.min(h, 4000)) });
      await page.evaluate(() => { document.querySelector(".sheet-card").style.maxHeight = "none"; });
      await page.screenshot({ path });
    } else {
      await page.screenshot({ path, fullPage: full });
    }
    console.log(path);
  }
  await ctx.close();
}

const start = async (p) => { await p.click("#fab"); await p.waitForTimeout(100); };
const firstTick = async (p) => { const t = await p.$(".set .tick"); if (t) await t.click(); await p.waitForTimeout(300); };
const tabs = ["today", "train", "food", "progress"];
for (const scheme of ["light", "dark"]) for (const t of tabs) await shot(`${t}-${scheme}`, { tab: t, scheme });
await shot("live-light", { act: start });
await shot("live-rest-dark", { scheme: "dark", full: false, act: async (p) => { await start(p); await firstTick(p); } });
await shot("live-rest-light", { full: false, act: async (p) => { await start(p); await firstTick(p); } });
await shot("resume-food-light", { tab: "food", full: false, act: async (p) => { await p.click("#tabs [data-tab=today]"); await start(p); await firstTick(p); await p.click("#tabs [data-tab=food]"); } });
await shot("pet-tap-light", { full: false, act: async (p) => {
  await p.waitForTimeout(1400); // let the hello-on-arrival trick finish, so the tap starts its own
  await p.click(".pet-tap");
  await p.waitForTimeout(350);
  const r = await p.evaluate(() => ({ poked: Boolean(document.querySelector("svg.pet").dataset.busy),
    hearts: document.querySelectorAll(".pet-puff .pet-pop-wrap").length, said: document.querySelector(".bubble").textContent,
    sheetOpen: !document.getElementById("sheet").hidden }));
  if (!r.poked || !r.hearts || r.sheetOpen || !r.said) problems.push(`pet tap: ${JSON.stringify(r)}`);
  else console.log(`pet tap ok: ${r.hearts} hearts, says "${r.said}"`);
} });
await shot("pet-sheet-light", { act: async (p) => { const b = await p.$(".pet-info"); if (b) await b.click(); } });
await shot("pet-sheet-dark", { scheme: "dark", act: async (p) => { const b = await p.$(".pet-info"); if (b) await b.click(); } });
await shot("meal-sheet-light", { tab: "food", act: async (p) => { const b = await p.$(".mealbtn, .mealline"); if (b) await b.click(); } });
await shot("exercise-sheet-dark", { tab: "train", scheme: "dark", act: async (p) => { const b = await p.$(".routine .ln"); if (b) await b.click(); } });
for (const t of tabs) await shot(`${t}-360`, { tab: t, width: 360, save: false });
await shot("live-360", { width: 360, save: false, act: start });

await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${[...new Set(problems)].join("\n")}`);
  process.exit(1);
}
console.log("\nNo CSP violations, script errors or sideways scroll.");
