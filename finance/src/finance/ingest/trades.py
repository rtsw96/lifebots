"""The trade ledger: `data/canonical/trades.csv`, one row per event.

Every trade, dividend, deposit and withdrawal is a row, added with
`finance trade` (or filed by `finance ibkr sync`). The build replays the rows
in date order into positions. To start from holdings you already have, record
each one as a BUY on the day you bought it (or on your start date, at your
average cost).

Shorts have their own types: SHORT opens or adds to a short, COVER buys it
back. A SELL beyond what is held stays an error, so a keying mistake never
silently becomes a short. On a short, dividends paid in lieu are DIVIDEND
rows with a negative amount, and borrow fees are INTEREST rows with a
negative amount.
"""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ..core.model import AssetKind, Instrument, Transaction, TxnType

FIELDS = ["date", "account_id", "instrument_id", "type", "quantity", "price",
          "amount", "currency", "fees", "name", "note"]
TYPES = {"BUY", "SELL", "SELL_ALL", "SHORT", "COVER", "DIVIDEND", "INTEREST", "FEE",
         "DEPOSIT", "WITHDRAWAL"}
def _f(value: str) -> float:
    value = (value or "").strip().replace(",", "")
    return float(value) if value else 0.0


def load(path: Path, known: Optional[Dict[str, Instrument]] = None
         ) -> Tuple[List[Transaction], Dict[str, Instrument], List[str]]:
    """Read the trade file. Returns transactions, new instruments, and problems."""
    known = known or {}
    if not path.exists():
        return [], {}, []
    txns: List[Transaction] = []
    new: Dict[str, Instrument] = {}
    problems: List[str] = []
    with path.open(newline="", encoding="utf-8") as fh:
        for n, row in enumerate(csv.DictReader(fh), start=2):
            if not (row.get("date") or "").strip():
                continue
            when = date.fromisoformat(row["date"].strip())
            kind = row["type"].strip().upper()
            iid = row["instrument_id"].strip()
            where = f"trades.csv line {n}"
            if kind not in TYPES:
                problems.append(f"{where}: unknown type '{kind}'")
                continue
            ccy = row["currency"].strip().upper()
            if iid and iid not in known and iid not in new:
                symbol, _, exchange = iid.partition("@")
                new[iid] = Instrument(instrument_id=iid, symbol=symbol,
                                      name=row.get("name", "").strip() or symbol,
                                      kind=AssetKind.LISTED, currency=ccy, exchange=exchange)
            txns.append(Transaction(
                txn_id=f"trades:{n}:{when}:{row['account_id'].strip()}:{iid}:{kind}",
                date=when, account_id=row["account_id"].strip(), instrument_id=iid,
                type=TxnType(kind), currency=ccy, quantity=_f(row.get("quantity", "")),
                price=_f(row.get("price", "")), amount=_f(row.get("amount", "")),
                fees=_f(row.get("fees", "")), note=row.get("note", "").strip(),
                source="trades.csv"))
    return txns, new, problems


def append(path: Path, row: Dict[str, str]) -> None:
    exists = path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if not exists:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in FIELDS})
