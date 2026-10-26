# Setup guide

This guide assumes you've never done anything like this before. Follow the steps in order; each says what to click and what you should see. Use a computer if you can.

- **Part 1** (once, about 20 minutes): accounts, your private copy, and Claude's settings.
- **Part 2** (about 10 minutes per bot): make each bot you want in Telegram, then type one sentence to Claude.
- **Part 3** (optional): the apps.

**Words you'll meet**

| Word | Meaning |
|---|---|
| **Bot** | A Telegram account run by a program instead of a person |
| **Token** | A long password for a bot, like `7412345678:AAH3k...`. Anyone who has it controls the bot, so never post it or send it to anyone, Claude included |
| **Repository (repo)** | A folder of code on GitHub. You'll make your own private copy of this one |
| **Claude Code** | Claude working in a cloud computer. It runs your bots |
| **Session** | One conversation with Claude Code, with its own cloud computer |
| **Environment** | The settings for those cloud computers: which websites they may reach, and private values like your tokens |
| **Routine** | A schedule that starts a Claude Code session by itself |

---

## Part 1: once

### Step 1. Accounts you need

1. **Telegram** on your phone.
2. **GitHub:** create a free account at [github.com/signup](https://github.com/signup). Remember your username.
3. **Claude Pro or Max:** at [claude.ai](https://claude.ai), sign up or log in and subscribe to Pro or Max (Settings → Billing). The free plan can't run Claude Code in the cloud.

### Step 2. Make your own private copy

Your copy will hold your meals, money, calendar titles and notes, so it must be **private**.

1. Logged in to GitHub, open this project's page (the page you're reading).
2. Click the green **Use this template** button near the top right, then **Create a new repository**. Don't click **Fork**: a fork of a public project is always public.
3. **Owner:** you. **Repository name:** `lifebots` (or anything). Choose **Private**.
4. Click **Create repository**. You now have `github.com/<your username>/lifebots`.

### Step 3. Find your Telegram user ID

The bots need to know you're their owner. Your Telegram user ID is a number like `123456789` (not your username or phone number).

1. In Telegram, search for **@userinfobot**, open it and tap **Start**.
2. Copy the number next to **Id**.

### Step 4. Connect Claude to GitHub

1. Go to [claude.ai/code](https://claude.ai/code). If it asks you to connect GitHub, do so. Otherwise open [claude.ai/connect-github](https://claude.ai/connect-github).
2. GitHub asks where to install the **Claude** app. Choose your account, pick **Only select repositories**, select your `lifebots`, and click **Install**. (If you're never asked, open [github.com/apps/claude](https://github.com/apps/claude), click **Configure** and add it there.)

### Step 5. Make an environment for the bots

1. On [claude.ai/code](https://claude.ai/code), find the small **cloud button** in the row above the message box (it shows an environment name, probably **Default**). Click it.
2. Choose **Cloud**, then **Add cloud environment**.
3. Fill in the form:
   - **Name:** `Life bots`
   - **Network access:** **Full**. The bots reach Telegram, exchange rates, maps and more, which the default setting blocks.
   - **Environment variables:** one line for now, with your number from step 3 and no spaces:
     ```
     OWNER_TELEGRAM_ID=123456789
     ```
     You'll add each bot's token here in Part 2.
   - Leave **Setup script** empty.
4. Click **Create environment**.

To change it later: cloud button → **Cloud** → hover over **Life bots** → the settings icon on the right → edit → **Save changes**. A session that's already open doesn't see changes; start a new one.

These values are visible to anyone who uses this environment. That's only you, unless you share your Claude account.

### Step 6. Starting a session (you'll do this often)

On [claude.ai/code](https://claude.ai/code), start a new session with:
- **Repository:** your `lifebots`;
- **Environment:** **Life bots** (the cloud button above the message box).

Then type what you want in plain words. Claude knows how to set up and look after the bots (`.claude/skills/setup`).

---

## Part 2: each bot

Do steps 7–9 for each bot you want. You can add more bots any time.

| Bot | Token name for step 8 | What to say in step 9 |
|---|---|---|
| Health | `FOOD_LOG_BOT_TOKEN` | `Set up the health bot` |
| Money | `FINANCE_BOT_TOKEN` | `Set up the money bot` |
| Secretary | `SECRETARY_BOT_TOKEN` | `Set up the secretary bot` |
| Knowledge | `KNOWLEDGE_BOT_TOKEN` | `Set up the knowledge bot` |
| Trips | `SPLIT_BOT_TOKEN` | `Set up the trip bot` |

### Step 7. Make the bot in Telegram

1. In Telegram, search for **@BotFather** (blue tick), open it and tap **Start**.
2. Send `/newbot`. Give it a **name** people will see (e.g. `My Health`), then a **username** that ends in `bot` and nobody else has (e.g. `ana_health_bot`).
3. BotFather replies with **the token**. Copy it into a private note for step 8. Don't share it.
4. **Trip bot only:** send `/setprivacy` to BotFather, tap your trip bot, then **Disable**. Without this it only sees messages starting with `/` in groups.
5. Search for your new bot's username, open it and tap **Start**. Bots can't message you until you do.

If a token ever leaks, send `/revoke` to BotFather for a new one and update it in step 8.

### Step 8. Add the token to your environment

Open your environment's settings (step 5, last paragraph) and add one line under **Environment variables**, using the token name from the table above:
```
FOOD_LOG_BOT_TOKEN=paste-the-token-here
```
Click **Save changes**.

### Step 9. Let Claude set it up

1. Start a **new** session (step 6).
2. Type the sentence from the table, e.g. **`Set up the health bot`**, and send.
3. Claude checks your copy is private, checks the token, asks a few questions (your name and timezone the first time; then things like your food targets, your bank accounts, the words that mean "work" in your calendar, or what you'd like to learn), runs the bot's tests, and creates a routine that starts the bot twice a day. Then it starts the bot.
4. A minute or two later, send your bot a message in Telegram.

If Claude reports a problem, it says which step to fix. The usual one is a typo in a variable name (they're case-sensitive).

### Step 10. Using the bots

| Bot | Try |
|---|---|
| Health | A photo of your lunch, or "2 eggs and toast"; "did 5 km run"; "weighed 68.2"; "how am I doing today?" |
| Money | Forward a bank or card statement (CSV or PDF); "what did I spend on food last month?"; "bought 10 VWRA at 140" |
| Secretary | "find me 2 hours for the gym this week"; "remind me at 6pm to call Mum"; a photo of a receipt for a claim; "where did my time go this week?" |
| Knowledge | "I want to learn Spanish, I'm a beginner"; any question, then tap **File it** to keep the answer |
| Trips | Add the bot to your trip's group chat, send `/newtrip Japan JPY Ana Ben Chloe` (you first), then everyone posts payments as they'd say them. The full list is in [trips/README.md](trips/README.md) |

Replies take 20–60 seconds: that's Claude reading the message. Each bot's skill and README have the full list of what it understands.

**One group for all your bots (optional).** Make a Telegram group just for you, turn on **Topics** (group settings), add your bots, and create a topic per bot. In each topic send `/here food`, `/here money`, `/here secretary`, `/here knowledge` or `/here travel`. Make a "Reports" topic and send `/here reports` there for finished reports. Each bot then answers only in its own topic, and only to you.

---

## Part 3: the apps (optional)

The health, money, secretary, knowledge and trip bots each have an optional Telegram app (a screen that opens from the bot's menu button): charts, your day, your ledger, lessons, the trip. They run free on Cloudflare, readable only from your Telegram account. The Money app is end-to-end encrypted.

### Step 11. Which apps need what

| App | Needs |
|---|---|
| Health | Cloudflare (step 12). Optional: Apple Health (needs the Health Auto Export app) and Oura (your own Oura API keys); ask Claude "set up Apple Health" or "set up Oura" |
| Money | Cloudflare. After deploying, open the app and send the bot the code it shows (`approve <code>`), so only your phone can read it |
| Secretary | Cloudflare and a Google OAuth client for your calendar: Claude walks you through it (`secretary/README.md`, "Setup") |
| Knowledge | Cloudflare. Lessons happen in the app; questions and filing work without it |
| Trips | Cloudflare, then register the app with @BotFather `/newapp` (`trips/README.md` has the steps; Claude will remind you) |

### Step 12. Cloudflare account and key

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (free) and verify your email.
2. In the left menu, open **Workers & Pages** (under **Compute**) once. If it asks you to choose a `workers.dev` subdomain, pick any name.
3. **Account ID:** on that page, copy **Account ID** from the right side.
4. **API token:** person icon (top right) → **Profile** → **API Tokens** → **Create Token** → find **Edit Cloudflare Workers** → **Use template**. Under **Account Resources** choose your account; under **Zone Resources** choose **All zones**. **Continue to summary** → **Create Token**, and copy it (it's shown once).
5. Add both to your environment (step 5, last paragraph):
   ```
   CLOUDFLARE_API_TOKEN=paste-the-token
   CLOUDFLARE_ACCOUNT_ID=paste-the-account-id
   ```

### Step 13. Deploy an app

Start a new session and type **`Deploy the health app`** (or money, secretary, knowledge, trip). Claude publishes it to your Cloudflare account, sets the bot's menu button, and tells you anything left to do for that app (step 11).

---

## Costs

- **Claude:** each running bot uses some of your plan's usage, a little every hour even when quiet, more on busy days (photos, statements, long questions). Check [claude.ai/settings/usage](https://claude.ai/settings/usage). Run only the bots you use; switch a routine off when you don't need its bot (e.g. the trip bot between trips).
- **Telegram, GitHub, Cloudflare, Google:** free for this.

## Making a routine by hand

Claude normally creates each bot's routine for you (step 9). If it says it can't:

1. Go to [claude.ai/code/routines](https://claude.ai/code/routines) → **New routine**.
2. **Name:** e.g. `Health bot`. **Prompt:** the one Claude gave you (it's also in `.claude/skills/setup/SKILL.md`, "Routine prompts").
3. **Model:** **Sonnet** (it handles the bots well and uses less of your plan). **Repository:** your `lifebots`. **Environment:** **Life bots**.
4. **Trigger:** **Schedule** → **Daily** at a few minutes past the hour (e.g. 8:07 AM), then **Add another trigger** → **Daily** at 8:07 PM. Use different minutes for different bots.
5. **Connectors:** remove them all. **Create**, then **Run now**.

## When something's wrong

| Problem | Try |
|---|---|
| A bot doesn't reply | On [claude.ai/code](https://claude.ai/code), look for its latest session. None: open the routine and click **Run now**. One that stopped with an error: its last message usually says what's missing. Or start a session and say **`Check my bots`** |
| "token missing" or similar | Check the variable names in your environment (step 5); they're case-sensitive. Then start a new session |
| The bot never messages you | Open it in Telegram and tap **Start** (step 7.5) |
| The trip bot only answers `/commands` | Privacy mode is still on: step 7.4, then remove the bot from the group and add it back |
| "Network" or "403" errors | Set the environment's **Network access** to **Full** (step 5) |
| You've run out of Claude usage | The bots stop until your usage resets. Messages wait in Telegram for up to 24 hours |

## Getting updates

When this project improves, start a session and type **`Update the bots from github.com/rtsw96/lifebots`**. Claude copies in the new code, keeps your data and settings, runs the tests and saves it.

## Pausing and resuming

- **Pause:** send `/stop` to the bot (or `/stopbot` in a trip group), or switch its routine off.
- **Resume:** start a session and type **`Resume the health bot`** (or whichever).
