// A made-up 12 weeks of calendar, sleep, workouts and claims for the Secretary app's
// tests and preview screenshots, built around "today" so nothing goes stale.
// Every title, name and number is invented. "Now" is 10:30 on the day of `nowMs`
// in the model's timezone (Asia/Singapore unless setZone() changed it).
//
//   import { fixture } from "./fixture.mjs";
//   const d = fixture();            // what /api/data would return
//   d.now, d.today                  // the fixture's clock (ms) and date
import { readFileSync } from "node:fs";

import * as M from "../public/model.js";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url)));

/** A small seeded random generator (mulberry32), so every run builds the same data. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random: next, choice: (xs) => xs[Math.floor(next() * xs.length)], uniform: (lo, hi) => lo + (hi - lo) * next() };
}

const iso = (date, hhmm) => new Date(M.localMs(date, hhmm)).toISOString();

export function fixture(nowMs = Date.now()) {
  const R = rng(11);
  const TODAY = M.localDate(nowMs);
  const NOW = M.localMs(TODAY, "10:30");
  const day = (n) => M.addDays(TODAY, n);
  const items = [];
  const ev = (date, start, minutes, title, extra = {}) => {
    const s = M.localMs(date, start);
    items.push({ id: `e${String(items.length).padStart(4, "0")}`, cal: "p", title, start: new Date(s).toISOString(),
      end: new Date(s + minutes * 60e3).toISOString(), allDay: false, ...extra });
  };

  for (let i = -84; i <= 21; i++) {
    const d = day(i);
    const wd = M.dow(d);
    if (i >= -38 && i <= -35) continue; // away on the trip below
    if (wd < 5) {
      const n = R.choice([0, 1, 1, 2, 3]);
      for (let k = 0; k < n; k++) {
        ev(d, R.choice(["09:30", "10:00", "11:00", "14:00", "15:30", "16:00"]), R.choice([30, 45, 60]),
          R.choice(["Team stand-up", "Project review", "Client call", "Weekly 1:1"]), R.random() < 0.4 ? { loc: "Online" } : {});
      }
    }
    if (R.random() < 0.28) ev(d, "12:15", 75, R.choice(["Lunch — Sam", "Lunch — Leo", "Lunch with the team"]));
    if (R.random() < 0.3 && [3, 4, 5].includes(wd)) ev(d, "19:00", 150, R.choice(["Dinner — Ana & Ben", "Dinner — old friends", "Drinks — Mei"]));
    if (wd === 5 && R.random() < 0.5) ev(d, "10:00", 120, "Spanish class");
    if (Number(d.slice(8, 10)) === 13) ev(d, "14:00", 60, "Pay credit card bills", { free: true });
  }

  // a trip, fixed one-offs, a holiday, an app-made event
  items.push({ id: "trip1", cal: "p", title: "Away — Lisbon", start: iso(day(-38), "09:40"), end: iso(day(-35), "22:40"), allDay: false });
  ev(day(-38), "09:40", 140, "XY123 Home → Lisbon");
  ev(day(-35), "20:30", 140, "XY124 Lisbon → Home");
  ev(day(2), "18:30", 90, "Haircut appointment");
  ev(day(5), "19:00", 180, "Housewarming — Chloe");
  ev(day(10), "12:00", 60, "Lunch — Kai");
  ev(day(12), "10:00", 60, "Dental check-up");
  ev(day(3), "07:30", 60, "Run club", { mine: true });
  ev(day(1), "10:00", 60, "Quarterly planning (declined)", { declined: true });
  items.push({ id: "hol1", cal: "h", title: "Public Holiday", start: day(28), end: day(29), allDay: true });

  // sleep and workouts (as the health bot would push them)
  const days = {};
  const workouts = [];
  for (let i = -84; i <= 0; i++) {
    const d = day(i);
    if ((i + 84) % 9 !== 4) {
      const bed = R.choice(["23:10", "23:40", "00:15", "22:50", "00:30", "23:55"]);
      const h = Math.round(R.uniform(5.8, 8.4) * 10) / 10;
      const wm = (M.toMin(bed) + Math.round(h * 60) + 20) % 1440;
      days[d] = { sleep_h: h, bed, wake: M.hm(wm), src: "oura" };
    }
    if ([0, 2, 4].includes(M.dow(d)) && (i + 84) % 5 !== 0) {
      const s = R.choice(["07:00", "18:30", "19:30"]);
      const m = R.choice([45, 55, 60, 70]);
      workouts.push({ date: d, start: s, end: M.hm(M.toMin(s) + m), name: R.choice(["Strength Training", "Indoor Run", "Cycling"]), min: m });
    }
  }

  // claims, in the home currency (SGD here); fx is home currency per unit
  const C = [
    [-38, "Taxi to the airport", 32.4, "SGD", 1, "transport", "Lisbon trip", "paid", -31, -16],
    [-37, "Hotel, 3 nights", 420, "EUR", 1.45, "hotel", "Lisbon trip", "paid", -31, -16],
    [-36, "Client dinner", 96, "EUR", 1.45, "client", "Lisbon trip", "paid", -31, -16],
    [-7, "Grab", 182000, "VND", 0.0000496, "transport", "Hanoi trip", "submitted", -3, null],
    [-6, "Pho 24", 450000, "VND", 0.0000495, "meal", "Hanoi trip", "submitted", -3, null],
    [-2, "Lunch with a client", 86.5, "SGD", 1, "client", "", "to_claim", null, null],
    [-1, "Mobile plan (work share)", 45, "SGD", 1, "phone", "", "to_claim", null, null],
  ];
  const rows = C.map(([n, merchant, amt, ccy, fx, cat, trip, status, sub, paid], i) => ({
    id: `${day(n).replace(/-/g, "")}-${i.toString(16).padStart(6, "0")}`, date: day(n), merchant, description: "", category: cat,
    amount: amt.toFixed(2), currency: ccy, fx: fx.toFixed(6), home: (amt * fx).toFixed(2), trip, status,
    submitted_on: sub == null ? "" : day(sub), paid_on: paid == null ? "" : day(paid), receipt: i % 3 ? "app" : "",
    added_at: iso(day(n), "20:00"), note: "" }));
  const by_status = {};
  const by_trip = {};
  const r2 = (x) => Math.round(x * 100) / 100;
  for (const r of rows) {
    by_status[r.status] = r2((by_status[r.status] || 0) + Number(r.home));
    const t = (by_trip[r.trip || "(no trip)"] ||= { count: 0, home: 0, open: 0 });
    t.count += 1;
    t.home = r2(t.home + Number(r.home));
    if (["to_claim", "submitted"].includes(r.status)) t.open = r2(t.open + Number(r.home));
  }

  return {
    ok: true, now: new Date(NOW).toISOString(), today: TODAY, nowMs: NOW,
    events: { fetched_at: new Date(NOW - 60e3).toISOString(), items: items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)) },
    health: { days, workouts, updated_at: new Date(NOW - 5400e3).toISOString() },
    rules: read("../../categories.json"),
    targets: read("../../targets.json"),
    google: { ready: true, connected: true, status: { ok: true }, error: null },
    settings: { timezone: M.zone(), currency: "SGD", holidays: "" },
    claims: { rows, summary: { by_status, by_trip, open_trip: "", currency: "SGD" },
      categories: ["meal", "transport", "hotel", "flight", "client", "phone", "supplies", "other"] },
  };
}
