// Finance Worker and encryption tests: node --test finance/app/test/ (no network)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { fingerprint, newDeviceKeys, open, seal } from "../public/crypto.js";
import worker, { cleanAction, signSync } from "../worker.js";

const TOKEN = "654321:TEST-finance_token";
const OWNER = "111";
const ORIGIN = "https://money-app.example";

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}
const env = () => ({ BOT_TOKEN: TOKEN, OWNER_ID: OWNER, FINANCE: new MemoryKV() });

function initData(id, token = TOKEN) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - 60), user: JSON.stringify({ id: Number(id) }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const app = (e, path, body, id = OWNER) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method: "POST", body: JSON.stringify({ ...body, initData: initData(id) }) }), e);
async function bot(e, path, body, token = TOKEN) {
  const raw = JSON.stringify(body);
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: raw,
    headers: { "X-Sync-Signature": await signSync(token, new TextEncoder().encode(raw)) } }), e);
}
const ts = () => new Date().toISOString();

// Python computes the same signature (finance/bot/test_app_sync.py).
test("signature vector shared with Python", async () => {
  assert.equal(await signSync(TOKEN, new TextEncoder().encode('{"op":"list","ts":"2026-01-01T00:00:00+00:00"}')),
    "02416fa051409ad845a4e426476355513e086bdf55037fed36cce68bba0771ba");
});

test("sealed for two devices, readable only with a device key", async () => {
  const a = await newDeviceKeys();
  const b = await newDeviceKeys();
  const c = await newDeviceKeys();
  const ida = await fingerprint(a.pub);
  const idb = await fingerprint(b.pub);
  assert.match(ida, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  const data = { net_worth: 631318, note: "secret" };
  const s = await seal(data, [{ id: ida, pub: a.pub }, { id: idb, pub: b.pub }]);
  assert.ok(!JSON.stringify(s).includes("631318"));
  assert.deepEqual(await open(s, ida, a.pair.privateKey), data);
  assert.deepEqual(await open(s, idb, b.pair.privateKey), data);
  await assert.rejects(open(s, ida, c.pair.privateKey));
  await assert.rejects(open(s, await fingerprint(c.pub), c.pair.privateKey), /not sealed/);
});

test("a device gets data only once the bot approves it", async () => {
  const e = env();
  const k = await newDeviceKeys();
  const reg = await (await app(e, "/api/device", { pub: k.pub, label: "iPhone <script>" })).json();
  assert.equal(reg.status, "pending");
  assert.equal(reg.id, await fingerprint(k.pub));
  assert.equal((await app(e, "/api/device", { pub: k.pub }, "222")).status, 403);
  const sealed = await seal({ x: 1 }, [{ id: reg.id, pub: k.pub }]);
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), generated_at: ts(), sealed })).status, 200);
  let d = await (await app(e, "/api/data", { device: reg.id })).json();
  assert.equal(d.sealed, null);
  assert.equal(d.device, "pending");
  const list = await (await bot(e, "/api/devices", { op: "devices", ts: ts() })).json();
  assert.equal(list.devices[0].label, "iPhone script");
  assert.equal((await bot(e, "/api/devices/set", { op: "device", ts: ts(), id: reg.id, status: "approved" })).status, 200);
  d = await (await app(e, "/api/data", { device: reg.id })).json();
  assert.deepEqual(await open(d.sealed, reg.id, k.pair.privateKey), { x: 1 });
  assert.equal((await bot(e, "/api/devices/set", { op: "device", ts: ts(), id: reg.id, status: "revoked" })).status, 200);
  assert.equal((await (await app(e, "/api/data", { device: reg.id })).json()).sealed, null);
});

test("bad keys, unsigned syncs and app changes are refused", async () => {
  const e = env();
  assert.equal((await app(e, "/api/device", { pub: { kty: "EC", crv: "P-256", x: "x", y: "y" } })).status, 400);
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), generated_at: ts(), sealed: { v: 1, ct: "", keys: [] } }, "1:other")).status, 401);
  assert.equal(cleanAction("txn_category", { id: "0123456789abcdef", category: "dining" }).category, "dining");
  assert.equal(cleanAction("txn_category", { id: "x", category: "dining" }), "bad transaction");
  assert.equal(cleanAction("txn_category", { id: "0123456789abcdef", category: "Drop Table" }), "bad category");
  assert.equal((await app(e, "/api/do", { device: "aaaa-bbbb-cccc", kind: "txn_category", data: { id: "0123456789abcdef", category: "dining" } })).status, 403);
});
