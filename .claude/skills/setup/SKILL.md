---
name: setup
description: Setting up and looking after the life bots for an owner who may not be technical. Use when they say "set up the health bot" (or money, secretary, knowledge, trip bot), "set up my bots", "deploy the health app" (or money, secretary, knowledge, trip app), "the trip app short name is X", "check my bots", "update the bots from github.com/rtsw96/lifebots", "pause the X bot" or "resume the X bot". Not for running a bot (each bot has its own skill).
---

# Setup and maintenance

The owner followed SETUP.md and may know nothing about code. Reply in plain words: what you checked, what worked, and the one thing they need to do next (by its SETUP.md step number). No jargon, no stack traces.

**Never print** a token, `OWNER_TELEGRAM_ID` or any key, not even partly. Check a variable with `[ -n "$VAR" ] && echo set || echo missing`. Never ask the owner to paste a token into the chat: tokens go in the environment's variables (SETUP.md, step 5).

**Branch.** The bots keep their data and settings on `main`. These tasks commit straight to `main`: `git checkout main && git pull --rebase origin main` first, `git push origin main` at the end. Never force-push.

## The bots

| Bot | Token variable | Skill (its own first-run section) | Listener | App deploy | Data the bot owns (kept on updates) |
|---|---|---|---|---|---|
| health | `FOOD_LOG_BOT_TOKEN` | `health-bot` ("First use: onboarding") | `health/foodbot/listen.py` | `bash health/app/deploy.sh` | `health/*.csv`, `health/*.json`, `health/foodbot/suggestions.json`, `health/app/config.json`, `health/app/wrangler.toml` |
| money | `FINANCE_BOT_TOKEN` | `finance-bot` ("First run") | `finance/bot/listen.py` | `bash finance/app/deploy.sh` | `finance/data/`, `finance/app/devices.json`, `finance/app/config.json`, `finance/app/wrangler.toml`, `finance/reports/` |
| secretary | `SECRETARY_BOT_TOKEN` | `secretary` ("First run") | `secretary/bot/listen.py` | `bash secretary/app/deploy.sh` | `secretary/data/`, `secretary/categories.json`, `secretary/targets.json`, `secretary/app/config.json`, `secretary/app/wrangler.toml` |
| knowledge | `KNOWLEDGE_BOT_TOKEN` | `knowledge-bot` ("Set up") | `knowledge/bot/listen.py` | `bash knowledge/app/deploy.sh` | `knowledge/data/`, `knowledge/vault/`, `knowledge/learn/` (courses written for them), `knowledge/app/config.json`, `knowledge/app/wrangler.toml` |
| trips | `SPLIT_BOT_TOKEN` | `bill-split` | `trips/splitbot/listen.py` | `bash trips/webapp/deploy.sh` | `trips/data/`, `trips/webapp/config.json`, `trips/webapp/wrangler.toml` |

Shared: `settings.json` (name, timezone, home currency, holiday calendar, which bots are on) and `bots/group.json` (the optional bot group) are the owner's too.

## "Set up the <name> bot"

Stop at the first failure and say how to fix it.

1. **Private copy.** If `gh repo view --json visibility -q .visibility` works and prints `PUBLIC`, stop: their data would be public. Tell them to make it private (GitHub → the repo → Settings → General → Danger Zone → Change visibility → Private), or to recreate it from the template as private (SETUP.md, step 2).
2. **Variables.** `OWNER_TELEGRAM_ID` set and digits only (`[[ "$OWNER_TELEGRAM_ID" =~ ^[0-9]+$ ]]`), and the bot's token variable (table above) set. Missing: they add it in the environment (SETUP.md, step 5 for the id, step 8 for the token) and start a **new** session, because a running session doesn't see changes.
3. **Network.** `curl -sS -o /dev/null -w '%{http_code}\n' --max-time 20 https://api.telegram.org` should print 200 or 302. A 403 means the environment's Network access isn't **Full** (SETUP.md, step 5).
4. **Token works.** Without showing it: `curl -sS "https://api.telegram.org/bot$TOKEN_VAR/getMe" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("@"+d["result"]["username"] if d.get("ok") else "token rejected")'` (use the bot's variable). "token rejected": they copy it again from @BotFather (SETUP.md, step 7) and update it (step 8). Then clear any old webhook: `curl -sS -o /dev/null "https://api.telegram.org/bot$TOKEN_VAR/deleteWebhook"`.
5. **settings.json.** If `owner_name` is still "Your first name", or `timezone` / `home_currency` aren't theirs, ask in one message (first name, city or timezone, home currency) and fill them in. Set `bots.<name>` to `true`. Commit "settings: <name> bot on".
6. **The bot's own first run.** Read that bot's skill and do its first-run section (onboarding questions, accounts, categories or topics). For trips there is nothing to ask: run `python3 trips/splitbot/send.py --status` (privacy mode must be OFF; if ON, SETUP.md step 7.4) and `python3 trips/splitbot/commands.py sync`.
7. **Tests** for that bot, as its skill lists them. Report pass or fail in one line; on a failure, don't go on.
8. **The routine.** Create it with the `create_trigger` tool:
   - `name`: "<Name> bot";
   - `create_new_session_on_fire`: true;
   - `cron_expression`: twice a day, 12 hours apart, in their timezone, on an odd minute, e.g. `CRON_TZ=<timezone> 7 8,20 * * *` (use a different minute for each bot: health 7, money 11, secretary 13, knowledge 17, trips 19);
   - `prompt`: the bot's routine prompt (below). Never a token in it.

   Then `fire_trigger` it once so the bot starts now. If `create_trigger` isn't available in this session, give them the prompt and point them to SETUP.md, "Making a routine by hand".
9. **Hello.** The first run sends its own greeting. Tell them: open the bot in Telegram, tap **Start** if they haven't, and send it something in a minute or two. Mention the optional app (SETUP.md, part 3) for this bot.

### Routine prompts

All of them begin: "Run the <name> bot for the next 11 hours 50 minutes. Work on main: `git checkout main && git pull --rebase origin main`." and end: "Relaunch the listener after every exit as the skill says, with N = min(3300, seconds left in this run), Bash timeout 3600000, run_in_background true. Keep context small. Never print tokens or chat ids. Stop when the time is up." In between:

| Bot | Middle |
|---|---|
| health | Read .claude/skills/health-bot/SKILL.md once and follow "Start or restart", including the evening debrief. |
| money | Read .claude/skills/finance-bot/SKILL.md once and follow "Start or restart". |
| secretary | Read .claude/skills/secretary/SKILL.md once and follow "Start or restart", including the morning brief and reminders. |
| knowledge | Read .claude/skills/knowledge-bot/SKILL.md once and follow "Start or restart", including the daily reminder and the curriculum check. |
| trips | Read .claude/skills/bill-split/SKILL.md once (and .claude/skills/trip-concierge/SKILL.md the first time a trip in planning sends an event), then "Start or restart": run `python3 trips/splitbot/transcribe.py --warm` in the foreground first (Bash timeout 600000), then `python3 trips/splitbot/commands.py sync`, then launch the listener. After each exit also run `python3 trips/splitbot/report.py nightly` and `python3 trips/splitbot/plan.py due --send`, and commit and push trips/data to main whenever it changed. |

The knowledge bot can also have its weekly librarian routine (weekly, fresh session, prompt "Run the knowledge librarian: follow .claude/skills/knowledge-librarian/SKILL.md."); offer it once.

## "Set up my bots"

Ask which bots they want (show the five in one line each, from README.md), then do "Set up the <name> bot" for each in turn. Check the shared parts (steps 1–3, 5) once.

## "Deploy the <name> app"

1. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set (else SETUP.md, step 12, then a new session), plus the bot's token and `OWNER_TELEGRAM_ID`. For the secretary app, read `secretary/README.md` "Setup" first: it needs the Google keys after the first deploy.
2. Run the deploy (table above), Bash timeout 600000. It creates the storage, publishes the app, stores secrets in Cloudflare, writes the app's `config.json` and `wrangler.toml`, and prints nothing secret. "No workers.dev subdomain": SETUP.md, step 12.2, then run it again. An authentication error: the API token needs the **Edit Cloudflare Workers** template with their account selected (step 12.4).
3. Commit the app's `config.json` and `wrangler.toml` ("<name> app deployed") and push to `main`.
4. Push the first snapshot with the bot's app sync (its skill says which command).
5. Tell them how to open it (the bot's menu button, or `/app`) and anything that bot's skill or app README adds (approving a phone for the Money app, connecting Google Calendar, Oura or Apple Health).

## "The trip app short name is <name>"

`python3 trips/splitbot/webapp_sync.py --set-short-name <name>`, commit `trips/webapp/config.json` ("Trip app short name"), push to `main`. Tell them `/app` in a trip group now posts the app button (trips/README.md, "Registering the trip app").

## "Check my bots"

For each bot that is on in `settings.json`: steps 2–4 above, `git log -1 --format=%cr -- <its data path>` (when it last saved anything), whether its `PAUSED` file exists (`health/foodbot/PAUSED`, `finance/bot/PAUSED`, `secretary/bot/PAUSED`, `trips/data/PAUSED`, or as its skill says), and whether its routine exists (`list_triggers`, if available). Explain what you found in a short table. If a routine seems not to run, ask them to open claude.ai/code/routines and check it is switched on and uses the right environment and repository.

## "Update the bots from github.com/rtsw96/lifebots"

Copies in the new code and keeps everything that is theirs.

1. `git remote get-url upstream || git remote add upstream https://github.com/rtsw96/lifebots.git`, then `git fetch upstream main`.
2. `git checkout upstream/main -- . ':(exclude)settings.json' ':(exclude)bots/group.json'` plus one `':(exclude)<path>'` for every data path in the table above.
3. `git status --short` and `git diff --cached --stat`. If they changed code themselves, those files are now overwritten: list them and ask before going on.
4. Run the tests of every bot that is on. If any fail, `git checkout HEAD -- .` to undo and tell them the update wasn't applied.
5. Commit ("Update bot code from upstream") and push to `main`. For each deployed app (its `config.json` has a `url`) whose folder changed, run its deploy again.
6. Tell them what changed in a few words (the upstream commit titles they got). Running bots pick it up on their own (their listener exits when its code changes); otherwise at the next routine run.

## "Pause the <name> bot" / "Resume the <name> bot"

- **Pause:** in Telegram, `/stop` (or `/stopbot` for the trip bot) does it from the chat. From a session: switch the routine off at claude.ai/code/routines (or `update_trigger` with `enabled: false`).
- **Resume:** delete the bot's `PAUSED` file if there is one (`git rm`, commit "Resume the <name> bot", push), switch the routine back on, and `fire_trigger` it (or **Run now** on the routine page).
