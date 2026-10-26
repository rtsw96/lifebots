# Life bots

Five Telegram bots for everyday life, run by Claude on your own Claude subscription. Pick the ones you want; each works on its own.

| Bot | What it does |
|---|---|
| **Health** | Snap or describe a meal and it estimates calories and protein, keeps running totals against your targets and suggests what to eat for the rest of the day. Logs workouts (with a workout planner that learns what you like), body weight, water and habits. Optional Health app, Oura ring and Apple Health. |
| **Money** | Forward bank and card statements (CSV or PDF) and it files every line into a private ledger, then answers money questions ("what did I spend on food in March?"). Tracks investments, net worth and recurring payments. Optional end-to-end encrypted Money app. |
| **Secretary** | Finds free time and puts things on your Google Calendar, sends reminders at set times, tracks where your time goes, logs receipts for expense claims and builds claim packs, answers quick web searches. |
| **Knowledge** | A tutor and a second brain. Ask it anything and it answers with sources; tap **File it** to keep the takeaways in your own notes vault. Tell it what you want to learn (a language, a subject) and it writes a course for you, with daily lessons and speaking practice in its app. |
| **Trips** | Add it to a trip's group chat and it splits the bills (typed, photos, PDFs, voice notes), plans the trip with polls and to-dos, finds places nearby and answers travel questions. Nightly breakdowns and a "Wrapped" trip PDF. Optional trip app. |

None of them buys, books or pays for anything, or messages anyone except you (and your trip group, for the trip bot).

## How it works, in one paragraph

There's no server to rent. Each bot's "brain" is Claude, running in a Claude Code cloud session on your subscription. A small script in that session waits for Telegram messages and wakes Claude only when one matters. Claude reads it, uses the scripts in this repo for anything exact (sums, dates, currency), replies to you, and saves your data to **your own private copy** of this repo on GitHub. A scheduled routine starts a fresh session twice a day, so each bot runs on its own. The method is explained in [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## What you need

| Thing | Cost | Why |
|---|---|---|
| Telegram | Free | The bots live there |
| A GitHub account | Free | Holds your private copy of this code and your data |
| A Claude **Pro** or **Max** plan | Paid | Runs the bots. Each running bot uses some of your plan's usage (see SETUP.md, "Costs") |
| A Cloudflare account | Free | Only for the optional apps |
| A Google account | Free | Only for the secretary bot's calendar |

## Get started

**Follow [SETUP.md](SETUP.md).** It assumes no technical background. The shared part takes about 20 minutes, then about 10 minutes per bot, mostly done by Claude after you type one sentence.

## Privacy

Everything a bot learns about you (meals, money, calendar titles, notes) is saved in **your** copy of this repo, so it must be **private** (SETUP.md, step 2 shows how). Photos, statements, receipts and voice notes are read and then deleted, never saved to the repo. The optional apps keep a copy of your numbers in your own Cloudflare account, readable only from your Telegram account; the Money app is end-to-end encrypted. Nothing goes to the author of this project.

Health answers come from an AI, not a doctor. Anything about medication or a diagnosed condition belongs with your doctor.

## License

MIT, see [LICENSE](LICENSE). Fonts keep their own licenses (see the `OFL.txt` files next to them).
