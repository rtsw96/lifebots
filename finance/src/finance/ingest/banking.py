"""Bank and credit card statement ingest.

Banks are considerably worse than brokers at this. Column names, date formats
and sign conventions all differ, and many banks issue PDF-only statements. So a new bank is a config entry, not a code change: the shape of
each format lives in `reference/statement_formats.json`.

Sign convention is normalised on the way in -- negative is always money out,
whatever the source did.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from ..core.model import CashFlowKind, CashTransaction
from ..core.money import BASE_CURRENCY


@dataclass
class StatementFormat:
    """How to read one bank's export."""

    name: str
    account_id: str
    date_column: str
    date_formats: List[str]
    description_columns: List[str]
    currency: str
    amount_column: Optional[str] = None      # single signed column
    debit_column: Optional[str] = None       # or separate debit/credit
    credit_column: Optional[str] = None
    debit_is_positive: bool = True           # debits written unsigned
    skip_rows: int = 0
    encoding: str = "utf-8-sig"

    @classmethod
    def from_dict(cls, name: str, raw: dict) -> "StatementFormat":
        return cls(
            name=name,
            account_id=raw["account_id"],
            date_column=raw["date_column"],
            date_formats=raw.get("date_formats", ["%Y-%m-%d"]),
            description_columns=raw.get("description_columns", []),
            currency=raw.get("currency") or BASE_CURRENCY,
            amount_column=raw.get("amount_column"),
            debit_column=raw.get("debit_column"),
            credit_column=raw.get("credit_column"),
            debit_is_positive=raw.get("debit_is_positive", True),
            skip_rows=raw.get("skip_rows", 0),
            encoding=raw.get("encoding", "utf-8-sig"),
        )


def load_formats(path: Path) -> Dict[str, StatementFormat]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    # Keys starting with "_" are documentation, not formats.
    return {name: StatementFormat.from_dict(name, cfg)
            for name, cfg in raw.items()
            if not name.startswith("_") and isinstance(cfg, dict)}


def _parse_date(value: str, formats: Iterable[str]) -> Optional[date]:
    value = (value or "").strip()
    if not value:
        return None
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _num(value: str) -> float:
    """Statements use thousands separators, currency symbols and (123) for
    negatives."""
    text = (value or "").strip()
    if not text:
        return 0.0
    negative = text.startswith("(") and text.endswith(")")
    text = re.sub(r"[^0-9.\-]", "", text)
    if not text or text in ("-", "."):
        return 0.0
    amount = float(text)
    return -amount if negative else amount


def _txn_id(account: str, when: date, description: str,
            amount: float, seq: int) -> str:
    raw = f"{account}|{when.isoformat()}|{description}|{amount:.2f}|{seq}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def ingest_statement(path: Path, fmt: StatementFormat) -> List[CashTransaction]:
    """Read one statement file into normalised cash transactions.

    Ingest is idempotent by content hash with an occurrence index: statements
    restate, and the same file re-imported must not duplicate rows, while two
    genuinely identical purchases on one day must both survive.
    """
    text = path.read_text(encoding=fmt.encoding)
    lines = text.splitlines()[fmt.skip_rows:]
    reader = csv.DictReader(lines)
    out: List[CashTransaction] = []
    seen: Dict[str, int] = {}

    for row in reader:
        clean = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        when = _parse_date(clean.get(fmt.date_column, ""), fmt.date_formats)
        if when is None:
            continue

        description = " ".join(
            clean.get(col, "") for col in fmt.description_columns
        ).strip()
        description = re.sub(r"\s+", " ", description)

        if fmt.amount_column:
            amount = _num(clean.get(fmt.amount_column, ""))
        else:
            debit = _num(clean.get(fmt.debit_column or "", ""))
            credit = _num(clean.get(fmt.credit_column or "", ""))
            if fmt.debit_is_positive:
                debit = -abs(debit) if debit else 0.0
            amount = debit + abs(credit)

        if amount == 0.0 and not description:
            continue

        key = f"{when}|{description}|{amount:.2f}"
        seen[key] = seen.get(key, 0) + 1
        out.append(CashTransaction(
            txn_id=_txn_id(fmt.account_id, when, description, amount, seen[key]),
            date=when,
            account_id=fmt.account_id,
            description=description,
            amount=amount,
            currency=fmt.currency,
            kind=CashFlowKind.UNKNOWN,
            source=f"{fmt.name}:{path.name}",
        ))

    out.sort(key=lambda t: (t.date, t.description))
    return out


def dedupe(transactions: Iterable[CashTransaction]) -> List[CashTransaction]:
    """Drop rows already seen, keyed on the content hash."""
    seen: set[str] = set()
    out: List[CashTransaction] = []
    for txn in transactions:
        if txn.txn_id in seen:
            continue
        seen.add(txn.txn_id)
        out.append(txn)
    return out
