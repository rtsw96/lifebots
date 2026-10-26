"""The transaction ledger: bank and card lines, kept without the statements.

Statements carry account and card numbers, so they are never stored. The
finance bot reads each statement (a CSV through `statement_formats.json`, or a
PDF it extracts itself), writes the lines here, and deletes the file. What is
kept per line: date, account alias, description (long digit runs masked),
signed amount, currency, and an optional manual category.

`data/canonical/transactions.csv` is the record.

Sign convention: negative is money out, whatever the statement did.
"""

from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from dataclasses import replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .categorise import apply_rules, load_rules, unmatched_merchants, _normalise
from .core.model import CashFlowKind, CashTransaction
from .core.money import BASE_CURRENCY
from .ingest.banking import _txn_id, dedupe, ingest_statement, load_formats
from .transfers import mark_card_payments, match_transfers

FIELDS = ["txn_id", "date", "account_id", "description", "amount", "currency",
          "category", "merchant", "note", "source", "imported_at"]

# What never reaches the ledger. Statements put identity numbers inside
# references (an ID number in a tax or insurer reference, a phone number in an
# e-wallet top-up), so masking runs over the whole description:
#   Singapore NRIC/FIN                    -> [ID]
#   IBKR account (U1234567, U12345678)    -> [acct]
#   Singapore vehicle plates (SLV1234T)   -> [plate]
#   unit numbers (#02-01)                 -> #[unit]
#   8+ digits, spaces or dashes allowed   -> x + last four (enough to tell two
#     cards apart); fully masked when glued to a letter, as in a reference
#     that ends in an NRIC check letter.
_NRIC = re.compile(r"(?<![A-Za-z0-9])[STFGM]\d{7}[A-Z](?![A-Za-z0-9])")
_IBKR = re.compile(r"(?<![A-Za-z0-9])U\d{7,8}(?![A-Za-z0-9])")
_PLATE = re.compile(r"(?<![A-Za-z0-9])S[A-HJ-NP-Z]{1,2}\d{1,4}[A-HJ-NP-Z](?![A-Za-z0-9])")
_UNIT = re.compile(r"#\s?\d{1,2}\s?-\s?\d{1,4}\b")
_LONG_DIGITS = re.compile(r"(?<!\d)(?:\d[ -]?){7,}\d(?!\d)")


def redact(text: str) -> str:
    def mask(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        after = m.string[m.end():m.end() + 1]
        return "x" if after.isalpha() else f"x{digits[-4:]}"
    text = _NRIC.sub("[ID]", text or "")
    text = _IBKR.sub("[acct]", text)
    text = _PLATE.sub("[plate]", text)
    text = _UNIT.sub("#[unit]", text)
    return _LONG_DIGITS.sub(mask, text)


def ledger_path(data: Path) -> Path:
    return data / "canonical" / "transactions.csv"


def accounts(data: Path) -> Dict[str, dict]:
    """Spending accounts (bank, card, wallet), by alias. No numbers kept."""
    p = data / "reference" / "spend_accounts.csv"
    if not p.exists():
        return {}
    with p.open(newline="", encoding="utf-8") as fh:
        return {r["account_id"]: r for r in csv.DictReader(fh)}


def load(data: Path) -> List[dict]:
    p = ledger_path(data)
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def save(data: Path, rows: List[dict]) -> None:
    p = ledger_path(data)
    p.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (r["date"], r["account_id"], r["description"]))
    tmp = p.with_suffix(".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    tmp.rename(p)


def _row(txn: CashTransaction, source: str, now: str) -> dict:
    return {"txn_id": txn.txn_id, "date": txn.date.isoformat(), "account_id": txn.account_id,
            "description": redact(txn.description), "amount": f"{txn.amount:.2f}",
            "currency": txn.currency, "category": "", "merchant": "", "note": "",
            "source": source, "imported_at": now}


def parse_lines(lines: Sequence[dict], account: str, currency: Optional[str] = None) -> List[CashTransaction]:
    """Lines extracted from a statement: [{date, description, amount, currency?}].

    `amount` must already be signed (negative = money out). The occurrence index
    keeps two identical purchases on one day apart while a re-import of the same
    statement matches the first import exactly.
    """
    out: List[CashTransaction] = []
    seen: Dict[str, int] = {}
    for i, ln in enumerate(lines):
        try:
            when = date.fromisoformat(str(ln["date"])[:10])
            amount = round(float(ln["amount"]), 2)
        except (KeyError, ValueError, TypeError) as e:
            raise ValueError(f"line {i + 1}: needs date (YYYY-MM-DD) and a signed amount ({e})")
        desc = re.sub(r"\s+", " ", redact(str(ln.get("description", "")))).strip()
        if not desc:
            raise ValueError(f"line {i + 1}: no description")
        cur = (ln.get("currency") or currency or BASE_CURRENCY).upper()
        key = f"{when}|{desc}|{amount:.2f}"
        seen[key] = seen.get(key, 0) + 1
        out.append(CashTransaction(txn_id=_txn_id(account, when, desc, amount, seen[key]), date=when,
                                   account_id=account, description=desc, amount=amount, currency=cur))
    return out


def add(data: Path, txns: Iterable[CashTransaction], source: str) -> Tuple[int, int]:
    """Append new lines to the ledger. Returns (added, already there)."""
    rows = load(data)
    have = {r["txn_id"] for r in rows}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    added = skipped = 0
    for t in txns:
        if t.txn_id in have:
            skipped += 1
            continue
        rows.append(_row(t, source, now))
        have.add(t.txn_id)
        added += 1
    if added:
        save(data, rows)
    return added, skipped


def import_json(data: Path, path: Path, account: str, currency: Optional[str] = None, source: str = "") -> Tuple[int, int]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    lines = raw["lines"] if isinstance(raw, dict) else raw
    return add(data, parse_lines(lines, account, currency), source or f"statement:{account}")


def import_csv(data: Path, path: Path, fmt_name: str) -> Tuple[int, int]:
    fmt = load_formats(data / "reference" / "statement_formats.json").get(fmt_name)
    if fmt is None:
        raise ValueError(f"no statement format named {fmt_name!r}")
    return add(data, ingest_statement(path, fmt), f"{fmt_name}")


def set_category(data: Path, txn_id: str, category: str, merchant: str = "") -> bool:
    rows = load(data)
    hit = next((r for r in rows if r["txn_id"] == txn_id), None)
    if hit is None:
        return False
    hit["category"] = category
    if merchant:
        hit["merchant"] = merchant
    save(data, rows)
    return True


def transactions(data: Path) -> List[CashTransaction]:
    """Everything in the ledger, with transfers
    matched, card payments retyped and rules applied. Manual categories win."""
    txns: List[CashTransaction] = []
    manual: Dict[str, Tuple[str, str]] = {}
    for r in load(data):
        t = CashTransaction(txn_id=r["txn_id"], date=date.fromisoformat(r["date"]), account_id=r["account_id"],
                            description=r["description"], amount=float(r["amount"]), currency=r["currency"],
                            source=r.get("source", ""), note=r.get("note", ""))
        txns.append(t)
        if r.get("category"):
            manual[t.txn_id] = (r["category"], r.get("merchant", ""))
    txns = dedupe(txns)
    _, txns = match_transfers(txns)
    cards = {a for a, r in accounts(data).items() if r.get("kind") == "card"}
    txns = mark_card_payments(txns, cards)
    txns = apply_rules(txns, load_rules(data / "reference" / "category_rules.csv"))
    out = []
    for t in txns:
        if t.txn_id in manual:
            cat, merch = manual[t.txn_id]
            kind = CashFlowKind.INCOME if cat in INCOME_CATS else \
                CashFlowKind.TRANSFER if cat in TRANSFER_CATS else \
                CashFlowKind.REFUND if cat in REFUND_CATS else CashFlowKind.EXPENSE
            t = replace(t, category=cat, merchant=merch or t.merchant, kind=kind)
        out.append(t)
    return sorted(out, key=lambda t: (t.date, t.account_id))


INCOME_CATS = {"salary", "investment_income", "rental_income", "income_other", "income"}
TRANSFER_CATS = {"transfer", "card_payment", "investment", "own_transfer", "loan"}
REFUND_CATS = {"refund", "reimbursement"}


def merchant_of(t: CashTransaction) -> str:
    if t.merchant:
        return t.merchant
    words = _normalise(t.description).split()
    return " ".join(words[:3]).title() or "?"


def summary(txns: Sequence[CashTransaction], months: int = 12, today: Optional[date] = None) -> dict:
    """Per month: spend by category, income, savings rate, top merchants.
    Plus the recent lines. Only home-currency lines are summed; others are listed
    (a foreign purchase on a card is filed at the amount the card charged)."""
    today = today or date.today()
    by_month: Dict[str, dict] = defaultdict(lambda: {"spend": 0.0, "income": 0.0, "categories": defaultdict(float),
                                                     "merchants": defaultdict(float), "lines": 0,
                                                     "unclassified_out": 0.0, "unclassified_in": 0.0})
    for t in txns:
        m = t.date.isoformat()[:7]
        b = by_month[m]
        b["lines"] += 1
        if t.currency != BASE_CURRENCY:
            continue
        if t.counts_as_spending:
            b["spend"] += -t.amount
            b["categories"][t.category or "uncategorised"] += -t.amount
            b["merchants"][merchant_of(t)] += -t.amount
        elif t.kind is CashFlowKind.REFUND and t.amount > 0:
            b["spend"] -= t.amount
            b["categories"][t.category or "uncategorised"] -= t.amount
        elif t.kind is CashFlowKind.INCOME and t.amount > 0:
            b["income"] += t.amount
        elif t.kind is CashFlowKind.UNKNOWN:
            # No rule and no manual category: shown apart, never silently dropped.
            b["unclassified_out" if t.amount < 0 else "unclassified_in"] += abs(t.amount)
    keys = sorted(by_month)[-months:]
    out_months = []
    for m in keys:
        b = by_month[m]
        out_months.append({
            "month": m, "spend": round(b["spend"], 2), "income": round(b["income"], 2),
            "savings_rate": round((b["income"] - b["spend"]) / b["income"], 3) if b["income"] > 0 else None,
            "categories": {k: round(v, 2) for k, v in sorted(b["categories"].items(), key=lambda x: -x[1])},
            "merchants": [[k, round(v, 2)] for k, v in sorted(b["merchants"].items(), key=lambda x: -x[1])[:10]],
            "lines": b["lines"],
            "unclassified_out": round(b["unclassified_out"], 2), "unclassified_in": round(b["unclassified_in"], 2),
        })
    recent = [{"id": t.txn_id, "date": t.date.isoformat(), "account": t.account_id, "desc": t.description,
               "merchant": merchant_of(t), "amount": t.amount, "currency": t.currency,
               "category": t.category or "", "kind": t.kind.value}
              for t in sorted(txns, key=lambda t: t.date, reverse=True)[:150]]
    outflows = [t for t in txns if t.amount < 0 and t.kind is not CashFlowKind.TRANSFER]
    done = sum(-t.amount for t in outflows if t.category)
    total = sum(-t.amount for t in outflows)
    return {"months": out_months, "recent": recent,
            "coverage": round(done / total, 3) if total else 1.0,
            "first": txns[0].date.isoformat() if txns else None,
            "last": txns[-1].date.isoformat() if txns else None}


def unmatched(data: Path, txns: Sequence[CashTransaction], limit: int = 15):
    return unmatched_merchants([t for t in txns if not t.category], load_rules(data / "reference" / "category_rules.csv"), limit)
