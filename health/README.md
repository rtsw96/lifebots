# Health bot

A Telegram bot that logs what you eat, drink and train, and coaches you towards your own
targets. Photograph or describe a meal and, within about a minute, you get an estimate,
today's running totals and what to aim for in the rest of the day. The same bot logs
workouts, runs, body weight, body-composition scans (numbers only) and water, sends an
evening debrief, and has an optional Telegram app (the **App** button) with dashboards,
a workout planner and a pet that lives on your week.

It runs on your own Claude subscription: a Claude Code cloud session reads the photos and
does the estimating; small scripts do every sum. No API key, no paid service.

**AI estimates and an AI coach, not a dietitian, doctor or physio.** Photo estimates are
usually within 20-30%. Anything about medicines, a diagnosed condition, pain or injury
goes to your doctor or physio; the bot won't advise on it.

## What it does

| Send | Get |
|---|---|
| A meal photo (a caption helps: "no rice", "half eaten") or a description | The meal logged, today's totals against your targets, one or two lines of advice |
| A voice note | Transcribed on the bot's machine (audio deleted at once), then handled like text |
| "water 500", "2 glasses" | Today's water against your goal and the pace |
| "bench 26kg 10,10,8", "rows 4x8 at 22", a gym-app screenshot | Sets logged, with estimated 1-rep max, volume and personal bests |
| "ran 5k in 27:40", "weight 70.5", "waist 82" | The run with its pace / weight with the 7-day trend |
| A body-composition scan (InBody, Tanita...) photo or PDF | The numbers logged and compared with your last scan on the same machine; the file is deleted |
| `today`, `week`, `workout`, `train week`, `prs`, `undo`, `fix 12: no skin` | Totals, trends, corrections |
| "add stretching to my daily checklist" | An item on your checklist (titles only, no doses) |
| `/stop` | Pauses the bot until you ask Claude to resume it |

Every evening (21:00 unless you change it) a debrief: the day, where each of the week's
targets stands, and two or three moves for tomorrow. On Sundays it reviews the week and
sets next week's targets, stepping halfway towards the plan wherever you fell short.

## Your targets

The first time you use it, the bot asks a few questions (your goal, diet, rough calories
if you know them, water, steps, training days) and saves the answers in
`health/settings.json`. Until then neutral defaults apply (about 1,800-2,200 kcal,
90-130 g protein, 2 L of water, 8,000 steps, 3 strength sessions a week). Change any of
them later by asking ("make my protein target 120 g").

## Folders and files

| Path | What |
|---|---|
| `settings.json` | Your targets (the onboarding writes it) |
| `foodbot/` | The bot: listener, logging tools, tests (`foodbot/README.md`) |
| `app/` | The optional Telegram app: Cloudflare Worker + KV (`app/README.md`) |
| `training/` | The exercise library and the training plan |
| `food_log.csv` | One row per meal (estimates). Photos are never stored |
| `workout_log.csv`, `workout_edits.csv` | One row per set or run; your swaps and removals in the app, which the planner learns from |
| `body_log.csv`, `body_scan_log.csv` | Weight and waist, one reading a day; scan numbers (never the scan, your name, age or height) |
| `water_log.csv` | Each drink |
| `plan.json`, `habit_log.csv` | Your checklist and its ticks |
| `activity_log.csv`, `daily_metrics.csv`, `oura_daily.csv` | Optional Apple Health and Oura daily summaries |
| `weekly_targets.json` | The week's targets |

They all start empty. The bot commits them to your own copy of this repo, which must be
**private**: it holds your health data.

## Privacy

- Only your Telegram account can talk to the bot; anyone else's messages are dropped unread.
- Meal photos, screenshots, scans and PDFs are deleted once read. Never stored in the repo.
- The optional app keeps a snapshot (food totals and meals, sets, weight, water, checklist,
  Apple Health and Oura daily summaries) in your own Cloudflare account, readable only by
  your Telegram account. No reports, lab results or scans.
- Tokens live in the cloud environment's variables, never in files or chat.
