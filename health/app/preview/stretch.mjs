// End-to-end check of stretching in the Health app, in Chromium with the real app.js and the
// Worker's CSP: today's workout ends with a cool-down stretch; the Stretching routine starts on
// its own; ✓ on a stretch runs its hold timer (first side, switch, second side) and ticks the
// set; Done ends a hold early; Finish sends the holds.
//
//   node health/app/preview/stretch.mjs <data.json> [screenshot-dir]

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dataPath, outDir] = process.argv.slice(2);
if (!dataPath) { console.error("usage: stretch.mjs <data.json> [screenshot-dir]"); process.exit(2); }
if (outDir) mkdirSync(outDir, { recursive: true });
const DATA = readFileSync(resolve(dataPath));
const PUB = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const CSP = (readFileSync(resolve(PUB, "../worker.js"), "utf8").match(/const PAGE_CSP = \[([\s\S]*?)\]\.join/) || [])[1];
const csp = CSP ? CSP.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).join("; ") : "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml" };
let finished = null;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (url.pathname === "/api/finish") finished = JSON.parse(body).workout;
      res.writeHead(200, { "Content-Type": "application/json" });
      // like the Worker: the queued item carries the workout's date, time and ticked sets
      const item = finished ? { id: "q1", kind: "workout", data: { date: finished.date, time: finished.time, sets: 1,
        blocks: finished.blocks.map((b) => ({ block: b.block, items: b.items.map((i) => ({ ex: i.ex, sets: i.sets.filter((s) => s.done).map((s) => ({ weight_kg: s.kg, reps: s.reps })) })) })) } } : null;
      res.end(url.pathname === "/api/data" ? DATA : JSON.stringify({ ok: true, item }));
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
await page.clock.install({ time: Date.parse("2026-10-20T19:00:00+08:00") });
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#tabs:not([hidden])");
await page.click("#tabs >> text=Train");
await page.waitForSelector(".routine");
const plans = await page.locator(".routine").allTextContents();
ok(/Standing Hamstring and Calf Stretch/.test(plans[0]) && /Knee-to-Wall Ankle Stretch/.test(plans[0]), "today's workout ends with a cool-down stretch");
ok(plans.length >= 2 && /Lying Hamstring Stretch/.test(plans[1]) && /Ankle Circles/.test(plans[1]), "the Stretching card lists the routine");
await page.locator("section", { has: page.locator("h2", { hasText: "Stretching" }) }).locator(".pillbtn").click();
await page.waitForSelector(".live-blk");
const names = await page.locator(".live-blk .ex .name").allTextContents();
ok(names.length === 5 && names[0] === "Ankle Circles", `the routine starts: ${names.join(", ")}`);
ok(await page.locator(".live-blk .rir .chip").count() === 0, "no 'reps left in the tank' on stretches");

// ✓ starts the hold: first side, switch sides, second side, then the set ticks itself
const first = page.locator(".live-blk").first().locator(".set").first();
await first.locator(".tick").click();
await page.waitForTimeout(100);
ok(/Hold · first side/.test(await page.textContent("#dock")), "✓ on a stretch starts the hold timer (first side)");
if (outDir) await page.screenshot({ path: join(outDir, "stretch-hold.png") });
await page.clock.fastForward(31000);
await page.waitForTimeout(100);
ok(/Switch sides/.test(await page.textContent("#dock")), "after 30 s: switch sides");
await page.clock.fastForward(4000);
await page.waitForTimeout(100);
ok(/Hold · second side/.test(await page.textContent("#dock")), "then the second side");
ok(!(await first.evaluate((e) => e.classList.contains("done"))), "the set isn't ticked until both sides are held");
await page.clock.fastForward(31000);
await page.waitForTimeout(200);
ok(await page.locator(".live-blk").first().locator(".set").first().evaluate((e) => e.classList.contains("done")), "both sides held: the set ticks itself");

// Done ends a hold early
const second = page.locator(".live-blk").nth(1).locator(".set").first();
await second.locator(".tick").click();
await page.waitForTimeout(100);
await page.click("#dock button >> text=Done");
await page.waitForTimeout(200);
ok(await page.locator(".live-blk").nth(1).locator(".set").first().evaluate((e) => e.classList.contains("done")), "Done ticks the set at once");

await page.click(".live-top .btn");
await page.waitForSelector("#sheet:not([hidden])", { timeout: 6000 });
const w = finished;
const holds = w.blocks.flatMap((b) => b.items.flatMap((i) => i.sets.filter((s) => s.done).map((s) => [i.ex, s.sec])));
ok(holds.length === 2 && holds[0][0] === "ankle_circles" && holds[0][1] === 30, `Finish sends the holds (${JSON.stringify(holds)})`);
if (outDir) await page.screenshot({ path: join(outDir, "stretch-done.png") });

await browser.close();
server.close();
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`); process.exit(1); }
console.log("\nStretching works end to end.");
