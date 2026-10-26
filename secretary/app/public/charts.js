// SVG charts for the Secretary app, in the Money app's style. Hand-rolled, no
// libraries. Colours come in as CSS values (var(--c-…)) and go in through the
// CSSOM (the CSP allows that, not style attributes). Every chart has an
// aria-label; tappable marks are focusable and work with Enter or Space.

import { h, s, fmt, share } from "./ui.js";
import { hours, hm } from "./model.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const keyActivate = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); } };
export const catColor = (c) => `var(--c-${c})`;

export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) { const pad = Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 1e6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// ------------------------------------------------------------------ day strip
/**
 * A 24-hour strip: who owned each part of one day. blocks: [{s, e, cat, title}]
 * in minutes. `now` (minutes) draws a marker on today.
 */
export function dayStrip(blocks, { w = 340, h: H = 34, label = "The day", now = null, ticks = true, onBlock = null } = {}) {
  const W = Math.max(240, w);
  const X = (m) => (m / 1440) * W;
  const svg = s("svg", { class: "svg strip", viewBox: `0 0 ${W} ${H + (ticks ? 16 : 0)}`, role: "img", "aria-label": label });
  svg.append(s("rect", { class: "strip-bg", x: 0, y: 0, width: W, height: H, rx: 6 }));
  for (const b of blocks) {
    const r = s("rect", { class: `blk${b.est ? " est" : ""}`, x: X(b.s), y: 0, width: Math.max(1.5, X(b.e) - X(b.s)), height: H, style: { fill: catColor(b.cat) } });
    r.append(s("title", null, `${b.title} · ${hm(b.s)}–${hm(b.e % 1440 === 0 && b.e ? 1440 : b.e).replace("00:00", "24:00")}`));
    if (onBlock && b.ev) {
      r.setAttribute("tabindex", "0");
      r.setAttribute("role", "button");
      r.setAttribute("aria-label", `${b.title}, ${hm(b.s)}`);
      r.addEventListener("click", () => onBlock(b));
      r.addEventListener("keydown", keyActivate(() => onBlock(b)));
    }
    svg.append(r);
  }
  if (now != null) svg.append(s("line", { class: "now", x1: X(now), x2: X(now), y1: -3, y2: H + 3 }));
  if (ticks) {
    for (const t of [0, 6, 12, 18, 24]) {
      svg.append(s("text", { class: "tick", x: clamp(X(t * 60), 6, W - 6), y: H + 13, "text-anchor": t === 0 ? "start" : t === 24 ? "end" : "middle" }, t === 24 ? "24" : String(t).padStart(2, "0")));
    }
  }
  return h("div", { class: "chart" }, svg);
}

/** Seven strips, Monday to Sunday: the week at a glance. rows: [{label, sub, blocks, dim}] */
export function weekGrid(rows, { w = 340, label = "The week, hour by hour", onRow = null } = {}) {
  const L = 44;
  const W = Math.max(260, w);
  const rowH = 20;
  const gap = 7;
  const H = rows.length * (rowH + gap) + 14;
  const X = (m) => L + (m / 1440) * (W - L);
  const svg = s("svg", { class: "svg grid7", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": label });
  for (const t of [0, 6, 12, 18, 24]) {
    svg.append(s("line", { class: "grid", x1: X(t * 60), x2: X(t * 60), y1: 0, y2: H - 14 }));
    svg.append(s("text", { class: "tick", x: X(t * 60), y: H - 2, "text-anchor": t === 0 ? "start" : t === 24 ? "end" : "middle" }, String(t).padStart(2, "0")));
  }
  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    const g = s("g", { class: `row${r.dim ? " dim" : ""}${r.on ? " on" : ""}` });
    g.append(s("text", { class: "rl", x: 0, y: y + rowH / 2 + 4 }, r.label));
    g.append(s("rect", { class: "strip-bg", x: L, y, width: W - L, height: rowH, rx: 4 }));
    for (const b of r.blocks) g.append(s("rect", { class: `blk${b.est ? " est" : ""}`, x: X(b.s), y, width: Math.max(1.2, X(b.e) - X(b.s)), height: rowH, style: { fill: catColor(b.cat) } }));
    if (r.away) g.append(s("text", { class: "away", x: L + 6, y: y + rowH / 2 + 4 }, `✈ ${r.away}`));
    if (onRow) {
      g.append(s("rect", { class: "hit", x: 0, y: y - 2, width: W, height: rowH + 4 }));
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", r.aria || r.label);
      g.addEventListener("click", () => onRow(r));
      g.addEventListener("keydown", keyActivate(() => onRow(r)));
    }
    svg.append(g);
  });
  return h("div", { class: "chart" }, svg);
}

// ------------------------------------------------------------------ stacked columns
/**
 * Stacked columns of hours. cols: [{key, label, sub?, values:{cat: minutes}}];
 * series: [{key, label, color}] bottom to top. Tap a column to select it.
 */
export function stackedBars(cols, series, { w = 340, h: H = 196, label = "Columns", sel = null, onSelect = null, target = null } = {}) {
  const W = Math.max(260, w);
  const L = 34, R = 4, T = 20, B = 34;
  const totals = cols.map((c) => series.reduce((a, se) => a + Math.max(0, c.values[se.key] || 0), 0));
  const ticks = niceTicks(0, Math.max(60, ...totals, target || 0) / 60, 3);
  const top = ticks[ticks.length - 1] * 60;
  const Y = (v) => T + (1 - v / top) * (H - T - B);
  const slot = (W - L - R) / Math.max(1, cols.length);
  const bw = clamp(slot * 0.58, 8, 34);
  const svg = s("svg", { class: "svg", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": label });
  for (const v of ticks) {
    svg.append(s("line", { class: v ? "grid" : "axis", x1: L, x2: W - R, y1: Y(v * 60), y2: Y(v * 60) }));
    svg.append(s("text", { class: "tick", x: L - 6, y: Y(v * 60) + 4, "text-anchor": "end" }, `${v}h`));
  }
  if (target) svg.append(s("line", { class: "target", x1: L, x2: W - R, y1: Y(target), y2: Y(target) }));
  cols.forEach((c, i) => {
    const on = c.key === sel;
    const cx = L + slot * (i + 0.5);
    const x0 = cx - bw / 2;
    const g = s("g", { class: `col${on ? " on" : ""}`, tabindex: onSelect ? "0" : null, role: onSelect ? "button" : "img", "aria-pressed": onSelect ? String(on) : null,
      "aria-label": `${c.aria || c.label}: ${hours(totals[i])}. ${series.filter((se) => c.values[se.key] > 0).map((se) => `${se.label} ${hours(c.values[se.key])}`).join(", ")}` });
    if (on) g.append(s("rect", { class: "sel-bg", x: L + slot * i + 2, y: 2, width: Math.max(1, slot - 4), height: H - 4, rx: 8 }));
    let base = 0;
    const segs = series.filter((se) => (c.values[se.key] || 0) > 0);
    segs.forEach((se, j) => {
      const v = c.values[se.key];
      const yTop = Y(base + v);
      const hh = Math.max(Y(base) - yTop - (j ? 1.5 : 0), 0.6);
      g.append(s("rect", { class: "seg", x: x0, y: yTop, width: bw, height: hh, rx: j === segs.length - 1 ? Math.min(3, hh / 2) : 0, style: { fill: se.color } }));
      base += v;
    });
    if (totals[i] > 0 && (on || cols.length <= 8)) g.append(s("text", { class: `val${on ? " b" : ""}`, x: cx, y: Y(totals[i]) - 5, "text-anchor": "middle" }, hours(totals[i])));
    g.append(s("text", { class: `xl${on ? " b" : ""}`, x: cx, y: H - B + 15, "text-anchor": "middle" }, c.label));
    if (c.sub) g.append(s("text", { class: "xs", x: cx, y: H - B + 28, "text-anchor": "middle" }, c.sub));
    g.append(s("rect", { class: "hit", x: L + slot * i, y: 0, width: slot, height: H }));
    if (onSelect) {
      g.addEventListener("click", () => onSelect(c.key));
      g.addEventListener("keydown", keyActivate(() => onSelect(c.key)));
    }
    svg.append(g);
  });
  return h("div", { class: "chart" }, svg);
}

// ------------------------------------------------------------------ donut
function arc(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    return `M${p(r1, 0)} A${r1},${r1} 0 1 1 ${p(r1, Math.PI)} A${r1},${r1} 0 1 1 ${p(r1, 0)} Z M${p(r0, 0)} A${r0},${r0} 0 1 0 ${p(r0, Math.PI)} A${r0},${r0} 0 1 0 ${p(r0, 0)} Z`;
  }
  return `M${p(r1, a0)} A${r1},${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

/** A donut of minutes with a legend. parts: [{key, label, value, color, sub?}]. */
export function donut(parts, { label = "Split", center = "awake" } = {}) {
  const ps = parts.filter((p) => p.value > 0);
  const total = ps.reduce((a, p) => a + p.value, 0) || 1;
  const S = 132, c = S / 2, r1 = 64, r0 = 44;
  const svg = s("svg", { class: "svg donut", viewBox: `0 0 ${S} ${S}`, role: "img", "aria-label": `${label}: ${ps.map((p) => `${p.label} ${hours(p.value)}`).join(", ")}` });
  let a = 0;
  for (const p of ps) {
    const span = (p.value / total) * Math.PI * 2;
    svg.append(s("path", { class: "slice", d: arc(c, c, r0, r1, a, a + span), style: { fill: p.color } }));
    a += span;
  }
  svg.append(s("text", { class: "c-big", x: c, y: c + 2, "text-anchor": "middle" }, hours(total)));
  svg.append(s("text", { class: "c-small", x: c, y: c + 18, "text-anchor": "middle" }, center));
  const legend = h("div", { class: "legend-list" }, ps.map((p) => h("div", { class: "lg-row" },
    h("i", { class: "sw", style: { background: p.color }, "aria-hidden": "true" }),
    h("span", { class: "lg-name" }, p.label, p.sub ? h("small", null, p.sub) : null),
    h("span", { class: "lg-v num" }, hours(p.value), h("small", null, share(p.value / total, 0))))));
  return h("div", { class: "donut-wrap" }, h("div", { class: "donut-fig" }, svg), legend);
}

// ------------------------------------------------------------------ bars
/** Horizontal bars against a target. rows: [{label, value, target?, color, right?, sub?}] in minutes. */
export function targetBars(rows, { label = "Against targets" } = {}) {
  const max = Math.max(60, ...rows.map((r) => Math.max(r.value, r.target || 0))) * 1.08;
  return h("div", { class: "hbars", role: "list", "aria-label": label }, rows.map((r) => h("div", { class: "hb-row", role: "listitem" },
    h("span", { class: "hb-l" }, h("span", { class: "hb-name" }, r.label), r.sub ? h("small", null, r.sub) : null),
    h("span", { class: `hb-v num ${r.cls || ""}` }, r.right != null ? r.right : hours(r.value)),
    h("span", { class: "track", "aria-hidden": "true" },
      h("i", { class: "fill", style: { width: `${clamp((r.value / max) * 100, r.value > 0 ? 1 : 0, 100)}%`, background: r.color } }),
      r.target ? h("i", { class: "tgt", style: { left: `${clamp((r.target / max) * 100, 0, 100)}%` } }) : null))));
}

/** A small line of nightly sleep hours with the target band. points: [[label, hours|null]]. */
export function sleepLine(points, { w = 340, h: H = 150, target = 7.5, label = "Sleep per night" } = {}) {
  const W = Math.max(260, w);
  const L = 28, R = 6, T = 10, B = 22;
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  const lo = Math.min(5, ...vals) - 0.5;
  const hi = Math.max(9, ...vals) + 0.5;
  const X = (i) => L + (points.length <= 1 ? (W - L - R) / 2 : (i / (points.length - 1)) * (W - L - R));
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = s("svg", { class: "svg", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${label}: ${vals.length ? `average ${fmt(vals.reduce((a, b) => a + b, 0) / vals.length, 1)} h over ${vals.length} nights` : "no data"}` });
  for (const v of niceTicks(lo, hi, 3).filter((v) => v >= lo && v <= hi)) {
    svg.append(s("line", { class: "grid", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    svg.append(s("text", { class: "tick", x: L - 5, y: Y(v) + 4, "text-anchor": "end" }, `${v}h`));
  }
  if (target) svg.append(s("line", { class: "target", x1: L, x2: W - R, y1: Y(target), y2: Y(target) }));
  let d = "";
  points.forEach(([, v], i) => { if (v != null) d += `${d ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
  if (d) svg.append(s("path", { class: "line", d }));
  points.forEach(([, v], i) => { if (v != null) svg.append(s("circle", { class: `pt${target && v < target - 0.25 ? " low" : ""}`, cx: X(i), cy: Y(v), r: 3 })); });
  const step = Math.max(1, Math.ceil(points.length / 6));
  points.forEach(([lab], i) => { if (i % step === 0 || i === points.length - 1) svg.append(s("text", { class: "tick", x: X(i), y: H - 6, "text-anchor": "middle" }, lab)); });
  return h("div", { class: "chart" }, svg);
}
