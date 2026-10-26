// Money app (Telegram Mini App for the money bot): boot, device pairing,
// decryption, the API and the queue of changes for the bot. The tabs live in
// views.js (pure render functions of the decrypted snapshot), charts in
// charts.js, helpers in ui.js.
// End-to-end encrypted: this phone holds a private key (IndexedDB, non-extractable)
// and decrypts the snapshot locally; the Worker only stores the sealed blob.
// All text from the snapshot goes in through text nodes (h() in ui.js), never as HTML.

import { fingerprint, newDeviceKeys, open } from "./crypto.js";
import { h, icon, closeSheet, openSheet, wireSheet, dayName, whenName } from "./ui.js";
import { TABS, renderTab } from "./views.js";

const tg = (window.Telegram && window.Telegram.WebApp) || (() => {
  const raw = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
  return raw ? { initData: raw, ready() {}, expand() {} } : null;
})();
const $ = (id) => document.getElementById(id);
const S = { data: null, device: null, status: null, tab: "overview", queue: [] };
const V = {}; // view state (selected month, filters, highlighted node): never stored
const LS_SEALED = "finance.sealed"; // the sealed blob only; never plaintext

async function api(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, initData: tg ? tg.initData : "" }) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ------------------------------------------------------------------ device key
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("finance-keys", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("keys").objectStore("keys").get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** This phone's key pair: made once, the private half can't leave the device. */
async function deviceKey() {
  let k = await idbGet("device");
  if (!k) {
    const { pair, pub } = await newDeviceKeys();
    k = { privateKey: pair.privateKey, pub, id: await fingerprint(pub) };
    await idbPut("device", k);
  }
  return k;
}

async function idbDel(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ------------------------------------------------------------------ demo mode
// For showing the app to friends: made-up data (demo.json, from preview/demo.py),
// and nothing of yours. While it is on, the app never registers the phone,
// never fetches or opens the sealed snapshot, and never sends anything to the bot.
// Leaving it takes the PIN chosen when it was turned on. The flag and the PIN's
// hash sit in IndexedDB next to the phone's private key: clearing the app's
// storage to get round the PIN also deletes the key, and the phone then has to
// be approved by the bot again.
const DEMO_ITER = 200000;
const PIN_RE = /^\d{4,8}$/;

async function pinHash(pin, salt) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: DEMO_ITER }, k, 256));
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// After 5 wrong PINs: wait 30 s, doubling with each further miss, up to an hour.
const lockFor = (fails) => (fails < 5 ? 0 : Math.min(3600e3, 30e3 * 2 ** (fails - 5)));

function pinField(label, id) {
  return h("label", { class: "pin-l" }, h("span", { class: "small" }, label),
    h("input", { id, class: "pin", type: "password", inputmode: "numeric", pattern: "[0-9]*", autocomplete: "off", maxlength: "8", "aria-label": label }));
}

function demoOnSheet() {
  const err = h("p", { class: "err", role: "alert" });
  openSheet(h("h2", { id: "sheet-title" }, "Show a demo"),
    h("p", null, "The app switches to made-up data: a pretend person with invented banks and numbers. Nothing of yours is shown, fetched or opened while it's on."),
    h("p", null, "Choose a PIN. Leaving demo mode needs it, so you can hand the phone over."),
    pinField("PIN (4 to 8 digits)", "pin1"), pinField("Same PIN again", "pin2"), err,
    h("button", { class: "btn", type: "button", onclick: async (e) => {
      const a = $("pin1").value, b = $("pin2").value;
      if (!PIN_RE.test(a)) { err.textContent = "Use 4 to 8 digits."; return; }
      if (a !== b) { err.textContent = "The two PINs don't match."; return; }
      e.currentTarget.disabled = true;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await idbPut("demo", { salt, hash: await pinHash(a, salt), fails: 0, until: 0, since: new Date().toISOString() });
      location.reload(); // start clean: the real snapshot is dropped from memory
    } }, "Turn on demo mode"),
    h("p", { class: "tiny" }, "If you forget the PIN, you can reset this phone instead: the bot then has to approve it again."));
  $("pin1").focus();
}

async function demoOffSheet() {
  const st = await idbGet("demo");
  const err = h("p", { class: "err", role: "alert" });
  const go = h("button", { class: "btn", type: "button", onclick: async () => {
    const cur = await idbGet("demo");
    if (!cur) { location.reload(); return; }
    const wait = cur.until - Date.now();
    if (wait > 0) { err.textContent = `Too many tries. Try again in ${Math.ceil(wait / 1000)} s.`; return; }
    const pin = $("pin0").value;
    go.disabled = true;
    const ok = PIN_RE.test(pin) && sameBytes(await pinHash(pin, cur.salt), cur.hash);
    if (ok) { await idbDel("demo"); location.reload(); return; }
    const fails = (cur.fails || 0) + 1;
    await idbPut("demo", { ...cur, fails, until: Date.now() + lockFor(fails) });
    $("pin0").value = "";
    go.disabled = false;
    err.textContent = lockFor(fails) ? `Wrong PIN. Locked for ${Math.round(lockFor(fails) / 1000)} s.` : "Wrong PIN.";
  } }, "Leave demo mode");
  openSheet(h("h2", { id: "sheet-title" }, "Leave demo mode"),
    h("p", null, "Everything here is made up. Enter the PIN to see your own data again."),
    pinField("PIN", "pin0"), err, go,
    h("button", { class: "linkbtn", type: "button", onclick: forgotSheet }, "Forgot the PIN?"));
  if (st && st.until > Date.now()) err.textContent = `Too many tries. Try again in ${Math.ceil((st.until - Date.now()) / 1000)} s.`;
  $("pin0").focus();
}

function forgotSheet() {
  openSheet(h("h2", { id: "sheet-title" }, "Reset this phone"),
    h("p", null, "This deletes this phone's key along with demo mode. The app then shows a new code; send it to the money bot (approve <code>) from your own chat to get your data back."),
    h("button", { class: "btn danger", type: "button", onclick: async () => {
      await idbDel("device");
      await idbDel("demo");
      try { localStorage.removeItem(LS_SEALED); } catch { /* ignore */ }
      location.reload();
    } }, "Reset this phone"));
}

async function loadDemo() {
  const res = await fetch("demo.json", { cache: "no-store" });
  if (!res.ok) throw new Error("the demo data didn't load");
  S.demo = true;
  S.data = await res.json();
  S.device = { id: "demo" };
  S.queue = [];
  $("demo-badge").hidden = false;
  $("refresh").hidden = true;
  $("foot-note").textContent = "Demo mode: every name, account and number here is made up.";
  $("tabs").hidden = false;
  $("foot").hidden = false;
  setTab(S.tab);
}

// ------------------------------------------------------------------ views
/** A change made in the app goes to the bot's queue; the bot files it. */
async function recategorise(t, c) {
  if (S.demo) { t.category = c; closeSheet(); render(); return; } // demo: on screen only
  try {
    const r = await api("/api/do", { device: S.device.id, kind: "txn_category", data: { id: t.id, category: c } });
    S.queue.push(r.item);
    t.category = c;
    closeSheet();
    render();
  } catch (e) { openSheet(h("h2", { id: "sheet-title" }, "Not saved"), h("p", null, e.message)); }
}

const contentWidth = () => Math.max(288, Math.min(680, document.documentElement.clientWidth || 390) - 24);

function setTab(tab) {
  S.tab = TABS.some(([t]) => t === tab) ? tab : "overview";
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    const on = b.dataset.tab === S.tab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && b.scrollIntoView) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  render();
  window.scrollTo(0, 0);
}

function render() {
  const d = S.data;
  if (!d) return;
  const v = $("view");
  // keep keyboard focus on the same control across a re-render
  const a = document.activeElement;
  const fk = a && v.contains(a) ? a.getAttribute("aria-label") || a.textContent : null;
  renderTab(S.tab, v, d, { st: V, rerender: render, w: contentWidth(), queue: S.queue, recategorise });
  if (fk) {
    const again = [...v.querySelectorAll("button, [tabindex='0']")].find((x) => (x.getAttribute("aria-label") || x.textContent) === fk);
    if (again) again.focus({ preventScroll: true });
  }
  $("sub").textContent = S.demo ? "Demo · made-up data" : `As of ${dayName(d.as_of || d.generated_at.slice(0, 10))}`;
  $("asof").textContent = S.demo ? "Demo data" : `Data as of ${whenName(d.generated_at, d.tz)} · this phone's key ${S.device.id}`;
  $("demo-on").hidden = Boolean(S.demo);
  const n = S.queue.length;
  $("pending").hidden = !n;
  $("pending").textContent = `${n} for the bot`;
}

// ------------------------------------------------------------------ pairing
function viewPairing(id, status) {
  $("tabs").hidden = true;
  $("view").replaceChildren(h("div", { class: "card pair-card" },
    h("p", { class: "eyebrow lock" }, icon("lock", "icon s"), status === "revoked" ? "This phone was removed" : "Approve this phone"),
    h("p", { class: "note" }, status === "revoked"
      ? "The bot no longer encrypts for this phone. Ask the bot to approve it again if that was a mistake."
      : "Your money data is encrypted for approved phones only. The money bot has sent you this phone's code in Telegram. Check it matches, then reply to the bot:"),
    h("p", { class: "code num" }, id),
    status === "revoked" ? null : h("p", { class: "small" }, `approve ${id}`),
    h("button", { class: "btn", type: "button", onclick: () => load().catch(fail) }, "I've approved it"),
    h("p", { class: "tiny" }, "The private key was made on this phone and never leaves it. If you clear the app's data, the phone gets a new code.")));
}

// ------------------------------------------------------------------ boot
async function load() {
  $("status") && ($("status").textContent = "Unlocking…");
  const k = await deviceKey();
  S.device = k;
  let res;
  try {
    const reg = await api("/api/device", { pub: k.pub, label: /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Desktop" });
    S.status = reg.status;
    res = await api("/api/data", { device: k.id });
  } catch (e) {
    // Offline: the sealed copy from last time still opens with this phone's key.
    const cached = JSON.parse(localStorage.getItem(LS_SEALED) || "null");
    if (!cached || /private|unauthorised/i.test(e.message)) throw e;
    res = { device: "approved", sealed: cached, queue: [], offline: true };
  }
  if (res.device !== "approved") return viewPairing(k.id, res.device);
  if (!res.sealed) {
    $("view").replaceChildren(h("p", { class: "status" }, "Approved. Waiting for the bot's first snapshot: ask the money bot to refresh."));
    return null;
  }
  S.data = await open(res.sealed, k.id, k.privateKey);
  S.queue = res.queue || [];
  try { localStorage.setItem(LS_SEALED, JSON.stringify(res.sealed)); } catch { /* full or private */ }
  $("tabs").hidden = false;
  $("foot").hidden = false;
  setTab(S.tab);
  return null;
}

function fail(e) {
  const msg = /private/i.test(e.message) ? "This app is private to its owner."
    : /not sealed/i.test(e.message) ? "This phone's key isn't in the latest snapshot yet. Ask the money bot to refresh."
      : `Couldn't load: ${e.message}`;
  $("view").replaceChildren(h("p", { class: "status" }, msg));
}

// Telegram's light or dark theme; the header band is the app's own colour.
const BAND = { light: "#0f4a45", dark: "#0b2b29" };
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

function wireTabs() {
  const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
  for (const b of tabs) {
    b.addEventListener("click", () => setTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(b);
      const j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : -1;
      if (j < 0) return;
      e.preventDefault();
      tabs[j].focus();
      setTab(tabs[j].dataset.tab);
    });
  }
}

function boot() {
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceWith(icon(el.dataset.icon, el.className || "icon"));
  wireSheet();
  wireTabs();
  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    try { tg.onEvent && tg.onEvent("themeChanged", () => { applyTheme(); render(); }); } catch { /* older clients */ }
  }
  let resize;
  window.addEventListener("resize", () => { clearTimeout(resize); resize = setTimeout(render, 150); });
  $("refresh").addEventListener("click", () => load().catch(fail));
  $("demo-on").addEventListener("click", demoOnSheet);
  $("demo-badge").addEventListener("click", () => demoOffSheet().catch(fail));
  if (!tg || !tg.initData) {
    $("status").textContent = "Open this from the money bot in Telegram.";
    return;
  }
  if (!(window.crypto && crypto.subtle && window.indexedDB)) {
    $("status").textContent = "This Telegram version can't do the encryption the app needs. Update Telegram.";
    return;
  }
  // Demo mode is checked before anything of yours is touched.
  idbGet("demo").then((demo) => (demo ? loadDemo() : load())).catch(fail);
}

boot();
