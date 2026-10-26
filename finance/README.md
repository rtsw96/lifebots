# Money bot (finance)

A Telegram bot and an end-to-end encrypted Mini App for your own money: net
worth, holdings, cash, spending by month and category, recurring payments and
money flows. You send the bot your bank and card statements (CSV, PDF or a
screenshot) and broker confirmations; Claude reads them, files the lines and
trades, deletes the file, and refreshes the app. Everything is reported in your
home currency (`home_currency` in `settings.json`; SGD if unset).

It is a record and a calculator, not an adviser: it never places orders and
never tells you to buy or sell.

```
finance/
  src/finance/   the engine: the `finance` CLI (standard library only, Python 3.11+)
  bot/           the Telegram side: listen.py (inbox), send.sh (replies), app_sync.py (the app)
  app/           the Money app: Cloudflare Worker + static page, deployed with deploy.sh
  data/          your records (empty templates in a fresh copy)
  tests/         the engine's tests
```

The bot is run by the `finance-bot` skill (`.claude/skills/finance-bot/SKILL.md`).

## Setup

Ask Claude in a cloud session on your (private) copy: "set up the money bot".
The skill walks you through it. In short:

1. In Telegram, talk to @BotFather: `/newbot`, pick a name. Copy the token.
2. In your Claude Code cloud environment's settings, add the variables
   `FINANCE_BOT_TOKEN` (that token) and `OWNER_TELEGRAM_ID` (your numeric
   Telegram id; @userinfobot tells you). Never paste them into a chat.
3. Optional, for the app: a free Cloudflare account, and `CLOUDFLARE_API_TOKEN`
   and `CLOUDFLARE_ACCOUNT_ID` in the same settings. Claude runs
   `finance/app/deploy.sh`.
4. Optional, for an Interactive Brokers account: a read-only Flex Query and its
   token, as `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID`.

## The CLI

```bash
PYTHONPATH=finance/src python3 -m finance snapshot   # report + dashboard -> data/derived/
PYTHONPATH=finance/src python3 -m finance brief      # one-screen summary
PYTHONPATH=finance/src python3 -m finance check      # reconciliation; non-zero exit on error
PYTHONPATH=finance/src python3 -m finance analyse    # concentration, your tags
PYTHONPATH=finance/src python3 -m finance plan --years 10 --rate 0.06 --contribution 20000
PYTHONPATH=finance/src python3 -m finance spend --month 2026-09
PYTHONPATH=finance/src python3 -m finance txn import --json lines.json --account 'Card A' --source 'Card A statement 2026-09'
PYTHONPATH=finance/src python3 -m finance txn list --month 2026-09
PYTHONPATH=finance/src python3 -m finance txn category <txn_id> dining
PYTHONPATH=finance/src python3 -m finance trade BUY VWRA.L@LSE 10 140.5 --account Broker --currency USD --name "All-World ETF"
PYTHONPATH=finance/src python3 -m finance policy     # your own rules (none by default)
PYTHONPATH=finance/src python3 -m finance addcheck VWRA.L 120   # before buying more
PYTHONPATH=finance/src python3 -m finance ibkr sync  # optional IBKR Flex
```

Every command runs on the empty templates: a fresh copy reports a net worth of
zero and no errors.

## Your data (`finance/data/`)

| File | What it holds |
|---|---|
| `canonical/transactions.csv` | Bank and card lines: date, account alias, description (long digit runs masked), signed amount, currency, category |
| `canonical/trades.csv` | Every trade, dividend, deposit and withdrawal (`finance trade`, `finance ibkr sync`) |
| `reference/accounts.csv` | Investment accounts by alias, with ownership (`SELF`, `FAMILY`, `JOINT`) |
| `reference/spend_accounts.csv` | Bank, card and wallet aliases for statements. Never a number |
| `reference/category_rules.csv` | Regex rules that categorise lines (a neutral starter set; the bot adds yours) |
| `reference/statement_formats.json` | How to read a bank's CSV export (one entry per bank) |
| `reference/fx_rates.csv` | How many units of your home currency one unit of each other currency is worth |
| `reference/marks.csv` | Prices for what you hold (the bot updates them) |
| `reference/manual_assets.csv` | Holdings with no trades: property, a private fund, a loan you made |
| `reference/instrument_overrides.csv` | A kind (`PROPERTY`, `BOND`, `CRYPTO`, `PRIVATE_FUND`...) or clearer name for a holding |
| `reference/balance_assertions.csv` | Cash balances stated by a statement |
| `reference/insurance_policies.csv` | Your policies, so the Recurring tab knows premiums before they hit a statement |
| `reference/recurring_manual.csv` | Payments that never hit a statement, and ones you've ended |
| `reference/payee_names.csv` | `pattern,name` rows that give a recurring payee one clean name |
| `reference/budgets.json` | Monthly targets for the Everyday tab (none set) |
| `reference/investment_policy.json` | Your own rules (none set; the file documents each) |
| `reference/etf_facts.csv`, `tags.csv` | Fund facts for the ETF rule; your own tags for `analyse` |
| `derived/` | Rebuilt by `snapshot`: the report, dashboard, positions and net-worth history |

Statements are never kept. Every correction is a row in a reference file, so a
manual fix is version-controlled and visible.

**Starting your holdings.** Record each holding you already have as a `BUY`
(on the day you bought it, or on your start date at your average cost), or let
`finance ibkr sync` do it for an IBKR account: on the first sync it files what
you held before the statement's period as opening positions at IBKR's average
cost. Property and other untraded assets go in `manual_assets.csv`.

**Cash** moves only on `DEPOSIT` and `WITHDRAWAL` rows and on stated balances
(`balance_assertions.csv`, which the IBKR sync writes from the closing cash). A
`BUY` does not debit cash and a dividend does not credit it: record the
broker's cash balance from its statement instead. A stated negative balance is
a margin loan; an unexplained one is a reconciliation error.

**Shorts.** `SHORT` opens or adds to a short; `COVER` buys it back. Dividends
paid in lieu are `DIVIDEND` and borrow fees `INTEREST`, each with a negative
`--amount`. Mixing types is refused, so a keying error never quietly becomes a
short. A trade that causes an error is removed again and nothing is written.

## Your rules (optional)

`reference/investment_policy.json` ships empty. Copy what you want from its
`_example` block:

- an ETF diversification rule (minimum holdings, maximum weight in one issuer),
  judged on the facts in `etf_facts.csv`, which carry an as-of date and a source;
- restricted single names you may not hold directly;
- locked positions that must not be traded.

`finance policy` holds them against what you own. `finance addcheck <ticker>
<price>` checks a planned buy against them and flags averaging down: buying a
single name more than 3% below your average cost (`averaging_down.warn_below_cost`).

## The Money app

- **End-to-end encrypted.** Each phone makes its own key pair (ECDH P-256; the
  private key is non-extractable and stays in the phone's IndexedDB). The bot
  seals each snapshot with a fresh AES-256-GCM key, wrapped for each approved
  phone (`app/public/crypto.js`, `app/seal.mjs`). The Worker stores only the
  sealed blob and the phones' public keys.
- **Approving a phone.** A new phone shows a code; you approve it by sending
  `approve <code>` to the bot from your own chat. The bot re-derives the code
  from the key and pins the key in `app/devices.json` (public keys, not
  secret), so the Worker can't substitute one. Limit: the page's code is served
  by Cloudflare, so this protects stored data, not against a malicious server
  changing the app itself.
- **Demo mode** (footer) swaps in made-up data (`app/public/demo.json`, from
  `python3 finance/app/preview/demo.py finance/app/public/demo.json`, which
  refuses to write if one of your own account names slips in). While it is on,
  the app makes no `/api` call. Leaving it needs the PIN set when it was turned
  on.
- **Deploy:** `finance/app/deploy.sh` (needs `FINANCE_BOT_TOKEN`,
  `OWNER_TELEGRAM_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; runs the
  pinned wrangler through `bots/wrangler.sh`), then
  `python3 finance/bot/app_sync.py push`. It creates the KV namespace, writes
  its id into `wrangler.toml` and the Worker URL into `app/config.json`.

## Tests

```bash
PYTHONPATH=finance/src python3 -m unittest discover -s finance/tests
python3 -m unittest discover -s finance/bot
node --test finance/app/test/*.test.mjs
node finance/app/preview/demo-mode.mjs            # end to end in Chromium (needs Playwright)
node finance/app/preview/screenshots.mjs <dir>    # every tab, CSP and layout checks
```
