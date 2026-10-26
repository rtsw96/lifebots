// Secretary app: pure functions over the calendar, sleep and workouts. No DOM, no
// network: the views call these, and test/model.test.mjs runs them in node.
//
// Every time is the owner's local time, in the timezone from settings.json (pushed
// by secretary/sync.py; setZone() sets it, Asia/Singapore until then). A day is
// local midnight to midnight. Who owns a minute, in this order: sleep (bed to wake,
// from the health bot's logs, when it is installed), then workouts, then calendar
// events by start time. What's left is "Unplanned". Events of 20 hours or more
// (trips like "Away — Lisbon", all-day items) are context for the day, not hours.
// "Free" (transparent) and declined events show but don't count.

const H = 3600e3;
export const CATS = ["sleep", "work", "social", "exercise", "travel", "health", "learning", "fun", "errands", "personal", "free"];
export const LABELS = { sleep: "Sleep", work: "Work", social: "Social", exercise: "Exercise", travel: "Travel", health: "Health",
  learning: "Learning", fun: "Fun", errands: "Errands", personal: "Personal", free: "Unplanned", holiday: "Holiday" };
const SPAN_MS = 20 * H;
const pad = (n) => String(n).padStart(2, "0");

// ------------------------------------------------------------------ timezone
export const DEFAULT_ZONE = "Asia/Singapore";
let ZONE = DEFAULT_ZONE;
let FMT = null;
const OFFS = new Map();

/** Use an IANA timezone ("Europe/London"); an unknown one falls back to the default. */
export function setZone(z) {
  let next = DEFAULT_ZONE;
  if (typeof z === "string" && z) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: z }); next = z; } catch { /* unknown: keep the default */ }
  }
  if (next !== ZONE) { ZONE = next; FMT = null; OFFS.clear(); }
  return ZONE;
}
export const zone = () => ZONE;

/** The zone's offset from UTC, in ms, at the instant `ms` (daylight saving included). */
export function offsetAt(ms) {
  const k = Math.floor(ms / 900e3);
  const hit = OFFS.get(k);
  if (hit !== undefined) return hit;
  FMT = FMT || new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  const off = wall - (ms - (((ms % 1000) + 1000) % 1000));
  if (OFFS.size > 20000) OFFS.clear();
  OFFS.set(k, off);
  return off;
}

// ------------------------------------------------------------------ dates
export const localDate = (ms) => new Date(ms + offsetAt(ms)).toISOString().slice(0, 10);
export const localMin = (ms) => { const d = new Date(ms + offsetAt(ms)); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** The instant of a local date and "HH:MM" in the owner's zone. */
export function localMs(date, hhmm = "00:00") {
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}
export const dayStart = (date) => localMs(date, "00:00");
const dayEnd = (date) => dayStart(addDays(date, 1));
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 24 * H).toISOString().slice(0, 10);
/** 0 = Monday ... 6 = Sunday */
export const dow = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const weekStart = (date) => addDays(date, -dow(date));
export const hm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
export const toMin = (s) => (typeof s === "string" && /^\d{1,2}:\d{2}/.test(s) ? Number(s.slice(0, s.indexOf(":"))) * 60 + Number(s.slice(s.indexOf(":") + 1, s.indexOf(":") + 3)) : null);
export const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

// ------------------------------------------------------------------ rules
export function compile(rules) {
  const list = [];
  for (const r of (rules && rules.rules) || []) {
    try { list.push({ cat: r.cat, re: new RegExp(r.match, "i") }); } catch { /* a bad pattern is skipped, not fatal */ }
  }
  return { list, def: (rules && rules.default) || "personal", labels: { ...LABELS, ...((rules && rules.labels) || {}) } };
}

export function categorise(ev, R) {
  if (ev.cal === "h") return "holiday";
  const text = `${ev.title || ""} ${ev.loc || ""}`;
  for (const r of R.list) if (r.re.test(text)) return CATS.includes(r.cat) ? r.cat : R.def;
  return R.def;
}

/** Calendar items with start/end in ms, a category, and whether they count as hours. */
export function prep(items, R) {
  const out = [];
  for (const ev of items || []) {
    const s = ev.allDay ? dayStart(ev.start) : Date.parse(ev.start);
    const e = ev.allDay ? dayStart(ev.end) : Date.parse(ev.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const span = ev.allDay || e - s >= SPAN_MS;
    const cat = categorise(ev, R);
    out.push({ ...ev, s, e, cat, span, counts: !span && !ev.free && !ev.declined && cat !== "holiday" });
  }
  return out.sort((a, b) => a.s - b.s || b.e - a.e);
}

// ------------------------------------------------------------------ one day
function sleepNight(health, date) {
  const d = health && health.days && health.days[date];
  if (!d || !(d.sleep_h > 0)) return null;
  let wake = toMin(d.wake);
  let bed = toMin(d.bed);
  let est = false;
  if (wake == null || bed == null) { // hours only: place them before a usual 08:30 wake
    wake = 510;
    bed = (wake - Math.round(d.sleep_h * 60) + 1440) % 1440;
    est = true;
  }
  return { date, bed, wake, h: d.sleep_h, est, prevDay: bed > wake };
}

/**
 * One day, minute by minute. Returns totals (minutes per category), blocks for a
 * timeline, the day's context (away, holiday), and its sleep.
 */
export function dayPlan(date, P, health) {
  const t0 = dayStart(date);
  const t1 = dayEnd(date);
  const slot = new Array(1440).fill(null);
  const blocks = [];
  const fill = (s, e, cat, block) => {
    let n = 0;
    for (let i = Math.max(0, s); i < Math.min(1440, e); i++) if (slot[i] == null) { slot[i] = cat; n++; }
    if (n && block) blocks.push({ ...block, s: Math.max(0, s), e: Math.min(1440, e), cat });
    return n;
  };
  // sleep: the night ending this morning, and tonight if bed is before midnight
  const night = sleepNight(health, date);
  if (night) fill(night.prevDay ? 0 : night.bed, night.wake, "sleep", { kind: "sleep", title: `Sleep ${night.h.toFixed(1)} h`, est: night.est });
  const tonight = sleepNight(health, addDays(date, 1));
  if (tonight && tonight.prevDay) fill(tonight.bed, 1440, "sleep", { kind: "sleep", title: "To bed", est: tonight.est });
  // workouts
  for (const w of (health && health.workouts) || []) {
    if (w.date !== date) continue;
    const s = toMin(w.start);
    const e = toMin(w.end) ?? (s != null ? s + (w.min || 60) : null);
    if (s != null) fill(s, e > s ? e : s + (w.min || 60), "exercise", { kind: "workout", title: w.name || "Workout" });
  }
  // calendar
  let away = null;
  let holiday = null;
  const events = [];
  for (const ev of P) {
    if (ev.e <= t0 || ev.s >= t1) continue;
    if (ev.cat === "holiday") { holiday = ev.title; continue; }
    if (ev.span) { if (ev.cat === "travel") away = away || ev.title; events.push(ev); continue; }
    events.push(ev);
    if (!ev.counts) continue;
    const s = Math.round((Math.max(ev.s, t0) - t0) / 60e3);
    const e = Math.round((Math.min(ev.e, t1) - t0) / 60e3);
    fill(s, e, ev.cat, { kind: "event", title: ev.title, ev });
  }
  const totals = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const c of slot) totals[c || "free"] += 1;
  blocks.sort((a, b) => a.s - b.s);
  return { date, totals, blocks, events, away, holiday, sleep: night, tracked: Boolean(night) };
}

// ------------------------------------------------------------------ weeks
const late = (bed, by) => bed != null && by != null && bed > by && bed < 12 * 60; // after the bedtime, before noon
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** A week from Monday `ws`: per-day plans, totals, sleep and exercise against the targets, and plain-language notes. */
export function weekSummary(ws, P, health, targets, today) {
  const ds = days(ws, 7);
  const plans = ds.map((d) => dayPlan(d, P, health));
  const past = plans.filter((p) => p.date <= today);
  const totals = Object.fromEntries(CATS.map((c) => [c, sum(plans.map((p) => p.totals[c]))]));
  const nights = past.map((p) => p.sleep).filter(Boolean);
  const avgSleep = nights.length ? sum(nights.map((n) => n.h)) / nights.length : null;
  const byMin = toMin((targets && targets.bed_by) || "00:30");
  const lateN = nights.filter((n) => !n.est && late(n.bed, byMin)).length;
  const workouts = ((health && health.workouts) || []).filter((w) => w.date >= ws && w.date <= ds[6]);
  const exH = sum(workouts.map((w) => w.min || 0)) / 60;
  const wk = (targets && targets.weekly_h) || {};
  const done = past.length === 7;
  const notes = [];
  const T = targets || {};
  if (avgSleep != null && T.sleep_h_per_night) {
    const gap = avgSleep - T.sleep_h_per_night;
    notes.push({ tone: gap >= -0.25 ? "good" : "warn", text: `Sleep averaged ${avgSleep.toFixed(1)} h over ${nights.length} nights${gap >= -0.25 ? ", on target" : `, ${(-gap).toFixed(1)} h under your ${T.sleep_h_per_night} h`}.` });
  } else if (!nights.length && past.length) notes.push({ tone: "info", text: "No sleep data this week yet." });
  if (lateN) notes.push({ tone: lateN >= 3 ? "warn" : "info", text: `${lateN} ${lateN === 1 ? "night" : "nights"} in bed after ${T.bed_by || "00:30"}.` });
  if (wk.exercise != null) {
    const ok = exH >= wk.exercise;
    notes.push({ tone: ok ? "good" : done ? "warn" : "info", text: `Exercise: ${workouts.length} ${workouts.length === 1 ? "session" : "sessions"}, ${exH.toFixed(1)} h of ${wk.exercise} h${ok ? " ✓" : ""}.` });
  }
  if (wk.social != null) {
    const sh = totals.social / 60;
    notes.push({ tone: sh >= wk.social ? "good" : "info", text: `Social: ${sh.toFixed(1)} h planned of ${wk.social} h.` });
  }
  const busiest = plans.map((p) => ({ d: p.date, m: sum(CATS.filter((c) => c !== "sleep" && c !== "free" && c !== "exercise").map((c) => p.totals[c])) })).sort((a, b) => b.m - a.m)[0];
  if (busiest && busiest.m >= 120) notes.push({ tone: "info", text: `Busiest day: ${dayLabel(busiest.d)}, ${(busiest.m / 60).toFixed(1)} h in the calendar.` });
  if (totals.work) notes.push({ tone: "info", text: `Work in the calendar: ${(totals.work / 60).toFixed(1)} h across ${plans.flatMap((p) => p.blocks).filter((b) => b.cat === "work").length} events.` });
  return { ws, days: plans, totals, avgSleep, nights: nights.length, late: lateN, workouts, exH, notes, partial: !done };
}

/** Weekly hours per category for the `n` weeks ending with the week of `today`. */
export function trend(P, health, targets, today, n = 12) {
  const last = weekStart(today);
  return Array.from({ length: n }, (_, i) => weekSummary(addDays(last, -7 * (n - 1 - i)), P, health, targets, today));
}

// ------------------------------------------------------------------ planning
/** Busy intervals on a date, in minutes from midnight (counted events only). */
function busy(date, P) {
  const t0 = dayStart(date);
  const t1 = dayEnd(date);
  return P.filter((ev) => ev.counts && ev.e > t0 && ev.s < t1)
    .map((ev) => [Math.max(0, Math.round((ev.s - t0) / 60e3)), Math.min(1440, Math.round((ev.e - t0) / 60e3))])
    .sort((a, b) => a[0] - b[0]);
}

const awayOn = (date, P) => {
  const t0 = dayStart(date) + 12 * H; // midday: a trip ending at 22:40 still makes the day "away"
  return P.some((ev) => ev.span && ev.cat === "travel" && ev.s <= t0 && ev.e > t0);
};

export const PARTS = { any: null, morning: [480, 720], afternoon: [720, 1080], evening: [1080, 1350] };

/**
 * Open slots of at least `minutes`, from `nowMs` over `n` days, inside the awake
 * window (and a part of the day if given), skipping days away. Starts on the quarter hour.
 */
export function freeSlots(P, nowMs, { minutes = 60, n = 14, part = "any", window = ["08:00", "22:30"], perDay = 3, max = 12 } = {}) {
  const today = localDate(nowMs);
  const [w0, w1] = [toMin(window[0]) ?? 480, toMin(window[1]) ?? 1350];
  const p = PARTS[part];
  const out = [];
  for (const date of days(today, n)) {
    if (awayOn(date, P)) continue;
    let from = p ? Math.max(w0, p[0]) : w0;
    const to = p ? Math.min(w1, p[1]) : w1;
    if (date === today) from = Math.max(from, Math.ceil((localMin(nowMs) + 15) / 15) * 15);
    let k = 0;
    for (const [s, e] of [...busy(date, P), [to, to]]) {
      if (s - from >= minutes && from < to) {
        out.push({ date, s: from, e: Math.min(s, to) });
        if (++k >= perDay) break;
      }
      from = Math.max(from, e);
      if (from >= to) break;
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** Evenings (18:30-22:00) with nothing in the calendar, over the next `n` days. */
export function freeEvenings(P, nowMs, n = 14) {
  return days(localDate(nowMs), n).filter((d) => !awayOn(d, P) && !busy(d, P).some(([s, e]) => e > 1110 && s < 1320));
}

/** Upcoming items grouped by day: everything from now to `n` days on. */
export function agenda(P, nowMs, n = 14) {
  const today = localDate(nowMs);
  return days(today, n).map((date) => {
    const t0 = dayStart(date);
    const t1 = dayEnd(date);
    // a trip or all-day item that started before this day shows once, on today
    const items = P.filter((ev) => ev.e > Math.max(t0, nowMs) && ev.s < t1 && !(ev.span && ev.s < t0 && date !== today));
    return { date, items };
  }).filter((d) => d.items.length);
}

// ------------------------------------------------------------------ words
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayLabel = (date) => `${DOW[dow(date)]} ${Number(date.slice(8, 10))} ${MON[Number(date.slice(5, 7)) - 1]}`;
export const shortDay = (date) => `${Number(date.slice(8, 10))} ${MON[Number(date.slice(5, 7)) - 1]}`;
export const dowLabel = (date) => DOW[dow(date)];
export const hours = (min) => (min >= 600 ? `${Math.round(min / 60)}h` : min >= 60 ? `${(min / 60).toFixed(1).replace(/\.0$/, "")}h` : `${min}m`);
