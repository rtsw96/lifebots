// Secretary app logic: node --test secretary/app/test/*.test.mjs (no browser, no network)
// Uses the made-up fixture (test/fixture.mjs), built around today, and the repo's rules file.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as M from "../public/model.js";
import { fixture } from "./fixture.mjs";

const d = fixture();
const R = M.compile(d.rules);
const P = M.prep(d.events.items, R);
const TODAY = d.today;
const NOW = d.nowMs; // 10:30 today
const day = (n) => M.addDays(TODAY, n);
const at = (date, hhmm) => new Date(M.localMs(date, hhmm)).toISOString();
const ev = (title, start, end, extra = {}) => ({ id: title, cal: "p", title, start, end, allDay: false, ...extra });

test("dates are local days in the owner's zone, weeks start on Monday", () => {
  M.setZone("Asia/Singapore");
  assert.equal(M.localDate(Date.parse(`${TODAY}T23:30:00+08:00`)), TODAY);
  assert.equal(M.localDate(Date.parse(`${TODAY}T16:30:00Z`)), day(1)); // 00:30 the next day in Singapore
  const ws = M.weekStart(TODAY);
  assert.equal(M.dow(ws), 0);
  assert.equal(M.weekStart(ws), ws);
  assert.equal(M.weekStart(day(6 - M.dow(TODAY))), ws); // Sunday belongs to the same week
  assert.match(M.dayLabel(TODAY), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/);
  assert.equal(M.hm(615), "10:15");
  assert.equal(M.toMin("07:05"), 425);
});

test("another timezone, with daylight saving, is honoured", () => {
  try {
    assert.equal(M.setZone("Europe/London"), "Europe/London");
    const y = TODAY.slice(0, 4);
    // summer (BST, UTC+1) and winter (GMT, UTC+0)
    assert.equal(M.localMs(`${y}-07-01`, "09:00"), Date.parse(`${y}-07-01T08:00:00Z`));
    assert.equal(M.localMs(`${y}-01-15`, "09:00"), Date.parse(`${y}-01-15T09:00:00Z`));
    assert.equal(M.localMin(Date.parse(`${y}-07-01T08:00:00Z`)), 9 * 60);
    assert.equal(M.localDate(Date.parse(`${y}-07-01T23:30:00Z`)), `${y}-07-02`);
    assert.equal(M.setZone("Not/AZone"), M.DEFAULT_ZONE); // an unknown zone falls back
  } finally {
    M.setZone(M.DEFAULT_ZONE);
  }
});

test("the template rules sort common kinds of event", () => {
  const cat = (t, x = {}) => M.categorise({ title: t, ...x }, R);
  assert.equal(cat("XY123 Home → Lisbon"), "travel");
  assert.equal(cat("Away — Lisbon"), "travel");
  assert.equal(cat("Flight to Bangkok"), "travel");
  assert.equal(cat("Team stand-up"), "work");
  assert.equal(cat("Client call"), "work");
  assert.equal(cat("Weekly 1:1"), "work");
  assert.equal(cat("Q3 2026 planning"), "personal"); // not mistaken for a flight number
  assert.equal(cat("Lunch — a friend"), "social");
  assert.equal(cat("Housewarming — Chloe"), "social");
  assert.equal(cat("Concert in the park"), "fun");
  assert.equal(cat("Dental check-up"), "health");
  assert.equal(cat("Spanish class"), "learning");
  assert.equal(cat("Gym"), "exercise");
  assert.equal(cat("Haircut appointment"), "errands");
  assert.equal(cat("Pay bills at the bank"), "errands");
  assert.equal(cat("Something else"), "personal");
  assert.equal(M.categorise({ title: "Public Holiday", cal: "h" }, R), "holiday");
  // a broken pattern in the rules file is skipped, not fatal
  assert.equal(M.categorise({ title: "Lunch" }, M.compile({ rules: [{ cat: "work", match: "(" }, { cat: "social", match: "lunch" }] })), "social");
  // the user's own words: a rule added on top wins
  const mine = M.compile({ ...d.rules, rules: [{ cat: "work", match: "\\bacme\\b" }, ...d.rules.rules] });
  assert.equal(M.categorise({ title: "Acme quarterly lunch" }, mine), "work");
});

test("a day: sleep first, then workouts, then events; overlaps never double count", () => {
  const D = day(-4);
  const items = [ev("Dinner — A", at(D, "19:00"), at(D, "22:00")),
    ev("Drinks — B", at(D, "21:00"), at(D, "23:30")),
    ev("Gym", at(D, "07:00"), at(D, "08:00")),
    ev("Skipped", at(D, "12:00"), at(D, "13:00"), { declined: true }),
    ev("Reminder", at(D, "14:00"), at(D, "15:00"), { free: true })];
  const health = { days: { [D]: { sleep_h: 6.5, bed: "00:30", wake: "07:30" }, [day(-3)]: { sleep_h: 7, bed: "23:45", wake: "07:00" } },
    workouts: [{ date: D, start: "07:15", end: "08:00", name: "Run", min: 45 }] };
  const p = M.dayPlan(D, M.prep(items, R), health);
  assert.equal(p.totals.sleep, 420 + 15); // 00:30-07:30, plus 23:45-24:00 tonight
  assert.equal(p.totals.exercise, 30); // the run from 07:30 (in bed until then); the "Gym" event adds nothing on top
  assert.equal(p.totals.social, 180 + 90); // dinner 19:00-22:00, then drinks to 23:30: the overlap counts once
  assert.equal(p.totals.personal, 0); // declined and "free" events don't count
  assert.equal(Object.values(p.totals).reduce((a, b) => a + b, 0), 1440);
  assert.ok(p.blocks.every((b, i) => i === 0 || p.blocks[i - 1].s <= b.s));
});

test("without the health bot (no sleep or workouts) a day still adds up", () => {
  const p = M.dayPlan(TODAY, P, { days: {}, workouts: [] });
  assert.equal(p.totals.sleep, 0);
  assert.equal(p.tracked, false);
  assert.equal(Object.values(p.totals).reduce((a, b) => a + b, 0), 1440);
  const w = M.weekSummary(M.addDays(M.weekStart(TODAY), -7), P, undefined, d.targets, TODAY);
  assert.ok(w.notes.some((n) => n.text === "No sleep data this week yet."));
});

test("trips are context, not hours; holidays are named", () => {
  const p = M.dayPlan(day(-37), P, d.health);
  assert.equal(p.away, "Away — Lisbon");
  assert.equal(p.totals.travel, 0); // the trip itself isn't 24 hours of travel
  const flight = M.dayPlan(day(-38), P, d.health);
  assert.ok(flight.totals.travel >= 140 - 1);
  assert.equal(M.dayPlan(day(28), P, d.health).holiday, "Public Holiday");
});

test("hours-only sleep is placed before a usual wake and marked as an estimate", () => {
  const D = day(-10);
  const p = M.dayPlan(D, [], { days: { [D]: { sleep_h: 7 } } });
  assert.equal(p.totals.sleep, 420);
  assert.ok(p.sleep.est);
  assert.ok(p.blocks.some((b) => b.est));
});

test("a week adds up, compares with the targets and says so in words", () => {
  const last = M.addDays(M.weekStart(TODAY), -7);
  const w = M.weekSummary(last, P, d.health, d.targets, TODAY);
  assert.equal(w.days.length, 7);
  assert.equal(Object.values(w.totals).reduce((a, b) => a + b, 0), 7 * 1440);
  assert.equal(w.partial, false);
  assert.ok(w.notes.some((n) => /^Sleep averaged/.test(n.text)));
  assert.ok(w.notes.some((n) => /^Exercise: /.test(n.text)));
  const next = M.weekSummary(M.addDays(M.weekStart(TODAY), 7), P, d.health, d.targets, TODAY);
  assert.equal(next.partial, true);
  assert.equal(next.nights, 0); // no future nights
  assert.equal(M.trend(P, d.health, d.targets, TODAY, 12).length, 12);
});

test("open slots: inside the awake window, after now, not on top of events, not while away", () => {
  const slots = M.freeSlots(P, NOW, { minutes: 60, n: 14 });
  assert.ok(slots.length > 0);
  for (const sl of slots) {
    assert.ok(sl.e - sl.s >= 60 && sl.s >= 480 && sl.e <= 1350, JSON.stringify(sl));
    const t0 = M.dayStart(sl.date) + sl.s * 60e3;
    const t1 = M.dayStart(sl.date) + sl.e * 60e3;
    assert.ok(!P.some((e) => e.counts && e.s < t1 && e.e > t0), `clash at ${sl.date} ${M.hm(sl.s)}`);
    assert.ok(sl.s % 15 === 0);
  }
  assert.ok(slots[0].date >= TODAY);
  assert.ok(slots.filter((s) => s.date === TODAY).every((s) => s.s >= 10 * 60 + 45));
  // the Lisbon trip days are skipped
  const trip = M.freeSlots(P, M.localMs(day(-38), "06:00"), { minutes: 60, n: 5 });
  assert.ok(!trip.some((s) => s.date >= day(-38) && s.date <= day(-35)));
  const evening = M.freeSlots(P, NOW, { minutes: 120, part: "evening" });
  assert.ok(evening.every((s) => s.s >= 1080));
  assert.ok(M.freeEvenings(P, NOW, 14).every((x) => x >= TODAY));
  assert.ok(!M.freeEvenings(P, NOW, 14).includes(day(5))); // the housewarming
});

test("the agenda starts now and shows a trip once", () => {
  const ag = M.agenda(P, NOW, 14);
  assert.ok(ag[0].date >= TODAY);
  assert.ok(ag.flatMap((x) => x.items).every((e) => e.e > NOW));
  const tripView = M.agenda(P, M.localMs(day(-37), "09:00"), 4);
  assert.equal(tripView.flatMap((x) => x.items).filter((e) => e.id === "trip1").length, 1);
});
