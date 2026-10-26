// The vault in the browser: an index over the notes bundle (names, links, backlinks, search,
// the review queue, a local graph). Pure apart from nothing: no DOM here, tested in Node.
//
// Bundle note: {p: path, t: title (filename stem), ty: type, st: status, mocs: [], tags: [],
//               cr, up, as (as_of), src: [sources], b: body without the frontmatter}

import { plain } from "./md.js";

const LINKS = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
export const keyOf = (target) => {
  const k = String(target).trim().split("/").pop().toLowerCase();
  return k.endsWith(".md") ? k.slice(0, -3) : k;
};

export function buildIndex(bundle) {
  const notes = bundle.notes || [];
  const byKey = new Map();
  for (const n of notes) {
    n.k = keyOf(n.t);
    n.raw = n.p.startsWith("raw/");
    if (!byKey.has(n.k)) byKey.set(n.k, n);
  }
  const back = new Map();
  const missing = new Map();
  for (const n of notes) {
    n.out = [];
    LINKS.lastIndex = 0;
    const seen = new Set();
    for (const m of (n.b || "").matchAll(LINKS)) {
      const k = keyOf(m[1]);
      if (seen.has(k) || k === n.k) continue;
      seen.add(k);
      if (byKey.has(k)) {
        n.out.push(k);
        if (!back.has(k)) back.set(k, []);
        back.get(k).push(n.k);
      } else {
        missing.set(k, (missing.get(k) || 0) + 1);
      }
    }
    for (const m of n.mocs || []) {
      const k = keyOf(m.replace(/^\[\[|\]\]$/g, ""));
      if (byKey.has(k) && !seen.has(k)) { n.out.push(k); seen.add(k); if (!back.has(k)) back.set(k, []); back.get(k).push(n.k); }
    }
    n.lc = null; // lower-case text, built on first search
  }
  return { notes, byKey, back, missing, version: bundle.version, built: bundle.built };
}

export const get = (ix, target) => ix.byKey.get(keyOf(target)) || null;
/** The body without its leading "# Title" line (the app shows the title itself). */
export const bodyOf = (n) => (n.b || "").replace(/^\s*#\s+[^\n]*\n+/, "");
export const backlinks = (ix, n) => (ix.back.get(n.k) || []).map((k) => ix.byKey.get(k)).filter(Boolean);
export const isMoc = (n) => /moc$/.test(n.ty || "");
export const flagged = (n) => (n.b || "").includes("> [!review]");

/** Notes waiting on the owner: drafts and notes with a [!review] flag (not raw sources). */
export function reviewQueue(ix) {
  return ix.notes.filter((n) => !n.raw && !isMoc(n) && (n.st === "draft" || flagged(n)))
    .sort((a, b) => (b.up || b.cr || "").localeCompare(a.up || a.cr || ""));
}

export function recent(ix, n = 20) {
  return ix.notes.filter((x) => !x.raw).sort((a, b) => (b.up || b.cr || "").localeCompare(a.up || a.cr || "")).slice(0, n);
}

export function mocs(ix) {
  const out = { concept: [], entity: [], theme: [] };
  for (const n of ix.notes) {
    if (n.ty === "concept-moc") out.concept.push(n);
    else if (n.ty === "entity-moc") out.entity.push(n);
    else if (n.ty === "theme-moc") out.theme.push(n);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t.localeCompare(b.t));
  return out;
}

/** Notes under a MOC: those linking to it in `mocs:` or by link, and those it links to. */
export function members(ix, moc) {
  const set = new Set([...(ix.back.get(moc.k) || []), ...moc.out]);
  return [...set].map((k) => ix.byKey.get(k)).filter((n) => n && !isMoc(n) && !n.raw).sort((a, b) => a.t.localeCompare(b.t));
}

/** Full-text search: every word must appear; the title counts most. Filters: {type, status, raw}. */
export function search(ix, query, f = {}, limit = 60) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const n of ix.notes) {
    if (f.raw === false && n.raw) continue;
    if (f.raw === true && !n.raw) continue;
    if (f.type && !(n.ty || "").startsWith(f.type)) continue;
    if (f.status && n.st !== f.status) continue;
    if (f.flagged && !flagged(n)) continue;
    if (!words.length) { hits.push({ n, score: 0 }); continue; }
    const title = n.k;
    if (n.lc == null) n.lc = (n.b || "").toLowerCase();
    let score = 0, ok = true;
    for (const w of words) {
      const inT = title.includes(w);
      const tags = (n.tags || []).some((t) => t.toLowerCase().includes(w));
      let c = 0, at = n.lc.indexOf(w);
      while (at >= 0 && c < 6) { c++; at = n.lc.indexOf(w, at + w.length); }
      if (!inT && !c && !tags) { ok = false; break; }
      score += (inT ? 20 : 0) + (tags ? 6 : 0) + c;
    }
    if (ok) hits.push({ n, score: score + (n.raw ? -3 : 0) + (isMoc(n) ? 4 : 0) });
  }
  hits.sort((a, b) => b.score - a.score || a.n.t.localeCompare(b.n.t));
  return hits.slice(0, limit).map((h) => ({ ...h, snippet: snippet(h.n, words) }));
}

export function snippet(n, words, width = 140) {
  const text = plain(bodyOf(n));
  const low = text.toLowerCase();
  const at = words.length ? Math.max(0, ...words.map((w) => low.indexOf(w)).filter((x) => x >= 0).slice(0, 1)) : 0;
  const start = Math.max(0, at - 40);
  return (start ? "…" : "") + text.slice(start, start + width) + (start + width < text.length ? "…" : "");
}

/** Notes within `depth` links of n (either direction), for the local graph. */
export function neighbourhood(ix, n, depth = 1, cap = 36) {
  const nodes = new Map([[n.k, 0]]);
  let frontier = [n.k];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const k of frontier) {
      const x = ix.byKey.get(k);
      for (const j of [...(x ? x.out : []), ...(ix.back.get(k) || [])]) {
        if (!nodes.has(j) && nodes.size < cap) { nodes.set(j, d); next.push(j); }
      }
    }
    frontier = next;
  }
  const keys = [...nodes.keys()];
  const edges = [];
  for (const k of keys) for (const j of (ix.byKey.get(k) || { out: [] }).out) if (nodes.has(j)) edges.push([k, j]);
  return { nodes: keys.map((k) => ({ k, d: nodes.get(k), n: ix.byKey.get(k) })), edges };
}

/** A small force layout (deterministic), positions in [0, w] x [0, h]. */
export function layout(graph, w = 340, h = 300, iters = 220) {
  const pts = graph.nodes.map((nd, i) => {
    const a = (i / graph.nodes.length) * Math.PI * 2;
    const r = nd.d === 0 ? 0 : 60 + 50 * nd.d;
    return { x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a), vx: 0, vy: 0, fixed: nd.d === 0 };
  });
  const idx = new Map(graph.nodes.map((nd, i) => [nd.k, i]));
  for (let t = 0; t < iters; t++) {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
      const d2 = Math.max(80, dx * dx + dy * dy), f = 1800 / d2;
      const fx = f * dx / Math.sqrt(d2), fy = f * dy / Math.sqrt(d2);
      pts[i].vx -= fx; pts[i].vy -= fy; pts[j].vx += fx; pts[j].vy += fy;
    }
    for (const [a, b] of graph.edges) {
      const p = pts[idx.get(a)], q = pts[idx.get(b)];
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 70) * 0.02;
      p.vx += f * dx / d; p.vy += f * dy / d; q.vx -= f * dx / d; q.vy -= f * dy / d;
    }
    for (const p of pts) {
      if (p.fixed) { p.x = w / 2; p.y = h / 2; p.vx = p.vy = 0; continue; }
      p.vx += (w / 2 - p.x) * 0.004; p.vy += (h / 2 - p.y) * 0.004;
      p.x = Math.min(w - 14, Math.max(14, p.x + p.vx * 0.5)); p.y = Math.min(h - 14, Math.max(14, p.y + p.vy * 0.5));
      p.vx *= 0.6; p.vy *= 0.6;
    }
  }
  return pts.map((p, i) => ({ ...graph.nodes[i], x: p.x, y: p.y }));
}

export function stats(ix) {
  const out = { notes: 0, raw: 0, draft: 0, reviewed: 0, flagged: 0, missing: ix.missing.size };
  for (const n of ix.notes) {
    if (n.raw) { out.raw++; continue; }
    out.notes++;
    if (n.st === "draft") out.draft++;
    if (n.st === "reviewed") out.reviewed++;
    if (flagged(n)) out.flagged++;
  }
  return out;
}
