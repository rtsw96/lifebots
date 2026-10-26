// Health app (Telegram Mini App for the health bot). Four tabs:
//   Today     the pet, water, food against the plan, next-meal ideas, checklist ticks, body, measurements, today's training
//   Train     today's suggested workout, live logging with a rest timer, recovery, history
//   Food      averages, macro split, sat fat sources, log/edit meals, day history
//   Progress  body weight, food, weekly sets per muscle, strength per lift
// The bot's snapshot is the record; workouts, weigh-ins, meal changes and checklist
// ticks made here are queued for the bot, which writes them into the repo and
// replies in Telegram.
// All text from the snapshot goes in through textContent (h() below), never as HTML.

import * as E from "./engine.js";
import { drawPet, SPECIES, moodBand, MOOD_WORDS, speech, ACCESSORIES, poke, liven, sip } from "./pet.js";

// Telegram's script comes from telegram.org; offline it may not load, so fall
// back to the sign-in data Telegram puts in the page's own address.
const tg = (window.Telegram && window.Telegram.WebApp) || (() => {
  const raw = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
  return raw ? { initData: raw, ready() {}, expand() {}, onEvent() {} } : null;
})();
const $ = (id) => document.getElementById(id);
const S = {
  snap: null, draft: null, queue: [], lib: null, EX: {},
  tab: "today", planType: null, swaps: {}, planEdits: [], range: 84, strengthEx: null, tables: {},
};
const LS_DRAFT = "health.draft";
const LS_REST = "health.rest";

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // the CSSOM: the CSP blocks style="" attributes
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) { if (k === "style") el.style.cssText = v; else el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// One icon set, drawn: 24-unit grid, 2px round strokes.
const ICONS = {
  pulse: "M3 12h4l2.5-6 4 12 2.5-6H21",
  today: "M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V8A1.5 1.5 0 0 1 5 6.5zM3.5 11h17M8 4v4M16 4v4",
  train: "M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11",
  progress: "M4 4.5v15h16M7.5 15l3.5-4.5 3 2.5 5-6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  swap: "M7 8h12l-3.5-3.5M17 16H5l3.5 3.5",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 11v5.5M12 7.6v.4",
  remove: "M5 7.5h14M10 7.5V5h4v2.5M7 7.5l.9 11.5h8.2l.9-11.5",
  up: "M12 19V6M6.5 11.5L12 6l5.5 5.5",
  skip: "M6 6.5l8 5.5-8 5.5zM18 6v12",
  timer: "M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM12 9.5v4l2.5 1.8M9.5 3h5",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2",
  ruler: "M4.5 15.5l11-11 4 4-11 11zM8 12l1.8 1.8M11 9l1.8 1.8M14 6l1.8 1.8",
  layers: "M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5",
  list: "M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01",
  flame: "M12 21c3.6 0 6-2.5 6-6 0-4-3.5-6-4-10-2.5 1.8-4.2 4.4-4.2 7-1-.7-1.6-1.8-1.8-3C6.6 10.6 6 12.6 6 15c0 3.5 2.4 6 6 6z",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z",
  food: "M6 3v7.5a2.5 2.5 0 0 0 5 0V3M8.5 3v18M17.5 21V3c-2.2 1.3-3.5 4.2-3.5 8.5 0 1 .6 1.8 1.6 1.8h1.9",
  heart: "M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z",
  down: "M12 5v13M6.5 12.5L12 18l5.5-5.5",
  grip: "M7 8h10M7 12h10M7 16h10",
  move: "M12 4v16M4 12h16M12 4l-2.5 2.5M12 4l2.5 2.5M12 20l-2.5-2.5M12 20l2.5-2.5M4 12l2.5-2.5M4 12l2.5 2.5M20 12l-2.5-2.5M20 12l-2.5 2.5",
};
function icon(name, cls = "icon") {
  return s("svg", { class: cls, viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: ICONS[name] }));
}

const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? "–" : Number(x).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const nowMs = () => Date.now();
// Dates and times are the owner's local ones (the snapshot's tz, from settings.json; engine.js).
// A date on its own (YYYY-MM-DD) is shown from noon UTC with timeZone "UTC", so it never shifts.
const locDate = (ms = nowMs()) => E.localDate(ms);
const locTime = (ms = nowMs()) => E.localTime(ms);
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const stamp = (iso, opts) => new Date(iso).toLocaleString("en-GB", { timeZone: E.tz(), ...opts });
const muscleName = (m) => m.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
function haptic(kind) {
  try {
    if (kind === "tick") tg.HapticFeedback.impactOccurred("medium");
    else if (kind === "soft") tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.notificationOccurred(kind);
  } catch { /* outside Telegram */ }
}

// Offline: changes made without signal wait on the phone (the outbox) and go
// out when the connection is back; the last data seen is kept to show offline.
const LS_OUTBOX = "health.outbox";
const LS_CACHE = "health.cache";
const QUEUEABLE = new Set(["/api/finish", "/api/body", "/api/do"]);
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } };

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, initData: tg ? tg.initData : "" }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { res, data };
}

function localWorkout(w) {
  return { date: w.date, time: w.time, blocks: w.blocks.map((b) => ({ block: b.block, items: b.items.map((it) => ({
    ex: it.ex, sets: it.sets.filter((x) => x.done).map((x) => ({ weight_kg: x.kg ?? undefined, reps: x.reps ?? undefined, seconds: x.sec ?? undefined })),
  })) })) };
}

function localItem(path, body) {
  const id = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (path === "/api/finish") return { id, local: true, kind: "workout", data: localWorkout(body.workout) };
  if (path === "/api/body") return { id, local: true, kind: "body", data: { date: body.date, time: body.time, kg: body.kg, waist: body.waist } };
  return { id, local: true, kind: body.kind, data: body.data };
}

async function api(path, body = {}) {
  let r;
  try {
    r = await post(path, body);
  } catch {
    if (!QUEUEABLE.has(path)) throw new Error("You're offline.");
    const item = localItem(path, body);
    lsSet(LS_OUTBOX, [...lsGet(LS_OUTBOX, []), { path, body, item }]);
    return { ok: true, item, offline: true };
  }
  if (r.res.status === 401 && QUEUEABLE.has(path)) {
    // The Telegram sign-in is over an hour old (a long workout): keep the entry on the
    // phone; it goes out from the outbox the next time the app is opened.
    const item = localItem(path, body);
    lsSet(LS_OUTBOX, [...lsGet(LS_OUTBOX, []), { path, body, item }]);
    return { ok: true, item, offline: true };
  }
  if (!r.res.ok || !r.data.ok) throw new Error(r.data.error || `Request failed (${r.res.status})`);
  return r.data;
}

/** Send what waited on the phone, oldest first. A refused item (bad data) is
 *  dropped so it can't block the rest; any other failure keeps it for next time. */
let flushing = null;
function flushOutbox() {
  if (!flushing) flushing = sendOutbox().finally(() => { flushing = null; });
  return flushing;
}

async function sendOutbox() {
  const box = lsGet(LS_OUTBOX, []);
  if (!box.length) return 0;
  const gone = new Set();
  let sent = 0;
  for (const x of box) {
    try {
      const r = await post(x.path, x.body);
      if (r.res.ok && r.data.ok) {
        sent++;
        gone.add(x.item.id);
        S.queue = S.queue.filter((q) => q.id !== x.item.id).concat(r.data.item ? [r.data.item] : []);
      } else if (r.res.status === 400) {
        gone.add(x.item.id);
        S.queue = S.queue.filter((q) => q.id !== x.item.id);
      } else break; // sign-in or server trouble: try again later, in order
    } catch {
      break;
    }
  }
  // Re-read: something may have been added while this was sending.
  lsSet(LS_OUTBOX, lsGet(LS_OUTBOX, []).filter((x) => !gone.has(x.item.id)));
  return sent;
}

// ------------------------------------------------------------------ data
/** Logged sets plus workouts still waiting for the bot (shown at once). */
function allSets() {
  const sets = (S.snap && S.snap.sets) || [];
  const have = new Set(sets.map((x) => x.wid));
  const extra = [];
  for (const it of S.queue) {
    if (it.kind !== "workout") continue;
    const d = it.data;
    const wid = `${d.date}T${d.time.replace(":", "")}`;
    if (have.has(wid)) continue;
    for (const b of d.blocks) for (const e of b.items) for (const st of e.sets) {
      extra.push({ wid, date: d.date, time: d.time, block: b.block, ex: e.ex, kg: st.weight_kg, reps: st.reps, sec: st.seconds, pending: true });
    }
  }
  return sets.concat(extra);
}

function allBody() {
  const body = ((S.snap && S.snap.body) || []).slice();
  for (const it of S.queue) {
    if (it.kind !== "body") continue;
    const i = body.findIndex((b) => b.date === it.data.date);
    const row = { date: it.data.date, kg: it.data.kg, waist: it.data.waist, pending: true };
    if (i >= 0) body[i] = row; else body.push(row);
  }
  return body.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Meals and day totals, with meal changes still waiting for the bot applied. */
function foodData() {
  const base = (S.snap && S.snap.food) || { days: [], meals: [] };
  let meals = (base.meals || []).map((m) => ({ ...m }));
  let touched = false;
  for (const it of S.queue) {
    if (it.kind === "meal_add") {
      meals.push({ ...it.data, id: `q:${it.id}`, pending: true, meal: it.data.meal || "meal" });
      touched = true;
    } else if (it.kind === "meal_edit") {
      const m = meals.find((x) => String(x.id) === String(it.data.id));
      if (m) { Object.assign(m, it.data, { id: m.id, pending: true }); touched = true; }
    } else if (it.kind === "meal_delete") {
      meals = meals.filter((x) => String(x.id) !== String(it.data.id));
      touched = true;
    }
  }
  if (!touched) return { days: base.days || [], meals };
  const byDay = new Map((base.days || []).map((d) => [d.date, { date: d.date }]));
  const keys = [["kcal", "kcal"], ["protein_g", "protein_g"], ["carbs_g", "carbs_g"], ["fat_g", "fat_g"], ["sat_fat_g", "sat_fat_g"],
    ["fibre_g", "fibre_g"], ["veg_servings", "veg"], ["fruit_servings", "fruit"]];
  for (const m of meals) {
    const d = byDay.get(m.date) || { date: m.date };
    for (const [dk, mk] of keys) d[dk] = (d[dk] || 0) + (Number(m[mk]) || 0);
    d.meals = (d.meals || 0) + 1;
    byDay.set(m.date, d);
  }
  return { days: [...byDay.values()].filter((d) => d.meals).sort((a, b) => (a.date < b.date ? -1 : 1)), meals };
}

/** The health plan, with ticks still waiting for the bot applied. */
function planData() {
  const p = S.snap && S.snap.plan;
  if (!p) return null;
  const tasks = p.tasks.map((t) => ({ ...t }));
  let log = (p.log || []).slice();
  for (const it of S.queue) {
    if (it.kind === "plan_task") {
      const t = tasks.find((x) => x.id === it.data.id);
      if (t) t.done = it.data.done ? it.data.date || locDate() : null;
    } else if (it.kind === "habit") {
      log = log.filter((r) => !(r.date === it.data.date && r.habit === it.data.habit));
      if (it.data.done) log.push({ date: it.data.date, habit: it.data.habit });
    }
  }
  const done = (id) => Boolean((tasks.find((t) => t.id === id) || {}).done);
  const habitActive = (hb) => {
    const [mode, id] = String(hb.active || "").split(":");
    if (mode === "until") return !done(id);
    if (mode === "after") return done(id);
    return true;
  };
  return { tasks, habits: p.habits.filter(habitActive), allHabits: p.habits, log, done };
}

/** Water: the snapshot's days and today's drinks, with taps still waiting for the bot applied. */
function waterData() {
  const w = (S.snap && S.snap.water) || { goal_ml: 2000, start_min: 480, end_min: 1260, slack_ml: 400, days: [], today: [] };
  const today = locDate();
  let drinks = (S.snap && S.snap.today === today ? w.today || [] : []).map((x) => ({ ...x }));
  for (const it of S.queue) {
    if (it.kind === "water" && it.data.date === today && !drinks.some((x) => x.id === it.id)) drinks.push({ id: it.id, time: it.data.time, ml: it.data.ml, pending: true });
    else if (it.kind === "water_delete") drinks = drinks.filter((x) => x.id !== it.data.id);
  }
  drinks.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const days = (w.days || []).filter((d) => d.date !== today).concat(drinks.length ? [{ date: today, ml: drinks.reduce((a, x) => a + x.ml, 0) }] : []);
  return { ...w, today, drinks, days, ml: drinks.reduce((a, x) => a + x.ml, 0) };
}

const locMins = (ms = nowMs()) => { const [hh, mm] = locTime(ms).split(":").map(Number); return hh * 60 + mm; };
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const litres = (ml) => `${Math.round(ml / 10) / 100} L`;
/** Where today's water should be by now: nothing at 08:00, the whole goal at the evening debrief. */
function waterExpected(wd, mins = locMins()) {
  return Math.round(wd.goal_ml * Math.min(1, Math.max(0, (mins - wd.start_min) / (wd.end_min - wd.start_min))));
}
/** 0 to 1: today's water against that, with a little slack (waterlog.py has the same sum). */
function waterPace(wd, mins = locMins()) {
  return Math.round(Math.min(1, (wd.ml + wd.slack_ml) / (waterExpected(wd, mins) + wd.slack_ml)) * 100) / 100;
}

function exImg(ex) {
  const item = S.EX[ex];
  if (item && item.images && item.images[0]) return h("img", { class: "thumb", src: item.images[0], alt: "", loading: "lazy", width: 56, height: 56 });
  return h("span", { class: "thumb-none" }, icon("train"));
}

function setLabel(ex, st) {
  const e = S.EX[ex];
  if (!e) return "";
  if (e.kind === "weight") return st.kg != null ? `${fmt(st.reps)} × ${fmt(st.kg, 1)}` : `${fmt(st.reps)} reps`;
  if (e.kind === "time") return `${fmt(st.sec)}s`;
  return `${fmt(st.reps)}`;
}

function setTarget(ex, st) {
  const e = S.EX[ex];
  if (e.kind === "weight") return st.kg != null ? `${fmt(st.kg, 1)} kg × ${fmt(st.reps)}` : `${fmt(st.reps)} reps`;
  if (e.kind === "time") return `${fmt(st.sec)} s${e.sides === 2 ? " each side" : ""}`;
  return `${fmt(st.reps)} reps`;
}

// ------------------------------------------------------------------ shell
const short = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const addDays = E.addDays;
function weekStart(ms = nowMs()) {
  const today = locDate(ms);
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(today, -dow);
}

function setTitle(main, aside) {
  $("title").textContent = aside ? `${main} · ${aside}` : main;
}

function setTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    b.tabIndex = b.dataset.tab === tab ? 0 : -1;
  }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const v = $("view");
  v.replaceChildren();
  if (S.tab === "today") setTitle("Today", short(locDate()));
  else if (S.tab === "train") {
    const ws = weekStart();
    setTitle(S.draft ? "Workout" : "Train", S.draft ? null : `${short(ws).replace(/ \w+$/, "")}–${short(addDays(ws, 6))}`);
  } else if (S.tab === "food") setTitle("Food", ({ 7: "7 days", 28: "4 weeks", 84: "12 weeks" })[S.foodRange || 28]);
  else setTitle("Progress", null);
  if (!S.snap) {
    v.append(h("p", { class: "status" }, "No data yet. The health bot sends it after its next log."));
  } else {
    ({ today: viewToday, train: viewTrain, food: viewFood, progress: viewProgress })[S.tab](v);
  }
  const n = S.queue.length;
  const onPhone = lsGet(LS_OUTBOX, []).length;
  $("pending").hidden = !n && !S.offlineAt;
  $("pending").textContent = S.offlineAt
    ? `offline${onPhone ? ` · ${onPhone} to send` : ""}`
    : `${n} for the bot${onPhone ? ` · ${onPhone} to send` : ""}`;
  if (S.snap) $("asof").textContent = `${S.offlineAt ? "Offline. " : ""}Data as of ${stamp(S.snap.generated_at, { dateStyle: "medium", timeStyle: "short" })}.`;
  renderFab();
  renderDock();
}

function renderFab() {
  const fab = $("fab");
  const live = S.draft && S.tab === "train";
  fab.hidden = !S.snap || live;
  fab.replaceChildren(S.draft ? "Resume" : "Start", icon(S.draft ? "train" : "plus"));
  fab.onclick = () => {
    if (!S.draft) startWorkout(currentPlan());
    setTab("train");
  };
}

function section(title, right, ...kids) {
  return h("section", { class: "sec" }, h("header", null, typeof title === "string" ? h("h2", null, title) : title, right || null), ...kids);
}

// ------------------------------------------------------------------ today
const k = (x) => (x >= 1000 ? `${fmt(x / 1000, 1)}k` : fmt(x));

function stateWord(st, unit) {
  if (st.state === "in") return h("span", { class: "state in" }, "on target");
  if (st.state === "over") return h("span", { class: "state over" }, `+${fmt(st.value - st.hi)} over`);
  return h("span", { class: "state under" }, `${fmt(st.lo - st.value)}${unit} to go`);
}

function track(st, big) {
  const max = Math.max(st.hi || st.lo || 1, st.value) * 1.12;
  const pct = (x) => `${Math.min(100, (x / max) * 100)}%`;
  const ticks = [st.lo, st.hi].filter((x) => x != null && x > 0);
  return h("div", { class: "track", role: "img", "aria-label": `${fmt(st.value)} of ${st.hi == null ? `${fmt(st.lo)}+` : `${fmt(st.lo)}–${fmt(st.hi)}`}` },
    h("span", { class: "fill", style: `width:${pct(st.value)}` }),
    ticks.map((x) => h("span", { class: "tk", style: `left:calc(${pct(x)} - 1px)` })), big ? null : null);
}

function bigMeter(label, unit, st, rangeText) {
  if (!st) return null;
  return h("div", { class: "meter" },
    h("span", { class: "caps" }, label),
    h("span", { class: "val" }, fmt(st.value), h("small", null, unit)),
    track(st, true),
    h("div", { class: "foot" }, h("span", { class: "range" }, rangeText), stateWord(st, unit === "kcal" ? "" : unit === "g" ? "g" : "")));
}

function smallMeter(label, unit, st) {
  if (!st) return null;
  const target = st.hi == null ? `${fmt(st.lo)}+` : label === "Sat fat" ? `<${fmt(st.hi)}` : `${fmt(st.lo)}–${fmt(st.hi)}`;
  return h("div", { class: "mrow" },
    h("span", { class: "caps" }, label), track(st),
    h("span", { class: "v" }, h("b", null, fmt(st.value)), ` / ${target}${unit}`));
}

function viewToday(v) {
  const snap = S.snap;
  const today = locDate();
  const fd = foodData();
  const day = fd.days.find((d) => d.date === today);
  const st = E.foodStatus(day, snap.targets);
  const meals = fd.meals.filter((m) => m.date === today).sort((a, b) => (a.time < b.time ? -1 : 1));
  const left = st.kcal ? Math.max(0, st.kcal.lo - st.kcal.value) : 0;
  const pet = petSection();
  if (pet) v.append(pet);
  v.append(waterSection());
  v.append(section(h("div", null, h("h2", null, "Food"), h("p", { class: "sub" }, day ? `${day.meals} logged · ${fmt(left)} kcal to the plan` : "Nothing logged yet")), null,
    h("div", { class: "meters" },
      bigMeter("Calories", "kcal", st.kcal, `${k(st.kcal.lo)}–${k(st.kcal.hi)}`),
      bigMeter("Protein", "g", st.protein_g, `${fmt(st.protein_g.lo)}–${fmt(st.protein_g.hi)}`),
      bigMeter("Veg", "serv", st.veg_servings, `${fmt(st.veg_servings.lo)}–${fmt(st.veg_servings.hi)}`)),
    h("div", { class: "mrows" },
      smallMeter("Carbs", "g", st.carbs_g), smallMeter("Fat", "g", st.fat_g),
      smallMeter("Sat fat", "g", st.sat_fat_g), smallMeter("Fibre", "g", st.fibre_g)),
    meals.length ? h("div", { class: "list" }, meals.map(mealRow)) : null));
  v.append(nextMealSection(day), planSection(), bodyNowSection(), measureSection(), todayWorkoutSection());
}

function mealRow(m, opts = {}) {
  return h("button", { class: "entry mealbtn", type: "button", onclick: () => mealSheet(m) },
    h("span", { class: "when" }, opts.dated ? short(m.date) : m.time),
    h("div", { class: "body" }, h("span", { class: "src" }, String(m.meal || "").replace(/^./, (c) => c.toUpperCase()), m.pending ? h("span", { class: "tag" }, "  waiting for bot") : null),
      h("span", { class: "note" }, m.desc)),
    opts.sat ? h("span", { class: "side" }, h("b", { class: "hi" }, `${fmt(m.sat_fat_g, 1)} g`), h("br"), "sat fat")
      : h("span", { class: "side" }, `${fmt(m.kcal)} kcal`, h("br"), `${fmt(m.protein_g)} g P`));
}

// ------------------------------------------------------------------ the pet
// A little creature that lives on the week's targets (weekly.py: needs, mood, wish,
// stars and level arrive in the snapshot). You pick the species and name.
const NEED_LABELS = { water: "Water", food: "Food", rest: "Rest", fitness: "Fitness" };

/** The week from the snapshot, with water scored live so the pet answers each drink at
 *  once: its mood is half water, half the average of food, rest and fitness (weekly.py). */
function liveWeekly() {
  const w = S.snap && S.snap.weekly;
  if (!w) return null;
  const wd = waterData();
  const water = waterPace(wd);
  const others = ["food", "rest", "fitness"].map((key) => w.needs[key]).filter((x) => x != null);
  const other = others.length ? others.reduce((a, x) => a + x, 0) / others.length : 0.7;
  const weight = w.water_weight ?? 0.5;
  const behind = waterExpected(wd) - wd.ml;
  const tip = water < 0.75 && behind > 0 ? `I'm thirsty! About ${fmt(behind)} ml to catch up.` : w.tip && /thirsty/.test(w.tip) ? null : w.tip;
  return { ...w, needs: { ...w.needs, water }, mood: Math.round((weight * water + (1 - weight) * other) * 100), tip, thirsty: water < 0.6 };
}
const STATE_MARK = { hit: "✓", pace: "·", behind: "!", out: "×", nodata: "–" };

function petInfo() {
  const sp = (S.pet && SPECIES[S.pet.species]) ? S.pet.species : "owl";
  return { sp, name: (S.pet && S.pet.name) || SPECIES[sp].pet };
}

function needBar(key, v) {
  const pct = v == null ? null : Math.round(v * 100);
  return h("div", { class: "need" },
    h("span", { class: "caps" }, NEED_LABELS[key]),
    h("div", { class: "track", role: "img", "aria-label": `${NEED_LABELS[key]} ${pct == null ? "no data yet" : `${pct}%`}` },
      pct == null ? null : h("span", { class: `fill ${pct >= 75 ? "ok" : pct >= 45 ? "mid" : "low"}`, style: `width:${pct}%` })),
    h("span", { class: "m" }, pct == null ? "–" : `${pct}%`));
}

function petSection() {
  const w = liveWeekly();
  if (!w) return null;
  const { sp, name } = petInfo();
  const band = moodBand(w.mood);
  const toNext = w.next_level_at - w.stars;
  const bubble = h("p", { class: "bubble", "aria-live": "polite" }, speech(name, w.mood, w.tip));
  const art = drawPet(sp, { mood: w.mood, level: w.level, size: 132, thirsty: w.thirsty });
  liven(art); // a trick now and then, on its own
  const card = h("div", { class: "pet-card" },
    h("button", { class: "pet-tap pet-art", type: "button", "aria-label": `Pat ${name}`, onclick: () => petTap(art, sp, bubble, speech(name, w.mood, w.tip)) }, art),
    h("button", { class: "pet-info", type: "button", onclick: petSheet, "aria-label": `${name} the ${SPECIES[sp].name.toLowerCase()}: ${MOOD_WORDS[band]}. See the week` },
      h("div", { class: "pet-name" }, h("b", null, name), h("span", { class: `mood ${band}` }, MOOD_WORDS[band])),
      bubble,
      h("div", { class: "needs" }, Object.keys(NEED_LABELS).map((key) => needBar(key, w.needs[key]))),
      h("p", { class: "pet-meta" }, `Level ${w.level} · ${w.stars} ★ · ${toNext} to level ${w.level + 1}`,
        w.streak > 1 ? h("span", null, ` · ${w.streak}-day logging streak`) : null)));
  return h("section", { class: "sec pet-sec" }, card);
}

let petSaid = null;
/** A pat: the pet boings, puffs hearts and says something; its usual line comes back after a moment. */
function petTap(svg, sp, bubble, usual) {
  const line = poke(svg, sp);
  haptic("soft");
  if (!bubble || !line) return;
  bubble.textContent = line;
  bubble.classList.add("said");
  clearTimeout(petSaid);
  petSaid = setTimeout(() => { bubble.textContent = usual; bubble.classList.remove("said"); }, 2400);
}

function petSheet() {
  const w = liveWeekly();
  const { sp, name } = petInfo();
  const input = h("input", { class: "field", type: "text", maxlength: "20", value: name, "aria-label": "Pet's name", autocomplete: "off" });
  // A custom name follows you to a new species; the default name doesn't.
  const save = async (species) => {
    const nm = input.value.trim();
    S.pet = { species, name: nm && nm !== SPECIES[sp].pet ? nm : null };
    render();
    petSheet();
    try { await api("/api/pet", { pet: S.pet }); } catch { /* kept on screen; tries again with the next change */ }
  };
  const unlocked = ACCESSORIES.filter((a) => w.level >= a.level).map((a) => a.name);
  const next = ACCESSORIES.find((a) => w.level < a.level);
  openSheet(
    h("h2", null, `${name}'s week`),
    (() => {
      const art = drawPet(sp, { mood: w.mood, level: w.level, size: 180, thirsty: w.thirsty });
      liven(art);
      const said = h("p", { class: "note", "aria-live": "polite" }, speech(name, w.mood, w.tip));
      return [h("div", { class: "pet-hero" }, h("button", { class: "pet-tap", type: "button", "aria-label": `Pat ${name}`,
        onclick: () => { const l = poke(art, sp); haptic("soft"); if (l) { said.textContent = l; setTimeout(() => { said.textContent = speech(name, w.mood, w.tip); }, 2400); } } }, art)), said];
    })(),
    h("ul", { class: "pet-targets" }, w.targets.map((t) => h("li", { class: t.state },
      h("span", { class: "mark" }, STATE_MARK[t.state] || "·"),
      h("span", null, t.label),
      h("span", { class: "m" }, t.kind === "avg" ? (t.avg == null ? "no data" : `${t.key === "steps" ? k(t.avg) : fmt(t.avg, 1)} / ${t.key === "steps" ? k(t.target) : t.target}`) : `${t.done} / ${t.target}`)))),
    h("p", { class: "tiny" }, `Hit ${w.hit_this_week} of ${w.targets.length} so far this week. Each target hit by Sunday is a star; every 6 stars is a level.`
      + (unlocked.length ? ` Unlocked: ${unlocked.join(", ")}.` : "") + (next ? ` Level ${next.level} brings ${next.name}.` : "")),
    h("h3", null, "Choose a pet"),
    h("div", { class: "pet-pick" }, Object.keys(SPECIES).map((id) => h("button", {
      type: "button", class: "pick-pet", "aria-pressed": String(id === sp), onclick: () => save(id) },
      drawPet(id, { mood: 80, level: 1, size: 64, still: true }), h("span", null, SPECIES[id].name)))),
    h("label", { class: "pet-rename" }, h("span", { class: "caps" }, "Name"), input,
      h("button", { class: "pillbtn", type: "button", onclick: () => save(sp) }, "Save")),
    h("p", { class: "tiny" }, `Half its mood is water: what you've drunk today against where the day should be by now (${litres(waterData().goal_ml)} by ${hhmm(waterData().end_min)}). The other half is the week so far: Food is protein, calories, veg and sat fat; Rest is sleep; Fitness is training, the run and steps, each against where the week should be by now, so a fresh Monday starts happy.`));
}

// ------------------------------------------------------------------ water
function waterSection() {
  const wd = waterData();
  const exp = waterExpected(wd);
  const pct = (x) => `${Math.min(100, (x / wd.goal_ml) * 100)}%`;
  const left = wd.goal_ml - wd.ml;
  const by = hhmm(wd.end_min);
  const sub = wd.ml >= wd.goal_ml ? "Goal reached. Nice one."
    : wd.ml >= exp ? `On pace · ${litres(left)} to go by ${by}`
      : `${fmt(exp - wd.ml)} ml behind the pace · ${litres(left)} to go by ${by}`;
  const last = wd.drinks[wd.drinks.length - 1];
  return section(h("div", null, h("h2", null, "Water"), h("p", { class: "sub" }, sub)), null,
    h("div", { class: "water-now" }, h("b", null, litres(wd.ml)), h("span", null, ` of ${litres(wd.goal_ml)}`)),
    h("div", { class: "water-track", role: "img", "aria-label": `${Math.round((wd.ml / wd.goal_ml) * 100)}% of today's water; the mark is where the pace is now` },
      h("span", { class: "fill", style: `width:${pct(wd.ml)}` }),
      exp > 0 && exp < wd.goal_ml ? h("span", { class: "pace", style: `left:calc(${pct(exp)} - 1px)` }) : null),
    h("div", { class: "water-btns" }, [[250, "Glass"], [500, "Bottle"], [750, "Big bottle"]].map(([ml, name]) =>
      h("button", { class: "water-add", type: "button", "aria-label": `Add a ${name.toLowerCase()}, ${ml} ml`, onclick: () => addWater(ml) },
        icon("plus", "icon s"), h("b", null, name), h("span", null, `${ml} ml`)))),
    wd.drinks.length ? h("div", { class: "water-log" },
      h("span", { class: "tiny" }, `${wd.drinks.length} drink${wd.drinks.length === 1 ? "" : "s"} · last ${fmt(last.ml)} ml at ${last.time}`),
      h("button", { class: "textbtn", type: "button", onclick: () => undoWater(last) }, "Undo last")) : null);
}

async function addWater(ml) {
  try {
    const r = await api("/api/do", { kind: "water", data: { date: locDate(), time: locTime(), ml } });
    S.queue.push(r.item);
    haptic("success");
    render();
    // the pet drinks it: a jump, a puff of droplets and thanks, then its usual line
    const art = document.querySelector(".pet-sec .pet-art svg");
    const bubble = document.querySelector(".pet-sec .bubble");
    const line = sip(art);
    if (bubble && line) {
      const w = liveWeekly();
      bubble.textContent = line;
      bubble.classList.add("said");
      clearTimeout(petSaid);
      petSaid = setTimeout(() => { bubble.textContent = speech(petInfo().name, w.mood, w.tip); bubble.classList.remove("said"); }, 2600);
    }
  } catch (e) {
    openSheet(h("h2", { id: "sheet-title" }, "Not saved"), h("p", null, e.message));
  }
}

function undoWater(d) {
  if (d) sendAction("water_delete", { id: d.id });
}

function waterHistorySection(from) {
  const wd = waterData();
  const pts = wd.days.filter((d) => d.date >= from);
  if (!pts.length) return null;
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const hit = pts.filter((d) => d.ml >= wd.goal_ml).length;
  const avg = pts.reduce((a, d) => a + d.ml, 0) / pts.length;
  return section(h("div", null, h("h2", null, "Water"), h("p", { class: "sub" }, `Average ${litres(avg)} a day · goal hit on ${hit} of ${pts.length} days`)), null,
    chart("Water, litres a day", pts.map((d) => ({ x: ms(d.date), y: d.ml / 1000, label: `${short(d.date)}: ${litres(d.ml)}` })), {
      kind: "bar", band: [wd.goal_ml / 1000, (wd.goal_ml + 1000) / 1000], zero: true, unit: "L", yfmt: (x) => fmt(x, 1),
    }),
    h("p", { class: "tiny" }, `Band: ${litres(wd.goal_ml)} or more. Days with nothing logged are left out.`));
}

// ------------------------------------------------------------------ next meal
const SLOT_NAMES = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

function nextMealSection(day) {
  const items = S.snap.suggest || [];
  if (!items.length) return null;
  const t = S.snap.targets;
  const hourNow = locMins() / 60;
  const r = E.pickNext(day, t, items, hourNow);
  let aim;
  if (r.over) aim = "You're past the plan's calories today. If you're hungry, keep it to protein.";
  else if (r.slot === "snack") aim = `Snack: up to ~${fmt(Math.max(120, Math.min(250, r.kcalLeft)))} kcal, protein first.`;
  else aim = `${SLOT_NAMES[r.slot]}: aim ~${fmt(Math.round(r.need.kcal / 10) * 10)} kcal, ${fmt(r.need.protein)} g protein, sat fat under ${fmt(Math.max(r.need.sat, 0), 1)} g${r.need.veg > 0 ? `, ${fmt(Math.min(r.need.veg, 2), 1)} veg` : ""}.`;
  return section(h("div", null, h("h2", null, "Next meal"), h("p", { class: "sub" }, aim)), null,
    h("div", { class: "list" }, r.picks.map((x) => h("button", { class: "entry wide mealbtn", type: "button", onclick: () => suggestionSheet(x) },
      h("span", { class: "when" }, icon("food")),
      h("div", { class: "body" },
        h("span", { class: "src" }, x.where),
        h("span", { class: "note", style: "color:var(--ink);font-weight:500" }, x.name),
        h("div", { class: "meta" }, h("span", null, `${fmt(x.kcal)} kcal`), h("span", null, `${fmt(x.protein_g)}P`),
          h("span", null, `${fmt(x.sat_fat_g, 1)} sat`), x.veg ? h("span", null, `${fmt(x.veg, 1)} veg`) : null))))),
    h("p", { class: "tiny" }, "Rough values for a typical serving. Tap one to log it as eaten, then adjust."));
}

function suggestionSheet(x) {
  openSheet(h("h2", { id: "sheet-title" }, x.name), macroTable(x),
    h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: () => logMeal({ ...x, desc: x.name }) }, "Log it now"),
      h("button", { class: "btn quiet", type: "button", onclick: () => editMealSheet({ ...x, desc: x.name }, true) }, "Adjust, then log")),
    h("p", { class: "tiny" }, "Estimates for a typical serving; the health bot's photo estimates are usually closer."));
}

function macroTable(m) {
  const rows = [["Calories", m.kcal, "kcal"], ["Protein", m.protein_g, "g"], ["Carbs", m.carbs_g, "g"], ["Fat", m.fat_g, "g"],
    ["Sat fat", m.sat_fat_g, "g"], ["Fibre", m.fibre_g, "g"], ["Veg", m.veg, "servings"]];
  return h("table", { class: "data" }, rows.filter((r) => r[1] != null).map(([l, v, u]) => h("tr", null, h("td", null, l), h("td", { class: "r" }, `${fmt(v, 1)} ${u}`))));
}

async function sendAction(kind, data, done) {
  try {
    const r = await api("/api/do", { kind, data });
    S.queue.push(r.item);
    haptic("success");
    closeSheet();
    render();
    if (done) done(r);
  } catch (e) {
    openSheet(h("h2", { id: "sheet-title" }, "Not saved"), h("p", null, e.message));
  }
}

function logMeal(m) {
  const data = { date: locDate(), time: m.at && /^\d{2}:\d{2}$/.test(m.at) ? m.at : locTime(), desc: m.desc, kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
    sat_fat_g: m.sat_fat_g, fibre_g: m.fibre_g, veg: m.veg, fruit: m.fruit };
  sendAction("meal_add", data);
}

function mealSheet(m) {
  const real = !String(m.id || "").startsWith("q:");
  openSheet(h("h2", { id: "sheet-title", class: m.desc.length > 60 ? "long" : null }, m.desc),
    h("p", { class: "tiny m" }, `${short(m.date)} · ${m.time} · ${m.meal || ""}${m.confidence ? ` · ${m.confidence} confidence` : ""}${m.pending ? " · waiting for the bot" : ""}`),
    macroTable(m),
    h("div", { class: "btns" },
      h("button", { class: "btn", type: "button", onclick: () => logMeal(m) }, "Log again now"),
      real ? h("button", { class: "btn quiet", type: "button", onclick: () => editMealSheet(m, false) }, "Edit") : null,
      real ? h("button", { class: "btn danger", type: "button", onclick: async () => {
        if (await confirmBox(`Delete "${m.desc.slice(0, 60)}"?`)) sendAction("meal_delete", { id: m.id });
      } }, "Delete") : null),
    real ? null : h("p", { class: "tiny" }, "Edit or delete it once the bot has logged it."));
}

function editMealSheet(m, asNew) {
  const fields = [["desc", "What", "text"], ["kcal", "Calories", "number"], ["protein_g", "Protein (g)", "number"], ["carbs_g", "Carbs (g)", "number"],
    ["fat_g", "Fat (g)", "number"], ["sat_fat_g", "Sat fat (g)", "number"], ["fibre_g", "Fibre (g)", "number"], ["veg", "Veg (servings)", "number"]];
  const inputs = {};
  const form = h("div", { class: "form" }, fields.map(([key, label, type]) => {
    inputs[key] = h("input", { type, inputmode: type === "number" ? "decimal" : null, value: m[key] ?? "", step: "any", "aria-label": label });
    if (type === "text") { inputs[key].classList.add("field-text"); inputs[key].placeholder = "e.g. Chicken rice, no skin, half rice"; }
    return h("label", null, h("span", { class: "caps" }, label), inputs[key]);
  }));
  const at = asNew ? h("input", { type: "time", value: locTime(), "aria-label": "Time eaten" }) : null;
  if (at) form.prepend(h("label", null, h("span", { class: "caps" }, "Time eaten (today)"), at));
  const save = h("button", { class: "btn", type: "button" }, asNew ? "Log it" : "Save changes");
  const msg = h("p", { class: "tiny overdue", role: "status" });
  save.addEventListener("click", () => {
    const d = {};
    for (const [key, , type] of fields) {
      const raw = inputs[key].value.trim();
      d[key] = type === "number" ? (raw === "" ? null : Number(raw)) : raw;
    }
    const missing = asNew && fields.filter(([key]) => ["desc", "kcal", "protein_g", "carbs_g", "fat_g"].includes(key) && (d[key] == null || d[key] === ""));
    if (missing && missing.length) { msg.textContent = `Fill in ${missing.map((f) => f[1].replace(/ \(g\)/, "").toLowerCase()).join(", ")}.`; return; }
    if (asNew) logMeal({ ...m, ...d, at: at.value });
    else {
      const changes = { id: m.id };
      for (const [key] of fields) if (d[key] !== (m[key] ?? null) && d[key] !== "") changes[key] = d[key];
      sendAction("meal_edit", changes);
    }
  });
  openSheet(h("h2", { id: "sheet-title" }, !asNew ? "Edit meal" : m.desc ? "Adjust, then log" : "Add a meal"), form, msg, h("div", { class: "btns" }, save),
    h("p", { class: "tiny" }, "The health bot updates the log and replies with your new totals."));
}

// ------------------------------------------------------------------ health plan
function planSection() {
  const p = planData();
  if (!p) return null;
  const today = locDate();
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const ticked = (hid, d) => p.log.some((r) => r.habit === hid && r.date === d);
  const habitRows = p.habits.map((hb) => {
    const on = ticked(hb.id, today);
    const n = week.filter((d) => ticked(hb.id, d)).length;
    return h("div", { class: "habit" },
      h("button", { class: "tick", type: "button", "aria-pressed": String(on), "aria-label": `${hb.title} today`,
        onclick: () => sendAction("habit", { habit: hb.id, date: today, done: !on }) }, icon("check")),
      h("div", { class: "hb" }, h("span", { class: "name" }, hb.title), h("span", { class: "tiny" }, hb.when)),
      h("span", { class: "m small" }, `${n}/7`));
  });
  const open = p.tasks.filter((t) => !t.done && (!t.after || p.done(t.after)));
  const next = open.sort((a, b) => (a.due || "9999") < (b.due || "9999") ? -1 : 1).slice(0, 3);
  const doneCount = p.tasks.filter((t) => t.done).length;
  return section(h("div", null, h("h2", null, "Checklist"), h("p", { class: "sub" }, p.tasks.length ? `${doneCount} of ${p.tasks.length} steps done` : "Tick each one when it's done")),
    p.tasks.length ? h("button", { class: "pillbtn", type: "button", onclick: healthPlanSheet }, "All steps") : null,
    habitRows.length ? h("div", { class: "list" }, h("p", { class: "caps" }, "Today"), habitRows) : null,
    next.length ? h("div", { class: "list" }, h("p", { class: "caps" }, "Next steps"), next.map(taskRow)) : p.tasks.length ? h("p", { class: "empty" }, "Every open step is done.") : null,
    h("p", { class: "tiny" }, "Your own list: ask the health bot to add or remove items. Medicines and doses are between you and your doctor."));
}

function taskRow(t) {
  const overdue = t.due && !t.done && t.due < locDate();
  return h("div", { class: "habit" },
    h("button", { class: "tick", type: "button", "aria-pressed": String(Boolean(t.done)), "aria-label": `${t.title} done`,
      onclick: () => sendAction("plan_task", { id: t.id, done: !t.done, date: locDate() }) }, icon("check")),
    h("button", { class: "hb textlike", type: "button", onclick: () => openSheet(h("h2", { id: "sheet-title" }, t.title), h("p", { class: "note" }, t.detail),
      t.due ? h("p", { class: "tiny m" }, `Due ${short(t.due)}`) : null, h("p", { class: "tiny" }, "Your own checklist item. Anything about medicines or a condition goes to your doctor.")) },
      h("span", { class: "name" }, t.title),
      h("span", { class: `tiny${overdue ? " overdue" : ""}` }, t.done ? `done ${short(t.done)}` : t.due ? `${overdue ? "overdue · " : ""}due ${short(t.due)}` : t.group)),
    h("span"));
}

function healthPlanSheet() {
  const p = planData();
  const groups = [...new Set(p.tasks.map((t) => t.group))];
  openSheet(h("h2", { id: "sheet-title" }, "Checklist"),
    h("p", { class: "tiny" }, "Your own list, from what you asked the health bot to add. Anything about medicines or a condition goes to your doctor."),
    groups.map((g) => h("div", { class: "list" }, h("p", { class: "caps" }, g), p.tasks.filter((t) => t.group === g).map(taskRow))),
    p.allHabits.length ? h("div", { class: "list" }, h("p", { class: "caps" }, "Daily"), p.allHabits.map((hb) => h("p", { class: "small" },
      `${hb.title} · ${hb.when || "daily"}${String(hb.active || "").startsWith("after:") ? " · starts after an earlier step" : String(hb.active || "").startsWith("until:") ? " · until an earlier step is done" : ""}`))) : null);
}

// ------------------------------------------------------------------ Oura
async function connectOura() {
  try {
    const r = await api("/api/oura/start");
    if (tg && tg.openLink) tg.openLink(r.url); else window.open(r.url, "_blank", "noopener");
    openSheet(h("h2", { id: "sheet-title" }, "Connect Oura"),
      h("p", null, "Oura's sign-in opened in your browser. Approve the access there, then come back here and pull to refresh."),
      h("p", { class: "tiny" }, "The app keeps daily summaries only: sleep, readiness, HRV, resting heart rate, temperature, SpO2 and steps."));
  } catch (e) {
    openSheet(h("h2", { id: "sheet-title" }, "Oura"), h("p", null, e.message));
  }
}

async function refreshOura() {
  try {
    const r = await api("/api/oura/pull");
    S.oura = r.oura;
    haptic("success");
    render();
  } catch (e) {
    openSheet(h("h2", { id: "sheet-title" }, "Oura"), h("p", null, e.message));
  }
}

function ouraLine() {
  const st = S.ouraState || {};
  if (!st.ready) return h("p", { class: "tiny m" }, "Oura (optional): not set up. Ask Claude to set up Oura for the health bot.");
  if (!st.connected) {
    return h("div", { class: "ouraline" }, h("span", { class: "tiny" }, "Oura isn't connected."),
      h("button", { class: "pillbtn", type: "button", onclick: connectOura }, "Connect Oura"));
  }
  const s2 = st.status || {};
  const when = s2.at ? stamp(s2.at, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }) : "never";
  return h("div", { class: "ouraline" },
    h("span", { class: `tiny${s2.ok === false ? " overdue" : ""}` }, s2.ok === false ? `Oura: ${s2.note} (${when})` : `Oura synced ${when}`),
    s2.ok === false && /connect again/.test(s2.note || "") ? h("button", { class: "pillbtn", type: "button", onclick: connectOura }, "Reconnect")
      : h("button", { class: "textbtn", type: "button", onclick: refreshOura }, "Refresh"));
}

function sleepSection(from) {
  const days = apple().days;
  const pts = Object.keys(days).filter((d) => d >= from && days[d].sleep_h != null).sort();
  if (!pts.length) return null;
  const t = (S.snap.profile && S.snap.profile.daily_targets) || { sleep_h: [7, 9] };
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const avg = pts.reduce((a, d) => a + days[d].sleep_h, 0) / pts.length;
  const ready = pts.map((d) => days[d].readiness).filter((x) => x != null);
  return section(h("div", null, h("h2", null, "Sleep"), h("p", { class: "sub" }, `Average ${fmt(avg, 1)} h${ready.length ? ` · readiness ${fmt(ready.reduce((a, b) => a + b, 0) / ready.length)}` : ""}`)), null,
    chart("Sleep hours", pts.map((d) => ({ x: ms(d), y: days[d].sleep_h,
      label: `${short(d)}: ${fmt(days[d].sleep_h, 1)} h${days[d].bed ? ` (${days[d].bed}–${days[d].wake})` : ""}${days[d].readiness != null ? `, readiness ${days[d].readiness}` : ""}` })), {
      kind: "bar", band: t.sleep_h, zero: true, unit: "h", yfmt: (x) => fmt(x, 1),
    }),
    h("p", { class: "tiny" }, `Band: ${t.sleep_h[0]}–${t.sleep_h[1]} h. Tap a bar for the night.`));
}

// Body today, from Apple Health: last night's sleep, resting heart rate, steps.
function bodyNowSection() {
  const days = apple().days;
  const today = locDate();
  const t = (S.snap.profile && S.snap.profile.daily_targets) || { sleep_h: [7, 9], steps: [8000, 12000] };
  const d = days[today] || {};
  const prevDays = Object.keys(days).filter((x) => x < today && x >= addDays(today, -30));
  const restAvg = (() => { const v = prevDays.map((x) => days[x].resting_hr).filter((x) => x); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();
  const lastRest = [today, ...prevDays.sort().reverse()].map((x) => days[x] && days[x].resting_hr).find((x) => x);
  if (!Object.keys(days).length) {
    const last = (S.appleLog || [])[0];
    const when = last ? stamp(last.at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
    return section("Body", null, h("p", { class: "empty" }, "No Apple Health data yet (optional). To add it, ask Claude to set up Apple Health for the health bot: it sends you the steps for Health Auto Export. Sleep, resting heart rate, steps and Watch workouts then show up here."),
      h("p", { class: "tiny m" }, last ? `Last sync attempt ${when}: ${last.status === 200 ? `arrived, ${last.days || 0} days and ${last.workouts || 0} workouts` : `refused (${last.note})`}` : "No sync attempt has reached the app yet."),
      ouraLine());
  }
  const st = (value, lo, hi) => ({ value, lo, hi, state: value < lo ? "under" : hi != null && value > hi ? "over" : "in" });
  const sleep = d.sleep_h != null ? st(d.sleep_h, t.sleep_h[0], t.sleep_h[1]) : null;
  const steps = st(d.steps || 0, t.steps[0], t.steps[1]);
  const fh = (x) => `${Math.floor(x)}h ${String(Math.round((x % 1) * 60)).padStart(2, "0")}`;
  const sleepM = h("div", { class: "meter" }, h("span", { class: "caps" }, "Sleep"),
    h("span", { class: "val" }, sleep ? fh(sleep.value).split(" ")[0] : "–", sleep ? h("small", null, fh(sleep.value).split(" ")[1] + "m") : null),
    sleep ? track({ ...sleep, value: sleep.value }, true) : h("div", { class: "track" }),
    h("div", { class: "foot" }, h("span", { class: "range" }, `${t.sleep_h[0]}–${t.sleep_h[1]}h`),
      sleep ? h("span", { class: `state ${sleep.state === "in" ? "in" : "under"}` }, d.bed && d.wake ? `${d.bed}–${d.wake}` : sleep.state === "in" ? "on target" : "short") : h("span", { class: "state under" }, "no data")));
  const restM = h("div", { class: "meter" }, h("span", { class: "caps" }, "Resting HR"),
    h("span", { class: "val" }, lastRest ? fmt(lastRest) : "–", h("small", null, "bpm")),
    restAvg && lastRest ? track({ value: lastRest, lo: Math.round(restAvg), hi: null, state: "in" }, true) : h("div", { class: "track" }),
    h("div", { class: "foot" }, h("span", { class: "range" }, restAvg ? `30d ${fmt(restAvg)}` : "30d –"),
      restAvg && lastRest ? h("span", { class: `state ${lastRest > restAvg + 4 ? "over" : "under"}` }, lastRest > restAvg + 4 ? "high: easy day" : `${lastRest - restAvg >= 0 ? "+" : "−"}${fmt(Math.abs(lastRest - restAvg))} vs avg`) : null));
  const stepsM = h("div", { class: "meter" }, h("span", { class: "caps" }, "Steps"),
    h("span", { class: "val" }, k(steps.value)), track(steps, true),
    h("div", { class: "foot" }, h("span", { class: "range" }, `${k(t.steps[0])}–${k(t.steps[1])}`), stateWord(steps, "")));
  const updated = S.apple && S.apple.updated_at ? stamp(S.apple.updated_at, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }) : null;
  const readyM = d.readiness != null ? h("div", { class: "meter" }, h("span", { class: "caps" }, "Readiness"),
    h("span", { class: "val" }, fmt(d.readiness)), track({ value: d.readiness, lo: 70, hi: 100, state: d.readiness >= 70 ? "in" : "under" }, true),
    h("div", { class: "foot" }, h("span", { class: "range" }, d.hrv_ms != null ? `HRV ${fmt(d.hrv_ms)}` : "Oura"),
      h("span", { class: `state ${d.readiness >= 70 ? "in" : "under"}` }, d.temp_dev != null && Math.abs(d.temp_dev) >= 0.5 ? `temp ${d.temp_dev > 0 ? "+" : "−"}${fmt(Math.abs(d.temp_dev), 1)}°` : d.readiness >= 85 ? "high" : d.readiness >= 70 ? "good" : "low: go easy"))) : null;
  return section(h("div", null, h("h2", null, "Body"), updated ? h("p", { class: "sub" }, `Apple Health, synced ${updated}`) : null), null,
    h("div", { class: "meters" }, sleepM, readyM || restM, stepsM), ouraLine());
}

function todayWorkoutSection() {
  const today = locDate();
  const done = E.workouts(allSets().filter((x) => x.date === today && S.EX[x.ex] && S.EX[x.ex].kind !== "cardio"));
  if (done.length && !S.draft) {
    const sets = done.flatMap((w) => w.sets);
    return section("Trained today", null, sessionEntry(done[done.length - 1]));
  }
  const plan = currentPlan();
  return section("Today's workout", h("button", { class: "pillbtn", type: "button", onclick: () => setTab("train") }, "Details"), routineCard(plan, false));
}

// Body measurements: weight (7-day average) or waist.
function measureSection() {
  const body = allBody();
  const metric = S.measure || "kg";
  const pts = metric === "kg"
    ? E.weightTrend(body).map((p) => ({ date: p.date, v: p.avg, raw: p.kg }))
    : body.filter((b) => b.waist).map((b) => ({ date: b.date, v: b.waist, raw: b.waist }));
  const unit = metric === "kg" ? "kg" : "cm";
  const last = pts[pts.length - 1];
  const change = (days) => {
    if (!last) return null;
    const cut = addDays(last.date, -days);
    const then = pts.filter((p) => p.date <= cut).pop();
    return then ? last.v - then.v : null;
  };
  const chip = (lab, d) => h("span", { class: "chip" }, `${lab}: `, d == null ? "–" : h("span", { class: d > 0 && metric === "waist" ? "neg" : null }, `${d >= 0 ? "+" : "−"}${fmt(Math.abs(d), 1)}`));
  const lastWeight = body.filter((b) => b.kg).pop();
  const lastWaist = body.filter((b) => b.waist).pop();
  const tile = (key, label, val, u) => h("button", {
    class: "tile", type: "button", "aria-pressed": String(metric === key), onclick: () => { S.measure = key; render(); },
  }, h("span", { class: "caps" }, label), h("b", null, val == null ? "–" : fmt(val, 1), h("small", null, u)));
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const recent = pts.filter((p) => p.date >= addDays(locDate(), -84));
  return section(h("div", null, h("h2", null, "Measure"),
    h("p", { class: "sub" }, last ? h("span", null, h("b", { class: "big-n" }, fmt(last.raw, 1)), ` ${unit}`) : "No readings yet")),
  h("button", { class: "pillbtn", type: "button", onclick: weighInSheet }, icon("plus", "icon s"), "Log"),
  last ? h("p", { class: "tiny m" }, `Measured: ${short(last.date)}${metric === "kg" ? ` · 7-day avg ${fmt(last.v, 1)} kg` : ""}`) : null,
  last ? h("div", { class: "chips" }, chip("1W", change(7)), chip("4W", change(28)), chip("12W", change(84))) : null,
  recent.length ? chart(`Measure ${metric}`, recent.map((p) => ({ x: ms(p.date), y: Math.round(p.v * 10) / 10, label: `${short(p.date)}: ${fmt(p.v, 1)} ${unit}${metric === "kg" ? ` avg (${fmt(p.raw, 1)} that day)` : ""}` })), {
    soft: metric === "kg" ? recent.map((p) => ({ x: ms(p.date), y: p.raw })) : null, yfmt: (x) => fmt(x, 1), unit,
  }) : h("p", { class: "empty" }, "Weigh in the morning, after the toilet, before food. Log it here or tell the health bot \"weight 70.5\"."),
  h("div", { class: "tiles" }, tile("kg", "Weight", lastWeight && lastWeight.kg, "kg"), tile("waist", "Waist", lastWaist && lastWaist.waist, "cm")));
}

function weighInSheet() {
  const kg = h("input", { type: "number", inputmode: "decimal", step: "0.1", min: "30", max: "250", placeholder: "70.0", "aria-label": "Weight in kg" });
  const wa = h("input", { type: "number", inputmode: "decimal", step: "0.5", min: "40", max: "200", placeholder: "optional", "aria-label": "Waist in cm" });
  const msg = h("p", { class: "tiny", role: "status" });
  const save = h("button", { class: "btn", type: "button" }, "Save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const r = await api("/api/body", { date: locDate(), time: locTime(), kg: kg.value ? Number(kg.value) : null, waist: wa.value ? Number(wa.value) : null });
      S.queue.push(r.item);
      haptic("success");
      closeSheet();
      render();
    } catch (e) {
      msg.textContent = e.message;
      save.disabled = false;
    }
  });
  openSheet(h("h2", { id: "sheet-title" }, "Log a measurement"),
    h("div", { class: "form" }, h("label", null, h("span", { class: "caps" }, "Weight (kg)"), kg), h("label", null, h("span", { class: "caps" }, "Waist (cm)"), wa), save, msg));
  setTimeout(() => kg.focus(), 50);
}

// ------------------------------------------------------------------ train
function currentPlan() {
  return E.planWorkout({ lib: S.lib, profile: S.snap.profile, sets: allSets(), now: nowMs(), type: S.planType, swaps: S.swaps, prefs: S.snap.workout_prefs || null });
}

function rounds(items) {
  return Math.max(0, ...items.map((i) => i.sets.filter((x) => !x.warmup).length));
}

function targetText(it) {
  const ex = S.EX[it.ex];
  const work = it.sets.filter((x) => !x.warmup);
  const f = work[0] || {};
  if (ex.kind === "weight") return `${work.length}×${f.reps}${f.kg != null ? ` @${fmt(f.kg, 1)}` : ""}`;
  if (ex.kind === "time") return `${work.length}×${f.sec}s${ex.sides === 2 ? " a side" : ""}`;
  return `${work.length}×${f.reps}`;
}

function routineCard(plan, interactive) {
  const lines = [];
  plan.blocks.forEach((b) => b.items.forEach((it, i) => {
    const label = `${b.block}${b.items.length > 1 ? i + 1 : ""}.`;
    const kids = [h("span", null, `${label} `, h("b", null, S.EX[it.ex].name)), h("span", { class: "t" }, targetText(it))];
    lines.push(interactive
      ? h("button", { class: "ln", type: "button", onclick: () => planSheet(it, b) }, ...kids, h("small", null, it.note))
      : h("div", { class: "ln" }, ...kids));
  }));
  const muscles = [...new Set(plan.blocks.flatMap((b) => b.items.flatMap((i) => S.EX[i.ex].primary)))].slice(0, 4).map(muscleName);
  return h("div", { class: "routine" }, h("h3", null, plan.name), lines,
    h("div", { class: "foot" }, h("span", null, muscles.join(", ")), h("span", null, `~${plan.minutes} min`)));
}

function planSheet(it, b) {
  const opts = E.swapOptions(it.slot, S.EX).filter((x) => x !== it.ex);
  howTo(it.ex, h("p", { class: "m", style: "font-size:17px" }, targetText(it)), h("p", { class: "note" }, it.note),
    opts.length ? h("div", null, h("p", { class: "caps", style: "margin:6px 0 4px" }, "Swap for"),
      pickList(opts, (id) => {
        S.swaps[it.slot] = id;
        notePlanSwap(it, id, b ? b.items.filter((x) => x !== it).map((x) => x.ex) : []);
        closeSheet(); render();
      })) : null);
}

// ------------------------------------------------------------------ workout edits
// Every swap, removal and addition is kept with the workout, so the planner (and the bot)
// learn what you don't like or can't do together (say, machines at opposite ends
// of the gym). A plan swap made twice on the same slot keeps one edit: first from, last to.
function notePlanSwap(it, to, partners) {
  const prev = S.planEdits.find((e) => e.slot === it.slot);
  if (prev) {
    prev.to = to;
    if (prev.to === prev.from) S.planEdits.splice(S.planEdits.indexOf(prev), 1);
  } else {
    S.planEdits.push({ kind: "swap", stage: "plan", slot: it.slot, from: it.ex, to, with: partners });
  }
}
function noteEdit(e) {
  if (!S.draft) return;
  (S.draft.edits = S.draft.edits || []).push({ ...e, stage: "live" });
}

// Apple Health: the repo's archive (snapshot) with the Worker's fresher copy on top.
function apple() {
  const a = (S.snap && S.snap.apple) || { workouts: {}, days: {} };
  const b = S.apple || { workouts: {}, days: {} };
  const days = { ...(a.days || {}) };
  for (const [d, v] of Object.entries(b.days || {})) days[d] = { ...(days[d] || {}), ...v };
  // Oura, when linked, is the source for sleep, HRV and resting heart rate; the Watch keeps steps.
  for (const [d, o] of Object.entries((S.oura && S.oura.days) || {})) {
    const cur = days[d] || {};
    days[d] = { ...cur, sleep_h: o.sleep_h ?? cur.sleep_h, deep_h: o.deep_h ?? cur.deep_h, rem_h: o.rem_h ?? cur.rem_h,
      bed: o.bed ?? cur.bed, wake: o.wake ?? cur.wake, resting_hr: o.rhr ?? cur.resting_hr, hrv_ms: o.hrv ?? cur.hrv_ms,
      steps: cur.steps ?? o.steps, readiness: o.readiness, sleep_score: o.sleep_score, temp_dev: o.temp_dev };
  }
  return { workouts: { ...(a.workouts || {}), ...(b.workouts || {}) }, days };
}
const isWalk = (name) => /walk|hik/i.test(name || "");
const isRun = (name) => /run|jog/i.test(name || "");
// Watch workouts the training log keeps as cardio (workoutlog.py APPLE_CARDIO).
const isCardio = (name) => /run|jog|cycl|bik|row/i.test(name || "");
const minsOf = (t) => { const [hh, mm] = t.split(":").map(Number); return hh * 60 + mm; };

/** Every session: logged workouts (with the matching Watch workout attached, if
 *  any) and Watch-only workouts. Newest first. */
function allSessions(sets) {
  const logged = E.workouts(sets).map((w) => ({ ...w, kind: "logged", cardio: w.sets.every((x) => S.EX[x.ex] && S.EX[x.ex].kind === "cardio"),
    stretch: w.sets.every((x) => S.EX[x.ex] && S.EX[x.ex].role === "stretch") }));
  const out = [...logged];
  for (const aw of Object.values(apple().workouts)) {
    // A Watch workout that started within 45 minutes of a logged one on the same day is the same session.
    const twin = logged.find((w) => w.date === aw.date && !w.watch && Math.abs(minsOf(w.time) - minsOf(aw.start)) <= 45
      && (w.cardio ? isCardio(aw.name) : !isCardio(aw.name) && !isWalk(aw.name)));
    if (twin) twin.watch = aw;
    else out.push({ kind: "apple", wid: aw.id, date: aw.date, time: aw.start, watch: aw, sets: [] });
  }
  return out.sort((x, y) => (x.date + x.time < y.date + y.time ? 1 : -1));
}

function runKm(sess) {
  if (sess.watch && isRun(sess.watch.name) && sess.watch.km) return sess.watch.km;
  return sess.cardio ? sess.sets.reduce((a, x) => a + (x.km || 0), 0) : 0;
}

// This week: cumulative totals, Monday to Sunday.
function weekSeries(sets, sess, startIso, metric) {
  const days = apple().days;
  const out = [];
  let acc = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(startIso, i);
    const day = sets.filter((x) => x.date === d);
    const ss = sess.filter((x) => x.date === d);
    if (metric === "sessions") acc += ss.filter((x) => !x.stretch && !(x.kind === "apple" && isWalk(x.watch.name))).length;
    else if (metric === "sets") acc += day.filter((x) => S.EX[x.ex] && S.EX[x.ex].kind !== "cardio" && S.EX[x.ex].role !== "stretch" && !E.isWarmup(x, day, S.EX)).length;
    else if (metric === "volume") acc += day.reduce((a, x) => a + (S.EX[x.ex] ? E.volume(S.EX[x.ex], [x]) : 0), 0);
    else if (metric === "km") acc += ss.reduce((a, x) => a + runKm(x), 0);
    else if (metric === "min") acc += ss.reduce((a, x) => a + ((x.watch && x.watch.min) || 0), 0);
    else if (metric === "steps") acc += (days[d] && days[d].steps) || 0;
    out.push(acc);
  }
  return out;
}

function weekChart(vals, lastVals, upto, band) {
  const W = 340, H = 170, L = 8, R = 8, T = 10, B = 24;
  const max = Math.max(...vals, ...lastVals, band ? band[1] * 1.15 : 0, 1);
  const X = (i) => L + (i / 6) * (W - L - R);
  const Y = (y) => T + (1 - y / max) * (H - T - B);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "This week, cumulative" });
  const g = s("g", { class: "grid" });
  for (let i = 0; i <= 4; i++) g.append(s("line", { x1: 0, x2: W, y1: T + (i / 4) * (H - T - B), y2: T + (i / 4) * (H - T - B) }));
  svg.append(g);
  if (band) {
    svg.append(s("rect", { class: "band", x: X(0), width: X(6) - X(0), y: Y(band[1]), height: Y(band[0]) - Y(band[1]) }));
    for (const b of band) svg.append(s("line", { class: "bandline", x1: X(0), x2: X(6), y1: Y(b), y2: Y(b) }));
  }
  svg.append(s("path", { class: "line prev", d: lastVals.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join(" ") }));
  svg.append(s("path", { class: "line", d: vals.slice(0, upto + 1).map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join(" ") }));
  svg.append(s("circle", { class: "dot", cx: X(upto), cy: Y(vals[upto]), r: 5 }));
  const ax = s("g", { class: "axis" });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d, i) => ax.append(s("text", { x: X(i), y: H - 4, "text-anchor": i === 0 ? "start" : i === 6 ? "end" : "middle" }, d)));
  svg.append(ax);
  return h("div", { class: "chart" }, svg);
}

const METRICS = {
  sessions: { label: "Sessions", unit: "", band: () => [3, 4], f: (x) => fmt(x) },
  sets: { label: "Hard sets", unit: "", f: (x) => fmt(x) },
  volume: { label: "Volume", unit: "kg", f: (x) => (x >= 1000 ? `${fmt(x / 1000, 1)}k` : fmt(x)) },
  km: { label: "Run", unit: "km", f: (x) => fmt(x, 1) },
  min: { label: "Duration", unit: "", f: (x) => (x >= 60 ? `${Math.floor(x / 60)}h ${Math.round(x % 60)}m` : `${Math.round(x)}m`) },
  steps: { label: "Steps", unit: "", f: (x) => (x >= 1000 ? `${fmt(x / 1000, 1)}k` : fmt(x)) },
};

function viewTrain(v) {
  if (S.draft) return viewLive(v);
  const sets = allSets();
  const now = nowMs();
  const ws = weekStart(now);
  const lws = addDays(ws, -7);
  const upto = Math.round((Date.parse(`${locDate(now)}T12:00:00Z`) - Date.parse(`${ws}T12:00:00Z`)) / 86400e3);
  const metric = S.weekMetric || "sessions";
  const sess = allSessions(sets);
  const tot = (m, start) => { const a = weekSeries(sets, sess, start, m); return a[6]; };
  const cur = Object.fromEntries(Object.keys(METRICS).map((m) => [m, weekSeries(sets, sess, ws, m)[upto]]));
  const prev = Object.fromEntries(Object.keys(METRICS).map((m) => [m, tot(m, lws)]));
  const pct = prev.sessions ? Math.round(((cur.sessions - prev.sessions) / prev.sessions) * 100) : null;
  const M = METRICS[metric];
  const band = M.band ? M.band() : null;
  const tile = (m) => {
    const d = cur[m] - prev[m];
    return h("button", { class: "tile", type: "button", "aria-pressed": String(metric === m), onclick: () => { S.weekMetric = m; render(); } },
      h("span", { class: "caps" }, METRICS[m].label),
      h("b", null, METRICS[m].f(cur[m]), METRICS[m].unit ? h("small", null, METRICS[m].unit) : null),
      h("span", { class: "trend" }, icon(d >= 0 ? "up" : "down", "icon s"), `${METRICS[m].f(Math.abs(d))} vs last`));
  };
  v.append(h("section", { class: "sec" },
    h("header", null, h("div", null,
      h("p", { class: "small" }, "This week"),
      h("p", { class: "big-n" }, `${cur.sessions} `, h("small", null, cur.sessions === 1 ? "session" : "sessions"),
        pct != null ? h("span", { class: "m", style: `font-size:17px;margin-left:8px;color:${pct < 0 ? "var(--red)" : "var(--green-ink)"}` }, `(${pct > 0 ? "+" : ""}${pct}%)`) : null),
      h("p", { class: "small" }, `Last week: ${prev.sessions}`))),
    weekChart(weekSeries(sets, sess, ws, metric), weekSeries(sets, sess, lws, metric), upto, band),
    h("div", { class: "legend" }, band ? h("span", null, h("i", { class: "band" }), `${band[0]}–${band[1]} sessions a week`) : null,
      h("span", null, h("i", { class: "s1" }), "this week"), h("span", null, h("i", { class: "prev" }), "last week")),
    h("div", { class: "tiles" }, ["sessions", "sets", "volume", "km", "min", "steps"].map(tile))));

  const plan = currentPlan();
  const segs = h("div", { class: "chips", role: "group", "aria-label": "Session type" },
    [[null, "Auto"], ["upper", "Upper"], ["lower", "Lower"]].map(([t, l]) => h("button", {
      class: "chip", type: "button", "aria-pressed": String(S.planType === t), onclick: () => { S.planType = t; S.swaps = {}; S.planEdits = []; render(); },
    }, l)));
  v.append(section("Today's workout", h("button", { class: "pillbtn", type: "button", onclick: () => startWorkout({ name: "Workout", blocks: [] }) }, "Empty"),
    segs, h("p", { class: "note" }, plan.why), routineCard(plan, true),
    h("p", { class: "tiny" }, "Tap an exercise for how to do it, or to swap it. Start begins this workout.")));

  const stretch = E.planStretch({ lib: S.lib, profile: S.snap.profile, prefs: S.snap.workout_prefs || null });
  v.append(section("Stretching", h("button", { class: "pillbtn", type: "button", onclick: () => startWorkout(stretch) }, "Start"),
    h("p", { class: "note" }, "Hamstrings and ankles. Tap ✓ on a stretch to start its timer: it counts each side and ticks the set when you're done. Daily is best; 2 or 3 days a week still helps. Every workout also ends with a short cool-down stretch."),
    routineCard(stretch, true),
    h("p", { class: "tiny" }, "From AI agents, not a physio. Stretch to a strong pull, never pain; stop if anything is sharp.")));

  const rec = E.recovery(sets, S.EX, S.lib.muscles, now);
  const order = ["chest", "lats", "upper_back", "front_delts", "side_delts", "rear_delts", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "abs", "lower_back"];
  v.append(section("Recovery", h("span", { class: "tiny m" }, "100% = fresh"),
    h("div", { class: "rec" }, order.map((m) => h("div", { class: "rm" },
      h("span", { class: "nm" }, muscleName(m)), h("span", { class: "pc" }, `${rec[m]}%`),
      h("div", { class: "track", role: "img", "aria-label": `${muscleName(m)} ${rec[m]}% recovered` },
        h("span", { class: `fill${rec[m] < 60 ? " low" : ""}`, style: `width:${rec[m]}%` })))))));
  v.append(sessionsSection(sess));
}

function sessionKind(sets) {
  if (sets.every((x) => S.EX[x.ex] && S.EX[x.ex].kind === "cardio")) return S.EX[sets[0].ex].name;
  let up = 0, low = 0;
  for (const x of sets) {
    for (const m of (S.EX[x.ex] || { primary: [] }).primary) {
      if (E.TEMPLATES.upper.muscles.includes(m)) up++; else if (E.TEMPLATES.lower.muscles.includes(m)) low++;
    }
  }
  return up > low * 2 ? "Upper body" : low > up * 2 ? "Lower body" : "Full body";
}

function clock12(t) {
  const [hh, mm] = t.split(":").map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")}${hh < 12 ? "am" : "pm"}`;
}

const durText = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

function sessionEntry(w) {
  const order = [...new Set(w.sets.map((x) => x.ex))];
  const vol = order.reduce((a, id) => a + (S.EX[id] ? E.volume(S.EX[id], w.sets.filter((x) => x.ex === id)) : 0), 0);
  const aw = w.watch;
  const d = new Date(`${w.date}T12:00:00Z`);
  const meta = [];
  if (aw && aw.min) meta.push(h("span", null, icon("clock", "icon s"), durText(aw.min)));
  if (aw && aw.kcal) meta.push(h("span", null, icon("flame", "icon s"), fmt(aw.kcal)));
  const km = runKm(w) || (aw && aw.km);
  if (km) meta.push(h("span", null, icon("ruler", "icon s"), `${fmt(km, 1)}km`));
  if (w.kind === "logged" && !w.cardio) {
    meta.push(h("span", null, icon("layers", "icon s"), `${w.sets.length} sets`));
    if (vol) meta.push(h("span", null, icon("train", "icon s"), `${k(vol)} kg`));
  }
  if (w.cardio && !aw) meta.push(h("span", null, icon("clock", "icon s"), `${Math.round((w.sets[0].sec || 0) / 60)}m`));
  const src = w.sets.some((x) => x.pending) ? h("span", { class: "tag" }, "waiting for the bot")
    : [aw ? "Apple Watch" : null, w.kind === "logged" ? (w.sets.some((x) => x.partial) ? "screenshot, partial" : "Logged") : null].filter(Boolean).join(" · ");
  const title = w.kind === "apple" || (w.cardio && aw) ? aw.name : sessionKind(w.sets);
  const end = aw ? ` – ${clock12(aw.end)}` : "";
  const details = w.kind === "logged" ? h("ul", null, order.map((id) => {
    const ex = S.EX[id];
    const xs = w.sets.filter((x) => x.ex === id);
    const bpm = aw && aw.hr_ex && aw.hr_ex[id]; // the Watch's heart rate over this exercise's sets
    return h("li", null, `${ex ? ex.name : id}: ${ex && ex.kind === "cardio" ? `${fmt(xs[0].km, 1)} km` : xs.map((x) => setLabel(id, x)).join(", ")}`
      + (bpm ? ` · ${bpm.avg} bpm avg, ${bpm.max} max` : ""));
  })) : null;
  const hr = aw && aw.avg_hr ? h("ul", null, h("li", null, `Average heart rate ${aw.avg_hr} bpm${aw.max_hr ? `, max ${aw.max_hr}` : ""}`)) : null;
  return h("div", { class: "entry" },
    h("span", { class: "when" }, d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }), h("br"), d.toLocaleDateString("en-GB", { day: "2-digit", timeZone: "UTC" })),
    h("details", { class: "body" },
      h("summary", null, h("span", { class: "src" }, src), h("div", { class: "ttl" }, title), h("div", { class: "meta" }, meta)),
      details, hr),
    h("span", { class: "side" }, clock12(w.time), end ? h("br") : null, end ? end.slice(3) : null));
}

function sessionsSection(sess) {
  const sec = section("Sessions", null);
  if (!sess.length) { sec.append(h("p", { class: "empty" }, "No sessions yet.")); return sec; }
  const months = new Map();
  for (const w of sess.slice(0, 40)) {
    const key = w.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(w);
  }
  for (const [key, list] of months) {
    const label = new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    sec.append(h("div", null,
      h("div", { class: "month" }, h("span", { class: "caps", style: "color:var(--ink)" }, label), h("span", { class: "caps" }, `${list.length} sessions`)),
      h("div", { class: "list" }, list.map(sessionEntry))));
  }
  return sec;
}

function pickList(ids, onPick) {
  return h("div", { class: "pick" }, ids.map((id) => h("button", { type: "button", onclick: () => onPick(id) },
    exImg(id), h("span", null, S.EX[id].name, h("small", null, S.EX[id].primary.map(muscleName).join(", "))))));
}

function howTo(id, ...extra) {
  const ex = S.EX[id];
  const imgs = (ex.images || []).map((src, i) => h("img", { src, alt: `${ex.name}, ${i ? "end" : "start"} position` }));
  openSheet(
    h("h2", { id: "sheet-title" }, ex.name),
    ...extra,
    imgs.length ? h("div", { class: "frames" }, imgs, h("span", { class: "cap" }, "start and end position")) : h("p", { class: "empty" }, "No illustration for this one yet."),
    h("div", { class: "mchips" }, ex.primary.map((m) => h("span", { class: "mchip p" }, muscleName(m))),
      ex.secondary.map((m) => h("span", { class: "mchip" }, muscleName(m)))),
    ex.steps && ex.steps.length ? h("ol", { class: "steps" }, ex.steps.map((t) => h("li", null, t))) : null,
    h("p", { class: "tiny" }, "Photos and steps: free-exercise-db (public domain). Weights for two-dumbbell lifts are per dumbbell."));
}

function openSheet(...kids) {
  $("sheet-body").replaceChildren(...kids.flat().filter(Boolean));
  $("sheet").hidden = false;
  $("sheet-x").focus();
}
function closeSheet() { $("sheet").hidden = true; }

// ------------------------------------------------------------------ live workout
function startWorkout(plan) {
  const now = nowMs();
  S.draft = {
    started: now, date: locDate(now), time: locTime(now), name: plan.name, rest: null,
    blocks: plan.blocks.map((b) => ({
      block: b.block,
      items: b.items.map((it) => ({ slot: it.slot, ex: it.ex, note: it.note, sets: it.sets.map((x) => ({ ...x, done: false })) })),
    })),
    edits: S.planEdits.slice(),
  };
  S.planEdits = [];
  saveDraft(true);
  render();
}

let draftTimer = null;
function saveDraft(now = false) {
  if (S.draft) S.draft.saved = nowMs(); // the newest copy (phone or server) wins on reload
  try { localStorage.setItem(LS_DRAFT, JSON.stringify(S.draft)); } catch { /* private mode */ }
  clearTimeout(draftTimer);
  const send = () => api("/api/draft", { draft: S.draft }).catch(() => { /* kept locally; retried on the next change */ });
  if (now) send(); else draftTimer = setTimeout(send, 2500);
}

function countDone() {
  return S.draft ? S.draft.blocks.reduce((a, b) => a + b.items.reduce((c, it) => c + it.sets.filter((x) => x.done).length, 0), 0) : 0;
}
function countAll() {
  return S.draft ? S.draft.blocks.reduce((a, b) => a + b.items.reduce((c, it) => c + it.sets.length, 0), 0) : 0;
}

/** Working sets of an exercise with their index in it.sets (warm-ups left out). */
function working(it) {
  return it.sets.map((st, si) => ({ st, si })).filter((x) => !x.st.warmup);
}

/** The next set to do, in workout order: warm-ups first, then round by round
 *  inside each superset (A1, A2, A1, A2...). */
function nextSet() {
  for (const [bi, b] of S.draft.blocks.entries()) {
    for (const [ii, it] of b.items.entries()) {
      const si = it.sets.findIndex((x) => x.warmup && !x.done);
      if (si >= 0) return { bi, ii, si, it, st: it.sets[si] };
    }
    const n = Math.max(0, ...b.items.map((i) => working(i).length));
    for (let r = 0; r < n; r++) {
      for (const [ii, it] of b.items.entries()) {
        const w = working(it)[r];
        if (w && !w.st.done) return { bi, ii, si: w.si, it, st: w.st };
      }
    }
  }
  return null;
}

// Rest preferences per exercise, remembered on this phone when you change a rest.
function restPrefs() { try { return JSON.parse(localStorage.getItem(LS_REST) || "{}"); } catch { return {}; } }
function restFor(ex) { return restPrefs()[ex] || E.restFor(S.EX[ex]); }
function rememberRest(ex, sec) {
  const p = restPrefs();
  p[ex] = sec;
  try { localStorage.setItem(LS_REST, JSON.stringify(p)); } catch { /* ignore */ }
}

/** After a set is ticked: inside a superset round, go straight to the partner
 *  exercise; at the end of a round (or a straight set), start the rest. */
function afterTick(bi, ii, si) {
  const b = S.draft.blocks[bi];
  const it = b.items[ii];
  const warm = it.sets[si].warmup;
  const r = working(it).findIndex((x) => x.si === si);
  const partnerLeft = !warm && b.items.some((o, k) => k !== ii && working(o)[r] && !working(o)[r].st.done);
  const nx = nextSet();
  if (!nx) {
    S.draft.rest = { kind: "done" };
    S.draft.planNext = null;
  } else if (partnerLeft && nx.bi === bi && nx.ii !== ii) {
    S.draft.rest = { kind: "next", at: nowMs() };
    S.draft.planNext = 0; // straight on to the superset partner
  } else {
    const sec = warm ? 60 : Math.max(...b.items.map((o) => restFor(o.ex)));
    S.draft.rest = { kind: "rest", until: nowMs() + sec * 1000, total: sec, ex: b.items[0].ex };
    S.draft.planNext = sec;
  }
  saveDraft();
  renderDock();
  markNext(true);
}

let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { audio = null; }
}
function beep(times = 2) {
  if (!audio) return;
  try {
    for (let i = 0; i < times; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.22;
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.18);
    }
  } catch { /* no audio */ }
}

let dockTimer = null;
let restEndedFor = 0;
function renderDock() {
  const dock = $("dock");
  const r = S.draft && S.draft.rest;
  clearInterval(dockTimer);
  if (!r || !S.draft) { dock.hidden = true; document.body.classList.remove("resting"); return; }
  dock.hidden = false;
  document.body.classList.add("resting");
  const nx = nextSet();
  const nextText = nx ? h("span", { class: "next-line" }, "Next: ", h("b", null, S.EX[nx.it.ex].name), ` · ${setTarget(nx.it.ex, nx.st)}`) : null;
  const dismiss = () => { S.draft.rest = null; saveDraft(); renderDock(); };
  const closeBtn = h("button", { type: "button", "aria-label": "Hide", onclick: dismiss }, icon("close"));

  if (r.kind === "done") {
    dock.replaceChildren(h("div", { class: "plate slim over" },
      h("span", { class: "next-line" }, h("b", null, "Every set done."), " Tap Finish to save it."),
      h("div", { class: "ctl" }, closeBtn), dockRir()));
    return;
  }
  if (r.kind === "hold") return holdDock(dock, r);
  if (r.kind === "next") {
    dock.replaceChildren(h("div", { class: "plate slim" }, nextText, h("div", { class: "ctl" }, closeBtn), dockRir()));
    dockTimer = setTimeout(() => { if (S.draft && S.draft.rest === r) dismiss(); }, 20000);
    return;
  }
  // A rest: a navy tile that drains, then turns green and counts the overtime.
  const clock = h("span", { class: "clock", role: "timer" });
  const what = h("span", { class: "what" });
  const drain = h("span", { class: "drain" });
  const plate = h("div", { class: "plate rest" }, clock, what,
    h("div", { class: "ctl" },
      h("button", { class: "adj", type: "button", "aria-label": "15 seconds less", onclick: () => nudge(-15) }, "−15"),
      h("button", { class: "adj", type: "button", "aria-label": "15 seconds more", onclick: () => nudge(15) }, "+15"),
      h("button", { type: "button", "aria-label": "Skip the rest", onclick: dismiss }, icon("skip"))),
    dockRir(), nextText, drain);
  dock.replaceChildren(plate);
  const tick = () => {
    const left = (r.until - nowMs()) / 1000;
    if (left > 0) {
      clock.textContent = mmss(Math.ceil(left));
      what.textContent = "Rest";
      drain.style.transform = `scaleX(${Math.max(0, left / r.total)})`;
      plate.classList.add("rest"); plate.classList.remove("over");
    } else {
      if (restEndedFor !== r.until) {
        restEndedFor = r.until;
        haptic("success");
        beep(2);
      }
      const over = -left;
      clock.textContent = `+${mmss(Math.floor(over))}`;
      what.textContent = "Rest's up: go";
      drain.style.transform = "scaleX(0)";
      plate.classList.remove("rest"); plate.classList.add("over");
      if (over > 600) dismiss();
    }
  };
  tick();
  dockTimer = setInterval(tick, 250);
}

// A stretch's hold timer: each side in turn (3 s to switch), then the set ticks itself.
const SWITCH_SEC = 3;
function startHold(bi, ii, si) {
  const it = S.draft.blocks[bi].items[ii];
  const sec = it.sets[si].sec || S.EX[it.ex].hold || 30;
  const sides = S.EX[it.ex].sides === 2 ? 2 : 1;
  S.draft.rest = { kind: "hold", bi, ii, si, sec, sides, side: 1, until: nowMs() + sec * 1000 };
  haptic("soft");
  saveDraft();
  renderDock();
}

function finishHold() {
  const r = S.draft && S.draft.rest;
  if (!r || r.kind !== "hold") return;
  const st = S.draft.blocks[r.bi] && S.draft.blocks[r.bi].items[r.ii] && S.draft.blocks[r.bi].items[r.ii].sets[r.si];
  S.draft.rest = null;
  if (!st) { saveDraft(); renderDock(); return; }
  st.done = true;
  stampSet(st);
  haptic("tick");
  render();
  afterTick(r.bi, r.ii, r.si);
}

function holdDock(dock, r) {
  const it = S.draft.blocks[r.bi] && S.draft.blocks[r.bi].items[r.ii];
  if (!it) { S.draft.rest = null; saveDraft(); dock.hidden = true; return; }
  const clock = h("span", { class: "clock", role: "timer" });
  const what = h("span", { class: "what" });
  const drain = h("span", { class: "drain" });
  const plate = h("div", { class: "plate rest hold" }, clock, what,
    h("div", { class: "ctl" },
      h("button", { class: "adj", type: "button", onclick: finishHold }, "Done"),
      h("button", { type: "button", "aria-label": "Stop the timer", onclick: () => { S.draft.rest = null; saveDraft(); renderDock(); } }, icon("close"))),
    h("span", { class: "next-line" }, h("b", null, S.EX[it.ex].name), ` · set ${r.si + 1}`), drain);
  dock.replaceChildren(plate);
  const tick = () => {
    if (S.draft.rest !== r) return;
    let left = (r.until - nowMs()) / 1000;
    if (left <= 0 && r.side < r.sides) { // switch sides
      r.side += 1;
      r.until = nowMs() + (SWITCH_SEC + r.sec) * 1000;
      left = SWITCH_SEC + r.sec;
      haptic("success"); beep(1);
      saveDraft();
    } else if (left <= 0) {
      haptic("success"); beep(2);
      finishHold();
      return;
    }
    const switching = r.side > 1 && left > r.sec;
    clock.textContent = mmss(Math.ceil(switching ? left - r.sec : left));
    what.textContent = switching ? "Switch sides" : r.sides === 2 ? (r.side === 1 ? "Hold · first side" : "Hold · second side") : "Hold";
    drain.style.transform = `scaleX(${switching ? 1 : Math.max(0, Math.min(1, left / r.sec))})`;
  };
  tick();
  dockTimer = setInterval(tick, 250);
}

/** In the rest timer, just after an exercise's last set: reps left in the tank? */
function dockRir() {
  const a = S.draft && S.draft.askRir;
  const it = a && S.draft.blocks[a.bi] && S.draft.blocks[a.bi].items[a.ii];
  if (!it || it.rir != null) return null;
  const timed = S.EX[it.ex].kind === "time";
  const opts = timed ? [[0, "0s"], [1, "5s"], [2, "10s"], [3, "15s"], [4, "20s+"]] : [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5+"]];
  return h("div", { class: "dock-rir" },
    h("span", null, `${S.EX[it.ex].name}: ${timed ? "seconds" : "reps"} left in the tank?`),
    h("div", { class: "chips", role: "group", "aria-label": "Reps left in the tank" }, opts.map(([v, l]) => h("button", {
      class: "chip", type: "button", onclick: () => {
        it.rir = v;
        S.draft.askRir = null;
        haptic("soft");
        saveDraft();
        const box = document.querySelector(`.rir[data-rir="${a.bi}-${a.ii}"]`);
        if (box) fillRir(box, it);
        renderDock();
      },
    }, l))));
}

function nudge(d) {
  const r = S.draft.rest;
  if (!r || r.kind !== "rest") return;
  const left = Math.max(0, (r.until - nowMs()) / 1000);
  const nl = Math.max(0, left + d);
  r.until = nowMs() + nl * 1000;
  r.total = Math.max(15, r.total + d);
  S.draft.planNext = r.total;
  rememberRest(r.ex, Math.max(15, Math.round(r.total / 15) * 15));
  haptic("soft");
  saveDraft();
  renderDock();
}

/** Highlight the next set and, after a tick, bring it into view above the dock. */
function markNext(scroll) {
  for (const el of document.querySelectorAll(".set.next")) el.classList.remove("next");
  const nx = S.draft && nextSet();
  if (!nx) return;
  const el = document.querySelector(`.set[data-k="${nx.bi}-${nx.ii}-${nx.si}"]`);
  if (!el) return;
  el.classList.add("next");
  if (scroll) {
    const r = el.getBoundingClientRect();
    const bottomLimit = window.innerHeight - (document.body.classList.contains("resting") ? 230 : 120);
    if (r.top < 80 || r.bottom > bottomLimit) {
      window.scrollBy({ top: r.top - Math.max(100, bottomLimit / 2), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }
}

let clock = null;
function tickClock() {
  const el = $("elapsed");
  if (!el || !S.draft) { clearInterval(clock); return; }
  el.textContent = `${mmss((nowMs() - S.draft.started) / 1000)} · ${countDone()} of ${countAll()} sets`;
}

function viewLive(v) {
  const d = S.draft;
  v.append(h("div", { class: "live-top" },
    h("div", { class: "lt" }, h("b", null, d.name), h("span", { id: "elapsed", class: "n" })),
    h("button", { class: "btn sm", type: "button", onclick: finish }, "Finish")));
  d.blocks.forEach((b, bi) => {
    const what = b.items.length > 1 ? "superset" : S.EX[b.items[0].ex].name;
    v.append(h("section", { class: "sec live-blk", "data-bi": String(bi) }, h("div", { class: "blk" }, h("span", { class: "letter" }, b.block),
      h("span", { class: "caps" }, `${b.items.length > 1 ? "Superset" : S.EX[b.items[0].ex].role === "stretch" ? "Stretch" : "Exercise"} · ${rounds(b.items)} ${rounds(b.items) === 1 ? "round" : "rounds"}`),
      h("span", { class: "move" },
        h("button", { class: "mv", type: "button", "aria-label": `Move ${what} up`, disabled: bi === 0, onclick: () => moveBlock(bi, -1) }, icon("up", "icon s")),
        h("button", { class: "mv", type: "button", "aria-label": `Move ${what} down`, disabled: bi === d.blocks.length - 1, onclick: () => moveBlock(bi, 1) }, icon("down", "icon s")),
        grip("card", { bi }, `Drag ${what} to reorder`))),
      b.items.map((it, ii) => liveItem(b, bi, it, ii))));
  });
  v.append(h("section", { class: "sec" }, h("div", { class: "btns" },
    h("button", { class: "btn quiet", type: "button", onclick: addExerciseSheet }, icon("plus"), "Add an exercise"),
    h("button", { class: "btn danger", type: "button", onclick: discard }, "Discard workout"))));
  clearInterval(clock);
  clock = setInterval(tickClock, 1000);
  tickClock();
  requestAnimationFrame(() => markNext(false));
}

function stepper(value, step, unit, onChange, label) {
  const field = unit === "kg" ? "kg" : unit === "reps" ? "reps" : "sec";
  const input = h("input", { type: "number", inputmode: unit === "kg" ? "decimal" : "numeric", value: value ?? "", placeholder: "–", "aria-label": label, step: String(step), "data-f": field });
  input.addEventListener("change", () => onChange(input.value === "" ? null : Number(input.value)));
  const bump = (dir) => () => {
    const x = Math.max(0, (Number(input.value) || 0) + dir * step);
    input.value = String(Math.round(x * 10) / 10);
    haptic("soft");
    onChange(Number(input.value));
  };
  return h("div", { class: "step" },
    h("button", { type: "button", "aria-label": `less ${label}`, onclick: bump(-1) }, icon("minus")),
    h("label", null, input, h("span", { class: "u" }, unit)),
    h("button", { type: "button", "aria-label": `more ${label}`, onclick: bump(1) }, icon("plus")));
}

function liveItem(b, bi, it, ii) {
  const ex = S.EX[it.ex];
  const inc = (S.snap.profile.increments_kg || {})[ex.equipment] || 2;
  const hist = E.lastWorking(allSets(), S.EX, it.ex);
  let n = 0;
  const rows = it.sets.map((st, si) => {
    const row = h("div", { class: `set${st.done ? " done" : ""}`, "data-k": `${bi}-${ii}-${si}` });
    const fields = [];
    const set = (f) => (x) => setField(bi, ii, si, f, x);
    if (ex.kind === "weight") {
      fields.push(stepper(st.kg, inc, "kg", set("kg"), `set ${si + 1} weight`));
      fields.push(stepper(st.reps, 1, "reps", set("reps"), `set ${si + 1} reps`));
    } else if (ex.kind === "time") {
      fields.push(stepper(st.sec, 5, "seconds", set("sec"), `set ${si + 1} seconds`), h("span"));
    } else {
      fields.push(stepper(st.reps, 1, "reps", set("reps"), `set ${si + 1} reps`), h("span"));
    }
    const tick = h("button", { class: "tick", type: "button", "aria-pressed": String(!!st.done), "aria-label": `set ${si + 1} done` }, icon("check"));
    tick.addEventListener("click", () => {
      unlockAudio();
      if (ex.role === "stretch" && !st.done) {
        const r = S.draft.rest;
        if (r && r.kind === "hold" && r.bi === bi && r.ii === ii && r.si === si) finishHold(); // ✓ again: done now
        else startHold(bi, ii, si);
        return;
      }
      st.done = !st.done;
      row.classList.toggle("done", st.done);
      tick.setAttribute("aria-pressed", String(st.done));
      if (st.done) {
        stampSet(st);
        haptic("tick");
        // the exercise's last set: ask about reps in reserve in the rest timer, where it can be seen
        S.draft.askRir = !st.warmup && it.rir == null && ex.role !== "stretch" && working(it).every((w) => w.st.done) ? { bi, ii } : null;
        afterTick(bi, ii, si);
      } else { unstampSet(st); saveDraft(); markNext(false); }
      tickClock();
      fillRir(rir, it);
    });
    if (!st.warmup) n++;
    row.append(h("span", { class: "no" }, st.warmup ? "W" : String(n)), ...fields, tick);
    return row;
  });
  const rir = h("div", { class: "rir", "data-rir": `${bi}-${ii}` });
  fillRir(rir, it);
  return h("div", { class: "ex", "data-bi": String(bi), "data-ii": String(ii) },
    h("button", { class: "thumb-btn", type: "button", "aria-label": `How to do ${ex.name}`, onclick: () => howTo(it.ex) }, exImg(it.ex)),
    h("div", { class: "rb" },
      h("span", { class: "name-row" }, h("span", { class: "name" }, ex.name), grip("ex", { bi, ii }, `Drag ${ex.name} to move it`)),
      h("span", { class: "hint m" }, hist ? `Last ${short(hist.date)}: ${hist.sets.map((x) => setLabel(it.ex, x)).join(", ")}` : "First time"),
      it.note ? h("span", { class: "hint" }, it.note) : null,
      h("div", { class: "acts" },
        h("button", { class: "act", type: "button", onclick: () => howTo(it.ex) }, icon("info", "icon s"), "How to"),
        it.slot && E.swapOptions(it.slot, S.EX).length > 1 ? h("button", { class: "act", type: "button", onclick: () => liveSwap(bi, ii) }, icon("swap", "icon s"), "Swap") : null,
        h("button", { class: "act", type: "button", onclick: () => moveSheet(bi, ii) }, icon("move", "icon s"), "Move"),
        h("button", { class: "act mute", type: "button", onclick: () => removeItem(bi, ii) }, icon("remove", "icon s"), "Remove"))),
    h("div", { class: "sets" }, rows,
      h("button", { class: "act addset", type: "button", onclick: () => addSet(it) }, icon("plus", "icon s"), "Add a set")),
    rir);
}

/** A change to one set carries on to the later sets not done yet (warm-ups stay as they are). */
function setField(bi, ii, si, field, x) {
  const it = S.draft.blocks[bi].items[ii];
  const st = it.sets[si];
  st[field] = x;
  if (!st.warmup) {
    for (let j = si + 1; j < it.sets.length; j++) {
      const o = it.sets[j];
      if (o.done || o.warmup) continue;
      o[field] = x;
      const input = document.querySelector(`.set[data-k="${bi}-${ii}-${j}"] input[data-f="${field}"]`);
      if (input) input.value = x ?? "";
    }
  }
  saveDraft();
}

/** When a set is ticked: the time, its place in the order sets were done, the seconds
 *  since the set before (rest plus the set itself) and the rest the app had planned. */
function stampSet(st) {
  const d = S.draft;
  const now = nowMs();
  const prev = Math.max(0, ...d.blocks.flatMap((b) => b.items.flatMap((i) => i.sets.filter((x) => x !== st && x.done && x.at).map((x) => x.at))));
  st.at = now;
  st.seq = (d.seq || 0) + 1;
  d.seq = st.seq;
  st.gap = prev ? Math.round((now - prev) / 1000) : null;
  st.plan = d.planNext ?? null;
}
function unstampSet(st) { for (const k of ["at", "seq", "gap", "plan"]) delete st[k]; }

/** Once every working set of an exercise is ticked: how many more reps were left in the tank? */
function fillRir(box, it) {
  if (S.EX[it.ex].role === "stretch") { box.replaceChildren(); return; } // nothing left in the tank on a stretch
  const work = working(it);
  if (!work.length || work.some((w) => !w.st.done)) { box.replaceChildren(); return; }
  const timed = S.EX[it.ex].kind === "time";
  const opts = timed ? [[0, "0s"], [1, "5s"], [2, "10s"], [3, "15s"], [4, "20s+"]] : [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5+"]];
  box.replaceChildren(
    h("span", { class: "caps" }, timed ? "Seconds left in the tank?" : "Reps left in the tank?"),
    h("div", { class: "chips", role: "group", "aria-label": "Reps left in the tank" }, opts.map(([v, l]) => h("button", {
      class: "chip", type: "button", "aria-pressed": String(it.rir === v),
      onclick: () => { it.rir = it.rir === v ? null : v; haptic("soft"); if (S.draft.askRir) S.draft.askRir = null; saveDraft(); fillRir(box, it); renderDock(); },
    }, l))));
}

/** Move a card (an exercise, or a superset) up or down: the gym's layout decides the order. */
function moveBlock(bi, dir) {
  const j = bi + dir;
  if (j < 0 || j >= S.draft.blocks.length) return;
  E.moveCard(S.draft.blocks, bi, j);
  afterMove(j);
}

/** Move one exercise: within its superset, out to a card of its own, or into another card.
 *  Moving it out of a superset is noted, so the planner stops pairing those two. */
function moveEx(from, to) {
  const split = E.moveExercise(S.draft.blocks, from, to);
  if (split) noteEdit({ kind: "split", ...split });
  afterMove(null);
}

function afterMove(focus) {
  S.draft.askRir = null; // it points at a card by position
  haptic("soft");
  saveDraft();
  render();
  if (focus == null) return;
  requestAnimationFrame(() => {
    const el = document.querySelectorAll(".live-blk")[focus];
    if (el) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

function moveSheet(bi, ii) {
  const b = S.draft.blocks[bi];
  const names = (o) => o.items.map((x) => S.EX[x.ex].name).join(" + ");
  const opts = [];
  if (b.items.length > 1) {
    if (ii > 0) opts.push(["Earlier in this superset", { bi, ii: ii - 1 }]);
    if (ii < b.items.length - 1) opts.push(["Later in this superset", { bi, ii: ii + 2 }]);
    opts.push(["On its own, after this card", { card: bi + 1 }]);
  }
  S.draft.blocks.forEach((o, k) => { if (k !== bi) opts.push([`Pair with ${o.block}: ${names(o)}`, { bi: k, ii: o.items.length }]); });
  openSheet(h("h2", { id: "sheet-title" }, `Move ${S.EX[b.items[ii].ex].name}`),
    h("p", { class: "hint" }, "Or drag it by ≡ to anywhere in the workout."),
    h("div", { class: "pick moves" }, opts.map(([label, to]) => h("button", { type: "button", onclick: () => { closeSheet(); moveEx({ bi, ii }, to); } }, h("span", null, label)))));
}

// Drag and drop, by the ≡ handle (touch or mouse). A card drops between cards; an exercise drops
// beside another exercise (joining its card) or on a card's header (a card of its own, there).
let drag = null;
function grip(kind, at, label) {
  const g = h("button", { class: "grip", type: "button", "aria-label": label }, icon("grip", "icon s"));
  g.addEventListener("pointerdown", (e) => startDrag(e, kind, at, g));
  g.addEventListener("click", (e) => e.preventDefault());
  return g;
}

function startDrag(e, kind, at, handle) {
  if (drag || !S.draft || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  const src = handle.closest(kind === "card" ? ".live-blk" : ".ex");
  const r = src.getBoundingClientRect();
  const ghost = src.cloneNode(true);
  ghost.classList.add("drag-ghost");
  Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
  document.body.append(ghost);
  src.classList.add("drag-src");
  drag = { kind, at, src, ghost, dy: e.clientY - r.top, y: e.clientY, to: null, mark: null, id: e.pointerId, handle };
  try { handle.setPointerCapture(e.pointerId); } catch { /* not all browsers */ }
  handle.addEventListener("pointermove", onDrag);
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  haptic("soft");
  drag.scroll = requestAnimationFrame(autoScroll);
}

function autoScroll() {
  if (!drag) return;
  const edge = 90;
  const v = drag.y < edge ? -(edge - drag.y) / 6 : drag.y > innerHeight - edge - 70 ? (drag.y - (innerHeight - edge - 70)) / 6 : 0;
  if (v) { window.scrollBy(0, v); findDrop(); }
  drag.scroll = requestAnimationFrame(autoScroll);
}

function onDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.y = e.clientY;
  drag.ghost.style.top = `${e.clientY - drag.dy}px`;
  findDrop(e.clientX);
}

function setMark(el, cls) {
  if (drag.mark && (drag.mark[0] !== el || drag.mark[1] !== cls)) drag.mark[0].classList.remove(drag.mark[1]);
  if (el) el.classList.add(cls);
  drag.mark = el ? [el, cls] : null;
}

function findDrop(x = innerWidth / 2) {
  const el = document.elementFromPoint(x, drag.y);
  const n = S.draft.blocks.length;
  const card = el && el.closest(".live-blk");
  const before = (node) => drag.y < node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2;
  drag.to = null;
  if (drag.kind === "card") {
    if (card) {
      const k = Number(card.dataset.bi);
      drag.to = before(card) ? k : k + 1;
      setMark(card, before(card) ? "drop-before" : "drop-after");
    } else if (el && el.closest(".live-top")) { drag.to = 0; setMark(document.querySelector(".live-blk"), "drop-before"); }
    else if (el && el.closest(".sec:not(.live-blk)")) { drag.to = n; setMark(document.querySelectorAll(".live-blk")[n - 1], "drop-after"); }
    else setMark(null);
    return;
  }
  const ex = el && el.closest(".live-blk .ex");
  if (ex) {
    const bi = Number(ex.dataset.bi), ii = Number(ex.dataset.ii);
    drag.to = { bi, ii: before(ex) ? ii : ii + 1 };
    setMark(ex, before(ex) ? "drop-before" : "drop-after");
  } else if (card && el.closest(".blk")) {
    drag.to = { card: Number(card.dataset.bi) };
    setMark(card, "drop-before");
  } else if (el && el.closest(".sec:not(.live-blk)")) {
    drag.to = { card: n };
    setMark(document.querySelectorAll(".live-blk")[n - 1], "drop-after");
  } else setMark(null);
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.scroll);
  for (const t of ["pointermove", "pointerup", "pointercancel"]) d.handle.removeEventListener(t, t === "pointermove" ? onDrag : endDrag);
  d.ghost.remove();
  d.src.classList.remove("drag-src");
  if (d.mark) d.mark[0].classList.remove(d.mark[1]);
  if (e.type === "pointercancel" || d.to == null) return;
  if (d.kind === "card") {
    const to = d.to > d.at.bi ? d.to - 1 : d.to;
    if (to !== d.at.bi) { E.moveCard(S.draft.blocks, d.at.bi, to); afterMove(null); }
  } else {
    const same = d.to.card == null && d.to.bi === d.at.bi && (d.to.ii === d.at.ii || d.to.ii === d.at.ii + 1);
    if (!same) moveEx(d.at, d.to);
  }
}

function addSet(it) {
  const last = it.sets[it.sets.length - 1] || {};
  it.sets.push({ kg: last.kg ?? null, reps: last.reps ?? null, sec: last.sec ?? null, done: false });
  saveDraft();
  render();
}

function removeItem(bi, ii) {
  const b = S.draft.blocks[bi];
  const it = b.items[ii];
  noteEdit({ kind: "remove", slot: it.slot, from: it.ex, with: b.items.filter((x) => x !== it).map((x) => x.ex) });
  b.items.splice(ii, 1);
  if (!b.items.length) S.draft.blocks.splice(bi, 1);
  saveDraft();
  render();
}

function freshSets(id, n = 3) {
  const p = E.prescribe(S.EX[id], allSets(), S.EX, S.snap.profile, n);
  return { sets: p.sets.map((x) => ({ ...x, done: false })), note: p.note };
}

function liveSwap(bi, ii) {
  const it = S.draft.blocks[bi].items[ii];
  openSheet(h("h2", { id: "sheet-title" }, `Swap ${S.EX[it.ex].name}`),
    pickList(E.swapOptions(it.slot, S.EX).filter((x) => x !== it.ex), (id) => {
      const f = freshSets(id, it.sets.filter((x) => !x.warmup).length || 3);
      noteEdit({ kind: "swap", slot: it.slot, from: it.ex, to: id, with: S.draft.blocks[bi].items.filter((x) => x !== it).map((x) => x.ex) });
      Object.assign(it, { ex: id, sets: f.sets, note: f.note });
      saveDraft(); closeSheet(); render();
    }));
}

function addExerciseSheet() {
  const list = h("div");
  const fill = (q) => {
    const n = q.trim().toLowerCase();
    const hits = S.lib.exercises.filter((e) => e.kind !== "cardio" && (!n || e.name.toLowerCase().includes(n) || e.primary.some((m) => m.includes(n))));
    list.replaceChildren(pickList(hits.map((e) => e.id), (id) => {
      const f = freshSets(id);
      const letter = String.fromCharCode(65 + S.draft.blocks.length);
      noteEdit({ kind: "add", to: id });
      S.draft.blocks.push({ block: letter, items: [{ slot: null, ex: id, note: f.note, sets: f.sets }] });
      saveDraft(); closeSheet(); render();
      window.scrollTo(0, document.body.scrollHeight);
    }));
  };
  const q = h("input", { class: "field", type: "search", placeholder: "Search: curl, chest, squat", "aria-label": "Search exercises" });
  q.addEventListener("input", () => fill(q.value));
  fill("");
  openSheet(h("h2", { id: "sheet-title" }, "Add an exercise"), q, list);
}

function confirmBox(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm) tg.showConfirm(text, (ok) => resolve(ok));
    else resolve(window.confirm(text));
  });
}

function endLive() {
  S.draft = null;
  try { localStorage.removeItem(LS_DRAFT); } catch { /* ignore */ }
  clearInterval(dockTimer);
  clearInterval(clock);
}

async function finish() {
  const n = countDone();
  if (!n) { openSheet(h("h2", { id: "sheet-title" }, "Nothing ticked yet"), h("p", null, "Tick each set as you finish it. Only ticked sets are saved.")); return; }
  if (!(await confirmBox(`Save this workout (${n} sets)? The health bot logs it and replies in Telegram.`))) return;
  try {
    const d = S.draft;
    const r = await api("/api/finish", { workout: d });
    S.queue.push(r.item);
    const ended = nowMs();
    endLive();
    haptic("success");
    render();
    summarySheet(d, ended);
  } catch (e) {
    openSheet(h("h2", { id: "sheet-title" }, "Not saved yet"), h("p", null, `${e.message} Your sets are kept on this phone; tap Finish again.`));
  }
}

// ------------------------------------------------------------------ the summary after Finish
const WORK_SEC = { compound: 50, isolation: 40, core: 40 }; // as engine.js plans a set

/** The numbers for a finished workout, from the sets as ticked. */
function workoutStats(d, ended) {
  const done = [];
  d.blocks.forEach((b) => b.items.forEach((it) => it.sets.forEach((st) => { if (st.done) done.push({ ...st, ex: it.ex }); })));
  const order = [...done].sort((a, b) => (a.seq || 1e9) - (b.seq || 1e9));
  const exOrder = [...new Set(order.map((x) => x.ex))];
  const vol = exOrder.reduce((a, id) => a + (S.EX[id] ? E.volume(S.EX[id], done.filter((x) => x.ex === id)) : 0), 0);
  const gaps = order.filter((x) => x.gap != null && x.plan != null && x.gap <= 900);
  const actual = gaps.length ? gaps.reduce((a, x) => a + x.gap, 0) / gaps.length : null;
  const plan = gaps.length ? gaps.reduce((a, x) => a + x.plan + (WORK_SEC[(S.EX[x.ex] || {}).role] || 40), 0) / gaps.length : null;
  const rir = [];
  d.blocks.forEach((b) => b.items.forEach((it) => { if (it.rir != null && it.sets.some((x) => x.done)) rir.push({ ex: it.ex, rir: it.rir }); }));
  return { minutes: Math.max(1, Math.round((ended - d.started) / 60000)), sets: done.length, exOrder, vol, order,
    actual, plan, pace: actual != null && plan ? Math.min(100, Math.round((plan / Math.max(1, actual)) * 100)) : null, rir };
}

function summarySheet(d, ended) {
  const s = workoutStats(d, ended);
  const { sp, name } = petInfo();
  const art = drawPet(sp, { mood: 90, level: (S.snap.weekly || {}).level || 1, size: 120 });
  setTimeout(() => poke(art, sp), 400);
  const setsOf = (id) => s.order.filter((x) => x.ex === id).map((x) => setLabel(id, x)).join(", ");
  const rirOf = (id) => { const r = s.rir.find((x) => x.ex === id); return r ? ` · ${r.rir}${S.EX[id].kind === "time" ? "×5s" : ""} in the tank` : ""; };
  openSheet(
    h("h2", { id: "sheet-title" }, "Workout done"),
    h("div", { class: "pet-hero" }, art),
    h("p", { class: "note" }, `${name} is proud of you. The health bot logs it and replies in Telegram in a minute or two.`),
    h("div", { class: "tiles" },
      h("div", { class: "tile" }, h("span", { class: "caps" }, "Time"), h("b", null, durText(s.minutes))),
      h("div", { class: "tile" }, h("span", { class: "caps" }, "Sets"), h("b", null, String(s.sets))),
      h("div", { class: "tile" }, h("span", { class: "caps" }, "Volume"), h("b", null, s.vol ? `${k(s.vol)}` : "–", s.vol ? h("small", null, "kg") : null)),
      h("div", { class: "tile" }, h("span", { class: "caps" }, "Pace"), h("b", null, s.pace != null ? `${s.pace}%` : "–"))),
    s.actual != null ? h("p", { class: "small" }, `Between sets you took ${mmss(Math.round(s.actual))} on average, against ${mmss(Math.round(s.plan))} planned (the rest plus the set itself)`
      + (s.actual < s.plan * 0.8 ? ": quicker than planned. Fine while your reps hold up." : s.pace >= 90 ? ": right on plan." : s.pace >= 75 ? ": a little slow." : ": long rests; shorter ones would save time.")) : null,
    h("h3", null, "In the order you did them"),
    h("ol", { class: "done-order" }, s.exOrder.map((id) => h("li", null, h("b", null, S.EX[id].name), h("span", { class: "m" }, `${setsOf(id)}${rirOf(id)}`)))),
    h("p", { class: "tiny" }, "If your Apple Watch recorded this workout, it pairs with this session (same day, starting within 45 minutes), so nothing is counted twice: the Watch adds its time, calories and heart rate to it."));
}

async function discard() {
  if (!(await confirmBox("Discard this workout? Ticked sets are lost."))) return;
  endLive();
  api("/api/draft", { draft: null }).catch(() => {});
  render();
}

// ------------------------------------------------------------------ progress
function rangeChips() {
  return h("div", { class: "chips", role: "group", "aria-label": "Time range" },
    [[28, "4W"], [84, "12W"], [3650, "All"]].map(([d, l]) => h("button", {
      class: "chip", type: "button", "aria-pressed": String(S.range === d), onclick: () => { S.range = d; render(); },
    }, l)));
}

/** A one-axis chart. points: [{x: ms, y, label}], opts: {band:[lo,hi], kind:"line"|"bar", soft:[...], yfmt} */
function chart(title, points, opts) {
  const W = 340, H = 180, L = 38, R = 6, T = 8, B = 22;
  const wrap = h("div", { class: "chart" });
  if (!points.length) { wrap.append(h("p", { class: "empty" }, opts.empty || "No data yet.")); return wrap; }
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 86400e3);
  const ys = points.map((p) => p.y).concat(opts.band || [], (opts.soft || []).map((p) => p.y));
  let y0 = opts.zero ? 0 : Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.08 || 1;
  y0 = opts.zero ? 0 : y0 - pad; y1 += pad;
  const bw = opts.kind === "bar" ? Math.max(3, Math.min(10, ((W - L - R) / ((x1 - x0) / 86400e3 + 1)) - 4)) : 0;
  const X = (x) => L + bw / 2 + ((x - x0) / (x1 - x0 || 1)) * (W - L - R - bw);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (H - T - B); // reads y0/y1 when called
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title} chart` });
  // Round gridlines: 1, 2 or 5 times a power of ten, about four of them.
  const raw = (y1 - y0) / 4;
  const p10 = 10 ** Math.floor(Math.log10(raw || 1));
  const tick = [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw) || raw;
  y0 = Math.floor(y0 / tick) * tick;
  y1 = Math.ceil(y1 / tick) * tick;
  const g = s("g", { class: "grid" }), ax = s("g", { class: "axis" });
  for (let yv = y0; yv <= y1 + tick / 2; yv += tick) {
    g.append(s("line", { x1: L, x2: W - R, y1: Y(yv), y2: Y(yv) }));
    ax.append(s("text", { x: L - 6, y: Y(yv) + 4, "text-anchor": "end" }, (opts.yfmt || ((v) => k(v)))(yv)));
  }
  const days = (x1 - x0) / 86400e3;
  const step = days > 300 ? 60 : days > 100 ? 28 : days > 24 ? 14 : 7;
  const dl = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  let lastTick = x0;
  for (let t = x0; t <= x1 + 1; t += step * 86400e3) {
    ax.append(s("text", { x: X(t), y: H - 4, "text-anchor": t === x0 ? "start" : "middle" }, dl(t)));
    lastTick = t;
  }
  if (x1 - lastTick > step * 0.75 * 86400e3) ax.append(s("text", { x: X(x1), y: H - 4, "text-anchor": "end" }, dl(x1)));
  svg.append(g);
  if (opts.band) {
    svg.append(s("rect", { class: "band", x: L, width: W - L - R, y: Y(opts.band[1]), height: Math.max(1, Y(opts.band[0]) - Y(opts.band[1])) }));
    for (const b of opts.band) svg.append(s("line", { class: "bandline", x1: L, x2: W - R, y1: Y(b), y2: Y(b) }));
  }
  svg.append(ax);
  for (const p of opts.soft || []) svg.append(s("circle", { class: "dot soft", cx: X(p.x), cy: Y(p.y), r: 3 }));
  if (opts.kind === "bar") {
    for (const p of points) {
      const top = Y(Math.max(p.y, y0)), base = Y(y0);
      const r = Math.min(bw / 2, Math.max(0, base - top));
      svg.append(s("path", { class: "barm", d: `M${X(p.x) - bw / 2},${base} V${top + r} a${r},${r} 0 0 1 ${bw},0 V${base} Z` }));
    }
  } else {
    svg.append(s("path", { class: "line", d: points.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join(" ") }));
    if (points.length <= 40) for (const p of points) svg.append(s("circle", { class: "dot", cx: X(p.x), cy: Y(p.y), r: 3.5 }));
  }
  const cross = s("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
  svg.append(cross);
  const tip = $("tip");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(X(p.x) - px) < Math.abs(X(best.x) - px)) best = p;
    cross.setAttribute("x1", X(best.x)); cross.setAttribute("x2", X(best.x)); cross.setAttribute("visibility", "visible");
    tip.textContent = best.label;
    tip.hidden = false;
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, ev.clientX - tip.offsetWidth / 2));
    tip.style.left = `${tx}px`;
    tip.style.top = `${r.top + (Y(best.y) / H) * r.height - tip.offsetHeight - 12}px`;
  };
  const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave);
  wrap.append(svg);
  if (opts.legend) wrap.append(h("div", { class: "legend" }, opts.legend));
  const key = title;
  const tbtn = h("button", { class: "textbtn", type: "button" }, S.tables[key] ? "Hide the numbers" : "Show the numbers");
  tbtn.addEventListener("click", () => { S.tables[key] = !S.tables[key]; render(); });
  wrap.append(tbtn);
  if (S.tables[key]) {
    wrap.append(h("table", { class: "data" }, h("tr", null, h("th", null, "Date"), h("th", { class: "r" }, opts.unit || "Value")),
      points.slice().reverse().map((p) => h("tr", null, h("td", null, dayName(new Date(p.x).toISOString().slice(0, 10))), h("td", { class: "r" }, p.label.split(": ").pop())))));
  }
  return wrap;
}

function viewProgress(v) {
  const now = nowMs();
  const from = locDate(now - S.range * 86400e3);
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  v.append(h("section", { class: "sec controls" }, rangeChips()));
  const sl = sleepSection(from);
  if (sl) v.append(sl);
  const wh = waterHistorySection(from);
  if (wh) v.append(wh);

  // Training: hard sets per muscle over the last 7 days, against the target band.
  const sets = allSets();
  const wk = E.weeklySets(sets, S.EX, now);
  const [lo, hi] = S.snap.profile.weekly_sets_per_muscle || [10, 16];
  const max = Math.max(hi * 1.25, ...Object.values(wk));
  const groups = [["Chest", ["chest"]], ["Back", ["lats", "upper_back"]], ["Shoulders", ["front_delts", "side_delts", "rear_delts"]],
    ["Biceps", ["biceps"]], ["Triceps", ["triceps"]], ["Quads", ["quads"]], ["Hamstrings", ["hamstrings"]], ["Glutes", ["glutes"]], ["Calves", ["calves"]], ["Core", ["abs", "obliques"]]];
  const pct = (x) => `${Math.min(100, (x / max) * 100)}%`;
  v.append(section(h("div", null, h("h2", null, "Hard sets"), h("p", { class: "sub" }, "Last 7 days, per muscle")), null,
    h("div", { class: "list", style: "gap:12px" }, groups.map(([g, ms2]) => {
      const val = ms2.reduce((a, m) => a + (wk[m] || 0), 0) / ms2.length;
      return h("div", { class: "wk" }, h("span", null, g),
        h("div", { class: "track", role: "img", "aria-label": `${g} ${fmt(val, 1)} sets` },
          h("span", { class: "band", style: `left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})` }),
          h("span", { class: "fill", style: `width:${pct(val)}` })),
        h("span", { class: "v" }, fmt(val, 1)));
    })),
    h("div", { class: "legend" }, h("span", null, h("i", { class: "band" }), `${lo}–${hi} sets a week`)),
    h("p", { class: "tiny" }, "Secondary muscles count half a set; warm-ups don't count. Back, shoulders and core are averages of their parts.")));

  // Strength: estimated 1-rep max per session for one lift.
  const lifts = [...new Set(sets.filter((x) => S.EX[x.ex] && S.EX[x.ex].kind === "weight").map((x) => x.ex))]
    .map((id) => ({ id, n: E.history(sets, S.EX[id]).length })).sort((a, b) => b.n - a.n);
  if (!S.strengthEx || !lifts.some((l) => l.id === S.strengthEx)) S.strengthEx = lifts[0] && lifts[0].id;
  const sel = h("select", { class: "select", "aria-label": "Exercise" }, lifts.map((l) => h("option", { value: l.id, selected: l.id === S.strengthEx }, `${S.EX[l.id].name} (${l.n})`)));
  sel.addEventListener("change", () => { S.strengthEx = sel.value; render(); });
  const hist = S.strengthEx ? E.history(sets, S.EX[S.strengthEx]).filter((x) => x.date >= from) : [];
  v.append(section(h("div", null, h("h2", null, "Strength"), h("p", { class: "sub" }, "Estimated 1-rep max, kg")), null, lifts.length ? sel : null,
    chart(`Strength ${S.strengthEx}`, hist.map((x) => ({ x: ms(x.date), y: Math.round(x.best * 10) / 10,
      label: `${short(x.date)}: ${fmt(x.best, 1)} kg (${x.sets.map((y) => setLabel(S.strengthEx, y)).join(", ")})` })), {
      yfmt: (x) => fmt(x, 1), unit: "e1RM (kg)", empty: "No weighted lifts in this range.",
    }),
    h("p", { class: "tiny" }, "Epley formula, reps capped at 12. Dumbbell lifts: per dumbbell. Same weight with more reps counts as progress.")));
}

// ------------------------------------------------------------------ food
const FOOD = {
  kcal: { label: "Calories", unit: "kcal", band: (t) => t.kcal, f: (x) => k(x) },
  protein_g: { label: "Protein", unit: "g", band: (t) => t.protein_g, f: (x) => fmt(x) },
  carbs_g: { label: "Carbs", unit: "g", band: (t) => t.carbs_g, f: (x) => fmt(x) },
  fat_g: { label: "Fat", unit: "g", band: (t) => t.fat_g, f: (x) => fmt(x) },
  sat_fat_g: { label: "Sat fat", unit: "g", band: (t) => [0, t.sat_fat_g_max], cap: true, f: (x) => fmt(x, 1) },
  fibre_g: { label: "Fibre", unit: "g", band: (t) => [t.fibre_g_min, t.fibre_g_min], floor: true, f: (x) => fmt(x, 1) },
  veg_servings: { label: "Veg", unit: "serv", band: (t) => t.veg_servings, f: (x) => fmt(x, 1) },
};

function verdict(m, v, t) {
  const [lo, hi] = FOOD[m].band(t);
  if (FOOD[m].cap) return v > hi ? ["over", `${FOOD[m].f(v - hi)} over cap`] : ["in", "under cap"];
  if (FOOD[m].floor) return v < lo ? ["under", `${FOOD[m].f(lo - v)} short`] : ["in", "on plan"];
  if (v < lo) return ["under", `${FOOD[m].f(lo - v)} under`];
  if (v > hi) return ["over", `${FOOD[m].f(v - hi)} over`];
  return ["in", "on plan"];
}

function viewFood(v) {
  const t = S.snap.targets;
  const today = locDate();
  const range = S.foodRange || 28;
  const metric = S.foodMetric || "kcal";
  const from = addDays(today, -range);
  const fd = foodData();
  const all = fd.days;
  const days = all.filter((d) => d.date >= from && d.date < today); // complete days only
  const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
  v.append(h("section", { class: "sec controls" }, h("div", { class: "chips", role: "group", "aria-label": "Time range" },
    [[7, "7D"], [28, "4W"], [84, "12W"]].map(([d, l]) => h("button", {
      class: "chip", type: "button", "aria-pressed": String(range === d), onclick: () => { S.foodRange = d; render(); },
    }, l)))));

  if (!days.length) {
    v.append(section("Averages", null, h("p", { class: "empty" }, "No complete days in this range yet. Today counts from tomorrow.")));
  } else {
    const avg = (key) => days.reduce((a, d) => a + (d[key] || 0), 0) / days.length;
    const onPlan = days.filter((d) => d.kcal >= t.kcal[0] && d.kcal <= t.kcal[1] && d.protein_g >= t.protein_g[0]).length;
    const tile = (m) => {
      const val = avg(m);
      const [state, word] = verdict(m, val, t);
      return h("button", { class: "tile", type: "button", "aria-pressed": String(metric === m), onclick: () => { S.foodMetric = m; render(); } },
        h("span", { class: "caps" }, FOOD[m].label),
        h("b", null, FOOD[m].f(val), h("small", null, FOOD[m].unit)),
        h("span", { class: `trend state ${state}` }, state === "in" ? icon("check", "icon s") : icon(state === "over" ? "up" : "down", "icon s"), word));
    };
    const M = FOOD[metric];
    const band = M.band(t);
    v.append(section(h("div", null, h("h2", null, "Averages"),
      h("p", { class: "sub" }, `${days.length} complete day${days.length === 1 ? "" : "s"} · on plan ${onPlan} of ${days.length}`)), null,
      h("div", { class: "tiles" }, Object.keys(FOOD).map(tile),
        h("div", { class: "tile" }, h("span", { class: "caps" }, "On plan"), h("b", null, `${onPlan}`, h("small", null, `/ ${days.length} days`)),
          h("span", { class: "trend" }, "kcal and protein"))),
      chart(`Food ${metric}`, days.map((d) => ({ x: ms(d.date), y: Math.round((d[metric] || 0) * 10) / 10,
        label: `${short(d.date)}: ${M.f(d[metric] || 0)} ${M.unit}, ${d.meals} meal${d.meals === 1 ? "" : "s"}` })), {
        kind: "bar", band, zero: true, unit: M.unit, yfmt: (x) => (metric === "kcal" ? k(x) : fmt(x)),
        legend: [h("span", null, h("i", { class: "s1" }), `${M.label} per day`),
          h("span", null, h("i", { class: "band" }), M.cap ? `cap ${band[1]} ${M.unit}` : M.floor ? `at least ${band[0]} ${M.unit}` : `plan ${M.f(band[0])}–${M.f(band[1])} ${M.unit}`)],
      })));

    // Where the calories come from: average protein, carbs and fat, against the plan's split.
    const kc = { p: avg("protein_g") * 4, c: avg("carbs_g") * 4, f: avg("fat_g") * 9 };
    const tot = kc.p + kc.c + kc.f || 1;
    const mid = (r) => (r[0] + r[1]) / 2;
    const pk = { p: mid(t.protein_g) * 4, c: mid(t.carbs_g) * 4, f: mid(t.fat_g) * 9 };
    const ptot = pk.p + pk.c + pk.f;
    const pc = (x, n) => Math.round((x / n) * 100);
    const parts = [["p", "Protein", "cat1", avg("protein_g")], ["c", "Carbs", "cat2", avg("carbs_g")], ["f", "Fat", "cat3", avg("fat_g")]];
    v.append(section(h("div", null, h("h2", null, "Macro split"), h("p", { class: "sub" }, "Share of calories, daily average")), null,
      h("div", { class: "split", role: "img", "aria-label": parts.map(([key, l]) => `${l} ${pc(kc[key], tot)}%`).join(", ") },
        parts.map(([key, , cls]) => h("span", { class: cls, style: `flex:${kc[key]}` }))),
      h("div", { class: "legend" }, parts.map(([key, l, cls, g]) => h("span", null, h("i", { class: cls }), `${l} ${pc(kc[key], tot)}% · ${fmt(g)} g`))),
      h("p", { class: "tiny m" }, `Plan: protein ${pc(pk.p, ptot)}% · carbs ${pc(pk.c, ptot)}% · fat ${pc(pk.f, ptot)}%`)));
    v.append(satFatSection(fd.meals.filter((m) => m.date >= from && m.date < today), days.length, t));
  }
  v.append(regularsSection(fd.meals));

  // History: one row per day, newest first; open a day for its meals.
  const meals = fd.meals;
  const hist = all.filter((d) => d.date >= from).slice().reverse();
  const n = S.foodHistN || 14;
  const sec = section("History", null);
  if (!hist.length) sec.append(h("p", { class: "empty" }, "Nothing logged in this range."));
  else {
    sec.append(h("div", { class: "list" }, hist.slice(0, n).map((d) => {
      const dt = new Date(`${d.date}T12:00:00Z`);
      const okK = d.kcal >= t.kcal[0] && d.kcal <= t.kcal[1];
      const okP = d.protein_g >= t.protein_g[0];
      const dm = meals.filter((m) => m.date === d.date).sort((a, b) => (a.time < b.time ? -1 : 1));
      const isToday = d.date === today;
      const verdicts = isToday ? null : h("div", { class: "verdicts" },
        h("span", { class: `state ${okK ? "in" : d.kcal > t.kcal[1] ? "over" : "under"}` }, okK ? icon("check", "icon s") : null, okK ? "calories" : d.kcal > t.kcal[1] ? "calories high" : "calories low"),
        h("span", { class: `state ${okP ? "in" : "under"}` }, okP ? icon("check", "icon s") : null, okP ? "protein" : "protein low"));
      return h("div", { class: "entry wide" },
        h("span", { class: "when" }, dt.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }), h("br"), dt.toLocaleDateString("en-GB", { day: "2-digit", timeZone: "UTC" })),
        h("details", { class: "body" },
          h("summary", null,
            h("span", { class: "src" }, isToday ? "Today, so far" : `${d.meals} meal${d.meals === 1 ? "" : "s"}`),
            h("div", { class: "ttl" }, `${fmt(d.kcal)} kcal`),
            h("div", { class: "meta" },
              h("span", null, `${fmt(d.protein_g)}P`), h("span", null, `${fmt(d.carbs_g)}C`), h("span", null, `${fmt(d.fat_g)}F`),
              h("span", null, `${fmt(d.veg_servings, 1)} veg`)),
            verdicts),
          h("ul", { class: "meals-in" }, dm.length ? dm.map((m) => h("li", null, h("button", { class: "mealline", type: "button", onclick: () => mealSheet(m) },
            h("span", { class: "m" }, m.time), h("span", null, m.desc),
            h("span", { class: "m" }, `${fmt(m.kcal)} · ${fmt(m.protein_g)}P`)))) : h("li", null, "Meal details older than the app's history aren't loaded."))));
    })));
    if (hist.length > n) sec.append(h("button", { class: "textbtn", type: "button", onclick: () => { S.foodHistN = n + 14; render(); } }, `Show ${Math.min(14, hist.length - n)} more days`));
  }
  v.append(sec);
}


// Where the sat fat comes from: food groups found in the meal descriptions, and
// the biggest single meals. A meal can fall in more than one group.
const SAT_GROUPS = [
  ["Coconut milk dishes", /laksa|curry|lemak|santan|coconut|rendang|lontong/i],
  ["Cheese, butter and cream", /cheese|butter|ghee|cream|mayo|carbonara|alfredo/i],
  ["Fatty and processed meats", /belly|bacon|sausage|char ?siu|lard|luncheon|spam|ribs|wagyu|brisket|salami|ham\b|pork/i],
  ["Fried food", /fried|tempura|katsu|cutlet|goreng|crispy|nugget|fries|prata|you ?tiao/i],
  ["Red meat", /beef|steak|lamb|mutton|burger/i],
  ["Milk drinks and desserts", /milk|latte|kopi|teh|ice cream|chocolate|cake|pastry|croissant|bubble tea|cookie|kaya/i],
  ["Eggs", /egg/i],
  ["Chicken with skin", /thigh|wing|skin|drumstick|chicken rice/i],
  ["Oily fish", /salmon|mackerel|saba|sashimi|unagi/i],
];

function satFatSection(meals, nDays, t) {
  const total = meals.reduce((a, m) => a + (m.sat_fat_g || 0), 0);
  if (!total) return null;
  const groups = SAT_GROUPS.map(([label, re]) => {
    const hits = meals.filter((m) => re.test(m.desc || ""));
    return { label, n: hits.length, g: hits.reduce((a, m) => a + (m.sat_fat_g || 0), 0) };
  }).filter((x) => x.n).sort((a, b) => b.g - a.g).slice(0, 5);
  const top = meals.slice().sort((a, b) => (b.sat_fat_g || 0) - (a.sat_fat_g || 0)).slice(0, 5);
  const max = Math.max(...groups.map((x) => x.g), 1);
  return section(h("div", null, h("h2", null, "Sat fat sources"),
    h("p", { class: "sub" }, `${fmt(total / Math.max(nDays, 1), 1)} g a day against a cap of ${t.sat_fat_g_max} g`)), null,
    h("div", { class: "list", style: "gap:12px" }, groups.map((x) => h("div", { class: "wk", style: "grid-template-columns:150px 1fr 64px" },
      h("span", null, x.label),
      h("div", { class: "track", role: "img", "aria-label": `${x.label} ${fmt(x.g)} g` }, h("span", { class: "fill", style: `width:${(x.g / max) * 100}%` })),
      h("span", { class: "v" }, `${Math.round((x.g / total) * 100)}%`)))),
    h("p", { class: "caps" }, "Biggest single meals"),
    h("div", { class: "list" }, top.map((m) => mealRow(m, { dated: true, sat: true }))),
    h("p", { class: "tiny" }, "Groups come from the words in each meal's description, and a meal can count in more than one. Percentages are shares of all the sat fat logged in the range."));
}

// Meals you log often, one tap to log again.
function regularsSection(meals) {
  const norm = (x) => String(x || "").toLowerCase().replace(/\([^)]*\)|~|\d+(\.\d+)?\s*(g|ml|pcs?|slices?)\b/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  const counts = new Map();
  for (const m of meals) {
    const key = norm(m.desc);
    if (!key) continue;
    const c = counts.get(key) || { n: 0, m };
    c.n += 1;
    if (m.date >= c.m.date) c.m = m;
    counts.set(key, c);
  }
  const regs = [...counts.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 6);
  return section(h("div", null, h("h2", null, "Log a meal"), h("p", { class: "sub" }, regs.length ? "Your regulars, or add one by hand" : "Add one by hand, or send it to the health bot")),
    h("button", { class: "pillbtn", type: "button", onclick: () => editMealSheet({ desc: "" }, true) }, icon("plus", "icon s"), "Add"),
    regs.length ? h("div", { class: "list" }, regs.map((c) => h("button", { class: "entry wide mealbtn", type: "button", onclick: () => mealSheet(c.m) },
      h("span", { class: "when" }, `${c.n}×`),
      h("div", { class: "body" }, h("span", { class: "note", style: "color:var(--ink)" }, c.m.desc),
        h("div", { class: "meta" }, h("span", null, `${fmt(c.m.kcal)} kcal`), h("span", null, `${fmt(c.m.protein_g)}P`), h("span", null, `${fmt(c.m.sat_fat_g, 1)} sat`)))))) : null,
    h("p", { class: "tiny" }, "Photos and descriptions still go to the health bot, which estimates better. Logging here uses the numbers you give."));
}

// ------------------------------------------------------------------ boot
async function load() {
  if ($("status")) $("status").textContent = "Loading…";
  let lib;
  let data;
  try {
    [lib, data] = await Promise.all([fetch("library.json").then((r) => r.json()), api("/api/data")]);
    lsSet(LS_CACHE, { at: nowMs(), lib, data });
    S.offlineAt = null;
  } catch (e) {
    const c = lsGet(LS_CACHE, null);
    if (!c || /unauthorised|private/i.test(e.message)) throw e;
    ({ lib, data } = c);
    S.offlineAt = c.at;
  }
  S.lib = lib;
  S.EX = E.index(lib);
  S.snap = data.snap;
  if (S.snap && S.snap.tz) E.setTimeZone(S.snap.tz);
  S.queue = data.queue || [];
  S.apple = data.apple || null;
  S.appleLog = data.appleLog || [];
  S.oura = data.oura || null;
  S.ouraState = data.ouraState || null;
  S.pet = data.pet || null;
  // Changes still waiting on the phone show as pending until they're sent.
  for (const x of lsGet(LS_OUTBOX, [])) if (!S.queue.some((q) => q.id === x.item.id)) S.queue.push(x.item);
  if (!S.offlineAt) flushOutbox().then((n) => { if (n) render(); }).catch(() => {});
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LS_DRAFT) || "null"); } catch { /* ignore */ }
  // The newer of the phone's copy and the server's copy wins (a phone can be closed mid-save).
  S.draft = [local, data.draft].filter(Boolean).sort((a, b) => (b.saved || 0) - (a.saved || 0))[0] || null;
  if (S.draft && S.draft.date !== locDate() && nowMs() - S.draft.started > 12 * 3600e3) S.draft = null;
  $("tabs").hidden = false;
  $("foot").hidden = false;
  if (S.draft) S.tab = "train";
  setTab(S.tab);
}

// Telegram's light or dark theme, as in the Money and trip apps (not the phone's own
// setting); Telegram's bar matches the band, the page behind the app follows the theme.
const BAND = { light: "#5a1f3d", dark: "#4a1832" };
function applyTheme() {
  if (!tg || !tg.colorScheme) return;
  const scheme = tg.colorScheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.scheme = scheme;
  try {
    if (tg.isVersionAtLeast && tg.isVersionAtLeast("6.1")) {
      tg.setHeaderColor(BAND[scheme]);
      tg.setBackgroundColor("secondary_bg_color");
    }
  } catch { /* older clients */ }
}

function boot() {
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceWith(icon(el.dataset.icon));
  $("sheet-x").append(icon("close"));
  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    try { tg.onEvent("themeChanged", applyTheme); } catch { /* older clients */ }
  }
  const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
  for (const b of tabs) {
    b.addEventListener("click", () => setTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => { // arrow keys move between tabs
      const j = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!j) return;
      const n = tabs[(tabs.indexOf(b) + j + tabs.length) % tabs.length];
      n.focus();
      setTab(n.dataset.tab);
    });
  }
  $("sheet-x").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  // Coming back to the app mid-rest: the timer is worked out from timestamps, so just redraw it.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.draft) renderDock(); });
  $("refresh").addEventListener("click", () => load().catch(fail));
  // Back online: send what waited on the phone, then reload.
  window.addEventListener("online", () => { flushOutbox().then(() => load()).catch(() => {}); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* not available in this webview */ });
  if (!tg || !tg.initData) {
    $("status").textContent = "Open this from the health bot in Telegram.";
    return;
  }
  load().catch(fail);
}

function fail(e) {
  const msg = /private/i.test(e.message) ? "This app is private to its owner."
    : /unauthorised/i.test(e.message) ? "Your Telegram sign-in has expired. Close the app and open it again from the chat."
      : `Couldn't load: ${e.message}`;
  $("view").replaceChildren(h("p", { class: "status" }, msg));
}

boot();
