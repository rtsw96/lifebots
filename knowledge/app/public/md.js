// A small Markdown renderer for the vault: builds DOM nodes directly (never innerHTML), so
// nothing in a note can run as code. Covers what the vault uses: headings, paragraphs, lists
// (nested), tables, block quotes and Obsidian callouts (> [!review] ...), fenced code,
// horizontal rules, **bold**, *italic*, ==highlight==, ~~strike~~, `code`, [[wikilinks]]
// (with #heading and |alias), [links](https://...) and footnote markers.
//
//   render(markdown, {resolve(target) -> bool, onWiki(target), onLink(url)}) -> DocumentFragment

const WIKI = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/y;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/y;

function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

/** Inline markup into a fragment. */
export function inline(text, opts = {}) {
  const out = document.createDocumentFragment();
  let buf = "";
  const flush = () => { if (buf) { out.append(buf); buf = ""; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const j = text.indexOf("`", i + 1);
      if (j > i) { flush(); out.append(el("code", null, text.slice(i + 1, j))); i = j + 1; continue; }
    }
    if (ch === "[" && text[i + 1] === "[") {
      WIKI.lastIndex = i;
      const m = WIKI.exec(text);
      if (m) {
        flush();
        const target = m[1].trim();
        const exists = opts.resolve ? opts.resolve(target) : true;
        const a = el("a", exists ? "wiki" : "wiki missing", (m[3] || target.split("/").pop()).trim());
        a.href = "#";
        a.dataset.target = target;
        if (!exists) a.title = "Not written yet";
        a.addEventListener("click", (e) => { e.preventDefault(); if (opts.onWiki) opts.onWiki(target, m[2] ? m[2].slice(1) : null); });
        out.append(a);
        i = WIKI.lastIndex;
        continue;
      }
    }
    if (ch === "[" && text[i + 1] === "^") {
      const j = text.indexOf("]", i);
      if (j > i) { flush(); out.append(el("sup", "fn", text.slice(i + 2, j))); i = j + 1; continue; }
    }
    if (ch === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(text);
      if (m) {
        flush();
        const a = el("a", "ext", inline(m[1], opts));
        a.href = m[2];
        a.rel = "noopener noreferrer";
        a.addEventListener("click", (e) => { e.preventDefault(); if (opts.onLink) opts.onLink(m[2]); });
        out.append(a);
        i = LINK.lastIndex;
        continue;
      }
    }
    const pairs = [["**", "strong"], ["__", "strong"], ["==", "mark"], ["~~", "s"]];
    let hit = false;
    for (const [mk, tag] of pairs) {
      if (text.startsWith(mk, i)) {
        const j = text.indexOf(mk, i + 2);
        if (j > i + 2) { flush(); out.append(el(tag, null, inline(text.slice(i + 2, j), opts))); i = j + 2; hit = true; break; }
      }
    }
    if (hit) continue;
    if ((ch === "*" || ch === "_") && text[i + 1] && text[i + 1] !== " " && text[i + 1] !== ch) {
      const j = text.indexOf(ch, i + 1);
      const wordy = ch === "_" && /\w/.test(text[i - 1] || "");
      if (j > i + 1 && !wordy && text[j - 1] !== " ") { flush(); out.append(el("em", null, inline(text.slice(i + 1, j), opts))); i = j + 1; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function listBlock(lines, start, opts) {
  // consecutive list lines (and their wrapped continuations), nested by indent
  const root = { indent: -1, el: null, items: [] };
  const stack = [root];
  let i = start;
  let lastLi = null;
  while (i < lines.length) {
    const l = lines[i];
    const m = LIST.exec(l);
    if (!m) {
      if (l.trim() && lastLi && /^\s{2,}/.test(l)) { lastLi.append(" ", inline(l.trim(), opts)); i++; continue; }
      break;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    const ordered = /\d/.test(m[2]);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top.el || indent > top.indent) {
      const listEl = el(ordered ? "ol" : "ul");
      if (top === root && !root.el) root.el = listEl;
      else if (lastLi) lastLi.append(listEl);
      top = { indent, el: listEl };
      stack.push(top);
    }
    let body = m[3];
    const li = el("li");
    const task = /^\[( |x|X)\]\s+/.exec(body);
    if (task) { const cb = el("span", task[1] === " " ? "task" : "task done", task[1] === " " ? "☐ " : "☑ "); li.append(cb); body = body.slice(task[0].length); }
    li.append(inline(body, opts));
    top.el.append(li);
    lastLi = li;
    i++;
  }
  return [root.el, i];
}

/** Render a markdown document into a fragment. */
export function render(md, opts = {}) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)(.*)$/.exec(l);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.append(el("pre", null, el("code", null, body.join("\n"))));
      continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hd) {
      const n = Math.min(6, hd[1].length + 1); // the note's # title is shown as h2 under the app's own header
      const hEl = el(`h${n}`, null, inline(hd[2].replace(/\s+#+\s*$/, ""), opts));
      hEl.id = "h-" + hd[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
      out.append(hEl);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.append(el("hr")); i++; continue; }
    if (/^\s*>/.test(l)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const call = /^\[!(\w+)\]([+-]?)\s*(.*)$/.exec(body[0] || "");
      if (call) {
        const box = el("aside", `callout callout-${call[1].toLowerCase()}`);
        box.append(el("p", "callout-title", call[3] ? inline(call[3], opts) : call[1].replace(/^./, (c) => c.toUpperCase())));
        box.append(render(body.slice(1).join("\n"), opts));
        out.append(box);
      } else {
        out.append(el("blockquote", null, render(body.join("\n"), opts)));
      }
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const table = el("table");
      const head = el("tr");
      for (const c of cells(l)) head.append(el("th", null, inline(c, opts)));
      table.append(el("thead", null, head));
      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const tr = el("tr");
        for (const c of cells(lines[i])) tr.append(el("td", null, inline(c, opts)));
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      out.append(el("div", "table-wrap", table));
      continue;
    }
    if (LIST.test(l)) {
      const [listEl, j] = listBlock(lines, i, opts);
      if (listEl) out.append(listEl);
      i = j;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*```|\s*~~~)/.test(lines[i]) && !LIST.test(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++].trim());
    out.append(el("p", null, inline(para.join(" "), opts)));
  }
  return out;
}

/** Plain text of a note body (for search snippets and previews). */
export function plain(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?\[![^\]]+\]\s*/gm, "")
    .replace(/[#>*_=`|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
