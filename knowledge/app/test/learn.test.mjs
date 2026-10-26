// Learning engine tests: node --test knowledge/app/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import * as L from "../public/learn.js";

const DAY = 86400e3;
L.setTimeZone("Asia/Tokyo"); // as settings.json would give it; days below are counted there
const T0 = Date.parse("2026-10-14T01:00:00Z"); // 10:00 in Tokyo, a Wednesday

test("days are counted in the user's timezone, from the bundle", () => {
  const late = Date.parse("2026-10-14T20:00:00Z");
  assert.equal(L.localDay(late), "2026-10-15"); // 05:00 the next morning in Tokyo
  L.setTimeZone("America/New_York");
  assert.equal(L.localDay(late), "2026-10-14");
  L.setTimeZone("Not/AZone"); // unknown names are ignored
  assert.equal(L.timeZone(), "America/New_York");
  L.setTimeZone("Asia/Tokyo");
});

test("a fresh install has no tracks: nothing to play, nothing to place", () => {
  const ix = L.indexContent({ tracks: [], units: {}, placement: {} });
  const s = L.buildSession(ix, L.emptyProgress(), T0);
  assert.deepEqual([s.reviews, s.lessons, s.needPlacement], [[], [], []]);
  assert.deepEqual(L.emptyProgress().settings.weights, {});
  assert.equal(L.langName("es"), "Spanish");
});

test("FSRS: a good first answer comes back in days, a miss in 10 minutes, and intervals grow", () => {
  const c1 = L.review(undefined, 3, T0);
  assert.equal(Math.round(c1.s * 100) / 100, 3.17);
  assert.equal(c1.due - T0, 3 * DAY);
  const miss = L.review(undefined, 1, T0);
  assert.equal(miss.due - T0, 10 * 60e3);
  const c2 = L.review(c1, 3, c1.due);
  assert.ok(c2.s > c1.s * 2, `stability should grow (${c1.s} -> ${c2.s})`);
  const lapse = L.review(c2, 1, c2.due);
  assert.ok(lapse.s < c2.s && lapse.lapses === 1);
  assert.ok(c2.d >= 1 && c2.d <= 10);
  assert.equal(L.intervalDays(10), 10); // at 90% retention the interval equals stability
});

test("streaks: a lesson a day extends it, a freeze covers one missed day, two missed days reset it", () => {
  let p = L.emptyProgress();
  const lesson = (at) => ({ type: "lesson", at, track: "ja", lesson: "ja-01-1", xp: 20, right: 8, total: 8, perfect: true });
  for (let i = 0; i < 7; i++) p = L.applyEvent(p, lesson(T0 + i * DAY));
  assert.equal(p.streak.count, 7);
  assert.equal(p.streak.freezes, 1); // earned on day 7
  p = L.applyEvent(p, lesson(T0 + 8 * DAY)); // day 8 missed: the freeze covers it
  assert.equal(p.streak.count, 8);
  assert.equal(p.streak.freezes, 0);
  p = L.applyEvent(p, lesson(T0 + 11 * DAY)); // two days missed, no freeze
  assert.equal(p.streak.count, 1);
  assert.equal(p.streak.best, 8);
  assert.ok(p.badges.first && p.badges.streak7);
});

test("quests are the same all day, fill up and pay 10 XP once", () => {
  let p = L.emptyProgress();
  const day = L.localDay(T0);
  const q = L.questsFor(p, day);
  assert.equal(q.length, 3);
  assert.deepEqual(L.questsFor(p, day).map((x) => x.id), q.map((x) => x.id));
  for (let i = 0; i < 4; i++) p = L.applyEvent(p, { type: "lesson", at: T0 + i * 60e3, track: ["ja", "ai", "zh", "health"][i], lesson: `x-${i}`, xp: 25, right: 10, total: 10, perfect: true, best_run: 10 });
  const done = p.quests.items.filter((x) => x.done).length;
  assert.ok(done >= 2, `most of today's quests should be done (${JSON.stringify(p.quests.items)})`);
  assert.equal(p.xp[day], 4 * 25 + 10 * done);
});

test("the league ranks this week against the last 8", () => {
  const p = L.emptyProgress();
  const wk = L.weekStart(L.localDay(T0));
  p.xp[L.addDays(wk, -7)] = 500; p.xp[L.addDays(wk, -14)] = 100; p.xp[wk] = 300;
  const lg = L.league(p, L.localDay(T0));
  assert.equal(lg.rank, 2);
  assert.equal(lg.now, 300);
  assert.ok(L.LEAGUES.includes(lg.tier));
});

const content = {
  tracks: [{ id: "ja" }, { id: "ai" }],
  units: {
    ja: [{ id: "ja-01", title: "K", cards: ["a", "i", "u", "e", "o"].map((r, n) => ({ id: `ja-k-${r}`, kind: "kana", char: "アイウエオ"[n], romaji: r })),
      lessons: [{ id: "ja-01-1", title: "ア行", cards: ["ja-k-a", "ja-k-i", "ja-k-u", "ja-k-e", "ja-k-o"] }, { id: "ja-01-2", title: "Checkpoint", checkpoint: true, cards: [] }] }],
    ai: [{ id: "ai-01", title: "T", cards: [{ id: "ai-c-1", kind: "concept", title: "Attention", explain: "x", questions: [{ type: "tf", prompt: "p", answer: true, explain: "e" }, { type: "numeric", prompt: "n", answer: 100, tolerance: 0.1, explain: "e" }] }],
      lessons: [{ id: "ai-01-1", title: "One", cards: ["ai-c-1"] }] },
      { id: "ai-02", title: "U", cards: [], lessons: [{ id: "ai-02-1", title: "Two", cards: [] }] }],
  },
  placement: { ja: { bands: [{ band: 0, start: "ja-01" }, { band: 1, start: null }], items: [
    { band: 0, q: { type: "tf" } }, { band: 0, q: { type: "tf" } }, { band: 0, q: { type: "tf" } },
    { band: 1, q: { type: "tf" } }, { band: 1, q: { type: "tf" } }, { band: 1, q: { type: "tf" } }] } },
};

test("the path opens one lesson at a time and respects the placement start", () => {
  const ix = L.indexContent(content);
  let p = L.emptyProgress();
  const ai = L.path(ix, p, "ai");
  assert.deepEqual(ai.flatMap((u) => u.lessons.map((l) => l.state)), ["next", "locked"]);
  p = L.applyEvent(p, { type: "placed", at: T0, track: "ai", band: 3, start: "ai-02" });
  assert.deepEqual(L.path(ix, p, "ai").flatMap((u) => u.lessons.map((l) => l.state)), ["skipped", "next"]);
  assert.equal(L.nextLesson(ix, p, "ai").id, "ai-02-1");
});

test("the daily session: due reviews first, then a lesson per track, least recently studied first", () => {
  const ix = L.indexContent(content);
  let p = L.emptyProgress();
  p = L.applyEvent(p, { type: "review", at: T0 - 5 * DAY, card: "ja-k-a", g: 3, track: "ja" });
  p.studied.ja = T0 - DAY; // studied yesterday, AI never
  const s = L.buildSession(ix, p, T0);
  assert.deepEqual(s.reviews, ["ja-k-a"]);
  assert.deepEqual(s.lessons, ["ai-01-1", "ja-01-1"]);
  assert.deepEqual(s.needPlacement, ["ja"]);
});

test("drills: new cards are taught first; kana drills use other kana as wrong options; concepts play their questions", () => {
  const ix = L.indexContent(content);
  L.setRandom(() => 0.3);
  const ex = L.lessonExercises(ix, "ja-01-1", L.emptyProgress());
  assert.equal(ex[0].type, "teach");
  const m = ex.find((x) => x.type === "mcq");
  assert.equal(m.options[m.answer], "a");
  assert.ok(m.options.every((o) => ["a", "i", "u", "e", "o"].includes(o)));
  assert.equal(ex[ex.length - 1].type, "match");
  const ai = L.lessonExercises(ix, "ai-01-1", L.emptyProgress());
  assert.deepEqual(ai.map((x) => x.type), ["teach", "tf", "mcq"]); // the number question as choices
  assert.equal(L.lessonExercises(ix, "ja-01-2", L.emptyProgress()).length, 5); // checkpoint: one drill per card
  ix.lessons["ja-01-1"].intro = "Katakana spells loanwords.";
  assert.equal(L.lessonExercises(ix, "ja-01-1", L.emptyProgress())[0].card.kind, "intro"); // the lesson's intro comes first
});

test("authored options are shuffled with the answer kept on the same text", () => {
  L.setRandom(() => 0.99);
  const q = { type: "mcq", prompt: "p", options: ["right", "w1", "w2", "w3"], answer: 0, explain: "e" };
  const s = L.shuffleOptions(q);
  assert.equal(s.options[s.answer], "right");
  const m = L.shuffleOptions({ type: "multi", prompt: "p", options: ["a", "b", "c"], answer: [0, 2], explain: "e" });
  assert.deepEqual(m.answer.map((i) => m.options[i]).sort(), ["a", "c"]);
  assert.equal(L.shuffleOptions({ type: "tf", answer: true }).answer, true);
});

test("marking: tolerance, typed answers folded, tones caught as close", () => {
  assert.ok(L.mark({ type: "numeric", answer: 100, tolerance: 0.1 }, "108").ok);
  assert.ok(!L.mark({ type: "numeric", answer: 100, tolerance: 0.1 }, "120").ok);
  assert.ok(L.mark({ type: "type", accept: ["会議", "かいぎ"] }, " かいぎ。").ok);
  assert.deepEqual(L.mark({ type: "type", accept: ["huìyì"] }, "huiyi"), { ok: false, close: "tones" });
  assert.ok(L.mark({ type: "build", answer: ["いつも", "お世話に"] }, ["いつも", "お世話に"]).ok);
  assert.ok(L.mark({ type: "order", items: ["a", "b", "c"] }, ["a", "b", "c"]).ok);
  assert.ok(L.mark({ type: "multi", answer: [2, 0] }, [0, 2]).ok);
});

test("placement: passes a band with 2 right, stops at the first band failed", () => {
  const pl = content.placement.ja;
  let s = L.placementState(pl, []);
  assert.equal(s.done, false);
  assert.equal(s.band, 0);
  const a = [{ band: 0, i: 0, ok: true }, { band: 0, i: 1, ok: true }];
  s = L.placementState(pl, a);
  assert.equal(s.band, 1);
  s = L.placementState(pl, [...a, { band: 1, i: 3, ok: false }, { band: 1, i: 4, ok: false }]);
  assert.deepEqual([s.done, s.band, s.start], [true, 1, null]);
  s = L.placementState(pl, [{ band: 0, i: 0, ok: false }, { band: 0, i: 1, ok: false }]);
  assert.deepEqual([s.done, s.start], [true, "ja-01"]);
});

test("events replay: the same events on the same start give the same progress", () => {
  const evs = [{ type: "review", at: T0, card: "ja-k-a", g: 3 }, { type: "lesson", at: T0 + 1000, track: "ja", lesson: "ja-01-1", xp: 15, right: 5, total: 6 }];
  const a = evs.reduce(L.applyEvent, L.emptyProgress());
  const b = evs.reduce(L.applyEvent, L.emptyProgress());
  assert.deepEqual(a, b);
  assert.equal(a.lessons["ja-01-1"].best, 83);
});

test("number questions become multiple choice: the answer plus three clearly off, percentages kept in 0–100", () => {
  L.setRandom(() => 0.42);
  for (const q of [{ type: "numeric", answer: 1.3, tolerance: 0.15 }, { type: "numeric", answer: 131072, unit: "bytes", tolerance: 0.03 },
    { type: "numeric", answer: 11.9, unit: "%", tolerance: 0.15 }, { type: "numeric", answer: 4, unit: "×", tolerance: 0.01 }]) {
    const m = L.numericChoice({ prompt: "p", explain: "the working", ...q });
    assert.equal(m.type, "mcq");
    assert.equal(m.options.length, 4);
    assert.equal(new Set(m.options).size, 4);
    assert.equal(m.explain, "the working");
    const val = (o) => Number(o.replace(/[^\d.]/g, ""));
    assert.equal(val(m.options[m.answer]), q.answer);
    for (const [i, o] of m.options.entries()) if (i !== m.answer) assert.ok(Math.abs(val(o) - q.answer) > q.answer * q.tolerance, `${o} is too close to ${q.answer}`);
    if (q.unit === "%") assert.ok(m.options.every((o) => o.endsWith("%") && val(o) <= 100));
    assert.ok(L.mark(m, m.answer).ok);
  }
  assert.equal(L.numericChoice({ type: "mcq", options: ["a"], answer: 0 }).options[0], "a"); // other types untouched
  const ex = L.exercisesFor({ id: "c", kind: "concept", questions: [{ type: "numeric", prompt: "p", answer: 300, unit: "tokens/s", tolerance: 0.04 }] }, [], "learn");
  assert.equal(ex[1].type, "mcq"); // in a lesson, after the teach card
  assert.ok(ex[1].numeric);
});

test("strands: grammar and reading open alongside the main path; the next lesson keeps the strands level", () => {
  const c = {
    tracks: [{ id: "ja" }],
    units: { ja: [
      { id: "ja-01", title: "K", cards: [], lessons: [{ id: "ja-01-1", title: "a", cards: [] }, { id: "ja-01-2", title: "b", cards: [] }] },
      { id: "ja-02", title: "B", cards: [], lessons: [{ id: "ja-02-1", title: "c", cards: [] }] },
      { id: "ja-07", title: "Fix", strand: "grammar", cards: [], lessons: [{ id: "ja-07-1", title: "x", cards: [] }, { id: "ja-07-2", title: "y", cards: [] }] },
      { id: "ja-12", title: "Read", strand: "reading", cards: [], lessons: [{ id: "ja-12-1", title: "r", cards: [] }] },
    ] },
  };
  const ix = L.indexContent(c);
  let p = L.emptyProgress();
  const states = () => Object.fromEntries(L.path(ix, p, "ja").flatMap((u) => u.lessons.map((l) => [l.id, l.state])));
  assert.deepEqual(states(), { "ja-01-1": "next", "ja-01-2": "locked", "ja-02-1": "locked", "ja-07-1": "next", "ja-07-2": "locked", "ja-12-1": "next" });
  assert.equal(L.nextLesson(ix, p, "ja").id, "ja-01-1"); // a tie goes to the main path
  p = L.applyEvent(p, { type: "lesson", at: T0, track: "ja", lesson: "ja-01-1", xp: 10, right: 5, total: 5 });
  assert.notEqual(L.nextLesson(ix, p, "ja").strand, "main"); // now a side strand's turn
  p = L.applyEvent(p, { type: "placed", at: T0, track: "ja", band: 1, start: "ja-02" });
  assert.equal(states()["ja-01-2"], "skipped"); // placement skips main units only
  assert.equal(states()["ja-07-1"], "next");
});

test("furigana lines readings up with the kanji; kana anchor the match", () => {
  assert.deepEqual(L.furigana("会議", "かいぎ"), [{ t: "会議", r: "かいぎ" }]);
  assert.deepEqual(L.furigana("新しいエアコン", "あたらしいえあこん"), [{ t: "新", r: "あたら" }, { t: "しいエアコン" }]);
  assert.deepEqual(L.furigana("出張した時", "しゅっちょうしたとき"), [{ t: "出張", r: "しゅっちょう" }, { t: "した" }, { t: "時", r: "とき" }]);
  assert.deepEqual(L.furigana("ひらがな", "ひらがな"), [{ t: "ひらがな" }]);
  assert.deepEqual(L.furigana("今日", "きょう"), [{ t: "今日", r: "きょう" }]);
  assert.deepEqual(L.furigana("食べる", "のむ"), [{ t: "食べる", r: "のむ" }]); // no fit: the whole reading over the whole text
});

test("reading cards: kana only, no furigana, no audio until answered; katakana also asks how it sounds", () => {
  L.setRandom(() => 0.3);
  const pool = ["エアコン:eakon:air conditioner", "マスク:masuku:mask", "パソコン:pasokon:PC", "ホテル:hoteru:hotel"].map((x, i) => {
    const [text, romaji, meaning] = x.split(":");
    return { id: `r${i}`, kind: "read", lang: "ja", text, romaji, meaning, script: "katakana", unit: "u" };
  });
  const ex = L.exercisesFor(pool[0], pool, "learn");
  assert.deepEqual(ex.map((e) => e.type), ["mcq", "mcq"]);
  assert.ok(ex.every((e) => e.noFuri && e.readDrill && e.show === "エアコン" && e.sayAfter === "エアコン" && !e.say && !e.listen));
  assert.equal(ex[1].options[ex[1].answer], "eakon");
  const sents = ["きょうは あついです。:It's hot today.", "あしたは あめです。:It will rain tomorrow.", "でんしゃが おそいです。:The train is late.", "ごはんを たべます。:I eat a meal."].map((x, i) => {
    const [text, meaning] = x.split(":");
    return { id: `s${i}`, kind: "read", lang: "ja", text, meaning, script: "hiragana", unit: "u" };
  });
  const s = L.exercisesFor(sents[0], [...pool, ...sents], "learn");
  assert.equal(s.length, 1); // no sound drill for sentences
  assert.ok(s[0].options.every((o) => o.includes(" ")), `sentence choices only (${s[0].options})`); // never "PC" next to a sentence
});

test("character cards: meaning and pinyin with the character alone, a word it builds, the meaning part", () => {
  const ch = (text, reading, meaning, parts, words) => ({ id: `zh-c-${text}`, kind: "char", lang: "zh", text, reading, meaning: [meaning], unit: "zh-109",
    formation: "phono-semantic", parts, words });
  const pool = [
    ch("清", "qīng", "clear", [{ part: "氵", role: "meaning", name: "water" }, { part: "青", role: "sound" }], [{ text: "清楚", reading: "qīngchu", meaning: "clear" }]),
    ch("情", "qíng", "feeling", [{ part: "忄", role: "meaning", name: "heart" }, { part: "青", role: "sound" }], [{ text: "感情", reading: "gǎnqíng", meaning: "emotion" }]),
    ch("请", "qǐng", "to ask", [{ part: "讠", role: "meaning", name: "speech" }, { part: "青", role: "sound" }], [{ text: "邀请", reading: "yāoqǐng", meaning: "to invite" }]),
    ch("妈", "mā", "mother", [{ part: "女", role: "meaning", name: "woman" }, { part: "马", role: "sound" }], [{ text: "妈妈", reading: "māma", meaning: "mum" }]),
    ch("跑", "pǎo", "to run", [{ part: "足", role: "meaning", name: "foot" }, { part: "包", role: "sound" }], [{ text: "跑步", reading: "pǎobù", meaning: "to jog" }]),
  ];
  L.setRandom(() => 0.1);
  const ex = L.exercisesFor(pool[0], pool, "new");
  assert.equal(ex[0].type, "teach");
  const [m, r, w] = ex.slice(1);
  assert.equal(m.show, "清");
  assert.equal(m.read, undefined, "no pinyin before answering");
  assert.equal(m.options[m.answer], "clear");
  assert.equal(r.options[r.answer], "qīng");
  assert.equal(w.show, "清楚");
  assert.equal(w.options[w.answer], "clear");
  // review gives one drill; the parts drill points at the meaning part
  const all = Array.from({ length: 40 }, (_, i) => { L.setRandom(() => i / 40); return L.exercisesFor(pool[0], pool, "review")[0]; });
  const partsQ = all.find((x) => /hints at the meaning/.test(x.prompt));
  assert.ok(partsQ && partsQ.options[partsQ.answer] === "氵" && partsQ.options.includes("青"));
  assert.ok(L.matchFor(pool).pairs.some(([a, b]) => a === "清" && b === "clear"));
  L.setRandom(Math.random);
});
