// End-to-end check of a live workout in the Health app, in Chromium with the real
// app.js and the Worker's CSP: an edited set carries on to the sets still to do,
// cards move up and down, ticks are stamped (time, order, gap, planned rest), the
// "reps left in the tank" prompt appears once an exercise is done, and Finish sends
// all of it and shows the summary.
//
//   node health/app/preview/live-workout.mjs <data.json> [screenshot-dir]

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dataPath, outDir] = process.argv.slice(2);
if (!dataPath) { console.error("usage: live-workout.mjs <data.json> [screenshot-dir]"); process.exit(2); }
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
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("#tabs:not([hidden])");
await page.click("#fab");
await page.waitForSelector(".live-blk");

// 1. an edit carries on to the later undone sets of the same exercise
const card = (i) => page.locator(".live-blk").nth(i);
const ex0 = () => card(0).locator(".ex").nth(0);
const labels = await ex0().locator(".set .no").allTextContents();
const first = labels.findIndex((x) => x !== "W");
const reps = ex0().locator('input[data-f="reps"]');
await reps.nth(first).fill("7");
await reps.nth(first).dispatchEvent("change");
const after = await reps.evaluateAll((els) => els.map((e) => e.value));
ok(after.slice(first).every((v) => v === "7"), `editing a set's reps to 7 changes the later undone sets too (${after.join(",")})`);

// 2. cards move: the second card goes up and takes the letter A
const names = await page.locator(".live-blk").evaluateAll((bs) => bs.map((b) => b.querySelector(".name").textContent));
await card(1).locator("button.mv").first().click();
await page.waitForTimeout(150);
const moved = await page.locator(".live-blk").evaluateAll((bs) => bs.map((b) => `${b.querySelector(".name").textContent} ${b.querySelector(".letter").textContent}`));
ok(moved[0] === `${names[1]} A` && moved[1] === `${names[0]} B`, `moving card 2 up swaps it to A (${moved.slice(0, 2).join(" | ")})`);
if (outDir) await page.screenshot({ path: join(outDir, "live-moved.png") });

// 2b. one exercise moves on its own: out of a superset with the Move sheet, then dragged
const layout = () => page.locator(".live-blk").evaluateAll((bs) => bs.map((b) => [...b.querySelectorAll(".ex .name")].map((n) => n.textContent)));
let split = false;
const before = await layout();
const sup = before.findIndex((names) => names.length > 1);
if (sup >= 0) {
  await card(sup).locator(".ex").nth(1).locator("button.act", { hasText: /^\s*Move\s*$/ }).click();
  await page.click("#sheet:not([hidden]) #sheet-body button >> text=On its own");
  await page.waitForTimeout(150);
  const after = await layout();
  split = true;
  ok(after.length === before.length + 1 && after[sup].length === before[sup].length - 1 && after[sup + 1].length === 1 && after[sup + 1][0] === before[sup][1],
    `Move → On its own takes one exercise out of its superset (${after.map((x) => x.join("+")).join(" | ")})`);
}
const dragTo = async (handle, target, where = "top") => {
  const a = await handle.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, where === "top" ? b.y + 6 : b.y + b.height - 6, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};
await page.setViewportSize({ width: 390, height: 7000 }); // the whole workout on screen: the drags need no scrolling
await page.evaluate(() => window.scrollTo(0, 0));
const n0 = await layout();
// (card A stays put: the steps below work on it)
await dragTo(page.locator(".live-blk").last().locator(".blk .grip"), card(1));
const n1 = await layout();
ok(JSON.stringify(n1[1]) === JSON.stringify(n0[n0.length - 1]) && JSON.stringify(n1[0]) === JSON.stringify(n0[0]) && n1.length === n0.length,
  "dragging a card by ≡ onto the second card puts it second");
const lone = n1.findIndex((names, k) => k > 0 && names.length === 1);
const other = lone === n1.length - 1 ? n1.length - 2 : n1.length - 1;
await dragTo(card(lone).locator(".ex .grip").first(), card(other).locator(".ex").first(), "bottom");
const n2 = await layout();
ok(n2.length === n1.length - 1 && n2.some((names) => names.length === n1[other].length + 1 && names.includes(n1[lone][0])),
  `dragging an exercise onto another card's exercise joins it as a superset (${n2.map((x) => x.join("+")).join(" | ")})`);
await page.setViewportSize({ width: 390, height: 844 });
if (outDir) await page.screenshot({ path: join(outDir, "live-regrouped.png") });

// 3. tick every set of the (new) first card; the reps-in-reserve prompt appears and takes a tap
const ticks = ex0().locator(".tick");
const nTicks = await ticks.count();
for (let i = 0; i < nTicks; i++) { await ticks.nth(i).click(); await page.waitForTimeout(150); }
ok(await ex0().locator(".rir .chip").count() === 6, "after the last set, 'Reps left in the tank?' shows on the card");
const chip = page.locator("#dock .dock-rir .chip").nth(2);
ok(await chip.isVisible(), "and in the rest timer, where the timer can't hide it");
if (outDir) { await page.waitForTimeout(700); await page.screenshot({ path: join(outDir, "live-rir.png") }); }
await chip.click();
ok(await page.locator("#dock .dock-rir").count() === 0 && await ex0().locator('.rir .chip[aria-pressed="true"]').textContent() === "2",
  "answering in the timer closes the question and marks the card");

// 3b. edits on the last card are recorded: a swap (if the slot has options), a removal, an addition
const lastCard = () => page.locator(".live-blk").last();
const swapBtn = lastCard().locator("button.act", { hasText: "Swap" }).first();
const swapped = await swapBtn.count();
if (swapped) {
  await swapBtn.click();
  await page.locator("#sheet:not([hidden]) #sheet-body button").first().click();
  await page.waitForTimeout(150);
}
await lastCard().locator("button.act", { hasText: "Remove" }).first().click();
await page.waitForTimeout(150);
await page.click("text=Add an exercise");
await page.locator("#sheet:not([hidden]) #sheet-body button").first().click();
await page.waitForTimeout(150);

// 4. Finish: the payload carries the stamps and the RIR; the summary opens
await page.click(".live-top .btn");
await page.waitForSelector("#sheet:not([hidden]) .done-order", { timeout: 6000 }).catch(async () => { console.error("sheet:", await page.$eval("#sheet", (s) => s.hidden + " " + s.textContent.slice(0, 200))); console.error(problems.join("\n")); process.exit(1); });
const w = finished;
const sets = w.blocks[0].items[0].sets.filter((s) => s.done);
ok(sets.length === nTicks && sets.every((s, i) => s.at && s.seq === i + 1), "each ticked set has a time and its place in the order");
ok(sets[0].gap == null && sets.slice(1).every((s) => Number.isInteger(s.gap)), "the gap is measured from the second set on");
ok(sets.slice(1).every((s) => Number.isInteger(s.plan) && s.plan >= 0), `the planned rest before each set is kept (0 = straight on to a superset partner) (${sets.map((s) => s.plan).join(",")})`);
ok(w.blocks[0].items[0].rir === 2, "reps left in the tank (2) is sent with the exercise");
const kinds = (w.edits || []).map((e) => e.kind);
ok(JSON.stringify(kinds) === JSON.stringify([...(split ? ["split"] : []), ...(swapped ? ["swap"] : []), "remove", "add"]) && w.edits.every((e) => e.stage === "live"),
  `the split, swap, removal and addition go with the workout (${kinds.join(", ")})`);
const sw = w.edits.find((e) => e.kind === "swap");
ok(!swapped || (sw.from && sw.to && sw.from !== sw.to), "a swap keeps what it replaced and what it became");
const sp = w.edits.find((e) => e.kind === "split");
ok(!split || (sp.from && sp.with.length >= 1), "a split keeps what moved out and what it left");
const sum = await page.$eval("#sheet", (s) => s.textContent);
ok(/Workout done/.test(sum) && /In the order you did them/.test(sum) && /2 in the tank/.test(sum) && /nothing is counted twice/.test(sum), "the summary shows the order, the reps in the tank and the Watch note");
if (outDir) { await page.waitForTimeout(900); await page.screenshot({ path: join(outDir, "summary.png") }); }

await browser.close();
server.close();
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`); process.exit(1); }
console.log("\nThe live workout works end to end.");
