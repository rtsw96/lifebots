// Knowledge app: a Cloudflare Worker serving the KnowledgeBot's Telegram Mini App.
// Private: only the owner's Telegram account gets any data.
//
//   GET  /                the app (public/, through the ASSETS binding)
//   POST /api/data        {initData} -> {meta, progress, rev, queue}: bundle versions, learning progress
//   POST /api/blob        {initData, name: "vault"|"learn"} -> the gzipped bundle (bytes)
//   POST /api/progress    {initData, rev, progress} -> save progress if rev is current, else 409
//   POST /api/do          {initData, kind, data} -> queue an item for the bot (note status, edit,
//                         delete, capture, ask, a written answer, a reported mistake, a curriculum
//                         request, a new topic to learn)
//   POST /api/queue       {op:"list", ts} (bot, signed) -> the queued items
//   POST /api/queue/ack   {op:"ack", ts, ids} (bot, signed) -> drop the ones handled
//   POST /api/settings    {op:"settings", ts, settings} (bot, signed) -> merge into progress
//
// The bot writes the bundles and `meta` straight into KV through the Cloudflare API, so big
// uploads cost the Worker nothing. Responses pass KV text through without parsing where they can
// (the free plan allows 10 ms of CPU per request). Bot requests are signed with
// HMAC_SHA256(key = HMAC_SHA256("KnowledgeSync", bot token), body).
//
// Secrets: BOT_TOKEN (the KnowledgeBot's token), OWNER_ID (the owner's Telegram id).
// Nothing here logs request bodies or initData.

const enc = new TextEncoder();
const DAY = 86400;
// Telegram initData is signed when the app opens; accept it for an hour, so a leaked
// copy (a screenshot, a log) can't be replayed for long. Reopening the app renews it.
const INIT_MAX_AGE = 3600;
const MAX_INIT = 16 * 1024;
const MAX_PROGRESS = 2 * 1024 * 1024;
const MAX_DO = 160 * 1024;
const MAX_QUEUE = 100;
const SIGNED_WINDOW = 2 * 60 * 1000;
const ITEM_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;
const TRACK_RE = /^[a-z]{2,12}$/;
const NOTE_RE = /^(concepts|entities|themes)\/[^\0]{1,300}\.md$/;

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

/** Telegram WebApp initData check. Returns {user} or null. */
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
  return hmac(enc.encode("KnowledgeSync"), enc.encode(botToken));
}
export async function signSync(botToken, bodyBytes) {
  return toHex(await hmac(await syncKey(botToken), bodyBytes));
}

// ------------------------------------------------------------------ responses
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
const API_HEADERS = { ...BASE_HEADERS, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };

function json(body, status = 200) {
  return rawJson(JSON.stringify(body), status);
}
function rawJson(text, status = 200) {
  return new Response(text, { status, headers: { ...API_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
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

async function readBody(request, limit) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > limit) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.length > limit ? null : buf;
}

/** An app request from the owner. Returns {body} or {res}. */
async function ownerBody(request, env, limit) {
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

async function readQueue(env) {
  const q = await env.KNOW.get("queue", "json");
  return Array.isArray(q) ? q : [];
}
const newId = () => `${Date.now()}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
const str = (v, max) => typeof v === "string" && v.length <= max;

/** Validate an app item. Returns the clean data or an error string. */
export function cleanDo(kind, d) {
  if (!d || typeof d !== "object") return "bad request";
  const notePath = (p) => typeof p === "string" && NOTE_RE.test(p) && !p.includes("..");
  switch (kind) {
    case "note_status":
      if (!notePath(d.path) || !["draft", "reviewed"].includes(d.status)) return "bad note or status";
      return { path: d.path, status: d.status };
    case "note_edit":
    case "note_delete":
      if (!notePath(d.path) || !/^[0-9a-f]{12}$/.test(d.base || "")) return "bad note";
      if (kind === "note_delete") return { path: d.path, base: d.base };
      if (!str(d.text, 64 * 1024) || !d.text.startsWith("---")) return "The note needs its frontmatter (the --- block at the top).";
      return { path: d.path, base: d.base, text: d.text };
    case "capture":
      if (!str(d.text, 100 * 1024) || !d.text.trim()) return "Paste something to file.";
      if (d.title != null && !str(d.title, 200)) return "Title too long.";
      return { title: d.title ? d.title.trim() : null, text: d.text };
    case "ask":
      if (!str(d.q, 2000) || !d.q.trim()) return "Ask a question.";
      if (d.path != null && !(str(d.path, 400))) return "bad note";
      return { q: d.q.trim(), path: d.path || null };
    case "answer":
      if (!TRACK_RE.test(d.track || "") || !str(d.card, 80) || !str(d.prompt, 2000) || !str(d.text, 4000) || !d.text.trim()) return "bad answer";
      return { track: d.track, card: d.card, prompt: d.prompt, text: d.text.trim(), rubric: str(d.rubric, 2000) ? d.rubric : null };
    case "report":
      if (!TRACK_RE.test(d.track || "") || !str(d.card, 80) || !str(d.text, 1000)) return "bad report";
      return { track: d.track, card: d.card, text: d.text.trim(), prompt: str(d.prompt, 1000) ? d.prompt : null };
    case "curriculum":
      if (!TRACK_RE.test(d.track || "") || !Number.isInteger(d.band) || d.band < 0 || d.band > 9) return "bad request";
      return { track: d.track, band: d.band, label: str(d.label, 200) ? d.label : null };
    case "topic":
      // a new subject to learn, in the user's words: the bot writes the first lessons
      if (!str(d.text, 500) || !d.text.trim()) return "Say what you'd like to learn.";
      if (d.level != null && !str(d.level, 100)) return "Level too long.";
      return { text: d.text.trim(), level: d.level ? d.level.trim() : null };
    default:
      return "unknown action";
  }
}

// ------------------------------------------------------------------ handlers
async function apiData(request, env) {
  const { res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const [meta, prog, queue] = await Promise.all([
    env.KNOW.get("meta"), env.KNOW.getWithMetadata("progress"), env.KNOW.get("queue"),
  ]);
  const rev = (prog.metadata && prog.metadata.rev) || 0;
  // KV text passes through unparsed
  return rawJson(`{"ok":true,"meta":${meta || "null"},"progress":${prog.value || "null"},"rev":${rev},"queue":${queue || "[]"}}`);
}

async function apiBlob(request, env) {
  const { body, res } = await ownerBody(request, env, 1024);
  if (res) return res;
  if (!["vault", "learn"].includes(body.name)) return json({ error: "bad name" }, 400);
  const blob = await env.KNOW.get(`blob:${body.name}`, "stream");
  if (!blob) return json({ error: "not built yet" }, 404);
  return new Response(blob, { headers: { ...API_HEADERS, "Content-Type": "application/octet-stream" } });
}

async function apiProgress(request, env) {
  const { body, res } = await ownerBody(request, env, MAX_PROGRESS);
  if (res) return res;
  if (!body.progress || typeof body.progress !== "object" || !Number.isInteger(body.rev)) return json({ error: "bad progress" }, 400);
  const cur = await env.KNOW.getWithMetadata("progress", "stream");
  if (cur.value) await cur.value.cancel();
  const rev = (cur.metadata && cur.metadata.rev) || 0;
  if (body.rev !== rev) return json({ error: "stale", rev }, 409);
  await env.KNOW.put("progress", JSON.stringify(body.progress), { metadata: { rev: rev + 1, at: Date.now() } });
  return json({ ok: true, rev: rev + 1 });
}

async function apiDo(request, env) {
  const { body, res } = await ownerBody(request, env, MAX_DO);
  if (res) return res;
  const data = cleanDo(body.kind, body.data);
  if (typeof data === "string") return json({ error: data }, 400);
  const queue = await readQueue(env);
  if (queue.length >= MAX_QUEUE) return json({ error: "Too much is waiting for the bot. Check the KnowledgeBot is running." }, 429);
  const item = { id: newId(), kind: body.kind, at: new Date().toISOString(), data };
  queue.push(item);
  await env.KNOW.put("queue", JSON.stringify(queue));
  return json({ ok: true, item });
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
  if (!ids.length || ids.length > MAX_QUEUE) return json({ error: "bad ids" }, 400);
  const drop = new Set(ids);
  const queue = await readQueue(env);
  const keep = queue.filter((it) => !drop.has(it.id));
  if (keep.length) await env.KNOW.put("queue", JSON.stringify(keep));
  else await env.KNOW.delete("queue");
  return json({ ok: true, removed: queue.length - keep.length });
}

const SETTING_KEYS = { daily_min: (v) => Number.isInteger(v) && v >= 5 && v <= 60, remind: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  weights: (v) => v && typeof v === "object" && Object.entries(v).every(([k, x]) => TRACK_RE.test(k) && typeof x === "number" && x >= 0 && x <= 5),
  paused: (v) => Array.isArray(v) && v.every((x) => TRACK_RE.test(x)) };

async function apiSettings(request, env) {
  const { body, res } = await signedBody(request, env, "settings");
  if (res) return res;
  const s = body.settings || {};
  for (const [k, v] of Object.entries(s)) if (!SETTING_KEYS[k] || !SETTING_KEYS[k](v)) return json({ error: `bad setting ${k}` }, 400);
  const cur = await env.KNOW.getWithMetadata("progress", "json");
  const rev = (cur.metadata && cur.metadata.rev) || 0;
  const prog = cur.value || { v: 1, settings: {} };
  prog.settings = { ...(prog.settings || {}), ...s };
  await env.KNOW.put("progress", JSON.stringify(prog), { metadata: { rev: rev + 1, at: Date.now() } });
  return json({ ok: true, settings: prog.settings, rev: rev + 1 });
}

const ROUTES = {
  "/api/data": apiData, "/api/blob": apiBlob, "/api/progress": apiProgress, "/api/do": apiDo,
  "/api/queue": apiQueue, "/api/queue/ack": apiQueueAck, "/api/settings": apiSettings,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];
    if (route) {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      try {
        return await route(request, env);
      } catch {
        return json({ error: "server error" }, 500);
      }
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET only" }, 405);
    return page(request, env);
  },
};
