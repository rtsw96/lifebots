// End-to-end encryption for the finance app. Shared by the phone (the app) and
// the bot (seal.mjs, run under Node), so both sides do exactly the same thing.
//
// Each phone makes its own key pair (ECDH P-256). The private key is created
// non-extractable and kept in the phone's IndexedDB; it never leaves the
// device. The bot encrypts each snapshot with a fresh random key (AES-256-GCM)
// and wraps that key once per approved device: an ephemeral ECDH key pair, the
// shared secret run through HKDF-SHA256, AES-GCM. The Worker only ever stores
// the sealed blob and public keys, so Cloudflare holds nothing it can read.

const te = new TextEncoder();
const td = new TextDecoder();
const INFO = te.encode("finance-app v1");
const EC = { name: "ECDH", namedCurve: "P-256" };

export const b64 = (bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64 = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Short, human-checkable fingerprint of a public key: SHA-256 of "x.y", 12 hex digits. */
export async function fingerprint(pub) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(`${pub.x}.${pub.y}`)));
  const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

export async function newDeviceKeys() {
  const pair = await crypto.subtle.generateKey(EC, false, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, pub: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
}

async function wrapKey(privateKey, publicJwk, salt) {
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, ext: true }, EC, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt `data` (any JSON) for each device {id, pub:{x,y}}. */
export async function seal(data, devices) {
  const content = crypto.getRandomValues(new Uint8Array(32));
  const ck = await crypto.subtle.importKey("raw", content, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, te.encode(JSON.stringify(data)));
  const keys = [];
  for (const d of devices) {
    const eph = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
    const epk = await crypto.subtle.exportKey("jwk", eph.publicKey);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kiv = crypto.getRandomValues(new Uint8Array(12));
    const wk = await wrapKey(eph.privateKey, d.pub, salt);
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: kiv }, wk, content);
    keys.push({ dev: d.id, epk: { x: epk.x, y: epk.y }, salt: b64(salt), iv: b64(kiv), wk: b64(wrapped) });
  }
  return { v: 1, iv: b64(iv), ct: b64(ct), keys };
}

/** Decrypt a sealed blob with this device's private key. Throws if it isn't for this device. */
export async function open(sealed, deviceId, privateKey) {
  const k = (sealed.keys || []).find((x) => x.dev === deviceId);
  if (!k) throw new Error("not sealed for this device");
  const wk = await wrapKey(privateKey, k.epk, unb64(k.salt));
  const content = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(k.iv) }, wk, unb64(k.wk));
  const ck = await crypto.subtle.importKey("raw", content, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, ck, unb64(sealed.ct));
  return JSON.parse(td.decode(pt));
}
