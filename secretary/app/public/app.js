// Secretary app (Telegram Mini App for the secretary bot). Five tabs:
//   Today   the day hour by hour, what's next, the next two weeks
//   Week    where a week's hours went, against your targets, in plain words
//   Trends  twelve weeks of planned hours by kind, and sleep night by night
//   Plan    find open time (by length and part of the day), free evenings, add an event
//   Claims  expense claims from receipts sent to the bot: to claim, submitted, paid; each receipt
// The Worker reads Google Calendar directly; sleep and workouts (from the health
// bot, when installed), claims and settings (timezone, home currency) come from the
// repo (secretary/sync.py). All text goes in through text nodes (h()), never HTML.

import { h, card, chips, segmented, note, openSheet, closeSheet, wireSheet, icon, plural, andList } from "./ui.js";
import * as M from "./model.js";
import { dayStrip, weekGrid, stackedBars, donut, targetBars, sleepLine, catColor } from "./charts.js";

const tg = (window.Telegram && window.Telegram.WebApp) || (() => {
  const raw = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
  return raw ? { initData: raw, ready() {}, expand() {}, openLink: (u) => window.open(u, "_blank", "noopener") } : null;
})();
const $ = (id) => document.getElementById(id);
const S = { data: null, tab: "today", cur: "SGD", st: { week: 0, dur: 60, part: "any", cst: "open", ctrip: "all" } };
const TABS = ["today", "week", "trends", "plan", "claims"];
const AWAKE = M.CATS.filter((c) => c !== "sleep" && c !== "free");

async function api(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, initData: tg ? tg.initData : "" }) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const openLink = (url) => (tg && tg.openLink ? tg.openLink(url) : window.open(url, "_blank", "noopener"));

/** Everything the views need, worked out once per render. */
function context() {
  const d = S.data;
  const R = M.compile(d.rules);
  const nowMs = Date.now();
  return {
    d, R, nowMs, today: M.localDate(nowMs), nowMin: M.localMin(nowMs),
    P: M.prep((d.events && d.events.items) || [], R),
    health: d.health || { days: {}, workouts: [] },
    targets: d.targets || { sleep_h_per_night: 7.5, bed_by: "23:30", weekly_h: {} },
    w: Math.max(288, Math.min(680, document.documentElement.clientWidth || 390) - 24),
  };
}

const label = (c, R) => (R && R.labels[c]) || M.LABELS[c] || c;
const legend = (cats, R) => h("div", { class: "legend", "aria-hidden": "true" }, cats.map((c) => h("span", null, h("i", { class: "sw", style: { background: catColor(c) } }), label(c, R))));
const stat = (l, v, sub, cls = "") => h("div", { class: `stat ${cls}` }, h("span", { class: "stat-l" }, l), h("b", { class: "num" }, v), sub ? h("small", null, sub) : null);
const when = (ev) => (ev.allDay ? "All day" : `${M.hm(M.localMin(ev.s))}–${M.hm(M.localMin(ev.e))}`);

// ------------------------------------------------------------------ today
function connectCard(c) {
  const g = c.d.google || {};
  if (g.connected) return g.error ? note(`Couldn't reach Google just now (${g.error}). Showing the last copy.`, "warn") : null;
  return card("Connect Google Calendar", { sub: "One tap, then approve in the browser" },
    h("p", { class: "small" }, "The app reads your calendar straight from Google and can add events to it. It keeps titles and times only: no descriptions, links or guest lists. It can move or delete only the events it made."),
    g.ready
      ? h("button", { type: "button", class: "btn", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await api("/api/google/start"); openLink(r.url); waitForGoogle(); } catch (err) { status(err.message); }
        e.currentTarget.disabled = false;
      } }, "Connect Google Calendar")
      : note("The Google keys aren't set up on the server yet: see secretary/README.md."));
}

function eventRow(ev, c) {
  const sub = ev.span ? (ev.cat === "travel" ? `Away until ${M.dayLabel(M.localDate(ev.e - 1))}` : "All day") : when(ev);
  return h("button", { type: "button", class: `row ev${ev.counts || ev.span ? "" : " dim"}`, onclick: () => eventSheet(ev, c) },
    h("i", { class: "bar", style: { background: ev.cat === "holiday" ? "var(--muted)" : catColor(ev.cat) } }),
    h("span", { class: "l" }, h("b", null, ev.cat === "holiday" ? `🎌 ${ev.title}` : ev.title),
      h("span", null, [sub, ev.cat === "holiday" ? "Public holiday" : label(ev.cat, c.R), ev.loc].filter(Boolean).join(" · "))),
    ev.mine ? h("span", { class: "tag" }, "Added here") : null);
}

function viewToday(c) {
  const out = [connectCard(c)];
  const plan = M.dayPlan(c.today, c.P, c.health);
  const next = c.P.find((ev) => ev.counts && ev.s > c.nowMs);
  const nowEv = c.P.find((ev) => ev.counts && ev.s <= c.nowMs && ev.e > c.nowMs);
  const inCal = AWAKE.reduce((a, k) => a + (k === "exercise" ? 0 : plan.totals[k]), 0);
  const restToday = plan.blocks.filter((b) => b.kind === "event" && b.e > c.nowMin);
  const freeTill = next && M.localDate(next.s) === c.today ? M.hm(M.localMin(next.s)) : null;
  const sleep = plan.sleep;
  out.push(card(null, { cls: "hero", label: "Today" },
    h("p", { class: "eyebrow" }, `Today · ${M.dayLabel(c.today)}${plan.holiday ? ` · ${plan.holiday}` : ""}`),
    nowEv ? h("p", { class: "big-t" }, h("small", null, "Now"), nowEv.title)
      : next ? h("p", { class: "big-t" }, h("small", null, M.localDate(next.s) === c.today ? `Next at ${M.hm(M.localMin(next.s))}` : `Next: ${M.dayLabel(M.localDate(next.s))}, ${M.hm(M.localMin(next.s))}`), next.title)
        : h("p", { class: "big-t" }, h("small", null, "Next"), "Nothing in the calendar"),
    dayStrip(plan.blocks, { w: c.w - 32, now: c.nowMin, label: `Today hour by hour: ${plan.blocks.map((b) => `${b.title} ${M.hm(b.s)}`).join(", ") || "nothing planned"}`, onBlock: (b) => eventSheet(b.ev, c) }),
    legend(M.CATS.filter((k) => k !== "free" && plan.totals[k] > 0), c.R),
    h("div", { class: "stats" },
      stat("In the calendar", M.hours(inCal), restToday.length ? `${plural(restToday.length, "thing")} still to come` : "nothing left today"),
      stat("Free until", freeTill || (nowEv ? M.hm(M.localMin(nowEv.e)) : "tonight"), freeTill ? "next event" : null),
      stat("Last night", sleep ? `${sleep.h.toFixed(1)}h` : "–", sleep ? (sleep.est ? "hours only" : `${M.hm(sleep.bed)}–${M.hm(sleep.wake)}`) : "no sleep data")),
    h("button", { type: "button", class: "btn", onclick: () => addSheet(c, { date: c.today }) }, icon("plus"), "Add to calendar")));

  const ag = M.agenda(c.P, c.nowMs, 14);
  out.push(card("Coming up", { sub: "The next two weeks" },
    ag.length ? h("div", { class: "agenda" }, ag.map((day) => h("div", { class: "day" },
      h("p", { class: "day-h" }, day.date === c.today ? "Today" : day.date === M.addDays(c.today, 1) ? "Tomorrow" : M.dayLabel(day.date)),
      h("div", { class: "rows" }, day.items.map((ev) => eventRow(ev, c))))))
      : h("p", { class: "empty" }, (c.d.google || {}).connected ? "Nothing in the next two weeks." : "Connect Google Calendar to see it here.")));
  return out;
}

// ------------------------------------------------------------------ week
function weekRows(sum, c) {
  return sum.days.map((p) => ({
    label: M.dowLabel(p.date), date: p.date, blocks: p.blocks, away: p.away, dim: p.date > c.today, on: p.date === c.today,
    aria: `${M.dayLabel(p.date)}: ${AWAKE.filter((k) => p.totals[k]).map((k) => `${label(k, c.R)} ${M.hours(p.totals[k])}`).join(", ") || "nothing planned"}`,
  }));
}

function viewWeek(c) {
  const st = S.st;
  const ws = M.addDays(M.weekStart(c.today), -7 * st.week);
  const sum = M.weekSummary(ws, c.P, c.health, c.targets, c.today);
  const T = c.targets;
  const awake = AWAKE.filter((k) => sum.totals[k] > 0);
  const planned = awake.reduce((a, k) => a + sum.totals[k], 0);
  const out = [];
  out.push(h("div", { class: "controls" }, chips([0, 1, 2, 3].map((i) => [String(i), i === 0 ? "This week" : i === 1 ? "Last week" : `${i} weeks ago`]), String(st.week),
    (v) => { st.week = Number(v); render(); }, "Week", "scroll")));
  out.push(card(null, { cls: "hero", label: "The week" },
    h("p", { class: "eyebrow" }, `Week of ${M.dayLabel(ws)}${sum.partial ? " · so far" : ""}`),
    h("p", { class: "big num" }, M.hours(planned), h("small", null, "planned, besides sleep")),
    h("div", { class: "stats" },
      stat("Sleep", sum.avgSleep != null ? `${sum.avgSleep.toFixed(1)}h` : "–", sum.nights ? `avg of ${plural(sum.nights, "night")}` : "no data", sum.avgSleep != null && sum.avgSleep < (T.sleep_h_per_night || 0) - 0.25 ? "warn" : ""),
      stat("Exercise", `${sum.exH.toFixed(1)}h`, plural(sum.workouts.length, "session")),
      stat("Social", M.hours(sum.totals.social), null),
      stat("Work", M.hours(sum.totals.work), null)),
    weekGrid(weekRows(sum, c), { w: c.w - 32, onRow: (r) => daySheet(r.date, c) }),
    legend(["sleep", ...awake], c.R),
    note("Tap a day for its hours. Grey is unplanned or untracked; light blocks are sleep hours without bed and wake times.")));

  const tgt = T.weekly_h || {};
  const rows = [];
  if (T.sleep_h_per_night) rows.push({ label: "Sleep a night", value: (sum.avgSleep || 0) * 60, target: T.sleep_h_per_night * 60, color: catColor("sleep"), right: sum.avgSleep != null ? `${sum.avgSleep.toFixed(1)} of ${T.sleep_h_per_night}h` : "no data" });
  for (const [k, v] of Object.entries(tgt)) {
    const val = k === "exercise" ? sum.exH * 60 : sum.totals[k] || 0;
    rows.push({ label: label(k, c.R), value: val, target: v * 60, color: catColor(k), right: `${M.hours(val)} of ${v}h`, cls: val >= v * 60 ? "pos" : "" });
  }
  out.push(card("Against your targets", { sub: sum.partial ? "This week so far" : "The full week" },
    rows.length ? targetBars(rows) : h("p", { class: "empty" }, "No targets set."),
    h("ul", { class: "notes" }, sum.notes.map((n) => h("li", { class: n.tone }, h("i", { "aria-hidden": "true" }), n.text))),
    note("Targets live in secretary/targets.json; tell the bot to change them.")));

  if (awake.length) {
    out.push(card("Where the awake hours went", { sub: "Planned time and workouts, by kind" },
      donut(awake.map((k) => ({ key: k, label: label(k, c.R), value: sum.totals[k], color: catColor(k) })), { label: "Planned hours by kind", center: "planned" })));
  }
  return out;
}

function daySheet(date, c) {
  const p = M.dayPlan(date, c.P, c.health);
  openSheet(h("h2", { id: "sheet-title" }, M.dayLabel(date)),
    h("p", { class: "tiny" }, [p.away ? `Away: ${p.away}` : null, p.holiday].filter(Boolean).join(" · ") || "Hour by hour"),
    dayStrip(p.blocks, { w: Math.min(640, c.w) - 8, label: `${M.dayLabel(date)} hour by hour`, now: date === c.today ? c.nowMin : null }),
    p.blocks.length ? h("div", { class: "rows" }, p.blocks.map((b) => h(b.ev ? "button" : "div", { type: b.ev ? "button" : null, class: "row ev", onclick: b.ev ? () => eventSheet(b.ev, c) : null },
      h("i", { class: "bar", style: { background: catColor(b.cat) } }),
      h("span", { class: "l" }, h("b", null, b.title), h("span", null, `${M.hm(b.s)}–${b.e >= 1440 ? "24:00" : M.hm(b.e)} · ${label(b.cat, c.R)}`)),
      h("span", { class: "r num" }, M.hours(b.e - b.s)))))
      : h("p", { class: "empty" }, "Nothing tracked or planned."),
    h("table", { class: "data" }, h("tbody", null, M.CATS.filter((k) => p.totals[k]).map((k) => h("tr", null, h("th", { scope: "row" }, label(k, c.R)), h("td", { class: "r num" }, M.hours(p.totals[k])))))));
}

// ------------------------------------------------------------------ trends
function viewTrends(c) {
  const weeks = M.trend(c.P, c.health, c.targets, c.today, 12);
  const series = AWAKE.filter((k) => weeks.some((w) => w.totals[k] > 0)).map((k) => ({ key: k, label: label(k, c.R), color: catColor(k) }));
  const cols = weeks.map((w, i) => ({ key: String(weeks.length - 1 - i), label: M.shortDay(w.ws).replace(/ \w+$/, ""), sub: i === weeks.length - 1 ? "now" : "",
    aria: `Week of ${M.dayLabel(w.ws)}`, values: Object.fromEntries(series.map((se) => [se.key, w.totals[se.key]])) }));
  const full = weeks.filter((w) => !w.partial);
  const avg = (f) => (full.length ? full.reduce((a, w) => a + f(w), 0) / full.length : 0);
  const out = [];
  out.push(card("Planned hours per week", { sub: "Twelve weeks, by kind. Tap a week to open it." },
    stackedBars(cols, series, { w: c.w - 32, label: "Planned hours per week by kind", sel: String(S.st.week), onSelect: (k) => { S.st.week = Number(k); setTab("week"); } }),
    legend(series.map((se) => se.key), c.R)));

  const nights = M.days(M.addDays(c.today, -27), 28).map((d) => {
    const n = c.health.days && c.health.days[d];
    return [M.shortDay(d).replace(/ \w+$/, ""), n && n.sleep_h ? n.sleep_h : null];
  });
  const got = nights.filter((n) => n[1] != null);
  out.push(card("Sleep, night by night", { sub: got.length ? `Last 4 weeks · ${got.length} nights with data · avg ${(got.reduce((a, n) => a + n[1], 0) / got.length).toFixed(1)}h` : "Last 4 weeks" },
    got.length ? sleepLine(nights, { w: c.w - 32, target: c.targets.sleep_h_per_night }) : h("p", { class: "empty" }, "No sleep data in the last 4 weeks. It comes from Oura or Apple Health through the health bot, if you use it."),
    got.length ? note("The dashed line is your target. Red dots are nights more than 15 minutes short.") : null));

  const T = c.targets.weekly_h || {};
  const rows = [
    { label: "Exercise", value: avg((w) => w.exH * 60), target: (T.exercise || 0) * 60, color: catColor("exercise") },
    { label: "Social", value: avg((w) => w.totals.social), target: (T.social || 0) * 60, color: catColor("social") },
    { label: "Work in the calendar", value: avg((w) => w.totals.work), color: catColor("work") },
    { label: "Unplanned awake", value: avg((w) => w.totals.free), color: "var(--axis)" },
  ].map((r) => ({ ...r, right: `${M.hours(Math.round(r.value))}${r.target ? ` of ${M.hours(r.target)}` : ""}` }));
  out.push(card("A typical week", { sub: full.length ? `Average of ${plural(full.length, "full week")}` : "Needs a full week of data" },
    targetBars(rows),
    note("Unplanned awake time includes nights with no sleep data, so it reads high until sleep is tracked every night.")));
  return out;
}

// ------------------------------------------------------------------ plan
function viewPlan(c) {
  const st = S.st;
  const out = [connectCard(c)];
  const slots = M.freeSlots(c.P, c.nowMs, { minutes: st.dur, part: st.part, window: c.targets.awake_window || ["08:00", "22:30"] });
  out.push(card("Find time", { sub: "Open slots in the next two weeks, skipping days away" },
    h("div", { class: "controls" },
      segmented([[30, "30m"], [60, "1h"], [120, "2h"], [180, "3h"]], st.dur, (v) => { st.dur = v; render(); }, "Length"),
      chips([["any", "Any time"], ["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"]], st.part, (v) => { st.part = v; render(); }, "Part of the day", "scroll")),
    slots.length ? h("div", { class: "rows" }, slots.map((sl) => h("button", { type: "button", class: "row slot", onclick: () => addSheet(c, { date: sl.date, start: M.hm(sl.s), minutes: st.dur }) },
      h("span", { class: "l" }, h("b", null, `${sl.date === c.today ? "Today" : M.dayLabel(sl.date)} · ${M.hm(sl.s)}`), h("span", null, `Open until ${sl.e >= 1440 ? "midnight" : M.hm(sl.e)} · ${M.hours(sl.e - sl.s)} free`)),
      h("span", { class: "r" }, icon("plus")))))
      : h("p", { class: "empty" }, "No open slot of that length. Try a shorter one or another part of the day."),
    note("Tap a slot to add something there.")));

  const ev = M.freeEvenings(c.P, c.nowMs, 14);
  out.push(card("Free evenings", { sub: "Nothing from 18:30 to 22:00, next two weeks" },
    ev.length ? h("div", { class: "chips" }, ev.map((d) => h("button", { type: "button", class: "chip", onclick: () => addSheet(c, { date: d, start: "19:00", minutes: 120 }) }, d === c.today ? "Tonight" : M.dayLabel(d))))
      : h("p", { class: "empty" }, "Every evening has something in it."),
    ev.length ? note(`${plural(ev.length, "free evening")} out of 14. Tap one to plan it.`) : null));

  out.push(h("button", { type: "button", class: "btn", onclick: () => addSheet(c, { date: c.today }) }, icon("plus"), "Add to calendar"));
  return out;
}

// ------------------------------------------------------------------ claims
const STATUS = { to_claim: "To claim", submitted: "Submitted", paid: "Paid", rejected: "Rejected" };
/** An amount in the home currency (settings.json), e.g. "SGD 9.03" or "£9.03". */
const money = (x) => {
  try { return Number(x).toLocaleString("en-GB", { style: "currency", currency: S.cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch { return `${S.cur} ${Number(x).toFixed(2)}`; }
};
const WHOLE = ["JPY", "KRW", "VND", "IDR"];
const orig = (r) => `${r.currency} ${Number(r.amount).toLocaleString("en-GB", { maximumFractionDigits: WHOLE.includes(r.currency) ? 0 : 2, minimumFractionDigits: WHOLE.includes(r.currency) ? 0 : 2 })}`;

function viewClaims(c) {
  const st = S.st;
  const cl = c.d.claims || { rows: [], summary: { by_status: {}, by_trip: {} } };
  const rows = [...(cl.rows || [])].reverse();
  const sum = cl.summary || { by_status: {}, by_trip: {} };
  const year = c.today.slice(0, 4);
  const paidYear = rows.filter((r) => r.status === "paid" && (r.paid_on || "").startsWith(year)).reduce((a, r) => a + Number(r.home), 0);
  const out = [];
  out.push(card(null, { cls: "hero", label: "Claims" },
    h("p", { class: "eyebrow" }, `Expense claims${sum.open_trip ? ` · on a trip: ${sum.open_trip}` : ""}`),
    h("p", { class: "big num" }, money(sum.by_status.to_claim || 0), h("small", null, "to claim")),
    h("div", { class: "stats" },
      stat("Submitted", money(sum.by_status.submitted || 0), "waiting to be paid"),
      stat(`Paid in ${year}`, money(paidYear), null),
      stat("Receipts", String(rows.length), plural(rows.filter((r) => r.receipt).length, "image"))),
    note("Send a receipt to the secretary bot to log it; ask it for a claim pack when you're ready to submit.")));
  if (!rows.length) return out;

  const trips = Object.entries(sum.by_trip || {}).filter(([t]) => t !== "(no trip)");
  if (st.ctrip !== "all" && !trips.some(([t]) => t === st.ctrip)) st.ctrip = "all";
  if (trips.length) {
    out.push(card("By trip", { sub: "Open means not yet paid" },
      h("div", { class: "rows" }, trips.map(([t, v]) => h("button", { type: "button", class: "row", onclick: () => { st.ctrip = st.ctrip === t ? "all" : t; render(); } },
        h("span", { class: "l" }, h("b", null, t), h("span", null, `${plural(v.count, "receipt")}${t === sum.open_trip ? " · open now" : ""}`)),
        h("span", { class: "r num" }, money(v.home), h("small", null, v.open ? `${money(v.open)} open` : "all paid")))))));
  }
  const pick = rows.filter((r) => (st.cst === "all" || (st.cst === "open" ? ["to_claim", "submitted"].includes(r.status) : r.status === st.cst))
    && (st.ctrip === "all" || r.trip === st.ctrip));
  out.push(h("div", { class: "controls" },
    chips([["open", "Open"], ["to_claim", "To claim"], ["submitted", "Submitted"], ["paid", "Paid"], ["all", "All"]], st.cst, (v) => { st.cst = v; render(); }, "Status", "scroll"),
    st.ctrip !== "all" ? h("button", { type: "button", class: "chip", "aria-pressed": "true", onclick: () => { st.ctrip = "all"; render(); } }, `${st.ctrip} ✕`) : null));
  out.push(card(plural(pick.length, "receipt"), { sub: pick.length ? `${money(pick.reduce((a, r) => a + Number(r.home), 0))} in ${S.cur}` : "Nothing here" },
    pick.length ? h("div", { class: "rows" }, pick.map((r) => h("button", { type: "button", class: "row", onclick: () => claimSheet(r) },
      h("span", { class: "l" }, h("b", null, r.merchant), h("span", null, [M.dayLabel(r.date), r.category, r.trip].filter(Boolean).join(" · "))),
      h("span", { class: "r num" }, money(r.home), h("small", null, h("span", { class: `st ${r.status}` }, STATUS[r.status] || r.status), r.currency !== S.cur ? ` · ${orig(r)}` : ""))))) : null));
  return out;
}

async function claimSheet(r) {
  const img = h("div", { class: "receipt" }, h("p", { class: "tiny" }, r.receipt ? "Loading the receipt…" : "No receipt image kept for this one."));
  const rows = [["Date", M.dayLabel(r.date)], ["Amount", orig(r)], [`In ${S.cur}`, `${money(r.home)}${r.currency !== S.cur ? ` at ${Number(r.fx).toFixed(4)}` : ""}`],
    ["Type", r.category], ["Trip", r.trip || "–"], ["Status", `${STATUS[r.status] || r.status}${r.submitted_on ? ` · submitted ${M.dayLabel(r.submitted_on)}` : ""}${r.paid_on ? ` · paid ${M.dayLabel(r.paid_on)}` : ""}`]];
  if (r.note) rows.push(["Note", r.note]);
  openSheet(h("h2", { id: "sheet-title" }, r.merchant), r.description ? h("p", { class: "small" }, r.description) : null,
    h("table", { class: "data" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { scope: "row" }, k), h("td", { class: "r" }, v))))),
    img, h("p", { class: "tiny" }, `To change it, tell the secretary bot (claim ${r.id}).`));
  if (!r.receipt) return;
  try {
    const x = await api("/api/receipt/view", { id: r.id });
    img.replaceChildren(x.mime === "application/pdf" ? h("p", { class: "tiny" }, "A PDF receipt: it goes into the claim pack as its own file.")
      : h("img", { src: `data:${x.mime};base64,${x.data}`, alt: `Receipt from ${r.merchant}` }));
  } catch (e) {
    img.replaceChildren(h("p", { class: "tiny" }, `Couldn't load the receipt: ${e.message}`));
  }
}

// ------------------------------------------------------------------ sheets
function eventSheet(ev, c) {
  if (!ev) return;
  const rows = [["When", ev.span ? `${M.dayLabel(M.localDate(ev.s))} to ${M.dayLabel(M.localDate(ev.e - 1))}` : `${M.dayLabel(M.localDate(ev.s))}, ${when(ev)}`],
    ["Counts as", ev.cat === "holiday" ? "Public holiday" : `${label(ev.cat, c.R)}${ev.counts ? "" : ev.span ? " (context, not hours)" : ev.free ? " (marked free: not counted)" : ev.declined ? " (declined)" : ""}`]];
  if (ev.loc) rows.push(["Where", ev.loc]);
  if (!ev.span && ev.e > ev.s) rows.push(["Length", M.hours(Math.round((ev.e - ev.s) / 60e3))]);
  openSheet(h("h2", { id: "sheet-title" }, ev.title),
    h("table", { class: "data" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { scope: "row" }, k), h("td", { class: "r" }, v))))),
    ev.link ? h("button", { type: "button", class: "btn quiet", onclick: () => openLink(ev.link) }, icon("ext"), "Open in Google Calendar") : null,
    ev.mine ? h("div", { class: "btns two" },
      h("button", { type: "button", class: "btn quiet", onclick: () => addSheet(c, { id: ev.id, title: ev.title, date: M.localDate(ev.s), start: M.hm(M.localMin(ev.s)), minutes: Math.round((ev.e - ev.s) / 60e3) }) }, "Move"),
      h("button", { type: "button", class: "btn danger", onclick: (e) => change({ op: "delete", id: ev.id }, e.currentTarget, "Deleted.") }, "Delete"))
      : h("p", { class: "tiny" }, ev.cal === "h" ? "From your public holiday calendar." : "Made outside this app: change it in Google Calendar."));
}

async function change(body, btn, done) {
  btn.disabled = true;
  try {
    const r = await api("/api/event", body);
    if (r.events) S.data.events = r.events;
    closeSheet();
    render();
    status(done);
  } catch (e) {
    btn.disabled = false;
    const err = $("form-err");
    if (err) err.textContent = e.message; else status(e.message);
  }
}

function addSheet(c, init = {}) {
  const moving = Boolean(init.id);
  const title = h("input", { class: "field", type: "text", maxlength: "120", placeholder: "What is it?", value: init.title || "", "aria-label": "Title", autocomplete: "off" });
  const date = h("input", { class: "field", type: "date", value: init.date || c.today, min: M.addDays(c.today, -7), "aria-label": "Date" });
  const start = h("input", { class: "field", type: "time", value: init.start || "19:00", step: "900", "aria-label": "Start" });
  let minutes = init.minutes || 60;
  const durs = [[30, "30m"], [60, "1h"], [90, "1.5h"], [120, "2h"], [180, "3h"]];
  if (!durs.some(([v]) => v === minutes)) durs.push([minutes, M.hours(minutes)]);
  const durWrap = h("div");
  const drawDur = () => durWrap.replaceChildren(segmented(durs, minutes, (v) => { minutes = v; drawDur(); check(); }, "Length"));
  const hint = h("p", { class: "tiny" });
  const clash = h("p", { class: "flag", hidden: true });
  const check = () => {
    const cat = M.categorise({ title: title.value }, c.R);
    hint.replaceChildren(h("i", { class: "sw", style: { background: catColor(cat) } }), ` Counts as ${label(cat, c.R)}`);
    const s0 = M.localMs(date.value, start.value || "00:00");
    const e0 = s0 + minutes * 60e3;
    const hits = c.P.filter((ev) => ev.counts && ev.id !== init.id && ev.s < e0 && ev.e > s0);
    clash.hidden = !hits.length;
    clash.replaceChildren(h("span", { class: "flag-tag" }, "Clash"), `Overlaps ${andList(hits.map((ev) => `${ev.title} (${when(ev)})`))}`);
  };
  for (const el of [title, date, start]) el.addEventListener("input", check);
  drawDur();
  check();
  const save = h("button", { type: "button", class: "btn", onclick: (e) => {
    if (!moving && !title.value.trim()) { $("form-err").textContent = "Add a title."; title.focus(); return; }
    if (!date.value || !start.value) { $("form-err").textContent = "Pick a date and a start time."; return; }
    change(moving ? { op: "move", id: init.id, date: date.value, start: start.value, minutes } : { op: "add", title: title.value.trim(), date: date.value, start: start.value, minutes },
      e.currentTarget, moving ? "Moved." : "Added to Google Calendar.");
  } }, moving ? "Move it" : "Add to calendar");
  openSheet(h("h2", { id: "sheet-title" }, moving ? `Move: ${init.title}` : "Add to calendar"),
    moving ? null : title,
    h("div", { class: "pair" }, h("label", null, h("span", { class: "eyebrow" }, "Date"), date), h("label", null, h("span", { class: "eyebrow" }, "Start"), start)),
    h("div", null, h("span", { class: "eyebrow" }, "Length"), durWrap),
    moving ? null : hint, clash,
    h("p", { class: "err", id: "form-err", role: "alert" }),
    save,
    h("p", { class: "tiny" }, moving ? "Changes the event in Google Calendar at once." : "Goes straight into your Google Calendar, marked as made here so it can be moved or deleted from the app later."));
  if (!moving) setTimeout(() => title.focus(), 50);
}

/** After the Google sign-in opens in the browser: check every few seconds until it's done (3 minutes at most). */
let waiting = null;
function waitForGoogle() {
  clearInterval(waiting);
  const until = Date.now() + 180e3;
  waiting = setInterval(async () => {
    if (Date.now() > until) { clearInterval(waiting); return; }
    try {
      const d = await api("/api/data");
      if ((d.google || {}).connected) {
        clearInterval(waiting);
        take(d);
        render();
        status("Google Calendar connected.");
      }
    } catch { /* keep waiting */ }
  }, 4000);
}

// ------------------------------------------------------------------ shell
let statusTimer;
function status(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function setTab(tab) {
  S.tab = TABS.includes(tab) ? tab : "today";
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    const on = b.dataset.tab === S.tab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!S.data) return;
  const c = context();
  const view = { today: viewToday, week: viewWeek, trends: viewTrends, plan: viewPlan, claims: viewClaims }[S.tab];
  $("view").replaceChildren(...view(c).filter(Boolean));
  const f = S.data.events && S.data.events.fetched_at;
  $("sub").textContent = (S.data.google || {}).connected ? `Google Calendar · ${f ? `read ${new Date(f).toLocaleTimeString("en-GB", { timeZone: M.zone(), hour: "2-digit", minute: "2-digit" })}` : "not read yet"}` : "Not connected yet";
  const hu = S.data.health && S.data.health.updated_at;
  $("asof").textContent = hu ? `Sleep and workouts as of ${new Date(hu).toLocaleString("en-GB", { timeZone: M.zone(), dateStyle: "medium", timeStyle: "short" })}.` : "No sleep or workout data (they come from the health bot, if you use it).";
}

/** Take in /api/data: the owner's timezone and home currency first, so every view uses them. */
function take(d) {
  S.data = d;
  const st = d.settings || {};
  M.setZone(st.timezone);
  S.cur = /^[A-Z]{3}$/.test(st.currency || "") ? st.currency : "SGD";
}

async function load() {
  take(await api("/api/data"));
  $("tabs").hidden = false;
  $("foot").hidden = false;
  setTab(S.tab);
}

// Telegram's light or dark theme, as in the Money and trip apps (not the phone's own
// setting); Telegram's bar takes the band colour, the page behind the app the theme's.
const BAND = { light: "#2f2a5e", dark: "#28234f" };
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
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceWith(icon(el.dataset.icon, el.className || "icon"));
  wireSheet();
  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    try { if (tg.onEvent) tg.onEvent("themeChanged", applyTheme); } catch { /* older clients */ }
  }
  const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
  for (const b of tabs) {
    b.addEventListener("click", () => setTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const j = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!j) return;
      const n = tabs[(tabs.indexOf(b) + j + tabs.length) % tabs.length];
      n.focus();
      setTab(n.dataset.tab);
    });
  }
  $("refresh").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      if (!(S.data && (S.data.google || {}).connected)) await load(); // not connected yet: reload everything
      else { const r = await api("/api/refresh"); S.data.events = r.events; render(); }
      status("Calendar re-read.");
    } catch (err) { status(err.message); }
    b.disabled = false;
  });
  // Back from the Google sign-in in the browser, or the app brought to the front again: reload.
  const back = () => { if (S.data && !document.hidden) load().catch(() => {}); };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
  try { if (tg && tg.onEvent) tg.onEvent("activated", back); } catch { /* older clients */ }
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 120); });
  if (!tg || !tg.initData) { $("status").textContent = "Open this from the secretary bot in Telegram."; return; }
  load().catch((e) => {
    $("view").replaceChildren(h("p", { class: "status" }, /private/i.test(e.message) ? "This app is private to its owner."
      : /unauthorised/i.test(e.message) ? "Your Telegram sign-in has expired. Close the app and open it again from the chat."
        : `Couldn't load: ${e.message}`));
  });
}

boot();
