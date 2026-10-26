// End-to-end check of the Money app's demo mode in a real browser (Chromium via
// Playwright), against the real app.js and the Worker's CSP:
//   1. a paired phone opens its own (synthetic fixture) data;
//   2. demo mode is turned on with a PIN: made-up data, no /api request at all;
//   3. a reload stays in demo; wrong PINs are refused and lock after five;
//   4. the right PIN brings the phone's own data back.
//
//   node finance/app/preview/demo-mode.mjs [screenshot-dir]
//
// /api/* is answered here: the phone's public key is taken from its /api/device
// call and the fixture is sealed for it with the app's own crypto.js, so the
// page decrypts exactly as it does in production. Nothing leaves the machine.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewServer } from "./serve.mjs";
import { fingerprint, seal } from "../public/crypto.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, "../test/fixture.json"), "utf8"));
const DEMO = JSON.parse(readFileSync(resolve(HERE, "../public/demo.json"), "utf8"));

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || join(execSync("npm root -g").toString().trim(), "playwright"));
const exe = existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;

const server = previewServer();
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
const page = await ctx.newPage();
const problems = [];
const fail = (m) => { problems.push(m); console.error(`FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`ok   ${m}`) : fail(m));
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") fail(`console: ${m.text()}`); });
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}`));
  const noop = () => {};
  window.Telegram = { WebApp: { initData: "preview", colorScheme: "light", ready: noop, expand: noop, onEvent: noop, isVersionAtLeast: () => false } };
});
await page.route("https://telegram.org/**", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));

let device = null;
const apiCalls = [];
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  apiCalls.push(path);
  const body = JSON.parse(route.request().postData() || "{}");
  let out = { ok: true };
  if (path === "/api/device") {
    device = { id: await fingerprint(body.pub), pub: body.pub };
    out = { ok: true, status: "approved" };
  } else if (path === "/api/data") {
    out = { ok: true, device: "approved", sealed: await seal(FIXTURE, [device]), queue: [] };
  }
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(out) });
});
const netWorth = () => page.evaluate(() => document.querySelector(".big") && document.querySelector(".big").textContent);
const shot = async (n) => { if (outDir) await page.screenshot({ path: join(outDir, `${n}.png`), fullPage: false }); };
const waitTabs = () => page.waitForSelector("#tabs:not([hidden])");
const fmt = (x) => Math.round(x).toLocaleString("en-SG");

// 1. the phone's own data
await page.goto(base);
await waitTabs();
const own = await netWorth();
ok(own && own.includes(fmt(FIXTURE.net_worth)), `real mode shows the fixture's net worth (${own})`);
ok(await page.isVisible("#demo-on") && !(await page.isVisible("#demo-badge")), "real mode: Demo mode button shown, no Demo badge");

// 2. turn demo mode on
await page.click("#demo-on");
await page.fill("#pin1", "2468");
await page.fill("#pin2", "2469");
await page.click("button:has-text(\"Turn on demo mode\")");
ok((await page.textContent(".err")).includes("don't match"), "mismatched PINs are refused");
await page.fill("#pin1", "12");
await page.fill("#pin2", "12");
await page.click("button:has-text(\"Turn on demo mode\")");
ok((await page.textContent(".err")).includes("4 to 8"), "a too-short PIN is refused");
await shot("demo-on-sheet");
await page.fill("#pin1", "2468");
await page.fill("#pin2", "2468");
apiCalls.length = 0;
await Promise.all([page.waitForNavigation(), page.click("button:has-text(\"Turn on demo mode\")")]);
await waitTabs();
const demoNw = await netWorth();
ok(demoNw && demoNw.includes(fmt(DEMO.net_worth)) && !demoNw.includes(fmt(FIXTURE.net_worth)), `demo shows the made-up net worth (${demoNw})`);
ok(await page.isVisible("#demo-badge") && !(await page.isVisible("#demo-on")) && !(await page.isVisible("#refresh")), "demo: badge shown, Demo mode and Refresh hidden");
ok((await page.textContent("#sub")).includes("Demo"), "the header says Demo");
await shot("demo-overview");
for (const t of ["day", "flows", "recurring", "spending", "holdings"]) {
  await page.click(`#tabs [data-tab="${t}"]`);
  await page.waitForTimeout(80);
}
ok(apiCalls.length === 0, `no /api request in demo mode (${apiCalls.join(", ") || "none"})`);

// 3. a reload stays in demo; wrong PINs lock
await page.reload();
await waitTabs();
ok((await netWorth()).includes(fmt(DEMO.net_worth)) && apiCalls.length === 0, "a reload stays in demo, still with no /api request");
await page.click("#demo-badge");
for (let i = 1; i <= 5; i++) {
  await page.fill("#pin0", "0000");
  await page.click("button:has-text(\"Leave demo mode\")");
  await page.waitForFunction((n) => /Wrong PIN|Locked/.test(document.querySelector("#sheet .err").textContent) && !document.querySelector("#pin0").value, i);
}
const locked = await page.textContent(".err");
ok(/Locked for 30 s/.test(locked), `five wrong PINs lock it (${locked})`);
await page.fill("#pin0", "2468");
await page.click("button:has-text(\"Leave demo mode\")");
await page.waitForTimeout(400);
ok(/Too many tries/.test(await page.textContent(".err")) && (await page.isVisible("#demo-badge")), "even the right PIN waits out the lock");
await shot("demo-off-locked");
// skip the wait: wind the lock back, as if 30 s had passed
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("finance-keys", 1);
  r.onsuccess = () => {
    const tx = r.result.transaction("keys", "readwrite");
    const st = tx.objectStore("keys");
    const g = st.get("demo");
    g.onsuccess = () => { st.put({ ...g.result, until: 0 }, "demo"); };
    tx.oncomplete = res;
  };
}));

// 4. the right PIN
await page.fill("#pin0", "2468");
await Promise.all([page.waitForNavigation(), page.click("button:has-text(\"Leave demo mode\")")]);
await waitTabs();
ok((await netWorth()).includes(fmt(FIXTURE.net_worth)) && !(await page.isVisible("#demo-badge")), "the right PIN brings the phone's own data back");
ok(apiCalls.includes("/api/data"), "and only then is the sealed snapshot fetched again");

await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nDemo mode works end to end.");
