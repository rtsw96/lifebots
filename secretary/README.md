# Secretary

A Telegram bot and its app (a Telegram Mini App). It does five jobs:

- **Scheduling.** It finds pockets of time ("2 hours for the gym this week", "a free evening for dinner") and books things into your Google Calendar.
- **Reminders.** "Remind me at 4pm to call the bank", once or every day, weekday or week.
- **Time tracking.** The app shows where your hours go (work, social, exercise...) against targets you set.
- **Expense claims.** Send it a receipt, ad hoc or on a trip. It logs date, merchant, amount, currency and the value in your home currency. When you're ready to submit, it makes an Excel file, a PDF with one trimmed receipt per page, and a zip of the receipts named to match. It then tracks the claim until it's paid.
- **Quick web searches.** Short answers, with sources.

Each morning at 08:00 it also sends a short brief of the day. The bot's instructions are in `.claude/skills/secretary/SKILL.md`.

| App tab | What it shows |
|---|---|
| **Today** | The day hour by hour (sleep, workouts, events), what's next, the next two weeks |
| **Week** | Where a week's hours went, against the targets, with short notes; tap a day for its hours |
| **Trends** | Twelve weeks of planned hours by kind; sleep night by night |
| **Plan** | Open slots by length and part of the day; free evenings; add an event (it goes straight into Google Calendar) |
| **Claims** | To claim, submitted, paid; by trip; each receipt with its image |

## Setup

You need: the bot (BotFather), and for the calendar and the app a free Cloudflare account and a free Google Cloud project. Reminders and searches work with just the bot. The easiest way: open a Claude Code session on your (private) copy of this repo and say **"set up the secretary bot"**. Claude walks you through these steps and does the technical parts.

1. **The bot.** In Telegram, open @BotFather, send `/newbot`, pick a name. Copy the token it gives you into your cloud environment's variables as `SECRETARY_BOT_TOKEN`. Your Telegram id goes in `OWNER_TELEGRAM_ID` (if it isn't there already; @userinfobot tells you yours). Never paste either into a file or a chat with Claude.
2. **Your settings.** In `settings.json` at the repo root: `timezone` (for example `Europe/London`), `home_currency` (claims are totalled in it) and `holiday_calendar` (your country as Google names its public-holiday calendar, such as `singapore`, `usa`, `uk`, `australian`; leave it empty for none). Defaults: Asia/Singapore, SGD, no holidays.
3. **Deploy the app** (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment). Ask Claude to run `bash secretary/app/deploy.sh`. It creates the app's private storage, deploys it, and points the bot's menu button at it. It prints the app's address and a **redirect URI** ending in `/google/callback`: you need that in step 4. Claude then commits `secretary/app/wrangler.toml` and `secretary/app/config.json` and runs `python3 secretary/sync.py push`.
4. **Google Calendar: your own OAuth client** (about 10 minutes, at console.cloud.google.com, signed in with the Google account whose calendar you want). Claude can walk you through it screen by screen.
   1. Create a project (top bar → project picker → New project), for example "Secretary".
   2. **APIs & Services → Library**: search for **Google Calendar API** and press Enable.
   3. **OAuth consent screen** (or **Google Auth Platform → Branding**): choose External; app name "Secretary"; your email as support and developer contact. Under **Data access** (scopes), add `.../auth/calendar.events`. Under **Audience**, add yourself as a test user.
   4. Still under **Audience**, press **Publish app** so it says "In production". Google will show an "unverified app" warning when you sign in; that's expected for your own app (tap Advanced → Go to Secretary). This step matters: in "Testing", Google signs you out every 7 days.
   5. **Credentials → Create credentials → OAuth client ID**: type **Web application**; under **Authorised redirect URIs** paste the redirect URI from step 3. Create.
   6. Google shows a **Client ID** and **Client secret**. Put them in your cloud environment's variables as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (not in a file, not in a chat).
   7. Start a new session and ask Claude to run `bash secretary/app/deploy.sh` again: it stores the two keys as Cloudflare secrets.
5. **Connect.** Open the app from the bot's menu button and tap **Connect Google Calendar**. Google's sign-in opens in the browser; approve, then go back to Telegram.
6. **Make it yours.** Claude asks which words in your calendar mean work (company or team names, recurring meetings) and adds them to `categories.json`, and checks the targets in `targets.json`.
7. **Run it.** The bot runs in a routine, like the other bots (see SETUP.md at the repo root): Claude creates it when you say "set up the secretary bot".

To stop: send `/stop` to the bot. To disconnect Google: remove "Secretary" at myaccount.google.com/permissions (the app then asks to connect again).

## How it works

- **Calendar:** the Worker reads Google Calendar directly with your sign-in (OAuth). It reads again when the app opens and its copy is more than 3 minutes old.
  - It keeps **titles and times only**: no descriptions, guest lists, meeting links or passcodes. Google is asked for those fields alone.
  - Writing is the one exception. When you send them, the bot puts a description (agenda, meeting ID, passcode) and a location into events it adds or edits. These pass through the Worker to Google and are never read back, kept, or repeated in replies.
  - Nothing from the calendar goes into the repo.
- **Changes:** anything can be added from the app or the bot. Only events the app made (marked in Google with a private `timeapp` flag) can be edited, moved or deleted from it. Everything else is changed in Google Calendar itself. It never invites anyone.
- **Timezone and holidays:** from `settings.json` (`sync.py push` sends them to the app). Events are read and written in your timezone, daylight saving included; public holidays come from Google's holiday calendar for your country.
- **Sleep and workouts (optional):** if the health bot is installed, `sync.py push` sends daily summaries from its logs: sleep (bed, wake, hours; Oura first, Apple Health otherwise) and workouts with their times. Without it, the app simply shows no sleep or workouts.
- **Categories:** `categories.json` sorts events into Work, Social, Exercise, Travel, Health, Learning, Fun, Errands and Personal, by words in the title. First match wins. It ships as a neutral template; tell the bot your own words ("count Acme as work").
  - Events of 20 hours or more (trips, "Away — …") count as context for the day, not hours.
  - Events marked "free", and declined ones, show but don't count.
- **Targets:** `targets.json` holds sleep per night, bedtime, weekly exercise and social hours, and the awake window used to find slots.
- **Claims:** the record is `data/claims.csv`, one line per receipt with no card numbers.
  - Home-currency values use the ECB rate on the receipt's date (frankfurter.dev), cached in `data/fx_cache.json`, unless you give what the card charged.
  - The open trip is kept in `data/state.json`; new receipts are tagged to it.
  - Receipt images are kept for the claim pack in the app's private storage (Cloudflare KV, readable only by you and the bot), never in the repo, and are deleted 60 days after the claim is paid.
  - If the money bot is set up, `claims.py match` finds reimbursements in its ledger that pay a submitted batch.
- **The bot:** the same listener pattern and group routing as the other bots (`/here secretary` claims its topic). Scheduling goes through the Worker's signed calls, so the bot and the Plan tab find the same slots.
- **Who can see it:** the app answers only your Telegram account (`OWNER_TELEGRAM_ID`). The repo's pushes and the bot's calls are signed with the bot token. Your Google sign-in is sealed in KV under a key only the Worker holds.

| Path | What it is |
|---|---|
| `app/worker.js` | API, Google sign-in, settings, security headers |
| `app/google.js` | OAuth tokens; reading, adding, moving and deleting events; cutting events down to title and time |
| `app/tokenbox.js` | Seals the Google sign-in in KV |
| `app/public/` | The app: `model.js` (pure logic, timezones), `charts.js`, `app.js`, `ui.js`, `app.css` |
| `app/test/` | `node --test secretary/app/test/*.test.mjs`; `fixture.mjs` builds made-up data around today |
| `app/preview/screenshots.mjs` | Every tab and sheet, light and dark, at 360 and 390 px, served with the Worker's CSP; flags CSP violations, script errors and sideways scroll (needs Playwright) |
| `app/deploy.sh` | KV, deploy, secrets, the bot's menu button (through `bots/wrangler.sh`) |
| `sync.py` | Push claims, rules, targets, settings, and sleep and workouts if present; the bot's calendar calls |
| `claims.py`, `receipt.py` | The claims ledger (add, list, set, trips, export, pack, match, purge); receipt trimming |
| `remind.py` | Reminders |
| `brief.py` | The 08:00 morning brief |
| `bot/listen.py`, `bot/send.sh` | The bot's listener and replies |
| `data/` | `claims.csv`, `reminders.csv`, `state.json`, `fx_cache.json` (bot data, committed straight to `main`; empty to start) |

Tests: `python3 -m unittest discover -s secretary`, `python3 -m unittest discover -s secretary/bot`, `node --test secretary/app/test/*.test.mjs`. The claims tests need Pillow, numpy and openpyxl.
