// Shared UI helpers for the Knowledge app. All text goes in through textContent (h()), never as HTML.

import { localDay as dayOf, timeZone } from "./learn.js";

export const tg = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData)
  ? window.Telegram.WebApp
  : (() => {
    const raw = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
    return raw ? { initData: raw, ready() {}, expand() {}, onEvent() {}, openLink: (u) => window.open(u, "_blank", "noopener") } : null;
  })();
export const $ = (id) => document.getElementById(id);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // the CSSOM: the CSP blocks style="" attributes
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) { if (k === "style") el.style.cssText = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const ICONS = {
  owl: "M12 20c4 0 6.5-2.6 6.5-6.5V8.5L16 6l-4 2-4-2-2.5 2.5v5C5.5 17.4 8 20 12 20zM9 12.2h.01M15 12.2h.01M11 15.5h2",
  learn: "M3.5 8.5L12 4l8.5 4.5L12 13zM7 10.6v4.6c1.4 1.4 3 2.3 5 2.3s3.6-.9 5-2.3v-4.6",
  library: "M5 4.5h3.5v15H5zM10.5 4.5H14v15h-3.5zM15.8 5.2l3.3-.9 3.4 14.6-3.3.9z",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5",
  flame: "M12 21c3.6 0 6-2.5 6-6 0-4-3.5-6-4-10-2.5 1.8-4.2 4.4-4.2 7-1-.7-1.6-1.8-1.8-3C6.6 10.6 6 12.6 6 15c0 3.5 2.4 6 6 6z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  snow: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z",
  trophy: "M8 4.5h8v5a4 4 0 0 1-8 0zM8 6.5H4.5c0 3 1.5 4.5 4 4.8M16 6.5h3.5c0 3-1.5 4.5-4 4.8M12 13.5V17M8.5 20h7M9.5 17h5v3h-5z",
  play: "M8 5.5l11 6.5-11 6.5z",
  sound: "M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l4.5 4.5",
  back: "M15 5.5L8.5 12l6.5 6.5",
  plus: "M12 5v14M5 12h14",
  edit: "M4.5 19.5l1-4.5L15.5 5l3.5 3.5-10 10zM13.5 7l3.5 3.5",
  graph: "M6 7a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M12 18a2 2 0 1 0 0-.01M7.5 8l3.5 8.5M16.5 7.5L13 16.5M8 6.8l8-.6",
  brain: "M9 4.5a3 3 0 0 0-3 3v.3A3 3 0 0 0 4.5 13a3 3 0 0 0 2 4.6A3 3 0 0 0 12 19V6a3 3 0 0 0-3-1.5zM15 4.5a3 3 0 0 1 3 3v.3a3 3 0 0 1 1.5 5.2 3 3 0 0 1-2 4.6A3 3 0 0 1 12 19",
  ask: "M4.5 5.5h15v10h-8l-4.5 4v-4h-2.5zM9.5 9a2.5 2.5 0 0 1 5 .2c0 1.6-2.5 1.8-2.5 3.3M12 14h.01",
  trash: "M5 7.5h14M10 7.5V5h4v2.5M7 7.5l.9 11.5h8.2l.9-11.5",
  flag: "M5.5 21V4.5M5.5 5c4-2 7 2 13 0v8c-6 2-9-2-13 0",
  inbox: "M4 13.5l2.5-8h11l2.5 8M4 13.5v5h16v-5h-5a3 3 0 0 1-6 0z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 20.6h-4l-.3-2a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.3L4.6 10l2-3.4 1.9.7a7 7 0 0 1 2-1.2l.3-2h4l.3 2a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.3z",
};
export function icon(name, cls = "icon") {
  return s("svg", { class: cls, viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: ICONS[name] || ICONS.star }));
}

export const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? "–" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d }));
export const nowMs = () => Date.now();
/** Today (YYYY-MM-DD) and minutes past midnight, in the user's timezone (learn.js setTimeZone). */
export const localDay = (ms = nowMs()) => dayOf(ms);
export const localMins = (ms = nowMs()) => {
  const [hh, mm] = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)).split(":").map(Number);
  return hh * 60 + mm;
};
/** A calendar date (YYYY-MM-DD) for display, e.g. "14 Oct 2026" in the phone's language. */
export const short = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
/** A moment for display, in the user's timezone. */
export const when = (ms, opts) => new Date(ms).toLocaleString(undefined, { ...opts, timeZone: timeZone() });

export function haptic(kind) {
  try {
    if (kind === "soft") tg.HapticFeedback.selectionChanged();
    else if (kind === "tick") tg.HapticFeedback.impactOccurred("medium");
    else tg.HapticFeedback.notificationOccurred(kind);
  } catch { /* outside Telegram */ }
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function openSheet(...kids) {
  const body = $("sheet-body");
  body.replaceChildren(...kids.flat().filter(Boolean));
  $("sheet").hidden = false;
}
export function closeSheet() { $("sheet").hidden = true; }

export function confirmBox(text, yes = "Yes", no = "Cancel") {
  return new Promise((resolve) => {
    openSheet(h("h2", { id: "sheet-title" }, text),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => { closeSheet(); resolve(true); } }, yes),
        h("button", { class: "btn quiet", type: "button", onclick: () => { closeSheet(); resolve(false); } }, no)));
  });
}

export function openLink(url) {
  try { if (tg && tg.openLink) { tg.openLink(url); return; } } catch { /* fall through */ }
  window.open(url, "_blank", "noopener");
}

// ------------------------------------------------------------------ speech (the phone's own voices; nothing leaves the phone)
let voices = [];
function loadVoices() { try { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; } catch { voices = []; } }
loadVoices();
try { if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices; } catch { /* none */ }
const LANG = { ja: "ja-JP", zh: "zh-CN", en: "en-GB", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-PT", ko: "ko-KR" };
export function canSpeak(lang) {
  if (!window.speechSynthesis) return false;
  const want = (LANG[lang] || lang || "").toLowerCase().slice(0, 2);
  return voices.some((v) => v.lang.toLowerCase().startsWith(want));
}
export function speak(text, lang = "ja", rate = 0.9) {
  if (!window.speechSynthesis || !text) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG[lang] || lang;
    const want = u.lang.toLowerCase().slice(0, 2);
    const v = voices.find((x) => x.lang.toLowerCase().startsWith(want) && /premium|enhanced|siri/i.test(x.name)) || voices.find((x) => x.lang.toLowerCase().startsWith(want));
    if (v) u.voice = v;
    u.rate = rate;
    speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ the API
export async function api(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, initData: tg ? tg.initData : "" }) });
  if (path === "/api/blob" && res.ok) return res;
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/** gunzip a Response body into parsed JSON (DecompressionStream, or the bundled fflate). */
export async function gunzipJson(res) {
  if (typeof DecompressionStream === "function") {
    const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(text);
  }
  const { gunzipSync, strFromU8 } = await import("./vendor/fflate.js");
  return JSON.parse(strFromU8(gunzipSync(new Uint8Array(await res.arrayBuffer()))));
}

// ------------------------------------------------------------------ storage (IndexedDB for the bundles, localStorage for small things)
const DB = "knowledge", STORE = "kv";
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((resolve) => { const q = d.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => resolve(null); });
  } catch { return null; }
}
export async function idbPut(key, val) {
  try {
    const d = await db();
    await new Promise((resolve) => { const t = d.transaction(STORE, "readwrite"); t.objectStore(STORE).put(val, key); t.oncomplete = resolve; t.onerror = resolve; });
  } catch { /* private mode */ }
}
export const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } };
