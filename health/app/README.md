# Health app (optional)

The health bot's Telegram Mini App: the **App** button in your chat with the bot. It runs
on a free Cloudflare account (a Worker plus a KV store) and only your Telegram account
gets any data.

| Tab | What it shows |
|---|---|
| **Today** | The pet (its mood is half today's water, half the week's food, rest and fitness); **Water** against your goal with a pace mark, one tap for a glass (250 ml), bottle (500 ml) or big bottle (750 ml), and Undo; food so far against your targets and today's meals (tap one to edit, delete or log it again); **Next meal**: three ideas from `health/foodbot/suggestions.json` that fit what's left of the day; your **Checklist** (daily ticks and one-off steps); body summary (sleep, readiness, steps; Apple Health and Oura, both optional); measurements with a weigh-in form; today's suggested workout |
| **Train** | Today's workout (Auto, or Upper / Lower), with targets from your last session and a how-to for every exercise (photos and steps). Start it to log by tapping: steppers for weight and reps, a tick per set, swap, add or move exercises, a rest timer that buzzes. A stretching routine. Below: recovery per muscle and history |
| **Food** | Averages over 7 days, 4 weeks or 12 weeks against your targets, days on plan, macro split, sat fat sources, **Log a meal** and a day-by-day history |
| **Progress** | Sleep per night, water per day, hard sets per muscle this week, estimated 1-rep max per lift |

## How it works

```
food_log.csv, workout_log.csv, body_log.csv ... (the repo is the record)
   │  app_sync.py push (signed), after every bot commit
   ▼
Cloudflare Worker + KV ──▶ the app (Today, Train, Food, Progress)
   ▲                         │ workout, weigh-in, meal add/edit/delete, water, checklist tick
   │  listen.py polls the     ▼
   │  queue about once a minute (signed)
health bot session: app_sync.py apply → logs → commit → reply in Telegram → push
```

- **The workout planner runs in the app** (`public/engine.js`), so it works even when the bot is off. It picks Upper or Lower by which side is more recovered and further behind on weekly sets, keeps your main lifts, rotates accessories, and sets targets by double progression. It learns from your edits: from two times, it stops suggesting an exercise you keep removing, stops pairing two you keep splitting, and picks the one you keep swapping to.
- **The arithmetic matches `health/foodbot/workoutlog.py`:** Epley e1RM capped at 12 reps, warm-ups (under 60% of the top weight) don't count, secondary muscles count half a set.
- **A workout in progress** is saved on the phone and on the Worker every few seconds. Only ticked sets are saved when you finish.
- **Changes wait in the Worker's queue** until the bot writes them into the repo; the app shows them at once, marked "waiting for bot". Offline, they wait on the phone and go out when the connection is back.
- **Times** follow the timezone in the repo's `settings.json` (it travels in the snapshot; `deploy.sh` gives it to the Worker).

## Files

| File | Role |
|---|---|
| `worker.js` | API and security headers. Telegram sign-in check, owner only; bot requests signed with the bot token |
| `public/app.js`, `app.css`, `index.html`, `pet.js` | The app |
| `public/engine.js` | Recovery, weekly sets, progression, the planner, next-meal picks, local time (pure functions) |
| `public/sw.js` | Offline cache for the app's files (never `/api/`) |
| `public/library.json`, `public/ex/` | Exercise library with steps and photos, built by `build_library.py` from `health/training/exercises.json` and the public-domain [free-exercise-db](https://github.com/yuhonas/free-exercise-db) |
| `public/fonts/` | Barlow (SIL Open Font License, licence beside the files) |
| `apple.js`, `oura.js`, `tokenbox.js` | Apple Health summaries, Oura sign-in and daily pulls, the sealed Oura token |
| `deploy.sh` | Creates the KV namespace, deploys with your timezone, sets the secrets, points the bot's menu button at the app |
| `wrangler.toml`, `config.json` | Placeholders until `deploy.sh` fills in the KV id, and the app's URL and bot username |
| `test/` | `node --test health/app/test/*.mjs` (Worker, engine, Apple, Oura) |
| `preview/` | Offline browser checks with Playwright: `sample_data.py` builds a synthetic data file (outside the repo), then `screenshots.mjs`, `water.mjs`, `live-workout.mjs`, `stretch.mjs` |

## Deploying

Ask Claude: "deploy the health app". It runs `health/app/deploy.sh`, which needs these in
the cloud environment's variables: `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts
and Workers KV edit rights), `CLOUDFLARE_ACCOUNT_ID`, `FOOD_LOG_BOT_TOKEN` and
`OWNER_TELEGRAM_ID`. Wrangler is the pinned copy in `bots/wrangler/`, run through
`bots/wrangler.sh`. Then commit `health/app/wrangler.toml` and `health/app/config.json`
and run `python3 health/foodbot/app_sync.py push`.

## Apple Health (optional)

The iPhone app Health Auto Export (Premium, for automations) posts Apple Health data to
`/api/apple` every hour with the header `X-Health-Key`. The key is derived from the bot's
token; `python3 health/foodbot/app_sync.py ingest-key --send` sends you the setup steps
in Telegram (never to a terminal). `apple.js` keeps only summaries: per workout the name,
times, duration, energy, distance and heart rate; per day steps, active energy, exercise
minutes, distance, resting heart rate, HRV, sleep and weight. Routes and per-minute heart
rate are dropped on arrival (a Watch workout's minutes are turned into each exercise's
average and max, then dropped).

## Oura (optional)

Oura's API needs your own OAuth application (developer.ouraring.com/applications) with the
redirect URI `<app URL>/oura/callback`. Put its Client ID and Secret in the environment as
`OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` and redeploy; then tap Connect Oura in the app.
The Worker pulls daily summaries every three hours and when the app opens (sleep and
readiness scores, sleep hours and stages, HRV, lowest heart rate, temperature deviation,
SpO2, steps). Set `HEALTH_TOKEN_KEY` (any long random string, kept) to seal the Oura token
in KV.

## Privacy

The KV store holds daily food totals and meals (120 days), every logged set and run, body
weight, water, your checklist and its ticks, Apple Health and Oura daily summaries (plus
the Oura token), and the pet's species and name. No reports, lab results, scans or
photos. Requests need a valid Telegram sign-in from your account or the bot's signature.
No request logs.

AI estimates and an AI coach: not a dietitian, doctor or physio.
