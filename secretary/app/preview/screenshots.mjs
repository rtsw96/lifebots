// Screenshot the Secretary app's tabs at 390x844, light and dark, and check for
// CSP violations, script errors and sideways scroll (at 360 and 390 wide).
//
//   node secretary/app/preview/screenshots.mjs <out-dir> [data.json] [now]
//
// data.json is what /api/data returns; the default is the made-up test/fixture.mjs,
// built around today with "now" at 10:30. For real data, build a file in a scratch
// folder outside the repo, never in it, and pass now (ISO) to match it.
// The page is served with the Worker's own CSP; Telegram is stubbed, the clock is
// fixed, and /api/* is answered from the file, so nothing leaves the machine.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixture } from "../test/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [outDir, dataPath, nowArg] = process.argv.slice(2);
if (!outDir) { console.error("usage: screenshots.mjs <out-dir> [data.json] [now]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const made = dataPath ? null : fixture();
const DATA = dataPath ? readFileSync(resolve(dataPath)) : JSON.stringify(made);
const nowIso = nowArg || (made ? made.now : new Date().toISOString());
const PUB = resolve(HERE, "../public");
const CSP = (readFileSync(resolve(PUB, "../worker.js"), "utf8").match(/const PAGE_CSP = \[([\s\S]*?)\]\.join/) || [])[1];
const csp = CSP ? CSP.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).join("; ") : "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    // a 1x1 PNG stands in for every receipt
    const RECEIPT = { ok: true, mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==" };
    res.end(url.pathname === "/api/data" ? DATA : url.pathname === "/api/google/start" ? JSON.stringify({ ok: true, url: "about:blank" })
      : url.pathname === "/api/receipt/view" ? JSON.stringify(RECEIPT) : JSON.stringify({ ok: true }));
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
  await page.clock.setFixedTime(new Date(nowIso));
  await page.addInitScript((sch) => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}: ${e.sample || e.blockedURI || ""}`));
    const noop = () => {};
    window.Telegram = { WebApp: { initData: "preview", colorScheme: sch, themeParams: {}, ready: noop, expand: noop, onEvent: noop, setHeaderColor: noop, openLink: noop } };
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

const click = (sel, i = 0) => async (p) => { const els = await p.$$(sel); if (els[i]) await els[i].click(); await p.waitForTimeout(100); };
const tabs = ["today", "week", "trends", "plan", "claims"];
for (const scheme of ["light", "dark"]) for (const t of tabs) await shot(`${t}-${scheme}`, { tab: t, scheme });
await shot("week-last-light", { tab: "week", act: click(".chips button", 1) });
await shot("day-sheet-light", { tab: "week", act: click(".grid7 .row", 2) });
await shot("event-sheet-dark", { scheme: "dark", act: click(".agenda .row.ev", 0) });
await shot("add-sheet-light", { tab: "plan", act: click(".row.slot", 0) });
await shot("claim-sheet-light", { tab: "claims", act: click(".card .rows .row", 2) });
await shot("claims-paid-dark", { tab: "claims", scheme: "dark", act: click(".controls .chips button", 3) });
await shot("plan-evening-dark", { tab: "plan", scheme: "dark", act: click(".chips button", 3) });
for (const t of tabs) await shot(`${t}-360`, { tab: t, width: 360, save: false });
await shot("add-sheet-360", { tab: "plan", width: 360, save: false, act: click(".row.slot", 0) });

await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${[...new Set(problems)].join("\n")}`);
  process.exit(1);
}
console.log("\nNo CSP violations, script errors or sideways scroll.");
