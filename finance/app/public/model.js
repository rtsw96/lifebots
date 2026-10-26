// Pure data shaping for the Money app's views: no DOM, so it runs under
// `node --test` as well as on the phone.

// ------------------------------------------------------------------ currency
/** The home currency (the snapshot's `base`): totals count only lines in it. Set by renderTab. */
export let BASE = "SGD";
export function setBase(code) { BASE = String(code || "SGD").toUpperCase(); }

// ------------------------------------------------------------------ groups
export const GROUP_ORDER = ["committed", "day", "chosen", "one_off"];
export const GROUP_LABEL = { committed: "Committed", day: "Day-to-day", chosen: "Chosen", one_off: "One-off" };
export const GROUP_HINT = {
  committed: "Bills you can't avoid: tax, family, mortgage, insurance, utilities",
  day: "Everyday spending",
  chosen: "Kept on purpose: donations, subscriptions, education, fitness, card fees",
  one_off: "One-off capital: car, property works",
};

/** Which group a category is in: committed, chosen, one_off, or day (day-to-day). */
export function groupOf(cat, groups) {
  for (const g of ["committed", "chosen", "one_off"]) if (((groups || {})[g] || []).includes(cat)) return g;
  return "day";
}

/**
 * A month's spending split for charts. Refunds and claims are netted into
 * categories upstream, so a category can be negative; those go to `back`
 * (money in), never to a bar.
 */
export function splitMonth(m, groups) {
  const out = [];
  const back = [];
  for (const [c, v] of Object.entries((m && m.categories) || {})) {
    if (v < 0) back.push([c, -v]);
    else if (v > 0) out.push([c, v]);
  }
  out.sort((a, b) => b[1] - a[1]);
  back.sort((a, b) => b[1] - a[1]);
  const byGroup = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0]));
  for (const [c, v] of out) byGroup[groupOf(c, groups)] += v;
  const gross = out.reduce((a, [, v]) => a + v, 0);
  const backTotal = back.reduce((a, [, v]) => a + v, 0);
  return { out, back, byGroup, gross, back_total: backTotal };
}

// ------------------------------------------------------------------ history
/** Change over `days` days: [abs, rel, fromDate] against the last point on or before the cut. */
export function change(hist, days) {
  if (!hist || hist.length < 2) return null;
  const last = hist[hist.length - 1];
  const cut = new Date(Date.parse(`${last[0]}T00:00:00Z`) - days * 86400e3).toISOString().slice(0, 10);
  const then = hist.filter((p) => p[0] <= cut).pop();
  return then ? [last[1] - then[1], (last[1] - then[1]) / Math.abs(then[1] || 1), then[0]] : null;
}

/** Round tick values covering [lo, hi], about `n` of them. */
export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) { const pad = Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || 10 * mag;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = a; v <= b + step / 1e6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// ------------------------------------------------------------------ partial months
const lastDay = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

/**
 * Which accounts are incomplete for month `m`. through: {account: last line date}.
 * Returns {partial, short, text, missing:[acct], cut:[[acct, date]]}.
 */
export function partialInfo(m, through, accounts, dayName = (d) => d) {
  const accts = (accounts && accounts.length ? accounts : Object.keys(through || {})).filter((a) => through && through[a]);
  const end = lastDay(m);
  const missing = [], cut = [];
  for (const a of accts) {
    const t = through[a];
    if (t < `${m}-01`) missing.push(a);
    else if (t < end) cut.push([a, t]);
  }
  if (!missing.length && !cut.length) return { partial: false, short: "", text: "", missing, cut };
  const and = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const parts = [];
  if (cut.length) {
    const ds = cut.map(([, d]) => d).sort();
    const range = ds[0] === ds[ds.length - 1] ? dayName(ds[0]) : `${dayName(ds[0]).split(" ")[0]}–${dayName(ds[ds.length - 1])}`;
    parts.push(`${and(cut.map(([a]) => a))} ${cut.length === 1 ? "has" : "have"} lines only to ${range}`);
  }
  if (missing.length) parts.push(`nothing yet from ${and(missing)}`);
  const text = `Partial month: ${parts.join("; ")}.`;
  return { partial: true, short: "partial", text: text.replace(/: (.)/, (x, c) => `: ${c.toUpperCase()}`), missing, cut };
}

// ------------------------------------------------------------------ flows
/** The months a flow selection covers: "all", "last3", or one "YYYY-MM". */
export function flowMonths(flows, sel) {
  const ms = (flows || []).map((f) => f.month);
  if (sel === "all") return ms;
  if (sel === "last3") return ms.slice(-3);
  return ms.includes(sel) ? [sel] : ms.slice(-1);
}

/** Sum the links of the chosen months; in "groups" mode categories become their group. */
export function sumFlows(flows, months, mode, groups) {
  const want = new Set(months);
  const acc = new Map();
  for (const f of flows || []) {
    if (!want.has(f.month)) continue;
    for (const [src, dst, v] of f.links) {
      const t = mode === "groups" && dst.startsWith("cat:") ? `grp:${groupOf(dst.slice(4), groups)}` : dst;
      const k = `${src}\u0000${t}`;
      acc.set(k, (acc.get(k) || 0) + v);
    }
  }
  return [...acc].map(([k, v]) => { const [a, b] = k.split("\u0000"); return [a, b, v]; }).filter((l) => l[2] > 0);
}

export const columnOf = (id) => (id.startsWith("src:") ? 0 : id.startsWith("hub:") ? 1 : id.startsWith("acct:") || id.startsWith("out:") ? 2 : 3);

/** Totals for the summary tiles. */
export function flowTotals(links) {
  let inflow = 0, spent = 0, invested = 0, saved = 0, drawn = 0;
  for (const [a, b, v] of links) {
    if (b === "hub:in") { inflow += v; if (a === "src:From savings") drawn += v; }
    if (a === "hub:in" && b.startsWith("acct:")) spent += v;
    if (b === "out:invested") invested += v;
    if (b === "out:saved") saved += v;
  }
  return { inflow, spent, invested, saved, drawn };
}

/**
 * Fold small nodes into "Other" per column so the chart stays readable on a
 * phone. Returns {links, folded: {otherId: [[id, value]]}}.
 * maxCat: most category nodes shown (incl. Other). minShare: of inflow.
 */
export function foldSmall(links, { maxCat = 8, maxSrc = 5, maxAcct = 6, minShare = 0.02 } = {}) {
  const inflow = links.filter((l) => l[1] === "hub:in").reduce((a, l) => a + l[2], 0) || 1;
  const val = new Map();
  const bump = (id, v) => val.set(id, (val.get(id) || 0) + v);
  for (const [a, b, v] of links) {
    if (columnOf(a) === 0) bump(a, v);
    if (b.startsWith("acct:")) bump(b, v);
    if (columnOf(b) === 3) bump(b, v);
  }
  const rename = new Map();
  const folded = {};
  const fold = (prefix, max, otherId) => {
    const nodes = [...val].filter(([id]) => id.startsWith(prefix)).sort((x, y) => y[1] - x[1]);
    let keep = nodes.filter(([, v], i) => i < max - 1 || nodes.length <= max).filter(([, v]) => v >= minShare * inflow);
    let drop = nodes.filter((n) => !keep.includes(n));
    if (drop.length === 1) { keep = nodes; drop = []; } // a lone small node stays itself
    if (!drop.length) return;
    folded[otherId] = drop.map(([id, v]) => [id, v]);
    for (const [id] of drop) rename.set(id, otherId);
  };
  fold("src:", maxSrc, "src:~other");
  fold("acct:", maxAcct, "acct:~other");
  const catPrefix = links.some((l) => l[1].startsWith("grp:")) ? "grp:" : "cat:";
  fold(catPrefix, maxCat, `${catPrefix}~other`);
  const acc = new Map();
  for (const [a, b, v] of links) {
    const k = `${rename.get(a) || a}\u0000${rename.get(b) || b}`;
    acc.set(k, (acc.get(k) || 0) + v);
  }
  return { links: [...acc].map(([k, v]) => { const [a, b] = k.split("\u0000"); return [a, b, v]; }), folded };
}

/**
 * Sankey layout in four fixed columns. Nodes are stacked by value (largest on
 * top, "Other" last); link widths are proportional to value. Pure geometry:
 * returns {nodes, links, height}, each node {id, col, x, y, h, value, ly}
 * (ly = label centre, nudged apart so labels never overlap) and each link
 * {source, target, value, w, sy, ty} (sy/ty = centre of the ribbon at each end).
 */
export function sankeyLayout(links, { width = 340, labelRight = 96, nodeW = 8, pad = 8, top = 22, plotH = 0, labelGap = 26 } = {}) {
  const ids = new Map();
  const node = (id) => {
    if (!ids.has(id)) ids.set(id, { id, col: columnOf(id), vin: 0, vout: 0, ins: [], outs: [] });
    return ids.get(id);
  };
  const L = links.filter((l) => l[2] > 0).map(([a, b, v]) => {
    const l = { source: node(a), target: node(b), value: v };
    l.source.vout += v;
    l.target.vin += v;
    l.source.outs.push(l);
    l.target.ins.push(l);
    return l;
  });
  const nodes = [...ids.values()];
  for (const n of nodes) n.value = Math.max(n.vin, n.vout);
  const rank = (n) => (n.id.endsWith("~other") ? 2 : n.id.startsWith("out:") ? 1 : 0);
  const cols = [0, 1, 2, 3].map((c) => nodes.filter((n) => n.col === c).sort((a, b) => rank(a) - rank(b) || b.value - a.value));
  const maxN = Math.max(1, ...cols.map((c) => c.length));
  const H = plotH || Math.max(240, maxN * 24);
  const ky = Math.min(...cols.filter((c) => c.length).map((c) => (H - pad * (c.length - 1)) / (c.reduce((a, n) => a + n.value, 0) || 1)));
  const xr = width - labelRight - nodeW;
  const xs = [0, xr * 0.34, xr * 0.62, xr];
  let bottom = 0;
  for (const [c, col] of cols.entries()) {
    // Stack by value; a small node gets pushed down just enough that its
    // two-line label (centred on the node) clears the one above.
    let y = top;
    let prevC = -Infinity;
    for (const n of col) {
      n.x = xs[c];
      n.h = Math.max(1.5, n.value * ky);
      n.y = Math.max(y, prevC + labelGap - n.h / 2);
      n.ly = n.y + n.h / 2;
      prevC = n.ly;
      y = n.y + n.h + pad;
    }
    bottom = Math.max(bottom, y - pad, prevC + labelGap / 2);
  }
  for (const n of nodes) {
    n.outs.sort((a, b) => a.target.y - b.target.y);
    n.ins.sort((a, b) => a.source.y - b.source.y);
    let o = n.y;
    for (const l of n.outs) { l.w = Math.max(1, l.value * ky); l.sy = o + (l.value * ky) / 2; o += l.value * ky; }
    let i = n.y;
    for (const l of n.ins) { l.ty = i + (l.value * ky) / 2; i += l.value * ky; }
  }
  return { nodes, links: L, height: Math.ceil(bottom + 6), ky, xs, nodeW };
}

// ------------------------------------------------------------------ treemap
/** Squarified treemap. items: [{value, ...}] (value > 0). Returns the items with x, y, w, h. */
export function squarify(items, W, H) {
  const list = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((a, d) => a + d.value, 0) || 1;
  const scale = (W * H) / total;
  const out = [];
  let x = 0, y = 0, w = W, h = H;
  let row = [];
  const worst = (r, side) => {
    const sum = r.reduce((a, d) => a + d.value * scale, 0);
    const mx = Math.max(...r.map((d) => d.value * scale)), mn = Math.min(...r.map((d) => d.value * scale));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const lay = (r) => {
    const sum = r.reduce((a, d) => a + d.value * scale, 0);
    if (w >= h) {
      const cw = sum / h;
      let yy = y;
      for (const d of r) { const ch = (d.value * scale) / cw; out.push({ ...d, x, y: yy, w: cw, h: ch }); yy += ch; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const d of r) { const cw = (d.value * scale) / rh; out.push({ ...d, x: xx, y, w: cw, h: rh }); xx += cw; }
      y += rh; h -= rh;
    }
  };
  for (const d of list) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, d], side) <= worst(row, side)) row.push(d);
    else { lay(row); row = [d]; }
  }
  if (row.length) lay(row);
  return out;
}

// ------------------------------------------------------------------ day-to-day
const DAY_SKIP_KINDS = new Set(["TRANSFER", "INCOME"]);
const isOut = (t) => t.currency === BASE && t.amount < 0 && !DAY_SKIP_KINDS.has(t.kind) && t.kind !== "REFUND";

/**
 * One month of day-to-day spending from the snapshot's lines: every category
 * outside the committed, chosen and one-off groups. `travel: false` leaves
 * travel out (it is lumpy and mostly decided per trip). Money back
 * (reimbursements, refunds) is reported apart and netted in `net`.
 */
export function daySummary(lines, month, groups, { travel = true } = {}) {
  const inMonth = (lines || []).filter((t) => t.date.startsWith(month));
  const isDay = (c) => groupOf(c || "uncategorised", groups) === "day" && (travel || c !== "travel");
  const out = inMonth.filter((t) => isOut(t) && isDay(t.category) && t.category !== "reimbursement");
  const back = inMonth.filter((t) => t.currency === BASE && t.amount > 0 && (t.kind === "REFUND" || t.category === "reimbursement")
    && (t.category === "reimbursement" || t.category === "refund" || isDay(t.category)));
  const sum = (xs) => xs.reduce((a, t) => a - t.amount, 0);
  const byCat = new Map(), byMerch = new Map(), byDay = new Map();
  for (const t of out) {
    const c = t.category || "uncategorised";
    byCat.set(c, (byCat.get(c) || 0) - t.amount);
    const m = t.merchant || t.desc;
    byMerch.set(m, (byMerch.get(m) || 0) - t.amount);
    byDay.set(t.date, (byDay.get(t.date) || 0) - t.amount);
  }
  const gross = sum(out);
  const backTotal = -sum(back);
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  // habits: what you can act on
  const cat = (c) => out.filter((t) => t.category === c);
  const dining = out.filter((t) => t.category === "dining" || t.category === "dining_hawker");
  const big = dining.filter((t) => -t.amount >= 100);
  const small = out.filter((t) => -t.amount < 15);
  const habit = (label, xs, hint) => ({ label, count: xs.length, total: sum(xs), hint });
  return {
    month, gross, back: backTotal, net: gross - backTotal, lines: out.sort((a, b) => a.amount - b.amount),
    categories: sorted(byCat), merchants: sorted(byMerch),
    days: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    habits: [
      habit("Eating out", dining, "every restaurant, café and delivery line"),
      habit(`Meals of ${BASE} 100 or more`, big, "the few big dinners"),
      habit("Rides and taxis", cat("transport_ride"), "rides"),
      habit("E-wallet top-ups", cat("e_wallet"), "what they bought isn't on any statement"),
      habit("Online shopping", cat("shopping_online"), "orders"),
      habit(`Small spends under ${BASE} 15`, small, "coffee, snacks, top-ups"),
    ].filter((x) => x.count),
  };
}

/** Cumulative spend by calendar day for a month: [[YYYY-MM-DD, running total]], one point per day up to `upTo`. */
export function cumulative(days, month, upTo) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = Math.min(last, upTo || last);
  const by = new Map(days);
  const pts = [];
  let run = 0;
  for (let dd = 1; dd <= end; dd++) {
    const k = `${month}-${String(dd).padStart(2, "0")}`;
    run += by.get(k) || 0;
    pts.push([k, run]);
  }
  return { pts, daysInMonth: last };
}

// ------------------------------------------------------------------ food
export const FOOD_TYPES = [["out", "Eating out"], ["delivery", "Delivery"], ["hawker", "Hawker"], ["groceries", "Groceries"]];
const DELIVERY = /FOOD ?PANDA|DELIVEROO|GRAB ?FOOD|GRABFOOD|UBER ?EATS|DOORDASH/i;

/** Which kind of food spend a line is, or null if it isn't food. */
export function foodType(t) {
  const c = t.category;
  if (c === "groceries") return "groceries";
  if (c === "dining_hawker") return "hawker";
  if (c === "dining") return DELIVERY.test(`${t.desc} ${t.merchant}`) ? "delivery" : "out";
  return null;
}

/** One month of food spending from the lines: totals by type, visits, big meals, top places. Home-currency money out only. */
export function foodSummary(lines, month) {
  const xs = (lines || []).filter((t) => t.date.startsWith(month) && t.currency === BASE && t.amount < 0 && foodType(t));
  const by = Object.fromEntries(FOOD_TYPES.map(([k]) => [k, { total: 0, count: 0 }]));
  const places = new Map();
  for (const t of xs) {
    const k = foodType(t);
    by[k].total -= t.amount;
    by[k].count += 1;
    const p = t.merchant || t.desc;
    places.set(p, (places.get(p) || 0) - t.amount);
  }
  const total = xs.reduce((a, t) => a - t.amount, 0);
  const out = xs.filter((t) => foodType(t) === "out");
  const big = out.filter((t) => -t.amount >= 100);
  return {
    month, total, by, lines: xs,
    meals: out.length + by.delivery.count + by.hawker.count,
    avgOut: out.length ? by.out.total / out.length : null,
    big: { count: big.length, total: big.reduce((a, t) => a - t.amount, 0) },
    places: [...places.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// ------------------------------------------------------------------ trackers
// The Everyday tab's trackers: a set of categories, split into types you
// recognise. Classification is by category first, then by words in the line.
const rx = (re) => (t) => re.test(`${t.desc} ${t.merchant}`);
const isFlight = rx(/AIRLINE|AIRWAYS|\bAIR\b|SCOOT|AIRASIA|JETSTAR|RYANAIR|EASYJET|VIETJET|FLIGHT/i);
const isStay = rx(/AGODA|BOOKING\.COM|AIRBNB|HOTEL|MARRIOTT|HILTON|HYATT|ACCOR|TRIP\.COM|EXPEDIA|HOSTEL/i);
const isVisa = rx(/ESTA|IMMIGRATION|E-?VISA|\bETA\b|VISA APPL/i);
const isEvent = rx(/EB \*|EVENTBRITE|TICKET|KLOOK|PEATIX/i);
const isFilm = rx(/CINEMA|CINEPLEX|FILM/i);
const isGame = rx(/GAMES|ARCADE|TIMEZONE|BOWLING|STEAM|PLAYSTATION|NINTENDO/i);

export const TRACKERS = [
  { key: "food", title: "Food", sub: "Eating out, delivery, hawker and groceries", cats: ["dining", "dining_hawker", "groceries"], budget: "food",
    types: [["out", "Eating out", "visit"], ["delivery", "Delivery", "order"], ["hawker", "Hawker", "visit"], ["groceries", "Groceries", "shop"]],
    typeOf: (t) => foodType(t),
    note: "Delivery that a statement can't tell apart from rides, and meals paid from an e-wallet, sit outside this tracker until you label them." },
  { key: "fun", title: "Entertainment and activities", sub: "Events, films, games and activities", cats: ["entertainment", "activities"], budget: "fun",
    types: [["events", "Events and tickets", "booking"], ["films", "Films", "visit"], ["games", "Games and arcades", "visit"], ["activities", "Activities", "booking"], ["other", "Other", "line"]],
    typeOf: (t) => (t.category === "activities" ? "activities" : isEvent(t) ? "events" : isFilm(t) ? "films" : isGame(t) ? "games" : "other"),
    note: "Classes, tours and sports can go here too: tap a line and pick Activities, or tell the bot." },
  { key: "shopping", title: "Shopping", sub: "Online and in store", cats: ["shopping_online", "shopping_retail"], budget: "shopping",
    types: [["online", "Online", "order"], ["store", "In store", "visit"]],
    typeOf: (t) => (t.category === "shopping_retail" ? "store" : "online") },
  { key: "travel", title: "Travel", sub: "Flights, stays, spending abroad and fees", cats: ["travel"], budget: "travel",
    types: [["flights", "Flights", "booking"], ["stays", "Stays", "booking"], ["abroad", "Spending abroad", "line"], ["fees", "Visas and fees", "line"], ["other", "Other", "line"]],
    typeOf: (t) => (isFlight(t) ? "flights" : isStay(t) ? "stays" : isVisa(t) ? "fees" : /\b(USD|EUR|GBP|JPY|CNY|HKD|KRW|THB|VND|MYR|IDR|AUD|TWD)\b/i.test(`${t.desc} ${t.merchant}`) ? "abroad" : "other"),
    note: "Spending abroad counts at what your card or wallet charged in your home currency. Cash for a trip counts once you file it as travel." },
];

/** One month of a tracker: totals by type, top places, the lines. Home-currency money out only. */
export function trackerSummary(lines, month, tr) {
  const xs = (lines || []).filter((t) => t.date.startsWith(month) && t.currency === BASE && t.amount < 0 && tr.cats.includes(t.category));
  const by = Object.fromEntries(tr.types.map(([k]) => [k, { total: 0, count: 0 }]));
  const places = new Map();
  for (const t of xs) {
    const k = tr.typeOf(t) || tr.types[0][0];
    by[k].total -= t.amount;
    by[k].count += 1;
    const p = t.merchant || t.desc;
    places.set(p, (places.get(p) || 0) - t.amount);
  }
  const total = xs.reduce((a, t) => a - t.amount, 0);
  const big = xs.filter((t) => -t.amount >= 100);
  return { month, total, by, lines: xs, count: xs.length, avg: xs.length ? total / xs.length : null,
    big: { count: big.length, total: big.reduce((a, t) => a - t.amount, 0) },
    places: [...places.entries()].sort((a, b) => b[1] - a[1]) };
}

// ------------------------------------------------------------------ recurring
export const REC_SECTIONS = [["insurance", "Insurance"], ["subscriptions", "Subscriptions"], ["regular", "Regular"],
  ["mortgage", "Mortgage"], ["taxes", "Taxes"], ["others", "Others"]];
const REC_MONTHS = { monthly: 1, quarterly: 3, "half-yearly": 6, annual: 12 };

/** Same day `n` months later, clamped to the month's end (31 Jan + 1 = 28 Feb). */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const counted = (i) => i.status !== "stopped?";

/**
 * What the recurring payments should cost in each of the next `n` months (this month
 * first, from today on). Payments on a monthly-or-longer cycle land on their due dates;
 * weekly and irregular ones are spread evenly at their monthly rate.
 */
export function recurringCalendar(rec, n = 12) {
  const asOf = rec.as_of;
  const months = Array.from({ length: n }, (_, k) => addMonths(`${asOf.slice(0, 7)}-01`, k).slice(0, 7));
  const cal = months.map((month) => ({ month, by: {}, total: 0, items: [] }));
  const put = (k, i, v, date) => {
    const c = cal[k];
    c.by[i.section] = (c.by[i.section] || 0) + v;
    c.total += v;
    c.items.push({ name: i.name, section: i.section, cadence: i.cadence, amount: v, date, spread: !date });
  };
  for (const i of (rec.items || []).filter(counted)) {
    const step = REC_MONTHS[i.cadence];
    if (!step || !i.next) {
      // the first month only holds the rest of it
      months.forEach((_, k) => put(k, i, k ? i.monthly : i.monthly * restOfMonth(asOf), null));
      continue;
    }
    for (let d = i.next; d.slice(0, 7) <= months[n - 1]; d = addMonths(d, step)) {
      const k = months.indexOf(d.slice(0, 7));
      if (k >= 0 && d >= asOf) put(k, i, i.amount, d);
    }
  }
  for (const c of cal) c.items.sort((a, b) => (a.date || "9") < (b.date || "9") ? -1 : (a.date || "9") > (b.date || "9") ? 1 : b.amount - a.amount);
  return cal;
}

function restOfMonth(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (days - d + 1) / days;
}

/** Payments on a monthly-or-longer cycle due within `days` of the snapshot date, soonest first. */
export function upcoming(rec, days = 30) {
  const end = new Date(Date.parse(`${rec.as_of}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
  const out = [];
  for (const i of (rec.items || []).filter(counted)) {
    const step = REC_MONTHS[i.cadence];
    if (!step || !i.next) continue; // weekly habits would crowd the list
    for (let d = i.next; d <= end; d = addMonths(d, step)) if (d >= rec.as_of) out.push({ ...i, due: d });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : b.amount - a.amount));
}
