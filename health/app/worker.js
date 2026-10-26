// Health app: a Cloudflare Worker serving the health bot's Telegram Mini App.
// Private: only the owner's Telegram account gets any data.
//
//   GET  /               the single-page app (public/, through the ASSETS binding)
//   POST /api/data       {initData} -> {snap, draft, queue}: the bot's snapshot, the
//                        workout in progress, and items still waiting for the bot
//   POST /api/draft      {initData, draft|null} -> save or clear the workout in progress
//   POST /api/finish     {initData, workout} -> queue a finished workout for the bot (and
//                        keep its set times 8 days, to match the Watch's heart rate)
//   POST /api/body       {initData, date, kg, waist} -> queue a weigh-in for the bot
//   POST /api/do         {initData, kind, data} -> queue a meal add/edit/delete, a checklist
//                        step or daily tick, or a drink of water for the bot
//   POST /api/sync       {op:"snapshot", ts, snap} from the bot session, signed
//   POST /api/queue      {op:"list", ts} -> the queued items (bot session, signed)
//   POST /api/queue/ack  {op:"ack", ts, ids} -> drop the ones now in the logs (signed)
//   POST /api/apple      Apple Health data from the Health Auto Export iPhone app,
//                        with header "X-Health-Key: <ingest key>"; summarised into KV
//   POST /api/apple/list {op:"apple", ts} -> the stored Apple summaries (bot session, signed)
//   POST /api/oura/start {initData} -> the Oura sign-in link (a one-time state in KV)
//   GET  /oura/callback  Oura sends the browser back here; the code becomes tokens in KV
//   POST /api/oura/pull  {initData} -> fetch the last week from Oura now
//   POST /api/oura/disconnect {initData} -> forget the Oura tokens (the summaries stay)
//   POST /api/oura/list  {op:"oura", ts} -> the stored Oura summaries (bot session, signed)
//   cron                 pulls the last few days from Oura twice each morning
//
// The git repo stays the record: health/foodbot/app_sync.py pushes the snapshot
// after each commit, writes queued items into the logs, and acks them. Bot
// requests are signed with HMAC_SHA256(key = HMAC_SHA256("HealthSync", bot
// token), msg = body), so the bot token is the only shared secret.
//
// The ingest key is HMAC_SHA256(key="HealthIngest", msg=bot token), hex, first
// 40 characters: no extra secret to store. app_sync.py sends it to the owner.
//
// Secrets: BOT_TOKEN (the health bot's token), OWNER_ID (the owner's Telegram id),
// OURA_CLIENT_ID and OURA_CLIENT_SECRET (the owner's own Oura API application).
// Var: TIMEZONE (IANA name, set by deploy.sh from settings.json).
// Nothing here logs request bodies or initData.

import { merge, summarise } from "./apple.js";
import * as Oura from "./oura.js";
import { writeAuth } from "./tokenbox.js";

const enc = new TextEncoder();
const DAY = 86400;
// Telegram initData is signed when the app opens; accept it for an hour, so a leaked
// copy (a screenshot, a log) can't be replayed for long. Reopening the app renews it.
const INIT_MAX_AGE = 3600;
const MAX_INIT = 16 * 1024;
const MAX_SNAP = 4 * 1024 * 1024;
const MAX_DRAFT = 96 * 1024;
const MAX_QUEUE = 60;
const SIGNED_WINDOW = 2 * 60 * 1000;
const EX_RE = /^[a-z0-9_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const ITEM_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;
const MAX_APPLE = 20 * 1024 * 1024; // a week of summarised metrics is small; routes are dropped

// ------------------------------------------------------------------ crypto
async function hmacKey(keyBytes, usage) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function hmac(keyBytes, msgBytes) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(keyBytes, "sign"), msgBytes));
}

async function hmacVerify(keyBytes, msgBytes, sigBytes) {
  return crypto.subtle.verify("HMAC", await hmacKey(keyBytes, "verify"), sigBytes, msgBytes);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex64(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Telegram WebApp initData check (same as the trip app). Returns {user} or null. */
export async function verifyInitData(initData, botToken, now = Math.floor(Date.now() / 1000), maxAge = INIT_MAX_AGE) {
  if (typeof initData !== "string" || !initData || initData.length > MAX_INIT || !botToken) return null;
  const params = new URLSearchParams(initData);
  const sig = fromHex64(params.get("hash"));
  if (!sig) return null;
  const pairs = [];
  const seen = new Set();
  for (const [k, v] of params) {
    if (k === "hash") continue;
    if (seen.has(k)) return null;
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const check = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  if (!(await hmacVerify(secret, enc.encode(check), sig))) return null;
  const auth = Number(params.get("auth_date"));
  if (!Number.isInteger(auth) || now - auth > maxAge || auth - now > 300) return null;
  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
  if (!user || !/^\d{1,20}$/.test(String(user.id))) return null;
  return { user };
}

export async function syncKey(botToken) {
  return hmac(enc.encode("HealthSync"), enc.encode(botToken));
}

export async function ingestKey(botToken) {
  return toHex(await hmac(enc.encode("HealthIngest"), enc.encode(botToken))).slice(0, 40);
}

function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signSync(botToken, bodyBytes) {
  return toHex(await hmac(await syncKey(botToken), bodyBytes));
}

// ---------------------------------------------------------------- responses
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors https://web.telegram.org https://*.telegram.org",
].join("; ");

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
  });
}

async function page(request, env) {
  if (!env.ASSETS) return new Response("Not deployed with assets", { status: 500, headers: BASE_HEADERS });
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  out.headers.set("Content-Security-Policy", PAGE_CSP);
  const path = new URL(request.url).pathname;
  // Exercise photos and fonts never change under the same name; everything else revalidates.
  out.headers.set("Cache-Control", /^\/(ex|fonts)\//.test(path) ? "public, max-age=604800" : "no-cache");
  return out;
}

async function readBody(request, limit) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > limit) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.length > limit ? null : buf;
}

/** Parse an app request and check it is the owner. Returns {body} or {res}. */
async function ownerBody(request, env, limit) {
  const raw = await readBody(request, limit + MAX_INIT);
  if (!raw) return { res: json({ error: "too large" }, 413) };
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { res: json({ error: "bad request" }, 400) };
  }
  const auth = await verifyInitData(body && body.initData, env.BOT_TOKEN);
  if (!auth) return { res: json({ error: "unauthorised: your Telegram sign-in has expired. Close the app and open it again from the chat." }, 401) };
  if (!env.OWNER_ID || String(auth.user.id) !== String(env.OWNER_ID).trim()) {
    return { res: json({ error: "This app is private." }, 403) };
  }
  return { body };
}

async function signedBody(request, env, op, limit = 64 * 1024) {
  const raw = await readBody(request, limit);
  if (!raw) return { res: json({ error: "too large" }, 413) };
  const sig = fromHex64(request.headers.get("X-Sync-Signature"));
  if (!sig || !(await hmacVerify(await syncKey(env.BOT_TOKEN), raw, sig))) {
    return { res: json({ error: "bad signature" }, 401) };
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { res: json({ error: "bad json" }, 400) };
  }
  const ts = Date.parse((body && body.ts) || "");
  if (!body || body.op !== op || !(Math.abs(Date.now() - ts) < SIGNED_WINDOW)) {
    return { res: json({ error: "bad request" }, 400) };
  }
  return { body, bytes: raw.length };
}

async function readQueue(env) {
  const q = await env.HEALTH.get("queue", "json");
  return Array.isArray(q) ? q : [];
}

const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const newId = () => `${Date.now()}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;

/** A finished workout from the app, reduced to what the bot needs. Returns the
 *  clean copy or an error string. */
export function cleanWorkout(w) {
  if (!w || typeof w !== "object") return "bad workout";
  if (!DATE_RE.test(w.date || "") || !TIME_RE.test(w.time || "")) return "bad date or time";
  if (!Array.isArray(w.blocks) || w.blocks.length > 12) return "bad blocks";
  let n = 0;
  const blocks = [];
  for (const b of w.blocks) {
    if (!b || !Array.isArray(b.items) || b.items.length > 6) return "bad block";
    const items = [];
    for (const it of b.items) {
      if (!it || !EX_RE.test(it.ex || "") || !Array.isArray(it.sets) || it.sets.length > 12) return "bad exercise";
      const sets = [];
      for (const s of it.sets) {
        if (!s || !s.done) continue; // only ticked sets count
        const out = {};
        if (s.kg != null) { if (!num(s.kg, 0, 500)) return "bad weight"; out.weight_kg = s.kg; }
        if (s.reps != null) { if (!num(s.reps, 0, 500) || !Number.isInteger(s.reps)) return "bad reps"; out.reps = s.reps; }
        if (s.sec != null) { if (!num(s.sec, 0, 7200)) return "bad time"; out.seconds = Math.round(s.sec); }
        if (!Object.keys(out).length) continue;
        // timing from the live workout: when it was ticked, its place in the order done,
        // the seconds since the previous set and the rest planned before it (all optional)
        if (num(s.at, 1.5e12, 2.5e12)) out.at = Math.round(s.at);
        if (Number.isInteger(s.seq) && s.seq > 0 && s.seq < 1000) out.seq = s.seq;
        if (Number.isInteger(s.gap) && s.gap >= 0 && s.gap <= 36000) out.gap_s = s.gap;
        if (Number.isInteger(s.plan) && s.plan >= 0 && s.plan <= 3600) out.plan_s = s.plan;
        sets.push(out);
        n++;
      }
      const item = { ex: it.ex, sets };
      if (Number.isInteger(it.rir) && it.rir >= 0 && it.rir <= 10) item.rir = it.rir; // reps left in the tank
      items.push(item);
    }
    blocks.push({ block: typeof b.block === "string" ? b.block.slice(0, 2) : "", items });
  }
  if (!n) return "No sets were ticked, so there's nothing to save.";
  const out = { date: w.date, time: w.time, blocks, sets: n };
  const edits = cleanEdits(w.edits);
  if (edits.length) out.edits = edits;
  return out;
}

/** The workout's edits (swaps, removals, additions), for the planner to learn from.
 *  Bad entries are dropped, never fatal: the sets matter more. */
export function cleanEdits(list) {
  if (!Array.isArray(list)) return [];
  const ex = (v) => (typeof v === "string" && EX_RE.test(v) ? v : null);
  const out = [];
  for (const e of list.slice(0, 40)) {
    if (!e || !["swap", "remove", "add", "split"].includes(e.kind)) continue;
    const c = { kind: e.kind, stage: e.stage === "plan" ? "plan" : "live" };
    if (typeof e.slot === "string" && /^[a-z_]{1,30}$/.test(e.slot)) c.slot = e.slot;
    if (ex(e.from)) c.from = e.from;
    if (ex(e.to)) c.to = e.to;
    if ((e.kind === "swap" && !(c.from && c.to)) || ((e.kind === "remove" || e.kind === "split") && !c.from) || (e.kind === "add" && !c.to)) continue;
    c.with = Array.isArray(e.with) ? e.with.map(ex).filter(Boolean).slice(0, 5) : [];
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- handlers
async function apiData(request, env, ctx) {
  const { res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const [snap, draft, queue, apple, appleLog, oura, ouraStatus, ouraAuth, pet] = await Promise.all([
    env.HEALTH.get("snap", "json"), env.HEALTH.get("draft", "json"), readQueue(env), env.HEALTH.get("apple", "json"),
    env.HEALTH.get("apple_log", "json"), env.HEALTH.get("oura", "json"), env.HEALTH.get("oura_status", "json"),
    env.HEALTH.get("oura_auth", "json"), env.HEALTH.get("pet", "json")]);
  // Opening the app refreshes Oura in the background when the last pull is over an hour old.
  if (ouraAuth && ctx && (!ouraStatus || Date.now() - Date.parse(ouraStatus.at) > 3600e3)) ctx.waitUntil(ouraRecent(env, 3));
  return json({
    ok: true, snap, draft, queue, apple, appleLog, oura, pet,
    ouraState: { ready: Boolean(env.OURA_CLIENT_ID && env.OURA_CLIENT_SECRET), connected: Boolean(ouraAuth), status: ouraStatus },
  });
}

// The pet the owner picked in the app, and its name. Nothing else is kept.
export const PET_SPECIES = ["owl", "cat", "penguin", "fox", "bunny", "frog"];
export function cleanPet(b) {
  const species = b && PET_SPECIES.includes(b.species) ? b.species : null;
  if (!species) return "bad species";
  const name = typeof b.name === "string" ? b.name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 20) : "";
  return { species, name: name || null };
}

async function apiPet(request, env) {
  const { body, res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const pet = cleanPet(body.pet);
  if (typeof pet === "string") return json({ error: pet }, 400);
  await env.HEALTH.put("pet", JSON.stringify(pet));
  return json({ ok: true, pet });
}

async function apiDraft(request, env) {
  const { body, res } = await ownerBody(request, env, MAX_DRAFT);
  if (res) return res;
  if (body.draft === null) {
    await env.HEALTH.delete("draft");
    return json({ ok: true, cleared: true });
  }
  if (!body.draft || typeof body.draft !== "object") return json({ error: "bad draft" }, 400);
  await env.HEALTH.put("draft", JSON.stringify(body.draft), { expirationTtl: 2 * DAY });
  return json({ ok: true });
}

async function queueItem(env, kind, data) {
  const queue = await readQueue(env);
  if (queue.length >= MAX_QUEUE) return json({ error: "Too much is waiting for the bot. Check the health bot is running." }, 429);
  const item = { id: newId(), kind, at: new Date().toISOString(), data };
  queue.push(item);
  await env.HEALTH.put("queue", JSON.stringify(queue));
  return json({ ok: true, id: item.id, item });
}

/** The set times of a finished workout, kept 8 days so the Watch's heart rate (which
 *  arrives later from Health Auto Export) can be matched to each exercise. */
export function stampOf(w) {
  const sets = [];
  for (const b of w.blocks) for (const it of b.items) for (const s of it.sets) {
    if (s.at) sets.push(s.seconds ? { ex: it.ex, at: s.at, sec: s.seconds } : { ex: it.ex, at: s.at });
  }
  return sets.length ? { wid: `${w.date}T${w.time.replace(":", "")}`, sets } : null;
}

export function keepStamps(list, add, now = Date.now()) {
  const cut = now - 8 * DAY * 1000;
  const old = (Array.isArray(list) ? list : []).filter((s) => s.wid !== add.wid && s.sets.some((x) => x.at > cut));
  return [add, ...old].slice(0, 12);
}

async function apiFinish(request, env) {
  const { body, res } = await ownerBody(request, env, MAX_DRAFT);
  if (res) return res;
  const w = cleanWorkout(body.workout);
  if (typeof w === "string") return json({ error: w }, 400);
  const out = await queueItem(env, "workout", w);
  if (out.status === 200) {
    await env.HEALTH.delete("draft");
    const stamp = stampOf(w);
    if (stamp) await env.HEALTH.put("hr_stamps", JSON.stringify(keepStamps(await env.HEALTH.get("hr_stamps", "json"), stamp)));
  }
  return out;
}

async function apiBody(request, env) {
  const { body, res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const kg = body.kg == null ? null : body.kg;
  const waist = body.waist == null ? null : body.waist;
  if (!DATE_RE.test(body.date || "")) return json({ error: "bad date" }, 400);
  if (kg === null && waist === null) return json({ error: "Enter a weight or a waist measurement." }, 400);
  if (kg !== null && !num(kg, 30, 250)) return json({ error: "Weight should be in kg, 30-250." }, 400);
  if (waist !== null && !num(waist, 40, 200)) return json({ error: "Waist should be in cm, 40-200." }, 400);
  return queueItem(env, "body", { date: body.date, time: TIME_RE.test(body.time || "") ? body.time : "", kg, waist });
}

const MEAL_NUM = { kcal: 6000, protein_g: 500, carbs_g: 1000, fat_g: 500, sat_fat_g: 300, fibre_g: 200, veg: 20, fruit: 20 };
const MEALS = ["breakfast", "lunch", "snack", "dinner", "supper", "drink"];
const PLAN_ID_RE = /^[a-z0-9_]{1,40}$/;

/** An app action, reduced to what the bot needs. Returns the clean data or an error string. */
export function cleanAction(kind, d) {
  if (!d || typeof d !== "object") return "bad request";
  const out = {};
  const nums = (required) => {
    for (const [k, max] of Object.entries(MEAL_NUM)) {
      if (d[k] == null || d[k] === "") { if (required.includes(k)) return `${k} is needed`; continue; }
      if (!num(Number(d[k]), 0, max)) return `${k} looks wrong`;
      out[k] = Math.round(Number(d[k]) * 10) / 10;
    }
    return null;
  };
  if (kind === "meal_add") {
    if (!DATE_RE.test(d.date || "") || !TIME_RE.test(d.time || "")) return "bad date or time";
    if (typeof d.desc !== "string" || !d.desc.trim() || d.desc.length > 300) return "Describe the meal (up to 300 characters).";
    const e = nums(["kcal", "protein_g", "carbs_g", "fat_g"]);
    if (e) return e;
    return { ...out, date: d.date, time: d.time, meal: MEALS.includes(d.meal) ? d.meal : null, desc: d.desc.trim() };
  }
  if (kind === "meal_edit" || kind === "meal_delete") {
    if (!/^\d{1,7}$/.test(String(d.id || ""))) return "bad meal id";
    if (kind === "meal_delete") return { id: String(d.id) };
    if (d.desc != null && (typeof d.desc !== "string" || !d.desc.trim() || d.desc.length > 300)) return "Describe the meal (up to 300 characters).";
    const e = nums([]);
    if (e) return e;
    return { ...out, id: String(d.id), ...(d.desc != null ? { desc: d.desc.trim() } : {}) };
  }
  if (kind === "plan_task") {
    if (!PLAN_ID_RE.test(d.id || "") || (d.date && !DATE_RE.test(d.date))) return "bad task";
    return { id: d.id, done: Boolean(d.done), date: d.date || null };
  }
  if (kind === "habit") {
    if (!PLAN_ID_RE.test(d.habit || "") || !DATE_RE.test(d.date || "")) return "bad tick";
    return { habit: d.habit, date: d.date, done: Boolean(d.done) };
  }
  if (kind === "water") {
    if (!DATE_RE.test(d.date || "") || !TIME_RE.test(d.time || "")) return "bad date or time";
    if (!Number.isInteger(d.ml) || d.ml < 50 || d.ml > 2000) return "Water is 50 to 2,000 ml at a time.";
    return { date: d.date, time: d.time, ml: d.ml };
  }
  // undo a drink: its id is the queue item's id (tapped in the app) or c<ms> (logged by chat)
  if (kind === "water_delete") return ITEM_ID_RE.test(d.id || "") || /^c\d{13}$/.test(d.id || "") ? { id: d.id } : "bad water id";
  return "unknown action";
}

async function apiDo(request, env) {
  const { body, res } = await ownerBody(request, env, 4096);
  if (res) return res;
  const data = cleanAction(body.kind, body.data);
  if (typeof data === "string") return json({ error: data }, 400);
  return queueItem(env, body.kind, data);
}

async function apiSync(request, env) {
  const { body, bytes, res } = await signedBody(request, env, "snapshot", MAX_SNAP);
  if (res) return res;
  const s = body.snap;
  if (!s || !Array.isArray(s.sets) || !s.food || !Date.parse(s.generated_at || "")) return json({ error: "bad snapshot" }, 400);
  const old = await env.HEALTH.get("snap", "json");
  if (old && Date.parse(old.generated_at) > Date.parse(s.generated_at)) return json({ error: "stale snapshot" }, 409);
  await env.HEALTH.put("snap", JSON.stringify(s));
  return json({ ok: true, bytes });
}

async function apiQueue(request, env) {
  const { res } = await signedBody(request, env, "list");
  if (res) return res;
  return json({ ok: true, items: await readQueue(env) });
}

async function apiQueueAck(request, env) {
  const { body, res } = await signedBody(request, env, "ack");
  if (res) return res;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && ITEM_ID_RE.test(x)) : [];
  if (!ids.length || ids.length > 100) return json({ error: "bad ids" }, 400);
  const drop = new Set(ids);
  const queue = await readQueue(env);
  const keep = queue.filter((it) => !drop.has(it.id));
  if (keep.length) await env.HEALTH.put("queue", JSON.stringify(keep));
  else await env.HEALTH.delete("queue");
  return json({ ok: true, removed: queue.length - keep.length });
}

/** The last few sync attempts (time, automation, result, size; never the data),
 *  so the app can say why nothing is arriving. */
async function noteAttempt(env, request, status, note, extra = {}) {
  const log = (await env.HEALTH.get("apple_log", "json")) || [];
  log.unshift({
    at: new Date().toISOString(), status, note,
    automation: (request.headers.get("automation-name") || "").slice(0, 60) || null,
    bytes: Number(request.headers.get("Content-Length") || 0) || null, ...extra,
  });
  await env.HEALTH.put("apple_log", JSON.stringify(log.slice(0, 10)));
}

/** Health Auto Export posts here on its schedule. Only summaries are stored: a
 *  workout's per-minute heart rate becomes each exercise's average and max, then goes. */
async function apiApple(request, env) {
  const given = request.headers.get("X-Health-Key") || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given) {
    await noteAttempt(env, request, 401, "no X-Health-Key header");
    return json({ error: "unauthorised: add the header X-Health-Key" }, 401);
  }
  if (!sameString(given.trim(), await ingestKey(env.BOT_TOKEN))) {
    await noteAttempt(env, request, 401, "wrong key");
    return json({ error: "unauthorised: wrong key" }, 401);
  }
  const raw = await readBody(request, MAX_APPLE);
  if (!raw) {
    await noteAttempt(env, request, 413, "too large");
    return json({ error: "too large: turn off route data, or turn on Batch Requests" }, 413);
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    await noteAttempt(env, request, 400, "not JSON");
    return json({ error: "bad json: choose JSON as the export format" }, 400);
  }
  const add = summarise(body, await env.HEALTH.get("hr_stamps", "json"));
  await noteAttempt(env, request, 200, "ok", { workouts: add.workouts.length, days: Object.keys(add.days).length });
  const stored = await env.HEALTH.get("apple", "json");
  const next = merge(stored, add, new Date().toISOString().slice(0, 10));
  next.updated_at = new Date().toISOString();
  await env.HEALTH.put("apple", JSON.stringify(next));
  return json({ ok: true, workouts: add.workouts.length, days: Object.keys(add.days).length });
}

// ---------------------------------------------------------------- Oura
const ouraRedirect = (url) => `${url.origin}/oura/callback`;
/** The local date (YYYY-MM-DD) n days ago, in the owner's timezone (TIMEZONE, from deploy.sh). */
export function localDate(tz, n = 0, now = Date.now()) {
  const at = new Date(now - n * 86400e3);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  }
}

async function ouraRecent(env, n) {
  if (!(env.OURA_CLIENT_ID && env.OURA_CLIENT_SECRET)) return { error: "not configured" };
  return Oura.pull(env, localDate(env.TIMEZONE, n), localDate(env.TIMEZONE));
}

async function apiOuraStart(request, env) {
  const { res } = await ownerBody(request, env, 1024);
  if (res) return res;
  if (!(env.OURA_CLIENT_ID && env.OURA_CLIENT_SECRET)) return json({ error: "The Oura app keys aren't set up yet." }, 503);
  const state = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await env.HEALTH.put("oura_state", state, { expirationTtl: 900 });
  return json({ ok: true, url: Oura.authorizeUrl(env.OURA_CLIENT_ID, ouraRedirect(new URL(request.url)), state) });
}

function note(title, text, status = 200) {
  const esc = (x) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:17px/1.5 -apple-system,system-ui,sans-serif;background:#151515;color:#f2f2f0;padding:32px 20px;max-width:520px;margin:auto"><h1 style="font-size:24px">${esc(title)}</h1><p>${esc(text)}</p></body>`, {
    status, headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}

/** Oura sends the browser here after the owner approves. Only a state this
 *  Worker handed to the owner's signed-in app is accepted, once. */
async function ouraCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const want = await env.HEALTH.get("oura_state");
  if (!want || !sameString(state, want)) return note("Link expired", "Start again from the health app: Today, Body, Connect Oura.", 400);
  await env.HEALTH.delete("oura_state");
  if (url.searchParams.get("error")) return note("Oura not connected", "Access wasn't granted. You can try again from the health app.", 400);
  const code = url.searchParams.get("code");
  if (!code || code.length > 512) return note("Oura not connected", "Oura didn't send a code. Try again from the health app.", 400);
  const r = await Oura.exchangeCode(env, code, ouraRedirect(url));
  if (r.error) return note("Oura not connected", `Oura refused the sign-in (${String(r.error).slice(0, 60)}). Try again from the health app.`, 502);
  await writeAuth(env, env.HEALTH, "oura_auth", r.auth);
  // The last 30 days of history come in at once.
  const p = await Oura.pull(env, localDate(env.TIMEZONE, 30), localDate(env.TIMEZONE));
  return note("Oura connected", p.ok ? `Done: ${p.days} days of sleep and readiness came in. Go back to Telegram and reopen the app.`
    : "Connected. The first download didn't finish; the app will try again when you open it.");
}

async function apiOuraPull(request, env) {
  const { res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const r = await ouraRecent(env, 7);
  if (r.error) return json({ error: r.error }, 502);
  return json({ ok: true, days: r.days, oura: await env.HEALTH.get("oura", "json") });
}

async function apiOuraDisconnect(request, env) {
  const { res } = await ownerBody(request, env, 1024);
  if (res) return res;
  await env.HEALTH.delete("oura_auth");
  await env.HEALTH.put("oura_status", JSON.stringify({ at: new Date().toISOString(), ok: false, note: "disconnected" }));
  return json({ ok: true });
}

async function apiOuraList(request, env) {
  const { res } = await signedBody(request, env, "oura");
  if (res) return res;
  return json({ ok: true, oura: (await env.HEALTH.get("oura", "json")) || { days: {} } });
}

async function apiAppleList(request, env) {
  const { res } = await signedBody(request, env, "apple");
  if (res) return res;
  return json({ ok: true, apple: (await env.HEALTH.get("apple", "json")) || { workouts: {}, days: {} } });
}

export default {
  async scheduled(event, env, ctx) {
    if (await env.HEALTH.get("oura_auth")) ctx.waitUntil(ouraRecent(env, 4));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/oura/callback" && request.method === "GET") {
      if (!env.BOT_TOKEN || !env.OURA_CLIENT_ID) return note("Not set up", "Oura isn't configured for this app yet.", 503);
      return ouraCallback(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      const route = {
        "/api/data": apiData, "/api/pet": apiPet, "/api/draft": apiDraft, "/api/finish": apiFinish, "/api/body": apiBody, "/api/do": apiDo,
        "/api/sync": apiSync, "/api/queue": apiQueue, "/api/queue/ack": apiQueueAck,
        "/api/apple": apiApple, "/api/apple/list": apiAppleList,
        "/api/oura/start": apiOuraStart, "/api/oura/pull": apiOuraPull, "/api/oura/disconnect": apiOuraDisconnect,
        "/api/oura/list": apiOuraList,
      }[url.pathname];
      if (!route) return json({ error: "not found" }, 404);
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
      if (!env.BOT_TOKEN) return json({ error: "not configured" }, 503);
      return route(request, env, ctx);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...BASE_HEADERS, Allow: "GET, HEAD" } });
    }
    return page(request, env);
  },
};
