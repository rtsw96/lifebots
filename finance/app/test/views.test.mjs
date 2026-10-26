// Money app view logic: node --test finance/app/test/*.test.mjs (no browser, no network)
// Uses the synthetic fixture (test/fixture.json): every name and number in it is made up.
// The rendered views are checked in a browser by finance/app/preview/screenshots.mjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { BASE, setBase, daySummary, addMonths, change, flowMonths, flowTotals, foldSmall, groupOf, niceTicks, partialInfo, recurringCalendar, sankeyLayout, splitMonth, squarify, sumFlows, upcoming } from "../public/model.js";

const d = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url)));
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("fixture months balance: money in equals money out", () => {
  for (const f of d.flows) {
    const inflow = f.links.filter((l) => l[1] === "hub:in").reduce((a, l) => a + l[2], 0);
    const out = f.links.filter((l) => l[0] === "hub:in").reduce((a, l) => a + l[2], 0);
    close(inflow, out, 0.05);
  }
});

test("flow selections sum the right months; groups mode maps categories to groups", () => {
  assert.deepEqual(flowMonths(d.flows, "last3"), ["2026-04", "2026-05", "2026-06"]);
  assert.equal(flowMonths(d.flows, "all").length, d.flows.length);
  assert.deepEqual(flowMonths(d.flows, "1999-01"), ["2026-06"]);
  const all = sumFlows(d.flows, flowMonths(d.flows, "all"), "categories", d.category_groups);
  const want = d.flows.reduce((a, f) => a + f.inflow, 0);
  close(flowTotals(all).inflow, want, 0.5);
  const g = sumFlows(d.flows, ["2026-04"], "groups", d.category_groups);
  assert.ok(g.every((l) => !l[1].startsWith("cat:")));
  assert.ok(g.some((l) => l[1] === "grp:one_off"), "car purchase lands in one-off");
  assert.equal(groupOf("tax", d.category_groups), "committed");
  assert.equal(groupOf("dining", d.category_groups), "day");
});

test("folding small flows keeps totals and caps the category column", () => {
  const raw = sumFlows(d.flows, flowMonths(d.flows, "all"), "categories", d.category_groups);
  const { links, folded } = foldSmall(raw, { maxCat: 6 });
  const cats = new Set(links.filter((l) => l[1].startsWith("cat:")).map((l) => l[1]));
  assert.ok(cats.size <= 6, `${cats.size} category nodes`);
  assert.ok(folded["cat:~other"].length >= 2);
  const sum = (ls) => ls.reduce((a, l) => a + l[2], 0);
  close(sum(links), sum(raw), 0.05);
});

test("sankey layout: four columns, labels never overlap, widths follow value", () => {
  const raw = sumFlows(d.flows, ["2026-06"], "categories", d.category_groups);
  const { links } = foldSmall(raw);
  for (const width of [336, 366]) {
    const lay = sankeyLayout(links, { width, labelRight: 96, labelGap: 26 });
    assert.ok(Number.isFinite(lay.height) && lay.height > 200);
    for (let c = 0; c < 4; c++) {
      const col = lay.nodes.filter((n) => n.col === c).sort((a, b) => a.y - b.y);
      assert.ok(col.length, `column ${c} has nodes`);
      for (let i = 1; i < col.length; i++) {
        assert.ok(col[i].ly - col[i - 1].ly >= 26 - 1e-6, "labels at least one label apart");
        assert.ok(col[i].y >= col[i - 1].y + col[i - 1].h, "nodes don't overlap");
      }
      for (const n of col) assert.ok(n.x >= 0 && n.x + lay.nodeW <= width && n.y + n.h <= lay.height);
    }
    for (const l of lay.links) {
      assert.ok(l.w >= 1 && l.sy >= l.source.y - 1e-6 && l.sy <= l.source.y + l.source.h + 1e-6);
      close(l.value * lay.ky, Math.max(l.w, l.value * lay.ky), 1);
    }
    const hub = lay.nodes.find((n) => n.id === "hub:in");
    close(hub.vin, hub.vout, 0.05);
  }
});

test("a month's split: refunds go to 'back', never to a negative bar", () => {
  const m = d.spending.months.find((x) => x.month === "2026-03");
  const sp = splitMonth(m, d.category_groups);
  assert.ok(sp.out.every(([, v]) => v > 0));
  assert.ok(sp.back.some(([c]) => c === "dining"), "a refund bigger than the month's dining goes to back");
  assert.ok(sp.back.some(([c]) => c === "reimbursement"));
  close(sp.gross - sp.back_total, m.spend, 0.05);
  close(Object.values(sp.byGroup).reduce((a, v) => a + v, 0), sp.gross);
});

test("partial months name the accounts that are behind", () => {
  const p = partialInfo("2026-06", d.accounts_through, d.spend_accounts);
  assert.equal(p.partial, true);
  assert.deepEqual(p.missing, ["Card C"]);
  assert.equal(p.cut.length, 4);
  assert.match(p.text, /^Partial month: .*nothing yet from Card C\.$/);
  assert.equal(partialInfo("2026-04", d.accounts_through, d.spend_accounts).partial, false);
  assert.equal(partialInfo("2026-05", d.accounts_through, d.spend_accounts).cut[0][0], "Card C");
});

test("history change, ticks and treemap geometry", () => {
  const w = change(d.history, 7);
  close(w[0], 2100);
  assert.equal(change(d.history, 60), null);
  assert.equal(change([["2026-01-01", 5]], 7), null);
  const t = niceTicks(631318, 638432, 3);
  assert.ok(t[0] <= 631318 && t[t.length - 1] >= 638432 && t.length >= 3 && t.length <= 6);
  assert.ok(niceTicks(5, 5).length >= 2, "a flat series still gets an axis");
  const cells = squarify(d.positions.map((p) => ({ value: p.value, key: p.id })), 340, 190);
  close(cells.reduce((a, c) => a + c.w * c.h, 0), 340 * 190, 1);
  assert.ok(cells.every((c) => c.x >= -1e-6 && c.y >= -1e-6 && c.x + c.w <= 340 + 1e-6 && c.y + c.h <= 190 + 1e-6));
});

test("the app's scripts never write HTML or style attributes (CSP: style-src 'self')", () => {
  const dir = new URL("../public/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /setAttribute\(\s*["']style["']/, f);
    assert.doesNotMatch(src, /style:\s*["'`]/, `${f}: style must be an object (CSSOM), not a string`);
    assert.doesNotMatch(src, /\bfetch\(\s*["'`]https?:/, `${f}: no calls to other origins`);
  }
});

test("recurring: month steps clamp to the month's end", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-30", 2), "2027-01-30");
  assert.equal(addMonths("2026-06-15", 12), "2027-06-15");
});

test("recurring calendar: yearly bills land on their month, weekly ones spread, stopped ones left out", () => {
  const rec = d.recurring;
  const cal = recurringCalendar(rec, 12);
  assert.equal(cal.length, 12);
  assert.equal(cal[0].month, "2026-06");
  const jan = cal.find((c) => c.month === "2027-01");
  assert.ok(jan.items.some((x) => x.name === "Property tax" && x.amount === 1100));
  assert.ok(!cal.some((c) => c.items.some((x) => x.name === "Old app")));
  const sep = cal.find((c) => c.month === "2026-09");
  assert.equal(sep.items.filter((x) => x.name === "Term life").length, 1);
  // a full month holds every monthly payment once, plus the spread ones at their rate
  const jul = cal.find((c) => c.month === "2026-07");
  const monthlies = rec.items.filter((i) => i.cadence === "monthly" && i.status !== "stopped?").reduce((a, i) => a + i.amount, 0);
  const spread = rec.items.filter((i) => ["weekly", "fortnightly", "irregular"].includes(i.cadence)).reduce((a, i) => a + i.monthly, 0);
  close(jul.total, monthlies + spread);
  // over a year the calendar matches the monthly figure, give or take this month's head start
  const year = cal.slice(1).reduce((a, c) => a + c.total, 0);
  assert.ok(Math.abs(year / 11 - rec.monthly_all) / rec.monthly_all < 0.15, `${year / 11} vs ${rec.monthly_all}`);
});

test("next 30 days: soonest first, no weekly habits, nothing already past", () => {
  const soon = upcoming(d.recurring, 30);
  assert.ok(soon.length > 0);
  assert.ok(soon.every((i, k) => k === 0 || soon[k - 1].due <= i.due));
  assert.ok(soon.every((i) => i.due >= d.recurring.as_of && i.cadence !== "fortnightly"));
  assert.ok(soon.some((i) => i.name === "Home loan (other part)"));
});

test("totals count the home currency from the snapshot, not a fixed one", () => {
  const lines = [{ date: "2026-05-02", amount: -10, currency: "EUR", category: "dining", kind: "EXPENSE", desc: "Cafe", merchant: "Cafe" },
    { date: "2026-05-03", amount: -99, currency: "SGD", category: "dining", kind: "EXPENSE", desc: "Shop", merchant: "Shop" }];
  setBase("eur");
  assert.equal(BASE, "EUR");
  assert.equal(daySummary(lines, "2026-05", {}).gross, 10);
  setBase("SGD");
  assert.equal(daySummary(lines, "2026-05", {}).gross, 99);
  setBase(undefined);
  assert.equal(BASE, "SGD");
});
