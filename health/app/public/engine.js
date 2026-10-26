// Training engine for the health app. Pure functions, no DOM: the page imports
// it, and test/engine.test.mjs runs it under node.
//
// The arithmetic matches health/foodbot/workoutlog.py, so the app and the bot
// agree: Epley e1RM capped at 12 reps; a weighted set under 60% of that
// exercise's top weight in the same workout is a warm-up and doesn't count;
// a primary muscle counts a set as 1, a secondary muscle as 0.5.
//
// A set (as the snapshot carries it): {wid, date, time, block, ex, kg, reps, sec, km}.

export const EPLEY_CAP = 12;
export const WARMUP_SHARE = 0.6;
export const RECOVERY_TAU_H = 36;   // fatigue halves roughly every 25 hours
export const FATIGUE_PER_SET = 12;  // % of recovery used by one hard set, at the moment it ends

// ------------------------------------------------------------------ local time
// Dates and clock times are the owner's own (the snapshot's tz, from settings.json).
// The page calls setTimeZone() once data arrives; until then, and in tests, it's
// Asia/Singapore.
let TZ = "Asia/Singapore";
let FMT = null;
const MS_CACHE = new Map();

export function setTimeZone(tz) {
  if (!tz || tz === TZ) return TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    TZ = tz;
    FMT = null;
    MS_CACHE.clear();
  } catch { /* unknown zone: keep the old one */ }
  return TZ;
}

export const tz = () => TZ;

function parts(ms) {
  if (!FMT) {
    FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  const p = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  if (p.hour === "24") p.hour = "00";
  return p;
}

/** The zone's offset from UTC at that moment, in ms. */
export function tzOffset(ms) {
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** YYYY-MM-DD and HH:MM at that moment, in the owner's timezone. */
export function localDate(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
export function localTime(ms) {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

/** The moment (ms) of a local date and time (HH:MM). */
export function localMs(date, time = "12:00") {
  const key = `${date}T${time}`;
  let v = MS_CACHE.get(key);
  if (v === undefined) {
    const wall = Date.parse(`${key}:00Z`);
    v = wall - tzOffset(wall - tzOffset(wall));
    if (MS_CACHE.size > 5000) MS_CACHE.clear();
    MS_CACHE.set(key, v);
  }
  return v;
}

/** Calendar arithmetic on YYYY-MM-DD strings (no timezone involved). */
export function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
}

export function e1rm(kg, reps) {
  if (!(kg > 0) || !(reps > 0)) return 0;
  return reps <= 1 ? kg : kg * (1 + Math.min(reps, EPLEY_CAP) / 30);
}

export function index(lib) {
  const by = {};
  for (const e of lib.exercises) by[e.id] = e;
  return by;
}

/** Sets grouped by workout, oldest first: [{wid, date, time, sets}]. */
export function workouts(sets) {
  const m = new Map();
  for (const s of sets) {
    if (!m.has(s.wid)) m.set(s.wid, { wid: s.wid, date: s.date, time: s.time, sets: [] });
    m.get(s.wid).sets.push(s);
  }
  return [...m.values()].sort((a, b) => (a.wid < b.wid ? -1 : 1));
}

function topKg(sets, wid, ex) {
  let top = 0;
  for (const s of sets) if (s.wid === wid && s.ex === ex && s.kg > top) top = s.kg;
  return top;
}

export function isWarmup(s, sets, EX) {
  const ex = EX[s.ex];
  if (!ex || ex.kind !== "weight") return false;
  return (s.kg || 0) < WARMUP_SHARE * topKg(sets, s.wid, s.ex);
}

/** Hard sets as {muscle: weight} contributions, warm-ups, cardio and stretches dropped. */
function hardSets(sets, EX) {
  const out = [];
  for (const s of sets) {
    const ex = EX[s.ex];
    if (!ex || ex.kind === "cardio" || ex.role === "stretch" || isWarmup(s, sets, EX)) continue;
    out.push({ s, ex });
  }
  return out;
}

const when = (s) => localMs(s.date, s.time || "12:00");

/** Hard sets per muscle over the 7 days ending at `now` (ms). */
export function weeklySets(sets, EX, now) {
  const from = now - 7 * 86400e3;
  const out = {};
  for (const { s, ex } of hardSets(sets, EX)) {
    const t = when(s);
    if (t < from || t > now) continue;
    for (const m of ex.primary) out[m] = (out[m] || 0) + 1;
    for (const m of ex.secondary) out[m] = (out[m] || 0) + 0.5;
  }
  return out;
}

/** Recovery per muscle, 0-100. Each hard set uses FATIGUE_PER_SET points (half
 *  for a secondary muscle), and fatigue fades exponentially with RECOVERY_TAU_H. */
export function recovery(sets, EX, muscles, now) {
  const fatigue = Object.fromEntries(muscles.map((m) => [m, 0]));
  for (const { s, ex } of hardSets(sets, EX)) {
    const h = (now - when(s)) / 3600e3 - 1; // the set ended about an hour after the start time
    if (h > 7 * 24) continue;
    const f = Math.exp(-Math.max(0, h) / RECOVERY_TAU_H);
    for (const m of ex.primary) fatigue[m] += f;
    for (const m of ex.secondary) fatigue[m] += 0.5 * f;
  }
  const out = {};
  for (const m of muscles) out[m] = Math.max(0, Math.min(100, Math.round(100 - FATIGUE_PER_SET * fatigue[m])));
  return out;
}

/** The progress number for one exercise in one session: best e1RM, reps or seconds. */
export function best(ex, sets) {
  let b = 0;
  for (const s of sets) {
    const v = ex.kind === "weight" ? e1rm(s.kg, s.reps) : ex.kind === "time" ? s.sec || 0 : s.reps || 0;
    if (v > b) b = v;
  }
  return b;
}

export function volume(ex, sets) {
  if (ex.kind !== "weight") return 0;
  const f = ex.load === "pair" || ex.load === "side" ? 2 : 1;
  return sets.reduce((a, s) => a + (s.kg || 0) * (s.reps || 0), 0) * f;
}

/** Per-session history of one exercise: [{wid, date, sets, best, volume}]. */
export function history(sets, ex) {
  return workouts(sets.filter((s) => s.ex === ex.id)).map((w) => ({
    wid: w.wid, date: w.date, sets: w.sets, best: best(ex, w.sets), volume: volume(ex, w.sets),
  }));
}

// ------------------------------------------------------------------ planner

// Each slot is a job in the session; its pool lists exercises that do that job,
// best first. Main slots keep the lift you do most (so it can progress);
// accessory slots rotate to the one done least recently.
export const SLOTS = {
  chest_main: { label: "Chest press", main: true, pool: ["db_bench_press", "bb_bench_press", "db_incline_press", "machine_chest_press"] },
  chest_acc: { label: "Chest accessory", pool: ["db_fly", "cable_fly", "db_incline_press", "push_up"] },
  row: { label: "Row", main: true, pool: ["db_row", "cable_row", "db_bent_over_row", "bb_row"] },
  vpull: { label: "Vertical pull", main: true, pool: ["lat_pulldown", "assisted_pull_up", "pull_up"] },
  press: { label: "Shoulder press", main: true, pool: ["db_shoulder_press", "machine_shoulder_press"] },
  delts: { label: "Delts", pool: ["db_lateral_raise", "cable_lateral_raise", "face_pull", "db_rear_delt_fly"] },
  biceps: { label: "Biceps", pool: ["db_curl", "hammer_curl", "incline_db_curl", "cable_curl", "cross_body_hammer_curl"] },
  triceps: { label: "Triceps", pool: ["cable_pushdown", "db_skullcrusher", "cable_overhead_ext", "db_kickback", "bench_dip"] },
  quads_main: { label: "Squat or press", main: true, pool: ["leg_press", "db_squat", "goblet_squat", "bb_squat"] },
  hinge: { label: "Hinge", main: true, pool: ["db_rdl", "bb_rdl", "hip_thrust"] },
  quads_acc: { label: "Single leg", pool: ["db_split_squat", "db_lunge", "leg_extension"] },
  hams: { label: "Hamstring curl", pool: ["seated_leg_curl", "lying_leg_curl"] },
  glutes: { label: "Glutes", pool: ["hip_thrust", "hip_abductor", "single_leg_glute_bridge"] },
  calves: { label: "Calves", pool: ["machine_calf_raise", "calf_raise"] },
  core: { label: "Core", pool: ["plank", "hanging_leg_raise", "cable_crunch", "dead_bug", "crunch", "bicycle_crunch"] },
};

// Sessions: four supersets of two, about 50-60 minutes with warm-up.
export const TEMPLATES = {
  upper: { name: "Upper body", blocks: [["chest_main", "row"], ["vpull", "press"], ["delts", "chest_acc"], ["biceps", "triceps"]],
    muscles: ["chest", "lats", "upper_back", "front_delts", "side_delts", "rear_delts", "biceps", "triceps"] },
  lower: { name: "Lower body and core", blocks: [["quads_main", "core"], ["hinge", "calves"], ["quads_acc", "hams"], ["glutes", "delts"]],
    muscles: ["quads", "hamstrings", "glutes", "adductors", "calves", "abs"] },
};

const r5 = (x) => Math.round(x * 2) / 2;

function inc(ex, profile) {
  return (profile.increments_kg || {})[ex.equipment] || 2;
}

function roundTo(x, step) {
  return Math.max(step, Math.round(x / step) * step);
}

function rangeFor(ex, profile) {
  if (ex.kind === "time") return [20, 60];
  const rr = profile.rep_ranges || {};
  return (ex.role === "compound" ? rr.compound : ex.role === "core" ? rr.core : rr.isolation) || [8, 12];
}

/** Working sets of the last session with this exercise (warm-ups dropped). */
export function lastWorking(sets, EX, exId) {
  const mine = sets.filter((s) => s.ex === exId);
  if (!mine.length) return null;
  const wid = mine.reduce((a, s) => (s.wid > a ? s.wid : a), "");
  const sess = mine.filter((s) => s.wid === wid);
  const work = sess.filter((s) => !isWarmup(s, sess, EX));
  return { wid, date: sess[0].date, sets: work };
}

/** Targets for one exercise: double progression inside the rep range. */
export function prescribe(ex, sets, EX, profile, nSets, first = false) {
  const [lo, hi] = rangeFor(ex, profile);
  const last = lastWorking(sets, EX, ex.id);
  const mk = (n, o) => Array.from({ length: n }, () => ({ ...o }));
  if (ex.role === "stretch") { // a stretch doesn't progress: the same easy-strong hold each time
    const sec = ex.hold || 30;
    return { sets: mk(nSets, { sec }), note: ex.cue || `Hold ${sec}s${ex.sides === 2 ? " each side" : ""}: a strong pull, never pain. No bouncing.`, last };
  }
  if (ex.kind === "weight") {
    if (!last) {
      return { sets: mk(nSets, { reps: lo + 2, kg: null }), note: `New: pick a weight you could lift about ${lo + 4} times, and stop at ${lo + 2}.` };
    }
    const w = Math.max(...last.sets.map((s) => s.kg || 0));
    const atW = last.sets.filter((s) => s.kg === w).map((s) => s.reps || 0);
    let kg = w;
    let reps;
    let note;
    if (atW.length && Math.min(...atW) >= hi) {
      kg = r5(w + inc(ex, profile));
      reps = lo;
      note = `Up to ${kg} kg: you hit ${hi}+ on every set last time.`;
    } else {
      reps = Math.min(hi, Math.max(lo, Math.min(...atW) + 1));
      note = `Same ${w} kg, aim for ${reps} on every set; at ${hi} across the board, go up.`;
    }
    const out = mk(nSets, { reps, kg });
    if (first && ex.role === "compound" && kg >= 8) {
      out.unshift({ reps: 10, kg: roundTo(kg * 0.5, inc(ex, profile)), warmup: true });
    }
    return { sets: out, note, last };
  }
  if (ex.kind === "time") {
    const b = last ? Math.max(...last.sets.map((s) => s.sec || 0)) : 0;
    const sec = last ? Math.min(90, b + 5) : 30;
    return { sets: mk(nSets, { sec }), note: last ? `Hold ${sec}s, 5s more than last time.` : "Hold with good form; stop before your back sags.", last };
  }
  const b = last ? Math.max(...last.sets.map((s) => s.reps || 0)) : 0;
  const reps = last ? b + 1 : Math.max(lo, 12);
  return { sets: mk(nSets, { reps }), note: last ? `Beat ${b}: aim for ${reps}.` : "Controlled reps, stop 2 short of failure.", last };
}

function lastDone(sets, exId) {
  let d = "";
  for (const s of sets) if (s.ex === exId && s.wid > d) d = s.wid;
  return d;
}

function timesDone(sets, exId, sinceDate) {
  return new Set(sets.filter((s) => s.ex === exId && s.date >= sinceDate).map((s) => s.wid)).size;
}

/** What your own edits say (from the snapshot's workout_prefs): an exercise they
 *  keep removing or swapping away (2+ more outs than ins) is avoided; two exercises they
 *  split apart twice or more (say the machines are at opposite ends of the gym) aren't
 *  paired again; and the exercise they keep swapping to for a slot (2+ times) becomes
 *  the pick. Each returns a short reason for the plan, or null. */
export const PREF_MIN = 2;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function avoided(prefs, id) {
  const e = prefs && prefs.ex && prefs.ex[id];
  return !!e && (e.out || 0) - (e.in || 0) >= PREF_MIN;
}
function clashes(prefs, id, partner) {
  return !!(prefs && prefs.pairs && partner && (prefs.pairs[pairKey(id, partner)] || 0) >= PREF_MIN);
}
function favourite(prefs, slotId, pool) {
  const to = prefs && prefs.slot && prefs.slot[slotId];
  if (!to) return null;
  const best = Object.entries(to).filter(([id, n]) => n >= PREF_MIN && pool.includes(id)).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** The exercise for a slot: a swap if given, else the main lift you do most
 *  (accessories: the one done least recently), never one already chosen.
 *  `prefs` and `partner` (the other exercise in its superset) apply your edits. */
export function pickExercise(slotId, sets, EX, taken, todayISO, swap, prefs = null, partner = null) {
  return pickWhy(slotId, sets, EX, taken, todayISO, swap, prefs, partner).id;
}

function pickWhy(slotId, sets, EX, taken, todayISO, swap, prefs, partner) {
  const slot = SLOTS[slotId];
  const all = slot.pool.filter((id) => EX[id] && !taken.has(id));
  if (swap && EX[swap] && !taken.has(swap)) return { id: swap, why: null };
  if (!all.length) return { id: null, why: null };
  // your edits narrow the pool, but never empty it
  const noClash = all.filter((id) => !clashes(prefs, id, partner));
  const pool = (noClash.filter((id) => !avoided(prefs, id)).length ? noClash.filter((id) => !avoided(prefs, id))
    : noClash.length ? noClash : all);
  const fav = favourite(prefs, slotId, pool);
  const base = defaultPick(slot, pool, sets, EX, todayISO);
  const id = fav || base;
  let why = null;
  if (fav && fav !== base) why = "You usually swap to this one.";
  else if (pool.length < all.length) {
    const left = all.filter((x) => !pool.includes(x));
    if (left.some((x) => clashes(prefs, x, partner))) why = `Not paired with ${EX[partner] ? EX[partner].name : "its partner"}: you split them before.`;
    else why = "Skipping exercises you usually remove or swap out.";
  }
  return { id, why };
}

function defaultPick(slot, pool, sets, EX, todayISO) {
  const done = pool.filter((id) => lastDone(sets, id));
  if (!done.length) return pool[0];
  let id;
  if (slot.main) {
    const since = new Date(Date.parse(todayISO) - 60 * 86400e3).toISOString().slice(0, 10);
    id = done.sort((a, b) => timesDone(sets, b, since) - timesDone(sets, a, since)
      || (lastDone(sets, b) > lastDone(sets, a) ? 1 : -1))[0];
  } else {
    id = done.sort((a, b) => (lastDone(sets, a) < lastDone(sets, b) ? -1 : 1))[0];
  }
  return graduate(id, pool, sets, EX);
}

export const GRADUATE_REPS = 25;

/** A bodyweight exercise done for 25+ reps has stopped building much: move to
 *  a loaded exercise in the same slot. */
function graduate(id, pool, sets, EX) {
  if (EX[id].kind !== "reps") return id;
  const top = Math.max(0, ...sets.filter((s) => s.ex === id).map((s) => s.reps || 0));
  if (top < GRADUATE_REPS) return id;
  return pool.find((x) => EX[x].kind === "weight") || id;
}

function sessionType(sets, EX) {
  const w = workouts(sets.filter((s) => EX[s.ex] && EX[s.ex].kind !== "cardio" && EX[s.ex].role !== "stretch"));
  if (!w.length) return null;
  const last = w[w.length - 1].sets;
  let up = 0;
  let low = 0;
  for (const s of last) {
    for (const m of EX[s.ex].primary) {
      if (TEMPLATES.upper.muscles.includes(m)) up++;
      else if (TEMPLATES.lower.muscles.includes(m)) low++;
    }
  }
  return up >= low ? "upper" : "lower";
}

/** Which session today, and why: the side that is more recovered and further
 *  behind its weekly sets; on a tie, the opposite of last time. */
export function chooseType(sets, EX, lib, profile, now) {
  const rec = recovery(sets, EX, lib.muscles, now);
  const wk = weeklySets(sets, EX, now);
  const [lo] = profile.weekly_sets_per_muscle || [10, 16];
  const score = {};
  const detail = {};
  for (const [k, t] of Object.entries(TEMPLATES)) {
    const ready = t.muscles.reduce((a, m) => a + rec[m], 0) / t.muscles.length;
    const need = t.muscles.reduce((a, m) => a + Math.max(0, lo - (wk[m] || 0)) / lo, 0) / t.muscles.length;
    score[k] = (ready / 100) * (0.5 + need);
    detail[k] = { ready: Math.round(ready), behind: Math.round(need * 100) };
  }
  const prev = sessionType(sets, EX);
  let type = score.upper >= score.lower ? "upper" : "lower";
  if (Math.abs(score.upper - score.lower) < 0.05 && prev) type = prev === "upper" ? "lower" : "upper";
  const other = type === "upper" ? "lower" : "upper";
  const why = `${TEMPLATES[type].name}: ${detail[type].ready}% recovered and ${detail[type].behind}% short of this week's sets, `
    + `against ${detail[other].ready}% and ${detail[other].behind}% for ${TEMPLATES[other].name.toLowerCase()}.`;
  return { type, why, detail };
}

const SEC_PER_SET = { compound: 50, isolation: 40, core: 40, cardio: 0, stretch: 65 };
const REST_SEC = { compound: 120, isolation: 75, core: 60, cardio: 0, stretch: 10 };

// Stretching: hamstrings and ankles, a common tight spot for people who sit a lot. Static holds of 30 s are as
// good as 60 s for hamstring length (Bandy et al., 1997); ACSM suggests 2-4 holds a muscle,
// about 60 s in all, at least 2-3 days a week and daily for the most gain. Calf stretching
// adds a little ankle bend (dorsiflexion) over weeks (Radford et al., 2006). Holds are done
// after lifting, where they can't blunt strength.
export const STRETCH_ROUTINES = {
  hams_ankles: { name: "Stretch: hamstrings and ankles", items: [
    ["ankle_circles", 1], ["knee_to_wall", 3], ["wall_calf_stretch", 2], ["strap_hamstring_stretch", 3], ["seated_hamstring_stretch", 2]] },
};
export const COOLDOWN = [["standing_hamstring_calf_stretch", 2], ["knee_to_wall", 2]];

function stretchBlocks(items, EX, profile, prefs, startAt = 0) {
  const out = [];
  for (const [id, n] of items) {
    const ex = EX[id];
    if (!ex || avoided(prefs, id)) continue;
    const p = prescribe(ex, [], EX, profile, n);
    out.push({ block: String.fromCharCode(65 + startAt + out.length), items: [{ slot: null, ex: id, sets: p.sets, note: p.note, last: null }] });
  }
  return out;
}

const stretchSeconds = (blocks, EX) => blocks.reduce((a, b) => a + b.items.reduce((c, it) =>
  c + it.sets.length * ((it.sets[0].sec || 30) * (EX[it.ex].sides || 1) + REST_SEC.stretch), 0), 0);

/** A stretching session on its own, any day: each stretch is a card of its own. */
export function planStretch({ lib, profile, routine = "hams_ankles", prefs = null }) {
  const EX = index(lib);
  const r = STRETCH_ROUTINES[routine];
  const blocks = stretchBlocks(r.items, EX, profile, prefs);
  return { type: "stretch", name: r.name, why: "Hold each stretch for 30 s a side.", minutes: Math.round(stretchSeconds(blocks, EX) / 60), blocks };
}

export function restFor(ex) {
  return REST_SEC[ex.role] || 75;
}

/** Today's workout. opts: {type, swaps: {slot: exId}, prefs: the snapshot's workout_prefs}. */
export function planWorkout({ lib, profile, sets, now, type, swaps = {}, prefs = null }) {
  const EX = index(lib);
  const today = localDate(now);
  const pick = type ? { type, why: "Chosen by you." } : chooseType(sets, EX, lib, profile, now);
  const t = TEMPLATES[pick.type];
  const taken = new Set();
  const blocks = [];
  let first = true;
  let seconds = 6 * 60; // general warm-up
  t.blocks.forEach((pair, i) => {
    const items = [];
    for (const slotId of pair) {
      const partner = items.length ? items[0].ex : null;
      const { id, why } = pickWhy(slotId, sets, EX, taken, today, swaps[slotId], prefs, partner);
      if (!id) continue;
      taken.add(id);
      const ex = EX[id];
      const n = SLOTS[slotId].main ? 4 : 3;
      const p = prescribe(ex, sets, EX, profile, n, first && ex.role === "compound");
      if (ex.role === "compound") first = false;
      items.push({ slot: slotId, ex: id, sets: p.sets, note: why ? `${p.note} ${why}` : p.note, last: p.last ? p.last.sets : null });
    }
    if (!items.length) return;
    const rounds = Math.max(...items.map((x) => x.sets.length));
    const work = items.reduce((a, x) => a + (SEC_PER_SET[EX[x.ex].role] || 40), 0);
    const rest = Math.max(...items.map((x) => restFor(EX[x.ex])));
    seconds += rounds * (work + rest) + 60;
    blocks.push({ block: String.fromCharCode(65 + i), items });
  });
  // A short cool-down stretch for the hamstrings and ankles closes every session (a stretch you
  // keep removing drops out, like any exercise).
  const cool = stretchBlocks(COOLDOWN, EX, profile, prefs, blocks.length);
  blocks.push(...cool);
  seconds += stretchSeconds(cool, EX);
  return { type: pick.type, name: t.name, why: pick.why, date: today, minutes: Math.round(seconds / 60), blocks };
}

/** Other exercises that can fill a slot (for the swap menu). */
export function swapOptions(slotId, EX) {
  return (SLOTS[slotId] ? SLOTS[slotId].pool : []).filter((id) => EX[id]);
}

const reletter = (blocks) => blocks.forEach((b, k) => { b.block = String.fromCharCode(65 + k); });

/** Move a card (an exercise or a superset) to position `to` in the order. In place. */
export function moveCard(blocks, from, to) {
  if (from === to || from < 0 || from >= blocks.length) return blocks;
  const [b] = blocks.splice(from, 1);
  blocks.splice(Math.max(0, Math.min(blocks.length, to)), 0, b);
  reletter(blocks);
  return blocks;
}

/** Move one exercise, sets and all, in place. `to` is {bi, ii}: into card bi at position ii
 *  (joining its superset), or {card: k}: a card of its own at position k. Positions are
 *  counted before the move. Returns the split it caused, {from, with}, when the exercise left
 *  a superset whose other exercises stay together (the planner learns not to pair them). */
export function moveExercise(blocks, from, to) {
  const src = blocks[from.bi];
  if (!src || !src.items[from.ii]) return null;
  const partners = src.items.filter((_, k) => k !== from.ii).map((x) => x.ex);
  if (to.card == null && to.bi === from.bi) {
    const [it] = src.items.splice(from.ii, 1);
    src.items.splice(Math.min(src.items.length, to.ii > from.ii ? to.ii - 1 : to.ii), 0, it);
    return null;
  }
  if (to.card != null && src.items.length === 1) {
    moveCard(blocks, from.bi, to.card > from.bi ? to.card - 1 : to.card);
    return null;
  }
  const [it] = src.items.splice(from.ii, 1);
  if (to.card != null) {
    blocks.splice(to.card, 0, { block: "", items: [it] });
    if (!src.items.length) blocks.splice(blocks.indexOf(src), 1);
  } else {
    const dst = blocks[to.bi];
    dst.items.splice(Math.max(0, Math.min(dst.items.length, to.ii)), 0, it);
    if (!src.items.length) blocks.splice(blocks.indexOf(src), 1);
  }
  reletter(blocks);
  return partners.length ? { from: it.ex, with: partners } : null;
}

// ------------------------------------------------------------------ food

/** Day totals against targets: {key: {value, lo, hi, state}} where state is
 *  "under", "in" or "over" (sat fat has only a cap; fibre and fruit only a floor). */
export function foodStatus(day, targets) {
  const out = {};
  const pair = (k, v) => {
    const t = targets[k];
    if (!Array.isArray(t)) return;
    out[k] = { value: v, lo: t[0], hi: t[1], state: v < t[0] ? "under" : v > t[1] ? "over" : "in" };
  };
  const d = day || {};
  pair("kcal", d.kcal || 0);
  pair("protein_g", d.protein_g || 0);
  pair("carbs_g", d.carbs_g || 0);
  pair("fat_g", d.fat_g || 0);
  pair("veg_servings", d.veg_servings || 0);
  if (targets.sat_fat_g_max != null) {
    const v = d.sat_fat_g || 0;
    out.sat_fat_g = { value: v, lo: 0, hi: targets.sat_fat_g_max, state: v > targets.sat_fat_g_max ? "over" : "in" };
  }
  if (targets.fibre_g_min != null) {
    const v = d.fibre_g || 0;
    out.fibre_g = { value: v, lo: targets.fibre_g_min, hi: null, state: v < targets.fibre_g_min ? "under" : "in" };
  }
  return out;
}

/** 7-day trailing average of body weight per reading date. */
export function weightTrend(body) {
  const pts = body.filter((b) => b.kg).map((b) => ({ date: b.date, kg: b.kg, t: Date.parse(b.date) }));
  return pts.map((p) => {
    const win = pts.filter((q) => q.t <= p.t && q.t > p.t - 7 * 86400e3);
    return { ...p, avg: win.reduce((a, q) => a + q.kg, 0) / win.length };
  });
}

/** What to eat next: the options that best fit what's left of today's plan.
 *  Pure arithmetic on the suggestion list; scores calories near the per-meal
 *  budget, protein towards what's still needed, sat fat under what's left of
 *  the cap, and veg and fibre when the day is short. */
export function pickNext(day, t, items, hourNow) {
  const eaten = (k) => (day && day[k]) || 0;
  const slots = hourNow < 10.5 ? ["breakfast", "lunch", "dinner"] : hourNow < 15 ? ["lunch", "dinner"] : hourNow < 21 ? ["dinner"] : ["snack"];
  const n = slots.length;
  const kcalLeft = t.kcal[1] - eaten("kcal");
  const need = {
    kcal: Math.max(0, (t.kcal[0] + t.kcal[1]) / 2 - eaten("kcal")) / n,
    protein: Math.max(0, t.protein_g[0] - eaten("protein_g")) / n,
    sat: Math.max(0, t.sat_fat_g_max - eaten("sat_fat_g")) / n,
    veg: Math.max(0, t.veg_servings[0] - eaten("veg_servings")),
    fibre: Math.max(0, t.fibre_g_min - eaten("fibre_g")),
  };
  let slot = slots[0];
  if (kcalLeft < 250) slot = "snack";
  const pool = items.filter((x) => x.meals.includes(slot));
  const score = (x) => {
    const kTarget = slot === "snack" ? Math.min(250, Math.max(kcalLeft, 120)) : Math.max(need.kcal, 250);
    let sc = -Math.abs(x.kcal - kTarget) / kTarget;
    if (x.kcal > kcalLeft) sc -= (x.kcal - kcalLeft) / 150;
    sc += Math.min(x.protein_g, need.protein || 20) / Math.max(need.protein || 20, 10) * 2;
    sc -= Math.max(0, x.sat_fat_g - Math.max(need.sat, 2)) / 2;
    if (need.veg > 0) sc += Math.min(x.veg || 0, 2) * 0.15;
    if (need.fibre > 5) sc += Math.min(x.fibre_g || 0, 8) * 0.02;
    return sc;
  };
  const picks = pool.map((x) => ({ x, s: score(x) })).sort((a, b) => b.s - a.s).slice(0, 3).map((p) => p.x);
  return { slot, need, kcalLeft, over: kcalLeft < 0, picks };
}
