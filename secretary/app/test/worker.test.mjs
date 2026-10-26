// Worker tests: node --test secretary/app/test/*.test.mjs   (no dependencies, no network: Google is faked)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import worker, { cleanEvent, cleanSettings, signSync } from "../worker.js";
import * as G from "../google.js";
import { addDays as M_addDays } from "../public/model.js";

const TOKEN = "123456:TEST-token_for-vectors";
const OWNER = "111";
const ORIGIN = "https://secretary-app.example.workers.dev";
const now = () => Math.floor(Date.now() / 1000);

// Python computes the same signature (secretary/test_sync.py).
const VECTOR_BODY = '{"op":"events","ts":"2026-01-01T00:00:00+00:00"}';
const VECTOR_SIG = "b80646d30462508391b47838412c9a04f755891e40b60b2a632632b14c4444f5";

function initData(id, token = TOKEN) {
  const fields = { auth_date: String(now() - 60), user: JSON.stringify({ id: Number(id), first_name: "Ana" }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

const env = (extra = {}) => ({
  BOT_TOKEN: TOKEN, OWNER_ID: OWNER, TIME: new MemoryKV(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret",
  ASSETS: { fetch: async () => new Response("<!doctype html><title>Secretary</title>", { headers: { "Content-Type": "text/html" } }) }, ...extra,
});
const app = (e, path, body, id = OWNER) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method: "POST", body: JSON.stringify({ ...body, initData: initData(id) }), headers: { "Content-Type": "application/json" } }), e);
async function bot(e, path, body, token = TOKEN) {
  const raw = JSON.stringify(body);
  const sig = await signSync(token, new TextEncoder().encode(raw));
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: raw, headers: { "X-Sync-Signature": sig } }), e);
}

/** A fake Google: token endpoint, events list, insert, get, patch, delete. Records every call. */
function fakeGoogle({ events = [], own = new Set() } = {}) {
  const calls = [];
  const store = new Map(events.map((e) => [e.id, e]));
  const res = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || "GET", path: u.pathname, query: u.search, body: init.body ? String(init.body) : "" });
    if (u.hostname === "oauth2.googleapis.com") return res({ access_token: "at", expires_in: 3600, refresh_token: "rt" });
    const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m) return res({ error: "nope" }, 404);
    const cal = decodeURIComponent(m[1]);
    const id = m[2] && decodeURIComponent(m[2]);
    if (cal !== "primary") return res({ items: [{ id: "h1", status: "confirmed", summary: "Public Holiday", start: { date: day(30) }, end: { date: day(31) } }] });
    if (!id && (init.method || "GET") === "GET") return res({ items: [...store.values()] });
    if (!id && init.method === "POST") {
      const b = JSON.parse(init.body);
      const e = { id: `new${store.size}`, status: "confirmed", ...b };
      store.set(e.id, e);
      return res(e);
    }
    const e = store.get(id);
    if (!e) return res({ error: "gone" }, 404);
    if (init.method === "DELETE") { store.delete(id); return res(null, 204); }
    if (init.method === "PATCH") { Object.assign(e, JSON.parse(init.body)); return res(e); }
    return res({ id: e.id, status: e.status, extendedProperties: own.has(id) || (e.extendedProperties || {}).private ? e.extendedProperties || { private: { timeapp: "1" } } : undefined });
  };
  return { fn, calls, store };
}

/** A date `n` days from today, in Singapore (the default timezone). */
const day = (n) => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const HOLIDAYS = "en.singapore#holiday@group.v.calendar.google.com";
const settingsPush = (e, settings) => bot(e, "/api/sync", { op: "push", ts: new Date().toISOString(), settings });
const gEvent = (id, summary, start, end, extra = {}) => ({ id, status: "confirmed", summary, start: { dateTime: start }, end: { dateTime: end },
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra });

test("signature matches the Python side", async () => {
  assert.equal(await signSync(TOKEN, new TextEncoder().encode(VECTOR_BODY)), VECTOR_SIG);
});

test("only the owner's Telegram account gets data", async () => {
  const e = env();
  assert.equal((await app(e, "/api/data", {}, "222")).status, 403);
  const forged = await worker.fetch(new Request(`${ORIGIN}/api/data`, { method: "POST", body: JSON.stringify({ initData: initData(OWNER, "999:other") }) }), e);
  assert.equal(forged.status, 401);
  const r = await app(e, "/api/data", {});
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.google, { ready: true, connected: false, status: null, error: null });
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/data`, { method: "POST", body: "{}", headers: { Origin: "https://evil.example" } }), e)).status, 403);
});

test("the page carries the CSP and security headers", async () => {
  const r = await worker.fetch(new Request(`${ORIGIN}/`), env());
  assert.match(r.headers.get("Content-Security-Policy"), /style-src 'self'/);
  assert.match(r.headers.get("Content-Security-Policy"), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
});

test("events keep titles and times only: no descriptions, guests or meeting links", () => {
  const e = G.slim(gEvent("x", "Team seminar (Zoom)", `${day(3)}T16:00:00+08:00`, `${day(3)}T17:00:00+08:00`,
    { description: "Passcode 123", location: "https://zoom.us/j/1?pwd=abc", attendees: [{ email: "a@b.c" }, { self: true, responseStatus: "accepted" }], conferenceData: { x: 1 } }));
  assert.deepEqual(Object.keys(e).sort(), ["allDay", "cal", "end", "id", "link", "loc", "start", "title"]);
  assert.equal(e.title, "Team seminar (Zoom)");
  assert.equal(e.loc, "Online");
  assert.ok(!JSON.stringify(e).includes("abc") && !JSON.stringify(e).includes("Passcode"));
  assert.equal(G.slim({ ...gEvent("y", "Gone", `${day(1)}T00:00:00Z`, `${day(1)}T01:00:00Z`), status: "cancelled" }), null);
  assert.equal(G.slim(gEvent("z", "Lunch", `${day(1)}T12:00:00+08:00`, `${day(1)}T13:00:00+08:00`, { attendees: [{ self: true, responseStatus: "declined" }] })).declined, true);
  assert.equal(G.slim({ ...gEvent("w", "Home", `${day(1)}T09:00:00+08:00`, `${day(1)}T17:00:00+08:00`), eventType: "workingLocation" }), null);
  assert.match(G.authorizeUrl("cid", `${ORIGIN}/google/callback`, "s"), /access_type=offline/);
  assert.match(G.authorizeUrl("cid", `${ORIGIN}/google/callback`, "s"), /calendar\.events/);
});

test("Google sign-in: only a state handed to the owner's app works, once", async () => {
  const e = env();
  const g = fakeGoogle({ events: [gEvent("a", "Lunch — Sam", `${day(1)}T12:00:00+08:00`, `${day(1)}T13:00:00+08:00`)] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fn;
  try {
    await settingsPush(e, { timezone: "Asia/Singapore", currency: "SGD", holidays: HOLIDAYS });
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/google/callback?state=guess&code=c`), e)).status, 400);
    const start = await (await app(e, "/api/google/start", {})).json();
    const state = new URL(start.url).searchParams.get("state");
    assert.match(start.url, /^https:\/\/accounts\.google\.com\//);
    const cb = await worker.fetch(new Request(`${ORIGIN}/google/callback?state=${state}&code=c`), e);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /2 events came in/); // the lunch and the public holiday
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/google/callback?state=${state}&code=c`), e)).status, 400); // used up
    const tokenCall = g.calls.find((c) => c.path === "/token");
    assert.match(tokenCall.body, /grant_type=authorization_code/);
    const d = await (await app(e, "/api/data", {})).json();
    assert.equal(d.google.connected, true);
    assert.deepEqual(d.events.items.map((x) => x.title).sort(), ["Lunch — Sam", "Public Holiday"]);
    const list = g.calls.find((c) => c.path.endsWith("/primary/events"));
    assert.match(decodeURIComponent(list.query), /fields=items\(id,status,summary,start,end,location/);
    assert.ok(!/description|attendees\(email/.test(decodeURIComponent(list.query)));
    // disconnect forgets tokens and the cached calendar
    await app(e, "/api/google/disconnect", {});
    assert.equal(await e.TIME.get("google_auth"), null);
    assert.equal(await e.TIME.get("events"), null);
  } finally { globalThis.fetch = realFetch; }
});

test("adding goes to Google at once; only events made here can be moved or deleted", async () => {
  const e = env();
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3 }));
  const [d1, d2, d3] = [day(1), day(2), day(3)];
  const g = fakeGoogle({ events: [gEvent("theirs", "Team — weekly sync", `${d1}T10:00:00+08:00`, `${d1}T11:00:00+08:00`)] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fn;
  try {
    const add = await (await app(e, "/api/event", { op: "add", title: "Run club", date: d2, start: "07:30", minutes: 60 })).json();
    assert.equal(add.ok, true);
    assert.equal(add.event.mine, true);
    const post = g.calls.find((c) => c.method === "POST" && c.path.endsWith("/primary/events"));
    const sent = JSON.parse(post.body);
    assert.deepEqual(sent.start, { dateTime: `${d2}T07:30:00`, timeZone: "Asia/Singapore" }); // no settings pushed: the default zone
    assert.deepEqual(sent.end, { dateTime: `${d2}T08:30:00`, timeZone: "Asia/Singapore" });
    assert.equal(sent.extendedProperties.private.timeapp, "1");
    assert.ok(add.events.items.some((x) => x.title === "Run club"));
    // someone else's event: refused, untouched
    const del = await app(e, "/api/event", { op: "delete", id: "theirs" });
    assert.equal(del.status, 502);
    assert.match((await del.json()).error, /Only events made in this app/);
    assert.ok(g.store.has("theirs"));
    assert.ok(!g.calls.some((c) => c.method === "DELETE"));
    const mv = await (await app(e, "/api/event", { op: "move", id: add.event.id, date: d3, start: "18:00", minutes: 45 })).json();
    assert.equal(mv.ok, true);
    assert.equal(g.store.get(add.event.id).start.dateTime, `${d3}T18:00:00`);
    assert.equal((await (await app(e, "/api/event", { op: "delete", id: add.event.id })).json()).ok, true);
    assert.ok(!g.store.has(add.event.id));
  } finally { globalThis.fetch = realFetch; }
});

test("bad adds are refused before Google is called", () => {
  const T = day(0);
  const D = day(1);
  assert.match(cleanEvent({ op: "add", title: "", date: D, start: "10:00", minutes: 60 }, T), /title/);
  assert.match(cleanEvent({ op: "add", title: "x".repeat(121), date: D, start: "10:00", minutes: 60 }, T), /title/);
  assert.equal(cleanEvent({ op: "add", title: "A", date: "12/10/2026", start: "10:00", minutes: 60 }, T), "bad date");
  assert.match(cleanEvent({ op: "add", title: "A", date: day(500), start: "10:00", minutes: 60 }, T), /out of range/);
  assert.match(cleanEvent({ op: "add", title: "A", date: day(-30), start: "10:00", minutes: 60 }, T), /out of range/);
  assert.equal(cleanEvent({ op: "add", title: "A", date: D, start: "25:00", minutes: 60 }, T), "bad start time");
  assert.match(cleanEvent({ op: "add", title: "A", date: D, start: "10:00", minutes: 1000 }, T), /Duration/);
  assert.deepEqual(cleanEvent({ op: "add", title: " Run\nclub ", date: D, start: "07:30", minutes: 60 }, T),
    { title: "Run club", date: D, start: "07:30", minutes: 60 });
  assert.deepEqual(cleanEvent({ op: "add", title: "A", date: D, start: "07:30", minutes: 60 }), { title: "A", date: D, start: "07:30", minutes: 60 }); // today by default
});

test("settings from settings.json: timezone, currency and holiday calendar are checked; events are written in that zone", async () => {
  assert.deepEqual(cleanSettings(null), { timezone: "Asia/Singapore", currency: "SGD", holidays: "" });
  assert.deepEqual(cleanSettings({ timezone: "Europe/London", currency: "GBP", holidays: "en.uk#holiday@group.v.calendar.google.com" }),
    { timezone: "Europe/London", currency: "GBP", holidays: "en.uk#holiday@group.v.calendar.google.com" });
  assert.deepEqual(cleanSettings({ timezone: "Mars/Olympus", currency: "pounds", holidays: "https://evil.example/cal" }),
    { timezone: "Asia/Singapore", currency: "SGD", holidays: "" });
  const e = env();
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3 }));
  assert.equal((await (await settingsPush(e, { timezone: "Europe/London", currency: "GBP", holidays: "" })).json()).stored, 1);
  const d = await (await app(e, "/api/data", {})).json();
  assert.deepEqual(d.settings, { timezone: "Europe/London", currency: "GBP", holidays: "" });
  const g = fakeGoogle();
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fn;
  try {
    const D = day(5);
    const add = await (await bot(e, "/api/add", { op: "add", ts: new Date().toISOString(), title: "Gym", date: D, start: "23:30", minutes: 60 })).json();
    assert.equal(add.ok, true);
    const sent = JSON.parse(g.calls.find((c) => c.method === "POST").body);
    assert.deepEqual(sent.start, { dateTime: `${D}T23:30:00`, timeZone: "Europe/London" });
    assert.deepEqual(sent.end, { dateTime: `${M_addDays(D, 1)}T00:30:00`, timeZone: "Europe/London" }); // past midnight: the next day
    const list = g.calls.find((c) => c.method === "GET" && c.path.endsWith("/primary/events"));
    assert.match(decodeURIComponent(list.query), /timeZone=Europe\/London/);
    assert.ok(!g.calls.some((c) => c.path.includes("holiday")), "no holiday calendar set: none read");
  } finally { globalThis.fetch = realFetch; }
});

test("the repo's push is signed; a wrong key or an old timestamp is refused", async () => {
  const e = env();
  const body = { op: "push", ts: new Date().toISOString(), health: { days: { [day(-1)]: { sleep_h: 7 } }, workouts: [] }, rules: { rules: [] }, targets: { sleep_h_per_night: 7.5 } };
  assert.equal((await bot(e, "/api/sync", body, "999:other")).status, 401);
  assert.equal((await bot(e, "/api/sync", { ...body, ts: "2020-01-01T00:00:00Z" })).status, 400);
  const r = await (await bot(e, "/api/sync", body)).json();
  assert.equal(r.stored, 3);
  const d = await (await app(e, "/api/data", {})).json();
  assert.equal(d.health.days[day(-1)].sleep_h, 7);
  assert.equal((await (await bot(e, "/api/events", { op: "events", ts: new Date().toISOString() })).json()).ok, true);
});

test("an expired access token is refreshed, and Google's errors are reported, not thrown", async () => {
  const e = env();
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "old", refresh_token: "rt", expires_at: Date.now() - 1000 }));
  const g = fakeGoogle();
  const r = await G.accessToken(e, g.fn);
  assert.equal(r.token, "at");
  assert.equal((await e.TIME.get("google_auth", "json")).refresh_token, "rt");
  const bad = await G.pull(e, { fetchFn: async () => new Response("{}", { status: 500 }) });
  assert.ok(bad.error);
});

test("with TOKEN_KEY the Google tokens are sealed in KV; a plain record is sealed on first read", async () => {
  const { writeAuth, readAuth } = await import("../tokenbox.js");
  const e = env({ TOKEN_KEY: "k".repeat(43) });
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "old", refresh_token: "rt", expires_at: Date.now() + 3600e3 }));
  assert.equal((await G.accessToken(e, fakeGoogle().fn)).token, "old");  // the plain record still works
  let raw = await e.TIME.get("google_auth");
  assert.ok(!raw.includes('"rt"') && JSON.parse(raw).sealed === 1, "sealed on read");
  await writeAuth(e, e.TIME, "google_auth", { access_token: "old", refresh_token: "rt", expires_at: Date.now() - 1000 });
  assert.equal((await G.accessToken(e, fakeGoogle().fn)).token, "at");  // refreshed through the sealed record
  raw = await e.TIME.get("google_auth");
  assert.ok(!raw.includes('"rt"') && JSON.parse(raw).sealed === 1, "the refreshed pair is sealed too");
  assert.equal((await readAuth(e, e.TIME, "google_auth")).refresh_token, "rt");
  assert.equal(await readAuth({ TOKEN_KEY: "other" }, e.TIME, "google_auth"), null);  // wrong key: unreadable
});

test("the bot finds slots and books into them through signed requests", async () => {
  const e = env();
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3 }));
  const tomorrow = day(1);
  const g = fakeGoogle({ events: [gEvent("busy", "Lunch — a friend", `${tomorrow}T12:00:00+08:00`, `${tomorrow}T14:00:00+08:00`)] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fn;
  try {
    const sl = await (await bot(e, "/api/slots", { op: "slots", ts: new Date().toISOString(), minutes: 120, part: "afternoon", n: 3 })).json();
    assert.equal(sl.ok, true);
    assert.equal(sl.minutes, 120);
    const t = sl.slots.find((x) => x.date === tomorrow);
    assert.ok(t && t.start >= "14:00", JSON.stringify(sl.slots)); // not over the lunch
    assert.equal((await bot(e, "/api/add", { op: "add", ts: new Date().toISOString(), title: "Gym", date: tomorrow, start: "15:00", minutes: 90 }, "999:other")).status, 401);
    const add = await (await bot(e, "/api/add", { op: "add", ts: new Date().toISOString(), title: "Gym", date: tomorrow, start: "15:00", minutes: 90 })).json();
    assert.equal(add.event.mine, true);
    assert.equal((await bot(e, "/api/add", { op: "add", ts: new Date().toISOString(), title: "", date: tomorrow, start: "15:00", minutes: 90 })).status, 400);
  } finally { globalThis.fetch = realFetch; }
});

test("the bot writes details (meeting ID, passcode) and a location, edits only its own events, and nothing comes back", async () => {
  const e = env();
  await e.TIME.put("google_auth", JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3 }));
  const D = day(2);
  const g = fakeGoogle({ events: [gEvent("theirs", "Team — weekly sync", `${D}T10:00:00+08:00`, `${D}T11:00:00+08:00`)] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fn;
  const ts = () => new Date().toISOString();
  try {
    const add = await (await bot(e, "/api/add", { op: "add", ts: ts(), title: "Catch-up — Mei", date: D, start: "10:00", minutes: 30,
      details: "Zoom ID: 111 222 333\r\nPasscode: 123456", location: "https://zoom.us/j/111222333" })).json();
    assert.equal(add.ok, true);
    const sent = JSON.parse(g.calls.find((c) => c.method === "POST" && c.path.endsWith("/primary/events")).body);
    assert.equal(sent.description, "Zoom ID: 111 222 333\nPasscode: 123456");
    assert.equal(sent.location, "https://zoom.us/j/111222333");
    // the Worker keeps neither: not in its reply, not in the cached calendar
    const kept = JSON.stringify(add) + (await e.TIME.get("events"));
    assert.ok(!/111 222|123456|zoom\.us/.test(kept), kept);
    assert.equal(add.event.loc, "Online");
    // an edit: add details to an event it made, then move it
    const ed = await (await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id, details: "Agenda: Q3 review\nZoom ID: 111 222 333" })).json();
    assert.equal(ed.ok, true);
    const patch = JSON.parse(g.calls.filter((c) => c.method === "PATCH").at(-1).body);
    assert.deepEqual(Object.keys(patch), ["description"]); // only what was asked
    const mv = await (await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id, date: D, start: "10:30", minutes: 30 })).json();
    assert.equal(mv.ok, true);
    assert.equal(g.store.get(add.event.id).start.dateTime, `${D}T10:30:00`);
    // someone else's event: refused, untouched
    const theirs = await bot(e, "/api/edit", { op: "edit", ts: ts(), id: "theirs", details: "x" });
    assert.equal(theirs.status, 502);
    assert.ok(!g.store.get("theirs").description);
    assert.equal((await bot(e, "/api/remove", { op: "remove", ts: ts(), id: "theirs" })).status, 502);
    assert.ok(g.store.has("theirs"));
    // bad edits never reach Google
    assert.equal((await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id })).status, 400);
    assert.equal((await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id, date: D })).status, 400);
    assert.equal((await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id, details: "x".repeat(4001) })).status, 400);
    assert.equal((await bot(e, "/api/edit", { op: "edit", ts: ts(), id: add.event.id, details: "x" }, "999:other")).status, 401);
    // and its own: removed
    assert.equal((await (await bot(e, "/api/remove", { op: "remove", ts: ts(), id: add.event.id })).json()).ok, true);
    assert.ok(!g.store.has(add.event.id));
  } finally { globalThis.fetch = realFetch; }
});

test("receipts: the bot stores them, the owner's app and the bot read them, nobody else", async () => {
  const e = env();
  const id = `${day(-3).replace(/-/g, "")}-abc123`;
  const data = Buffer.from("fake jpeg bytes").toString("base64");
  const put = (body, token) => bot(e, "/api/receipt", { op: "receipt", ts: new Date().toISOString(), id, mime: "image/jpeg", data, ...body }, token);
  assert.equal((await put({}, "999:other")).status, 401);
  assert.equal((await put({ id: "../../etc" })).status, 400);
  assert.equal((await put({ mime: "text/html" })).status, 400);
  assert.equal((await put({ data: "<script>" })).status, 400);
  assert.equal((await (await put({})).json()).ok, true);
  const mine = await (await app(e, "/api/receipt/view", { id })).json();
  assert.deepEqual([mine.mime, mine.data], ["image/jpeg", data]);
  assert.equal((await app(e, "/api/receipt/view", { id }, "222")).status, 403);
  const got = await (await bot(e, "/api/receipt/get", { op: "receipt_get", ts: new Date().toISOString(), id })).json();
  assert.equal(got.data, data);
  await bot(e, "/api/receipt/delete", { op: "receipt_delete", ts: new Date().toISOString(), id });
  assert.equal((await app(e, "/api/receipt/view", { id })).status, 404);
});

test("claims pushed from the repo reach the app", async () => {
  const e = env();
  const claims = { rows: [{ id: `${day(-3).replace(/-/g, "")}-abc123`, merchant: "Grab", home: "9.03", status: "to_claim" }], summary: { by_status: { to_claim: 9.03 }, by_trip: {}, currency: "SGD" } };
  await bot(e, "/api/sync", { op: "push", ts: new Date().toISOString(), claims });
  const d = await (await app(e, "/api/data", {})).json();
  assert.equal(d.claims.rows[0].merchant, "Grab");
});
