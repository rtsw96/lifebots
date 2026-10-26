// Apple Health ingest tests: node --test health/app/test/*.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { days, exerciseHr, hrSamples, merge, parseTime, stampFor, summarise, workout } from "../apple.js";
import worker, { cleanWorkout, ingestKey, keepStamps, stampOf } from "../worker.js";

const TOKEN = "123456:TEST-token_for-vectors";

const payload = {
  data: {
    workouts: [
      { name: "Traditional Strength Training", start: "2026-10-09 19:35:00 +0800", end: "2026-10-09 20:33:00 +0800",
        activeEnergyBurned: { qty: 254, units: "kcal" }, avgHeartRate: { qty: 118.4, units: "bpm" },
        route: [{ lat: 1.3, lon: 103.8 }] },
      { name: "Outdoor Run", start: "2026-10-06 9:01:00 AM +0800", end: "2026-10-06 9:37:00 AM +0800",
        activeEnergy: { qty: 1355.6, units: "kJ" }, distance: { qty: 5.4, units: "km" } },
      { name: "Broken", start: "nonsense", end: "2026-10-06 09:37:00 +0800" },
    ],
    metrics: [
      { name: "step_count", units: "count", data: [{ date: "2026-10-09 00:00:00 +0800", qty: 8123 }, { date: "2026-10-10 00:00:00 +0800", qty: 2040 }] },
      { name: "active_energy", units: "kJ", data: [{ date: "2026-10-09 00:00:00 +0800", qty: 2092 }] },
      { name: "resting_heart_rate", units: "count/min", data: [{ date: "2026-10-09 00:00:00 +0800", qty: 58 }] },
      { name: "body_mass", units: "lb", data: [{ date: "2026-10-09 07:10:00 +0800", qty: 176.4 }] },
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-10-10 00:00:00 +0800", totalSleep: 6.9, deep: 0.8, rem: 1.4,
        sleepStart: "2026-10-09 23:58:00 +0800", sleepEnd: "2026-10-10 07:02:00 +0800" }] },
    ],
  },
};

test("times in 24-hour and 12-hour forms", () => {
  assert.deepEqual(parseTime("2026-10-09 19:35:00 +0800").time, "19:35");
  assert.deepEqual(parseTime("2026-10-06 9:01:00 AM +0800").time, "09:01");
  assert.equal(parseTime("2026-10-06 12:05:00 AM +0800").time, "00:05");
  assert.equal(parseTime("2026-10-06 12:05:00 PM -0500").time, "12:05");
  assert.equal(parseTime("yesterday"), null);
});

test("workouts are summarised without routes, units converted", () => {
  const s = summarise(payload);
  assert.equal(s.workouts.length, 2);
  const [lift, run] = s.workouts;
  assert.equal(lift.min, 58);
  assert.equal(lift.kcal, 254);
  assert.equal(lift.avg_hr, 118);
  assert.equal(lift.route, undefined);
  assert.equal(run.start, "09:01");
  assert.equal(run.kcal, 324);
  assert.equal(run.km, 5.4);
  assert.equal(workout({ name: "x", start: "2026-10-06 09:00:00 +0800", end: "2026-10-06 08:00:00 +0800" }), null);
});

test("daily metrics", () => {
  const d = days(payload.data.metrics);
  assert.equal(d["2026-10-09"].steps, 8123);
  assert.equal(d["2026-10-09"].active_kcal, 500);
  assert.equal(d["2026-10-09"].resting_hr, 58);
  assert.equal(d["2026-10-09"].weight_kg, 80);
  assert.equal(d["2026-10-10"].sleep_h, 6.9);
  assert.equal(d["2026-10-10"].wake, "07:02");
});

test("export version 2: date-only nightly sleep, nested heart rate", () => {
  const d = days([{ name: "sleep_analysis", units: "hr", data: [{ date: "2026-10-10", totalSleep: 7.2, asleep: 7.2, deep: 1, rem: 1.5,
    sleepStart: "2026-10-09 23:40:00 +0800", sleepEnd: "2026-10-10 06:55:00 +0800", inBed: 7.6 }] }]);
  assert.equal(d["2026-10-10"].sleep_h, 7.2);
  assert.equal(d["2026-10-10"].bed, "23:40");
  const w = workout({ id: "x", name: "Outdoor Run", start: "2026-10-06 09:01:00 +0800", end: "2026-10-06 09:37:00 +0800", duration: 2160,
    activeEnergyBurned: { qty: 324, units: "kcal" }, distance: { qty: 3.36, units: "mi" },
    heartRate: { min: { qty: 98, units: "bpm" }, avg: { qty: 156.4, units: "bpm" }, max: { qty: 171, units: "bpm" } },
    stepCount: [{ date: "2026-10-06 09:02:00 +0800", qty: 160, units: "count" }] });
  assert.equal(w.km, 5.41);
  assert.equal(w.avg_hr, 156);
  assert.equal(w.max_hr, 171);
});

test("a newer post replaces a day's figures, and old days drop off", () => {
  const a = merge(null, summarise(payload), "2026-10-10");
  const b = merge(a, { workouts: [], days: { "2026-10-10": { steps: 9000 } } }, "2026-10-10");
  assert.equal(b.days["2026-10-10"].steps, 9000);
  assert.equal(b.days["2026-10-10"].sleep_h, 6.9);
  const c = merge(b, { workouts: [], days: {} }, "2028-01-01");
  assert.equal(Object.keys(c.days).length, 0);
});

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

test("the endpoint needs the ingest key", async () => {
  const env = { BOT_TOKEN: TOKEN, OWNER_ID: "111", HEALTH: new MemoryKV() };
  const post = (key) => worker.fetch(new Request("https://h.example/api/apple", {
    method: "POST", body: JSON.stringify(payload), headers: key ? { "X-Health-Key": key } : {},
  }), env);
  assert.equal((await post(null)).status, 401);
  assert.equal((await post("0".repeat(40))).status, 401);
  const key = await ingestKey(TOKEN);
  assert.equal(key.length, 40);
  const ok = await (await post(key)).json();
  assert.deepEqual([ok.workouts, ok.days], [2, 2]);
  const stored = await env.HEALTH.get("apple", "json");
  assert.equal(Object.keys(stored.workouts).length, 2);
  assert.ok(!JSON.stringify(stored).includes("103.8"), "no coordinates stored");
});

// A strength workout 18:00-18:40 SGT on 13 Oct with per-minute heart rate: minute i reads
// avg 100 + i, max 105 + i. The app ticked two lat pulldown sets, a bench set and a plank.
const sgt = (hms) => Date.parse(`2026-10-13T${hms}+08:00`);
const hrData = Array.from({ length: 40 }, (_, i) => ({ date: `2026-10-13 18:${String(i).padStart(2, "0")}:00 +0800`, Min: 90 + i, Avg: 100 + i, Max: 105 + i, units: "count/min" }));
const lift = { name: "Traditional Strength Training", start: "2026-10-13 18:00:00 +0800", end: "2026-10-13 18:40:00 +0800",
  avgHeartRate: { qty: 120, units: "bpm" }, heartRateData: hrData };
const finished = { date: "2026-10-13", time: "18:00", blocks: [
  { block: "A", items: [{ ex: "lat_pulldown", sets: [{ kg: 45, reps: 10, done: true, at: sgt("18:05:30"), seq: 1 }, { kg: 45, reps: 9, done: true, at: sgt("18:08:30"), seq: 2 }] }] },
  { block: "B", items: [{ ex: "db_bench_press", sets: [{ kg: 26, reps: 8, done: true, at: sgt("18:20:10"), seq: 3 }, { kg: 26, reps: 8 }] }] },
  { block: "C", items: [{ ex: "plank", sets: [{ sec: 60, done: true, at: sgt("18:30:00"), seq: 4 }] }] }] };

test("heart rate per exercise: each set's work time plus 30 s, matched to the minutes", () => {
  const stamp = stampOf(cleanWorkout(finished));
  assert.equal(stamp.wid, "2026-10-13T1800");
  assert.equal(stamp.sets.length, 4); // the unticked bench set is not there
  assert.equal(stamp.sets[3].sec, 60);
  const hr = exerciseHr(hrSamples(hrData), stamp.sets);
  assert.deepEqual(hr.lat_pulldown, { avg: 106, max: 113 }); // minutes 4, 5, 7, 8
  assert.deepEqual(hr.db_bench_press, { avg: 120, max: 125 }); // minutes 19, 20
  assert.deepEqual(hr.plank, { avg: 130, max: 135 });          // a 60 s hold: minutes 29, 30
  assert.equal(exerciseHr([], stamp.sets), null);
  assert.deepEqual(hrSamples([{ date: "2026-10-13 18:00:00 +0800", qty: 97 }, { date: "bad", Avg: 100 }, { date: "2026-10-13 18:01:00 +0800", Avg: 400 }]),
    [{ ms: sgt("18:00:00"), avg: 97, max: 97 }]);
});

test("the Watch workout finds the app workout it overlaps, and nothing else", () => {
  const stamp = stampOf(cleanWorkout(finished));
  const other = { wid: "2026-10-12T0700", sets: [{ ex: "lat_pulldown", at: Date.parse("2026-10-12T07:10:00+08:00") }] };
  assert.equal(stampFor(lift, [other, stamp]), stamp);
  assert.equal(stampFor({ ...lift, start: "2026-10-13 21:00:00 +0800", end: "2026-10-13 21:30:00 +0800" }, [other, stamp]), null);
  const kept = keepStamps([other, stamp], { ...stamp }, sgt("19:00:00"));
  assert.deepEqual(kept.map((x) => x.wid), ["2026-10-13T1800", "2026-10-12T0700"]); // no duplicate
  assert.deepEqual(keepStamps([other], stamp, Date.parse("2026-10-25T00:00:00Z")).map((x) => x.wid), ["2026-10-13T1800"]); // 8 days on
});

test("ingest keeps each exercise's average and max, never the minutes", async () => {
  const env = { BOT_TOKEN: TOKEN, OWNER_ID: "111", HEALTH: new MemoryKV() };
  await env.HEALTH.put("hr_stamps", JSON.stringify([stampOf(cleanWorkout(finished))]));
  const post = async (body) => worker.fetch(new Request("https://h.example/api/apple", {
    method: "POST", body: JSON.stringify(body), headers: { "X-Health-Key": await ingestKey(TOKEN) } }), env);
  assert.equal((await post({ data: { workouts: [lift] } })).status, 200);
  let w = Object.values((await env.HEALTH.get("apple", "json")).workouts)[0];
  assert.equal(w.app, "2026-10-13T1800");
  assert.deepEqual(w.hr_ex.lat_pulldown, { avg: 106, max: 113 });
  assert.deepEqual(Object.keys(w).sort(), ["app", "avg_hr", "date", "end", "hr_ex", "id", "kcal", "km", "max_hr", "min", "name", "start"]);
  assert.ok(!JSON.stringify(await env.HEALTH.get("apple", "json")).includes("count/min"), "no per-minute readings stored");
  // the next hourly post without workout metrics keeps what was worked out
  const { heartRateData, ...bare } = lift;
  await post({ data: { workouts: [bare] } });
  w = Object.values((await env.HEALTH.get("apple", "json")).workouts)[0];
  assert.deepEqual(w.hr_ex.plank, { avg: 130, max: 135 });
});
