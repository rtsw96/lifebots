// Reusable SVG charts for the Money app. Hand-rolled, no libraries.
// Colours come in as CSS values (usually var(--…)) and are set through the
// CSSOM, which the page's CSP allows. Every chart has an aria-label, and every
// interactive mark is focusable and works with Enter or Space.

import { h, s, money, fmt, share, dayName } from "./ui.js";
import { BASE, niceTicks, squarify } from "./model.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const keyActivate = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); } };
/** Rough text width for Barlow at `px` (labels are trimmed to fit, never measured from the DOM). */
const textW = (t, px = 11.5) => String(t).length * px * 0.5;
export function fit(t, px, maxW) {
  const str = String(t);
  if (textW(str, px) <= maxW) return str;
  const n = Math.max(1, Math.floor(maxW / (px * 0.5)) - 1);
  return `${str.slice(0, n).trimEnd()}…`;
}

// ------------------------------------------------------------------ line
/**
 * Net worth over time. Tap, drag or use the arrow keys to read a point.
 * points: [[date, value]]. Handles one point, and a few uneven ones.
 */
export function lineChart(points, { w = 340, h: H = 180, label = "Value over time", unit = BASE } = {}) {
  const W = Math.max(260, w);
  const L = 46, R = 12, T = 14, B = 26;
  const pts = points.map(([d, v]) => ({ d, v, t: Date.parse(`${d}T00:00:00+08:00`) }));
  const n = pts.length;
  const readout = h("p", { class: "readout", "aria-live": "polite" });
  const wrap = h("div", { class: "chart line" }, readout);
  if (!n) return wrap;
  const vs = pts.map((p) => p.v);
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const t0 = pts[0].t, t1 = pts[n - 1].t;
  const X = (t) => (n === 1 || t1 === t0 ? (L + W - R) / 2 : L + ((t - t0) / (t1 - t0)) * (W - L - R));
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  const svg = s("svg", { class: "svg", viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `${label}: ${n} point${n === 1 ? "" : "s"} from ${dayName(pts[0].d)} to ${dayName(pts[n - 1].d)}, latest ${fmt(pts[n - 1].v)} ${unit}. Use the arrow keys to read each point.` });
  for (const v of ticks) {
    svg.append(s("line", { class: v === y0 ? "axis" : "grid", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    svg.append(s("text", { class: "tick", x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, money(v)));
  }
  // x labels: first and last, plus the middle when there is room
  const xl = [0, n - 1];
  if (n > 2 && W > 300) xl.splice(1, 0, Math.floor((n - 1) / 2));
  for (const i of [...new Set(xl)]) {
    const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    svg.append(s("text", { class: "tick", x: X(pts[i].t), y: H - 7, "text-anchor": anchor }, dayName(pts[i].d)));
  }
  if (n > 1) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
    svg.append(s("path", { class: "area", d: `${d} L${X(t1).toFixed(1)},${Y(y0)} L${X(t0).toFixed(1)},${Y(y0)} Z` }));
    svg.append(s("path", { class: "line", d }));
  }
  if (n <= 24) for (const p of pts) svg.append(s("circle", { class: "pt", cx: X(p.t), cy: Y(p.v), r: 3 }));
  const cross = s("line", { class: "cross", y1: T - 4, y2: H - B });
  const ring = s("circle", { class: "ring", r: 5.5 });
  svg.append(cross, ring);
  let cur = n - 1;
  const show = (i) => {
    cur = clamp(i, 0, n - 1);
    const p = pts[cur];
    cross.setAttribute("x1", X(p.t)); cross.setAttribute("x2", X(p.t));
    ring.setAttribute("cx", X(p.t)); ring.setAttribute("cy", Y(p.v));
    const prev = cur ? pts[cur - 1] : null;
    const dv = prev ? p.v - prev.v : null;
    readout.replaceChildren(h("b", null, dayName(p.d)), ` ${fmt(p.v)} ${unit}`,
      dv == null ? null : h("span", { class: dv >= 0 ? "pos" : "neg" }, ` ${dv >= 0 ? "▲ +" : "▼ −"}${money(Math.abs(dv))} since ${dayName(prev.d)}`));
  };
  const pick = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / (r.width || 1)) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(X(pts[i].t) - x) < Math.abs(X(pts[best].t) - x)) best = i;
    show(best);
  };
  svg.addEventListener("pointerdown", pick);
  svg.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) pick(e); });
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(cur - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(cur + 1); e.preventDefault(); }
    if (e.key === "Home") { show(0); e.preventDefault(); }
    if (e.key === "End") { show(n - 1); e.preventDefault(); }
  });
  show(n - 1);
  wrap.append(svg);
  return wrap;
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

/**
 * A donut with a legend. parts: [{key, label, value, color, sub?}] (value > 0).
 * Tap a slice or a legend row to select it; the centre then reads that part.
 */
export function donut(parts, { label = "Split", center = "Total", total: given, fmtV = money, sel = null, onSelect = null, unit = "" } = {}) {
  const ps = parts.filter((p) => p.value > 0);
  const total = given || ps.reduce((a, p) => a + p.value, 0) || 1;
  const S = 132, c = S / 2, r1 = 64, r0 = 44;
  const svg = s("svg", { class: "svg donut", viewBox: `0 0 ${S} ${S}`, role: "img",
    "aria-label": `${label}: ${ps.map((p) => `${p.label} ${share(p.value / total)}`).join(", ")}` });
  const centre = s("g", { class: "centre" });
  const legend = h("div", { class: "legend-list" });
  const els = [];
  const select = (key) => {
    const on = ps.find((p) => p.key === key);
    els.forEach(({ p, path, row }) => {
      path.classList.toggle("dim", !!on && p !== on);
      row.setAttribute("aria-pressed", String(p === on));
    });
    const big = on ? fmtV(on.value) : fmtV(total);
    const small = on ? `${on.label.length > 14 ? `${on.label.slice(0, 13)}…` : on.label} · ${share(on.value / total, 0)}` : center;
    centre.replaceChildren(s("text", { class: "c-big", x: c, y: c + 2, "text-anchor": "middle" }, big),
      s("text", { class: "c-small", x: c, y: c + 18, "text-anchor": "middle" }, small));
    if (onSelect) onSelect(on ? on.key : null);
  };
  let a = 0;
  let cur = sel;
  for (const p of ps) {
    const span = (p.value / total) * Math.PI * 2;
    const path = s("path", { class: "slice", d: arc(c, c, r0, r1, a, a + span), style: { fill: p.color } });
    a += span;
    path.addEventListener("click", () => { cur = cur === p.key ? null : p.key; select(cur); });
    svg.append(path);
    const row = h("button", { type: "button", class: "lg-row", "aria-pressed": "false", onclick: () => { cur = cur === p.key ? null : p.key; select(cur); } },
      h("i", { class: "sw", style: { background: p.color }, "aria-hidden": "true" }),
      h("span", { class: "lg-name" }, p.label, p.sub ? h("small", null, p.sub) : null),
      h("span", { class: "lg-v num" }, fmtV(p.value), unit ? ` ${unit}` : "", h("small", null, share(p.value / total, 0))));
    legend.append(row);
    els.push({ p, path, row });
  }
  svg.append(centre);
  select(cur);
  return h("div", { class: "donut-wrap" }, h("div", { class: "donut-fig" }, svg), legend);
}

// ------------------------------------------------------------------ bars (HTML)
/**
 * Horizontal bars as an accessible list. rows: [{label, value, sub?, color?, onClick?, right?, part?}].
 * Bars never go negative; `part` (0..1) draws an inner share of the bar.
 */
export function hbars(rows, { label = "Bars", max: given, fmtV = money, cls = "" } = {}) {
  const max = given || Math.max(1e-9, ...rows.map((r) => Math.max(0, r.value)));
  return h("div", { class: `hbars ${cls}`, role: "list", "aria-label": label }, rows.map((r) => {
    const wpc = clamp((Math.max(0, r.value) / max) * 100, 0, 100);
    const fill = h("i", { class: "fill", style: { width: `${Math.max(wpc, r.value > 0 ? 0.8 : 0)}%`, background: r.color || null } });
    const part = r.part != null ? h("i", { class: "part", style: { width: `${wpc * clamp(r.part, 0, 1)}%` } }) : null;
    const body = [
      h("span", { class: "hb-l" }, h("span", { class: "hb-name" }, r.label), r.sub ? h("small", null, r.sub) : null),
      h("span", { class: "hb-v num" }, r.right != null ? r.right : fmtV(r.value)),
      h("span", { class: "track", "aria-hidden": "true" }, fill, part),
    ];
    return r.onClick
      ? h("button", { type: "button", class: "hb-row tap", role: "listitem", onclick: r.onClick }, body)
      : h("div", { class: "hb-row", role: "listitem" }, body);
  }));
}

// ------------------------------------------------------------------ stacked columns
/**
 * Stacked columns, one per period. cols: [{key, label, sub?, values:{series: v}}];
 * series: [{key, label, color}] bottom to top. Tap a column to select it.
 * showValue(i, totals): which totals to print above their column (all by default).
 */
export function stackedBars(cols, series, { w = 340, h: H = 196, label = "Columns", sel = null, onSelect = null, showValue = null } = {}) {
  const W = Math.max(260, w);
  const L = 40, R = 4, T = 20, B = 36;
  const totals = cols.map((c) => series.reduce((a, se) => a + Math.max(0, c.values[se.key] || 0), 0));
  const ticks = niceTicks(0, Math.max(1, ...totals), 3);
  const top = ticks[ticks.length - 1];
  const Y = (v) => T + (1 - v / top) * (H - T - B);
  const slot = (W - L - R) / Math.max(1, cols.length);
  const bw = clamp(slot * 0.58, 8, 38);
  const svg = s("svg", { class: "svg", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": label });
  for (const v of ticks) {
    svg.append(s("line", { class: v ? "grid" : "axis", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    svg.append(s("text", { class: "tick", x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, money(v)));
  }
  cols.forEach((c, i) => {
    const on = c.key === sel;
    const cx = L + slot * (i + 0.5);
    const x0 = cx - bw / 2;
    const g = s("g", { class: `col${on ? " on" : ""}`, tabindex: "0", role: "button", "aria-pressed": String(on),
      "aria-label": `${c.aria || c.label}: ${fmt(totals[i])} ${BASE}. ${series.filter((se) => c.values[se.key] > 0).map((se) => `${se.label} ${fmt(c.values[se.key])}`).join(", ")}` });
    if (on) g.append(s("rect", { class: "sel-bg", x: L + slot * i + 2, y: 2, width: Math.max(1, slot - 4), height: H - 4, rx: 8 }));
    let base = 0;
    const segs = series.filter((se) => (c.values[se.key] || 0) > 0);
    segs.forEach((se, j) => {
      const v = c.values[se.key];
      const yTop = Y(base + v);
      const gap = j ? 2 : 0;
      const hh = Math.max(Y(base) - yTop - gap, 0.6);
      if (j === segs.length - 1) {
        const r = Math.min(4, hh, bw / 2);
        g.append(s("path", { class: "seg", style: { fill: se.color },
          d: `M${x0},${yTop + hh} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + bw - r} Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r} V${yTop + hh} Z` }));
      } else {
        g.append(s("rect", { class: "seg", x: x0, y: yTop, width: bw, height: hh, style: { fill: se.color } }));
      }
      base += v;
    });
    if (totals[i] > 0 && (on || !showValue || showValue(i, totals))) g.append(s("text", { class: `val${on ? " b" : ""}`, x: cx, y: Y(totals[i]) - 5, "text-anchor": "middle" }, money(totals[i])));
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

// ------------------------------------------------------------------ sankey
/**
 * Draw a laid-out Sankey (model.sankeyLayout). opts: labelOf(id) -> [name, full],
 * colorOf(id), linkColor(link), headers [4], sel (node id), onNode(id).
 */
export function sankey(lay, { w = 340, label = "Money flow", labelOf, colorOf, linkColor, headers = [], sel = null, onNode = null, fmtV = money, labelRight = 96 } = {}) {
  const W = w;
  const H = lay.height;
  const nw = lay.nodeW;
  const svg = s("svg", { class: "svg sankey", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": label });
  headers.forEach((t, c) => {
    if (!t) return;
    const x = c === 3 ? lay.xs[3] : lay.xs[c];
    svg.append(s("text", { class: "colh", x, y: 11, "text-anchor": "start" }, t));
  });
  const linkG = s("g", { class: "links" });
  const touches = (l) => sel && (l.source.id === sel || l.target.id === sel);
  for (const l of lay.links) {
    const x0 = l.source.x + nw, x1 = l.target.x, xm = (x0 + x1) / 2;
    const p = s("path", { class: `link${sel ? (touches(l) ? " on" : " dim") : ""}`,
      d: `M${x0.toFixed(1)},${l.sy.toFixed(1)} C${xm.toFixed(1)},${l.sy.toFixed(1)} ${xm.toFixed(1)},${l.ty.toFixed(1)} ${x1.toFixed(1)},${l.ty.toFixed(1)}`,
      style: { strokeWidth: `${Math.max(1, l.w).toFixed(2)}px`, stroke: linkColor(l) } });
    p.append(s("title", null, `${labelOf(l.source.id)[1]} → ${labelOf(l.target.id)[1]}: ${fmt(l.value)} ${BASE}`));
    linkG.append(p);
  }
  svg.append(linkG);
  for (const n of lay.nodes) {
    const [name, full] = labelOf(n.id);
    const on = n.id === sel;
    const room = n.col === 3 ? labelRight - 8 : n.col === 2 ? lay.xs[3] - lay.xs[2] - nw - 8 : n.col === 0 ? lay.xs[1] - nw - 8 : 0;
    const g = s("g", { class: `node${on ? " sel" : ""}${sel && !on ? " dim" : ""}`, tabindex: "0", role: "button", "aria-pressed": String(on),
      "aria-label": `${full}: ${fmt(n.value)} ${BASE}. Show the breakdown.` });
    g.append(s("rect", { class: "bar", x: n.x, y: n.y, width: nw, height: n.h, rx: 2, style: { fill: colorOf(n.id) } }));
    if (n.col !== 1) {
      const tx = n.x + nw + 5;
      g.append(s("text", { class: "nl", x: tx, y: n.ly - 1.5 }, fit(name, 11.5, room)));
      g.append(s("text", { class: "nv", x: tx, y: n.ly + 11 }, fmtV(n.value)));
      g.append(s("rect", { class: "hit", x: n.x - 4, y: Math.min(n.y, n.ly - 14), width: nw + 8 + room, height: Math.max(n.h, 28, n.ly + 16 - Math.min(n.y, n.ly - 14)), rx: 6 }));
    } else {
      g.append(s("rect", { class: "hit", x: n.x - 8, y: n.y, width: nw + 16, height: n.h, rx: 6 }));
    }
    if (onNode) {
      g.addEventListener("click", () => onNode(n.id));
      g.addEventListener("keydown", keyActivate(() => onNode(n.id)));
    }
    svg.append(g);
  }
  return h("div", { class: "chart sankey-wrap" }, svg);
}

// ------------------------------------------------------------------ treemap
/** Weights as a treemap. items: [{key, label, sub, value, color, onClick}]. */
export function treemap(items, { w = 340, h: H = 190, label = "Weights" } = {}) {
  const W = Math.max(260, w);
  const cells = squarify(items, W, H);
  const svg = s("svg", { class: "svg treemap", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": label });
  for (const c of cells) {
    const g = s("g", { class: "cell", tabindex: c.onClick ? "0" : null, role: c.onClick ? "button" : "img", "aria-label": `${c.aria || c.label}: ${c.sub}` });
    const x = c.x + 1, y = c.y + 1, cw = Math.max(0, c.w - 2), ch = Math.max(0, c.h - 2);
    g.append(s("rect", { class: "tint", x, y, width: cw, height: ch, rx: 5, style: { fill: c.color } }));
    g.append(s("rect", { class: "edge", x, y, width: Math.min(3, cw), height: ch, style: { fill: c.color } }));
    if (cw > 44 && ch > 30) {
      g.append(s("text", { class: "tl", x: x + 8, y: y + 16 }, fit(c.label, 12, cw - 12)));
      if (ch > 44) g.append(s("text", { class: "ts", x: x + 8, y: y + 31 }, fit(c.sub, 11, cw - 12)));
    } else if (cw > 26 && ch > 18) {
      g.append(s("text", { class: "ts", x: x + 6, y: y + 14 }, fit(c.label, 10, cw - 8)));
    }
    if (c.onClick) {
      g.addEventListener("click", c.onClick);
      g.addEventListener("keydown", keyActivate(c.onClick));
    }
    svg.append(g);
  }
  return h("div", { class: "chart" }, svg);
}

/** A thin single bar split into parts (e.g. currency exposure). parts: [{label, value, color}]. */
export function splitBar(parts, { label = "Split" } = {}) {
  const ps = parts.filter((p) => p.value > 0);
  const total = ps.reduce((a, p) => a + p.value, 0) || 1;
  return h("div", { class: "splitbar", role: "img", "aria-label": `${label}: ${ps.map((p) => `${p.label} ${share(p.value / total, 0)}`).join(", ")}` },
    ps.map((p) => h("span", { style: { flexGrow: String(p.value), background: p.color } })));
}

// ------------------------------------------------------------------ pace
/**
 * Cumulative spend through a month against an even-pace budget line.
 * pts: [[date, running total]] (day 1 onwards); budget: home-currency amount for the month (or null).
 */
export function paceChart(pts, { daysInMonth = 30, budget = null, w = 340, h: H = 170, label = "Spend through the month" } = {}) {
  const W = Math.max(260, w);
  const L = 46, R = 12, T = 12, B = 24;
  const n = pts.length;
  const top = Math.max(budget || 0, n ? pts[n - 1][1] : 0, 1);
  const ticks = niceTicks(0, top, 3);
  const y1 = ticks[ticks.length - 1];
  const X = (i) => L + (i / Math.max(1, daysInMonth - 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / (y1 || 1)) * (H - T - B);
  const last = n ? pts[n - 1] : null;
  const svg = s("svg", { class: "svg", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${label}: ${last ? `${fmt(last[1])} ${BASE} by ${dayName(last[0])}` : "nothing yet"}${budget ? `, against a budget of ${fmt(budget)} for the month` : ""}.` });
  for (const v of ticks) {
    svg.append(s("line", { class: v === 0 ? "axis" : "grid", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
    svg.append(s("text", { class: "tick", x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, money(v)));
  }
  for (const [i, anchor] of [[0, "start"], [Math.floor((daysInMonth - 1) / 2), "middle"], [daysInMonth - 1, "end"]]) {
    svg.append(s("text", { class: "tick", x: X(i), y: H - 7, "text-anchor": anchor }, String(i + 1)));
  }
  if (budget) {
    svg.append(s("line", { class: "pace", x1: X(0), y1: Y(0), x2: X(daysInMonth - 1), y2: Y(budget) }));
    svg.append(s("text", { class: "tick pace-l", x: X(daysInMonth - 1), y: Y(budget) - 6, "text-anchor": "end" }, `budget ${money(budget)}`));
  }
  if (n) {
    const d = pts.map(([, v], i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    svg.append(s("path", { class: "area", d: `${d} L${X(n - 1).toFixed(1)},${Y(0)} L${X(0).toFixed(1)},${Y(0)} Z` }));
    svg.append(s("path", { class: "line", d }));
    svg.append(s("circle", { class: "ring", cx: X(n - 1), cy: Y(last[1]), r: 4.5 }));
  }
  return h("div", { class: "chart line pacechart" }, svg);
}
