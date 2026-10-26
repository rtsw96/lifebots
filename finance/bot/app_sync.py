#!/usr/bin/env python3
"""Sync the finance app (Cloudflare Worker + KV) with the repo, end-to-end encrypted.

The repo stays the record. The bot builds a snapshot from the same code the
CLI uses (`portfolio.build`, `spending`, `recurring`, your policy), seals it
for your approved devices (finance/app/seal.mjs) and pushes the sealed blob.
The Worker can't read it.

  app_sync.py push           build, seal and send the snapshot; then ack app changes already applied
  app_sync.py apply          apply changes made in the app (categories) to the ledger
  app_sync.py devices        list devices (approved ones are pinned in finance/app/devices.json)
  app_sync.py approve <id>   approve a pending device after you confirm its fingerprint in the bot chat
  app_sync.py revoke <id>    stop sealing for a device
  app_sync.py --dry-run      build the snapshot and print its size and sections (no network)

Devices: the approved public keys are pinned in finance/app/devices.json (public
keys are not secret). Snapshots are sealed only for pinned keys, so the Worker
can't slip in a key of its own. The fingerprint you see on the phone is
recomputed here from the key itself before approval.

Requests are signed with HMAC_SHA256(key = HMAC_SHA256("FinanceSync", bot token),
msg = body). Not configured (no finance/app/config.json, or no token): one line, exit 0.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIN = HERE.parent
sys.path.insert(0, str(FIN / "src"))
from finance import portfolio, recurring, spending  # noqa: E402
from finance import policy as policy_mod  # noqa: E402
from finance.core.money import BASE_CURRENCY  # noqa: E402

DATA = Path(os.environ.get("FINANCE_DATA", FIN / "data"))
CONFIG = FIN / "app" / "config.json"
PINNED = FIN / "app" / "devices.json"
# The categories the app offers (the rules file may use these and no others).
CATEGORIES = ["dining", "dining_hawker", "groceries", "transport_public", "transport_ride", "transport_fuel",
              "shopping_online", "shopping_retail", "travel", "health", "fitness", "personal_care", "entertainment",
              "activities", "subscriptions", "education", "utilities_home", "utilities_telco", "insurance", "tax",
              "housing_fees", "housing_mortgage", "property_capex", "property_costs", "car", "car_purchase", "family",
              "gifts", "donations", "bank_fees", "cash_withdrawal", "e_wallet", "refund", "reimbursement", "transfer",
              "own_transfer", "card_payment", "investment", "loan", "salary", "investment_income", "rental_income",
              "income_other", "other"]


def timezone_name() -> str:
    """settings.json's timezone (bots/settings.py), for the app's "as of" time."""
    try:
        sys.path.insert(0, str(FIN.parent / "bots"))
        import settings  # noqa: PLC0415
        return settings.get("timezone") or "Asia/Singapore"
    except Exception:  # noqa: BLE001 - the package used on its own
        return "Asia/Singapore"
    finally:
        if sys.path and sys.path[0] == str(FIN.parent / "bots"):
            sys.path.pop(0)


def token() -> str:
    return os.environ.get("FINANCE_BOT_TOKEN", "")


def config() -> dict | None:
    p = Path(os.environ.get("FINANCE_APP_CONFIG") or CONFIG)
    if not p.exists():
        return None
    cfg = json.loads(p.read_text())
    return cfg if cfg.get("url") else None


def sign(tok: str, body: bytes) -> str:
    key = hmac.new(b"FinanceSync", tok.encode(), hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def post(cfg: dict, tok: str, path: str, obj: dict, max_time: int = 30) -> dict:
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
    out = subprocess.run(
        ["curl", "-sS", "--max-time", str(max_time), "-X", "POST", "-H", "Content-Type: application/json",
         "-H", f"X-Sync-Signature: {sign(tok, body)}", "--data-binary", "@-", cfg["url"].rstrip("/") + path],
        input=body, capture_output=True, check=True).stdout
    res = json.loads(out or b"{}")
    if not res.get("ok"):
        raise RuntimeError(f"{path}: {res.get('error', 'failed')}")
    return res


def fingerprint(pub: dict) -> str:
    h = hashlib.sha256(f"{pub['x']}.{pub['y']}".encode()).hexdigest()[:12]
    return f"{h[:4]}-{h[4:8]}-{h[8:12]}"


def pinned() -> list[dict]:
    return json.loads(PINNED.read_text()).get("devices", []) if PINNED.exists() else []


# ------------------------------------------------------------------ snapshot

def r0(x) -> float:
    return round(float(x or 0), 2)


def _history() -> list:
    p = DATA / "derived" / "networth_history.csv"
    if not p.exists():
        return []
    with p.open(newline="") as fh:
        return [[r["date"], r0(r["net_worth"])] for r in csv.DictReader(fh)]


def _alerts(snap, as_of: date) -> list[dict]:
    """Everything that needs a look, worst first: reconciliation, prices, your policy."""
    out = []
    for (acct, cur), v in snap.unexplained_negative_cash():
        out.append({"severity": "error", "area": "cash", "text": f"{acct} {cur} cash is {v:,.0f} with no statement behind it: send the latest statement"})
    for sym in snap.unmarked:
        out.append({"severity": "warning", "area": "marks", "text": f"No price for {sym}: valued at zero"})
    ref = DATA / "reference"
    rules = policy_mod.Policy.from_json(ref / "investment_policy.json")
    facts = policy_mod.load_facts(ref / "etf_facts.csv")
    ownership = {k: a.ownership.value if hasattr(a.ownership, "value") else str(a.ownership) for k, a in snap.accounts.items()}
    for i in policy_mod.check(snap.positions, facts, rules, as_of, ownership):
        if i.severity != "info":
            out.append({"severity": i.severity, "area": "policy", "text": f"{i.instrument_id}: {i.detail}"})
    rank = {"error": 0, "warning": 1}
    return sorted(out, key=lambda a: rank.get(a["severity"], 2))


# Category groups for the app's charts: what you can't avoid, what you chose to keep
# paying, day-to-day spending (everything else), and one-off capital.
CATEGORY_GROUPS = {
    "committed": ["tax", "family", "housing_mortgage", "housing_fees", "insurance", "utilities_home", "utilities_telco"],
    "chosen": ["donations", "subscriptions", "education", "fitness", "bank_fees"],
    "one_off": ["property_capex", "property_costs", "car_purchase"],
}
SOURCE_LABELS = {"salary": "Salary", "rental_income": "Rent", "investment_income": "Interest and dividends",
                 "income_other": "Other income", "income": "Other income"}


def _flows(txns, months: int = 12) -> list[dict]:
    """Money flow per month, as Sankey links [source, target, amount]:
    sources (salary, rent, refunds, money back from investments, or savings drawn
    down) -> "hub:in" -> the account that paid (a bank account or a card), plus
    "out:invested" and "out:saved" -> the spending category. Home-currency lines
    only. A month always balances: a shortfall shows as "src:savings", a surplus
    as "out:saved"."""
    from collections import defaultdict
    by = defaultdict(lambda: defaultdict(float))  # month -> (s, t) -> value
    for t in txns:
        if t.currency != BASE_CURRENCY:
            continue
        m, L = t.date.isoformat()[:7], by[t.date.isoformat()[:7]]
        cat = t.category or "uncategorised"
        if t.counts_as_spending and t.amount < 0:
            L[("hub:in", f"acct:{t.account_id}")] += -t.amount
            L[(f"acct:{t.account_id}", f"cat:{cat}")] += -t.amount
        elif t.kind is spending.CashFlowKind.INCOME and t.amount > 0:
            L[(f"src:{SOURCE_LABELS.get(cat, 'Other income')}", "hub:in")] += t.amount
        elif t.kind is spending.CashFlowKind.REFUND and t.amount > 0:
            L[("src:Refunds and claims", "hub:in")] += t.amount
        elif t.kind is spending.CashFlowKind.TRANSFER and cat == "investment":
            if t.amount < 0:
                L[("hub:in", "out:invested")] += -t.amount
            else:
                L[("src:From investments", "hub:in")] += t.amount
    out = []
    for m in sorted(by)[-months:]:
        L = by[m]
        inflow = sum(v for (s_, t_), v in L.items() if t_ == "hub:in")
        outflow = sum(v for (s_, t_), v in L.items() if s_ == "hub:in")
        if inflow > outflow + 0.5:
            L[("hub:in", "out:saved")] += inflow - outflow
        elif outflow > inflow + 0.5:
            L[("src:From savings", "hub:in")] += outflow - inflow
        out.append({"month": m, "inflow": round(max(inflow, outflow), 2),
                    "links": [[s_, t_, round(v, 2)] for (s_, t_), v in sorted(L.items()) if v >= 0.5]})
    return out


def _lines(txns, as_of: date, months: int = 7) -> list[dict]:
    """Every line of the last `months` months (the app's drill-down: group ->
    category -> merchant -> line). spending.summary's `recent` stops at 150."""
    y, m = as_of.year, as_of.month - (months - 1)
    while m <= 0:
        y, m = y - 1, m + 12
    start = f"{y:04d}-{m:02d}-01"
    return [{"id": t.txn_id, "date": t.date.isoformat(), "account": t.account_id, "desc": t.description,
             "merchant": spending.merchant_of(t), "amount": round(t.amount, 2), "currency": t.currency,
             "category": t.category or "", "kind": t.kind.value}
            for t in sorted(txns, key=lambda t: t.date, reverse=True) if t.date.isoformat() >= start]


def _budgets() -> dict:
    """Monthly targets for the app (finance/data/reference/budgets.json); keys starting with _ are notes."""
    p = DATA / "reference" / "budgets.json"
    try:
        return {k: v for k, v in json.loads(p.read_text()).items() if not k.startswith("_")}
    except (OSError, ValueError):
        return {}


def _through(txns) -> dict:
    """Last line date per spending account: a month after it is incomplete for that account."""
    last = {}
    for t in txns:
        last[t.account_id] = max(last.get(t.account_id, ""), t.date.isoformat())
    return dict(sorted(last.items()))


def snapshot(as_of: date | None = None) -> dict:
    as_of = as_of or date.today()
    snap = portfolio.build(DATA, as_of=as_of)
    nw = snap.net_worth or 1.0
    names = {k: getattr(a, "name", k) for k, a in snap.accounts.items()}
    positions = []
    for p in sorted(snap.positions, key=lambda p: -p.market_value_base):
        pnl = p.market_value_base - p.cost_basis_base
        positions.append({
            "id": p.instrument_id, "symbol": p.symbol, "name": p.name, "account": p.account_id, "kind": p.kind.value,
            "currency": p.currency, "qty": round(p.quantity, 6), "mark": p.mark, "value": r0(p.market_value_base),
            "local": r0(p.market_value_local), "cost": r0(p.cost_basis_base),
            "pnl": r0(pnl), "pnl_pct": round(pnl / p.cost_basis_base, 4) if p.cost_basis_base > 0 else None,
            "weight": round(p.market_value_base / nw, 4), "mark_source": p.mark_source,
        })
    cash = [{"account": a, "currency": c, "amount": r0(v), "base": r0(snap._cash_base.get((a, c), 0.0)),
             "stated": (a, c) in snap.asserted_cash} for (a, c), v in sorted(snap.cash.items()) if abs(v) > 0.005]
    txns = spending.transactions(DATA)
    rules = spending.load_rules(DATA / "reference" / "category_rules.csv") if hasattr(spending, "load_rules") else []
    categories = sorted({r.category for r in rules} | set(CATEGORIES))
    return {
        "generated_at": now_ts(), "as_of": as_of.isoformat(), "base": snap.base_currency, "tz": timezone_name(),
        "net_worth": r0(snap.net_worth), "securities": r0(snap.securities_value), "cash_total": r0(snap.cash_value),
        "margin_loans": r0(snap.margin_loans_base()),
        "history": _history(),
        "by_kind": {k: r0(v) for k, v in sorted(snap.by_kind().items(), key=lambda x: -x[1])},
        "by_currency": {k: r0(v) for k, v in sorted(snap.by_currency().items(), key=lambda x: -x[1])},
        "by_account": [{"id": k, "name": names.get(k, k), "value": r0(v)} for k, v in sorted(snap.by_account().items(), key=lambda x: -x[1])],
        "positions": positions, "cash": cash,
        "alerts": _alerts(snap, as_of),
        "spending": spending.summary(txns, months=12, today=as_of),
        "flows": _flows(txns),
        "lines": _lines(txns, as_of),
        "category_groups": CATEGORY_GROUPS,
        "accounts_through": _through(txns),
        "budgets": _budgets(),
        "recurring": recurring.build(txns, DATA / "reference", as_of, _through(txns)),
        "spend_accounts": sorted(spending.accounts(DATA)),
        "categories": categories,
    }


def seal(data: dict, devices: list[dict]) -> dict:
    out = subprocess.run(["node", str(FIN / "app" / "seal.mjs")], input=json.dumps({"devices": devices, "data": data}).encode(),
                         capture_output=True, check=False)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode().strip() or "seal failed")
    return json.loads(out.stdout)


# ------------------------------------------------------------------ app changes

def apply(items: list[dict]) -> tuple[list[str], list[str]]:
    """Apply queued app changes. Returns (printable lines, ids handled)."""
    lines, done = [], []
    for it in items:
        d = it.get("data") or {}
        if it.get("kind") == "txn_category":
            ok = spending.set_category(DATA, d["id"], d["category"])
            lines.append(f"Category {d['category']} set on {d['id']}" if ok else f"No transaction {d['id']} (already gone?)")
        else:
            lines.append(f"Skipped an unknown app change ({it.get('kind')})")
        done.append(it["id"])
    return lines, done


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("cmd", nargs="?", default="push", choices=["push", "apply", "devices", "approve", "revoke"])
    p.add_argument("id", nargs="?")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    if a.dry_run:
        s = snapshot()
        body = json.dumps(s, separators=(",", ":")).encode()
        print(f"snapshot {len(body):,} bytes · net worth {s['base']} {s['net_worth']:,.0f} · "
              f"{len(s['positions'])} positions · {len(s['alerts'])} alerts · "
              f"{len(s['spending']['months'])} spending months")
        return 0
    cfg, tok = config(), token()
    if not cfg or not tok:
        print("finance app not configured (finance/app/config.json or FINANCE_BOT_TOKEN missing); skipped")
        return 0
    if a.cmd == "devices":
        pins = {d["id"] for d in pinned()}
        for d in post(cfg, tok, "/api/devices", {"op": "devices", "ts": now_ts()})["devices"]:
            ok = fingerprint(d["pub"]) == d["id"]
            print(f"{d['id']}  {d['status']:<9}{' pinned' if d['id'] in pins else '':<8}{d.get('label', '')}"
                  f"{'' if ok else '  KEY DOES NOT MATCH ITS ID: do not approve'}")
        return 0
    if a.cmd in ("approve", "revoke"):
        if not a.id:
            print("give the device id (its fingerprint, e.g. 1a2b-3c4d-5e6f)")
            return 2
        devs = {d["id"]: d for d in post(cfg, tok, "/api/devices", {"op": "devices", "ts": now_ts()})["devices"]}
        d = devs.get(a.id)
        if a.cmd == "approve":
            if not d or fingerprint(d["pub"]) != a.id:
                print("refused: no such device, or its key doesn't match the fingerprint")
                return 1
            pins = [x for x in pinned() if x["id"] != a.id] + [{"id": a.id, "pub": d["pub"], "label": d.get("label", ""),
                                                                 "fingerprint": a.id, "approved": now_ts()}]
        else:
            pins = [x for x in pinned() if x["id"] != a.id]
        PINNED.write_text(json.dumps({"_note": "Approved device public keys (not secret). Snapshots are sealed only for these.",
                                      "devices": pins}, indent=1) + "\n")
        if d:
            post(cfg, tok, "/api/devices/set", {"op": "device", "ts": now_ts(), "id": a.id,
                                                "status": "approved" if a.cmd == "approve" else "revoked"})
        print(f"{a.cmd}d {a.id}; commit finance/app/devices.json, then run push")
        return 0
    items = post(cfg, tok, "/api/queue", {"op": "list", "ts": now_ts()}).get("items", [])
    if a.cmd == "apply":
        lines, _ = apply(items)
        for s in lines or ["Nothing new from the app."]:
            print(s)
        return 0
    devices = pinned()
    if not devices:
        print("no approved devices yet: open the app on your phone, then approve it here")
        return 0
    data = snapshot()
    sealed = seal(data, devices)
    res = post(cfg, tok, "/api/sync", {"op": "snapshot", "ts": now_ts(), "generated_at": data["generated_at"], "sealed": sealed}, 60)
    print(f"finance app updated ({res.get('bytes', 0):,} bytes, sealed for {len(devices)} device(s))")
    # App changes are acked once a push carries them (the bot ran `apply` and committed first).
    applied = {it["id"] for it in items if it.get("kind") == "txn_category"
               and any(r["txn_id"] == it["data"]["id"] and r["category"] == it["data"]["category"] for r in spending.load(DATA))}
    if applied:
        post(cfg, tok, "/api/queue/ack", {"op": "ack", "ts": now_ts(), "ids": sorted(applied)})
        print(f"cleared {len(applied)} app change(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
