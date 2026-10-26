// Oura tests: node --test health/app/test/*.mjs (no network: fetch is mocked)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { accessToken, mergeDays, pull, summarise } from "../oura.js";
import worker, { localDate } from "../worker.js";

const TOKEN = "123456:TEST-token_for-vectors";
const OWNER = "111";

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}
const env = () => ({ BOT_TOKEN: TOKEN, OWNER_ID: OWNER, OURA_CLIENT_ID: "cid", OURA_CLIENT_SECRET: "csecret", HEALTH: new MemoryKV() });

function initData(id) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - 60), user: JSON.stringify({ id: Number(id) }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const app = (e, path, body = {}, id = OWNER) => worker.fetch(new Request(`https://h.example${path}`, {
  method: "POST", body: JSON.stringify({ ...body, initData: initData(id) }),
}), e, { waitUntil() {} });

const sleepRow = { day: "2026-10-09", type: "long_sleep", total_sleep_duration: 22320, deep_sleep_duration: 3600, rem_sleep_duration: 5400,
  awake_time: 1800, efficiency: 85, bedtime_start: "2026-10-09T01:40:00+08:00", bedtime_end: "2026-10-09T08:10:00+08:00",
  average_hrv: 38.4, lowest_heart_rate: 52, average_breath: 14.25, heart_rate: { items: [60, 61] } };
const nap = { ...sleepRow, type: "late_nap", total_sleep_duration: 1800 };

test("one row per day, main sleep only, no raw samples", () => {
  const d = summarise({
    dailySleep: [{ day: "2026-10-09", score: 71 }], sleep: [nap, sleepRow],
    readiness: [{ day: "2026-10-09", score: 62, temperature_deviation: 0.42 }],
    spo2: [{ day: "2026-10-09", spo2_percentage: { average: 96.8 } }], activity: [{ day: "2026-10-09", steps: 8123, active_calories: 410 }],
  })["2026-10-09"];
  assert.equal(d.sleep_h, 6.2);
  assert.equal(d.bed, "01:40");
  assert.equal(d.wake, "08:10");
  assert.equal(d.hrv, 38);
  assert.equal(d.rhr, 52);
  assert.equal(d.readiness, 62);
  assert.equal(d.temp_dev, 0.4);
  assert.equal(d.sleep_score, 71);
  assert.equal(d.spo2, 96.8);
  assert.ok(!JSON.stringify(d).includes("items"));
  const m = mergeDays({ days: { "2025-01-01": { sleep_h: 7 } } }, { "2026-10-09": d }, "2026-10-10");
  assert.deepEqual(Object.keys(m.days), ["2026-10-09"]);
});

function oura(calls) {
  return async (url, init = {}) => {
    calls.push(url);
    if (url.startsWith("https://api.ouraring.com/oauth/token")) {
      const body = new URLSearchParams(init.body);
      if (body.get("refresh_token") === "used") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 86400 }));
    }
    if (url.includes("/usercollection/sleep?")) return new Response(JSON.stringify({ data: [sleepRow], next_token: null }));
    if (url.includes("/usercollection/daily_spo2?")) return new Response("{}", { status: 403 });
    return new Response(JSON.stringify({ data: [] }));
  };
}

test("an expiring token is refreshed and the new pair stored", async () => {
  const e = env();
  await e.HEALTH.put("oura_auth", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() + 60e3 }));
  const calls = [];
  const r = await pull(e, "2026-10-08", "2026-10-10", oura(calls));
  assert.ok(r.ok, r.error);
  assert.equal((await e.HEALTH.get("oura_auth", "json")).refresh_token, "r2");
  assert.equal((await e.HEALTH.get("oura", "json")).days["2026-10-09"].sleep_h, 6.2);
  assert.ok(calls.some((u) => u.includes("end_date=2026-10-11")));
});

test("with TOKEN_KEY the Oura pair is sealed in KV, and a plain record is sealed on first read", async () => {
  const e = { ...env(), TOKEN_KEY: "secret-key" };
  await e.HEALTH.put("oura_auth", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() + 60e3 }));
  const r = await pull(e, "2026-10-08", "2026-10-10", oura([]));
  assert.ok(r.ok, r.error);
  const raw = await e.HEALTH.get("oura_auth");
  const rec = JSON.parse(raw);
  assert.equal(rec.sealed, 1);
  assert.deepEqual(Object.keys(rec).sort(), ["ct", "iv", "sealed"]);   // no token in the clear
  assert.ok(!raw.includes('"r2"') && !raw.includes("refresh_token"));   // (the base64 itself may hold "r2" by chance)
  assert.equal((await accessToken(e)).token, "a2");
});

test("a refresh token already used by another run falls back to the stored one", async () => {
  const e = env();
  await e.HEALTH.put("oura_auth", JSON.stringify({ access_token: "a1", refresh_token: "used", expires_at: Date.now() }));
  const r = await accessToken(e, oura([]));
  assert.match(r.error, /connect again/);
});

test("the Oura sign-in needs the owner, and the callback a state from that sign-in", async () => {
  const e = env();
  assert.equal((await app(e, "/api/oura/start", {}, "222")).status, 403);
  const { url } = await (await app(e, "/api/oura/start")).json();
  const u = new URL(url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://h.example/oura/callback");
  assert.equal(u.searchParams.get("client_id"), "cid");
  const state = u.searchParams.get("state");
  const forged = await worker.fetch(new Request("https://h.example/oura/callback?code=x&state=0000"), e, { waitUntil() {} });
  assert.equal(forged.status, 400);
  const real = globalThis.fetch;
  globalThis.fetch = oura([]);
  try {
    const ok = await worker.fetch(new Request(`https://h.example/oura/callback?code=abc&state=${state}`), e, { waitUntil() {} });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Oura connected/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal((await e.HEALTH.get("oura_auth", "json")).access_token, "a2");
  // A state works once.
  const again = await worker.fetch(new Request(`https://h.example/oura/callback?code=abc&state=${state}`), e, { waitUntil() {} });
  assert.equal(again.status, 400);
  const data = await (await app(e, "/api/data")).json();
  assert.deepEqual([data.ouraState.ready, data.ouraState.connected], [true, true]);
});

test("the Worker's dates follow the owner's timezone", () => {
  const at = Date.parse("2026-10-13T20:30:00Z");
  assert.equal(localDate("Asia/Singapore", 0, at), "2026-10-14");      // 04:30 the next morning
  assert.equal(localDate("America/New_York", 0, at), "2026-10-13");    // 16:30 the same day
  assert.equal(localDate("Asia/Singapore", 3, at), "2026-10-11");
  assert.equal(localDate("Not/AZone", 0, at), "2026-10-14");           // a bad name falls back
});
