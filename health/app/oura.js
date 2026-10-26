// Oura: sign-in (OAuth2) and the daily summaries the app keeps.
// Only per-day summaries are stored: sleep and readiness scores, sleep times and
// stages, HRV, lowest heart rate, breathing rate, temperature deviation, SpO2,
// steps. No per-minute heart rate, no raw samples.
//
// Tokens live in KV ("oura_auth", sealed under the TOKEN_KEY secret: tokenbox.js). Oura's refresh tokens are single-use, so a
// refresh writes the new pair at once, and a failed refresh re-reads KV in case
// another run already refreshed.

import { readAuth, writeAuth } from "./tokenbox.js";

export const AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize";
export const TOKEN = "https://api.ouraring.com/oauth/token";
const API = "https://api.ouraring.com/v2/usercollection";
export const SCOPES = "daily heartrate workout spo2";
const KEEP_DAYS = 400;

const hhmm = (iso) => (typeof iso === "string" && /T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : null);
const hours = (sec) => (Number.isFinite(sec) ? Math.round((sec / 3600) * 100) / 100 : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

export function authorizeUrl(clientId, redirectUri, state) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state });
  return `${AUTHORIZE}?${q}`;
}

/** Turn Oura's collections into one row per day. Sleep belongs to the day you wake up. */
export function summarise({ dailySleep = [], sleep = [], readiness = [], spo2 = [], activity = [] }) {
  const days = {};
  const day = (d) => (days[d] = days[d] || {});
  for (const x of dailySleep) if (x && x.day) day(x.day).sleep_score = x.score ?? null;
  // The main sleep of the night: Oura marks it long_sleep; otherwise take the longest.
  const best = {};
  for (const x of sleep) {
    if (!x || !x.day || x.type === "rest") continue;
    const cur = best[x.day];
    const rank = (y) => (y.type === "long_sleep" ? 1e9 : 0) + (y.total_sleep_duration || 0);
    if (!cur || rank(x) > rank(cur)) best[x.day] = x;
  }
  for (const [d, x] of Object.entries(best)) {
    Object.assign(day(d), {
      sleep_h: hours(x.total_sleep_duration), deep_h: hours(x.deep_sleep_duration), rem_h: hours(x.rem_sleep_duration),
      awake_h: hours(x.awake_time), efficiency: x.efficiency ?? null,
      bed: hhmm(x.bedtime_start), wake: hhmm(x.bedtime_end),
      hrv: Number.isFinite(x.average_hrv) ? Math.round(x.average_hrv) : null,
      rhr: Number.isFinite(x.lowest_heart_rate) ? Math.round(x.lowest_heart_rate) : null,
      resp: r1(x.average_breath),
    });
  }
  for (const x of readiness) {
    if (!x || !x.day) continue;
    Object.assign(day(x.day), { readiness: x.score ?? null, temp_dev: r1(x.temperature_deviation) });
  }
  for (const x of spo2) {
    if (!x || !x.day) continue;
    const v = x.spo2_percentage && x.spo2_percentage.average;
    if (Number.isFinite(v)) day(x.day).spo2 = r1(v);
  }
  for (const x of activity) {
    if (!x || !x.day) continue;
    Object.assign(day(x.day), { steps: x.steps ?? null, active_kcal: x.active_calories ?? null });
  }
  for (const d of Object.values(days)) for (const k of Object.keys(d)) if (d[k] == null) delete d[k];
  return days;
}

/** Newer figures replace a day's older ones; days past KEEP_DAYS drop off. */
export function mergeDays(stored, add, today) {
  const out = { ...((stored && stored.days) || {}) };
  for (const [d, v] of Object.entries(add)) out[d] = { ...(out[d] || {}), ...v };
  const cut = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
  for (const d of Object.keys(out)) if (d < cut) delete out[d];
  return { ...(stored || {}), days: out };
}

async function tokenRequest(env, params, fetchFn) {
  const res = await fetchFn(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: env.OURA_CLIENT_ID, client_secret: env.OURA_CLIENT_SECRET }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || !data.access_token) return { error: data.error || `token request failed (${res.status})` };
  return {
    auth: { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (Number(data.expires_in) || 86400) * 1000 },
  };
}

export async function exchangeCode(env, code, redirectUri, fetchFn = fetch) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchFn);
}

/** A usable access token, refreshing it if it expires within 10 minutes. */
export async function accessToken(env, fetchFn = fetch) {
  const auth = await readAuth(env, env.HEALTH, "oura_auth");
  if (!auth) return { error: "not connected" };
  if (auth.expires_at - Date.now() > 10 * 60e3) return { token: auth.access_token };
  const r = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: auth.refresh_token }, fetchFn);
  if (r.auth) {
    await writeAuth(env, env.HEALTH, "oura_auth", r.auth);
    return { token: r.auth.access_token };
  }
  // Another run may have used the refresh token first.
  const again = await readAuth(env, env.HEALTH, "oura_auth");
  if (again && again.refresh_token !== auth.refresh_token && again.expires_at - Date.now() > 60e3) return { token: again.access_token };
  return { error: r.error === "invalid_grant" ? "Oura sign-in expired: connect again" : r.error };
}

async function collection(name, token, start, end, fetchFn) {
  const out = [];
  let next = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ start_date: start, end_date: end });
    if (next) q.set("next_token", next);
    const res = await fetchFn(`${API}/${name}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error("Oura refused the token");
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) return out; // scope not granted, or no membership for this one
      throw new Error(`Oura ${name}: ${res.status}`);
    }
    const data = await res.json();
    out.push(...(data.data || []));
    next = data.next_token;
    if (!next) break;
  }
  return out;
}

/** Pull start..end (inclusive dates) and merge into KV "oura". */
export async function pull(env, start, end, fetchFn = fetch) {
  const t = await accessToken(env, fetchFn);
  if (t.error) {
    await env.HEALTH.put("oura_status", JSON.stringify({ at: new Date().toISOString(), ok: false, note: t.error }));
    return { error: t.error };
  }
  // Oura's sleep end_date is exclusive for some collections: ask for one day more.
  const endPlus = new Date(Date.parse(`${end}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
  try {
    const [dailySleep, sleep, readiness, spo2, activity] = await Promise.all([
      collection("daily_sleep", t.token, start, endPlus, fetchFn), collection("sleep", t.token, start, endPlus, fetchFn),
      collection("daily_readiness", t.token, start, endPlus, fetchFn), collection("daily_spo2", t.token, start, endPlus, fetchFn),
      collection("daily_activity", t.token, start, endPlus, fetchFn)]);
    const add = summarise({ dailySleep, sleep, readiness, spo2, activity });
    const stored = await env.HEALTH.get("oura", "json");
    const next = mergeDays(stored, add, end);
    next.updated_at = new Date().toISOString();
    await env.HEALTH.put("oura", JSON.stringify(next));
    await env.HEALTH.put("oura_status", JSON.stringify({ at: next.updated_at, ok: true, days: Object.keys(add).length }));
    return { ok: true, days: Object.keys(add).length };
  } catch (e) {
    await env.HEALTH.put("oura_status", JSON.stringify({ at: new Date().toISOString(), ok: false, note: String(e.message || e).slice(0, 120) }));
    return { error: String(e.message || e) };
  }
}
