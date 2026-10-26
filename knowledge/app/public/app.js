// Knowledge app (the KnowledgeBot's Telegram Mini App). Three tabs:
//   Learn    the daily 10-minute session, placement tests, quests, Blue the owl, a path per topic;
//            on a fresh install, "What do you want to learn?" (the bot writes the first lessons)
//   Library  the vault: search, maps, notes, review queue, edits, capture, ask
//   You      streak, league, badges, settings
// Learning progress is changed only by events (learn.js applyEvent). Events made offline wait on
// the phone and are replayed on top of the server copy, so two devices never overwrite each other.
// Vault changes and questions are queued for the bot, which commits them and answers in Telegram.

import { h, icon, $, tg, api, gunzipJson, idbGet, idbPut, lsGet, lsSet, toast, openSheet, closeSheet, haptic, localDay as sgDay, localMins as sgMins, fmt, short, when } from "./ui.js";
import * as L from "./learn.js";
import * as V from "./vault.js";
import { play, placement, deck, sfx, SOUND_KEY, FURI_KEY, unlockAudio } from "./player.js";
import { libraryView, openNote } from "./library.js";
import { drawPet, poke, liven } from "./pet.js";

// Strand pills: "main" and "mine" have fixed names; a side path names itself on its first unit
// (strand_label, strand_about), else its id is shown.
const STRAND_LABEL = { main: "Path", mine: "Your words" };
const STRAND_ABOUT = { mine: "Words you met and sent to the bot. Up to 10 a lesson, in the order you sent them." };
function strandInfo(units, x) {
  const u = (units.find((v) => (v.unit.strand || "main") === x) || {}).unit || {};
  return { label: u.strand_label || STRAND_LABEL[x] || x.charAt(0).toUpperCase() + x.slice(1), about: u.strand_about || STRAND_ABOUT[x] || "" };
}
const LS = { base: "kb.base", out: "kb.outbox", qout: "kb.qout", track: "kb.track", theme: "kb.theme", day: "kb.day", topics: "kb.topics" };

const K = {
  tab: "learn", track: lsGet(LS.track, null), lib: { stack: [], skipped: new Set() },
  content: null, ix: null, vault: null, vaultError: null, meta: null,
  base: lsGet(LS.base, { progress: L.emptyProgress(), rev: 0 }), outbox: lsGet(LS.out, []), qout: lsGet(LS.qout, []), queueItems: [],
  progress: null, online: true,
};

// ------------------------------------------------------------------ progress and events
function recompute() {
  K.progress = K.outbox.reduce((p, ev) => L.applyEvent(p, ev), { ...L.emptyProgress(), ...(K.base.progress || {}) });
}
function addEvents(evs) {
  K.outbox.push(...evs);
  lsSet(LS.out, K.outbox);
  recompute();
  scheduleSave();
}
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveProgress, 1200); }
async function saveProgress(retry = true) {
  if (!K.outbox.length) return;
  const sending = K.outbox.length;
  try {
    const r = await api("/api/progress", { rev: K.base.rev, progress: K.progress });
    K.base = { progress: K.progress, rev: r.rev };
    K.outbox = K.outbox.slice(sending);
    lsSet(LS.base, K.base);
    lsSet(LS.out, K.outbox);
    recompute();
  } catch (e) {
    if (e.status === 409 && retry) { await pull(); return saveProgress(false); }
    K.online = false; // kept on the phone; sent next time
  }
}
async function pull() {
  const d = await api("/api/data", {});
  K.meta = d.meta;
  if (d.progress && d.rev >= K.base.rev) K.base = { progress: d.progress, rev: d.rev };
  if (!d.progress) K.base = { progress: K.base.progress, rev: 0 }; // nothing on the server yet: this phone's copy goes up
  lsSet(LS.base, K.base);
  K.queueItems = d.queue || [];
  recompute();
  return d;
}

// ------------------------------------------------------------------ the queue (things for the bot)
async function queue(kind, data) {
  const local = { id: `local-${Date.now()}`, kind, data, local: true };
  K.queueItems.push(local);
  try {
    const r = await api("/api/do", { kind, data });
    K.queueItems = K.queueItems.filter((x) => x !== local).concat(r.item);
  } catch (e) {
    if (e.status && e.status < 500) { K.queueItems = K.queueItems.filter((x) => x !== local); toast(e.message); render(); return false; }
    K.qout.push({ kind, data });
    lsSet(LS.qout, K.qout);
    toast("Offline: it goes to KnowledgeBot when you're back online.");
  }
  render();
  return true;
}
async function flushQueue() {
  const left = [];
  for (const it of K.qout) {
    try { const r = await api("/api/do", it); K.queueItems.push(r.item); } catch (e) { if (!e.status || e.status >= 500) left.push(it); }
  }
  K.qout = left;
  lsSet(LS.qout, left);
}
function pendingNote(path) {
  let out = null;
  for (const it of [...K.queueItems, ...K.qout]) {
    if (!it.data || it.data.path !== path) continue;
    out = out || {};
    if (it.kind === "note_status") out.status = it.data.status;
    if (it.kind === "note_edit") out.text = it.data.text;
    if (it.kind === "note_delete") out.deleted = true;
  }
  return out;
}

// ------------------------------------------------------------------ bundles
async function loadBundle(name) {
  const cached = await idbGet(name);
  const want = K.meta && K.meta[name] && K.meta[name].v;
  if (cached && (!want || cached.v === want)) return cached.data;
  if (!want) return cached ? cached.data : null;
  const res = await api("/api/blob", { name });
  const data = await gunzipJson(res);
  await idbPut(name, { v: want, data });
  return data;
}
async function loadAll() {
  const [learn, vault] = await Promise.allSettled([loadBundle("learn"), loadBundle("vault")]);
  if (learn.status === "fulfilled" && learn.value) setContent(learn.value);
  if (vault.status === "fulfilled" && vault.value) { K.vault = V.buildIndex(vault.value); K.vaultError = null; }
  else if (vault.status === "rejected") K.vaultError = "The vault couldn't load. Pull to refresh, or try again in a minute.";
  else K.vaultError = "The vault isn't uploaded yet: KnowledgeBot does it on its next run.";
}

function setContent(c) {
  K.content = c;
  K.ix = L.indexContent(c);
  if (c.tz) L.setTimeZone(c.tz);
}
const hasTracks = () => Boolean(K.content && (K.content.tracks || []).length);

// ------------------------------------------------------------------ the app context for the other modules
Object.assign(K, {
  render: () => render(),
  queue,
  card: (id) => (K.ix && K.ix.cards[id]) || null,
  resolveNote: (t) => Boolean(K.vault && V.get(K.vault, t)),
  pendingNote,
  inDeck: (k) => Boolean(K.progress.deck[k]),
  toggleDeck: (k) => { addEvents([{ type: K.progress.deck[k] ? "deck_remove" : "deck_add", note: k, at: Date.now() }]); toast(K.progress.deck[k] ? "Added to your review deck." : "Removed from your deck."); },
  deckDue: () => Object.entries(K.progress.deck || {}).filter(([k, c]) => (c.due || 0) <= Date.now() && K.vault && K.vault.byKey.get(k)).map(([k]) => k),
  playDeck: () => {
    const notes = K.deckDue().slice(0, 15).map((k) => K.vault.byKey.get(k));
    deck({ notes, ctx: K, onDone: (graded) => { if (graded.length) addEvents(graded.map((g) => ({ type: "deck", note: g.note, g: g.g, at: Date.now() })).concat([{ type: "xp", xp: graded.length * 2, at: Date.now() }])); }, after: render });
  },
});

// ------------------------------------------------------------------ the owl
function owlMood() {
  const p = K.progress;
  const today = sgDay();
  const xp = p.xp[today] || 0;
  const goal = L.DAILY_GOAL_XP;
  if (xp >= goal) return 95;
  const late = sgMins() > 20 * 60;
  const broken = p.streak.best > 0 && !(p.streak.last === today || p.streak.last === L.addDays(today, -1));
  if (late && !xp && p.streak.count > 2) return 35;
  return Math.round(70 + 22 * Math.min(1, xp / goal) - (broken ? 12 : 0));
}
function owlLine(mood) {
  if (!hasTracks()) return pendingTopics().length ? "Hoo! Your first lessons are on their way." : "Hoo! What shall we learn first?";
  const p = K.progress;
  const xp = p.xp[sgDay()] || 0;
  if (xp >= L.DAILY_GOAL_XP) return `Hoo-ray! Today's goal is done${p.streak.count > 1 ? ` and your streak is ${p.streak.count} days` : ""}.`;
  if (mood < 40) return `Your ${p.streak.count}-day streak ends at midnight! One lesson keeps it.`;
  if (!xp) return p.streak.count ? `Day ${p.streak.count + 1} awaits. Ten minutes?` : "Ready for today's ten minutes?";
  return `${L.DAILY_GOAL_XP - xp} XP to today's goal. Keep going!`;
}

// ------------------------------------------------------------------ the session
function trackName(t) { return ((K.content && K.content.tracks.find((x) => x.id === t)) || { short: t }).short; }
function trackColor(t) { return ((K.content && K.content.tracks.find((x) => x.id === t)) || {}).color || "var(--node)"; }

function finishLesson(lessonId, exercises, result) {
  const l = K.ix.lessons[lessonId];
  const now = Date.now();
  const firstToday = !(K.progress.xp[sgDay()] > 0);
  const xp = L.lessonXp(result.right, firstToday, result.perfect);
  const cards = new Set(exercises.map((x) => x.card).filter(Boolean));
  const evs = [...cards].filter((c) => K.ix.cards[c]).map((c) => ({ type: "review", card: c, track: l.track, g: result.cards[c] === false ? 1 : 3, at: now }));
  evs.push({ type: "lesson", track: l.track, lesson: lessonId, xp, right: result.right, total: result.total, secs: result.secs, perfect: result.perfect, best_run: result.best_run, legendary: Boolean(result.legendary), at: now + 1 });
  const before = K.progress.streak.count;
  addEvents(evs);
  const after = K.progress.streak.count;
  return { xp, line: after > before ? `Streak: ${after} day${after === 1 ? "" : "s"}! 🔥` : null };
}

function playLesson(lessonId, opts = {}) {
  const exercises = L.lessonExercises(K.ix, lessonId, K.progress, opts);
  const l = K.ix.lessons[lessonId];
  play({ ctx: K, track: l.track, exercises, onDone: (r) => finishLesson(lessonId, exercises, { ...r, legendary: opts.legendary }), after: opts.after || render });
}

function playReviews(ids, after) {
  const exercises = L.reviewExercises(K.ix, ids);
  play({ ctx: K, exercises, endTitle: "Reviews done!", onDone: (r) => {
    const now = Date.now();
    const evs = ids.map((c) => ({ type: "review", card: c, track: K.ix.cards[c].track, g: r.cards[c] === false ? 1 : 3, at: now }));
    const xp = r.right + 5;
    evs.push({ type: "xp", xp, best_run: r.best_run, at: now + 1 });
    addEvents(evs);
    return { xp };
  }, after: after || render });
}

function startSession() {
  const s = L.buildSession(K.ix, K.progress, Date.now());
  const steps = [];
  if (s.reviews.length) steps.push((next) => playReviews(s.reviews, next));
  for (const id of s.lessons) steps.push((next) => playLesson(id, { after: next }));
  if (!steps.length) { toast("Nothing due: try a lesson from a path below."); return; }
  const run = (i) => (i < steps.length ? steps[i](() => run(i + 1)) : render());
  run(0);
}

function startPlacement(t) {
  const pl = K.ix.placement && K.ix.placement[t];
  if (!pl) return;
  placement({ pl, ctx: K, name: (K.content.tracks.find((x) => x.id === t) || {}).name || t, onDone: (s) => {
    addEvents([{ type: "placed", track: t, band: s.band, start: s.start || null, at: Date.now() }]);
    if (!s.start) {
      queue("curriculum", { track: t, band: s.band, label: s.label || null });
      return { line: "Lessons at this level are being written. KnowledgeBot adds them, sourced and checked, usually within a day." };
    }
    K.track = t;
    lsSet(LS.track, t);
    return { line: `Your path for ${trackName(t)} now starts here.` };
  }, after: render });
}

// ------------------------------------------------------------------ views
function topStats() {
  const p = K.progress;
  const today = sgDay();
  const done = p.streak.last === today;
  const box = $("topstats");
  box.replaceChildren(...[
    h("span", { class: `stat-chip flame${done ? "" : " cold"}`, title: "Streak" }, icon("flame"), String(p.streak.count || 0)),
    h("span", { class: "stat-chip", title: "XP today" }, icon("bolt"), String(p.xp[today] || 0)),
    p.streak.freezes ? h("span", { class: "stat-chip gem", title: "Streak freezes" }, icon("snow"), String(p.streak.freezes)) : null].filter(Boolean));
  box.hidden = false;
  $("title").textContent = when(Date.now(), { weekday: "short", day: "numeric", month: "short" }) + ` · ${L.league(p, today).tier} league`;
}

function owlCard() {
  const mood = owlMood();
  const pet = drawPet("owl", { mood, level: Math.min(5, 1 + Math.floor((K.progress.streak.best || 0) / 7)), size: 116 });
  liven(pet);
  const line = owlLine(mood);
  const bubble = h("p", { class: "bubble" }, line);
  const xp = K.progress.xp[sgDay()] || 0;
  const pct = Math.min(100, Math.round((100 * xp) / L.DAILY_GOAL_XP));
  return h("section", { class: "sec owl-card" },
    h("button", { class: "pet-tap", type: "button", "aria-label": "Pat Blue", onclick: () => { const l = poke(pet, "owl"); haptic("soft"); if (l) { bubble.textContent = l; setTimeout(() => { bubble.textContent = line; }, 2400); } } }, pet),
    h("div", null, h("p", { class: "caps" }, "Blue"), bubble,
      h("div", { class: "goal" }, h("div", { class: "lbl" }, h("span", null, "Daily goal"), h("span", null, `${xp} / ${L.DAILY_GOAL_XP} XP`)),
        h("div", { class: `bar${pct >= 100 ? " good" : ""}`, role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, h("span", { style: `width:${pct}%` })))));
}

function sessionCard() {
  const s = L.buildSession(K.ix, K.progress, Date.now());
  const parts = [];
  if (s.reviews.length) parts.push(`${s.reviews.length} review${s.reviews.length === 1 ? "" : "s"}`);
  if (s.lessons.length) parts.push(s.lessons.map((id) => trackName(K.ix.lessons[id].track)).join(", "));
  const done = (K.progress.xp[sgDay()] || 0) >= L.DAILY_GOAL_XP;
  return h("section", { class: "sec session" },
    h("header", null, h("div", null, h("h2", null, done ? "Goal done. Keep going?" : "Today's session"), h("p", { class: "sub" }, `${K.progress.settings.daily_min || 10} minutes, mixed`))),
    parts.length ? h("p", { class: "what" }, parts.join(" · ")) : h("p", { class: "what" }, "Nothing new to start: take a placement test below, or pick a lesson from a path."),
    h("button", { class: "btn big", type: "button", disabled: !parts.length, onclick: startSession }, done ? "Practice more" : "Start"),
    s.needPlacement.length ? h("div", { style: "display:grid;gap:8px" }, h("p", { class: "caps" }, "Find your level"),
      h("div", { class: "row" }, s.needPlacement.map((t) => h("button", { class: "pill", type: "button", onclick: () => startPlacement(t) }, icon("play", "icon s"), trackName(t))))) : null);
}

function questCard() {
  const p = K.progress;
  const items = p.quests.day === sgDay() ? p.quests.items : L.questsFor(p, sgDay());
  return h("section", { class: "sec" }, h("header", null, h("h2", null, "Daily quests"), h("span", { class: "tiny" }, "+10 XP each")),
    h("div", { class: "quests" }, items.map((q) => h("div", { class: `quest${q.done ? " done" : ""}` }, icon(q.done ? "check" : "star"), h("span", null, q.text), h("span", { class: "tiny" }, `${Math.min(q.have, q.n)}/${q.n}`),
      h("div", { class: `bar${q.done ? " good" : ""}` }, h("span", { style: `width:${Math.min(100, Math.round((100 * q.have) / q.n))}%` }))))));
}

function pathCard() {
  const tracks = (K.content && K.content.tracks) || [];
  if (!tracks.find((t) => t.id === K.track)) K.track = tracks[0] && tracks[0].id;
  const t = K.track;
  const color = trackColor(t);
  const chips = h("div", { class: "tracks" }, tracks.map((x) => {
    const lessons = Object.values(K.progress.lessons).length;
    const st = K.progress.tracks[x.id];
    return h("button", { class: "trk", type: "button", "aria-pressed": String(x.id === t), style: `--trk:${x.color}`, onclick: () => { K.track = x.id; lsSet(LS.track, x.id); render(); } },
      h("b", null, x.short), h("span", null, st && st.placed ? `level ${st.band + 1}` : "not placed"));
  }));
  const all = L.path(K.ix, K.progress, t);
  // a track can run side strands next to its main path (Your words, a reading or grammar path)
  const strands = [...new Set(all.map((u) => u.unit.strand || "main"))];
  K.strand = K.strand || {};
  const sk = strands.includes(K.strand[t]) ? K.strand[t] : "main";
  const units = all.filter((u) => (u.unit.strand || "main") === sk);
  const strandRow = strands.length > 1 ? h("div", { class: "chips strands", role: "group", "aria-label": "Lesson strands" }, strands.map((x) => {
    const open = all.some((u) => (u.unit.strand || "main") === x && u.lessons.some((l) => l.state === "next"));
    return h("button", { class: "pill", type: "button", "aria-pressed": String(x === sk), onclick: () => { K.strand[t] = x; render(); } },
      strandInfo(all, x).label, open && x !== sk ? h("span", { class: "dot", "aria-label": "a lesson is open" }) : null);
  })) : null;
  const pathEl = h("div", { style: `display:grid;gap:14px;--trk:${color}` });
  const tr = tracks.find((x) => x.id === t) || {};
  if (!units.length) pathEl.append(h("p", { class: "empty" }, "Lessons for this topic are being written."));
  const zig = [0, 46, 70, 46, 0, -46, -70, -46];
  let n = 0;
  for (const u of units) {
    const allSkipped = u.lessons.every((l) => l.state === "skipped");
    pathEl.append(h("div", { class: "unit-band", style: `--trk:${color}` }, h("span", { class: "caps" }, `${u.unit.level}${allSkipped ? " · placed past this" : ""}`), h("h3", null, u.unit.title), h("p", null, u.unit.goal)));
    const col = h("div", { class: "path" });
    for (const l of u.lessons) {
      const off = zig[n++ % zig.length];
      const cls = `node ${l.state}${l.legendary ? " legend" : ""}`;
      const ic = l.checkpoint ? "trophy" : l.state === "locked" ? "lock" : l.state === "done" || l.state === "skipped" ? "check" : "star";
      const node = h("button", { class: cls, type: "button", "aria-label": `${l.title}: ${l.state}`, onclick: () => nodeTap(l) }, icon(ic), l.level ? h("span", { class: "lvl" }, String(l.level)) : null);
      col.append(h("div", { class: "node-wrap", style: `transform:translateX(${off}px)` },
        l.state === "next" ? h("span", { class: "start-tip" }, "START") : null, node, h("span", { class: "node-label" }, l.title)));
    }
    pathEl.append(col);
  }
  const st = K.progress.tracks[t];
  return h("section", { class: "sec" }, h("header", null, h("div", null, h("h2", null, tr.name || t), h("p", { class: "sub" }, tr.about || ""))), chips, strandRow,
    strandRow && sk !== "main" ? h("p", { class: "tiny" }, strandInfo(all, sk).about) : null,
    st && st.placed ? null : (K.ix.placement && K.ix.placement[t] ? h("button", { class: "btn quiet", type: "button", onclick: () => startPlacement(t) }, `Find your level in ${tr.short || t}`) : null),
    tr.graded ? h("p", { class: "tiny" }, "These lessons come from AI agents, not a doctor. They teach how things work, never what to take or do: anything about medication or a diagnosed condition, ask your doctor first.") : null,
    pathEl,
    h("button", { class: "btn quiet", type: "button", onclick: () => topicSheet() }, icon("plus", "icon s"), "Learn something new"));
}

function nodeTap(l) {
  if (l.state === "locked") { toast("Finish the lessons before this one first."); return; }
  if (l.state === "next") { playLesson(l.id); return; }
  openSheet(h("h2", { id: "sheet-title" }, l.title), h("p", { class: "note" }, `Level ${l.level || 0} of 5${l.legendary ? " · legendary" : ""}`),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => { closeSheet(); playLesson(l.id); } }, "Practise again"),
      l.level >= 2 && !l.checkpoint ? h("button", { class: "btn quiet", type: "button", onclick: () => { closeSheet(); playLesson(l.id, { legendary: true }); } }, "Legendary") : null),
    h("p", { class: "tiny" }, "Legendary: type the answers, no choices."));
}

// ------------------------------------------------------------------ a new topic (the first run starts here)
const LEVELS = ["New to it", "Know a little", "Fairly good"];
// Topics asked for and not here yet: still in the queue, or sent from this phone in the last 3 days
// while no new track has arrived since (the bot takes the item off the queue before it has written
// the lessons).
function pendingTopics() {
  const n = (K.content && (K.content.tracks || []).length) || 0;
  const mine = lsGet(LS.topics, []).filter((x) => x.n >= n && Date.now() - x.at < 3 * 864e5).map((x) => x.text);
  const queued = [...K.queueItems, ...K.qout].filter((it) => it.kind === "topic" && it.data).map((it) => it.data.text);
  return [...new Set([...queued, ...mine])];
}
function topicForm(onSent) {
  const ta = h("textarea", { class: "field", placeholder: "A language (Spanish, Japanese…), a subject (astronomy, wine, the Roman Empire…), a skill. Say why if you like: “Italian for a trip in May”." });
  let level = null;
  const chips = h("div", { class: "row", role: "group", "aria-label": "Your level" }, LEVELS.map((x) => h("button", { class: "pill", type: "button", "aria-pressed": "false", onclick: (e) => {
    level = level === x ? null : x;
    chips.querySelectorAll(".pill").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === level)));
    e.currentTarget.blur();
  } }, x)));
  const send = h("button", { class: "btn big", type: "button", onclick: async () => {
    const text = ta.value.trim();
    if (!text) { toast("Say what you'd like to learn."); return; }
    if (!(await queue("topic", { text, level }))) return;
    const n = (K.content && (K.content.tracks || []).length) || 0;
    lsSet(LS.topics, [...lsGet(LS.topics, []).filter((x) => Date.now() - x.at < 3 * 864e5), { text, at: Date.now(), n }]);
    toast("Sent. KnowledgeBot writes your first lessons, sourced and checked, and tells you in Telegram.");
    if (onSent) onSent();
  } }, "Start learning");
  return h("div", { class: "topic-form", style: "display:grid;gap:12px" }, ta, h("p", { class: "caps" }, "Your level (optional)"), chips, send,
    h("p", { class: "tiny" }, "Every fact in your lessons cites a source, and nothing goes live until it passes the checks. You can also just tell KnowledgeBot in Telegram."));
}
function topicSheet() {
  openSheet(h("h2", { id: "sheet-title" }, "Learn something new"), topicForm(() => closeSheet()));
}
function welcomeCard() {
  const waiting = pendingTopics();
  return h("section", { class: "sec welcome" },
    h("header", null, h("div", null, h("h2", null, waiting.length ? "Your lessons are being written" : "What do you want to learn?"),
      h("p", { class: "sub" }, waiting.length ? "KnowledgeBot is writing and checking them. It tells you in Telegram when they're here, usually on its next run." : "Pick anything. KnowledgeBot writes a course for you: ten minutes a day, every fact sourced."))),
    waiting.length ? h("div", { class: "list" }, waiting.map((t) => h("div", { class: "item" }, h("div", null, h("div", { class: "t" }, t), h("div", { class: "m" }, "waiting for KnowledgeBot"))))) : null,
    waiting.length ? h("button", { class: "btn quiet", type: "button", onclick: () => topicSheet() }, icon("plus", "icon s"), "Add another topic") : topicForm(() => render()));
}

function learnView(v) {
  if (!hasTracks()) { v.append(owlCard(), welcomeCard()); return; }
  v.append(owlCard(), sessionCard(), questCard(), pathCard());
}

function meView(v) {
  const p = K.progress;
  const today = sgDay();
  const lg = L.league(p, today);
  const total = Object.values(p.xp).reduce((a, b) => a + b, 0);
  v.append(h("section", { class: "sec" }, h("h2", null, "Your progress"),
    h("div", { class: "statgrid" },
      h("div", { class: "stat" }, h("span", { class: "caps" }, "Streak"), h("b", null, `${p.streak.count || 0} day${p.streak.count === 1 ? "" : "s"}`), h("span", { class: "tiny" }, `best ${p.streak.best || 0}`)),
      h("div", { class: "stat" }, h("span", { class: "caps" }, "Total XP"), h("b", null, fmt(total)), h("span", { class: "tiny" }, `${lg.tier} league`)),
      h("div", { class: "stat" }, h("span", { class: "caps" }, "Cards learned"), h("b", null, fmt(Object.keys(p.cards).length)), h("span", { class: "tiny" }, `${Object.keys(p.lessons).length} lesson${Object.keys(p.lessons).length === 1 ? "" : "s"}`)),
      h("div", { class: "stat" }, h("span", { class: "caps" }, "Your notes deck"), h("b", null, fmt(Object.keys(p.deck).length)), h("span", { class: "tiny" }, `${K.deckDue().length} due`)))));
  const max = Math.max(1, lg.now, ...lg.past);
  v.append(h("section", { class: "sec" }, h("header", null, h("div", null, h("h2", null, `${lg.tier} league`), h("p", { class: "sub" }, `This week ${lg.now} XP: your #${lg.rank} week of the last ${lg.of}`))),
    h("div", { class: "weeks", role: "img", "aria-label": "XP per week, the last nine weeks" }, [...lg.past].reverse().map((x) => h("span", { style: `height:${Math.round((100 * x) / max)}%` })).concat(h("span", { class: "now", style: `height:${Math.round((100 * lg.now) / max)}%` }))),
    h("p", { class: "tiny" }, "No strangers here: you race your own past weeks. Total XP lifts your league.")));
  v.append(h("section", { class: "sec" }, h("h2", null, "Badges"), h("div", { class: "badges" }, L.BADGES.map((b) => h("div", { class: `badge${p.badges[b.id] ? " got" : ""}` },
    h("span", { class: "medal" }, icon(p.badges[b.id] ? "star" : "lock")), h("b", null, b.name), h("span", null, p.badges[b.id] ? short(p.badges[b.id]) : b.text))))));
  // settings
  const set = (patch) => { addEvents([{ type: "settings", settings: patch, at: Date.now() }]); render(); };
  const stepper = (val, lo, hi, step, on) => h("span", { class: "stepper" }, h("button", { type: "button", "aria-label": "Less", onclick: () => on(Math.max(lo, val - step)) }, "−"), h("b", null, String(val)), h("button", { type: "button", "aria-label": "More", onclick: () => on(Math.min(hi, val + step)) }, "+"));
  const tracks = (K.content && K.content.tracks) || [];
  v.append(h("section", { class: "sec" }, h("h2", null, "Settings"),
    h("div", { class: "setrow" }, h("span", null, "Minutes a day"), stepper(p.settings.daily_min || 10, 5, 60, 5, (x) => set({ daily_min: x }))),
    h("div", { class: "setrow" }, h("span", null, "Reminder (if you haven't studied)"), h("input", { class: "field", type: "time", value: p.settings.remind || "20:00", style: "width:auto", onchange: (e) => set({ remind: e.target.value }) })),
    h("p", { class: "caps" }, "Topics: weight in the daily mix"),
    tracks.map((t) => {
      const w = (p.settings.weights || {})[t.id] ?? 1;
      const paused = (p.settings.paused || []).includes(t.id);
      return h("div", { class: "setrow" }, h("span", null, t.short, paused ? h("span", { class: "tiny" }, " · paused") : null),
        h("span", { class: "row" }, stepper(w, 0, 3, 1, (x) => set({ weights: { ...p.settings.weights, [t.id]: x } })),
          h("button", { class: "textbtn", type: "button", onclick: () => set({ paused: paused ? p.settings.paused.filter((x) => x !== t.id) : [...(p.settings.paused || []), t.id] }) }, paused ? "Resume" : "Pause"),
          K.ix && K.ix.placement && K.ix.placement[t.id] ? h("button", { class: "textbtn", type: "button", onclick: () => startPlacement(t.id) }, "Re-place") : null));
    }),
    h("button", { class: "btn quiet", type: "button", onclick: () => topicSheet() }, icon("plus", "icon s"), "Learn something new"),
    h("p", { class: "tiny" }, "You can also tell KnowledgeBot in Telegram: “teach me the basics of astronomy”, “pause Spanish for a month”, “make it 15 minutes”."),
    tracks.some((t) => t.lang === "ja") ? [
      h("div", { class: "setrow" }, h("span", null, "Furigana over kanji"), h("span", { class: "row" }, ["on", "off"].map((m) => h("button", { class: "pill", type: "button", "aria-pressed": String(lsGet(FURI_KEY, "on") === m), onclick: () => { lsSet(FURI_KEY, m); render(); } }, m)))),
      h("p", { class: "tiny" }, "Off: tap any Japanese text to peek at the reading. Reading drills never show furigana.")] : null,
    h("div", { class: "setrow" }, h("span", null, "Sound effects"), h("span", { class: "row" }, ["on", "off"].map((m) => h("button", { class: "pill", type: "button", "aria-pressed": String(lsGet(SOUND_KEY, "on") === m), onclick: () => { lsSet(SOUND_KEY, m); if (m === "on") sfx("right"); render(); } }, m)))),
    h("div", { class: "setrow" }, h("span", null, "Look"), h("span", { class: "row" }, ["auto", "light", "dark"].map((m) => h("button", { class: "pill", type: "button", "aria-pressed": String((lsGet(LS.theme, "auto")) === m), onclick: () => { lsSet(LS.theme, m); applyTheme(); render(); } }, m))))));
  v.append(h("section", { class: "sec" }, h("h2", null, "About"),
    h("p", { class: "note" }, "Every lesson cites its sources: dictionaries, papers, guidelines and reference works. Tap “Report a problem” on anything wrong and KnowledgeBot fixes it."),
    h("p", { class: "tiny" }, K.meta ? `Lessons ${K.meta.learn ? K.meta.learn.v : "–"} · Vault ${K.meta.vault ? `${K.meta.vault.v} (${K.meta.vault.notes} notes)` : "–"}` : "Offline"),
    K.outbox.length ? h("p", { class: "tiny" }, `${K.outbox.length} change(s) waiting to sync`) : null));
}

function applyTheme() {
  const m = lsGet(LS.theme, "auto");
  if (m === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", m);
}

function render() {
  const v = $("view");
  const y = window.scrollY;
  v.replaceChildren();
  for (const b of document.querySelectorAll("#tabs [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === K.tab));
  topStats();
  if (K.tab === "learn") learnView(v);
  else if (K.tab === "library") libraryView(v, K);
  else meView(v);
  if (K.tab === K._lastTab) window.scrollTo(0, y);
  K._lastTab = K.tab;
}

async function boot() {
  applyTheme();
  document.querySelector(".logo").replaceChildren(icon("owl"));
  try { tg && tg.ready(); tg && tg.expand(); } catch { /* outside Telegram */ }
  if (!tg || !tg.initData) {
    $("status").textContent = "Open this from the KnowledgeBot's App button in Telegram.";
    return;
  }
  recompute();
  $("tabs").hidden = false;
  for (const b of document.querySelectorAll("#tabs [role=tab]")) b.addEventListener("click", () => { K.tab = b.dataset.tab; if (K.tab === "library") { K.lib.note = null; K.lib.mode = null; } render(); window.scrollTo(0, 0); });
  $("sheet-x").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  $("refresh").addEventListener("click", async () => { await sync(); toast("Up to date."); });
  // the cached copy first, so the app opens instantly (and offline)
  const [learn, vault] = await Promise.all([idbGet("learn"), idbGet("vault")]);
  if (learn) setContent(learn.data);
  if (vault) K.vault = V.buildIndex(vault.data);
  render();
  await sync();
  $("foot").hidden = false;
}

async function sync() {
  try {
    await pull();
    await flushQueue();
    if (lsGet(LS.day, null) !== sgDay()) { lsSet(LS.day, sgDay()); addEvents([{ type: "day", at: Date.now() }]); }
    await loadAll();
    await saveProgress();
    K.online = true;
    $("asof").textContent = `Synced ${when(Date.now(), { hour: "numeric", minute: "2-digit" })}`;
  } catch (e) {
    K.online = false;
    if (e.status === 401 || e.status === 403) { $("view").replaceChildren(h("p", { class: "status" }, e.message)); return; }
    toast("Offline: showing what's on this phone.");
  }
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
document.addEventListener("visibilitychange", () => { if (document.hidden) saveProgress(); });
unlockAudio();
boot();
