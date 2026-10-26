// Worker tests: node --test health/app/test/   (no dependencies, no network)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import worker, { cleanWorkout, signSync } from "../worker.js";

const TOKEN = "123456:TEST-token_for-vectors";
const OWNER = "111";
const ORIGIN = "https://health-app.example.workers.dev";
const now = () => Math.floor(Date.now() / 1000);

// Python computes the same signature (health/foodbot/test_app_sync.py).
const VECTOR_BODY = '{"op":"list","ts":"2026-01-01T00:00:00+00:00"}';
const VECTOR_SIG = "7a7080065542fce47b32cca0219a4b200dd0be9d600990d95591f80ba4bf7417";

function initData(id, token = TOKEN) {
  const fields = { auth_date: String(now() - 60), user: JSON.stringify({ id: Number(id), first_name: "Ana" }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

const env = () => ({
  BOT_TOKEN: TOKEN, OWNER_ID: OWNER, HEALTH: new MemoryKV(),
  ASSETS: { fetch: async () => new Response("<!doctype html><title>Health</title>", { headers: { "Content-Type": "text/html" } }) },
});

const app = (e, path, body, id = OWNER) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method: "POST", body: JSON.stringify({ ...body, initData: initData(id) }), headers: { "Content-Type": "application/json" },
}), e);

async function bot(e, path, body, token = TOKEN) {
  const raw = JSON.stringify(body);
  const sig = await signSync(token, new TextEncoder().encode(raw));
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: raw, headers: { "X-Sync-Signature": sig } }), e);
}

const ts = () => new Date().toISOString();
const snap = (at = ts()) => ({ generated_at: at, today: "2026-10-10", targets: {}, profile: {}, food: { days: [], meals: [] }, sets: [], body: [] });
const workout = {
  date: "2026-10-10", time: "18:05", name: "Upper body", started: 1,
  blocks: [{ block: "A", items: [
    { ex: "db_bench_press", sets: [{ kg: 26, reps: 10, done: true }, { kg: 26, reps: 9, done: true }, { kg: 26, reps: 8, done: false }] },
    { ex: "plank", sets: [{ sec: 40, done: true }] }] }],
};

test("signature matches the Python side", async () => {
  assert.equal(await signSync(TOKEN, new TextEncoder().encode(VECTOR_BODY)), VECTOR_SIG);
});

test("only the owner gets data", async () => {
  const e = env();
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), snap: snap() })).status, 200);
  const mine = await (await app(e, "/api/data", {})).json();
  assert.ok(mine.ok && mine.snap && mine.snap.today === "2026-10-10");
  const other = await app(e, "/api/data", {}, "222");
  assert.equal(other.status, 403);
  const forged = await worker.fetch(new Request(`${ORIGIN}/api/data`, {
    method: "POST", body: JSON.stringify({ initData: initData(OWNER, "999:other") }),
  }), e);
  assert.equal(forged.status, 401);
});

test("sync needs a valid signature, a fresh timestamp and no older snapshot", async () => {
  const e = env();
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), snap: snap() }, "999:other")).status, 401);
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: "2020-01-01T00:00:00Z", snap: snap() })).status, 400);
  assert.equal((await bot(e, "/api/sync", { op: "list", ts: ts(), snap: snap() })).status, 400);
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), snap: snap() })).status, 200);
  assert.equal((await bot(e, "/api/sync", { op: "snapshot", ts: ts(), snap: snap("2020-01-01T00:00:00Z") })).status, 409);
});

test("finishing a workout queues only ticked sets and clears the draft", async () => {
  const e = env();
  assert.equal((await app(e, "/api/draft", { draft: workout })).status, 200);
  assert.ok((await (await app(e, "/api/data", {})).json()).draft);
  const r = await (await app(e, "/api/finish", { workout })).json();
  assert.ok(r.ok);
  const d = await (await app(e, "/api/data", {})).json();
  assert.equal(d.draft, null);
  assert.equal(d.queue.length, 1);
  const w = d.queue[0].data;
  assert.equal(w.sets, 3);
  assert.deepEqual(w.blocks[0].items[0].sets, [{ weight_kg: 26, reps: 10 }, { weight_kg: 26, reps: 9 }]);
  assert.deepEqual(w.blocks[0].items[1].sets, [{ seconds: 40 }]);

  const list = await (await bot(e, "/api/queue", { op: "list", ts: ts() })).json();
  assert.equal(list.items.length, 1);
  const ack = await (await bot(e, "/api/queue/ack", { op: "ack", ts: ts(), ids: [list.items[0].id] })).json();
  assert.equal(ack.removed, 1);
  assert.equal((await (await app(e, "/api/data", {})).json()).queue.length, 0);
});

test("bad workouts and weigh-ins are refused", async () => {
  assert.match(cleanWorkout({ ...workout, blocks: [{ block: "A", items: [{ ex: "x", sets: [{ reps: 5 }] }] }] }), /nothing to save/);
  assert.equal(cleanWorkout({ ...workout, date: "10/10/2026" }), "bad date or time");
  assert.equal(cleanWorkout({ ...workout, blocks: [{ block: "A", items: [{ ex: "../etc", sets: [] }] }] }), "bad exercise");
  assert.equal(cleanWorkout({ ...workout, blocks: [{ block: "A", items: [{ ex: "db_curl", sets: [{ kg: -1, reps: 5, done: true }] }] }] }), "bad weight");
  const e = env();
  assert.equal((await app(e, "/api/body", { date: "2026-10-10", kg: 7 })).status, 400);
  assert.equal((await app(e, "/api/body", { date: "2026-10-10" })).status, 400);
  assert.equal((await app(e, "/api/body", { date: "2026-10-10", kg: 80.4, waist: 90 })).status, 200);
});

test("pages carry the security headers", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/`), env());
  assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/data`), env())).status, 405);
});

test("meal and plan actions are validated and queued", async () => {
  const { cleanAction } = await import("../worker.js");
  const meal = { date: "2026-10-10", time: "12:30", meal: "lunch", desc: "Fish soup", kcal: 330, protein_g: 34, carbs_g: 14, fat_g: 11 };
  assert.equal(cleanAction("meal_add", meal).kcal, 330);
  assert.match(cleanAction("meal_add", { ...meal, kcal: -5 }), /kcal/);
  assert.match(cleanAction("meal_add", { ...meal, desc: "" }), /Describe/);
  assert.equal(cleanAction("meal_add", { ...meal, protein_g: null }), "protein_g is needed");
  assert.deepEqual(cleanAction("meal_delete", { id: "42" }), { id: "42" });
  assert.equal(cleanAction("meal_edit", { id: "x; rm" }), "bad meal id");
  assert.deepEqual(cleanAction("meal_edit", { id: 7, kcal: 400 }), { kcal: 400, id: "7" });
  assert.deepEqual(cleanAction("habit", { habit: "stretch", date: "2026-10-10", done: 1 }), { habit: "stretch", date: "2026-10-10", done: true });
  assert.equal(cleanAction("plan_task", { id: "../x" }), "bad task");
  assert.equal(cleanAction("launch_rockets", {}), "unknown action");
  assert.deepEqual(cleanAction("water", { date: "2026-10-13", time: "14:05", ml: 250, extra: 1 }), { date: "2026-10-13", time: "14:05", ml: 250 });
  assert.match(cleanAction("water", { date: "2026-10-13", time: "14:05", ml: 5000 }), /50 to 2,000/);
  assert.match(cleanAction("water", { date: "2026-10-13", time: "14:05", ml: 2.5 }), /50 to 2,000/);
  assert.deepEqual(cleanAction("water_delete", { id: "1792058000000-0a1b2c3d" }), { id: "1792058000000-0a1b2c3d" });
  assert.deepEqual(cleanAction("water_delete", { id: "c1792058000000" }), { id: "c1792058000000" });
  assert.equal(cleanAction("water_delete", { id: "../x" }), "bad water id");
  const e = env();
  const r = await (await app(e, "/api/do", { kind: "meal_add", data: meal })).json();
  assert.ok(r.ok && r.item.kind === "meal_add");
  assert.equal((await app(e, "/api/do", { kind: "meal_add", data: meal }, "222")).status, 403);
});

test("the pet: only the owner picks it, from the known species, with a short plain name", async () => {
  const e = env();
  assert.equal((await app(e, "/api/pet", { pet: { species: "owl", name: "Blue" } }, "222")).status, 403);
  assert.equal((await app(e, "/api/pet", { pet: { species: "dragon" } })).status, 400);
  const r = await (await app(e, "/api/pet", { pet: { species: "owl", name: "  <b>Sir Hoots-a-lot the Third</b> " } })).json();
  assert.deepEqual(r.pet, { species: "owl", name: "bSir Hoots-a-lot the" });
  const d = await (await app(e, "/api/data", {})).json();
  assert.deepEqual(d.pet, { species: "owl", name: "bSir Hoots-a-lot the" });
  assert.deepEqual((await (await app(e, "/api/pet", { pet: { species: "fox", name: "" } })).json()).pet, { species: "fox", name: null });
});

test("workout edits pass through cleaned; bad ones are dropped, never fatal", async () => {
  const { cleanWorkout } = await import("../worker.js");
  const w = { date: "2026-10-10", time: "18:05", blocks: [{ block: "A", items: [{ ex: "db_curl", sets: [{ kg: 10, reps: 10, done: true }] }] }],
    edits: [{ kind: "swap", stage: "plan", slot: "chest_main", from: "db_bench_press", to: "machine_chest_press", with: ["lat_pulldown", "BAD ID"] },
      { kind: "remove", from: "plank" }, { kind: "add", to: "db_curl" }, { kind: "swap", from: "x" }, { kind: "delete_all" }, null] };
  const c = cleanWorkout(w);
  assert.deepEqual(c.edits, [
    { kind: "swap", stage: "plan", slot: "chest_main", from: "db_bench_press", to: "machine_chest_press", with: ["lat_pulldown"] },
    { kind: "remove", stage: "live", from: "plank", with: [] },
    { kind: "add", stage: "live", to: "db_curl", with: [] }]);
  assert.equal(cleanWorkout({ ...w, edits: undefined }).edits, undefined);
});

test("workout edits: a split needs the exercise that moved; unknown kinds are dropped", async () => {
  const { cleanEdits } = await import("../worker.js");
  const out = cleanEdits([{ kind: "split", from: "lat_pulldown", with: ["db_bench_press"] }, { kind: "split" }, { kind: "rename", from: "x" }]);
  assert.deepEqual(out, [{ kind: "split", stage: "live", from: "lat_pulldown", with: ["db_bench_press"] }]);
});
