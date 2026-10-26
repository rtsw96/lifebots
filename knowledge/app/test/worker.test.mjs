// Worker tests: node --test knowledge/app/test/*.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import worker, { cleanDo, hmac, signSync, toHex } from "../worker.js";

const TOKEN = "123456:TEST-token_for-vectors";
const OWNER = "111";
const ORIGIN = "https://k.example";
const enc = new TextEncoder();

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const e = this.m.get(k);
    if (!e) return null;
    if (type === "json") return JSON.parse(new TextDecoder().decode(e.v));
    if (type === "stream") return new Blob([e.v]).stream();
    return new TextDecoder().decode(e.v);
  }
  async getWithMetadata(k, type) {
    const e = this.m.get(k);
    return { value: e ? await this.get(k, type) : null, metadata: e ? e.meta : null };
  }
  async put(k, v, opts = {}) { this.m.set(k, { v: typeof v === "string" ? enc.encode(v) : new Uint8Array(v), meta: opts.metadata || null }); }
  async delete(k) { this.m.delete(k); }
}
const env = () => ({ BOT_TOKEN: TOKEN, OWNER_ID: OWNER, KNOW: new MemoryKV() });

async function initData(userId = OWNER, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), query_id: "q1", user: JSON.stringify({ id: Number(userId), first_name: "Ana" }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(TOKEN));
  const hash = toHex(await hmac(secret, enc.encode(check)));
  return new URLSearchParams({ ...fields, hash }).toString();
}
async function app(e, path, body, user = OWNER) {
  return worker.fetch(new Request(ORIGIN + path, { method: "POST", body: JSON.stringify({ ...body, initData: await initData(user) }) }), e);
}
async function bot(e, path, body) {
  const raw = enc.encode(JSON.stringify({ ...body, ts: new Date().toISOString() }));
  return worker.fetch(new Request(ORIGIN + path, { method: "POST", body: raw, headers: { "X-Sync-Signature": await signSync(TOKEN, raw) } }), e);
}

test("initData older than an hour is refused, with a reopen hint", async () => {
  const e = env();
  const t = Math.floor(Date.now() / 1000);
  for (const [age, ok] of [[50 * 60, true], [61 * 60, false]]) {
    const r = await worker.fetch(new Request(ORIGIN + "/api/data", { method: "POST", body: JSON.stringify({ initData: await initData(OWNER, t - age) }) }), e);
    assert.equal(r.status !== 401, ok, `age ${age}s`);
    if (!ok) assert.match((await r.json()).error, /open it again/);
  }
});

test("only the owner gets in", async () => {
  const e = env();
  assert.equal((await app(e, "/api/data", {}, "222")).status, 403);
  const bad = await worker.fetch(new Request(ORIGIN + "/api/data", { method: "POST", body: JSON.stringify({ initData: "hash=00" }) }), e);
  assert.equal(bad.status, 401);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/data"), e)).status, 405);
  const r = await (await app(e, "/api/data", {})).json();
  assert.deepEqual(r, { ok: true, meta: null, progress: null, rev: 0, queue: [] });
});

test("bundles stream back as uploaded, meta and progress pass through", async () => {
  const e = env();
  const blob = gzipSync(Buffer.from(JSON.stringify({ notes: [{ p: "concepts/x.md" }] })));
  await e.KNOW.put("blob:vault", blob);
  await e.KNOW.put("meta", JSON.stringify({ vault: { v: "abc" } }));
  const res = await app(e, "/api/blob", { name: "vault" });
  assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(blob));
  assert.equal((await app(e, "/api/blob", { name: "secrets" })).status, 400);
  assert.equal((await app(e, "/api/blob", { name: "learn" })).status, 404);
  const d = await (await app(e, "/api/data", {})).json();
  assert.equal(d.meta.vault.v, "abc");
});

test("progress saves only on the current revision", async () => {
  const e = env();
  let r = await app(e, "/api/progress", { rev: 0, progress: { xp: { "2026-10-14": 20 } } });
  assert.deepEqual(await r.json(), { ok: true, rev: 1 });
  r = await app(e, "/api/progress", { rev: 0, progress: { xp: {} } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).rev, 1);
  const d = await (await app(e, "/api/data", {})).json();
  assert.deepEqual([d.rev, d.progress.xp["2026-10-14"]], [1, 20]);
});

test("app items are checked, queued, listed and acked by the signed bot", async () => {
  const e = env();
  assert.equal(cleanDo("note_status", { path: "raw/2026-01-01_x.md", status: "reviewed" }), "bad note or status");
  assert.equal(cleanDo("note_status", { path: "concepts/../CLAUDE.md", status: "reviewed" }), "bad note or status");
  assert.deepEqual(cleanDo("note_status", { path: "concepts/p-and-c/A.md", status: "reviewed" }), { path: "concepts/p-and-c/A.md", status: "reviewed" });
  assert.match(cleanDo("note_edit", { path: "concepts/A.md", base: "0123456789ab", text: "no front" }), /frontmatter/);
  assert.equal(cleanDo("launch", {}), "unknown action");
  assert.equal(cleanDo("curriculum", { track: "spanish", band: 3, label: "B2" }).band, 3);
  assert.deepEqual(cleanDo("topic", { text: "  Spanish for a trip ", level: "beginner" }), { text: "Spanish for a trip", level: "beginner" });
  assert.match(cleanDo("topic", { text: " " }), /like to learn/);
  assert.match(cleanDo("topic", { text: "x".repeat(501) }), /like to learn/);
  const r = await (await app(e, "/api/do", { kind: "ask", data: { q: " Why is the sky blue? " } })).json();
  assert.equal(r.item.data.q, "Why is the sky blue?");
  assert.equal((await app(e, "/api/do", { kind: "ask", data: { q: "" } })).status, 400);
  const list = await (await bot(e, "/api/queue", { op: "list" })).json();
  assert.equal(list.items.length, 1);
  const forged = await worker.fetch(new Request(ORIGIN + "/api/queue", { method: "POST", body: JSON.stringify({ op: "list", ts: new Date().toISOString() }), headers: { "X-Sync-Signature": "0".repeat(64) } }), e);
  assert.equal(forged.status, 401);
  const ack = await (await bot(e, "/api/queue/ack", { op: "ack", ids: [r.item.id] })).json();
  assert.equal(ack.removed, 1);
  assert.equal((await (await bot(e, "/api/queue", { op: "list" })).json()).items.length, 0);
});

test("settings from the bot merge into progress and bump the revision", async () => {
  const e = env();
  await app(e, "/api/progress", { rev: 0, progress: { settings: { daily_min: 10, remind: "20:00" }, xp: { a: 1 } } });
  const r = await (await bot(e, "/api/settings", { op: "settings", settings: { daily_min: 15, paused: ["history"] } })).json();
  assert.deepEqual([r.settings.daily_min, r.settings.remind, r.settings.paused[0], r.rev], [15, "20:00", "history", 2]);
  assert.equal((await bot(e, "/api/settings", { op: "settings", settings: { daily_min: 500 } })).status, 400);
  const d = await (await app(e, "/api/data", {})).json();
  assert.equal(d.progress.xp.a, 1);
});
