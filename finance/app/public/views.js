// The Money app's tabs, as pure render functions of the decrypted snapshot.
// No crypto and no network here: app.js passes in a context with the view
// state, a re-render hook and the one write the app makes (re-categorise a
// line), so the same code renders in the test harness (finance/app/test/).
//
//   ctx = { st, rerender(), w, queue: [{ref}], recategorise(txn, category) }

import { h, card, chips, segmented, note, openSheet, money, fmt, pct, share, smoney, title, monthName, monthShort, dayName, plural, andList, delta, icon } from "./ui.js";
import { BASE, setBase, GROUP_ORDER, GROUP_LABEL, GROUP_HINT, groupOf, splitMonth, change, partialInfo, flowMonths, sumFlows, flowTotals, foldSmall, sankeyLayout, daySummary, cumulative, TRACKERS, trackerSummary, REC_SECTIONS, recurringCalendar, upcoming } from "./model.js";
import { lineChart, donut, hbars, stackedBars, sankey, treemap, splitBar, paceChart } from "./charts.js";

export const TABS = [["overview", "Overview"], ["day", "Everyday"], ["flows", "Flows"], ["recurring", "Recurring"], ["spending", "Spending"], ["holdings", "Holdings"]];

// ------------------------------------------------------------------ colours
// Fixed per entity (never by rank), with dark-mode steps in app.css.
const KIND_ORDER = ["PROPERTY", "LISTED", "PRIVATE_FUND", "PRIVATE_CREDIT", "BOND", "CRYPTO", "CASH"];
const kindColor = (k) => `var(--k-${KIND_ORDER.includes(k) ? k.toLowerCase() : "other"})`;
const kindName = (k) => ({ PRIVATE_FUND: "Private fund", PRIVATE_CREDIT: "Private credit", LISTED: "Listed" }[k] || title(k));
const groupColor = (g) => `var(--g-${GROUP_ORDER.includes(g) ? g : "other"})`;
const CURRENCIES = ["SGD", "USD", "KRW", "JPY", "TWD", "HKD", "EUR"];
const curColor = (c) => `var(--cur-${CURRENCIES.includes(c) ? c.toLowerCase() : "other"})`;
const rankColor = (i) => (i < 6 ? `var(--s${i + 1})` : "var(--s-other)");
const catName = (c) => (c === "uncategorised" || !c ? "No category" : title(c));

const SRC_SHORT = { "Refunds and claims": "Refunds", "From investments": "Investments",
  "From savings": "Savings", "Interest and dividends": "Interest", "Other income": "Other" };

function defaultMonth(ms, asOf) {
  const cur = String(asOf || "").slice(0, 7);
  const past = ms.filter((m) => m < cur);
  return past.length ? past[past.length - 1] : ms[ms.length - 1];
}

function monthNote(d, months) {
  const info = months.map((m) => [m, partialInfo(m, d.accounts_through || {}, d.spend_accounts, dayName)]).filter(([, i]) => i.partial);
  if (!info.length) return null;
  if (info.length === 1 && months.length === 1) return info[0][1].text;
  if (info.length === 1) return `${monthName(info[0][0])} is partial. ${info[0][1].text.replace(/^Partial month: /, "")}`;
  return `${andList(info.map(([m]) => monthShort(m)))} are partial: some statements aren't in yet.`;
}
const partialFlag = (text) => (text ? h("p", { class: "flag" }, h("span", { class: "flag-tag" }, "Partial"), text.replace(/^Partial month: /, "")) : null);

const stat = (labelText, value, sub, cls = "") => h("div", { class: `stat ${cls}` }, h("span", { class: "stat-l" }, labelText), h("b", { class: "num" }, value), sub ? h("small", null, sub) : null);
const legend = (items) => h("div", { class: "legend", "aria-hidden": "true" }, items.map(([l, c]) => h("span", null, h("i", { class: "sw", style: { background: c } }), l)));

// ------------------------------------------------------------------ overview
function viewOverview(d, ctx) {
  const hist = d.history || [];
  const w1 = change(hist, 7);
  const m1 = change(hist, 30);
  const first = hist[0];
  const last = hist[hist.length - 1];
  const chg = (c, lab) => delta(c[0], `${smoney(c[0])} (${pct(c[1])}) ${lab}`);
  const deltas = [];
  if (w1) deltas.push(chg(w1, "1W"));
  if (m1) deltas.push(chg(m1, "1M"));
  else if (hist.length > 1 && first[0] !== (w1 && w1[2])) deltas.push(chg([last[1] - first[1], (last[1] - first[1]) / Math.abs(first[1] || 1)], `since ${dayName(first[0])}`));
  const out = [];
  out.push(card(null, { cls: "hero", label: "Net worth" },
    h("p", { class: "eyebrow" }, "Net worth"),
    h("p", { class: "big num" }, fmt(d.net_worth), h("small", null, d.base || BASE)),
    deltas.length ? h("div", { class: "deltas" }, deltas) : null,
    hist.length ? lineChart(hist, { w: ctx.w - 32, label: "Net worth" }) : null,
    hist.length && hist.length < 12 ? h("p", { class: "tiny" }, `History started ${dayName(first[0])}: ${plural(hist.length, "point")} so far. Tap the chart to read one.`) : null,
    h("div", { class: "stats" },
      stat("Securities", money(d.securities)),
      stat("Cash", money(d.cash_total), "net of margin"),
      d.margin_loans ? stat("Margin loans", money(d.margin_loans), "in cash above", "neg") : null)));

  const kinds = Object.entries(d.by_kind || {});
  const posK = KIND_ORDER.filter((k) => (d.by_kind || {})[k] > 0).concat(kinds.map(([k]) => k).filter((k) => !KIND_ORDER.includes(k) && d.by_kind[k] > 0));
  const negK = kinds.filter(([, v]) => v < 0);
  const gross = posK.reduce((a, k) => a + d.by_kind[k], 0);
  out.push(card("What it's made of", { sub: `${money(gross)} ${BASE} gross assets` },
    donut(posK.map((k) => ({ key: k, label: kindName(k), value: d.by_kind[k], color: kindColor(k) })),
      { label: "Assets by kind", center: "gross assets", sel: ctx.st.kindSel, onSelect: (k) => { ctx.st.kindSel = k; } }),
    negK.length ? note(`Not shown: ${negK.map(([k, v]) => `${kindName(k)} ${money(v)}`).join(", ")} (negative).`) : null,
    note("Cash is net of margin loans. Tap a slice or a row.")));

  const accts = (d.by_account || []).filter((a) => a.value >= 1);
  const tiny = (d.by_account || []).filter((a) => a.value < 1);
  out.push(card("Accounts", { sub: `${plural(accts.length, "account")} with money in` },
    hbars(accts.map((a) => ({ label: a.name, sub: a.name !== a.id ? a.id : null, value: a.value })), { label: "Value by account" }),
    tiny.length ? note(`Also: ${tiny.map((a) => a.name).join(", ")} (under 1 ${BASE}).`) : null));

  const cur = Object.entries(d.by_currency || {}).filter(([, v]) => v > 0);
  const curTot = cur.reduce((a, [, v]) => a + v, 0) || 1;
  out.push(card("Currency exposure", { sub: "Gross assets by currency" },
    splitBar(cur.map(([c, v]) => ({ label: c, value: v, color: curColor(c) })), { label: "Currency exposure" }),
    hbars(cur.map(([c, v]) => ({ label: c, value: v, color: curColor(c), right: `${money(v)} · ${share(v / curTot, 0)}` })), { label: "Value by currency" })));

  const alerts = d.alerts || [];
  out.push(card("Needs a look", { sub: alerts.length ? plural(alerts.length, "item") : "Nothing" },
    alerts.length
      ? h("ul", { class: "alerts" }, alerts.map((a) => h("li", null,
        h("span", { class: `sev ${a.severity}` }, a.severity === "error" ? "Act" : a.severity === "warning" ? "Check" : "Note"),
        h("span", null, h("b", null, `${title(a.area)}: `), a.text))))
      : h("p", { class: "empty" }, "No policy or reconciliation flags.")));
  return out;
}

// ------------------------------------------------------------------ flows
function nodeLabel(id) {
  const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  if (id.endsWith("~other")) return kind === "acct" ? ["Smaller", "Smaller accounts"] : kind === "src" ? ["Smaller", "Smaller sources"] : ["Smaller", kind === "grp" ? "Smaller groups" : "Smaller categories"];
  if (kind === "src") return [SRC_SHORT[rest] || rest, rest];
  if (kind === "hub") return ["In", "Money in"];
  if (kind === "acct") return [rest, rest];
  if (id === "out:invested") return ["Invested", "Invested"];
  if (id === "out:saved") return ["Saved", "Kept as savings"];
  if (kind === "grp") return [GROUP_LABEL[rest] || title(rest), GROUP_LABEL[rest] || title(rest)];
  return [catName(rest), catName(rest)];
}

function nodeColor(id, groups) {
  if (id.startsWith("src:")) return id === "src:From savings" ? "var(--warm)" : "var(--flow-src)";
  if (id.startsWith("hub:")) return "var(--accent)";
  if (id.startsWith("acct:")) return "var(--flow-acct)";
  if (id === "out:invested") return "var(--invested)";
  if (id === "out:saved") return "var(--accent)";
  if (id.endsWith("~other")) return "var(--g-other)";
  if (id.startsWith("grp:")) return groupColor(id.slice(4));
  return groupColor(groupOf(id.slice(4), groups));
}

function viewFlows(d, ctx) {
  const flows = d.flows || [];
  const st = ctx.st;
  if (!flows.length) return [card("No flows yet", null, note("Flows appear once the bot has bank or card lines for a month."))];
  const ms = flows.map((f) => f.month);
  if (!st.flowSel || !(st.flowSel === "all" || st.flowSel === "last3" || ms.includes(st.flowSel))) st.flowSel = defaultMonth(ms, d.as_of);
  st.flowMode = st.flowMode || "categories";
  const months = flowMonths(flows, st.flowSel);
  const groups = d.category_groups || {};
  const raw = sumFlows(flows, months, st.flowMode, groups);
  const rawCats = sumFlows(flows, months, "categories", groups);
  const { links, folded } = foldSmall(raw, { maxCat: st.flowMode === "groups" ? 6 : 8 });
  const tot = flowTotals(raw);
  const yearOf = (m) => m.slice(0, 4);
  const multiYear = new Set(ms.map(yearOf)).size > 1;
  const span = months.length === 1 ? monthName(months[0]) : `${monthShort(months[0])}–${monthName(months[months.length - 1])}`;

  const pick = (v) => { st.flowSel = v; st.flowNode = null; ctx.rerender(); };
  const out = [];
  out.push(h("div", { class: "controls" },
    chips([["all", "All"], ["last3", "Last 3 months"], ...[...ms].reverse().map((m) => [m, multiYear ? monthName(m) : monthShort(m)])], st.flowSel, pick, "Months", "scroll"),
    segmented([["categories", "Categories"], ["groups", "Groups"]], st.flowMode, (v) => { st.flowMode = v; st.flowNode = null; ctx.rerender(); }, "Detail")));

  out.push(card(null, { cls: "tiles-card", label: "Totals" },
    h("p", { class: "eyebrow" }, `Money in and out · ${span}`),
    h("div", { class: "stats four" },
      stat("In", money(tot.inflow)),
      stat("Paid out", money(tot.spent)),
      stat("Invested", money(tot.invested)),
      tot.drawn > 0 && !tot.saved ? stat("From savings", money(tot.drawn), null, "warm") : stat("Saved", money(tot.saved))),
    partialFlag(monthNote(d, months))));

  const W = ctx.w - 16;
  const labelRight = W < 330 ? 88 : 98;
  const lay = sankeyLayout(links, { width: W, labelRight });
  const sel = st.flowNode && lay.nodes.some((n) => n.id === st.flowNode) ? st.flowNode : null;
  const onNode = (id) => {
    st.flowNode = st.flowNode === id ? null : id;
    ctx.rerender();
    if (st.flowNode) flowSheet(id, { d, months, span, raw, rawCats, folded, groups, mode: st.flowMode });
  };
  out.push(card("Where it went", { cls: "flush", sub: "Tap a block for its breakdown",
    right: sel ? h("button", { type: "button", class: "linkbtn", onclick: () => { st.flowNode = null; ctx.rerender(); } }, "Clear") : null },
    sankey(lay, { w: W, labelRight, sel, onNode, label: `Money flow for ${span}: ${money(tot.inflow)} ${BASE} in`,
      headers: ["From", `In ${money(tot.inflow)}`, "Paid from", st.flowMode === "groups" ? "Groups" : "Spent on"],
      labelOf: nodeLabel, colorOf: (id) => nodeColor(id, groups),
      linkColor: (l) => (l.target.id === "hub:in" ? nodeColor(l.source.id, groups) : l.source.id === "hub:in" && l.target.id.startsWith("acct:") ? "var(--flow)" : nodeColor(l.target.id, groups)) }),
    st.flowMode === "categories" ? legend(GROUP_ORDER.map((g) => [GROUP_LABEL[g], groupColor(g)])) : null,
    Object.keys(folded).length ? note(`Small flows are folded into "Smaller" so the chart stays readable; tap it to see them.`) : null));

  // The same numbers as lists (also the accessible view of the chart).
  const srcRows = raw.filter((l) => l[1] === "hub:in").sort((a, b) => b[2] - a[2]);
  const catRows = raw.filter((l) => l[0].startsWith("acct:"));
  const byCat = new Map();
  for (const [, t, v] of catRows) byCat.set(t, (byCat.get(t) || 0) + v);
  out.push(h("details", { class: "card lists" }, h("summary", null, h("span", null, h("h2", null, "As lists"), h("span", { class: "sub" }, "The same flows, largest first"))),
    h("h3", null, "Money in"),
    hbars(srcRows.map(([sId, , v]) => ({ label: nodeLabel(sId)[1], value: v, color: nodeColor(sId, groups) })), { label: "Money in by source" }),
    h("h3", null, st.flowMode === "groups" ? "Spent, by group" : "Spent, by category"),
    hbars([...byCat].sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ label: nodeLabel(id)[1], value: v, color: nodeColor(id, groups),
      sub: id.startsWith("cat:") ? GROUP_LABEL[groupOf(id.slice(4), groups)] : null })), { label: "Spending by category" })));
  return out;
}

function flowSheet(id, { d, months, span, raw, rawCats, folded, groups, mode }) {
  const [, full] = nodeLabel(id);
  const kids = [h("h2", { id: "sheet-title" }, full)];
  const sumBy = (ls, keyOf) => { const m = new Map(); for (const l of ls) m.set(keyOf(l), (m.get(keyOf(l)) || 0) + l[2]); return [...m].sort((a, b) => b[1] - a[1]); };
  const members = folded[id] ? folded[id].map(([x]) => x) : [id];
  const inSet = (x) => members.includes(x);
  const catRow = ([c, v]) => ({ label: nodeLabel(c)[1], value: v, color: nodeColor(c, groups), sub: c.startsWith("cat:") ? GROUP_LABEL[groupOf(c.slice(4), groups)] : null });
  const perMonth = (pred, md = mode) => (months.length > 1 ? months.map((m) => [m, sumFlows(d.flows, [m], md, groups).filter(pred).reduce((a, l) => a + l[2], 0)]) : null);
  const monthBars = (rows) => (rows && rows.some(([, v]) => v) ? [h("h3", null, "By month"),
    hbars(rows.map(([m, v]) => ({ label: monthName(m), value: v })), { label: "By month" })] : []);
  let total = 0;
  if (id.startsWith("src:")) {
    const ls = raw.filter((l) => inSet(l[0]) && l[1] === "hub:in");
    total = ls.reduce((a, l) => a + l[2], 0);
    kids.push(h("p", { class: "sheet-big num" }, fmt(total), h("small", null, `${BASE} in · ${span}`)));
    if (folded[id]) kids.push(h("h3", null, "Folded in here"), hbars(sumBy(ls, (l) => l[0]).map(([x, v]) => ({ label: nodeLabel(x)[1], value: v, color: nodeColor(x, groups) })), { label: "Sources" }));
    if (id === "src:From savings") kids.push(note("More went out than came in, so the difference came from savings."));
    kids.push(...monthBars(perMonth((l) => inSet(l[0]) && l[1] === "hub:in")));
  } else if (id === "hub:in") {
    total = flowTotals(raw).inflow;
    kids.push(h("p", { class: "sheet-big num" }, fmt(total), h("small", null, `${BASE} in · ${span}`)),
      h("h3", null, "From"), hbars(sumBy(raw.filter((l) => l[1] === "hub:in"), (l) => l[0]).map(([x, v]) => ({ label: nodeLabel(x)[1], value: v, color: nodeColor(x, groups) })), { label: "From" }),
      h("h3", null, "To"), hbars(sumBy(raw.filter((l) => l[0] === "hub:in"), (l) => l[1]).map(([x, v]) => ({ label: nodeLabel(x)[1], value: v, color: nodeColor(x, groups) })), { label: "To" }));
  } else if (id.startsWith("acct:")) {
    const ls = rawCats.filter((l) => inSet(l[0]));
    total = ls.reduce((a, l) => a + l[2], 0);
    kids.push(h("p", { class: "sheet-big num" }, fmt(total), h("small", null, `${BASE} paid · ${span}`)));
    if (folded[id]) kids.push(h("h3", null, "Accounts"), hbars(sumBy(ls, (l) => l[0]).map(([x, v]) => ({ label: nodeLabel(x)[1], value: v })), { label: "Accounts" }));
    kids.push(h("h3", null, "What it paid for"), hbars(sumBy(ls, (l) => l[1]).map(catRow), { label: "Categories paid" }));
    const acct = id.slice(5);
    const thr = (d.accounts_through || {})[acct];
    if (thr) kids.push(note(`Lines from ${acct} run to ${dayName(thr)}.`));
  } else if (id.startsWith("out:")) {
    total = raw.filter((l) => l[1] === id).reduce((a, l) => a + l[2], 0);
    kids.push(h("p", { class: "sheet-big num" }, fmt(total), h("small", null, `${BASE} · ${span}`)),
      note(id === "out:invested" ? "Money moved to brokers and funds." : "What came in and wasn't spent or invested."));
    kids.push(...monthBars(perMonth((l) => l[1] === id)));
  } else {
    // a category, a group, or the folded "Other"
    const catIds = new Set();
    for (const m of members) {
      if (m.startsWith("grp:")) for (const l of rawCats) { if (l[1].startsWith("cat:") && `grp:${groupOf(l[1].slice(4), groups)}` === m) catIds.add(l[1]); }
      else catIds.add(m);
    }
    const ls = rawCats.filter((l) => catIds.has(l[1]));
    total = ls.reduce((a, l) => a + l[2], 0);
    kids.push(h("p", { class: "sheet-big num" }, fmt(total), h("small", null, `${BASE} spent · ${span}`)));
    if (id.startsWith("cat:") && !folded[id]) kids.push(h("p", { class: "tiny" }, `Group: ${GROUP_LABEL[groupOf(id.slice(4), groups)]}`));
    if (catIds.size > 1) kids.push(h("h3", null, "Categories"), hbars(sumBy(ls, (l) => l[1]).map(catRow), { label: "Categories" }));
    kids.push(h("h3", null, "Paid from"), hbars(sumBy(ls, (l) => l[0]).map(([x, v]) => ({ label: nodeLabel(x)[1], value: v, color: "var(--flow-acct)" })), { label: "Accounts that paid" }));
    kids.push(...monthBars(perMonth((l) => l[0].startsWith("acct:") && catIds.has(l[1]), "categories")));
  }
  const nt = id.startsWith("acct:") ? null : monthNote(d, months); // an account sheet says its own date
  if (nt) kids.push(partialFlag(nt));
  openSheet(kids);
}

// ------------------------------------------------------------------ spending
function viewSpending(d, ctx) {
  const sp = d.spending || { months: [], recent: [] };
  const st = ctx.st;
  const groups = d.category_groups || {};
  if (!sp.months.length) {
    return [card("No statements yet", null,
      note("Send a card or bank statement to the money bot: a CSV export, or a PDF (unlock it first if it's password-protected). The bot reads the lines, deletes the file, and the numbers appear here."),
      h("p", { class: "tiny" }, `Cards on file: ${(d.spend_accounts || []).join(", ")}. Account and card numbers are never kept.`))];
  }
  const months = sp.months.slice(-6);
  if (!st.month || !months.some((m) => m.month === st.month)) st.month = defaultMonth(months.map((m) => m.month), d.as_of);
  const m = months.find((x) => x.month === st.month);
  const split = splitMonth(m, groups);
  const through = d.accounts_through || {};
  const out = [];

  const cols = months.map((x) => {
    const sx = splitMonth(x, groups);
    const pi = partialInfo(x.month, through, d.spend_accounts, dayName);
    return { key: x.month, label: monthShort(x.month), sub: pi.partial ? "partial" : "", aria: `${monthName(x.month)}${pi.partial ? " (partial)" : ""}`, values: sx.byGroup };
  });
  const series = GROUP_ORDER.map((g) => ({ key: g, label: GROUP_LABEL[g], color: groupColor(g) }));
  out.push(card("Six months", { sub: "Money out by group. Tap a month." },
    stackedBars(cols, series, { w: ctx.w - 32, label: "Money out per month by group", sel: st.month, onSelect: (k) => { st.month = k; st.allLines = false; st.allCats = false; ctx.rerender(); } }),
    legend(series.map((se) => [se.label, se.color])),
    note("Bars are money out before refunds and claims, which are shown on their own below.")));

  const idx = sp.months.indexOf(m);
  const prev = idx > 0 ? sp.months[idx - 1] : null;
  const pi = partialInfo(m.month, through, d.spend_accounts, dayName);
  out.push(card(null, { cls: "hero", label: `Spending in ${monthName(m.month)}` },
    h("p", { class: "eyebrow" }, `Spent in ${monthName(m.month)}`),
    h("p", { class: "big num" }, fmt(m.spend), h("small", null, BASE)),
    h("div", { class: "deltas" },
      prev ? delta(m.spend - prev.spend, `${smoney(m.spend - prev.spend)} vs ${monthShort(prev.month)}`, false) : null),
    split.back_total > 0 ? h("p", { class: "tiny" }, `${fmt(split.gross)} out, ${fmt(split.back_total)} back from refunds and claims.`) : null,
    h("div", { class: "stats" },
      stat("Income", m.income ? money(m.income) : "–", m.income ? null : "none this month"),
      stat("Savings rate", m.savings_rate == null ? "–" : `${m.savings_rate < 0 ? "−" : ""}${fmt(Math.abs(m.savings_rate) * 100)}%`, m.savings_rate != null && m.savings_rate < 0 ? "spent more than came in" : null, m.savings_rate != null && m.savings_rate < 0 ? "neg" : ""),
      stat("Lines", fmt(m.lines || 0))),
    pi.partial ? partialFlag(pi.text) : null,
    sp.coverage < 0.9 ? h("p", { class: "tiny warn" }, `${fmt((1 - sp.coverage) * 100)}% of spending has no category yet: tap a line below, or ask the bot to write rules.`) : null));

  const gParts = GROUP_ORDER.filter((g) => split.byGroup[g] > 0).map((g) => ({ key: g, label: GROUP_LABEL[g], value: split.byGroup[g], color: groupColor(g) }));
  out.push(card("By group", { sub: `${fmt(split.gross)} ${BASE} out` },
    donut(gParts, { label: `Spending by group, ${monthName(m.month)}`, center: "money out", sel: null, onSelect: (k) => { if (k) groupSheet(k, m, d, ctx); } }),
    note("Tap a group to see what's in it.")));

  const CATS = 10;
  const catMax = Math.max(1, ...split.out.map(([, v]) => v), ...split.back.map(([, v]) => v));
  out.push(card("By category", { sub: "Coloured by group" },
    hbars((st.allCats ? split.out : split.out.slice(0, CATS)).map(([c, v]) => ({ label: catName(c), value: v, color: groupColor(groupOf(c, groups)), sub: GROUP_LABEL[groupOf(c, groups)], onClick: () => categorySheet(c, m, d, ctx) })),
      { label: "Spending by category", fmtV: (v) => fmt(v), max: catMax }),
    note("Tap a category for its merchants and lines."),
    split.out.length > CATS && !st.allCats ? h("button", { type: "button", class: "morebtn", onclick: () => { st.allCats = true; ctx.rerender(); } }, `Show all ${split.out.length} categories`) : null,
    split.back.length ? h("h3", null, "Money back") : null,
    split.back.length ? hbars(split.back.map(([c, v]) => ({ label: catName(c), value: v, color: "var(--pos)", right: `+${fmt(v)}` })), { label: "Refunds and claims", max: catMax }) : null,
    split.back.length ? note("Refunds and claims come back in. They're netted into the month's total, not drawn as negative bars.") : null));

  const merch = (m.merchants || []).slice(0, 8);
  if (merch.length) {
    out.push(card("Top merchants", null,
      hbars(merch.map(([name, v]) => ({ label: name, value: Math.max(0, v), right: v < 0 ? `+${fmt(-v, 2)} back` : fmt(v, 2) })), { label: "Top merchants", fmtV: (v) => fmt(v, 2) })));
  }

  const lines = monthLines(d, m.month);
  const LIMIT = 40;
  const shown = st.allLines ? lines : lines.slice(0, LIMIT);
  out.push(card("Lines", { sub: `${lines.length}${lines.length >= 150 ? "+" : ""} this month · tap to re-categorise` },
    lines.length ? h("div", { class: "rows" }, shown.map((t) => h("button", { class: "row", type: "button", onclick: () => catSheet(t, d.categories, ctx) },
      h("span", { class: "l" }, h("b", null, t.merchant || t.desc),
        h("span", null, `${dayName(t.date)} · ${t.account} · `,
          h("span", { class: "cat-tag" }, h("i", { class: "sw", style: { background: t.category ? groupColor(groupOf(t.category, groups)) : "var(--g-other)" } }), t.category ? title(t.category) : "no category"),
          ctx.queue.some((q) => q.ref === t.id) ? " · waiting for bot" : "")),
      h("span", { class: `r num ${t.amount > 0 ? "pos" : ""}` }, `${t.amount > 0 ? "+" : ""}${fmt(t.amount, 2)}`, t.currency !== BASE ? h("small", null, t.currency) : null))))
      : h("p", { class: "empty" }, "No lines this month."),
    lines.length > shown.length ? h("button", { type: "button", class: "morebtn", onclick: () => { st.allLines = true; ctx.rerender(); } }, `Show all ${lines.length} lines`) : null));
  return out;
}

// ------------------------------------------------------------------ everyday
/**
 * Day-to-day spending: the part you control. Everything outside the
 * committed, chosen and one-off groups, with travel in or out, against the
 * monthly budget in the snapshot (finance/data/reference/budgets.json).
 */
function viewDay(d, ctx) {
  const st = ctx.st;
  const groups = d.category_groups || {};
  const sp = d.spending || { months: [] };
  const lines = d.lines || sp.recent || [];
  const months = sp.months.slice(-6).map((x) => x.month);
  if (!months.length) return [card("No statements yet", null, note("Send a card or bank statement to the money bot. Day-to-day spending shows up here once lines are filed."))];
  if (!st.dayMonth || !months.includes(st.dayMonth)) st.dayMonth = defaultMonth(months, d.as_of);
  const month = st.dayMonth;
  const travel = st.dayTravel !== "ex";
  const through = d.accounts_through || {};
  const per = months.map((mm) => ({ mm, sum: daySummary(lines, mm, groups, { travel }), pi: partialInfo(mm, through, d.spend_accounts, dayName) }));
  const cur = per.find((x) => x.mm === month);
  const sum = cur.sum;
  const full = per.filter((x) => !x.pi.partial);
  const avg = full.length ? full.reduce((a, x) => a + x.sum.net, 0) / full.length : null;
  const budget = (d.budgets || {})[travel ? "day_to_day" : "day_to_day_ex_travel"] || null;
  const mObj = sp.months.find((x) => x.month === month);
  const out = [];

  out.push(h("div", { class: "controls" },
    chips([...months].reverse().map((mm) => [mm, monthShort(mm)]), month, (v) => { st.dayMonth = v; ctx.rerender(); }, "Month", "scroll"),
    segmented([["with", "With travel"], ["ex", "Without travel"]], travel ? "with" : "ex", (v) => { st.dayTravel = v; ctx.rerender(); }, "Travel")));

  // hero: net spend against budget
  const used = budget ? sum.net / budget : null;
  out.push(card(null, { cls: "hero", label: `Day-to-day in ${monthName(month)}` },
    h("p", { class: "eyebrow" }, `Day-to-day · ${monthName(month)}${travel ? "" : " · without travel"}`),
    h("p", { class: "big num" }, fmt(sum.net), h("small", null, BASE)),
    h("p", { class: "tiny" }, sum.back > 0 ? `${fmt(sum.gross)} out, ${fmt(sum.back)} back from friends, claims and refunds.` : `${fmt(sum.gross)} out.`),
    budget ? h("div", { class: "budget", role: "img", "aria-label": `${share(used, 0)} of the ${fmt(budget)} budget` },
      h("span", { class: "track" }, h("i", { class: `fill${used > 1 ? " over" : ""}`, style: { width: `${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%` } })),
      h("p", null, used > 1 ? h("b", { class: "neg" }, `${fmt(sum.net - budget)} over`) : h("b", null, `${fmt(budget - sum.net)} left`), ` of a ${fmt(budget)} budget`)) : null,
    h("div", { class: "stats" },
      stat("Full-month avg", avg == null ? "–" : fmt(avg), full.length ? plural(full.length, "month") : null),
      stat("vs average", avg == null ? "–" : smoney(sum.net - avg), null, avg != null && sum.net > avg ? "neg" : ""),
      stat("Lines", fmt(sum.lines.length))),
    cur.pi.partial ? partialFlag(cur.pi.text) : null));

  // pace through the month
  const isNow = String(d.as_of || "").startsWith(month);
  const upTo = isNow ? Number(String(d.as_of).slice(8, 10)) : null;
  const cum = cumulative(sum.days, month, upTo);
  out.push(card("Through the month", { sub: budget ? "Running total against an even pace to the budget" : "Running total" },
    paceChart(cum.pts, { daysInMonth: cum.daysInMonth, budget, w: ctx.w - 32, label: `Day-to-day through ${monthName(month)}` })));

  // E-wallet top-ups are a blind spot until each is labelled (food, travel, ...)
  const unlabelled = lines.filter((t) => t.date.startsWith(month) && t.category === "e_wallet" && t.amount < 0);
  if (unlabelled.length) {
    const tot = unlabelled.reduce((a, t) => a - t.amount, 0);
    out.push(card("E-wallet top-ups to label", { sub: `${plural(unlabelled.length, "top-up")} · ${fmt(tot)} ${BASE} with no category yet` },
      h("div", { class: "rows" }, [...unlabelled].sort((a, b) => a.amount - b.amount).slice(0, st.allWallet ? undefined : 6).map((t) => lineRow(t, d, ctx))),
      unlabelled.length > 6 && !st.allWallet ? h("button", { type: "button", class: "morebtn", onclick: () => { st.allWallet = true; ctx.rerender(); } }, `Show all ${unlabelled.length}`) : null,
      note("Tap a top-up and pick what it paid for (food, travel, shopping, family…). Once labelled it moves into the right tracker.")));
  }

  out.push(trackerCard(d, ctx, months, month, through));

  // six months by category
  const totals = new Map();
  for (const x of per) for (const [c, v] of x.sum.categories) totals.set(c, (totals.get(c) || 0) + v);
  const topCats = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
  const series = [...topCats.map((c, i) => ({ key: c, label: catName(c), color: rankColor(i) })), { key: "_other", label: "Everything else", color: "var(--s-other)" }];
  const cols = per.map((x) => {
    const values = { _other: 0 };
    for (const [c, v] of x.sum.categories) { if (topCats.includes(c)) values[c] = v; else values._other += v; }
    return { key: x.mm, label: monthShort(x.mm), sub: x.pi.partial ? "partial" : "", aria: `${monthName(x.mm)}${x.pi.partial ? " (partial)" : ""}`, values };
  });
  out.push(card("Six months", { sub: "Money out by category. Tap a month." },
    stackedBars(cols, series, { w: ctx.w - 32, label: "Day-to-day per month by category", sel: month, onSelect: (k) => { st.dayMonth = k; ctx.rerender(); } }),
    legend(series.map((se) => [se.label, se.color]))));

  // categories this month
  out.push(card("Where it went", { sub: "Tap a category for its merchants and lines" },
    sum.categories.length ? hbars(sum.categories.map(([c, v]) => ({ label: catName(c), value: v, sub: share(v / Math.max(1, sum.gross), 0),
      color: topCats.includes(c) ? rankColor(topCats.indexOf(c)) : "var(--s-other)", onClick: mObj ? () => categorySheet(c, mObj, d, ctx) : null })),
    { label: "Day-to-day by category", fmtV: (v) => fmt(v) }) : h("p", { class: "empty" }, "Nothing this month.")));

  // habits
  if (sum.habits.length) {
    out.push(card("Habits", { sub: "Counts and totals this month" },
      h("div", { class: "habits" }, sum.habits.map((x) => h("div", { class: "habit" },
        h("span", null, h("b", null, x.label), ` · ${x.count}×`), h("b", { class: "num" }, fmt(x.total)), h("small", null, x.hint))))));
  }

  // biggest lines and merchants
  if (sum.lines.length) {
    out.push(card("Biggest lines", { sub: "Tap one to re-categorise" },
      h("div", { class: "rows" }, sum.lines.slice(0, 8).map((t) => lineRow(t, d, ctx)))));
  }
  if (sum.merchants.length) {
    out.push(card("Top merchants", null,
      hbars(sum.merchants.slice(0, 8).map(([name, v]) => ({ label: name, value: v, color: "var(--g-day)" })), { label: "Day-to-day by merchant", fmtV: (v) => fmt(v, 2) })));
  }
  out.push(note(`Day-to-day is everything outside committed bills, chosen recurring costs and one-offs. ${budget ? "The budget is set in the money bot: tell it a new number to change it." : ""}`));
  return out;
}

// ------------------------------------------------------------------ trackers
const trColor = (tr, k, i) => (tr.key === "food" ? `var(--f-${k})` : rankColor(i));

/** One tracker (food, fun, shopping, travel): the month against its budget, types, six months, top places. */
function trackerCard(d, ctx, months, month, through) {
  const st = ctx.st;
  const tr = TRACKERS.find((x) => x.key === st.tracker) || TRACKERS[0];
  const lines = d.lines || (d.spending || {}).recent || [];
  const per = months.map((mm) => ({ mm, f: trackerSummary(lines, mm, tr), pi: partialInfo(mm, through, d.spend_accounts, dayName) }));
  const f = per.find((x) => x.mm === month).f;
  const full = per.filter((x) => !x.pi.partial);
  const avg = full.length ? full.reduce((a, x) => a + x.f.total, 0) / full.length : null;
  const budget = (d.budgets || {})[tr.budget] || null;
  const used = budget ? f.total / budget : null;
  const mObj = (d.spending.months || []).find((x) => x.month === month);
  const shown = tr.types.filter(([k]) => f.by[k].count || per.some((x) => x.f.by[k].count));
  const tile = ([k, label, unit]) => {
    const b = f.by[k];
    const i = tr.types.findIndex(([kk]) => kk === k);
    return h("div", { class: "food-tile" },
      h("span", { class: "k" }, h("i", { class: "sw", style: { background: trColor(tr, k, i) } }), label),
      h("b", { class: "num" }, fmt(b.total)),
      h("small", null, b.count ? `${plural(b.count, unit)} · avg ${fmt(b.total / b.count)}` : "none"));
  };
  const cols = per.map((x) => ({ key: x.mm, label: monthShort(x.mm), sub: x.pi.partial ? "partial" : "", aria: `${monthName(x.mm)}${x.pi.partial ? " (partial)" : ""}`,
    values: Object.fromEntries(tr.types.map(([k]) => [k, x.f.by[k].total])) }));
  const series = tr.types.map(([k, label], i) => ({ key: k, label, color: trColor(tr, k, i) }));
  const firstCat = tr.cats.find((c) => (mObj && (mObj.categories || {})[c]));
  return card(null, { label: `${tr.title} tracker` },
    chips(TRACKERS.map((x) => [x.key, x.key === "fun" ? "Fun" : x.title]), tr.key, (v) => { st.tracker = v; ctx.rerender(); }, "Tracker", "scroll"),
    h("h2", null, tr.title), h("p", { class: "sub" }, `${tr.sub} · ${monthName(month)}`),
    h("p", { class: "big num" }, fmt(f.total), h("small", null, BASE)),
    budget ? h("div", { class: "budget", role: "img", "aria-label": `${share(used, 0)} of the ${fmt(budget)} ${tr.title.toLowerCase()} budget` },
      h("span", { class: "track" }, h("i", { class: `fill${used > 1 ? " over" : ""}`, style: { width: `${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%` } })),
      h("p", null, used > 1 ? h("b", { class: "neg" }, `${fmt(f.total - budget)} over`) : h("b", null, `${fmt(budget - f.total)} left`), ` of a ${fmt(budget)} budget`))
      : h("p", { class: "tiny" }, "No budget set: tell the money bot one if you want a target."),
    shown.length ? h("div", { class: "food-tiles" }, shown.map(tile)) : h("p", { class: "empty" }, "Nothing in the last six months."),
    h("div", { class: "stats" },
      stat("Full-month avg", avg == null ? "–" : fmt(avg), full.length ? plural(full.length, "month") : null),
      stat("Average line", f.avg == null ? "–" : fmt(f.avg), f.count ? plural(f.count, "line") : null),
      stat(`${BASE} 100 or more`, f.big.count ? `${f.big.count}×` : "0", f.big.count ? `${fmt(f.big.total)} · ${share(f.big.total / Math.max(1, f.total), 0)}` : null)),
    h("h3", null, "Six months"),
    stackedBars(cols, series.filter((se) => shown.some(([k]) => k === se.key)), { w: ctx.w - 32, h: 160, label: `${tr.title} per month by type`, sel: month, onSelect: (k) => { st.dayMonth = k; ctx.rerender(); } }),
    legend(series.filter((se) => shown.some(([k]) => k === se.key)).map((se) => [se.label, se.color])),
    f.places.length ? h("h3", null, "Top places") : null,
    f.places.length ? hbars(f.places.slice(0, 6).map(([p, v]) => {
      const k = tr.typeOf(f.lines.find((t) => (t.merchant || t.desc) === p)) || tr.types[0][0];
      return { label: p, value: v, color: trColor(tr, k, tr.types.findIndex(([kk]) => kk === k)) };
    }), { label: `${tr.title} by place`, fmtV: (v) => fmt(v, 2) }) : null,
    f.lines.length ? h("h3", null, "Lines") : null,
    f.lines.length ? h("div", { class: "rows" }, [...f.lines].sort((a, b) => a.amount - b.amount).slice(0, 12).map((t) => lineRow(t, d, ctx))) : null,
    mObj && firstCat ? h("button", { type: "button", class: "morebtn", onclick: () => categorySheet(firstCat, mObj, d, ctx) }, `All ${catName(firstCat).toLowerCase()} lines this month`) : null,
    tr.note ? note(tr.note) : null);
}

// ------------------------------------------------------------------ drill-down
/** Every line of a month: the snapshot's `lines` (last 7 months), else the 150 most recent. */
function monthLines(d, month) {
  return (d.lines || (d.spending || {}).recent || []).filter((t) => t.date.startsWith(month));
}

/** Money out per merchant for one category in one month, from the lines (home currency only, refunds netted). */
function catMerchants(lines, cat) {
  const by = new Map();
  for (const t of lines) {
    if ((t.category || "uncategorised") !== cat || t.currency !== BASE || t.kind === "TRANSFER" || t.kind === "INCOME") continue;
    by.set(t.merchant || t.desc, (by.get(t.merchant || t.desc) || 0) - t.amount);
  }
  return [...by.entries()].filter(([, v]) => Math.abs(v) >= 0.01).sort((a, b) => b[1] - a[1]);
}

const lineRow = (t, d, ctx) => h("button", { class: "row", type: "button", onclick: () => catSheet(t, d.categories, ctx) },
  h("span", { class: "l" }, h("b", null, t.merchant || t.desc), h("span", null, `${dayName(t.date)} · ${t.account}`)),
  h("span", { class: `r num ${t.amount > 0 ? "pos" : ""}` }, `${t.amount > 0 ? "+" : ""}${fmt(t.amount, 2)}`, t.currency !== BASE ? h("small", null, t.currency) : null));

/** Group -> its categories this month (tap one for merchants and lines), plus the 6-month trend. */
function groupSheet(g, m, d, ctx) {
  const groups = d.category_groups || {};
  const split = splitMonth(m, groups);
  const cats = split.out.filter(([c]) => groupOf(c, groups) === g);
  const total = cats.reduce((a, [, v]) => a + v, 0);
  const months = (d.spending.months || []).slice(-6);
  const trend = months.map((x) => [x.month, splitMonth(x, groups).byGroup[g] || 0]);
  // Average over full months only: a partial month (statements not in yet) would drag it down.
  const full = trend.filter(([mm]) => !partialInfo(mm, d.accounts_through || {}, d.spend_accounts, dayName).partial);
  const avg = full.length ? full.reduce((a, [, v]) => a + v, 0) / full.length : null;
  openSheet(h("h2", { id: "sheet-title" }, `${GROUP_LABEL[g]} · ${monthName(m.month)}`),
    h("p", { class: "tiny" }, GROUP_HINT[g]),
    h("div", { class: "stats" }, stat("This month", fmt(total)), stat("Full-month avg", avg == null ? "–" : fmt(avg), full.length ? `${plural(full.length, "month")}` : null), stat("Of money out", share(total / Math.max(1, split.gross), 0))),
    h("h3", null, "What's in it"),
    cats.length ? hbars(cats.map(([c, v]) => ({ label: catName(c), value: v, sub: share(v / Math.max(1, total), 0), color: groupColor(g), onClick: () => categorySheet(c, m, d, ctx, g) })),
      { label: `${GROUP_LABEL[g]} by category`, fmtV: (v) => fmt(v) }) : h("p", { class: "empty" }, "Nothing in this group this month."),
    cats.length ? note("Tap a category for its merchants and lines.") : null,
    h("h3", null, "Last six months"),
    hbars(trend.map(([mm, v]) => ({ label: monthName(mm), value: v, color: mm === m.month ? groupColor(g) : "var(--axis)" })), { label: `${GROUP_LABEL[g]} by month`, fmtV: (v) => fmt(v) }));
}

/** Category -> merchants and lines this month, plus its 6-month trend. `from` adds a way back to the group. */
function categorySheet(cat, m, d, ctx, from = null) {
  const groups = d.category_groups || {};
  const g = groupOf(cat, groups);
  const lines = monthLines(d, m.month).filter((t) => (t.category || "uncategorised") === cat);
  const merch = catMerchants(lines, cat);
  const total = (m.categories || {})[cat] || 0;
  const months = (d.spending.months || []).slice(-6);
  const trend = months.map((x) => [x.month, Math.max(0, (x.categories || {})[cat] || 0)]);
  openSheet(from ? h("button", { type: "button", class: "morebtn back", onclick: () => groupSheet(from, m, d, ctx) }, `← ${GROUP_LABEL[from]}`) : null,
    h("h2", { id: "sheet-title" }, `${catName(cat)} · ${monthName(m.month)}`),
    h("p", { class: "tiny" }, `${GROUP_LABEL[g]} · ${fmt(total)} ${BASE} net · ${plural(lines.length, "line")}`),
    merch.length ? h("h3", null, "By merchant") : null,
    merch.length ? hbars(merch.slice(0, 15).map(([name, v]) => ({ label: name, value: Math.max(0, v), right: v < 0 ? `+${fmt(-v, 2)} back` : fmt(v, 2), color: groupColor(g) })), { label: `${catName(cat)} by merchant`, fmtV: (v) => fmt(v, 2) }) : null,
    merch.length > 15 ? h("p", { class: "tiny" }, `${merch.length - 15} more merchants in the lines below.`) : null,
    h("h3", null, "Last six months"),
    hbars(trend.map(([mm, v]) => ({ label: monthName(mm), value: v, color: mm === m.month ? groupColor(g) : "var(--axis)" })), { label: `${catName(cat)} by month`, fmtV: (v) => fmt(v) }),
    h("h3", null, "Lines"),
    lines.length ? h("div", { class: "rows" }, lines.map((t) => lineRow(t, d, ctx))) : h("p", { class: "empty" }, "No lines."),
    note("Tap a line to move it to another category."));
}

function catSheet(t, cats, ctx) {
  const pick = h("div", { class: "chips choose", role: "group", "aria-label": "Category" }, cats.map((c) => h("button", { class: "chip", type: "button", "aria-pressed": String(c === t.category),
    onclick: () => ctx.recategorise(t, c) }, title(c))));
  openSheet(h("h2", { id: "sheet-title" }, t.merchant || t.desc), h("p", { class: "tiny" }, `${dayName(t.date)} · ${t.account} · ${fmt(t.amount, 2)} ${t.currency}`),
    h("p", { class: "small" }, t.desc), h("p", { class: "eyebrow" }, "Category"), pick,
    h("p", { class: "tiny" }, "The bot files the change and remembers it for this line. To change the rule for this merchant, tell the bot."));
}

// ------------------------------------------------------------------ recurring
const SEC_COLOR = { insurance: "var(--s1)", subscriptions: "var(--s5)", regular: "var(--s3)", mortgage: "var(--s2)", taxes: "var(--s4)", others: "var(--g-chosen)" };
const secName = (k) => (REC_SECTIONS.find(([x]) => x === k) || [k, title(k)])[1];
const CADENCE = { weekly: "Weekly", fortnightly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", "half-yearly": "Twice a year", annual: "Yearly", irregular: "On and off" };
const recTag = (i) => (i.status === "stopped?" ? ["Stopped?", "warn"] : i.paid_from !== "cash" ? [i.paid_from, "other-src"]
  : i.status === "not seen yet" ? ["Not seen yet", ""] : i.note === "Not on your policy list." ? ["Not on policy list", "warn"] : null);

function recRow(i, d) {
  const tag = recTag(i);
  const when = i.status === "stopped?" ? `last ${dayName(i.last)}` : i.next ? `next ${dayName(i.next)}` : i.last ? `last ${dayName(i.last)}` : "";
  return h("button", { class: `row${i.status === "stopped?" ? " dim" : ""}`, type: "button", onclick: () => recSheet(i, d) },
    h("span", { class: "l" }, h("b", null, i.name),
      h("span", null, tag ? h("span", { class: `tag ${tag[1]}` }, tag[0]) : null, [CADENCE[i.cadence] || title(i.cadence), when].filter(Boolean).join(" · "))),
    h("span", { class: "r num" }, fmt(i.cadence === "irregular" || i.cadence === "weekly" || i.cadence === "fortnightly" ? i.monthly : i.amount, i.amount < 100 ? 2 : 0),
      h("small", null, i.cadence === "monthly" ? "a month" : i.cadence === "irregular" || i.cadence === "weekly" || i.cadence === "fortnightly" ? "a month, average" : `≈ ${fmt(i.monthly)} a month`)));
}

function recSheet(i, d) {
  const rows = [["How often", CADENCE[i.cadence] || title(i.cadence)], ["Usual amount", `${fmt(i.amount, 2)} ${BASE}`], ["Per month", `${fmt(i.monthly, 2)} ${BASE}`],
    ["Per year", `${fmt(i.yearly)} ${BASE}`], ["Last paid", i.last ? dayName(i.last) : "–"], ["Next due", i.next ? dayName(i.next) : "–"],
    ["Paid from", i.paid_from === "cash" ? i.account || "Bank or card" : i.paid_from], ["Seen", i.count ? plural(i.count, "payment") : "not in the statements yet"], ["Found from", i.source]];
  const hist = (i.history || []).slice(-12);
  openSheet(h("h2", { id: "sheet-title" }, i.name),
    h("p", { class: "tiny" }, `${secName(i.section)}${i.category ? ` · ${catName(i.category)}` : ""}${i.status !== "active" ? ` · ${i.status}` : ""}`),
    h("table", { class: "data" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { scope: "row" }, k), h("td", { class: "r" }, v))))),
    i.policies && i.policies.length ? h("h3", null, "Policies") : null,
    i.policies && i.policies.length ? h("ul", { class: "plain" }, i.policies.map((x) => h("li", null, x))) : null,
    i.note ? note(i.note) : null,
    hist.length ? h("h3", null, hist.length < (i.history || []).length ? "Last 12 payments" : "Payments") : null,
    hist.length ? hbars([...hist].reverse().map(([dt, v]) => ({ label: dayName(dt), value: v, color: SEC_COLOR[i.section] })), { label: `${i.name} payments`, fmtV: (v) => fmt(v, 2) }) : null,
    i.status === "stopped?" ? note("Not seen for over two cycles in statements that run past when it was due. If it has really ended, it drops out of the totals on its own; it already does here.") : null);
}

function recMonthSheet(c) {
  const dated = c.items.filter((x) => !x.spread);
  const spread = c.items.filter((x) => x.spread);
  const spreadTot = spread.reduce((a, x) => a + x.amount, 0);
  openSheet(h("h2", { id: "sheet-title" }, `Recurring · ${monthName(c.month)}`),
    h("p", { class: "tiny" }, `${fmt(c.total)} ${BASE} expected`),
    h("div", { class: "rows" }, dated.map((x) => h("div", { class: "row" },
      h("span", { class: "l" }, h("b", null, h("i", { class: "sw", style: { background: SEC_COLOR[x.section] } }), x.name), h("span", null, `${dayName(x.date)} · ${secName(x.section)}`)),
      h("span", { class: "r num" }, fmt(x.amount, x.amount < 100 ? 2 : 0))))),
    spread.length ? h("h3", null, `Spread across the month · ${fmt(spreadTot)}`) : null,
    spread.length ? hbars(spread.sort((a, b) => b.amount - a.amount).map((x) => ({ label: x.name, value: x.amount, color: SEC_COLOR[x.section] })), { label: "Weekly and on-and-off payments", fmtV: (v) => fmt(v) }) : null,
    spread.length ? note("Weekly and on-and-off payments have no due date, so they count at their monthly average.") : null);
}

function heaviest(c) {
  const big = c.items.filter((x) => !x.spread && x.cadence !== "monthly").sort((a, b) => b.amount - a.amount).slice(0, 3);
  const why = big.length ? `, with ${andList(big.map((x) => `${x.name} (${fmt(x.amount)})`))} on top of the monthly bills` : "";
  return `Heaviest month: ${monthName(c.month)} at ${fmt(c.total)}${why}. Yearly bills bunch up, so set cash aside for them.`;
}

function viewRecurring(d, ctx) {
  const st = ctx.st;
  const rec = d.recurring;
  if (!rec || !(rec.items || []).length) return [card("No recurring payments yet", null, note("Once a few months of statements are filed, payments that repeat show up here."))];
  const live = rec.items.filter((i) => i.status !== "stopped?");
  const other = rec.monthly_all - rec.monthly_cash;
  const months = (d.spending || { months: [] }).months.filter((m) => !partialInfo(m.month, d.accounts_through || {}, d.spend_accounts, dayName).partial).slice(-6);
  const avgSpend = months.length ? months.reduce((a, m) => a + (m.spend || 0), 0) / months.length : null;
  const out = [];

  out.push(card(null, { cls: "hero", label: "Recurring payments" },
    h("p", { class: "eyebrow" }, "Recurring · per month"),
    h("p", { class: "big num" }, fmt(rec.monthly_all), h("small", null, BASE)),
    h("p", { class: "tiny" }, `${fmt(rec.monthly_all * 12)} a year across ${plural(live.length, "payment")}. Yearly and quarterly bills are counted as a monthly share.`),
    h("div", { class: "stats" },
      stat("From the bank", fmt(rec.monthly_cash), "cash and cards"),
      stat("Elsewhere", fmt(other), "not from a bank or card"),
      stat("Of money out", avgSpend ? share(rec.monthly_cash / avgSpend, 0) : "–", avgSpend ? `avg ${fmt(avgSpend)} a month` : null))));

  const secs = REC_SECTIONS.filter(([k]) => (rec.sections || {})[k] > 0);
  out.push(card("What it's made of", { sub: "Per month, by kind" },
    donut(secs.map(([k, l]) => ({ key: k, label: l, value: rec.sections[k], color: SEC_COLOR[k], sub: plural(live.filter((i) => i.section === k).length, "payment") })),
      { label: "Recurring by kind", center: "a month", fmtV: (v) => fmt(v), sel: st.recDonut, onSelect: (k) => { st.recDonut = k; } })));

  const cal = recurringCalendar(rec, 12);
  const cols = cal.map((c, k) => ({ key: c.month, label: monthShort(c.month), sub: k ? "" : "rest", aria: `${monthName(c.month)}${k ? "" : " (rest of the month)"}`, values: c.by }));
  const peak = cal.slice(1).reduce((a, c) => (c.total > a.total ? c : a), cal[1] || cal[0]);
  out.push(card("Next 12 months", { sub: "What should go out each month. Tap a month for the list." },
    stackedBars(cols, secs.map(([k, l]) => ({ key: k, label: l, color: SEC_COLOR[k] })), { w: ctx.w - 32, label: "Recurring payments by month, next 12 months",
      onSelect: (k) => recMonthSheet(cal.find((c) => c.month === k)),
      // twelve labels collide on a phone: print the first month and the peaks
      showValue: (i, t) => i === 0 || ((i === 1 || t[i] > t[i - 1] * 1.02) && (i === t.length - 1 || t[i] > t[i + 1] * 1.02)) }),
    legend(secs.map(([k, l]) => [l, SEC_COLOR[k]])),
    peak ? note(heaviest(peak)) : null));

  const soon = upcoming(rec, 30);
  out.push(card("Next 30 days", { sub: soon.length ? `${plural(soon.length, "payment")} · ${fmt(soon.reduce((a, i) => a + i.amount, 0))} ${BASE}` : "Nothing due" },
    soon.length ? h("div", { class: "rows" }, soon.slice(0, st.allSoon ? undefined : 8).map((i) => h("button", { class: "row", type: "button", onclick: () => recSheet(i, d) },
      h("span", { class: "l" }, h("b", null, h("i", { class: "sw", style: { background: SEC_COLOR[i.section] } }), i.name), h("span", null, `${dayName(i.due)} · ${i.paid_from === "cash" ? i.account || "bank" : i.paid_from}`)),
      h("span", { class: "r num" }, fmt(i.amount, i.amount < 100 ? 2 : 0))))) : null,
    soon.length > 8 && !st.allSoon ? h("button", { type: "button", class: "morebtn", onclick: () => { st.allSoon = true; ctx.rerender(); } }, `Show all ${soon.length}`) : null,
    note("Weekly and on-and-off payments aren't listed here; they're in their sections below.")));

  if (!st.recSec || (st.recSec !== "all" && !secs.some(([k]) => k === st.recSec))) st.recSec = "all";
  out.push(h("div", { class: "controls" },
    chips([["all", "All"], ...secs.map(([k, l]) => [k, l])], st.recSec, (v) => { st.recSec = v; ctx.rerender(); }, "Kind", "scroll")));
  for (const [k, l] of REC_SECTIONS.filter(([k]) => st.recSec === "all" || k === st.recSec)) {
    const items = rec.items.filter((i) => i.section === k);
    if (!items.length) continue;
    const on = items.filter((i) => i.status !== "stopped?");
    const off = items.filter((i) => i.status === "stopped?");
    out.push(card(h("h2", { class: "kind-h" }, h("i", { class: "sw", style: { background: SEC_COLOR[k] } }), l),
      { label: l, sub: `${fmt(rec.sections[k] || 0)} a month · ${fmt((rec.sections[k] || 0) * 12)} a year` },
      h("div", { class: "rows" }, on.map((i) => recRow(i, d))),
      off.length ? h("h3", null, "Looks stopped") : null,
      off.length ? h("div", { class: "rows" }, off.map((i) => recRow(i, d))) : null,
      off.length ? note("Not in the totals: no payment for over two cycles.") : null));
  }
  out.push(note("Found from repeat payments in your statements, your insurance policy list, and what you've told the bot (like a payment that never shows on a statement). Tell the money bot if something is missing or has ended."));
  return out;
}

// ------------------------------------------------------------------ holdings
const posLabel = (p) => (/[=]/.test(p.symbol) || p.symbol.length > 9 ? p.name || p.symbol : p.symbol);
const pnlText = (x) => (x == null ? "no P&L" : `${x >= 0 ? "▲" : "▼"} ${pct(x, Math.abs(x) < 0.1 ? 1 : 0)}`);
const pnlCls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");

function posSheet(p, d) {
  const rows = [["Account", p.account], ["Quantity", fmt(p.qty, 4)], ["Price", `${fmt(p.mark, 4)} ${p.currency}`],
    ["Value", `${fmt(p.local, 0)} ${p.currency} · ${fmt(p.value)} ${BASE}`], ["Cost", `${fmt(p.cost)} ${BASE}`],
    ["P&L", `${p.pnl >= 0 ? "+" : "−"}${fmt(Math.abs(p.pnl))} ${BASE} (${pct(p.pnl_pct)})`], ["Weight", `${fmt(p.weight * 100, 1)}%`], ["Price from", p.mark_source]];
  openSheet(h("h2", { id: "sheet-title" }, p.name || p.symbol), h("p", { class: "tiny" }, `${p.id} · ${kindName(p.kind)}`),
    h("table", { class: "data" }, h("tbody", null, rows.map(([k, val]) => h("tr", null, h("th", { scope: "row" }, k), h("td", { class: `r num ${k === "P&L" ? pnlCls(p.pnl) : ""}` }, val))))));
}

function viewHoldings(d, ctx) {
  const st = ctx.st;
  const all = d.positions || [];
  const present = KIND_ORDER.filter((k) => all.some((p) => p.kind === k)).concat([...new Set(all.map((p) => p.kind))].filter((k) => !KIND_ORDER.includes(k)));
  if (!st.kind || (st.kind !== "all" && !present.includes(st.kind))) st.kind = "all";
  const list = all.filter((p) => st.kind === "all" || p.kind === st.kind);
  const total = list.reduce((a, p) => a + p.value, 0);
  const pnl = list.reduce((a, p) => a + p.pnl, 0);
  const out = [];
  out.push(h("div", { class: "controls" },
    chips([["all", "All"], ...present.map((k) => [k, kindName(k)])], st.kind, (v) => { st.kind = v; ctx.rerender(); }, "Asset kind", "scroll")));

  const open = (p) => posSheet(p, d);

  const items = list.filter((p) => p.value > 0);
  const TOP = 11;
  const top = items.slice(0, TOP);
  const rest = items.slice(TOP);
  const restV = rest.reduce((a, p) => a + p.value, 0);
  const cells = top.map((p) => ({ key: p.id, label: posLabel(p), sub: `${share(p.weight)} · ${money(p.value)}`, value: p.value, color: kindColor(p.kind), onClick: () => open(p) }));
  if (restV > 0) cells.push({ key: "rest", label: `+${rest.length}`, aria: `${rest.length} smaller positions`, sub: `${share(rest.reduce((a, p) => a + p.weight, 0))} · ${money(restV)}`, value: restV, color: "var(--k-other)" });
  const kindsShown = [...new Set(top.map((p) => p.kind))];
  out.push(card(st.kind === "all" ? `${list.length} positions` : `${kindName(st.kind)}: ${plural(list.length, "position")}`,
    { sub: h("span", null, `${money(total)} ${BASE} · P&L `, h("span", { class: pnl >= 0 ? "pos" : "neg" }, `${pnl >= 0 ? "▲ " : "▼ "}${smoney(pnl)}`)) },
    cells.length ? treemap(cells, { w: ctx.w - 32, h: st.kind === "all" ? 200 : 160, label: "Weights by position" }) : null,
    kindsShown.length > 1 ? legend(kindsShown.map((k) => [kindName(k), kindColor(k)])) : null,
    note("Box size is value; % is the share of net worth, as in the rows below. Tap a box for details.")));

  for (const k of present.filter((x) => st.kind === "all" || x === st.kind)) {
    const ps = list.filter((p) => p.kind === k);
    if (!ps.length) continue;
    const v = ps.reduce((a, p) => a + p.value, 0);
    const pl = ps.reduce((a, p) => a + p.pnl, 0);
    out.push(card(h("h2", { class: "kind-h" }, h("i", { class: "sw", style: { background: kindColor(k) } }), kindName(k)),
      { label: kindName(k), sub: h("span", null, `${money(v)} ${BASE} · `, h("span", { class: pnlCls(pl) }, `${pl >= 0 ? "▲ " : "▼ "}${smoney(pl)}`)) },
      h("div", { class: "rows" }, ps.map((p) => h("button", { class: "row", type: "button", onclick: () => open(p) },
        h("span", { class: "l" }, h("b", null, p.name || p.symbol), h("span", null, `${p.symbol} · ${p.account}${p.mark_source === "none" || !p.mark ? " · no price" : ""}`)),
        h("span", { class: "r num" }, money(p.value), h("small", { class: pnlCls(p.pnl_pct) }, `${share(p.weight)} · ${pnlText(p.pnl_pct)}`)))))));
  }

  if (st.kind === "all" && (d.cash || []).length) {
    out.push(card("Cash and margin", { sub: `${money(d.cash_total)} ${BASE} net${d.margin_loans ? ` · margin loans ${money(d.margin_loans)}` : ""}` },
      h("div", { class: "rows" }, d.cash.map((c) => h("div", { class: "row" },
        h("span", { class: "l" }, h("b", null, `${c.account} ${c.currency}`), h("span", null, c.amount < 0 ? (c.stated ? "margin loan (broker statement)" : "negative, not explained yet") : c.stated ? "from a statement" : "from the flows")),
        h("span", { class: `r num ${c.amount < 0 ? "neg" : ""}` }, `${fmt(c.amount)} ${c.currency}`, h("small", null, `${money(c.base)} ${BASE}`)))))));
  }
  return out;
}

// ------------------------------------------------------------------ entry
const VIEWS = { overview: viewOverview, day: viewDay, flows: viewFlows, recurring: viewRecurring, spending: viewSpending, holdings: viewHoldings };

/** Render one tab of the snapshot `d` into `root`. */
export function renderTab(tab, root, d, ctx) {
  setBase(d.base);
  root.replaceChildren(...(VIEWS[tab] || viewOverview)(d, ctx).filter(Boolean));
}
