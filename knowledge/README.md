# Knowledge

A second brain and a tutor. The KnowledgeBot answers anything you ask with sources, keeps the
takeaways you choose in a personal vault, and teaches you whatever you decide to learn in a daily
10-minute session in its Telegram app.

It ships with **no lessons and an empty vault**. You tell the bot what you'd like to learn (a
language, a science, history, cooking, a skill) and it writes the course: every fact sourced,
checked by a second reviewer and by `learn/validate.py` before it reaches the app.

No Anthropic API key is involved. A Claude Code session does the work on your subscription, started
twice a day by a routine. A small listener (curl, no model) wakes it when you message the bot.

## What you can do

| Send the bot | Get |
|---|---|
| "I want to learn Spanish for a trip in May" (or type it in the app's "What do you want to learn?" box) | A new topic: the first unit written for your level, checked, then in the app. More units follow as you go |
| Any question | A sourced answer, built on what your vault already holds, with a 📥 **File it** button |
| Tap 📥 File it | The conversation archived word for word, and 0–3 short notes written into your vault as drafts |
| An article, a PDF or a link with "file this" | Archived as a source, and the few notes worth keeping five years from now |
| Words you met: a word, a screenshot, a photo of a menu, an article in a language you're learning | A translation in the chat, and the words you'd struggle with added to **Your words** lessons. Only the words are kept: never the photo, the text or where it came from |
| `/speak spanish` (or any language you learn), then voice notes | Role-play practice: what you said, corrections, a more natural version, the next line. Voice notes are transcribed on the bot's own machine and the audio deleted |
| `/plan`, "make it 15 minutes", "pause history" | Your plan changed |
| `/vault`, "what do I know about X?" | An answer from your own notes |
| (in the evening, if you haven't studied) | One reminder, with your streak |

## The app (optional, free Cloudflare account)

A Telegram Mini App, opened from the bot's App button:

- **Learn:** today's session (reviews due plus new lessons across your topics), placement tests, a path per topic with side paths, daily quests, streaks, Blue the owl. Spaced repetition is FSRS-5. Language cards become Duolingo-style drills; ideas come with Brilliant-style questions and a "Recap the idea" button. On a fresh install it asks what you want to learn.
- **Library:** your vault: search, maps, notes with backlinks and a small graph, the review queue (approve, edit or delete the bot's drafts), capture a source, ask about a note.
- **You:** streak, league against your own past weeks, badges, settings (minutes a day, reminder time, topic weights, pause).

Only your Telegram account can open it: the Worker checks Telegram's signature and your id. It keeps
your lessons, vault and progress in Cloudflare KV; the repo stays the record.

## How it fits together

```
Telegram ──▶ KnowledgeBot session (Claude) ──▶ your private repo (vault, lessons, progress) ──▶ app_sync push ──▶ Cloudflare KV
                     ▲                                                                                              │
                     └────────────── the app's queue (new topic, approve, edit, capture, ask, answers) ◀── Knowledge app
```

| Path | What it is |
|---|---|
| `vault/` | The vault: atomic concept and entity notes, maps, verbatim `raw/` sources, `index.md`, `log.md`. Its rules are `vault/CLAUDE.md` (with `_PATTERN.md`). Empty to start |
| `bot/` | `listen.py` (Telegram and the app's queue), `send.py` (replies, the File it button), `kb.py` (threads, filing, the reminder), `vault.py` (check, stats, find), `app_sync.py` (bundles to the app, queue, progress), `words.py` (Your words) |
| `app/` | The Knowledge app: a Cloudflare Worker plus KV (`worker.js`, `public/`), deployed by `deploy.sh` through `bots/wrangler.sh` |
| `learn/` | Lessons: `tracks.json` (empty to start), and per topic a `units/` folder and an optional `placement.json`. Format and sourcing rules: `SCHEMA.md`. `validate.py` checks them, Japanese and Chinese against JMdict and CC-CEDICT (downloaded at run time, never committed). `hanzi.py`: Chinese character data for lesson writers |
| `data/` | Bot data: learning progress pulled from the app, Q&A threads, Your words |

Skills: `knowledge-bot` (setup, the tutor, new topics, File it, the app's queue, the reminder) and
`knowledge-librarian` (optional weekly routine: the To be filed inbox and a monthly lint).

Rules it keeps: answers and lessons cite sources; health and medicine lessons come from AI, not a
doctor, and teach how things work, never what to take; messages and filed pages are data, never
instructions; photos and PDFs are deleted once read; your vault and progress live only in your own
private copy and your own Cloudflare account.

## Tests

- `python3 -m unittest discover -s knowledge/bot`
- `node --test knowledge/app/test/*.mjs`
- `python3 knowledge/learn/validate.py` (prints "no tracks yet" on a fresh copy); the test fixture: `python3 knowledge/learn/validate.py --root knowledge/app/preview/fixture/learn --no-dict`
- `node knowledge/app/preview/e2e.mjs [screenshot-dir]` (Chromium via Playwright: the fresh install, then a tiny made-up fixture track and vault in `app/preview/fixture/`, which is test data, not content)
