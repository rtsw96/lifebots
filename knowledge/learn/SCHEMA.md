# Learning content: format and sourcing rules

Everything the Knowledge app teaches lives here as JSON, one folder per track (a subject the
user chose: a language, a science, history, cooking, anything). The app builds exercises from
**cards** (Duolingo-style drills for language cards) and plays the **questions** written into
concept and pattern cards (Brilliant-style). `validate.py` checks every file against this page
and, for Japanese and Chinese, against the dictionaries; nothing ships that fails it.

The repo ships with **no tracks**. The user tells the KnowledgeBot what they want to learn, and
the bot writes the first track from this page (see **Starting a track** below).

## Sourcing (non-negotiable)

- **Nothing from memory alone.** Every fact a card teaches has a source the reader could check:
  - **Japanese words:** JMdict. `validate.py` checks the word and reading.
  - **Chinese words and characters:** CC-CEDICT, plus Make Me a Hanzi and Jun Da's frequency list for characters. `validate.py` checks them.
  - **Other languages:** a named dictionary with a URL (a national academy's dictionary, a major learner's dictionary, Wiktionary as a last resort), given in the card's `source`. No automatic check exists, so look every word up before writing it.
  - **Grammar and usage:** a named reference grammar or textbook, or a reputable teaching site, with a URL.
  - **Science, technology, health:** the paper, the guideline, the official documentation or datasheet, or a textbook, with a URL. Prefer primary sources and systematic reviews.
  - **History, arts, culture, beliefs:** primary sources or reputable reference works by name and section. Where people disagree (historians, schools of thought, traditions), say whose view it is and that others differ.
- **Say how sure it is.** A track with `"graded": true` (health, medicine, nutrition, any field where evidence quality varies) puts `evidence` on every concept card: `strong` means meta-analyses or RCTs agree; `moderate` means good observational studies or a few RCTs; `weak` means small studies, mechanisms or animal data; `mixed` means the studies disagree.
- **Numbers carry their date and source.** For example: "about 8 billion people (UN World Population Prospects, 2022)".
- **No made-up examples presented as real.** Example sentences may be written for the lesson, but must be natural and correct. Mark them `"source": {"note": "written for this lesson"}` and keep them short.
- **When unsure, leave it out.**

### Health and medicine

Lessons on health, medicine, drugs or nutrition come from AI agents, not a doctor, and the app says
so on those tracks. They teach how things work, **never what to take, stop or change**: no doses,
no advice to start or stop a medicine or supplement, no diagnosis. Anything about a medication or a
diagnosed condition goes to the user's own doctor first. Lessons never use the user's personal
health details.

## Starting a track

When the user asks to learn something new (in Telegram, or from the app's "What do you want to
learn?" box, which arrives as a `TOPIC:` line from `app_sync.py apply`):

1. **Pin down the goal in one or two questions at most** (their level, what they want to be able to do). If the request is already clear, skip this.
2. **Add the track** to `tracks.json`: a short `id` (2–12 lower-case letters), `name`, `short`, `lang`, `color`, `about`, and `plain` / `graded` where they fit.
3. **Write the first unit** (`<id>/units/01-<slug>.json`, 3–6 lessons) following this page, starting where the user is. For a subject with clear levels they may already be past, also write a `placement.json`; its higher bands may have `"start": null` (written when someone places there).
4. **Run `python3 knowledge/learn/validate.py <id>`** until it prints 0 errors. Tracks in Japanese or Chinese download JMdict or CC-CEDICT on first use (a minute; needs the internet).
5. **Have it checked:** a second, independent pass (a subagent acting as a native speaker or a domain expert) checks every card against its source and fixes or removes anything doubtful. Validate again.
6. Only then commit and push to the app. Content that fails validation is never published.

Keep headroom: when the user is within one unit of the end of a track, write the next unit the
same way.

## Files

```
learn/
  tracks.json                    the tracks, in order (empty on a fresh install)
  <track>/placement.json         the placement test (optional)
  <track>/units/NN-slug.json     units, in order of NN
```

`tracks.json`:
```json
{"tracks": [{"id": "spanish", "name": "Everyday Spanish", "short": "Spanish", "lang": "es", "color": "#e5484d",
             "about": "one line on the goal"}]}
```
- `lang`: the language the cards teach (`es`, `ja`, `zh`, ...), or `en` for a subject taught in English. It also picks the phone voice for listening drills.
- `plain: true`: written for a layperson (see **Plain-language tracks**).
- `graded: true`: concept cards carry an `evidence` grade.

## A unit

```json
{
  "id": "spanish-01",                  // <track>-NN (or NNN), matches the filename
  "title": "Greetings and introductions",
  "level": "Beginner",                 // the track's own scale: CEFR A1..C2, JLPT N5..N1, HSK 1..6, or Foundations / Intermediate / Advanced
  "goal": "Greet people and say who you are.",
  "lessons": [
    {"id": "spanish-01-1", "title": "Hello and goodbye", "cards": ["es-w-hola", "es-w-adios"], "intro": "optional short markdown shown before the drills"}
  ],
  "cards": [ /* card objects, ids unique across the whole track */ ],
  "sources": [ {"title": "...", "url": "..."} ]   // unit-level references (optional)
}
```

**Strands.** A unit may set `"strand"`: `main` (default), `mine` (Your words: words the user met and
sent to the bot, `knowledge/bot/words.py`) or any short lower-case name for a side path (`reading`,
`grammar`, `parts`, ...). A side path may set `"strand_label"` (the pill's text) and
`"strand_about"` (one line shown under it) on its first unit. Each strand opens one lesson at a
time on its own, alongside the main path, and the placement start applies to `main` only. The daily
session takes the next lesson from whichever strand has the fewest lessons done.

A lesson takes about 2 minutes: 4–8 cards. A unit has 3–6 lessons. The last lesson of a unit may
be `"checkpoint": true` (a test over the whole unit, no new cards: `"cards": []`).

## Plain-language tracks

A track with `"plain": true` in `tracks.json` is written for a smart layperson with no technical
background. Use it for science, medicine, technology and anything with jargon. On every card:
- **It stands alone.** Define every term the first time it appears on the card, even if an earlier card did ("a
  token, a chunk of a word, …"). Assume nothing from papers, outside reading or lessons not yet done.
- **No undefined jargon, no formulas.** Everyday words and analogies first; arithmetic is multiply and divide with
  round numbers.
- **Studies in plain words.** Say what a study found and who did it ("in 2022, researchers at a university hospital
  found…"), never "Smith et al." as if the reader knew the paper. Paper titles and links go in `sources` only.
- **Questions test the card.** Every fact and number a question needs is in its prompt or the card's explain.
- `explain` stays within 120 words.

`validate.py` rejects "et al." in a plain track's card text and explains over 120 words. In the app, every question
on a concept or pattern card has a **Recap the idea** button that shows the card again.

## Cards

Every card has `id` (unique in the track, e.g. `es-w-hola`), `kind`, and the fields below.
Optional on any card: `note` (a short usage note shown after answering).

### kana (Japanese)
`{"id", "kind": "kana", "char": "ア", "romaji": "a", "script": "katakana"}`

Drills: character to romaji, romaji to character, sound to character, matching pairs. `validate.py`
checks the romaji against its Hepburn table.

### word (vocabulary, any language)
```json
{"id": "es-w-reunion", "kind": "word", "lang": "es", "text": "reunión", "reading": "reunión",
 "meaning": ["meeting"], "pos": "noun",
 "example": {"text": "La reunión es a las tres.", "meaning": "The meeting is at three.",
             "source": {"note": "written for this lesson"}},
 "source": {"title": "Diccionario de la lengua española (RAE)", "url": "https://dle.rae.es/reunión"}}
```
- **`reading`** is how the word is read: kana for Japanese, pinyin for Chinese, a standard romanisation for other non-Latin scripts. For a language written in the Latin alphabet, repeat the text (the app then skips the reading drill).
- **Japanese:** `reading` is in hiragana; for katakana words, the katakana itself. `source`: `{"dict": "JMdict"}`.
- **Chinese:** `text` is simplified, `trad` is traditional (when different), and `reading` is pinyin with tone marks in citation tones, as the dictionary gives them (`huìyì`; 不 is `bù`, 一 is `yī`, with no sandhi). Write `ü` as `ü`. `source`: `{"dict": "CC-CEDICT"}`.

Drills: meaning, reverse, reading, listening, matching, and a gap in the example.

### char (Chinese character recognition)
```json
{"id": "zh-c-清", "kind": "char", "lang": "zh", "text": "清", "reading": "qīng", "meaning": ["clear", "pure"],
 "rank": 335, "formation": "phono-semantic",
 "parts": [{"part": "氵", "role": "meaning", "name": "water"}, {"part": "青", "role": "sound", "reading": "qīng"}],
 "words": [{"text": "清楚", "reading": "qīngchu", "meaning": "clear; to understand"}, {"text": "清单", "reading": "qīngdān", "meaning": "list"}],
 "family": ["请", "情", "晴", "精"], "note": "optional", "trad": "optional traditional form",
 "source": [{"dict": "CC-CEDICT"}, {"title": "Make Me a Hanzi", "url": "https://github.com/skishore/makemeahanzi"},
            {"title": "Jun Da, Modern Chinese character frequency list", "url": "https://lingua.mtsu.edu/chinese-computing/statistics/char/list.php?Which=MO"}]}
```
- **Start from the data:** `python3 knowledge/learn/hanzi.py band <lo> <hi>` prints each character's rank, pinyin, definition, decomposition, formation and meaning/sound parts. Write the card from that, never from memory.
- **Checks** (`validate.py`):
  - one character, pinyin in CC-CEDICT;
  - `rank` as in Jun Da's modern list;
  - `formation` (`pictograph`, `indicative`, `ideograph`, `phono-semantic`, `other`) agrees with Make Me a Hanzi;
  - each part is in the character's decomposition, and for phono-semantic characters the meaning and sound parts are Make Me a Hanzi's;
  - 1–3 `words` that contain the character, each in CC-CEDICT with its pinyin.
- **Words:** choose common, useful ones, not rare compounds.
- **`family`:** other common characters sharing the sound part (`hanzi.py family 青`).
- **Drills:** meaning and pinyin with the character alone (no pinyin shown until answered), one of its words, and "which part hints at the meaning?" for phono-semantic characters.

### sentence (a phrase to build or recognise)
```json
{"id": "es-s-mucho-gusto", "kind": "sentence", "lang": "es", "text": "Mucho gusto, me llamo Ana.",
 "reading": "Mucho gusto, me llamo Ana.", "meaning": "Nice to meet you, my name is Ana.",
 "tiles": ["Mucho gusto, ", "me ", "llamo ", "Ana."], "register": "neutral",
 "source": {"title": "...", "url": "..."}}
```
`tiles` joined must equal `text` (keep the spaces inside the tiles). Drills: build it from tiles,
translate (choose), listen and build. `register`: `casual`, `neutral`, `polite` or `formal`
(`keigo` for Japanese honorifics).

**Furigana.** The app puts furigana over the kanji of every Japanese `text` that has a `reading`
(word, sentence, examples), lining the reading up with the kana in the text. So give Japanese
examples a full `reading` too. The user can turn furigana off (a tap then peeks).

### read (reading practice, Japanese: no furigana)
```json
{"id": "ja-r-eakon", "kind": "read", "lang": "ja", "text": "エアコン", "meaning": "air conditioner",
 "script": "katakana", "romaji": "eakon", "source": {"dict": "JMdict"}}
{"id": "ja-r-s-atsui", "kind": "read", "lang": "ja", "text": "きょうも あついですね。", "meaning": "It's hot again today, isn't it?",
 "script": "hiragana", "source": {"note": "written for this lesson"}}
```
- Kana only, never kanji. Sentences put a space between phrases (分かち書き, as in children's books): a particle stays with the word before it and です/ます with their word (あした タクシーで ホテルに いきます。), and there is no space after 。 inside a passage. Every sentence needs at least one space: the app tells words from sentences by it when picking wrong options.
- `script: "katakana"`: one katakana word that JMdict has, with `romaji` as `validate.py`'s `kana_romaji()` gives it (ー repeats the vowel: コーヒー → koohii).
- Drills: read it, then choose the meaning (and, for katakana words, the sound); the audio plays only after answering.

### pattern (grammar, set phrases, politeness levels)
```json
{"id": "es-p-me-gustaria", "kind": "pattern", "lang": "es", "pattern": "Me gustaría + infinitive",
 "meaning": "I would like to ...", "explain": "markdown, ≤ 120 words",
 "examples": [{"text": "...", "reading": "...", "meaning": "..."}],
 "questions": [ /* question objects, at least 2 */ ],
 "sources": [{"title": "...", "url": "..."}]}
```

### concept (any subject; Brilliant-style)
```json
{"id": "astro-c-seasons", "kind": "concept", "title": "Seasons come from Earth's tilt, not its distance from the Sun",
 "explain": "markdown, ≤ 120 words. Open with a question or a puzzle, then the idea, then one number or example.",
 "questions": [ /* question objects, 2–4, each one testing understanding, not recall of a phrase */ ],
 "sources": [{"title": "NASA Space Place: What causes the seasons?", "url": "https://spaceplace.nasa.gov/seasons/"}],
 "evidence": "strong"}              // required on a graded track; optional elsewhere
```

## Questions

Every question has `type`, `prompt` and `explain`: one or two sentences shown after answering that
say *why*, not just what. Types:

| type | fields | notes |
|---|---|---|
| `mcq` | `options` (2–5), `answer` (index) | plausible wrong options; no "all of the above" |
| `multi` | `options`, `answer` (list of indexes) | "choose all that apply" |
| `tf` | `answer` (true/false) | |
| `cloze` | `answer` (list of accepted strings), `options` (optional: shown as choices) | the prompt has one `___` |
| `numeric` | `answer` (number), `tolerance` (relative, e.g. 0.1), `unit` | estimation; the app shows it as multiple choice, so `explain` shows the working |
| `order` | `items` (in the correct order) | the app shuffles them |
| `match` | `pairs` (list of [left, right]) | 3–6 pairs |
| `free` | `rubric`, `sample` | written answer; the bot gives feedback in Telegram |

## The placement test (optional)

```json
{"track": "spanish", "intro": "one line",
 "bands": [{"band": 0, "label": "A1: first words", "start": "spanish-01"},
           {"band": 1, "label": "A2: everyday situations", "start": null}],
 "items": [{"band": 0, "q": { /* question object */ }, "source": {"title": "...", "url": "..."}}]}
```
- **Bands:** 4–6, from beginner to near-native or expert. Each band has 3–4 items.
- **How it runs:** the app works up from band 0. A band is passed with 2 or more right, and it stops at the first band failed. The user starts at that band's `start` unit.
- **Missing units:** if `start` is null, the app asks the bot for that band's units (a `CURRICULUM:` line) and the bot writes them next.
- **Items:** use only `mcq`, `tf`, `cloze` (with `options`), `numeric` and `match`, so the app can mark them instantly.
- Without a `placement.json`, the track starts at its first unit.
