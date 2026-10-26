// OAuth tokens at rest in KV, sealed with AES-GCM under the TOKEN_KEY Worker secret.
//
// Someone who can read the KV namespace (a Cloudflare account token, a dashboard
// session) would otherwise get a refresh token that never expires on its own.
// With TOKEN_KEY set, the record is {"sealed":1,"iv":…,"ct":…}; the key name is
// bound in as associated data, so a sealed record can't be moved to another key.
//
// Migration: a record written before TOKEN_KEY existed is plain JSON. It is read
// as before and sealed in place on that read. Without TOKEN_KEY everything stays
// plain JSON, exactly as before, so nothing breaks until the secret is set.
// The same file lives in secretary/app and health/app; keep the two identical.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.TOKEN_KEY) return null;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(String(env.TOKEN_KEY)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Store an auth record, sealed when TOKEN_KEY is set. */
export async function writeAuth(env, kv, name, auth) {
  const k = await key(env);
  if (!k) return kv.put(name, JSON.stringify(auth));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) },
    k, enc.encode(JSON.stringify(auth))));
  return kv.put(name, JSON.stringify({ sealed: 1, iv: b64(iv), ct: b64(ct) }));
}

/** The auth record, or null when missing or unreadable (wrong or missing key). Seals a plain one. */
export async function readAuth(env, kv, name) {
  const raw = await kv.get(name);
  if (!raw) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (v && v.sealed === 1) {
    const k = await key(env);
    if (!k) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv), additionalData: enc.encode(name) },
        k, unb64(v.ct));
      return JSON.parse(dec.decode(pt));
    } catch {
      return null;
    }
  }
  if (v && env.TOKEN_KEY) await writeAuth(env, kv, name, v);
  return v;
}
