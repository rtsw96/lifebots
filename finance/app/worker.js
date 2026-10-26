// Money app: a Cloudflare Worker serving the money (finance) bot's Telegram Mini App.
// Private, and end-to-end encrypted: the Worker stores a sealed snapshot it
// cannot read, plus the public keys of the owner's approved devices (see
// public/crypto.js). Only the owner's Telegram account can fetch anything.
//
//   GET  /                   the single-page app (public/, through the ASSETS binding)
//   POST /api/data           {initData, device} -> {sealed, generated_at, device status, queue}
//   POST /api/device         {initData, pub, label} -> register this phone's public key (pending
//                            until the owner approves its fingerprint in the bot chat)
//   POST /api/do             {initData, kind, data} -> queue a change for the bot (e.g. a category)
//   POST /api/sync           {op:"snapshot", ts, sealed, generated_at} from the bot session, signed
//   POST /api/devices        {op:"devices", ts} -> every registered device (bot, signed)
//   POST /api/devices/set    {op:"device", ts, id, status} -> approve or revoke (bot, signed)
//   POST /api/queue          {op:"list", ts} -> queued app changes (bot, signed)
//   POST /api/queue/ack      {op:"ack", ts, ids} -> drop handled ones (bot, signed)
//
// Bot requests are signed with HMAC_SHA256(key = HMAC_SHA256("FinanceSync",
// bot token), msg = body). Secrets: BOT_TOKEN (the money bot's token, FINANCE_BOT_TOKEN),
// OWNER_ID (the owner's Telegram id). Nothing here logs request bodies.

import { fingerprint } from "./public/crypto.js";

const enc = new TextEncoder();
const DAY = 86400;
// Telegram initData is signed when the app opens; accept it for an hour, so a leaked
// copy (a screenshot, a log) can't be replayed for long. Reopening the app renews it.
const INIT_MAX_AGE = 3600;
const MAX_INIT = 16 * 1024;
const MAX_SEALED = 8 * 1024 * 1024;
const MAX_QUEUE = 60;
const MAX_DEVICES = 6;
const SIGNED_WINDOW = 2 * 60 * 1000;
const ITEM_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;
const DEV_ID_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;

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
  return hmac(enc.encode("FinanceSync"), enc.encode(botToken));
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
  // Fonts never change under the same name; everything else revalidates.
  out.headers.set("Cache-Control", /^\/fonts\//.test(path) ? "public, max-age=604800" : "no-cache");
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
  const q = await env.FINANCE.get("queue", "json");
  return Array.isArray(q) ? q : [];
}

async function readDevices(env) {
  const d = await env.FINANCE.get("devices", "json");
  return Array.isArray(d) ? d : [];
}

const newId = () => `${Date.now()}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;

// ---------------------------------------------------------------- app (owner)
async function apiData(request, env) {
  const { body, res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const devices = await readDevices(env);
  const dev = devices.find((d) => d.id === body.device);
  const status = dev ? dev.status : "unknown";
  if (status !== "approved") return json({ ok: true, device: status, sealed: null, queue: [] });
  const [sealed, queue] = await Promise.all([env.FINANCE.get("sealed", "json"), readQueue(env)]);
  // The queue is only ids and kinds: what a change was, not its content.
  return json({ ok: true, device: status, sealed, queue: queue.map((q) => ({ id: q.id, kind: q.kind, ref: q.ref })) });
}

async function apiDevice(request, env) {
  const { body, res } = await ownerBody(request, env, 2048);
  if (res) return res;
  const pub = body.pub || {};
  if (pub.kty !== "EC" || pub.crv !== "P-256" || !B64URL_RE.test(pub.x || "") || !B64URL_RE.test(pub.y || "")) {
    return json({ error: "bad key" }, 400);
  }
  const id = await fingerprint(pub);
  const devices = await readDevices(env);
  const have = devices.find((d) => d.id === id);
  if (have) return json({ ok: true, id, status: have.status });
  if (devices.filter((d) => d.status !== "revoked").length >= MAX_DEVICES) return json({ error: "Too many devices. Revoke one in the bot first." }, 429);
  const label = typeof body.label === "string" ? body.label.replace(/[^\w .,()-]/g, "").slice(0, 40) : "";
  devices.push({ id, pub: { x: pub.x, y: pub.y }, label, status: "pending", created: new Date().toISOString() });
  await env.FINANCE.put("devices", JSON.stringify(devices));
  return json({ ok: true, id, status: "pending" });
}

const CATEGORY_RE = /^[a-z][a-z0-9_]{1,30}$/;

/** A change from the app, for the bot. Returns the clean data or an error string. */
export function cleanAction(kind, d) {
  if (!d || typeof d !== "object") return "bad request";
  if (kind === "txn_category") {
    if (!/^[0-9a-f]{16}$/.test(d.id || "")) return "bad transaction";
    if (!CATEGORY_RE.test(d.category || "")) return "bad category";
    return { id: d.id, category: d.category };
  }
  return "unknown action";
}

async function apiDo(request, env) {
  const { body, res } = await ownerBody(request, env, 1024);
  if (res) return res;
  const devices = await readDevices(env);
  if (!devices.some((d) => d.id === body.device && d.status === "approved")) return json({ error: "This device isn't approved yet." }, 403);
  const data = cleanAction(body.kind, body.data);
  if (typeof data === "string") return json({ error: data }, 400);
  const queue = await readQueue(env);
  if (queue.length >= MAX_QUEUE) return json({ error: "Too much is waiting for the bot. Check the finance bot is running." }, 429);
  const item = { id: newId(), kind: body.kind, at: new Date().toISOString(), data, ref: data.id || null };
  queue.push(item);
  await env.FINANCE.put("queue", JSON.stringify(queue));
  return json({ ok: true, item: { id: item.id, kind: item.kind, ref: item.ref } });
}

// ---------------------------------------------------------------- bot (signed)
async function apiSync(request, env) {
  const { body, bytes, res } = await signedBody(request, env, "snapshot", MAX_SEALED);
  if (res) return res;
  const s = body.sealed;
  if (!s || s.v !== 1 || typeof s.ct !== "string" || !Array.isArray(s.keys) || !Date.parse(body.generated_at || "")) {
    return json({ error: "bad snapshot" }, 400);
  }
  const old = await env.FINANCE.get("sealed", "json");
  if (old && Date.parse(old.generated_at) > Date.parse(body.generated_at)) return json({ error: "stale snapshot" }, 409);
  await env.FINANCE.put("sealed", JSON.stringify({ ...s, generated_at: body.generated_at }));
  return json({ ok: true, bytes });
}

async function apiDevices(request, env) {
  const { res } = await signedBody(request, env, "devices");
  if (res) return res;
  return json({ ok: true, devices: await readDevices(env) });
}

async function apiDevicesSet(request, env) {
  const { body, res } = await signedBody(request, env, "device");
  if (res) return res;
  if (!DEV_ID_RE.test(body.id || "") || !["approved", "revoked"].includes(body.status)) return json({ error: "bad request" }, 400);
  const devices = await readDevices(env);
  const d = devices.find((x) => x.id === body.id);
  if (!d) return json({ error: "no such device" }, 404);
  d.status = body.status;
  d[body.status] = new Date().toISOString();
  await env.FINANCE.put("devices", JSON.stringify(devices));
  return json({ ok: true, device: d });
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
  if (keep.length) await env.FINANCE.put("queue", JSON.stringify(keep));
  else await env.FINANCE.delete("queue");
  return json({ ok: true, removed: queue.length - keep.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = {
        "/api/data": apiData, "/api/device": apiDevice, "/api/do": apiDo,
        "/api/sync": apiSync, "/api/devices": apiDevices, "/api/devices/set": apiDevicesSet,
        "/api/queue": apiQueue, "/api/queue/ack": apiQueueAck,
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
