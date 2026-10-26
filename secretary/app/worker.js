// Secretary app: a Cloudflare Worker serving the secretary bot's Telegram Mini App.
// Private: only the owner's Telegram account gets any data.
//
//   GET  /                     the single-page app (public/, through the ASSETS binding)
//   POST /api/data             {initData} -> {events, google, health, rules, targets, claims, settings}; the
//                              calendar is re-read from Google when the copy is over 3 minutes old
//   POST /api/refresh          {initData} -> re-read the calendar now
//   POST /api/event            {initData, op: add|move|delete, ...} -> change Google Calendar.
//                              Anything can be added; only events made here can be moved or deleted
//   POST /api/google/start     {initData} -> the Google sign-in link (a one-time state in KV)
//   GET  /google/callback      Google sends the browser back here; the code becomes tokens in KV
//   POST /api/google/disconnect {initData} -> forget the Google tokens and the cached events
//   POST /api/receipt/view     {initData, id} -> {mime, data}: a claim's receipt, for the owner's app
//   POST /api/sync             {op:"push", ts, health, rules, targets, claims, settings} from the repo, signed
//   POST /api/events           {op:"events", ts} -> the cached calendar (bot session, signed)
//   POST /api/slots            {op:"slots", ts, minutes, part, n} -> open slots and free evenings (bot, signed)
//   POST /api/add              {op:"add", ts, title, date, start, minutes, details?, location?} -> add to Google Calendar (bot, signed)
//   POST /api/edit             {op:"edit", ts, id, ...} -> change an event this app made (bot, signed)
//   POST /api/remove           {op:"remove", ts, id} -> delete an event this app made (bot, signed)
//   POST /api/receipt          {op:"receipt", ts, id, mime, data} -> keep a receipt image (bot, signed)
//   POST /api/receipt/get      {op:"receipt_get", ts, id} -> {mime, data} (bot, signed: for claim packs)
//   POST /api/receipt/delete   {op:"receipt_delete", ts, id} (bot, signed: deleted claims, 60 days after paid)
//
// Receipts are claim evidence: kept in KV under "r:<claim id>" (base64, 3 MB at most),
// readable only by the owner's app and the bot, and deleted by the repo's purge.
//
// Bot requests are signed with HMAC_SHA256(key = HMAC_SHA256("SecretarySync", bot
// token), msg = body), so the bot token is the only shared secret with the repo.
// Secrets: BOT_TOKEN (the secretary bot's token), OWNER_ID (the owner's Telegram id),
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the owner's own Google OAuth client),
// TOKEN_KEY (seals the Google sign-in in KV). Settings (timezone, home currency,
// public-holiday calendar) come from the repo's settings.json through /api/sync.
// Nothing here logs request bodies, initData or calendar contents.

import * as G from "./google.js";
import * as M from "./public/model.js";
import { writeAuth } from "./tokenbox.js";

const enc = new TextEncoder();
const DAY = 86400;
// Telegram initData is signed when the app opens; accept it for an hour, so a leaked
// copy (a screenshot, a log) can't be replayed for long. Reopening the app renews it.
const INIT_MAX_AGE = 3600;
const MAX_INIT = 16 * 1024;
const MAX_SYNC = 2 * 1024 * 1024;
const SIGNED_WINDOW = 2 * 60 * 1000;
const STALE_MS = 3 * 60e3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLAIM_ID_RE = /^\d{8}-[0-9a-f]{6}$/;
const RECEIPT_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_RECEIPT_B64 = 4 * 1024 * 1024 + 4;

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

/** Telegram WebApp initData check (same as the other apps). Returns {user} or null. */
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
  try { user = JSON.parse(params.get("user") || "null"); } catch { return null; }
  if (!user || !/^\d{1,20}$/.test(String(user.id))) return null;
  return { user };
}

export async function syncKey(botToken) {
  return hmac(enc.encode("SecretarySync"), enc.encode(botToken));
}
export async function signSync(botToken, bodyBytes) {
  return toHex(await hmac(await syncKey(botToken), bodyBytes));
}
function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------------- responses
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-origin",
};
export const PAGE_CSP = [
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
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", ...extra },
  });
}

async function page(request, env) {
  if (!env.ASSETS) return new Response("Not deployed with assets", { status: 500, headers: BASE_HEADERS });
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  out.headers.set("Content-Security-Policy", PAGE_CSP);
  out.headers.set("Cache-Control", /^\/fonts\//.test(new URL(request.url).pathname) ? "public, max-age=604800" : "no-cache");
  return out;
}

function note(title, text, status = 200) {
  const esc = (x) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:17px/1.5 -apple-system,system-ui,sans-serif;background:#f2f0f7;color:#1d1a2a;padding:32px 20px;max-width:520px;margin:auto"><h1 style="font-size:24px">${esc(title)}</h1><p>${esc(text)}</p></body>`, {
    status, headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}

async function readBody(request, limit) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > limit) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.length > limit ? null : buf;
}

/** Parse an app request and check it is the owner. Returns {body} or {res}. */
async function ownerBody(request, env, limit = 2048) {
  const raw = await readBody(request, limit + MAX_INIT);
  if (!raw) return { res: json({ error: "too large" }, 413) };
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return { res: json({ error: "bad request" }, 400) }; }
  const auth = await verifyInitData(body && body.initData, env.BOT_TOKEN);
  if (!auth) return { res: json({ error: "unauthorised: your Telegram sign-in has expired. Close the app and open it again from the chat." }, 401) };
  if (!env.OWNER_ID || String(auth.user.id) !== String(env.OWNER_ID).trim()) return { res: json({ error: "This app is private." }, 403) };
  return { body };
}

async function signedBody(request, env, op, limit = 64 * 1024) {
  const raw = await readBody(request, limit);
  if (!raw) return { res: json({ error: "too large" }, 413) };
  const sig = fromHex64(request.headers.get("X-Sync-Signature"));
  if (!sig || !(await hmacVerify(await syncKey(env.BOT_TOKEN), raw, sig))) return { res: json({ error: "bad signature" }, 401) };
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return { res: json({ error: "bad json" }, 400) }; }
  const ts = Date.parse((body && body.ts) || "");
  if (!body || body.op !== op || !(Math.abs(Date.now() - ts) < SIGNED_WINDOW)) return { res: json({ error: "bad request" }, 400) };
  return { body };
}

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = { timezone: M.DEFAULT_ZONE, currency: "SGD", holidays: "" };
const HOLIDAY_RE = /^[A-Za-z0-9._-]{1,80}#holiday@group\.v\.calendar\.google\.com$/;

/** The owner's settings as pushed from settings.json, checked; defaults for anything missing or odd. */
export function cleanSettings(x) {
  const out = { ...DEFAULT_SETTINGS };
  if (!x || typeof x !== "object") return out;
  if (typeof x.timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(x.timezone)) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: x.timezone }); out.timezone = x.timezone; } catch { /* unknown zone */ }
  }
  if (typeof x.currency === "string" && /^[A-Z]{3}$/.test(x.currency)) out.currency = x.currency;
  if (typeof x.holidays === "string" && HOLIDAY_RE.test(x.holidays)) out.holidays = x.holidays;
  return out;
}

/** Read the settings and set the model's timezone for this request. */
async function settings(env) {
  const s = cleanSettings(await env.TIME.get("settings", "json"));
  M.setZone(s.timezone);
  return s;
}

// ---------------------------------------------------------------- calendar
const googleReady = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const redirect = (url) => `${url.origin}/google/callback`;

/** The cached calendar, re-read from Google first when it's stale (or `force`). */
async function events(env, force = false) {
  const cached = await env.TIME.get("events", "json");
  const fresh = cached && Date.now() - Date.parse(cached.fetched_at) < STALE_MS;
  if ((fresh && !force) || !googleReady(env) || !(await env.TIME.get("google_auth"))) return { events: cached };
  const s = await settings(env);
  const r = await G.pull(env, { tz: s.timezone, holidays: s.holidays });
  if (r.error) {
    await env.TIME.put("google_status", JSON.stringify({ at: new Date().toISOString(), ok: false, note: r.error }));
    return { events: cached, error: r.error };
  }
  await env.TIME.put("google_status", JSON.stringify({ at: new Date().toISOString(), ok: true }));
  return { events: r.events };
}

async function apiData(request, env) {
  const { res } = await ownerBody(request, env);
  if (res) return res;
  const ev = await events(env);
  const [health, rules, targets, status, auth, claims, s] = await Promise.all([
    env.TIME.get("health", "json"), env.TIME.get("rules", "json"), env.TIME.get("targets", "json"),
    env.TIME.get("google_status", "json"), env.TIME.get("google_auth"), env.TIME.get("claims", "json"), settings(env)]);
  return json({
    ok: true, now: new Date().toISOString(), events: ev.events || { items: [] }, health, rules, targets, claims, settings: s,
    google: { ready: googleReady(env), connected: Boolean(auth), status, error: ev.error || null },
  });
}

async function apiRefresh(request, env) {
  const { res } = await ownerBody(request, env);
  if (res) return res;
  const ev = await events(env, true);
  if (ev.error) return json({ error: ev.error, events: ev.events }, 502);
  return json({ ok: true, events: ev.events });
}

const MAX_DETAILS = 4000;
const MAX_LOCATION = 300;

/** The optional free text of an add or edit: a description (agenda, meeting ID,
 *  passcode; line breaks kept) and a location. "" clears one on an edit. */
function cleanText(b, out) {
  if (b.details !== undefined) {
    if (typeof b.details !== "string") return "bad details";
    const d = b.details.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
    if (d.length > MAX_DETAILS) return `Details must be under ${MAX_DETAILS} characters`;
    out.details = d;
  }
  if (b.location !== undefined) {
    if (typeof b.location !== "string") return "bad location";
    const l = b.location.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (l.length > MAX_LOCATION) return `A location must be under ${MAX_LOCATION} characters`;
    out.location = l;
  }
  return null;
}

const cleanTitle = (t) => (typeof t === "string" ? t.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "");

/** Validate an add or move from the app. Returns the clean fields or an error string.
 *  `today` is the owner's local date (the model's zone, set from the settings). */
export function cleanEvent(b, today = M.localDate(Date.now())) {
  const out = {};
  if (b.op === "add") {
    const title = cleanTitle(b.title);
    if (!title || title.length > 120) return "A title of 1 to 120 characters is needed";
    out.title = title;
    const bad = cleanText(b, out);
    if (bad) return bad;
  }
  if (!DATE_RE.test(b.date || "")) return "bad date";
  const d = Date.parse(`${b.date}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(d) || d < t - 7 * DAY * 1e3 || d > t + 400 * DAY * 1e3) return "That date is out of range";
  if (!TIME_RE.test(b.start || "")) return "bad start time";
  if (!Number.isInteger(b.minutes) || b.minutes < 5 || b.minutes > 12 * 60) return "Duration must be 5 minutes to 12 hours";
  return { ...out, date: b.date, start: b.start, minutes: b.minutes };
}

/** Validate an edit from the bot: any of title, time (date, start and minutes
 *  together), details and location. Returns the clean fields or an error string. */
export function cleanEdit(b, today) {
  if (!(typeof b.id === "string" && b.id && b.id.length <= 200)) return "bad id";
  const out = {};
  if (b.title !== undefined) {
    const title = cleanTitle(b.title);
    if (!title || title.length > 120) return "A title of 1 to 120 characters is needed";
    out.title = title;
  }
  if (b.date !== undefined || b.start !== undefined || b.minutes !== undefined) {
    const c = cleanEvent({ date: b.date, start: b.start, minutes: b.minutes }, today);
    if (typeof c === "string") return c;
    Object.assign(out, c);
  }
  const bad = cleanText(b, out);
  if (bad) return bad;
  if (!Object.keys(out).length) return "Nothing to change";
  return out;
}

async function apiEvent(request, env) {
  const { body, res } = await ownerBody(request, env);
  if (res) return res;
  if (!googleReady(env) || !(await env.TIME.get("google_auth"))) return json({ error: "Connect Google Calendar first." }, 409);
  const { timezone: tz } = await settings(env);
  const op = body.op;
  let r;
  if (op === "add" || op === "move") {
    const c = cleanEvent(body);
    if (typeof c === "string") return json({ error: c }, 400);
    if (op === "move" && !(typeof body.id === "string" && body.id.length <= 200)) return json({ error: "bad id" }, 400);
    r = op === "add" ? await G.insert(env, c, { tz }) : await G.move(env, body.id, c, { tz });
  } else if (op === "delete") {
    if (!(typeof body.id === "string" && body.id && body.id.length <= 200)) return json({ error: "bad id" }, 400);
    r = await G.remove(env, body.id);
  } else return json({ error: "bad op" }, 400);
  if (r.error) return json({ error: r.error }, 502);
  const ev = await events(env, true); // show the change at once
  return json({ ok: true, event: r.event || null, events: ev.events });
}

async function apiGoogleStart(request, env) {
  const { res } = await ownerBody(request, env);
  if (res) return res;
  if (!googleReady(env)) return json({ error: "The Google keys aren't set up yet." }, 503);
  const state = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await env.TIME.put("google_state", state, { expirationTtl: 900 });
  return json({ ok: true, url: G.authorizeUrl(env.GOOGLE_CLIENT_ID, redirect(new URL(request.url)), state) });
}

/** Google sends the browser here after the owner approves. Only a state this
 *  Worker handed to the owner's signed-in app is accepted, once. */
async function googleCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const want = await env.TIME.get("google_state");
  if (!want || !sameString(state, want)) return note("Link expired", "Start again from the Secretary app: Connect Google Calendar.", 400);
  await env.TIME.delete("google_state");
  if (url.searchParams.get("error")) return note("Not connected", "Access wasn't granted. You can try again from the Secretary app.", 400);
  const code = url.searchParams.get("code");
  if (!code || code.length > 1024) return note("Not connected", "Google didn't send a code. Try again from the Secretary app.", 400);
  const r = await G.exchangeCode(env, code, redirect(url));
  if (r.error) return note("Not connected", `Google refused the sign-in (${String(r.error).slice(0, 60)}). Try again from the Secretary app.`, 502);
  await writeAuth(env, env.TIME, "google_auth", r.auth);
  const s = await settings(env);
  const p = await G.pull(env, { tz: s.timezone, holidays: s.holidays });
  return note("Google Calendar connected", p.ok ? `Done: ${p.events.items.length} events came in. Go back to Telegram and reopen the app.`
    : "Connected. The first read didn't finish; the app will try again when you open it.");
}

async function apiGoogleDisconnect(request, env) {
  const { res } = await ownerBody(request, env);
  if (res) return res;
  await Promise.all([env.TIME.delete("google_auth"), env.TIME.delete("events"),
    env.TIME.put("google_status", JSON.stringify({ at: new Date().toISOString(), ok: false, note: "disconnected" }))]);
  return json({ ok: true });
}

/** Sleep, workouts, rules, targets, claims and settings from the repo (secretary/sync.py). Daily summaries only. */
async function apiSync(request, env) {
  const { body, res } = await signedBody(request, env, "push", MAX_SYNC);
  if (res) return res;
  const puts = [];
  if (body.health && typeof body.health === "object") puts.push(env.TIME.put("health", JSON.stringify(body.health)));
  if (body.rules && Array.isArray(body.rules.rules)) puts.push(env.TIME.put("rules", JSON.stringify(body.rules)));
  if (body.targets && typeof body.targets === "object") puts.push(env.TIME.put("targets", JSON.stringify(body.targets)));
  if (body.claims && Array.isArray(body.claims.rows)) puts.push(env.TIME.put("claims", JSON.stringify(body.claims)));
  if (body.settings && typeof body.settings === "object") puts.push(env.TIME.put("settings", JSON.stringify(cleanSettings(body.settings))));
  await Promise.all(puts);
  return json({ ok: true, stored: puts.length });
}

async function apiEvents(request, env) {
  const { res } = await signedBody(request, env, "events");
  if (res) return res;
  const ev = await events(env);
  return json({ ok: true, events: ev.events || { items: [] }, error: ev.error || null });
}

/** Open slots for the bot, worked out exactly as the app's Plan tab does. */
async function apiSlots(request, env) {
  const { body, res } = await signedBody(request, env, "slots");
  if (res) return res;
  const ev = await events(env);
  await settings(env);
  const [rules, targets] = await Promise.all([env.TIME.get("rules", "json"), env.TIME.get("targets", "json")]);
  const P = M.prep(((ev.events || {}).items) || [], M.compile(rules));
  const minutes = Number.isInteger(body.minutes) && body.minutes >= 15 && body.minutes <= 720 ? body.minutes : 60;
  const part = Object.hasOwn(M.PARTS, body.part) ? body.part : "any";
  const n = Number.isInteger(body.n) && body.n >= 1 && body.n <= 42 ? body.n : 14;
  const now = Date.now();
  const slots = M.freeSlots(P, now, { minutes, part, n, window: (targets && targets.awake_window) || ["08:00", "22:30"], max: 20 });
  return json({ ok: true, minutes, part, slots: slots.map((x) => ({ date: x.date, start: M.hm(x.s), until: x.e >= 1440 ? "24:00" : M.hm(x.e) })),
    free_evenings: M.freeEvenings(P, now, n), fetched_at: ev.events && ev.events.fetched_at, error: ev.error || null });
}

async function apiAdd(request, env) {
  const { body, res } = await signedBody(request, env, "add");
  if (res) return res;
  if (!googleReady(env) || !(await env.TIME.get("google_auth"))) return json({ error: "Google Calendar isn't connected" }, 409);
  const { timezone: tz } = await settings(env);
  const c = cleanEvent({ ...body, op: "add" });
  if (typeof c === "string") return json({ error: c }, 400);
  const r = await G.insert(env, c, { tz });
  if (r.error) return json({ error: r.error }, 502);
  await events(env, true);
  return json({ ok: true, event: r.event });
}

/** The bot changes or removes an event. Google refuses nothing here, so the
 *  Worker does: only events this app made (G.edit and G.remove check). */
async function apiEdit(request, env) {
  const { body, res } = await signedBody(request, env, "edit");
  if (res) return res;
  if (!googleReady(env) || !(await env.TIME.get("google_auth"))) return json({ error: "Google Calendar isn't connected" }, 409);
  const { timezone: tz } = await settings(env);
  const c = cleanEdit(body);
  if (typeof c === "string") return json({ error: c }, 400);
  const r = await G.edit(env, body.id, c, { tz });
  if (r.error) return json({ error: r.error }, 502);
  await events(env, true);
  return json({ ok: true, event: r.event });
}

async function apiRemove(request, env) {
  const { body, res } = await signedBody(request, env, "remove");
  if (res) return res;
  if (!googleReady(env) || !(await env.TIME.get("google_auth"))) return json({ error: "Google Calendar isn't connected" }, 409);
  if (!(typeof body.id === "string" && body.id && body.id.length <= 200)) return json({ error: "bad id" }, 400);
  const r = await G.remove(env, body.id);
  if (r.error) return json({ error: r.error }, 502);
  await events(env, true);
  return json({ ok: true });
}

async function apiReceipt(request, env) {
  const { body, res } = await signedBody(request, env, "receipt", MAX_RECEIPT_B64 + 4096);
  if (res) return res;
  if (!CLAIM_ID_RE.test(body.id || "") || !RECEIPT_MIME.includes(body.mime) || typeof body.data !== "string" || !body.data || body.data.length > MAX_RECEIPT_B64 || !/^[A-Za-z0-9+/]+=*$/.test(body.data)) {
    return json({ error: "bad receipt" }, 400);
  }
  await env.TIME.put(`r:${body.id}`, JSON.stringify({ mime: body.mime, data: body.data, at: new Date().toISOString() }));
  return json({ ok: true });
}

async function receiptOut(env, id) {
  if (!CLAIM_ID_RE.test(id || "")) return json({ error: "bad id" }, 400);
  const r = await env.TIME.get(`r:${id}`, "json");
  return r ? json({ ok: true, mime: r.mime, data: r.data }) : json({ error: "no receipt" }, 404);
}

async function apiReceiptGet(request, env) {
  const { body, res } = await signedBody(request, env, "receipt_get");
  return res || receiptOut(env, body.id);
}

async function apiReceiptView(request, env) {
  const { body, res } = await ownerBody(request, env);
  return res || receiptOut(env, body.id);
}

async function apiReceiptDelete(request, env) {
  const { body, res } = await signedBody(request, env, "receipt_delete");
  if (res) return res;
  if (!CLAIM_ID_RE.test(body.id || "")) return json({ error: "bad id" }, 400);
  await env.TIME.delete(`r:${body.id}`);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/google/callback" && request.method === "GET") {
      if (!env.BOT_TOKEN || !googleReady(env)) return note("Not set up", "Google isn't configured for this app yet.", 503);
      return googleCallback(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      const route = {
        "/api/data": apiData, "/api/refresh": apiRefresh, "/api/event": apiEvent,
        "/api/google/start": apiGoogleStart, "/api/google/disconnect": apiGoogleDisconnect,
        "/api/sync": apiSync, "/api/events": apiEvents, "/api/slots": apiSlots, "/api/add": apiAdd,
        "/api/edit": apiEdit, "/api/remove": apiRemove,
        "/api/receipt": apiReceipt, "/api/receipt/get": apiReceiptGet, "/api/receipt/delete": apiReceiptDelete,
        "/api/receipt/view": apiReceiptView,
      }[url.pathname];
      if (!route) return json({ error: "not found" }, 404);
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
      if (!env.BOT_TOKEN) return json({ error: "not configured" }, 503);
      return route(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...BASE_HEADERS, Allow: "GET, HEAD" } });
    }
    return page(request, env);
  },
};
