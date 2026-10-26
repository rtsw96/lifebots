// Screenshot every tab of the Money app at 390x844, light and dark, and check
// for CSP violations, script errors and horizontal scroll (at 360 and 390 wide).
//
//   node finance/app/preview/screenshots.mjs <out-dir> [data-dir] [file.json]
//
// Defaults to the synthetic fixture in ../test. To check real numbers, pass a
// scratch folder holding a snapshot as data-dir: never save one in the repo.
// Uses the Playwright install on this machine (global, or PLAYWRIGHT_PATH) and
// its preinstalled Chromium; it never downloads a browser.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { previewServer } from "./serve.mjs";

const [outDir, dataDir, file = "fixture.json"] = process.argv.slice(2);
if (!outDir) { console.error("usage: screenshots.mjs <out-dir> [data-dir] [file.json]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_PATH || join(execSync("npm root -g").toString().trim(), "playwright");
const { chromium } = require(pwPath);
const exe = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);

const server = previewServer(dataDir ? resolve(dataDir) : undefined);
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/preview/views.html?data=/data/${file}`;

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const problems = [];
async function shot(name, params, { scheme = "light", width = 390, full = true, save = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name}: console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}: ${e.blockedURI || e.sample || ""}`)));
  await page.goto(`${base}&${params}`);
  await page.waitForSelector("body[data-ready]");
  await page.evaluate(() => document.fonts.ready);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) problems.push(`${name} @${width}: page scrolls sideways by ${over}px`);
  if (save) {
    const sheetOpen = await page.evaluate(() => !document.getElementById("sheet").hidden);
    const path = join(outDir, `${name}.png`);
    if (sheetOpen) {
      // the sheet scrolls on its own: grow the viewport to show all of it
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

const tabs = ["overview", "day", "flows", "recurring", "spending", "holdings"];
for (const scheme of ["light", "dark"]) {
  for (const t of tabs) await shot(`${t}-${scheme}`, `tab=${t}&scheme=${scheme}`, { scheme });
}
await shot("flows-groups-light", "tab=flows&mode=groups&flow=last3", {});
await shot("flows-sheet-smaller-light", "tab=flows&flow=last3&node=Smaller categories", {});
await shot("flows-all-dark", "tab=flows&flow=all&scheme=dark", { scheme: "dark" });
await shot("flows-sheet-account-light", "tab=flows&node=Bank A", {});
await shot("flows-sheet-category-dark", "tab=flows&flow=last3&node=Tax&scheme=dark", { scheme: "dark" });
await shot("spending-line-sheet-light", "tab=spending&sheet=line", {});
await shot("day-ex-travel-light", "tab=day&travel=ex", {});
for (const tr of ["fun", "shopping", "travel"]) await shot(`day-${tr}-light`, `tab=day&tracker=${tr}&month=2026-08`, {});
await shot("spending-group-day-light", "tab=spending&sheet=group&group=Day-to-day", {});
await shot("spending-group-day-dark", "tab=spending&sheet=group&group=Day-to-day&scheme=dark", { scheme: "dark" });
await shot("spending-category-light", "tab=spending&sheet=category&cat=", {});
await shot("recurring-item-light", "tab=recurring&sheet=rec", {});
await shot("recurring-month-dark", "tab=recurring&sheet=recmonth&col=3&scheme=dark", { scheme: "dark" });
await shot("recurring-insurance-light", "tab=recurring&sec=insurance", {});
for (const t of tabs) await shot(`${t}-360`, `tab=${t}`, { width: 360, save: false });
await shot("flows-groups-360", "tab=flows&mode=groups", { width: 360, save: false });

await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("\nNo CSP violations, script errors or sideways scroll.");
