// Apple Health data from the Health Auto Export iPhone app (REST API automation).
// Pure functions: the Worker calls summarise() on each post and merge() into KV.
//
// Payload: {data: {metrics: [{name, units, data: [...]}], workouts: [{name, start, end, ...}]}}
// Times look like "2026-10-09 19:35:00 +0800" (or 12-hour, sometimes with a
// narrow no-break space before AM/PM). Workout extras arrive as {qty, units}.
// Only summaries are kept: no routes, no GPS, no per-minute heart rate. With
// "Include Workout Metrics" on, a workout also carries its per-minute heart rate
// (heartRateData); it is read once here, matched against the set times the app
// logged (stamps), and reduced to each exercise's average and max. The minutes
// themselves are never stored.

const KEEP_DAYS = 400;

/** "2026-10-09 7:35:00 PM +0800" -> {ms, date: "2026-10-09", time: "19:35"} in the time's own offset. */
export function parseTime(v) {
  if (typeof v !== "string") return null;
  const dateOnly = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/); // aggregated sleep in export version 2
  if (dateOnly) return { ms: Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]), date: v.trim(), time: "00:00" };
  const m = v.replace(/[  ]/g, " ").trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  let hh = Number(m[4]);
  if (m[7]) {
    const pm = /p/i.test(m[7]);
    if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12;
  }
  const off = (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], hh, +m[5], +(m[6] || 0)) - off * 60000;
  return { ms, date: `${m[1]}-${m[2]}-${m[3]}`, time: `${String(hh).padStart(2, "0")}:${m[5]}` };
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

function qty(field) {
  if (field == null) return null;
  if (typeof field === "object") return { v: num(field.qty), u: String(field.units || "").toLowerCase() };
  return { v: num(field), u: "" };
}

/** Energy to kcal (kJ / Cal / kcal). */
export function kcal(field) {
  const q = qty(field);
  if (!q || q.v == null) return null;
  return q.u === "kj" ? q.v / 4.184 : q.v;
}

/** Distance to km (km / mi / m / yd). */
export function km(field) {
  const q = qty(field);
  if (!q || q.v == null) return null;
  if (q.u === "mi") return q.v * 1.609344;
  if (q.u === "m") return q.v / 1000;
  if (q.u === "yd") return q.v * 0.0009144;
  return q.v;
}

function kg(v, u) {
  if (v == null) return null;
  return /lb/.test(u) ? v * 0.45359237 : v;
}

const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** One workout, reduced to what the app shows. */
export function workout(w) {
  if (!w || typeof w.name !== "string") return null;
  const st = parseTime(w.start), en = parseTime(w.end);
  if (!st || !en || en.ms <= st.ms) return null;
  const pick = (...keys) => { for (const key of keys) if (w[key] != null) return w[key]; return null; };
  const hr = (f) => { const q = qty(f); return q && q.v != null ? Math.round(q.v) : null; };
  return {
    id: `${st.date}T${st.time.replace(":", "")}-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    name: w.name.slice(0, 60), date: st.date, start: st.time, end: en.time,
    min: Math.round((en.ms - st.ms) / 60000),
    kcal: round(kcal(pick("activeEnergyBurned", "activeEnergy")), 0),
    km: round(km(pick("distance")), 2),
    avg_hr: hr(pick("avgHeartRate", "heartRate")) ?? (w.heartRate && typeof w.heartRate === "object" && w.heartRate.avg ? hr(w.heartRate.avg) : null),
    max_hr: hr(pick("maxHeartRate")) ?? (w.heartRate && typeof w.heartRate === "object" && w.heartRate.max ? hr(w.heartRate.max) : null),
  };
}

// ---------------------------------------------------------------- heart rate per exercise
const SET_WORK_S = 45;  // a set of reps takes about this long; a hold takes its own seconds
const AFTER_SET_S = 30; // heart rate peaks just after the set, so the window runs on a little

/** heartRateData -> [{ms, avg, max}] per minute (Health Auto Export version 2: {date, Avg, Max}
 *  or {date, qty}). */
export function hrSamples(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const t = p && parseTime(p.date);
    const avg = p && num(p.Avg ?? p.avg ?? p.qty);
    if (!t || avg == null || avg < 25 || avg > 250) continue;
    const max = num(p.Max ?? p.max);
    out.push({ ms: t.ms, avg, max: max != null && max >= avg && max <= 250 ? max : avg });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** Each exercise's average and max heart rate over its sets: a set runs from (tick - its
 *  work time) to (tick + 30 s), and a minute's reading counts when it overlaps that.
 *  sets = [{ex, at, sec}] from the app's live workout. -> {ex: {avg, max}} or null. */
export function exerciseHr(samples, sets) {
  if (!samples.length || !Array.isArray(sets)) return null;
  const by = {};
  for (const s of sets) {
    if (!s || typeof s.ex !== "string" || !num(s.at)) continue;
    const lo = s.at - (num(s.sec) || SET_WORK_S) * 1000, hi = s.at + AFTER_SET_S * 1000;
    const hit = by[s.ex] = by[s.ex] || new Set();
    samples.forEach((m, i) => { if (m.ms < hi && m.ms + 60000 > lo) hit.add(i); });
  }
  const out = {};
  for (const [ex, hit] of Object.entries(by)) {
    if (!hit.size) continue;
    const ms = [...hit].map((i) => samples[i]);
    out[ex] = { avg: Math.round(ms.reduce((a, m) => a + m.avg, 0) / ms.length), max: Math.round(Math.max(...ms.map((m) => m.max))) };
  }
  return Object.keys(out).length ? out : null;
}

/** The app workout whose sets fall inside this Watch workout (give or take 10 minutes). */
export function stampFor(w, stamps) {
  const st = parseTime(w.start), en = parseTime(w.end);
  if (!st || !en) return null;
  let best = null, bestN = 0;
  for (const s of Array.isArray(stamps) ? stamps : []) {
    const n = (s.sets || []).filter((x) => x.at >= st.ms - 600000 && x.at <= en.ms + 600000).length;
    if (n > bestN) { best = s; bestN = n; }
  }
  return best;
}

// Daily metrics: totals are summed per day, levels averaged, sleep taken per night.
const SUM = { step_count: "steps", active_energy: "active_kcal", apple_exercise_time: "exercise_min", walking_running_distance: "walk_km" };
const AVG = { resting_heart_rate: "resting_hr", heart_rate_variability: "hrv_ms", body_mass: "weight_kg" };

/** Daily summaries from the metrics list: {date: {steps, active_kcal, ...}}. */
export function days(metrics) {
  const out = {};
  const acc = {};
  const day = (d) => (out[d] = out[d] || {});
  for (const m of Array.isArray(metrics) ? metrics : []) {
    if (!m || !Array.isArray(m.data)) continue;
    const u = String(m.units || "").toLowerCase();
    if (SUM[m.name]) {
      const key = SUM[m.name];
      for (const p of m.data) {
        const t = parseTime(p.date);
        let v = num(p.qty);
        if (!t || v == null) continue;
        if (key === "active_kcal" && u === "kj") v /= 4.184;
        if (key === "walk_km") v = km({ qty: v, units: u });
        day(t.date)[key] = (out[t.date][key] || 0) + v;
      }
    } else if (AVG[m.name]) {
      const key = AVG[m.name];
      for (const p of m.data) {
        const t = parseTime(p.date);
        let v = num(p.qty ?? p.Avg ?? p.avg);
        if (!t || v == null) continue;
        if (key === "weight_kg") v = kg(v, u);
        const a = (acc[`${t.date}|${key}`] = acc[`${t.date}|${key}`] || { s: 0, n: 0 });
        a.s += v; a.n += 1;
        day(t.date)[key] = a.s / a.n;
      }
    } else if (m.name === "sleep_analysis") {
      for (const p of m.data) {
        const t = parseTime(p.date) || parseTime(p.sleepEnd) || parseTime(p.endDate);
        if (!t) continue;
        const asleep = num(p.totalSleep ?? p.asleep);
        if (asleep != null) {
          // Aggregated per night (hours): asleep, deep, rem, core, inBed.
          const d = day(t.date);
          d.sleep_h = (d.sleep_h || 0) + asleep;
          for (const [k, src] of [["deep_h", "deep"], ["rem_h", "rem"]]) if (num(p[src]) != null) d[k] = (d[k] || 0) + num(p[src]);
          const s = parseTime(p.sleepStart), e = parseTime(p.sleepEnd);
          if (s) d.bed = s.time;
          if (e) d.wake = e.time;
        } else if (p.value && !/awake|in ?bed/i.test(p.value)) {
          // Unaggregated stages: add up the asleep stages, counted on the day they end.
          const s = parseTime(p.startDate), e = parseTime(p.endDate);
          if (!s || !e) continue;
          day(e.date).sleep_h = (out[e.date].sleep_h || 0) + (e.ms - s.ms) / 3600e3;
        }
      }
    }
  }
  for (const d of Object.values(out)) {
    for (const [k, v] of Object.entries(d)) if (typeof v === "number") d[k] = k === "steps" ? Math.round(v) : round(v, k.endsWith("_h") ? 2 : 1);
  }
  return out;
}

/** Everything worth keeping from one post. stamps (optional): the set times of recent
 *  app workouts, to work out heart rate per exercise. */
export function summarise(payload, stamps) {
  const data = (payload && payload.data) || payload || {};
  const workouts = [];
  for (const raw of Array.isArray(data.workouts) ? data.workouts : []) {
    const w = workout(raw);
    if (!w) continue;
    const stamp = raw.heartRateData && stampFor(raw, stamps);
    const hr = stamp && exerciseHr(hrSamples(raw.heartRateData), stamp.sets);
    if (hr) { w.app = stamp.wid; w.hr_ex = hr; }
    workouts.push(w);
  }
  return { workouts, days: days(data.metrics) };
}

/** Merge a post into what's stored. A day's figures from a newer post replace
 *  the older ones (each post carries whole days), metric by metric. */
export function merge(stored, add, todayIso) {
  const out = { workouts: { ...((stored && stored.workouts) || {}) }, days: { ...((stored && stored.days) || {}) } };
  for (const w of add.workouts) {
    const old = out.workouts[w.id];
    // a later post without workout metrics keeps the heart rate per exercise worked out earlier
    out.workouts[w.id] = !w.hr_ex && old && old.hr_ex ? { ...w, app: old.app, hr_ex: old.hr_ex } : w;
  }
  for (const [d, v] of Object.entries(add.days)) out.days[d] = { ...(out.days[d] || {}), ...v };
  const cut = new Date(Date.parse(`${todayIso}T00:00:00Z`) - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
  for (const [id, w] of Object.entries(out.workouts)) if (w.date < cut) delete out.workouts[id];
  for (const d of Object.keys(out.days)) if (d < cut) delete out.days[d];
  return out;
}
