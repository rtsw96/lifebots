"""A made-up Money app snapshot for showing the app to other people.

Every name, account and number here is invented (a pretend "Kai" living in
Singapore, reporting in SGD); nothing is read from your data. The spending
side goes through the real pipeline (ledger -> categories -> summary, flows,
recurring) so the screens behave exactly as they do for real; the holdings
side is written by hand.

    python3 finance/app/preview/demo.py <out.json>
    python3 finance/app/preview/demo.py finance/app/public/demo.json   (the app's demo mode)
    node finance/app/preview/screenshots.mjs <shots> <dir of out.json> <out.json name>
"""

from __future__ import annotations

import csv
import json
import random
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIN = HERE.parents[1]
sys.path.insert(0, str(FIN / "src"))
sys.path.insert(0, str(FIN / "bot"))
from finance import recurring, spending  # noqa: E402
import app_sync  # noqa: E402

AS_OF = date(2026, 10, 11)
START = date(2026, 3, 1)
R = random.Random(7)

BANK, MILES, CASHBACK, WALLET = "Everyday Bank", "Miles Card", "Cashback Card", "Travel Wallet"
ACCOUNTS = [(BANK, "bank"), (MILES, "card"), (CASHBACK, "card"), (WALLET, "wallet")]
# statements arrive late: each account's lines stop here
THROUGH = {BANK: date(2026, 10, 10), MILES: date(2026, 9, 18), CASHBACK: date(2026, 9, 24), WALLET: date(2026, 10, 9)}

DINING = ["Kopi & Toast", "Ramen Hut", "The Brunch Club", "Sushi Go", "Thai Corner", "Pasta Bar", "Burger Lab", "Dim Sum House", "Poke Bowl Co"]
DELIVERY = ["Deliveroo", "Foodpanda"]
HAWKER = ["Maxwell Food Centre", "Lau Pa Sat", "Tiong Bahru Market", "Old Airport Road FC", "Amoy Street FC"]
GROCER = ["FairPrice", "Cold Storage", "Don Don Donki"]


def months():
    m = START
    while m <= AS_OF:
        yield m
        m = (m.replace(day=28) + timedelta(days=4)).replace(day=1)


def lines():
    rows = []

    def add(d, acct, desc, amount, cat, merchant=""):
        if d <= THROUGH[acct] and d <= AS_OF:
            rows.append((d, acct, desc, round(amount, 2), cat, merchant))

    def day(m, lo=1, hi=28):
        return m.replace(day=R.randint(lo, hi))

    for m in months():
        add(m.replace(day=25), BANK, "SALARY ACME PTE LTD", 8650, "salary", "Acme (salary)")
        add(m.replace(day=26), BANK, "TRANSFER TO BROKER", -1500, "investment", "Broker")
        add(m.replace(day=1), BANK, "HOME LOAN INSTALMENT", -1650, "housing_mortgage", "Home loan")
        add(m.replace(day=28), BANK, "PAYNOW TO PARENTS", -800, "family", "Parents")
        add(m.replace(day=6), BANK, "IRAS ITX GIRO", -412.50, "tax", "Income tax (GIRO)")
        add(m.replace(day=5), BANK, "SAVINGS PLAN PREMIUM", -120, "insurance", "Savings plan")
        add(m.replace(day=15), BANK, "SP SERVICES", -R.uniform(85, 140), "utilities_home", "SP Services")
        add(m.replace(day=20), CASHBACK, "MOBILE PLAN", -32.90, "utilities_telco", "Mobile plan")
        add(m.replace(day=3), CASHBACK, "NETFLIX.COM", -19.98, "subscriptions", "Netflix")
        add(m.replace(day=9), CASHBACK, "SPOTIFY", -13.98, "subscriptions", "Spotify")
        add(m.replace(day=12), CASHBACK, "ICLOUD STORAGE", -3.98, "subscriptions", "iCloud")
        add(m.replace(day=2), CASHBACK, "CLIMB CENTRAL MEMBERSHIP", -139, "fitness", "Climbing gym")
        add(m.replace(day=14), BANK, "GIVING.SG", -50, "donations", "giving.sg")
        if m.month in (3, 6, 9):
            add(m.replace(day=10), BANK, "CONDO MGMT FEES", -360, "housing_fees", "Condo fees")
        for _ in range(R.randint(14, 20)):
            add(day(m), MILES, R.choice(DINING).upper(), -R.uniform(14, 68), "dining", "")
        for _ in range(R.randint(3, 6)):
            v = R.choice(DELIVERY)
            add(day(m), MILES, f"{v.upper()} SG", -R.uniform(18, 42), "dining", v)
        for _ in range(R.randint(12, 18)):
            add(day(m), CASHBACK, R.choice(HAWKER).upper(), -R.uniform(4, 9), "dining_hawker", "")
        for _ in range(R.randint(4, 7)):
            add(day(m), CASHBACK, R.choice(GROCER).upper(), -R.uniform(25, 120), "groceries", "")
        for _ in range(R.randint(6, 10)):
            add(day(m), MILES, "GRAB RIDES", -R.uniform(9, 28), "transport_ride", "Grab")
        for _ in range(R.randint(18, 26)):
            add(day(m), CASHBACK, "BUS/MRT", -R.uniform(1.2, 2.6), "transport_public", "Bus/MRT")
        for _ in range(R.randint(2, 5)):
            add(day(m), MILES, "SHOPEE SINGAPORE", -R.uniform(9, 85), "shopping_online", "Shopee")
        for _ in range(R.randint(0, 2)):
            add(day(m), MILES, "AMAZON.SG", -R.uniform(20, 140), "shopping_online", "Amazon")
        if R.random() < 0.7:
            add(day(m), MILES, R.choice(["UNIQLO", "IKEA", "MUJI"]), -R.uniform(30, 160), "shopping_retail", "")
        for _ in range(R.randint(1, 2)):
            add(day(m), MILES, "GOLDEN VILLAGE", -R.uniform(13, 28), "entertainment", "GV cinemas")
        if R.random() < 0.5:
            add(day(m), MILES, "SISTIC CONCERT", -R.uniform(68, 168), "entertainment", "SISTIC")
        if R.random() < 0.6:
            add(day(m), MILES, "KAYAK TOUR SENTOSA", -R.uniform(45, 90), "activities", "")
        if R.random() < 0.5:
            add(day(m), CASHBACK, "RAFFLES MEDICAL", -R.uniform(35, 90), "health", "")
        add(day(m), CASHBACK, "BARBER", -28, "personal_care", "Barber")
        for _ in range(R.randint(1, 3)):
            add(day(m), BANK, "E-WALLET TOP UP", -R.choice([30, 50, 50, 80]), "e_wallet", "E-wallet top-up")
        if R.random() < 0.5:
            add(day(m), BANK, "PAYNOW FROM SAM (DINNER)", R.uniform(25, 60), "reimbursement", "Sam")

    # two trips, one big yearly premium, one property tax bill, a refund
    add(date(2026, 5, 2), MILES, "SCOOT AIRLINE", -386, "travel", "Scoot")
    add(date(2026, 5, 3), MILES, "AGODA HOTEL BANGKOK", -540, "travel", "Agoda")
    for k in range(8):
        add(date(2026, 6, 12 + k % 4), WALLET, "THB SPEND BANGKOK", -R.uniform(12, 70), "travel", "Bangkok spending")
    add(date(2026, 8, 4), MILES, "SINGAPORE AIRLINES", -1180, "travel", "Singapore Airlines")
    add(date(2026, 8, 6), MILES, "BOOKING.COM HOTEL TOKYO", -960, "travel", "Booking.com")
    for k in range(14):
        add(date(2026, 9, 20 + k % 7), WALLET, "JPY SPEND TOKYO", -R.uniform(10, 90), "travel", "Tokyo spending")
    add(date(2026, 6, 18), BANK, "TERM LIFE PREMIUM", -980, "insurance", "Term life")
    add(date(2026, 5, 1), BANK, "IRAS PT GIRO", -880, "tax", "Property tax")
    add(date(2026, 7, 9), MILES, "AMAZON.SG REFUND", 64, "refund", "Amazon")
    add(date(2026, 7, 21), BANK, "DIVIDEND", 310, "investment_income", "Dividends")
    return rows


def write_data(d: Path):
    (d / "reference").mkdir(parents=True)
    (d / "canonical").mkdir()
    with (d / "reference" / "spend_accounts.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["account_id", "kind", "institution", "product", "note"])
        for a, k in ACCOUNTS:
            w.writerow([a, k, "Demo", a, ""])
    (d / "reference" / "category_rules.csv").write_text("priority,pattern,category,kind,merchant,note\n")
    (d / "reference" / "statement_formats.json").write_text("{}")
    (d / "reference" / "insurance_policies.csv").write_text(
        "policy,insurer,policy_name,in_force,commenced,annual_premium,paid_from,payee\n"
        "1,Insurer A,Term Life,Yes,2021-06-18,980,cash,Term life\n"
        "2,Insurer B,Hospital Plan,Yes,2022-08-19,420,Health savings,\n"
        "3,Insurer A,Savings Plan,Yes,2019-03-05,1440,cash,Savings plan\n")
    (d / "reference" / "recurring_manual.csv").write_text(
        "name,section,amount,cadence,paid_from,start,note\n"
        "Home loan (savings part),mortgage,1400,monthly,Savings scheme,2024-01-01,\"Paid from a savings scheme, so it never shows on a bank statement.\"\n")
    with (d / "canonical" / "transactions.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=spending.FIELDS)
        w.writeheader()
        for k, (dt, acct, desc, amt, cat, merch) in enumerate(sorted(lines())):
            w.writerow({"txn_id": f"demo{k:05d}", "date": dt.isoformat(), "account_id": acct, "description": desc,
                        "amount": f"{amt:.2f}", "currency": "SGD", "category": cat, "merchant": merch or desc.title(),
                        "source": "demo", "imported_at": "2026-10-11T00:00:00+00:00"})


def holdings():
    pos = [  # id, symbol, name, account, kind, currency, qty, mark, value SGD, cost SGD
        ("HOME", "HOME", "Home (equity)", "Property", "PROPERTY", "SGD", 1, 285000, 285000, 260000),
        ("VWRA", "VWRA", "Global All-World ETF", "Broker", "LISTED", "USD", 420, 148.2, 80180, 68500),
        ("ES3", "ES3", "STI ETF", "Broker", "LISTED", "SGD", 4800, 3.92, 18816, 16900),
        ("CSPX", "CSPX", "S&P 500 ETF", "Broker", "LISTED", "USD", 22, 640.5, 18240, 14800),
        ("A35", "A35", "SGD bond ETF", "Robo", "BOND", "SGD", 14000, 1.02, 14280, 14100),
        ("SSB", "SSB", "Savings bonds", "Bank", "BOND", "SGD", 10000, 1.0, 10000, 10000),
        ("BTC", "BTC", "Bitcoin", "Crypto app", "CRYPTO", "USD", 0.06, 98000, 7550, 5200),
    ]
    cash = [("Everyday Bank", "SGD", 24600, 24600), ("Broker", "USD", 3100, 3990), ("High-yield savings", "SGD", 18000, 18000)]
    total = sum(p[8] for p in pos) + sum(c[3] for c in cash)
    positions = [{"id": i, "symbol": s, "name": n, "account": a, "kind": k, "currency": c, "qty": q, "mark": mk,
                  "value": v, "local": round(q * mk, 2), "cost": cost, "pnl": v - cost, "pnl_pct": round((v - cost) / cost, 4),
                  "weight": round(v / total, 4), "mark_source": "demo"} for i, s, n, a, k, c, q, mk, v, cost in pos]
    by_kind, by_acct, by_cur = {}, {}, {}
    for p in positions:
        by_kind[p["kind"]] = by_kind.get(p["kind"], 0) + p["value"]
        by_acct[p["account"]] = by_acct.get(p["account"], 0) + p["value"]
        by_cur[p["currency"]] = by_cur.get(p["currency"], 0) + p["value"]
    for a, c, _, base in cash:
        by_kind["CASH"] = by_kind.get("CASH", 0) + base
        by_acct[a] = by_acct.get(a, 0) + base
        by_cur[c] = by_cur.get(c, 0) + base
    hist, v, dt = [], total * 0.9, AS_OF - timedelta(days=7 * 30)
    while dt <= AS_OF:
        hist.append([dt.isoformat(), round(v)])
        v = v * (1 + R.uniform(-0.006, 0.011)) + 900
        dt += timedelta(days=7)
    k = total / hist[-1][1]  # end exactly on today's net worth
    hist = [[dt_, round(x * k)] for dt_, x in hist]
    return {
        "net_worth": round(total), "securities": round(sum(p["value"] for p in positions if p["kind"] != "PROPERTY")),
        "cash_total": round(sum(c[3] for c in cash)), "margin_loans": 0, "history": hist,
        "by_kind": {k: round(x) for k, x in by_kind.items()}, "by_currency": {k: round(x) for k, x in by_cur.items()},
        "by_account": [{"id": a, "name": a, "value": round(x)} for a, x in sorted(by_acct.items(), key=lambda kv: -kv[1])],
        "positions": sorted(positions, key=lambda p: -p["value"]),
        "cash": [{"account": a, "currency": c, "amount": amt, "base": base, "stated": True} for a, c, amt, base in cash],
        "alerts": [
            {"severity": "warning", "area": "spending", "text": "Day-to-day spending was 14% over budget in September (the Tokyo trip)."},
            {"severity": "info", "area": "statements", "text": "Miles Card statement for October isn't in yet."},
        ],
    }


def snapshot() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        write_data(d)
        txns = spending.transactions(d)
        through = app_sync._through(txns)
        snap = {"generated_at": f"{AS_OF.isoformat()}T09:00:00+00:00", "as_of": AS_OF.isoformat(), "base": "SGD",
                "tz": "Asia/Singapore", **holdings(),
                "spending": spending.summary(txns, months=12, today=AS_OF), "flows": app_sync._flows(txns),
                "lines": app_sync._lines(txns, AS_OF), "category_groups": app_sync.CATEGORY_GROUPS, "accounts_through": through,
                "budgets": {"day_to_day": 2600, "day_to_day_ex_travel": 2000, "food": 1100, "shopping": 300, "travel": 600, "fun": 250},
                "recurring": recurring.build(txns, d / "reference", AS_OF, through),
                "spend_accounts": sorted(spending.accounts(d)), "categories": sorted(app_sync.CATEGORIES)}
    return snap


# The demo is shown to other people: none of your own account names, aliases or
# payee names may slip in through the code's tables. Fails loudly if one does.
def own_names() -> list:
    ref = FIN / "data" / "reference"
    names = set()
    for f, cols in (("spend_accounts.csv", ("account_id", "institution", "product")),
                    ("accounts.csv", ("account_id", "name", "broker")), ("payee_names.csv", ("name",))):
        p = ref / f
        if p.exists():
            with p.open(newline="", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    names |= {(r.get(c) or "").strip().lower() for c in cols}
    return sorted(n for n in names if len(n) >= 3 and n not in {"ibkr", "interactive brokers", "bank", "card"})


def check(text: str) -> None:
    import re
    low = text.lower()
    hits = [w for w in own_names() if re.search(rf"\b{re.escape(w)}\b", low)]
    if hits:
        raise SystemExit(f"demo snapshot mentions {hits}: rename the fake lines")


if __name__ == "__main__":
    out = Path(sys.argv[1])
    text = json.dumps(snapshot())
    check(text)
    out.write_text(text)
    print(out)
