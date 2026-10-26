// The lesson player: lessons, review blocks, placement tests and the note deck, full screen.
// One exercise at a time: answer, Check, see why (with sources), Continue. Mistakes come back at
// the end of the lesson once. Nothing here changes progress: it reports a result to the caller.

import { h, icon, $, haptic, speak, canSpeak, openSheet, closeSheet, toast, openLink, lsGet } from "./ui.js";
import { mark, placementState, numericChoice, furigana } from "./learn.js";
import { render } from "./md.js";
import { drawPet, poke } from "./pet.js";

const KIND_LABEL = { mcq: "Choose", multi: "Choose all that apply", tf: "True or false", cloze: "Fill the gap", numeric: "Estimate", order: "Put in order",
  match: "Match", build: "Build the sentence", type: "Type it", free: "Explain", teach: "New" };

function stage(...kids) {
  const st = $("stage");
  st.replaceChildren(...kids);
  st.hidden = false;
  document.body.style.overflow = "hidden";
  return st;
}
export function closeStage() {
  $("stage").hidden = true;
  $("stage").replaceChildren();
  document.body.style.overflow = "";
  try { speechSynthesis.cancel(); } catch { /* none */ }
}

function sourcesEl(srcs) {
  const list = (Array.isArray(srcs) ? srcs : srcs ? [srcs] : []).filter(Boolean);
  if (!list.length) return null;
  return h("div", { class: "sources" }, h("span", { class: "caps" }, "Sources"), list.map((x) => {
    const label = x.title || x.cite || (x.dict ? `${x.dict}${x.id ? ` #${x.id}` : ""}` : x.note || "source");
    return x.url ? h("a", { href: x.url, onclick: (e) => { e.preventDefault(); openLink(x.url); } }, label) : h("span", null, label);
  }));
}

function speakBtn(text, lang, wide) {
  if (!text || !canSpeak(lang)) return null;
  return h("button", { class: wide ? "speak wide" : "speak", type: "button", "aria-label": "Listen", onclick: () => speak(text, lang) }, icon("sound"), wide ? "Listen" : null);
}

/** A teaching card: a new word, kana, sentence or concept. */
function teachEl(card, ctx) {
  const lang = card.lang || (card.kind === "kana" ? "ja" : null);
  if (card.kind === "kana") {
    return h("div", { class: "teach" }, h("span", { class: "badge-new" }, "NEW CHARACTER"),
      h("div", { class: "big", lang: "ja" }, card.char), h("div", { class: "reading" }, card.romaji), h("div", { class: "row", style: "justify-content:center" }, speakBtn(card.char, "ja", true)));
  }
  if (card.kind === "char") return charTeach(card);
  if (card.kind === "word" || card.kind === "sentence") {
    return h("div", { class: "teach" }, h("span", { class: "badge-new" }, card.kind === "word" ? "NEW WORD" : "NEW PHRASE"),
      h("div", { class: card.kind === "word" ? "big" : "show mid", lang }, lang === "ja" ? jaText(card.text, card.reading) : card.text),
      card.reading && card.reading !== card.text ? h("div", { class: "reading", lang }, card.reading) : null,
      card.trad && card.trad !== card.text ? h("div", { class: "reading", lang }, `Traditional: ${card.trad}`) : null,
      h("div", { class: "meaning" }, Array.isArray(card.meaning) ? card.meaning.join("; ") : card.meaning),
      h("div", { class: "row", style: "justify-content:center" }, speakBtn(card.text, lang, true)),
      card.example ? h("div", { class: "ex" }, h("div", { lang }, lang === "ja" ? jaText(card.example.text, card.example.reading) : card.example.text), h("div", { class: "tr" }, card.example.meaning)) : null,
      card.note ? h("p", { class: "note" }, card.note) : null,
      sourcesEl(card.source));
  }
  // pattern or concept: Brilliant-style explanation
  const meta = h("div", { class: "meta" },
    card.evidence ? h("span", { class: "tag" }, `Evidence: ${card.evidence}`) : null);
  const body = h("div", { class: "prose" });
  body.append(render(card.explain || "", { onLink: openLink }));
  return h("div", { class: "teach" }, h("span", { class: "badge-new" }, card.kind === "pattern" ? "PATTERN" : card.kind === "intro" ? "LESSON" : "IDEA"),
    h("h3", { class: "prompt", lang: card.lang || null }, card.kind === "pattern" ? card.pattern : card.title),
    card.kind === "pattern" ? h("p", { class: "meaning" }, card.meaning) : null,
    meta.childNodes.length ? meta : null, body,
    card.examples ? h("div", { class: "ex" }, card.examples.map((e) => h("div", null, h("div", { lang: card.lang }, card.lang === "ja" ? jaText(e.text, e.reading) : e.text), h("div", { class: "tr" }, e.meaning)))) : null,
    sourcesEl(card.sources));
}

const FORMATION_LABEL = {
  "phono-semantic": "Meaning + sound (形声)", pictograph: "Picture (象形)", indicative: "Pointer (指事)",
  ideograph: "Meaning + meaning (会意)", other: "Simplified or borrowed form",
};
const ROLE_LABEL = { meaning: "meaning", sound: "sound", form: "part" };

/** A character: big, its pinyin and meaning, how it's built (each part and what it does), the
 *  words it makes and its sound family. */
function charTeach(card) {
  const parts = (card.parts || []).map((x) => h("div", { class: `part ${x.role}` },
    h("span", { class: "pc", lang: "zh" }, x.part),
    h("span", null, h("b", null, ROLE_LABEL[x.role] || "part"), x.name ? ` · ${x.name}` : "", x.reading ? ` · ${x.reading}` : "")));
  return h("div", { class: "teach char-teach" }, h("span", { class: "badge-new" }, card.rank ? `CHARACTER #${card.rank}` : "NEW CHARACTER"),
    h("div", { class: "big", lang: "zh" }, card.text),
    h("div", { class: "reading", lang: "zh" }, card.reading),
    card.trad && card.trad !== card.text ? h("div", { class: "reading", lang: "zh" }, `Traditional: ${card.trad}`) : null,
    h("div", { class: "meaning" }, Array.isArray(card.meaning) ? card.meaning.join("; ") : card.meaning),
    h("div", { class: "row", style: "justify-content:center" }, speakBtn(card.text, "zh", true)),
    card.formation ? h("p", { class: "caps formation" }, FORMATION_LABEL[card.formation] || card.formation) : null,
    parts.length ? h("div", { class: "parts" }, parts) : null,
    (card.words || []).length ? h("div", { class: "ex words" }, card.words.map((w) => h("div", { class: "w" },
      h("span", { lang: "zh" }, w.text), h("span", { class: "r", lang: "zh" }, w.reading), h("span", { class: "tr" }, w.meaning)))) : null,
    card.family && card.family.length ? h("p", { class: "note" }, h("b", null, "Same sound part: "), h("span", { lang: "zh" }, card.family.join(" "))) : null,
    card.note ? h("p", { class: "note" }, card.note) : null,
    sourcesEl(card.source));
}

/** Build the interactive part of one exercise. answer() returns the current answer or undefined. */
function exerciseEl(ex, ctx) {
  const lang = ex.lang || null;
  const wrap = h("div", { class: "ex-wrap", style: "display:grid;gap:14px" });
  let answer;
  const changed = () => ctx.onChange(answer !== undefined && answer !== "" && !(Array.isArray(answer) && !answer.length));
  const listenOnly = ex.listen && canSpeak(lang || "ja");
  wrap.append(h("p", { class: "ex-kind" }, ex.listen ? "Listen" : ex.numeric ? "Estimate: pick the closest" : KIND_LABEL[ex.type] || ""));
  if (ex.listen && !listenOnly) {
    wrap.append(h("p", { class: "prompt" }, ex.prompt.replace("Which one do you hear?", "Which is this?").replace("What did you hear?", "What does this mean?")), h("div", { class: "show", lang }, ex.listen));
  } else if (ex.listen) {
    wrap.append(h("p", { class: "prompt" }, ex.prompt), h("div", { class: "row", style: "justify-content:center" }, speakBtn(ex.listen, lang || "ja", true)));
    setTimeout(() => speak(ex.listen, lang || "ja"), 250);
  } else {
    wrap.append(h("p", { class: `prompt${lang && !ex.readDrill && !ex.charDrill && !ex.big ? " big-cjk" : ""}`, lang: ex.readDrill || ex.charDrill ? null : lang }, ex.prompt));
    if (ex.show) {
      const box = h("div", { class: `show${String(ex.show).length > 2 ? " mid" : ""}${ex.readDrill ? " readme" : ""}`, lang });
      box.append(lang === "ja" ? jaText(ex.show, ex.read, { none: ex.noFuri || !ex.read }) : ex.show);
      wrap.append(box);
    }
    if (ex.say) { const b = speakBtn(ex.say, lang || "ja", true); if (b) wrap.append(h("div", { class: "row", style: "justify-content:center" }, b)); }
  }
  const choose = (opts, multi) => {
    const big = ex.big || opts.every((o) => String(o).length <= 2);
    const box = h("div", { class: `opts${big || opts.every((o) => String(o).length <= 14) ? " grid" : ""}` });
    const btns = opts.map((o, i) => h("button", { class: `opt${big ? " big" : ""}`, type: "button", lang: ex.latin ? null : big ? (lang || "ja") : lang, "aria-pressed": "false", onclick: () => {
      haptic("soft"); sfx("tap");
      if (multi) {
        const on = btns[i].getAttribute("aria-pressed") !== "true";
        btns[i].setAttribute("aria-pressed", String(on));
        answer = btns.map((b, j) => (b.getAttribute("aria-pressed") === "true" ? j : -1)).filter((j) => j >= 0);
      } else {
        btns.forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
        answer = i;
      }
      changed();
    } }, String(o)));
    box.append(...btns);
    wrap.append(box);
    return btns;
  };
  let btns = null;
  switch (ex.type) {
    case "mcq": btns = choose(ex.options, false); break;
    case "multi": btns = choose(ex.options, true); break;
    case "tf": {
      btns = choose(["True", "False"], false);
      const raw = () => answer;
      ctx.translate = () => (raw() === undefined ? undefined : raw() === 0);
      break;
    }
    case "cloze":
      if (ex.options) {
        btns = choose(ex.options, false);
        ctx.translate = () => (answer === undefined ? undefined : ex.options[answer]);
        break;
      }
      // falls through to typing
    case "type":
    case "numeric": {
      const inp = h("input", { class: "field", type: ex.type === "numeric" ? "text" : "text", inputmode: ex.type === "numeric" ? "decimal" : null, lang, autocomplete: "off", autocapitalize: "off", spellcheck: "false",
        placeholder: ex.type === "numeric" ? "Your estimate" : "Type here", oninput: () => { answer = inp.value.trim(); changed(); },
        onkeydown: (e) => { if (e.key === "Enter" && answer) ctx.submit(); } });
      wrap.append(ex.type === "numeric" && ex.unit ? h("div", { class: "row", style: "flex-wrap:nowrap" }, inp, h("span", { class: "unit" }, ex.unit)) : inp);
      setTimeout(() => inp.focus(), 200);
      break;
    }
    case "order":
    case "build": {
      const pool = ex.type === "order" ? shuffled(ex.items) : ex.tiles;
      const ans = h("div", { class: "tiles answer", lang });
      const bank = h("div", { class: "tiles", lang });
      const picked = [];
      const redraw = () => {
        ans.replaceChildren(...picked.map((i, k) => h("button", { class: "tile", type: "button", onclick: () => { picked.splice(k, 1); redraw(); } }, pool[i])));
        bank.querySelectorAll(".tile").forEach((t, i) => t.classList.toggle("used", picked.includes(i)));
        answer = picked.length ? picked.map((i) => pool[i]) : undefined;
        changed();
      };
      bank.append(...pool.map((t, i) => h("button", { class: "tile", type: "button", onclick: () => { if (!picked.includes(i)) { haptic("soft"); sfx("tap"); picked.push(i); redraw(); } } }, t)));
      wrap.append(ans, bank);
      break;
    }
    case "match": {
      const left = shuffled(ex.pairs.map((p) => p[0])), right = shuffled(ex.pairs.map((p) => p[1]));
      const L = h("div", { class: "col" }), R = h("div", { class: "col" });
      let sel = null, done = 0;
      ctx.mistakes = 0;
      const tap = (side, val, btn) => {
        haptic("soft"); sfx("tap");
        if (!sel || sel.side === side) {
          if (sel) sel.btn.setAttribute("aria-pressed", "false");
          sel = { side, val, btn };
          btn.setAttribute("aria-pressed", "true");
          return;
        }
        const [l, r] = side === "R" ? [sel.val, val] : [val, sel.val];
        const ok = ex.pairs.some((p) => p[0] === l && p[1] === r);
        const pair = [sel.btn, btn];
        sel = null;
        if (ok) {
          pair.forEach((b) => { b.classList.add("right"); b.setAttribute("aria-pressed", "false"); setTimeout(() => b.classList.add("gone"), 250); });
          if (++done === ex.pairs.length) { answer = true; changed(); setTimeout(() => ctx.submit(), 350); }
        } else {
          ctx.mistakes++;
          haptic("error");
          pair.forEach((b) => { b.classList.add("wrong"); setTimeout(() => { b.classList.remove("wrong"); b.setAttribute("aria-pressed", "false"); }, 450); });
        }
      };
      L.append(...left.map((v) => { const b = h("button", { class: "opt", type: "button", lang: ex.lang || null, onclick: () => tap("L", v, b) }, v); return b; }));
      R.append(...right.map((v) => { const b = h("button", { class: "opt", type: "button", onclick: () => tap("R", v, b) }, v); return b; }));
      wrap.append(h("div", { class: "match" }, L, R));
      break;
    }
    case "free": {
      const ta = h("textarea", { class: "field", placeholder: "Write your answer. KnowledgeBot gives feedback in Telegram.", oninput: () => { answer = ta.value.trim(); changed(); } });
      wrap.append(ta);
      break;
    }
    default: break;
  }
  return { el: wrap, get: () => (ctx.translate ? ctx.translate() : answer), btns };
}

// ------------------------------------------------------------------ sound and celebration
// Short synthesised chimes (Web Audio, no files): a two-note "ding-ding" for a right answer, a
// rising run for a streak milestone, a soft low blip for a miss, a light tick on each tap. Off in
// Settings (per device). iPhones mute Web Audio when the ring switch is on silent, so the page asks
// for the "playback" audio session (iOS 17+), as a game or a video would, and wakes the audio on
// the first touch: Safari only lets a page start sound inside a tap.
let actx = null;
export const SOUND_KEY = "kb.sound";
const NOTES = {
  tap: [[1318.5, 0]],
  right: [[1046.5, 0], [1568, 0.085]],
  streak: [[784, 0], [988, 0.07], [1175, 0.14], [1568, 0.21], [2093, 0.3]],
  wrong: [[294, 0], [220, 0.11]],
  done: [[523.3, 0], [659.3, 0.11], [784, 0.22], [1046.5, 0.33], [1318.5, 0.45]],
};
function audio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback"; } catch { /* older WebKit */ }
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  return actx.state === "running" ? Promise.resolve(actx) : actx.resume().then(() => actx);
}
/** Wake the audio on the first touch (and after the app comes back), so the first chime isn't lost. */
export function unlockAudio() {
  const wake = () => { if (lsGet(SOUND_KEY, "on") !== "off") audio().catch(() => {}); };
  for (const ev of ["pointerdown", "touchend", "keydown"]) document.addEventListener(ev, wake, { capture: true, passive: true });
}
export function sfx(kind) {
  if (lsGet(SOUND_KEY, "on") === "off" || !NOTES[kind]) return;
  let ready;
  try { ready = audio(); } catch { return; }
  ready.then((ac) => {
    const t0 = ac.currentTime + 0.01;
    const peak = kind === "wrong" ? 0.09 : kind === "tap" ? 0.05 : 0.2;
    for (const [f, at] of NOTES[kind]) {
      for (const [mult, share, type] of [[1, 1, kind === "wrong" ? "triangle" : "sine"], [2, 0.25, "sine"]]) { // a bell: the note plus a soft octave
        if ((kind === "wrong" || kind === "tap") && mult === 2) continue;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type;
        o.frequency.value = f * mult;
        const t = t0 + at, len = kind === "tap" ? 0.06 : kind === "done" && at === 0.45 ? 0.7 : 0.32;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak * share, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(ac.destination);
        o.start(t);
        o.stop(t + len + 0.05);
      }
    }
  }).catch(() => { /* no audio here: carry on silently */ });
}

function burst(host, big) {
  if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = h("div", { class: `burst${big ? " big" : ""}`, "aria-hidden": "true" });
  const n = big ? 34 : 18;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const d = (big ? 150 : 95) + Math.random() * (big ? 90 : 50);
    const bit = h("i", { class: `c${i % 4}` });
    bit.style.setProperty("--dx", `${Math.round(Math.cos(a) * d)}px`);
    bit.style.setProperty("--dy", `${Math.round(Math.sin(a) * d - (big ? 60 : 30))}px`);
    bit.style.setProperty("--r", `${Math.round(Math.random() * 540 - 270)}deg`);
    bit.style.animationDelay = `${Math.round(Math.random() * 60)}ms`;
    layer.append(bit);
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 1300);
}

const STREAK_AT = (n) => n === 3 || n === 5 || (n >= 10 && n % 5 === 0);

// ------------------------------------------------------------------ furigana
export const FURI_KEY = "kb.furigana";
/** Japanese text with furigana over the kanji (from its reading). With furigana off in Settings,
 *  the readings are hidden and a tap on the text shows them. `none`: plain text, no readings at all
 *  (reading drills). */
export function jaText(text, reading, { cls = "", none = false } = {}) {
  const el = h("span", { class: `ja ${cls}`.trim(), lang: "ja" });
  if (none || !reading) { el.textContent = text; return el; }
  for (const seg of furigana(text, reading)) {
    if (!seg.r) { el.append(seg.t); continue; }
    el.append(h("ruby", null, seg.t, h("rp", null, "("), h("rt", null, seg.r), h("rp", null, ")")));
  }
  if (lsGet(FURI_KEY, "on") === "off" && el.querySelector("rt")) {
    el.classList.add("furi-hidden");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `${text}: tap to show the reading`);
    el.addEventListener("click", () => el.classList.toggle("furi-peek"));
  }
  return el;
}

function shuffled(xs) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function rightAnswerText(ex) {
  switch (ex.type) {
    case "mcq": return ex.options[ex.answer];
    case "multi": return ex.answer.map((i) => ex.options[i]).join("; ");
    case "tf": return ex.answer ? "True" : "False";
    case "cloze": return ex.answer[0];
    case "type": return ex.accept[0];
    case "numeric": return `${ex.answer}${ex.unit ? ` ${ex.unit}` : ""} (within ${Math.round(ex.tolerance * 100)}%)`;
    case "order": return ex.items.join(" → ");
    case "build": return ex.answer.join("");
    default: return "";
  }
}

/** Play a list of exercises. opts: {title, exercises, ctx: app context, track, onDone(result), onQuit} */
export function play(opts) {
  const { ctx } = opts;
  const queue = opts.exercises.map((x) => ({ ...x }));
  const total = queue.filter((x) => x.type !== "teach").length;
  const firstTry = {}; // card -> ok on first attempt (false if any miss)
  let right = 0, graded = 0, run = 0, bestRun = 0, steps = 0;
  const t0 = Date.now();
  const bar = h("span", { style: "width:0%" });
  const combo = h("span", { class: "combo" });
  const body = h("div", { class: "stage-body" });
  const foot = h("div", { class: "stage-foot" });
  const quit = async () => { if (opts.onQuit) opts.onQuit(); closeStage(); };
  // Back: re-read the reading (teach) cards already passed. From a question not yet checked, or
  // from a later reading card, it steps back one reading card; the step you left comes next again.
  const seen = [];
  let cur = null;
  const back = () => {
    if (!seen.length) return;
    queue.unshift(cur);
    queue.unshift(seen.pop());
    steps -= 2;
    next();
  };
  const withBack = (main) => (seen.length
    ? h("div", { class: "foot-pair" }, h("button", { class: "btn big quiet back", type: "button", "aria-label": "Back to the last card", onclick: back }, icon("back"), "Back"), main)
    : main);
  stage(h("div", { class: "stage-top" }, h("button", { class: "x", type: "button", "aria-label": "Quit the lesson", onclick: quit }, icon("close")),
    h("div", { class: "prog", role: "progressbar", "aria-label": "Lesson progress" }, bar), combo), body, foot);

  const next = () => {
    const ex = queue.shift();
    if (!ex) return finish();
    cur = ex;
    steps++;
    bar.style.width = `${Math.min(100, Math.round((100 * (steps - 1)) / (steps + queue.length)))}%`;
    body.scrollTop = 0;
    if (ex.type === "teach") {
      body.replaceChildren(teachEl(ctx.card(ex.card) || ex.card, ctx));
      const card = ctx.card(ex.card) || ex.card;
      if (card && (card.kind === "word" || card.kind === "kana" || card.kind === "sentence")) setTimeout(() => speak(card.char || card.text, card.lang || "ja"), 300);
      foot.replaceChildren(withBack(h("button", { class: "btn big", type: "button", onclick: () => { seen.push(ex); next(); } }, "Continue")));
      return;
    }
    const st = { onChange: (ready) => { check.disabled = !ready; }, submit: () => { if (!check.disabled) doCheck(); } };
    const view = exerciseEl(ex, st);
    body.replaceChildren(view.el);
    // A question never assumes you remember the idea behind it: the idea is one tap away
    const idea = ctx.card(ex.card);
    if (idea && idea.explain && (idea.kind === "concept" || idea.kind === "pattern")) {
      body.append(h("button", { class: "textbtn recap", type: "button", onclick: () => openSheet(h("h2", { id: "sheet-title" }, "The idea"), teachEl(idea, ctx)) }, "Recap the idea"));
    }
    const check = h("button", { class: "btn big", type: "button", disabled: true, onclick: () => doCheck() }, ex.type === "free" ? "Send for feedback" : "Check");
    foot.replaceChildren(ex.type === "match" ? h("p", { class: "tiny", style: "text-align:center" }, "Tap a pair to match it") : withBack(check));
    const doCheck = () => {
      const ans = view.get();
      if (ex.type === "free") {
        ctx.queue("answer", { track: opts.track || "x", card: ex.card || "x", prompt: ex.prompt, text: ans, rubric: ex.rubric || null });
        feedback(true, null, "Sent. KnowledgeBot will reply with feedback in Telegram.", ex);
        return;
      }
      const res = ex.type === "match" ? { ok: (st.mistakes || 0) === 0 } : mark(ex, ans);
      if (view.btns && (ex.type === "mcq" || ex.type === "tf" || (ex.type === "cloze" && ex.options))) {
        const correctIdx = ex.type === "tf" ? (ex.answer ? 0 : 1) : ex.type === "cloze" ? ex.options.indexOf(ex.answer.find((a) => ex.options.includes(a))) : ex.answer;
        view.btns.forEach((b, i) => { b.disabled = true; if (i === correctIdx) b.classList.add("right"); else if (b.getAttribute("aria-pressed") === "true") b.classList.add("wrong"); });
      }
      const first = !ex.retry;
      if (first) graded++;
      let milestone = false;
      if (res.ok) {
        if (first) right++;
        run++;
        bestRun = Math.max(bestRun, run);
        milestone = STREAK_AT(run);
        if (ex.card && firstTry[ex.card] === undefined) firstTry[ex.card] = true;
        haptic("success");
        sfx(milestone ? "streak" : "right");
      } else {
        if (run >= 3) toast(`Streak ended at ${run}. Go again!`);
        run = 0;
        if (ex.card) firstTry[ex.card] = false;
        haptic("error");
        sfx("wrong");
        if (!ex.retry && ex.type !== "match") queue.push({ ...ex, retry: true }); // it comes back once, at the end
      }
      showStreak(milestone);
      feedback(res.ok, res.close, ex.explain, ex, milestone);
    };
    const feedback = (ok, close, explain, ex2, milestone = false) => {
      check.disabled = true;
      const card = ex2.card ? ctx.card(ex2.card) : null;
      const box = h("div", { class: `feedback ${ok ? "ok" : "no"}${ok ? " pop" : ""}${milestone ? " streak" : ""}` },
        h("h3", null, milestone ? `🔥 ${run} in a row!` : ok ? ["Nice!", "Correct!", "Exactly.", "Well done.", "Spot on!"][steps % 5] : close === "tones" ? "Almost: check the tones" : "Not quite"),
        !ok && rightAnswerText(ex2) ? h("p", null, h("b", null, "Answer: "), h("span", { lang: ex2.lang || null }, rightAnswerText(ex2))) : null,
        explain ? h("p", null, explain) : null,
        ex2.readDrill && card ? h("p", null, h("span", { lang: "ja" }, card.text), ` · ${card.romaji ? `${card.romaji} · ` : ""}${card.meaning}`) : null,
        ex2.charDrill && card && !ex2.word ? h("p", null, h("span", { lang: "zh", class: "fb-char" }, card.text), ` · ${card.reading} · ${Array.isArray(card.meaning) ? card.meaning.join("; ") : card.meaning}`) : null,
        ex2.charDrill && ex2.word ? h("p", null, h("span", { lang: "zh", class: "fb-char" }, ex2.word.text), ` · ${ex2.word.reading} · ${ex2.word.meaning}`) : null,
        ex2.charDrill && ex2.sayAfter ? h("div", { class: "row" }, speakBtn(ex2.sayAfter, "zh", false)) : null,
        ex2.readDrill && ex2.sayAfter ? h("div", { class: "row" }, speakBtn(ex2.sayAfter, "ja", false)) : null,
        card && card.note && ok ? h("p", null, card.note) : null,
        h("div", { class: "actions" },
          h("button", { class: "textbtn", type: "button", onclick: () => reportSheet(ctx, ex2, card, opts.track) }, icon("flag", "icon s"), " Report a problem"),
          card && (card.sources || card.source) ? h("button", { class: "textbtn", type: "button", onclick: () => openSheet(h("h2", { id: "sheet-title" }, "Sources"), sourcesEl(card.sources || card.source)) }, "Sources") : null));
      foot.replaceChildren(box, h("button", { class: `btn big ${ok ? "good" : "bad"}`, type: "button", onclick: next }, "Continue"));
      if (ok) burst(body, milestone);
      if (ex2.sayAfter) setTimeout(() => speak(ex2.sayAfter, ex2.lang || "ja"), 650); // hear what you just read
    };
  };
  // The answer streak: a flame counter in the top bar from 2 right in a row; it jumps on each one
  // and flares at 3, 5, 10, 15...
  const showStreak = (milestone) => {
    combo.replaceChildren(...(run >= 2 ? [h("span", { class: "flame", "aria-hidden": "true" }, "🔥"), h("b", null, String(run))] : []));
    combo.setAttribute("aria-label", run >= 2 ? `${run} right in a row` : "");
    combo.classList.toggle("on", run >= 2);
    combo.classList.remove("bump", "flare");
    void combo.offsetWidth; // restart the animation
    if (run >= 2) combo.classList.add(milestone ? "flare" : "bump");
  };

  const finish = () => {
    bar.style.width = "100%";
    const secs = Math.round((Date.now() - t0) / 1000);
    const result = { right, total: graded || total, perfect: graded > 0 && right === graded, cards: firstTry, secs, best_run: bestRun };
    const out = opts.onDone ? opts.onDone(result) : null;
    const pet = drawPet("owl", { mood: 95, level: 1, size: 150 });
    body.replaceChildren(h("div", { class: "end" },
      h("button", { class: "pet-tap", type: "button", "aria-label": "Pat Blue", onclick: () => poke(pet, "owl") }, pet),
      h("h2", null, opts.endTitle || (result.perfect ? "Perfect lesson!" : "Lesson complete!")),
      h("div", { class: "tiles3" },
        h("div", { class: "t3" }, h("span", { class: "caps" }, "XP"), h("b", null, `+${(out && out.xp) || 0}`)),
        h("div", { class: "t3" }, h("span", { class: "caps" }, "Accuracy"), h("b", null, `${graded ? Math.round((100 * right) / graded) : 100}%`)),
        h("div", { class: "t3" }, h("span", { class: "caps" }, bestRun >= 2 ? "Best streak" : "Time"), h("b", null, bestRun >= 2 ? `🔥 ${bestRun}` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`))),
      out && out.line ? h("p", { class: "note" }, out.line) : null));
    setTimeout(() => poke(pet, "owl"), 300);
    sfx("done");
    burst(body, true);
    foot.replaceChildren(h("button", { class: "btn big", type: "button", onclick: () => { closeStage(); if (opts.after) opts.after(); } }, "Continue"));
  };
  next();
}

function reportSheet(ctx, ex, card, track) {
  const ta = h("textarea", { class: "field", placeholder: "What looks wrong? (a reading, a fact, a translation…)" });
  openSheet(h("h2", { id: "sheet-title" }, "Report a problem"),
    h("p", { class: "note" }, "KnowledgeBot checks this card against its sources and fixes or removes it."),
    ta,
    h("button", { class: "btn", type: "button", onclick: () => {
      ctx.queue("report", { track: track || (card && card.track) || "x", card: (card && card.id) || ex.card || "x", text: ta.value.trim() || "(no note)", prompt: ex.prompt || null });
      closeSheet();
      toast("Thanks: sent to KnowledgeBot.");
    } }, "Send"));
}

/** The placement test: works up the bands until one is failed. onDone({band, start, label}). */
export function placement(opts) {
  const { pl, ctx } = opts;
  const answers = [];
  const bar = h("span", { style: "width:0%" });
  const body = h("div", { class: "stage-body" });
  const foot = h("div", { class: "stage-foot" });
  stage(h("div", { class: "stage-top" }, h("button", { class: "x", type: "button", "aria-label": "Stop the test", onclick: closeStage }, icon("close")),
    h("div", { class: "prog" }, bar), h("span", { class: "combo" })), body, foot);
  const intro = () => {
    body.replaceChildren(h("div", { class: "teach" }, h("span", { class: "badge-new" }, "PLACEMENT"), h("h3", { class: "prompt" }, `Find your level: ${opts.name}`),
      h("p", null, pl.intro || "A few quick questions, getting harder. Answer what you know; it's fine to miss. You'll start where it gets hard."),
      h("p", { class: "note" }, `${pl.bands.length} levels, about 2 minutes.`)));
    foot.replaceChildren(h("button", { class: "btn big", type: "button", onclick: step }, "Start"),
      h("button", { class: "textbtn", type: "button", onclick: () => done({ band: pl.bands[0].band, start: pl.bands[0].start, label: pl.bands[0].label, skipped: true }) }, "Skip: start from the beginning"));
  };
  const step = () => {
    const s = placementState(pl, answers);
    bar.style.width = `${Math.round((100 * (s.band + (s.done ? 1 : 0))) / pl.bands.length)}%`;
    if (s.done) return done(s);
    const q = { ...numericChoice(s.item.q) };
    const st = { onChange: (ready) => { check.disabled = !ready; }, submit: () => { if (!check.disabled) doCheck(); } };
    const view = exerciseEl(q, st);
    body.replaceChildren(h("p", { class: "caps" }, s.label), view.el);
    const check = h("button", { class: "btn big", type: "button", disabled: true }, "Check");
    const doCheck = () => {
      const res = q.type === "match" ? { ok: (st.mistakes || 0) <= 1 } : mark(q, view.get());
      answers.push({ band: s.band, i: s.item.i, ok: res.ok });
      haptic(res.ok ? "success" : "error");
      sfx(res.ok ? "right" : "wrong");
      foot.replaceChildren(h("div", { class: `feedback ${res.ok ? "ok" : "no"}` }, h("h3", null, res.ok ? "Right" : "Not this time"),
        !res.ok && rightAnswerText(q) ? h("p", null, h("b", null, "Answer: "), rightAnswerText(q)) : null),
        h("button", { class: `btn big ${res.ok ? "good" : "bad"}`, type: "button", onclick: step }, "Continue"));
    };
    check.addEventListener("click", doCheck);
    foot.replaceChildren(q.type === "match" ? h("p", { class: "tiny", style: "text-align:center" }, "Tap a pair to match it") : check);
  };
  const done = (s) => {
    const out = opts.onDone(s);
    const pet = drawPet("owl", { mood: 90, level: 1, size: 140 });
    body.replaceChildren(h("div", { class: "end" }, pet, h("h2", null, "Placed!"),
      h("p", { class: "prompt" }, `You start at: ${s.label}`),
      out && out.line ? h("p", { class: "note" }, out.line) : null));
    setTimeout(() => poke(pet, "owl"), 300);
    foot.replaceChildren(h("button", { class: "btn big", type: "button", onclick: () => { closeStage(); if (opts.after) opts.after(); } }, "Continue"));
  };
  intro();
}

/** Your own notes, spaced: read the claim, recall the mechanism, then grade yourself. */
export function deck(opts) {
  const { notes, ctx } = opts;
  let i = 0;
  const graded = [];
  const bar = h("span", { style: "width:0%" });
  const body = h("div", { class: "stage-body" });
  const foot = h("div", { class: "stage-foot" });
  stage(h("div", { class: "stage-top" }, h("button", { class: "x", type: "button", "aria-label": "Stop", onclick: () => { opts.onDone(graded); closeStage(); } }, icon("close")),
    h("div", { class: "prog" }, bar), h("span", { class: "combo" })), body, foot);
  const show = () => {
    if (i >= notes.length) { opts.onDone(graded); closeStage(); if (opts.after) opts.after(); return; }
    const n = notes[i];
    bar.style.width = `${Math.round((100 * i) / notes.length)}%`;
    body.replaceChildren(h("p", { class: "caps" }, "From your vault"), h("h3", { class: "notehead" }, h("span", { style: "font:600 22px/1.35 var(--serif)" }, n.title || n.t)),
      h("p", { class: "note" }, "Recall the mechanism and why it matters, then reveal."));
    foot.replaceChildren(h("button", { class: "btn big", type: "button", onclick: reveal }, "Reveal"));
  };
  const reveal = () => {
    const n = notes[i];
    const prose = h("div", { class: "prose" });
    prose.append(render((n.b || "").replace(/^\s*#\s+[^\n]*\n+/, ""), { resolve: ctx.resolveNote, onWiki: () => {}, onLink: openLink }));
    body.append(prose);
    const g = (v) => () => { graded.push({ note: n.k, g: v }); i++; show(); };
    foot.replaceChildren(h("div", { class: "row", style: "display:grid;grid-template-columns:repeat(4,1fr)" },
      h("button", { class: "btn bad", type: "button", onclick: g(1) }, "Again"), h("button", { class: "btn quiet", type: "button", onclick: g(2) }, "Hard"),
      h("button", { class: "btn good", type: "button", onclick: g(3) }, "Good"), h("button", { class: "btn", type: "button", onclick: g(4) }, "Easy")));
  };
  show();
}
