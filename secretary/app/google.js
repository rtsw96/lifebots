// Google Calendar: sign-in (OAuth2, offline access) and the events the app keeps.
//
// Only what the Secretary app shows is kept: title, start, end, all-day, a short
// location, the event's Google link, and flags (free, declined, made by this app).
// Never descriptions, attendees, conference links or passcodes: the Calendar API
// is asked for these fields only (`fields=`), so the rest never reaches the Worker.
// Writing is the one exception, on the owner's say-so: the bot can put a
// description (agenda, meeting ID, passcode) and a location into an event it adds
// or edits. They pass through to Google and are never read back or kept here.
//
// Tokens live in KV ("google_auth", sealed under the TOKEN_KEY secret: tokenbox.js).
// Google's refresh token lasts until the owner revokes it (as long as their OAuth
// app is "In production", not "Testing", where tokens expire after 7 days). Access
// tokens last an hour and are refreshed here.
//
// Times: events are read and written in the owner's timezone (`tz`, from
// settings.json through the app's settings); public holidays come from the Google
// holiday calendar named in settings.json (`holidays`), or none.

import { readAuth, writeAuth } from "./tokenbox.js";

export const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
export const SCOPES = "https://www.googleapis.com/auth/calendar.events";
export const DEFAULT_TZ = "Asia/Singapore";
// Marks events made from the app: only these can be moved or deleted from it.
export const MARK = "timeapp";
const ITEM_FIELDS = "id,status,summary,start,end,location,htmlLink,transparency,eventType,extendedProperties/private,attendees(self,responseStatus)";
const FIELDS = `items(${ITEM_FIELDS}),nextPageToken`;

export function authorizeUrl(clientId, redirectUri, state) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
  });
  return `${AUTHORIZE}?${q}`;
}

async function tokenRequest(env, params, fetchFn) {
  const res = await fetchFn(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || !data.access_token) return { error: data.error || `token request failed (${res.status})` };
  return { auth: { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 } };
}

export async function exchangeCode(env, code, redirectUri, fetchFn = fetch) {
  const r = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchFn);
  if (r.auth && !r.auth.refresh_token) return { error: "Google sent no refresh token" };
  return r;
}

/** A usable access token, refreshed when it expires within 5 minutes. */
export async function accessToken(env, fetchFn = fetch) {
  const auth = await readAuth(env, env.TIME, "google_auth");
  if (!auth) return { error: "not connected" };
  if (auth.expires_at - Date.now() > 5 * 60e3) return { token: auth.access_token };
  const r = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: auth.refresh_token }, fetchFn);
  if (!r.auth) return { error: r.error === "invalid_grant" ? "Google sign-in expired: connect again" : r.error };
  // Google keeps the same refresh token unless it sends a new one.
  const next = { ...r.auth, refresh_token: r.auth.refresh_token || auth.refresh_token };
  await writeAuth(env, env.TIME, "google_auth", next);
  return { token: next.access_token };
}

const isUrl = (s) => /^(https?:\/\/|www\.)/i.test(s) || /zoom\.us|meet\.google|teams\.microsoft/i.test(s);

/** One Calendar API event, cut down to what the app keeps. null for ones it skips. */
export function slim(e, cal = "p") {
  if (!e || e.status === "cancelled" || !e.start || !e.end) return null;
  if (e.eventType === "workingLocation" || e.eventType === "birthday") return null;
  const allDay = Boolean(e.start.date && !e.start.dateTime);
  const raw = String(e.summary || "(no title)");
  const title = raw.replace(/&amp;/g, "&").replace(/\s{2,}/g, " ").trim() || "(no title)";
  const loc = String(e.location || "").trim();
  const me = (e.attendees || []).find((a) => a && a.self);
  const out = {
    id: String(e.id).slice(0, 200), cal, title: title.slice(0, 160),
    start: allDay ? e.start.date : e.start.dateTime, end: allDay ? e.end.date : e.end.dateTime, allDay,
  };
  if (loc) out.loc = isUrl(loc) ? "Online" : loc.split(/[,(\n]/)[0].trim().slice(0, 60);
  if (e.htmlLink && /^https:\/\/www\.google\.com\/calendar\//.test(e.htmlLink)) out.link = e.htmlLink;
  if (e.transparency === "transparent") out.free = true;
  if (me && me.responseStatus === "declined") out.declined = true;
  if (((e.extendedProperties || {}).private || {})[MARK] === "1") out.mine = true;
  return out;
}

async function list(token, calendarId, timeMin, timeMax, tz, fetchFn) {
  const out = [];
  let page = null;
  for (let i = 0; i < 8; i++) {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500", fields: FIELDS, timeZone: tz });
    if (page) q.set("pageToken", page);
    const res = await fetchFn(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error("Google refused the token");
    if (!res.ok) {
      if (calendarId !== "primary") return out; // a holiday calendar that isn't there: skip
      throw new Error(`Google Calendar: ${res.status}`);
    }
    const data = await res.json();
    out.push(...(data.items || []));
    page = data.nextPageToken;
    if (!page) break;
  }
  return out;
}

/** Pull from `back` days ago to `ahead` days on, the primary calendar plus the public
 *  holidays (if a holiday calendar is set), into KV "events". */
export async function pull(env, { back = 98, ahead = 42, now = Date.now(), fetchFn = fetch, tz = DEFAULT_TZ, holidays = "" } = {}) {
  const t = await accessToken(env, fetchFn);
  if (t.error) return { error: t.error };
  const timeMin = new Date(now - back * 86400e3).toISOString();
  const timeMax = new Date(now + ahead * 86400e3).toISOString();
  try {
    const [mine, hols] = await Promise.all([list(t.token, "primary", timeMin, timeMax, tz, fetchFn),
      holidays ? list(t.token, holidays, timeMin, timeMax, tz, fetchFn) : []]);
    const items = [...mine.map((e) => slim(e, "p")), ...hols.map((e) => slim(e, "h"))].filter(Boolean);
    const out = { fetched_at: new Date(now).toISOString(), from: timeMin, to: timeMax, items };
    await env.TIME.put("events", JSON.stringify(out));
    return { ok: true, events: out };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 160) };
  }
}

/** Local "YYYY-MM-DD" + "HH:MM" as a wall-clock time; Google reads it in `timeZone`. */
export const wallTime = (date, hhmm) => `${date}T${hhmm}:00`;
/** The wall-clock time `minutes` after date + start (Google applies the zone's rules). */
export const wallPlus = (date, hhmm, minutes) => new Date(Date.parse(`${wallTime(date, hhmm)}Z`) + minutes * 60e3).toISOString().slice(0, 19);

/** The Calendar API fields for a change: only the ones given. */
function changes({ title, date, start, minutes, details, location }, tz = DEFAULT_TZ) {
  const body = {};
  if (title !== undefined) body.summary = title;
  if (date !== undefined) {
    body.start = { dateTime: wallTime(date, start), timeZone: tz };
    body.end = { dateTime: wallPlus(date, start, minutes), timeZone: tz };
  }
  if (details !== undefined) body.description = details;
  if (location !== undefined) body.location = location;
  return body;
}

/** Create an event on the primary calendar, marked as made by this app. */
export async function insert(env, ev, { fetchFn = fetch, tz = DEFAULT_TZ } = {}) {
  const t = await accessToken(env, fetchFn);
  if (t.error) return { error: t.error };
  const body = { ...changes(ev, tz), extendedProperties: { private: { [MARK]: "1" } } };
  const res = await fetchFn(`${API}/calendars/primary/events?fields=${encodeURIComponent(ITEM_FIELDS)}`, {
    method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `Google Calendar: ${res.status}` };
  return { event: slim(await res.json(), "p") };
}

/** Only events this app made can be changed or removed from it. */
async function ownEvent(token, id, fetchFn) {
  const res = await fetchFn(`${API}/calendars/primary/events/${encodeURIComponent(id)}?fields=id,status,extendedProperties/private`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: res.status === 404 ? "That event is gone" : `Google Calendar: ${res.status}` };
  const e = await res.json();
  if (((e.extendedProperties || {}).private || {})[MARK] !== "1") return { error: "Only events made in this app can be changed here; use Google Calendar for the rest." };
  return { ok: true };
}

export async function remove(env, id, { fetchFn = fetch } = {}) {
  const t = await accessToken(env, fetchFn);
  if (t.error) return { error: t.error };
  const own = await ownEvent(t.token, id, fetchFn);
  if (own.error) return own;
  const res = await fetchFn(`${API}/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${t.token}` } });
  return res.ok || res.status === 410 ? { ok: true } : { error: `Google Calendar: ${res.status}` };
}

export const move = (env, id, { date, start, minutes }, opts = {}) => edit(env, id, { date, start, minutes }, opts);

/** Change an event this app made: any of title, time, description, location. */
export async function edit(env, id, ev, { fetchFn = fetch, tz = DEFAULT_TZ } = {}) {
  const t = await accessToken(env, fetchFn);
  if (t.error) return { error: t.error };
  const own = await ownEvent(t.token, id, fetchFn);
  if (own.error) return own;
  const body = changes(ev, tz);
  const res = await fetchFn(`${API}/calendars/primary/events/${encodeURIComponent(id)}?fields=${encodeURIComponent(ITEM_FIELDS)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `Google Calendar: ${res.status}` };
  return { event: slim(await res.json(), "p") };
}
