// Engine tests: node --test health/app/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as E from "../public/engine.js";

const lib = JSON.parse(readFileSync(new URL("../public/library.json", import.meta.url)));
const EX = E.index(lib);
const profile = {
  weekly_sets_per_muscle: [10, 16], rep_ranges: { compound: [6, 10], isolation: [10, 15], core: [10, 20] },
  increments_kg: { dumbbell: 2, barbell: 2.5, cable: 5, machine: 5 },
};
const at = (date, time = "18:00") => Date.parse(`${date}T${time}:00+08:00`);
const set = (date, ex, o) => ({ wid: `${date}T1800`, date, time: "18:00", ex, ...o });

test("e1RM and volume match workoutlog.py", () => {
  assert.equal(E.e1rm(100, 1), 100);
  assert.equal(E.e1rm(30, 10), 40);
  assert.equal(E.e1rm(30, 20), E.e1rm(30, 12));
  assert.equal(E.volume(EX.hammer_curl, [{ kg: 10, reps: 10 }, { kg: 10, reps: 10 }]), 400);
});

test("warm-ups don't count towards weekly sets", () => {
  const sets = [set("2026-10-01", "db_bench_press", { kg: 10, reps: 10 }), set("2026-10-01", "db_bench_press", { kg: 26, reps: 10 }),
    set("2026-10-01", "db_bench_press", { kg: 26, reps: 10 })];
  const wk = E.weeklySets(sets, EX, at("2026-10-02"));
  assert.equal(wk.chest, 2);
  assert.equal(wk.triceps, 1);
});

test("recovery drops after training and comes back", () => {
  const sets = Array.from({ length: 6 }, () => set("2026-10-01", "db_curl", { kg: 12, reps: 8 }));
  const soon = E.recovery(sets, EX, lib.muscles, at("2026-10-01", "20:00")).biceps;
  const later = E.recovery(sets, EX, lib.muscles, at("2026-10-04")).biceps;
  assert.ok(soon < 40, `soon ${soon}`);
  assert.ok(later > 85, `later ${later}`);
  assert.equal(E.recovery(sets, EX, lib.muscles, at("2026-10-01", "20:00")).quads, 100);
});

test("double progression: same weight until the top of the range, then up", () => {
  const short = [8, 8, 7].map((r) => set("2026-10-01", "db_row", { kg: 22, reps: r }));
  const p1 = E.prescribe(EX.db_row, short, EX, profile, 3);
  assert.deepEqual(p1.sets.map((x) => [x.kg, x.reps]), [[22, 8], [22, 8], [22, 8]]);
  const topped = [10, 10, 10].map((r) => set("2026-10-01", "db_row", { kg: 22, reps: r }));
  const p2 = E.prescribe(EX.db_row, topped, EX, profile, 3);
  assert.deepEqual(p2.sets.map((x) => [x.kg, x.reps]), [[24, 6], [24, 6], [24, 6]]);
  const first = E.prescribe(EX.db_row, topped, EX, profile, 3, true);
  assert.ok(first.sets[0].warmup && first.sets[0].kg === 12);
  const none = E.prescribe(EX.leg_press, [], EX, profile, 4);
  assert.equal(none.sets[0].kg, null);
});

test("bodyweight exercises past 25 reps graduate to a loaded one", () => {
  const sets = [set("2026-10-01", "calf_raise", { reps: 50 })];
  assert.equal(E.pickExercise("calves", sets, EX, new Set(), "2026-10-10"), "machine_calf_raise");
});

test("the plan trains the side that is fresher and further behind", () => {
  const sets = [];
  for (const d of ["2026-10-08", "2026-10-09"]) {
    for (const ex of ["db_bench_press", "db_row", "lat_pulldown", "db_curl"]) {
      for (let i = 0; i < 4; i++) sets.push(set(d, ex, { kg: 20, reps: 8 }));
    }
  }
  const p = E.planWorkout({ lib, profile, sets, now: at("2026-10-10") });
  assert.equal(p.type, "lower");
  const ids = p.blocks.flatMap((b) => b.items.map((i) => i.ex));
  assert.equal(new Set(ids).size, ids.length, "no exercise twice");
  assert.ok(p.minutes >= 40 && p.minutes <= 75, `minutes ${p.minutes}`);
  const forced = E.planWorkout({ lib, profile, sets, now: at("2026-10-10"), type: "upper", swaps: { chest_main: "machine_chest_press" } });
  assert.equal(forced.blocks[0].items[0].ex, "machine_chest_press");
});

test("food status against the plan", () => {
  const t = { kcal: [1900, 2100], protein_g: [130, 145], sat_fat_g_max: 16, fibre_g_min: 30 };
  const s = E.foodStatus({ kcal: 2200, protein_g: 100, sat_fat_g: 10, fibre_g: 31 }, t);
  assert.equal(s.kcal.state, "over");
  assert.equal(s.protein_g.state, "under");
  assert.equal(s.sat_fat_g.state, "in");
  assert.equal(s.fibre_g.state, "in");
});

test("next meal: fits what's left of the day", () => {
  const t = { kcal: [1900, 2100], protein_g: [130, 145], sat_fat_g_max: 16, fibre_g_min: 30, veg_servings: [4, 5] };
  const items = JSON.parse(readFileSync(new URL("../../foodbot/suggestions.json", import.meta.url))).items;
  const lunch = E.pickNext({ kcal: 450, protein_g: 30, sat_fat_g: 5, veg_servings: 0, fibre_g: 4 }, t, items, 12);
  assert.equal(lunch.slot, "lunch");
  assert.equal(lunch.picks.length, 3);
  assert.ok(lunch.picks.every((x) => x.meals.includes("lunch")));
  assert.ok(lunch.picks.every((x) => x.protein_g >= 25));
  const late = E.pickNext({ kcal: 1950, protein_g: 120, sat_fat_g: 15 }, t, items, 19);
  assert.equal(late.slot, "snack");
  assert.ok(late.picks.every((x) => x.kcal <= 250));
  assert.ok(E.pickNext({ kcal: 2300 }, t, items, 20).over);
});

test("the owner's edits steer the plan: favourites, avoided exercises, split pairs", () => {
  const today = "2026-10-10";
  const sets = [set("2026-10-01", "db_bench_press", { kg: 26, reps: 10 })];
  // two swaps to the machine press make it the pick for the slot
  const fav = { ex: { machine_chest_press: { out: 0, in: 2 } }, slot: { chest_main: { machine_chest_press: 2 } }, pairs: {} };
  assert.equal(E.pickExercise("chest_main", sets, EX, new Set(), today, null, fav), "machine_chest_press");
  // one swap isn't enough
  const once = { ex: {}, slot: { chest_main: { machine_chest_press: 1 } }, pairs: {} };
  assert.notEqual(E.pickExercise("chest_main", sets, EX, new Set(), today, null, once), "machine_chest_press");
  // an exercise removed twice is skipped while another fits the slot
  const base = E.pickExercise("chest_main", sets, EX, new Set(), today);
  const avoid = { ex: { [base]: { out: 2, in: 0 } }, slot: {}, pairs: {} };
  const other = E.pickExercise("chest_main", sets, EX, new Set(), today, null, avoid);
  assert.notEqual(other, base);
  // a pair split twice isn't put together again
  const split = { ex: {}, slot: {}, pairs: { [[base, "lat_pulldown"].sort().join("|")]: 2 } };
  assert.notEqual(E.pickExercise("chest_main", sets, EX, new Set(), today, null, split, "lat_pulldown"), base);
  // a swap the owner makes today still wins
  assert.equal(E.pickExercise("chest_main", sets, EX, new Set(), today, base, avoid), base);
  // the plan says why
  const p = E.planWorkout({ lib, profile, sets, now: at(today), type: "upper", prefs: fav });
  const it = p.blocks.flatMap((b) => b.items).find((x) => x.slot === "chest_main");
  assert.equal(it.ex, "machine_chest_press");
  assert.match(it.note, /usually swap to this/);
});

test("moving exercises: within a superset, out to a card of their own, into another superset", () => {
  const mk = () => [
    { block: "A", items: [{ ex: "a1" }, { ex: "a2" }] },
    { block: "B", items: [{ ex: "b1" }] },
    { block: "C", items: [{ ex: "c1" }, { ex: "c2" }, { ex: "c3" }] },
  ];
  const view = (bs) => bs.map((b) => `${b.block}:${b.items.map((i) => i.ex).join("+")}`).join(" ");
  let bs = mk();
  assert.equal(E.moveExercise(bs, { bi: 2, ii: 0 }, { bi: 2, ii: 3 }), null);
  assert.equal(view(bs), "A:a1+a2 B:b1 C:c2+c3+c1", "reordered inside its superset");
  bs = mk();
  assert.deepEqual(E.moveExercise(bs, { bi: 0, ii: 1 }, { card: 2 }), { from: "a2", with: ["a1"] });
  assert.equal(view(bs), "A:a1 B:b1 C:a2 D:c1+c2+c3", "split out to its own card, letters redone");
  bs = mk();
  assert.deepEqual(E.moveExercise(bs, { bi: 2, ii: 1 }, { bi: 1, ii: 1 }), { from: "c2", with: ["c1", "c3"] });
  assert.equal(view(bs), "A:a1+a2 B:b1+c2 C:c1+c3", "joined another card as a superset");
  bs = mk();
  assert.equal(E.moveExercise(bs, { bi: 1, ii: 0 }, { bi: 0, ii: 0 }), null, "a lone exercise joining a superset splits nothing");
  assert.equal(view(bs), "A:b1+a1+a2 B:c1+c2+c3", "its empty card is gone");
  bs = mk();
  assert.equal(E.moveExercise(bs, { bi: 1, ii: 0 }, { card: 3 }), null);
  assert.equal(view(bs), "A:a1+a2 B:c1+c2+c3 C:b1", "a lone exercise moved as a card");
  bs = mk();
  E.moveCard(bs, 2, 0);
  assert.equal(view(bs), "A:c1+c2+c3 B:a1+a2 C:b1");
});

test("stretching: a routine on its own, a cool-down after every session, never counted as training", () => {
  const lib = JSON.parse(readFileSync(new URL("../public/library.json", import.meta.url)));
  const profile = { rep_ranges: { compound: [6, 10], isolation: [10, 15], core: [10, 20] }, increments_kg: {}, weekly_sets_per_muscle: [10, 16] };
  const s = E.planStretch({ lib, profile });
  assert.deepEqual(s.blocks.map((b) => b.items[0].ex), ["ankle_circles", "knee_to_wall", "wall_calf_stretch", "strap_hamstring_stretch", "seated_hamstring_stretch"]);
  assert.ok(s.blocks.every((b) => b.items[0].sets.every((x) => x.sec === 30)) && s.minutes >= 10 && s.minutes <= 14, `about 12 minutes (${s.minutes})`);
  assert.match(s.blocks[1].items[0].note, /each side/);
  const w = E.planWorkout({ lib, profile, sets: [], now: Date.parse("2026-10-20T10:00:00+08:00"), type: "lower" });
  assert.deepEqual(w.blocks.slice(-2).map((b) => b.items[0].ex), ["standing_hamstring_calf_stretch", "knee_to_wall"]);
  assert.equal(w.blocks.at(-1).block, String.fromCharCode(64 + w.blocks.length));
  const removed = E.planWorkout({ lib, profile, sets: [], now: Date.parse("2026-10-20T10:00:00+08:00"), type: "lower", prefs: { ex: { knee_to_wall: { out: 3, in: 0 } } } });
  assert.ok(!removed.blocks.some((b) => b.items.some((i) => i.ex === "knee_to_wall")), "a stretch removed again and again drops out");
  const EX = E.index(lib);
  const sets = [{ ex: "strap_hamstring_stretch", sec: 30, date: "2026-10-19", time: "18:00", wid: "2026-10-19T1800" }];
  assert.deepEqual(E.weeklySets(sets, EX, Date.parse("2026-10-20T10:00:00+08:00")), {}, "no training volume from stretches");
});

test("local dates and times follow the owner's timezone", () => {
  const at = Date.parse("2026-10-13T20:30:00Z");
  assert.equal(E.localDate(at), "2026-10-14");                     // Asia/Singapore until told otherwise
  assert.equal(E.localTime(at), "04:30");
  assert.equal(E.localMs("2026-10-14", "04:30"), at);
  try {
    assert.equal(E.setTimeZone("America/New_York"), "America/New_York");
    assert.equal(E.localDate(at), "2026-10-13");
    assert.equal(E.localTime(at), "16:30");
    assert.equal(E.localMs("2026-10-13", "16:30"), at);
    assert.equal(E.localMs("2026-03-08", "12:00"), Date.parse("2026-03-08T16:00:00Z"));   // after the clocks go forward
    assert.equal(E.setTimeZone("Not/AZone"), "America/New_York");   // an unknown zone is ignored
  } finally {
    E.setTimeZone("Asia/Singapore");
  }
  assert.equal(E.addDays("2026-02-27", 2), "2026-03-01");
});
