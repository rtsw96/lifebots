// End-to-end check of the Knowledge app in Chromium, with the real app code, the Worker's CSP, bundles
// built by app_sync.py exactly as the bot uploads them, and a stand-in for the Worker's API.
//
//   node knowledge/app/preview/e2e.mjs [screenshot-dir]
//
// Two runs:
//   1. A fresh install: the repo's own empty learn/ and vault/. The Learn tab asks what to learn; a
//      topic sent from it is queued for the bot; the Library says the vault is empty.
//   2. The test fixture (preview/fixture/: a tiny made-up track and vault, never shipped as content).
//      It opens; the Learn tab shows Blue, the session and the paths; a placement test runs and
//      places you; a lesson plays end to end (teach, drills, match, the end screen) and saves progress
//      (XP, streak, cards); side strands, furigana and reading drills work; the Library searches the
//      vault, opens a note with backlinks and a graph, approves a draft (queued); the You tab shows
//      the league and badges. No CSP violations, script errors or sideways scroll, light and dark.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PUB = resolve(HERE, "../public");
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });

/** The bundles for a learn folder and a vault, exactly as the bot uploads them. */
function bundlesFor(learn, vault) {
  const out = execSync(`python3 -c "
import sys,json,base64; sys.path.insert(0,'knowledge/bot'); import app_sync as a
out={}
for n,b in (('vault',a.vault_bundle),('learn',a.learn_bundle)):
    blob,ver=a.pack(b()); out[n]={'v':ver,'b':base64.b64encode(blob).decode()}
print(json.dumps(out))"`, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, KNOWLEDGE_LEARN: learn, KNOWLEDGE_VAULT: vault } }).toString();
  const b = JSON.parse(out);
  return { blobs: { vault: Buffer.from(b.vault.b, "base64"), learn: Buffer.from(b.learn.b, "base64") }, meta: { vault: { v: b.vault.v, notes: 0 }, learn: { v: b.learn.v } } };
}

const CSP = (readFileSync(resolve(HERE, "../worker.js"), "utf8").match(/export const PAGE_CSP = \[([\s\S]*?)\]\.join/) || [])[1]
  .split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).join("; ");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };

/** A stand-in for the Worker: the app's files with its CSP, and the owner's API over in-memory state. */
async function serve({ blobs, meta }) {
  const state = { progress: null, rev: 0, queue: [], saves: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const b = body ? JSON.parse(body) : {};
        const send = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
        if (url.pathname === "/api/data") return send({ ok: true, meta, progress: state.progress, rev: state.rev, queue: state.queue });
        if (url.pathname === "/api/blob") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(blobs[b.name]); }
        if (url.pathname === "/api/progress") {
          if (b.rev !== state.rev) return send({ error: "stale", rev: state.rev }, 409);
          state.progress = b.progress; state.rev++; state.saves++;
          return send({ ok: true, rev: state.rev });
        }
        if (url.pathname === "/api/do") { const item = { id: `${Date.now()}-0a1b2c3d`, kind: b.kind, data: b.data }; state.queue.push(item); return send({ ok: true, item }); }
        send({ error: "nope" }, 404);
      });
      return;
    }
    const p = normalize(join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
    if (!p.startsWith(PUB) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream", ...(extname(p) === ".html" ? { "Content-Security-Policy": CSP } : {}) });
    res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(0, r));
  return { server, state, url: `http://localhost:${server.address().port}/` };
}

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || join(execSync("npm root -g").toString().trim(), "playwright"));
const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const problems = [];
const ok = (c, m) => (c ? console.log(`ok   ${m}`) : (problems.push(m), console.error(`FAIL ${m}`)));

async function newPage(url, scheme = "light") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.route("https://telegram.org/**", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP blocked ${e.violatedDirective}`));
    const noop = () => {};
    window.Telegram = { WebApp: { initData: "preview", ready: noop, expand: noop, onEvent: noop, openLink: noop, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop } } };
    // count the chimes: each note is one oscillator
    const Real = window.AudioContext;
    window.__notes = 0;
    window.AudioContext = class extends Real { createOscillator() { window.__notes++; return super.createOscillator(); } };
  });
  await page.goto(url);
  await page.waitForSelector("#tabs:not([hidden])");
  return page;
}
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const shot = async (page, name, full = false) => { if (outDir) await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: full }); };

// ------------------------------------------------------------------ 1. a fresh install (what ships)
{
  const fresh = await serve(bundlesFor(join(ROOT, "knowledge/learn"), join(ROOT, "knowledge/vault")));
  const page = await newPage(fresh.url);
  await page.waitForSelector(".welcome", { timeout: 15000 });
  ok(/What do you want to learn\?/.test(await page.textContent(".welcome")), "Fresh install: the Learn tab asks what to learn");
  ok(await page.locator(".owl-card .pet").count() === 1, "Fresh install: Blue is there");
  await shot(page, "fresh-learn", true);
  await page.click(".welcome .btn >> text=Start learning");
  ok(fresh.state.queue.length === 0, "Fresh install: an empty topic is not sent");
  await page.fill(".welcome textarea", "Spanish for a trip");
  await page.click(".welcome .pill >> text=New to it");
  await page.click(".welcome .btn >> text=Start learning");
  await page.waitForTimeout(300);
  ok(fresh.state.queue.some((q) => q.kind === "topic" && q.data.text === "Spanish for a trip" && q.data.level === "New to it"), "Fresh install: the topic is queued for the bot");
  ok(/being written/.test(await page.textContent(".welcome")) && /Spanish for a trip/.test(await page.textContent(".welcome")), "Fresh install: the topic shows as being written");
  await shot(page, "fresh-waiting", true);
  await page.click('#tabs [data-tab="library"]');
  await page.waitForSelector("text=Nothing here yet", { timeout: 15000 });
  ok(true, "Fresh install: the Library says the vault is empty");
  await page.click('#tabs [data-tab="me"]');
  await page.waitForSelector(".badges");
  ok(/Learn something new/.test(await page.textContent("#view")), "Fresh install: You has Learn something new");
  ok(!(await wide(page)), "Fresh install: no sideways scroll");
  await page.context().close();
  fresh.server.close();
}

// ------------------------------------------------------------------ 2. the test fixture
const fx = await serve(bundlesFor(join(HERE, "fixture/learn"), join(HERE, "fixture/vault")));
const state = fx.state;
const page = await newPage(fx.url);
await page.waitForSelector(".owl-card", { timeout: 15000 });
ok(await page.locator(".owl-card .pet").count() === 1, "Learn: Blue the owl is there");
ok(/Today's session/.test(await page.textContent(".session")), "Learn: today's session card");
ok(await page.locator(".trk").count() === 2, "Learn: two topics (the fixture's)");
await shot(page, "learn-light", true);

// a placement test, answered (true every time), for the ideas track
await page.click(".session .pill >> text=Ideas");
await page.waitForSelector("#stage:not([hidden])");
await page.click("#stage .btn >> text=Start");
for (let i = 0; i < 16; i++) {
  if (await page.locator("#stage .end").count()) break;
  const opt = page.locator("#stage .opt").first();
  if (await opt.count()) await opt.click();
  const check = page.locator("#stage .btn >> text=Check");
  if (await check.count() && await check.isEnabled()) await check.click();
  if (!(await page.locator("#stage .btn >> text=Continue").count())) {
    console.error("stuck on:", (await page.textContent("#stage")).slice(0, 300));
    await shot(page, "stuck");
    break;
  }
  await page.click("#stage .btn >> text=Continue");
}
ok(/Placed!/.test(await page.textContent("#stage")), `Placement: placed (${(await page.textContent("#stage .end .prompt")).trim()})`);
await shot(page, "placement-done");
await page.click("#stage .btn >> text=Continue");
await page.waitForTimeout(300);
ok(state.queue.some((q) => q.kind === "curriculum" && q.data.track === "ideas"), "Placement: a band with no units yet asks the bot for them");

// a lesson: the first kana lesson, answering right
await page.click(".trk >> text=Demo");
await page.click(".node.next");
await page.waitForSelector("#stage:not([hidden])");
await page.waitForTimeout(500);
await shot(page, "lesson-teach");
const map = { "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o", "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko" };
const inv = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
let steps = 0;
let shotMcq = false, shotStreak = false;
let rightCount = 0, pops = 0, bursts = 0;
const combos = [], milestones = [];
while (steps++ < 60) {
  if (!shotMcq && await page.locator("#stage .opt").count() && !(await page.locator("#stage .match").count())) { await shot(page, "lesson-mcq"); shotMcq = true; }
  if (await page.locator("#stage .end").count()) break;
  const stage = page.locator("#stage");
  if (await stage.locator(".teach").count()) { await page.click("#stage .btn >> text=Continue"); continue; }
  if (await stage.locator(".match").count()) {
    const lefts = await stage.locator(".match .col").first().locator(".opt").allTextContents();
    for (const l of lefts) {
      await stage.locator(".match .col").first().locator(".opt", { hasText: l }).click();
      await stage.locator(".match .col").last().locator(".opt").filter({ hasText: new RegExp(`^${map[l]}$`) }).click();
      await page.waitForTimeout(120);
    }
    await page.waitForSelector("#stage .feedback", { timeout: 3000 });
    await page.click("#stage .btn >> text=Continue");
    continue;
  }
  const prompt = await stage.locator(".prompt").first().textContent();
  const opts = stage.locator(".opt");
  const texts = await opts.allTextContents();
  let pick = 0;
  const show = (await stage.locator(".show").count()) ? (await stage.locator(".show").first().textContent()).trim() : null;
  const quoted = (prompt.match(/"([^"]+)"/) || [])[1];
  if (show && map[show]) pick = texts.indexOf(map[show]);
  else if (quoted && inv[quoted]) pick = texts.indexOf(inv[quoted]);
  await opts.nth(Math.max(0, pick)).click();
  await page.click("#stage .btn >> text=Check");
  const fb = await stage.locator(".feedback").getAttribute("class");
  if (/\bok\b/.test(fb)) {
    rightCount++;
    if (await stage.locator(".burst").count()) bursts++;
    if (/\bpop\b/.test(fb)) pops++;
    const c = (await stage.locator(".combo").textContent()).trim();
    if (c) combos.push(c);
    if (/streak/.test(fb)) { milestones.push((await stage.locator(".feedback h3").textContent()).trim()); if (!shotStreak) { await shot(page, "lesson-streak"); shotStreak = true; } }
  }
  await page.click("#stage .btn >> text=Continue");
}
ok(rightCount >= 3 && pops === rightCount && bursts === rightCount, `Lesson: every right answer pops and bursts confetti (${rightCount} right, ${pops} pops, ${bursts} bursts)`);
ok(combos.includes("🔥2") && combos.includes("🔥3"), `Lesson: the answer streak counts up in the top bar (${combos.slice(0, 4).join(", ")}…)`);
ok(milestones.includes("🔥 3 in a row!"), `Lesson: 3 in a row flares (${milestones.join(", ")})`);
ok(await page.evaluate(() => window.__notes) >= rightCount * 2, `Lesson: a chime per right answer (${await page.evaluate(() => window.__notes)} notes)`);
ok(/complete|Perfect/.test(await page.textContent("#stage")), "Lesson: reached the end screen");
await shot(page, "lesson-end");
await page.click("#stage .btn >> text=Continue");
await page.waitForTimeout(1600);
ok(state.saves >= 1 && state.progress && Object.keys(state.progress.lessons || {}).includes("demo-01-1"), "Lesson: progress saved to the server (lesson done)");
ok(state.progress && state.progress.streak.count === 1 && Object.values(state.progress.xp)[0] > 0, `Lesson: streak 1 and XP ${state.progress && Object.values(state.progress.xp)[0]}`);
ok(state.progress && Object.keys(state.progress.cards).filter((c) => c.startsWith("demo-k-")).length === 5, "Lesson: five kana cards scheduled");
ok(state.progress.tracks.ideas && state.progress.tracks.ideas.placed, "Placement saved");
ok(/1/.test(await page.textContent(".stat-chip.flame")), "Header: the streak shows 1");

// an idea's questions never assume you remember it: Recap the idea shows the card again
await page.click(".trk >> text=Ideas");
await page.click(".node.next");
await page.waitForSelector("#stage:not([hidden])");
ok(await page.locator("#stage .teach .sources a").count() >= 1, "Ideas: the idea card shows its sources");
await shot(page, "idea-teach");
for (let i = 0; i < 4 && await page.locator("#stage .teach").count(); i++) {
  await page.click("#stage .btn >> text=Continue");
  await page.waitForTimeout(200);
}
const recap = page.locator("#stage .recap");
ok(await recap.count() === 1, "Ideas: a question on an idea card has Recap the idea");
await recap.click();
ok(/The idea/.test(await page.textContent("#sheet")) && await page.locator("#sheet .teach").count() === 1, "Ideas: Recap opens the idea in a sheet");
await shot(page, "recap");
await page.evaluate(() => { document.getElementById("sheet").hidden = true; });
await page.click("#stage .stage-top .x");
await page.waitForTimeout(300);

// side strands: Words (furigana over kanji, on and off) and Reading (kana, no furigana)
await page.click(".trk >> text=Demo");
const strandNames = await page.locator(".chips.strands .pill").allTextContents();
ok(["Path", "Reading", "Words"].every((s) => strandNames.some((x) => x.startsWith(s))), `Strands: a pill per strand, named by its unit (${strandNames.join(", ")})`);
const openStrand = async (name) => {
  await page.click(`.chips.strands .pill >> text=${name}`);
  await page.click(".node.next");
  await page.waitForSelector("#stage:not([hidden])");
  await page.waitForTimeout(300);
};
const rubyOnTeach = async () => {
  for (let i = 0; i < 3 && !(await page.locator("#stage .teach .ja rt").count()); i++) {
    if (!(await page.locator("#stage .teach").count())) break;
    await page.click("#stage .btn >> text=Continue");
    await page.waitForTimeout(200);
  }
  return page.locator("#stage .teach .ja rt").count();
};
const quit = async () => { await page.click("#stage .stage-top .x"); await page.waitForTimeout(300); };
await openStrand("Words");
ok(await rubyOnTeach() > 0, "Words: kanji carry furigana on the teaching card");
ok(!(await page.locator("#stage .ja.furi-hidden").count()), "Words: furigana show by default");
await shot(page, "words-teach");
await quit();
await page.evaluate(() => localStorage.setItem("kb.furigana", JSON.stringify("off")));
await openStrand("Words");
await rubyOnTeach();
const hidden = page.locator("#stage .ja.furi-hidden").first();
ok(await hidden.count() === 1 && await hidden.locator("rt").first().evaluate((e) => getComputedStyle(e).visibility) === "hidden", "Furigana off: readings are hidden");
await hidden.click();
ok(await hidden.locator("rt").first().evaluate((e) => getComputedStyle(e).visibility) === "visible", "Furigana off: a tap peeks at the reading");
await quit();
await page.evaluate(() => localStorage.setItem("kb.furigana", JSON.stringify("on")));
await openStrand("Reading");
ok(/Kana only/.test(await page.textContent("#view")), "Reading: the strand's own about line shows");
// Back: after Continue on the lesson's intro, Back brings it up again
const firstCard = (await page.textContent("#stage .stage-body")).trim();
ok(!(await page.locator("#stage .foot-pair .back").count()), "Back: no Back button on the first card");
await page.click("#stage .btn >> text=Continue");
await page.waitForTimeout(200);
ok(await page.locator("#stage .foot-pair .back").count() === 1, "Back: a Back button once a card is passed");
await shot(page, "back-button");
await page.click("#stage .foot-pair .back");
await page.waitForTimeout(200);
ok((await page.textContent("#stage .stage-body")).trim() === firstCard, "Back: it shows the card again");
for (let i = 0; i < 15 && !(await page.locator("#stage .show.readme").count()); i++) {
  if (!(await page.locator("#stage .btn >> text=Continue").count())) break;
  await page.click("#stage .btn >> text=Continue");
  await page.waitForTimeout(150);
}
ok(await page.locator("#stage .show.readme").count() === 1, "Reading: a kana reading drill comes up");
ok(await page.locator("#stage .show.readme rt").count() === 0 && !(await page.locator("#stage .show.readme").evaluate((e) => /[㐀-鿿]/.test(e.textContent))), "Reading: no kanji and no furigana in the drill");
ok(await page.locator("#stage .speak").count() === 0, "Reading: no audio before answering");
await shot(page, "reading-drill");
await quit();
await page.click(".chips.strands .pill >> text=Path");

// the library
await page.click('#tabs [data-tab="library"]');
await page.waitForSelector(".search input", { timeout: 20000 });
await page.fill(".search input", "seasons");
await page.waitForTimeout(500);
const hits = await page.locator(".sec .item").count();
ok(hits >= 2, `Library: search finds ${hits} notes`);
await shot(page, "library-search");
await page.locator(".sec .item", { hasText: "Seasons come from axial tilt" }).first().click();
await page.waitForSelector(".notehead");
ok(await page.locator(".prose p").count() > 0, "Library: a note renders");
ok(await page.locator(".graph svg circle").count() > 1, "Library: the local graph draws");
await shot(page, "note", true);
const wikis = await page.locator(".prose a.wiki:not(.missing)").count();
if (wikis) { await page.locator(".prose a.wiki:not(.missing)").first().click(); await page.waitForTimeout(200); ok(await page.locator(".notehead").count() === 1, "Library: a [[link]] opens the linked note"); }
await page.click(".crumbs .textbtn");
await page.click(".crumbs .textbtn").catch(() => {});
await page.fill(".search input", "");
await page.waitForTimeout(300);
ok(/People, places and things/.test(await page.textContent("#view")), "Library: entities have their own list");
await page.click("text=Review queue");
await page.waitForSelector(".actionbar");
await page.click(".actionbar >> text=Approve");
await page.waitForTimeout(300);
ok(state.queue.some((q) => q.kind === "note_status" && q.data.status === "reviewed"), "Library: approving a draft queues it for the bot");
await shot(page, "review");

// the you tab
await page.click('#tabs [data-tab="me"]');
await page.waitForSelector(".badges");
ok(await page.locator(".badge.got").count() >= 1, "You: a badge is earned (first lesson)");
ok(/league/.test(await page.textContent("#view")), "You: the league shows");
ok(/Furigana/.test(await page.textContent("#view")), "You: the furigana setting shows for a Japanese track");
await shot(page, "you", true);
ok(!(await wide(page)), "no sideways scroll (light)");

const dark = await newPage(fx.url, "dark");
await dark.waitForSelector(".owl-card", { timeout: 15000 });
await shot(dark, "learn-dark", true);
await dark.click('#tabs [data-tab="library"]');
await dark.waitForSelector(".search input", { timeout: 20000 });
await shot(dark, "library-dark", true);
ok(!(await wide(dark)), "no sideways scroll (dark)");

await browser.close();
fx.server.close();
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`); process.exit(1); }
console.log("\nThe Knowledge app works end to end. No CSP violations or script errors.");
