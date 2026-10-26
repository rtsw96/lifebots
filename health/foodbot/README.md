# Health bot: the plumbing

A dedicated Claude Code session does the estimating, on your subscription (the
`health-bot` skill). A background long-poll listener (curl, no model) wakes it when a
message arrives, so an idle bot costs nothing.

```
You (Telegram) ──photo──▶ health bot ──getUpdates long-poll──▶ listen.py (background, idle = free)
                                                               │ saves event + photo to ~/.foodbot/inbox, exits
                                                               ▼
                                               Claude session wakes (health-bot skill)
                                               reads photo → estimates → foodlog.py add
                                               → send.sh reply → foodlog.py done (deletes photo)
                                               → commit the logs → relaunch listener
Scheduled routine (twice a day) ──▶ starts a fresh session that runs the bot
```

- **Backlog is kept.** Between runs Telegram holds messages for 24 hours; they are logged at the time you sent them.
- **Crash-safe.** The inbox is the queue and entries are deduplicated by message ID.
- **Private.** Only your Telegram id (`OWNER_TELEGRAM_ID`) is accepted.

| File | Role |
|---|---|
| `listen.py` | Long-polls the bot, downloads photos and PDFs to the inbox, transcribes voice notes locally, prints events, exits |
| `foodlog.py` | Meals: add, today, week, undo, edit, pending, done. All the arithmetic |
| `waterlog.py` | Water: add, undo, today, paced from 08:00 to the evening debrief |
| `workoutlog.py` | Workouts, runs and body weight: add, import, run, body, summary, week, history, prs, prefs, undo. Epley e1RM, volume, PRs, weekly sets per muscle |
| `bodyscan.py` | Body-composition scans: the numbers only, compared on the same machine |
| `weekly.py` | Weekly targets, the evening debrief, the pet's numbers |
| `health_settings.py` | Your targets (`health/settings.json`), with neutral defaults until the onboarding runs |
| `plan.py` | Your checklist (`health/plan.json`): daily items and one-off steps, titles only |
| `app_sync.py` | Pushes the snapshot to the health app; writes what you did in the app into the logs (`../app/README.md`) |
| `send.sh` | Replies (text, a chart, a file) |
| `suggestions.json` | Meal ideas the app picks from; replace them with your own |
| `reference_sg.md` | Rough values for common dishes (leans Singaporean) and single foods |
| `test_*.py` | Tests, including an end-to-end run against a fake Telegram server: `python3 -m unittest discover -s health/foodbot` |

Logs are committed straight to `main` of your (private) copy by the bot. Code changes go
through a pull request.
