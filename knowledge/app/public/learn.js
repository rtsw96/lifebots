// Learning engine for the Knowledge app: pure functions, no DOM, tested in Node.
//
//   FSRS-5 spaced repetition (default parameters) for every card.
//   Progress is a plain object changed only by applyEvent(progress, event), so the phone can
//   keep a list of events made offline and replay them on top of the server copy.
//   buildSession(): the daily mixed session (reviews due + new lessons across the tracks).
//   exercisesFor(): Duolingo-style drills generated from a card, or the card's own
//   Brilliant-style questions.
//   placement: works up the bands of a track until one is failed.
//   Gamification: XP, daily goal, streak and freezes, daily quests, a league against your own
//   past weeks, badges, levels per lesson.

// ------------------------------------------------------------------ FSRS-5
// Weights: the published FSRS-5 defaults (open-spaced-repetition/fsrs4anki).
export const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81; // so that retrievability is 90% when t = S
export const RETENTION = 0.9;
const DAY_MS = 86400e3;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const retrievability = (elapsedDays, s) => Math.pow(1 + (FACTOR * elapsedDays) / s, DECAY);
const d0 = (g) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
export function intervalDays(s, r = RETENTION) {
  return Math.max(1, Math.round((s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)));
}

/** One review. card = {s, d, due, last, reps, lapses} or undefined (new); g: 1 again, 2 hard, 3 good, 4 easy. */
export function review(card, g, now) {
  const c = card && card.s ? { ...card } : { s: 0, d: 0, reps: 0, lapses: 0 };
  if (!c.s) {
    c.s = W[g - 1];
    c.d = d0(g);
  } else {
    const elapsed = Math.max(0, (now - (c.last || now)) / DAY_MS);
    if (elapsed < 1) {
      // same-day review (FSRS-5 short-term formula)
      c.s = c.s * Math.exp(W[17] * (g - 3 + W[18]));
    } else {
      const r = retrievability(elapsed, c.s);
      if (g === 1) {
        c.s = Math.min(c.s, W[11] * Math.pow(c.d, -W[12]) * (Math.pow(c.s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
        c.lapses += 1;
      } else {
        const hard = g === 2 ? W[15] : 1;
        const easy = g === 4 ? W[16] : 1;
        c.s = c.s * (1 + Math.exp(W[8]) * (11 - c.d) * Math.pow(c.s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
      }
    }
    const delta = -W[6] * (g - 3);
    const dNew = c.d + (delta * (10 - c.d)) / 9;
    c.d = clamp(W[7] * d0(4) + (1 - W[7]) * dNew, 1, 10);
  }
  c.s = Math.max(0.1, c.s);
  c.reps += 1;
  c.last = now;
  // A miss comes back in 10 minutes; anything else at the interval that keeps recall at 90%.
  c.due = g === 1 ? now + 10 * 60e3 : now + intervalDays(c.s) * DAY_MS;
  return c;
}

// ------------------------------------------------------------------ dates (the user's timezone)
// Days (streaks, XP, quests) are counted in the timezone from the repo's settings.json, which the
// bot puts in the learning bundle (setTimeZone). Until it arrives: the phone's own timezone.
let TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
let dayFmt = null;
export function setTimeZone(tz) {
  if (!tz || tz === TZ) return;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); } catch { return; } // unknown name: keep the current one
  TZ = tz;
  dayFmt = null;
}
export const timeZone = () => TZ;
/** The calendar day (YYYY-MM-DD) of a moment, in the user's timezone. */
export function localDay(ms) {
  dayFmt = dayFmt || new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return dayFmt.format(new Date(ms));
}
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export function weekStart(iso) {
  const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

// ------------------------------------------------------------------ progress
export const DAILY_GOAL_XP = 60; // about 10 minutes
export function emptyProgress() {
  return {
    v: 1, settings: { daily_min: 10, weights: {}, paused: [], remind: "20:00" },
    tracks: {}, cards: {}, lessons: {}, xp: {}, streak: { count: 0, last: null, freezes: 0, best: 0 },
    quests: { day: null, items: [] }, badges: {}, history: [], deck: {}, studied: {},
  };
}

function trackState(p, t) {
  p.tracks[t] = p.tracks[t] || { placed: false, band: null, start: null };
  return p.tracks[t];
}

/** Every change to progress goes through here. Events carry their own time (`at`, ms). */
export function applyEvent(p0, ev) {
  const p = structuredClone(p0);
  const day = localDay(ev.at);
  if (ev.type === "review") {
    // {card, g, track}: one card graded once (end of a lesson or review block)
    p.cards[ev.card] = review(p.cards[ev.card], ev.g, ev.at);
    if (ev.track) p.cards[ev.card].t = ev.track;
  } else if (ev.type === "deck") {
    // a vault note reviewed from the Library deck: {note, g}
    p.deck[ev.note] = review(p.deck[ev.note], ev.g, ev.at);
  } else if (ev.type === "deck_add") {
    if (!p.deck[ev.note]) p.deck[ev.note] = { s: 0, due: ev.at, added: ev.at };
  } else if (ev.type === "deck_remove") {
    delete p.deck[ev.note];
  } else if (ev.type === "lesson") {
    // {track, lesson, xp, right, total, secs, perfect, legendary}
    const l = p.lessons[ev.lesson] || { level: 0, best: 0, first: day };
    l.level = Math.min(5, l.level + 1);
    if (ev.legendary) l.legendary = true;
    l.best = Math.max(l.best, ev.total ? Math.round((100 * ev.right) / ev.total) : 0);
    l.last = day;
    p.lessons[ev.lesson] = l;
    p.studied[ev.track] = ev.at;
    gainXp(p, day, ev.xp || 0);
    bumpStreak(p, day);
    p.history.unshift({ day, track: ev.track, lesson: ev.lesson, xp: ev.xp, right: ev.right, total: ev.total, secs: ev.secs });
    p.history = p.history.slice(0, 300);
    questProgress(p, day, ev);
  } else if (ev.type === "xp") {
    gainXp(p, day, ev.xp || 0);
    bumpStreak(p, day);
    questProgress(p, day, ev);
  } else if (ev.type === "placed") {
    // {track, band, start}: start null when the band's units aren't written yet
    Object.assign(trackState(p, ev.track), { placed: true, band: ev.band, start: ev.start, at: day });
  } else if (ev.type === "settings") {
    p.settings = { ...p.settings, ...ev.settings };
  } else if (ev.type === "day") {
    rollDay(p, day);
  }
  checkBadges(p, day);
  return p;
}

function gainXp(p, day, xp) {
  p.xp[day] = (p.xp[day] || 0) + xp;
  const keep = addDays(day, -400);
  for (const d of Object.keys(p.xp)) if (d < keep) delete p.xp[d];
}

/** Opening the app on a new day: use a freeze for a missed day, or reset the streak. */
export function rollDay(p, today) {
  const s = p.streak;
  if (!s.last || s.last >= addDays(today, -1)) return;
  const missed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${s.last}T00:00:00Z`)) / DAY_MS) - 1;
  if (missed <= s.freezes) {
    s.freezes -= missed;
    s.frozen = (s.frozen || 0) + missed;
    s.last = addDays(today, -1); // the gap is covered
  } else {
    s.count = 0;
  }
}

function bumpStreak(p, day) {
  const s = p.streak;
  if (s.last === day) return;
  rollDay(p, day);
  s.count = s.last === addDays(day, -1) ? s.count + 1 : 1;
  s.last = day;
  s.best = Math.max(s.best || 0, s.count);
  if (s.count % 7 === 0 && s.freezes < 2) s.freezes += 1; // a freeze earned every 7 days, 2 at most
}

// ------------------------------------------------------------------ quests
const QUESTS = [
  { id: "xp", text: (n) => `Earn ${n} XP`, n: [40, 60, 80], measure: (ev) => ev.xp || 0 },
  { id: "lessons", text: (n) => `Finish ${n} lessons`, n: [2, 3, 4], measure: (ev) => (ev.type === "lesson" ? 1 : 0) },
  { id: "perfect", text: () => "Finish a lesson with no mistakes", n: [1], measure: (ev) => (ev.type === "lesson" && ev.perfect ? 1 : 0) },
  { id: "tracks", text: (n) => `Study ${n} different topics`, n: [2, 3], measure: () => 0 },
  { id: "streak", text: (n) => `Get ${n} right in a row`, n: [8, 12, 15], measure: (ev) => ev.best_run || 0, max: true },
];
function seedOf(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function questsFor(p, day) {
  if (p.quests.day === day) return p.quests.items;
  let r = seedOf(day);
  const next = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0);
  const pool = [...QUESTS];
  const items = [];
  while (items.length < 3) {
    const q = pool.splice(next() % pool.length, 1)[0];
    const n = q.n[next() % q.n.length];
    items.push({ id: q.id, n, text: q.text(n), have: 0, done: false });
  }
  return items;
}

function questProgress(p, day, ev) {
  if (p.quests.day !== day) p.quests = { day, items: questsFor(p, day) };
  for (const it of p.quests.items) {
    const q = QUESTS.find((x) => x.id === it.id);
    if (it.id === "tracks") {
      it.have = new Set(p.history.filter((h) => h.day === day).map((h) => h.track)).size;
    } else {
      const m = q.measure(ev);
      it.have = q.max ? Math.max(it.have, m) : it.have + m;
    }
    if (!it.done && it.have >= it.n) {
      it.done = true;
      p.xp[day] = (p.xp[day] || 0) + 10; // a finished quest is worth 10 XP
    }
  }
}

// ------------------------------------------------------------------ league (you against your past weeks)
export const LEAGUES = ["Bronze", "Silver", "Gold", "Sapphire", "Ruby", "Emerald", "Amethyst", "Pearl", "Obsidian", "Diamond"];
export function weekXp(p, wkStart) {
  let n = 0;
  for (let i = 0; i < 7; i++) n += p.xp[addDays(wkStart, i)] || 0;
  return n;
}
/** This week's XP ranked among the last 8 finished weeks. The league rises with your best weeks. */
export function league(p, today) {
  const wk = weekStart(today);
  const past = Array.from({ length: 8 }, (_, i) => weekXp(p, addDays(wk, -7 * (i + 1))));
  const now = weekXp(p, wk);
  const rank = 1 + past.filter((x) => x > now).length;
  const total = Object.values(p.xp).reduce((a, b) => a + b, 0);
  const tier = LEAGUES[Math.min(LEAGUES.length - 1, Math.floor(Math.sqrt(total / 150)))];
  return { tier, rank, of: 9, now, past };
}

// ------------------------------------------------------------------ badges
export const BADGES = [
  { id: "first", name: "First step", text: "Finished a first lesson", test: (p) => Object.keys(p.lessons).length >= 1 },
  { id: "placed", name: "Know thyself", text: "Took a placement test", test: (p) => Object.values(p.tracks || {}).some((t) => t && t.placed) },
  { id: "streak7", name: "One week", text: "A 7-day streak", test: (p) => (p.streak.best || 0) >= 7 },
  { id: "streak30", name: "One month", text: "A 30-day streak", test: (p) => (p.streak.best || 0) >= 30 },
  { id: "streak100", name: "Centurion", text: "A 100-day streak", test: (p) => (p.streak.best || 0) >= 100 },
  { id: "cards100", name: "Hundred", text: "100 cards learned", test: (p) => Object.keys(p.cards).length >= 100 },
  { id: "cards500", name: "Five hundred", text: "500 cards learned", test: (p) => Object.keys(p.cards).length >= 500 },
  { id: "xp1000", name: "Scholar", text: "1,000 XP", test: (p) => Object.values(p.xp).reduce((a, b) => a + b, 0) >= 1000 },
  { id: "lessons50", name: "Fifty", text: "50 lessons done", test: (p) => Object.keys(p.lessons).length >= 50 },
  { id: "deck", name: "Own words", text: "10 of your own notes in your review deck", test: (p) => Object.keys(p.deck).length >= 10 },
  { id: "legend", name: "Legendary", text: "A lesson done at the legendary level", test: (p) => Object.values(p.lessons).some((l) => l.legendary) },
];
function checkBadges(p, day) {
  for (const b of BADGES) if (!p.badges[b.id] && b.test(p)) p.badges[b.id] = day;
}

// ------------------------------------------------------------------ content
/** Index the learning bundle: {tracks, units: {t: [unit]}, placement: {t: {...}}}. */
export function indexContent(c) {
  const cards = {}, lessons = {}, unitOf = {};
  for (const [t, units] of Object.entries(c.units || {})) {
    units.forEach((u, ui) => {
      for (const card of u.cards) cards[card.id] = { ...card, track: t, unit: u.id };
      u.lessons.forEach((l, li) => {
        lessons[l.id] = { ...l, track: t, unit: u.id, ui, li };
        unitOf[l.id] = u;
      });
    });
  }
  return { ...c, cards, lessons, unitOf };
}

const strandOf = (u) => u.strand || "main";

/** The path for a track: every lesson in order, with its state. Units run in strands: "main" (the
 *  placement start applies here; earlier units are skipped) and side strands such as "grammar" or
 *  "reading", each opening one lesson at a time alongside the main one. */
export function path(ix, p, t) {
  const units = ix.units[t] || [];
  const st = p.tracks[t] || {};
  const startUi = st.start ? Math.max(0, units.findIndex((u) => u.id === st.start)) : 0;
  const out = [];
  const open = {};
  units.forEach((u, ui) => {
    const sk = strandOf(u);
    if (open[sk] === undefined) open[sk] = true;
    const ls = u.lessons.map((l) => {
      const rec = p.lessons[l.id];
      const skipped = sk === "main" && ui < startUi;
      const state = rec ? "done" : skipped ? "skipped" : open[sk] ? "next" : "locked";
      if (state === "next") open[sk] = false;
      return { ...l, state, strand: sk, level: rec ? rec.level : 0, legendary: Boolean(rec && rec.legendary) };
    });
    out.push({ unit: u, lessons: ls });
  });
  return out;
}

/** The next lesson to do in a track: the open lesson of the strand with the fewest lessons done,
 *  so side strands (grammar, reading) keep pace with the main path. Ties go to the main path. */
export function nextLesson(ix, p, t) {
  const next = [], done = {};
  for (const u of path(ix, p, t)) for (const l of u.lessons) {
    if (l.state === "next") next.push(l);
    if (l.state === "done") done[l.strand] = (done[l.strand] || 0) + 1;
  }
  next.sort((a, b) => (done[a.strand] || 0) - (done[b.strand] || 0) || (a.strand === "main" ? -1 : b.strand === "main" ? 1 : 0));
  return next[0] || null;
}

// ------------------------------------------------------------------ furigana and kana
const KANJI = /[\u3400-\u9fff\uf900-\ufaff々〆ヶ]/;
export const hasKanji = (s) => KANJI.test(String(s || ""));
export const kataToHira = (s) => String(s).replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Furigana for a Japanese text from its whole reading: [{t, r?}] (r only over kanji). Kana in the
 *  text anchor the match; if the reading doesn't line up, the whole text gets the whole reading. */
export function furigana(text, reading) {
  text = String(text || "");
  if (!reading || !hasKanji(text)) return [{ t: text }];
  const runs = text.match(/[\u3400-\u9fff\uf900-\ufaff々〆ヶ]+|[^\u3400-\u9fff\uf900-\ufaff々〆ヶ]+/g) || [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${runs.map((r) => (KANJI.test(r) ? "(.+?)" : esc(kataToHira(r)))).join("")}$`);
  const m = kataToHira(reading).match(re);
  if (!m) return [{ t: text, r: reading }];
  let g = 1;
  return runs.map((r) => (KANJI.test(r) ? { t: r, r: m[g++] } : { t: r }));
}


// ------------------------------------------------------------------ the daily session
/** About 10 minutes: due reviews first (capped), then a new lesson from the tracks studied least
 *  recently (weighted), rotating so every track gets its turn. */
export function buildSession(ix, p, now, opts = {}) {
  const minutes = p.settings.daily_min || 10;
  const budget = minutes * 60;
  const due = Object.entries(p.cards)
    .filter(([id, c]) => c.due <= now && ix.cards[id] && !p.settings.paused.includes(ix.cards[id].track))
    .sort((a, b) => a[1].due - b[1].due)
    .map(([id]) => id);
  const reviewSecs = Math.min(due.length * 12, budget * 0.4);
  const reviews = due.slice(0, Math.floor(reviewSecs / 12));
  const tracks = (ix.tracks || []).map((t) => t.id).filter((t) => !p.settings.paused.includes(t) && (p.settings.weights[t] ?? 1) > 0);
  // least recently studied first, then by weight
  const order = [...tracks].sort((a, b) => ((p.studied[a] || 0) / (p.settings.weights[a] || 1)) - ((p.studied[b] || 0) / (p.settings.weights[b] || 1)));
  const lessons = [];
  let left = budget - reviewSecs;
  for (const t of order) {
    if (left < 90) break;
    const l = nextLesson(ix, p, t);
    if (!l) continue;
    lessons.push(l.id);
    left -= 120;
  }
  const needPlacement = tracks.filter((t) => !(p.tracks[t] && p.tracks[t].placed) && ix.placement && ix.placement[t]);
  return { reviews, lessons, needPlacement, minutes };
}

// ------------------------------------------------------------------ exercises
let rnd = Math.random;
export function setRandom(fn) { rnd = fn; } // tests
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickN = (xs, n) => shuffle(xs).slice(0, n);
const first = (m) => (Array.isArray(m) ? m[0] : m);
/** "Japanese" for "ja", "Spanish" for "es": the language's English name, or its code. */
export function langName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code || "the language"; }
}

function mcq(prompt, right, wrongs, extra = {}) {
  const opts = shuffle([right, ...pickN([...new Set(wrongs.filter((w) => w && w !== right))], 3)]);
  return { type: "mcq", prompt, options: opts, answer: opts.indexOf(right), ...extra };
}

/** Drills for one card. `pool`: other cards of the same track and kind, for wrong options.
 *  mode "new" adds a teaching card first; "review" gives one drill; "legendary" prefers typing. */
export function exercisesFor(card, pool, mode = "learn") {
  // wrong options from the same unit where there are enough, so they're as hard as the right one
  const all = pool.filter((c) => c.id !== card.id && c.kind === card.kind);
  const near = all.filter((c) => c.unit && c.unit === card.unit);
  const peers = near.length >= 3 ? near : all;
  const out = [];
  if (card.kind === "kana") {
    if (mode === "new") out.push({ type: "teach", card });
    const drills = [
      mcq(`Which sound is ${card.char}?`, card.romaji, peers.map((c) => c.romaji), { say: card.char, show: card.char }),
      mcq(`Which is "${card.romaji}"?`, card.char, peers.map((c) => c.char), { big: true }),
      mcq("Which one do you hear?", card.char, peers.map((c) => c.char), { listen: card.char, big: true }),
    ];
    if (mode === "legendary") drills.push({ type: "type", prompt: `Type the sound of ${card.char} in romaji`, accept: [card.romaji], show: card.char });
    out.push(...(mode === "review" ? [drills[Math.floor(rnd() * drills.length)]] : drills.slice(0, 2)));
  } else if (card.kind === "word") {
    if (mode === "new") out.push({ type: "teach", card });
    const meaning = first(card.meaning);
    const drills = [
      mcq(`What does ${card.text} mean?`, meaning, peers.map((c) => first(c.meaning)), { say: card.text, lang: card.lang, show: card.text, read: card.reading }),
      mcq(`Which is "${meaning}"?`, card.text, peers.map((c) => c.text), { lang: card.lang }),
    ];
    if (card.reading !== card.text) drills.push(mcq(`How do you read ${card.text}?`, card.reading, peers.map((c) => c.reading), { lang: card.lang, show: card.text, noFuri: true }));
    drills.push(mcq("What did you hear?", meaning, peers.map((c) => first(c.meaning)), { listen: card.text, lang: card.lang }));
    if (mode === "legendary") drills.push({ type: "type", prompt: `Type "${meaning}" in ${langName(card.lang)}`, accept: [card.text, card.reading, card.trad].filter(Boolean), lang: card.lang });
    out.push(...(mode === "review" ? [drills[Math.floor(rnd() * drills.length)]] : drills.slice(0, 2)));
  } else if (card.kind === "char") {
    // character recognition: the character alone (no pinyin until it's answered), then its sound,
    // a word it builds, and which part carries the meaning or the sound
    if (mode === "new") out.push({ type: "teach", card });
    const meaning = first(card.meaning);
    const drills = [
      mcq("What does this character mean?", meaning, peers.map((c) => first(c.meaning)), { lang: "zh", show: card.text, sayAfter: card.text, charDrill: true }),
      mcq("How do you read it?", card.reading, peers.map((c) => c.reading), { lang: "zh", show: card.text, sayAfter: card.text, charDrill: true, latin: true }),
    ];
    const w = (card.words || [])[Math.floor(rnd() * (card.words || []).length)];
    if (w) {
      const otherWords = peers.flatMap((c) => c.words || []).filter((x) => x.text !== w.text);
      if (otherWords.length >= 3) drills.push(mcq("What does this word mean?", w.meaning, otherWords.map((x) => x.meaning), { lang: "zh", show: w.text, sayAfter: w.text, charDrill: true, word: w }));
    }
    const sem = (card.parts || []).find((x) => x.role === "meaning");
    const snd = (card.parts || []).find((x) => x.role === "sound");
    const decoys = [...new Set(peers.flatMap((c) => (c.parts || []).map((x) => x.part)))];
    if (sem && snd && decoys.length >= 3) {
      drills.push(mcq(`Which part of ${card.text} hints at the meaning?`, sem.part, [snd.part, ...decoys.filter((x) => x !== sem.part)],
        { lang: "zh", big: true, explain: `${sem.part}${sem.name ? ` (${sem.name})` : ""} carries the meaning; ${snd.part} gives the sound${snd.reading ? `, ${snd.reading}` : ""}.` }));
    }
    out.push(...(mode === "review" ? [drills[Math.floor(rnd() * drills.length)]] : drills.slice(0, 3)));
  } else if (card.kind === "sentence") {
    if (mode === "new") out.push({ type: "teach", card });
    const extra = pickN(peers.flatMap((c) => c.tiles || []).filter((t) => !card.tiles.includes(t)), 2);
    out.push({ type: "build", prompt: `Say: "${card.meaning}"`, tiles: shuffle([...card.tiles, ...extra]), answer: card.tiles, lang: card.lang, say: card.text });
    if (mode !== "review") out.push(mcq("What does this mean?", card.meaning, peers.map((c) => c.meaning), { say: card.text, lang: card.lang, show: card.text, read: card.reading }));
  } else if (card.kind === "read") {
    // reading practice: kana only, no furigana and no audio until it's answered. Wrong options come
    // from the same shape of card (word or sentence, katakana word or not), so length gives nothing away.
    const shape = (c) => `${c.script === "katakana"}:${/\s/.test(c.text.trim())}`;
    const alike = peers.filter((c) => shape(c) === shape(card));
    const pool2 = alike.length >= 3 ? alike : all.filter((c) => shape(c) === shape(card)).length >= 3 ? all.filter((c) => shape(c) === shape(card)) : peers;
    const drills = [mcq("Read it. What does it mean?", card.meaning, pool2.map((c) => c.meaning), { lang: card.lang || "ja", show: card.text, noFuri: true, sayAfter: card.text, readDrill: true })];
    const ro = card.script === "katakana" && card.romaji;
    if (ro) drills.push(mcq("Read it. How does it sound?", card.romaji, pool2.map((c) => c.romaji).filter(Boolean), { lang: card.lang || "ja", show: card.text, noFuri: true, sayAfter: card.text, readDrill: true, latin: true }));
    out.push(...(mode === "review" ? [drills[Math.floor(rnd() * drills.length)]] : drills));
  } else {
    // pattern and concept: teach (explain) then the authored questions, options shuffled
    const qs = (card.questions || []).map((q) => ({ ...shuffleOptions(numericChoice(q)), card: card.id }));
    if (mode !== "review") out.push({ type: "teach", card });
    if (mode === "review") out.push(qs[Math.floor(rnd() * qs.length)]);
    else out.push(...qs);
  }
  return out.map((x) => ({ ...x, card: card.id }));
}

const numText = (x) => {
  const n = Math.abs(x) >= 100 ? Math.round(x) : Number(x.toPrecision(3));
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(n);
};

/** A number question as multiple choice (no mental arithmetic):
 *  the answer plus three choices clearly outside its tolerance. The explanation, shown after,
 *  carries the working. Percentages stay between 0 and 100. */
export function numericChoice(q) {
  if (!q || q.type !== "numeric") return q;
  const a = Number(q.answer);
  const tol = Math.max(q.tolerance || 0.1, 0.05);
  const unit = !q.unit ? "" : q.unit === "%" ? "%" : ` ${q.unit}`;
  const pct = /%|percent/i.test(q.unit || "") && a >= 0 && a <= 100;
  const two = (x) => { if (!x) return 0; const m = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1); return Math.round(x / m) * m; };
  let pool = shuffle([0.25, 0.5, 2, 4, 10, 0.1]).map((f) => two(a * f));
  if (pct) pool = shuffle([a - 30, a - 15, a + 15, a + 30, a / 2, a * 2].map((x) => Math.round(x))).filter((x) => x >= 0 && x <= 100);
  if (!a) pool = [1, 10, 100];
  const far = (x) => Math.abs(x - a) > Math.max(Math.abs(a) * tol * 1.5, 1e-9);
  const picked = [];
  for (const x of pool) {
    if (picked.length === 3) break;
    if (far(x) && !picked.some((y) => numText(y) === numText(x)) && numText(x) !== numText(a)) picked.push(x);
  }
  const opts = shuffle([a, ...picked]);
  return { ...q, type: "mcq", numeric: true, options: opts.map((x) => numText(x) + unit), answer: opts.indexOf(a) };
}

/** Shuffle an authored question's options, keeping the answer pointing at the same text. */
export function shuffleOptions(q) {
  if (!q || !Array.isArray(q.options) || (q.type !== "mcq" && q.type !== "multi")) return q;
  const order = shuffle(q.options.map((_, i) => i));
  const options = order.map((i) => q.options[i]);
  const answer = q.type === "mcq" ? order.indexOf(q.answer) : q.answer.map((a) => order.indexOf(a)).sort((a, b) => a - b);
  return { ...q, options, answer };
}

/** Matching pairs over a lesson's kana or word cards (Duolingo's tap-to-match), 4–5 pairs. */
export function matchFor(cards) {
  const usable = cards.filter((c) => c.kind === "kana" || c.kind === "word" || c.kind === "char").slice(0, 5);
  if (usable.length < 3) return null;
  const lang = (usable.find((c) => c.lang) || {}).lang || (usable[0].kind === "kana" ? "ja" : null);
  return { type: "match", prompt: "Tap the pairs", pairs: usable.map((c) => (c.kind === "kana" ? [c.char, c.romaji] : [c.text, first(c.meaning)])), lang, card: null };
}

/** The exercises for a lesson: new cards taught then drilled, a match round, mistakes come back at the end. */
export function lessonExercises(ix, lessonId, p, opts = {}) {
  const l = ix.lessons[lessonId];
  const unit = ix.unitOf[lessonId];
  const pool = Object.values(ix.cards).filter((c) => c.track === l.track);
  if (l.checkpoint) {
    const cards = unit.cards;
    return pickN(cards, Math.min(12, cards.length)).flatMap((c) => exercisesFor(c, pool, "review"));
  }
  const cards = l.cards.map((id) => ix.cards[id]).filter(Boolean);
  const mode = opts.legendary ? "legendary" : null;
  const seq = [];
  for (const c of cards) seq.push(...exercisesFor(c, pool, mode || (p.cards[c.id] ? "learn" : "new")));
  const m = matchFor(cards);
  if (m) seq.push(m);
  if (l.intro && !opts.legendary) seq.unshift({ type: "teach", card: { kind: "intro", id: `${lessonId}-intro`, title: l.title, explain: l.intro } });
  return seq;
}

export function reviewExercises(ix, ids) {
  return ids.map((id) => {
    const c = ix.cards[id];
    const pool = Object.values(ix.cards).filter((x) => x.track === c.track);
    return exercisesFor(c, pool, "review")[0];
  }).filter(Boolean);
}

// ------------------------------------------------------------------ marking
const fold = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[\s。、.,!?！？'"’「」『』（）()·-]/g, "");
const stripTones = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ü/g, "v");

/** Is this answer right? Returns {ok, close} (close: right but for tone marks or small typos). */
export function mark(ex, answer) {
  switch (ex.type) {
    case "mcq": return { ok: answer === ex.answer };
    case "multi": {
      const a = [...(answer || [])].sort().join(), b = [...ex.answer].sort().join();
      return { ok: a === b };
    }
    case "tf": return { ok: answer === ex.answer };
    case "cloze": case "type": {
      const acc = ex.type === "cloze" ? ex.answer : ex.accept;
      const got = fold(answer || "");
      if (acc.some((a) => fold(a) === got)) return { ok: true };
      if (acc.some((a) => stripTones(fold(a)) === stripTones(got))) return { ok: false, close: "tones" };
      return { ok: false };
    }
    case "numeric": {
      const x = Number(String(answer).replace(/,/g, ""));
      return { ok: Number.isFinite(x) && Math.abs(x - ex.answer) <= Math.abs(ex.answer) * ex.tolerance };
    }
    case "order": return { ok: JSON.stringify(answer) === JSON.stringify(ex.items) };
    case "build": return { ok: (answer || []).join("") === ex.answer.join("") };
    case "match": return { ok: true }; // marked pair by pair in the player
    default: return { ok: true };
  }
}

/** XP for a finished lesson: 2 per first-try right answer, 5 for a perfect lesson, 5 for the first lesson of the day. */
export function lessonXp(right, firstToday, perfect) {
  return right * 2 + (perfect ? 5 : 0) + (firstToday ? 5 : 0);
}

// ------------------------------------------------------------------ placement
/** Walk up the bands: 3 items per band (a 4th if it's 1–1 after 2… then 2 of 3 passes). */
export function placementState(pl, answers) {
  // answers: [{band, ok}] in order asked
  const bands = [...pl.bands].sort((a, b) => a.band - b.band);
  for (const b of bands) {
    const got = answers.filter((a) => a.band === b.band);
    const right = got.filter((a) => a.ok).length, wrong = got.length - right;
    if (right >= 2) continue; // passed: go up
    if (wrong >= 2) return { done: true, band: b.band, start: b.start, label: b.label };
    const asked = new Set(got.map((a) => a.i));
    const next = pl.items.map((it, i) => ({ ...it, i })).find((it) => it.band === b.band && !asked.has(it.i));
    if (!next) return { done: true, band: b.band, start: b.start, label: b.label };
    return { done: false, item: next, band: b.band, label: b.label };
  }
  const top = bands[bands.length - 1];
  return { done: true, band: top.band, start: top.start, label: top.label, top: true };
}
