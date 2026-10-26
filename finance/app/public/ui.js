// Shared DOM helpers and number formats for the Money app.
// All text goes in through text nodes (never HTML). Styles go in through the
// CSSOM (el.style), never a style="" attribute: the page's CSP is
// style-src 'self', which blocks style attributes but allows the CSSOM.

const SVGNS = "http://www.w3.org/2000/svg";

function setStyle(el, st) {
  for (const [k, v] of Object.entries(st)) {
    if (v == null) continue;
    if (k.startsWith("--")) el.style.setProperty(k, String(v));
    else el.style[k] = String(v);
  }
}

function props(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "style") {
      if (typeof v !== "object") throw new Error("style must be an object (CSP blocks style attributes)");
      setStyle(el, v);
    } else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function kidsInto(el, kids) {
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/** An HTML element. Text children become text nodes. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  props(el, attrs);
  return kidsInto(el, kids);
}

/** An SVG element. */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  props(el, attrs);
  return kidsInto(el, kids);
}

const ICONS = {
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z",
  chev: "M9 6l6 6-6 6",
  mark: "M4 17l5-5 4 3 7-8M15 7h5v5",
};
export const icon = (n, cls = "icon") => s("svg", { class: cls, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, s("path", { d: ICONS[n] }));

// ------------------------------------------------------------------ numbers
// Numbers and dates read the same in any timezone: dates are calendar days
// (YYYY-MM-DD), formatted at noon UTC so no offset can move them a day.
const LOCALE = "en-GB";
export const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? "–" : Number(x).toLocaleString(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const money = (x) => (Math.abs(x) >= 1e6 ? `${fmt(x / 1e6, 2)}m` : Math.abs(x) >= 1e4 ? `${fmt(x / 1e3, 1)}k` : fmt(x));
export const pct = (x, d = 1) => (x == null ? "–" : `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, d)}%`);
/** A share (0..1) as a plain percentage, no sign. */
export const share = (x, d = 1) => (x == null || !Number.isFinite(x) ? "–" : `${fmt(x * 100, d)}%`);
/** Signed money, with a real minus sign. */
export const smoney = (x) => `${x >= 0 ? "+" : "−"}${money(Math.abs(x))}`;
export const title = (t) => String(t).replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(LOCALE, { month: "short", year: "numeric", timeZone: "UTC" });
export const monthShort = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(LOCALE, { month: "short", timeZone: "UTC" });
export const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
/** A moment (ISO timestamp) in the owner's timezone (the snapshot's `tz`), e.g. "26 Oct 2026, 09:00". */
export function whenName(iso, tz) {
  const o = { dateStyle: "medium", timeStyle: "short" };
  try { return new Date(iso).toLocaleString(LOCALE, { ...o, timeZone: tz || undefined }); } catch { return new Date(iso).toLocaleString(LOCALE, o); }
}
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "a, b and c" */
export const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Up or down, said with an arrow as well as a colour. */
export function delta(v, text, goodWhenUp = true) {
  if (v == null) return null;
  const good = goodWhenUp ? v >= 0 : v <= 0;
  return h("span", { class: `delta ${good ? "up" : "down"}` }, h("span", { "aria-hidden": "true" }, v >= 0 ? "▲ " : "▼ "), text);
}

// ------------------------------------------------------------------ layout
/** A card with a heading row (title, optional sub line, optional right-hand slot). */
export function card(head, opts, ...kids) {
  const o = opts || {};
  const hd = head == null ? null : h("header", { class: "card-h" },
    h("div", null, typeof head === "string" || head.tagName !== "H2" ? h("h2", null, head) : head, o.sub ? h("p", { class: "sub" }, o.sub) : null),
    o.right || null);
  return h("section", { class: `card${o.cls ? ` ${o.cls}` : ""}`, "aria-label": typeof head === "string" ? head : o.label || null }, hd, ...kids);
}

/** A row of toggle chips. items: [[value, label]]. */
export function chips(items, current, onPick, label, cls = "") {
  return h("div", { class: `chips ${cls}`, role: "group", "aria-label": label },
    items.map(([v, l]) => h("button", { class: "chip", type: "button", "aria-pressed": String(v === current), onclick: () => onPick(v) }, l)));
}

/** Two to four options as one segmented control. */
export function segmented(items, current, onPick, label) {
  return h("div", { class: "seg", role: "group", "aria-label": label },
    items.map(([v, l]) => h("button", { type: "button", "aria-pressed": String(v === current), onclick: () => onPick(v) }, l)));
}

export const note = (text, cls = "") => h("p", { class: `note ${cls}` }, text);

// ------------------------------------------------------------------ sheet
let opener = null;
const $ = (id) => document.getElementById(id);

export function openSheet(...kids) {
  if ($("sheet").hidden) opener = document.activeElement;
  $("sheet-body").replaceChildren(...kids.flat().filter(Boolean));
  $("sheet").hidden = false;
  $("sheet-body").scrollTop = 0;
  $("sheet-x").focus();
}

export function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  if (opener && opener.isConnected && opener.focus) opener.focus();
  opener = null;
}

/** Close button, backdrop, Escape, and keep Tab inside the open sheet. */
export function wireSheet() {
  $("sheet-x").replaceChildren(icon("close"));
  $("sheet-x").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if ($("sheet").hidden) return;
    if (e.key === "Escape") { closeSheet(); return; }
    if (e.key !== "Tab") return;
    const f = [...$("sheet").querySelectorAll("button, [tabindex='0'], a[href]")].filter((x) => !x.disabled && x.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
}
