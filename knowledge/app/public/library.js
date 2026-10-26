// The Library tab: the vault, in the app. Search, maps, entities (people, places, organisations), themes,
// the review queue (drafts and [!review] flags), notes with backlinks and a local graph, raw
// sources, editing, capturing new sources and asking KnowledgeBot about a note. Changes are
// queued for the bot, which commits them to the vault; the screen shows them at once.

import { h, s, icon, openSheet, closeSheet, toast, confirmBox, openLink, haptic, short } from "./ui.js";
import { render } from "./md.js";
import * as V from "./vault.js";

const FILTERS = [["all", "All", {}], ["concept", "Concepts", { type: "concept", raw: false }], ["entity", "Entities", { type: "entity", raw: false }],
  ["theme", "Themes", { type: "theme", raw: false }], ["raw", "Sources", { raw: true }], ["draft", "Drafts", { status: "draft", raw: false }], ["flag", "Flagged", { flagged: true, raw: false }]];
const TYPE_LABEL = { concept: "Concept", entity: "Entity fact", "concept-moc": "Map", "entity-moc": "Entity", "theme-moc": "Theme" };

export function libraryView(v, K) {
  const L = K.lib;
  if (!K.vault) {
    v.append(h("section", { class: "sec" }, h("h2", null, "Library"), h("p", { class: "empty" }, K.vaultError || "Loading the vault…")));
    return;
  }
  if (L.note) return noteView(v, K, L.note);
  if (L.mode === "review") return reviewView(v, K);
  if (L.mode === "moc") return mocView(v, K, L.moc);
  homeView(v, K);
}

function go(K, patch) {
  Object.assign(K.lib, patch);
  K.render();
  window.scrollTo(0, patch.note ? 0 : K.lib.scroll || 0);
}
export function openNote(K, target) {
  const n = V.get(K.vault, target);
  if (!n) { toast("That note isn't written yet."); return; }
  K.lib.stack.push({ note: K.lib.note, mode: K.lib.mode, moc: K.lib.moc });
  K.tab = "library";
  go(K, { note: n.k });
}
function back(K) {
  const prev = K.lib.stack.pop() || { note: null, mode: null, moc: null };
  go(K, prev);
}

/** Status after changes still waiting for the bot. */
function statusOf(K, n) {
  const p = K.pendingNote(n.p);
  if (p && p.deleted) return "deleted";
  return (p && p.status) || n.st;
}
/** Waiting for you: a draft, or a [!review] flag not yet approved (approving clears it). */
function waiting(K, n) {
  const p = K.pendingNote(n.p);
  if (p && (p.deleted || p.status === "reviewed")) return false;
  return statusOf(K, n) === "draft" || V.flagged(n);
}

function noteRow(K, n, sub) {
  const st = statusOf(K, n);
  return h("button", { class: "item", type: "button", onclick: () => openNote(K, n.t) },
    h("div", null, h("div", { class: "t" }, n.title || n.t), h("div", { class: "m" }, sub || [TYPE_LABEL[n.ty] || (n.raw ? "Source" : ""), n.mocs && n.mocs[0] ? ` · ${n.mocs[0]}` : ""].join(""))),
    h("div", { class: "side" }, st === "draft" ? h("span", { class: "tag draft" }, "draft") : null, V.flagged(n) ? h("div", null, h("span", { class: "tag flag" }, "flag")) : null));
}

function homeView(v, K) {
  const L = K.lib;
  const ix = K.vault;
  const input = h("input", { type: "search", placeholder: `Search ${V.stats(ix).notes} notes and ${V.stats(ix).raw} sources`, value: L.q || "", "aria-label": "Search the vault", autocomplete: "off" });
  const results = h("div", { class: "list" });
  const chips = h("div", { class: "scroller" }, FILTERS.map(([id, label]) => h("button", { class: "pill", type: "button", "aria-pressed": String((L.filter || "all") === id),
    onclick: () => { L.filter = id; run(); chips.querySelectorAll(".pill").forEach((b, i) => b.setAttribute("aria-pressed", String(FILTERS[i][0] === id))); } }, label)));
  const home = h("div", { style: "display:grid;gap:14px" });
  let timer = null;
  const run = () => {
    const f = (FILTERS.find((x) => x[0] === (L.filter || "all")) || FILTERS[0])[2];
    const q = (L.q || "").trim();
    if (!q && (L.filter || "all") === "all") { results.hidden = true; home.hidden = false; return; }
    const hits = V.search(ix, q, f, 80);
    results.replaceChildren(...(hits.length ? hits.map((x) => noteRow(K, x.n, x.snippet)) : [h("p", { class: "empty", style: "padding:12px 2px" }, "Nothing matches.")]));
    results.hidden = false;
    home.hidden = true;
  };
  input.addEventListener("input", () => { L.q = input.value; clearTimeout(timer); timer = setTimeout(run, 180); });
  v.append(h("div", { class: "search" }, h("div", { class: "box" }, icon("search"), input), chips));
  v.append(h("section", { class: "sec", style: "padding:6px 14px" }, results));

  const st = V.stats(ix);
  const queue = V.reviewQueue(ix).filter((n) => waiting(K, n));
  const deckDue = K.deckDue();
  home.append(h("section", { class: "sec" },
    h("header", null, h("div", null, h("h2", null, "Your second brain"), h("p", { class: "sub" }, `${st.notes} notes · ${st.raw} sources · ${st.reviewed} reviewed`)),
      h("button", { class: "pill", type: "button", onclick: () => captureSheet(K) }, icon("plus", "icon s"), "Capture")),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: () => go(K, { mode: "review", ri: 0 }) }, `Review queue · ${queue.length}`),
      deckDue.length ? h("button", { class: "btn quiet", type: "button", onclick: () => K.playDeck() }, `Your notes due · ${deckDue.length}`) : null),
    h("p", { class: "tiny" }, "Drafts and notes flagged [!review] wait for you. Approve one and KnowledgeBot marks it reviewed in the vault.")));
  if (!st.notes && !st.raw) {
    home.append(h("section", { class: "sec" }, h("h2", null, "Nothing here yet"),
      h("p", { class: "empty" }, "Your vault starts empty. Ask KnowledgeBot anything in Telegram and tap 📥 File it, or Capture an article or your own notes: KnowledgeBot keeps the source and writes the few notes worth keeping five years from now.")));
    v.append(home);
    run();
    return;
  }
  const m = V.mocs(ix);
  home.append(h("section", { class: "sec" }, h("h2", null, "Maps"),
    h("div", { class: "list" }, m.concept.map((n) => mocRow(K, n))),
    m.theme.length ? h("h2", { style: "margin-top:6px" }, "Themes") : null,
    m.theme.length ? h("div", { class: "list" }, m.theme.map((n) => mocRow(K, n))) : null));
  const entities = h("div", { class: "list" }, m.entity.map((n) => mocRow(K, n)));
  if (m.entity.length) home.append(h("section", { class: "sec" }, h("header", null, h("h2", null, "People, places and things"), h("span", { class: "tiny" }, `${m.entity.length}`)), entities));
  home.append(h("section", { class: "sec" }, h("h2", null, "Recently updated"), h("div", { class: "list" }, V.recent(ix, 15).map((n) => noteRow(K, n, `${TYPE_LABEL[n.ty] || ""} · ${short(n.up || n.cr)}`)))));
  v.append(home);
  run();
}

function mocRow(K, n) {
  const count = V.members(K.vault, n).length;
  return h("button", { class: "item", type: "button", onclick: () => { K.lib.stack.push({ note: null, mode: null, moc: null }); go(K, { mode: "moc", moc: n.k }); } },
    h("div", null, h("div", { class: "t" }, n.t)), h("div", { class: "side" }, `${count} notes`));
}

function mocView(v, K, k) {
  const n = K.vault.byKey.get(k);
  const ms = V.members(K.vault, n);
  const byType = { concept: ms.filter((x) => x.ty === "concept"), entity: ms.filter((x) => x.ty === "entity"), other: ms.filter((x) => !["concept", "entity"].includes(x.ty)) };
  v.append(h("div", { class: "crumbs" }, h("button", { class: "textbtn", type: "button", onclick: () => back(K) }, icon("back", "icon s"), "Back")));
  v.append(h("section", { class: "sec" }, h("header", null, h("div", null, h("p", { class: "caps" }, TYPE_LABEL[n.ty] || "Map"), h("h2", null, n.t)),
    h("button", { class: "pill", type: "button", onclick: () => openNote(K, n.t) }, "Open map")),
  byType.concept.length ? [h("p", { class: "caps" }, `Concepts · ${byType.concept.length}`), h("div", { class: "list" }, byType.concept.map((x) => noteRow(K, x)))] : null,
  byType.entity.length ? [h("p", { class: "caps" }, `Entity facts · ${byType.entity.length}`), h("div", { class: "list" }, byType.entity.map((x) => noteRow(K, x)))] : null,
  byType.other.length ? [h("p", { class: "caps" }, "Linked"), h("div", { class: "list" }, byType.other.map((x) => noteRow(K, x)))] : null));
}

function meta(K, n) {
  const st = statusOf(K, n);
  const stale = n.as && n.as < new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return h("div", { class: "row" },
    h("span", { class: "tag" }, n.raw ? "Source" : TYPE_LABEL[n.ty] || n.ty || "Note"),
    st ? h("span", { class: `tag ${st}` }, st) : null,
    V.flagged(n) ? h("span", { class: "tag flag" }, "review flag") : null,
    n.as ? h("span", { class: `tag${stale ? " stale" : ""}` }, `as of ${short(n.as)}`) : null,
    n.up ? h("span", { class: "tiny" }, `updated ${short(n.up)}`) : null,
    K.pendingNote(n.p) ? h("span", { class: "tag" }, "waiting for the bot") : null);
}

function noteView(v, K, k) {
  const n = K.vault.byKey.get(k);
  if (!n) { K.lib.note = null; return homeView(v, K); }
  const ix = K.vault;
  const opts = { resolve: (t) => Boolean(V.get(ix, t)), onWiki: (t) => openNote(K, t), onLink: openLink };
  const prose = h("div", { class: "prose" });
  prose.append(render(V.bodyOf(n), opts));
  const backs = V.backlinks(ix, n);
  const st = statusOf(K, n);
  const inDeck = K.inDeck(n.k);
  v.append(h("div", { class: "crumbs" }, h("button", { class: "textbtn", type: "button", onclick: () => back(K) }, icon("back", "icon s"), "Back"),
    n.mocs && n.mocs.length ? h("span", null, n.mocs.slice(0, 2).join(" · ")) : null));
  v.append(h("section", { class: `sec${n.raw ? " raw" : ""}` },
    h("div", { class: "notehead" }, h("h2", null, n.title || n.t), meta(K, n), n.tags && n.tags.length ? h("div", { class: "row" }, n.tags.slice(0, 6).map((t) => h("span", { class: "tiny" }, `#${t}`))) : null),
    prose,
    n.src && n.src.length ? h("div", { class: "sources" }, h("span", { class: "caps" }, "Sources"), n.src.map((x) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); openNote(K, x); } }, x.split("/").pop()))) : null));
  if (backs.length) v.append(h("section", { class: "sec" }, h("h2", null, `Linked from · ${backs.length}`), h("div", { class: "list" }, backs.slice(0, 40).map((b) => noteRow(K, b)))));
  const graphBox = h("div", { class: "graph" });
  v.append(h("section", { class: "sec" }, h("header", null, h("h2", null, "Graph"), h("span", { class: "tiny" }, "this note and its links")), graphBox));
  drawGraph(graphBox, K, n);
  if (n.raw) return;
  v.append(h("div", { class: "actionbar" },
    waiting(K, n)
      ? h("button", { type: "button", onclick: () => setStatus(K, n, "reviewed") }, icon("check"), "Approve")
      : h("button", { type: "button", class: "on", onclick: () => setStatus(K, n, "draft") }, icon("check"), "Reviewed"),
    h("button", { type: "button", class: inDeck ? "on" : null, onclick: () => { K.toggleDeck(n.k); K.render(); } }, icon("brain"), inDeck ? "In deck" : "Remember"),
    h("button", { type: "button", onclick: () => askSheet(K, n) }, icon("ask"), "Ask"),
    h("button", { type: "button", onclick: () => editSheet(K, n) }, icon("edit"), "Edit"),
    h("button", { type: "button", onclick: async () => { if (await confirmBox(`Delete “${(n.title || n.t).slice(0, 80)}”? KnowledgeBot removes it from the vault.`, "Delete")) { K.queue("note_delete", { path: n.p, base: n.h }); back(K); } } }, icon("trash"), "Delete")));
}

function setStatus(K, n, status) {
  K.queue("note_status", { path: n.p, status });
  haptic("success");
  toast(status === "reviewed" ? "Approved. KnowledgeBot marks it reviewed." : "Back to draft.");
  K.render();
}

function drawGraph(box, K, n) {
  const g = V.neighbourhood(K.vault, n, 1, 28);
  if (g.nodes.length < 2) { box.append(h("p", { class: "empty" }, "No links yet.")); return; }
  const W = 340, H = 280;
  const pts = V.layout(g, W, H);
  const at = new Map(pts.map((p) => [p.k, p]));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${g.nodes.length} linked notes` });
  for (const [a, b] of g.edges) { const p = at.get(a), q = at.get(b); svg.append(s("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y })); }
  for (const p of pts) {
    const isMe = p.k === n.k;
    const col = isMe ? "var(--gold)" : /moc/.test((p.n || {}).ty || "") ? "var(--node)" : (p.n || {}).raw ? "var(--locked)" : "var(--good)";
    const label = ((p.n && (p.n.title || p.n.t)) || p.k).slice(0, 26);
    svg.append(s("g", { onclick: () => { if (!isMe) openNote(K, p.n.t); } },
      s("circle", { cx: p.x, cy: p.y, r: isMe ? 9 : 6, fill: col }),
      s("text", { x: p.x + 9, y: p.y + 3 }, label)));
  }
  box.append(svg);
}

function reviewView(v, K) {
  const queue = V.reviewQueue(K.vault).filter((n) => waiting(K, n)).filter((n) => !K.lib.skipped.has(n.k));
  v.append(h("div", { class: "crumbs" }, h("button", { class: "textbtn", type: "button", onclick: () => back(K) }, icon("back", "icon s"), "Library"), h("span", null, `${queue.length} waiting`)));
  const n = queue[0];
  if (!n) { v.append(h("section", { class: "sec" }, h("h2", null, "All caught up"), h("p", { class: "empty" }, "No drafts or flags left. Nice."))); return; }
  const prose = h("div", { class: "prose" });
  prose.append(render(V.bodyOf(n), { resolve: (t) => Boolean(V.get(K.vault, t)), onWiki: (t) => openNote(K, t), onLink: openLink }));
  v.append(h("section", { class: "sec" }, h("div", { class: "notehead" }, h("h2", null, n.title || n.t), meta(K, n)), prose));
  v.append(h("div", { class: "actionbar" },
    h("button", { type: "button", class: "on", onclick: () => { setStatus(K, n, "reviewed"); } }, icon("check"), "Approve"),
    h("button", { type: "button", onclick: () => { K.lib.skipped.add(n.k); K.render(); window.scrollTo(0, 0); } }, icon("back"), "Later"),
    h("button", { type: "button", onclick: () => editSheet(K, n) }, icon("edit"), "Edit"),
    h("button", { type: "button", onclick: async () => { if (await confirmBox("Delete this note?", "Delete")) { K.queue("note_delete", { path: n.p, base: n.h }); K.render(); } } }, icon("trash"), "Delete")));
}

function askSheet(K, n) {
  const ta = h("textarea", { class: "field", placeholder: "What do you want to know? KnowledgeBot answers in Telegram, with sources." });
  openSheet(h("h2", { id: "sheet-title" }, "Ask about this note"), h("p", { class: "note" }, n.title || n.t), ta,
    h("button", { class: "btn", type: "button", onclick: () => { if (!ta.value.trim()) return; K.queue("ask", { q: ta.value.trim(), path: n.p }); closeSheet(); toast("Sent. The answer comes in Telegram."); } }, "Ask"));
}

function captureSheet(K) {
  const title = h("input", { class: "field", placeholder: "Title (optional)" });
  const ta = h("textarea", { class: "field", placeholder: "Paste an article, notes or a link. KnowledgeBot files it in the vault (raw source, then 0–3 notes)." });
  openSheet(h("h2", { id: "sheet-title" }, "Capture"), title, ta,
    h("button", { class: "btn", type: "button", onclick: () => { if (!ta.value.trim()) return; K.queue("capture", { title: title.value.trim() || null, text: ta.value }); closeSheet(); toast("Captured. KnowledgeBot files it."); } }, "File it"));
}

/** The editor: the whole note (frontmatter and all), with [[link]] suggestions. */
function editSheet(K, n) {
  const full = `---\n${frontText(n)}---\n\n${n.b}`;
  const ta = h("textarea", { class: "field editor", spellcheck: "false" });
  ta.value = K.pendingNote(n.p) && K.pendingNote(n.p).text ? K.pendingNote(n.p).text : full;
  const sug = h("div", { class: "suggest", hidden: true });
  ta.addEventListener("input", () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /\[\[([^\]\n]{2,})$/.exec(upto);
    if (!m) { sug.hidden = true; return; }
    const hits = V.search(K.vault, m[1], { raw: false }, 6);
    sug.replaceChildren(...hits.map((x) => h("button", { type: "button", onclick: () => {
      const start = ta.selectionStart - m[1].length;
      ta.value = ta.value.slice(0, start) + x.n.t + "]]" + ta.value.slice(ta.selectionStart);
      sug.hidden = true;
      ta.focus();
    } }, x.n.t)));
    sug.hidden = !hits.length;
  });
  openSheet(h("h2", { id: "sheet-title" }, "Edit note"), h("p", { class: "tiny" }, "Markdown. Type [[ to link a note. KnowledgeBot saves it to the vault and fixes links if needed."), ta, sug,
    h("button", { class: "btn", type: "button", onclick: () => { K.queue("note_edit", { path: n.p, base: n.h, text: ta.value }); closeSheet(); toast("Saved. KnowledgeBot commits it."); K.render(); } }, "Save"));
}

function frontText(n) {
  const lines = [];
  if (n.ty) lines.push(`type: ${n.ty}`);
  if (n.title) lines.push(`title: "${n.title}"`);
  if (n.cr) lines.push(`created: ${n.cr}`);
  if (n.up) lines.push(`updated: ${n.up}`);
  if (n.st) lines.push(`status: ${n.st}`);
  if (n.as) lines.push(`as_of: ${n.as}`);
  if (n.src && n.src.length) lines.push("sources:", ...n.src.map((x) => `  - "[[${x}]]"`));
  if (n.mocs && n.mocs.length) lines.push("mocs:", ...n.mocs.map((x) => `  - "[[${x}]]"`));
  if (n.tags && n.tags.length) lines.push("tags:", ...n.tags.map((x) => `  - ${x}`));
  return lines.join("\n") + "\n";
}
