"""Deterministic expense categorisation.

Categorisation must be reproducible. If re-running last March reshuffles
March's categories, the history is worthless for any trend. So this is a
version-controlled rules file matched in priority order -- never a live model
call at report time.

That does not mean the rules have to be written by hand. `unmatched_merchants`
surfaces what has no rule yet, grouped and ranked by spend, so a model (or a
person) can write rules for the ones that matter. The output of that work is
new rows in the rules file: inspectable, diffable, and identical on every
subsequent run.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .core.model import CashFlowKind, CashTransaction


@dataclass
class Rule:
    pattern: str
    category: str
    kind: CashFlowKind
    merchant: str = ""
    priority: int = 100
    _compiled: Optional[re.Pattern] = None

    def __post_init__(self) -> None:
        self._compiled = re.compile(self.pattern, re.IGNORECASE)

    def matches(self, description: str) -> bool:
        return bool(self._compiled and self._compiled.search(description))


def load_rules(path: Path) -> List[Rule]:
    if not path.exists():
        return []
    rules: List[Rule] = []
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if not row.get("pattern"):
                continue
            rules.append(Rule(
                pattern=row["pattern"].strip(),
                category=row["category"].strip(),
                kind=CashFlowKind(row.get("kind", "EXPENSE").strip() or "EXPENSE"),
                merchant=row.get("merchant", "").strip(),
                priority=int(row.get("priority", 100) or 100),
            ))
    # Lower priority number wins, so a specific rule can be placed ahead of a
    # broad one without depending on file order.
    rules.sort(key=lambda r: r.priority)
    return rules


def apply_rules(transactions: Sequence[CashTransaction],
                rules: Sequence[Rule]) -> List[CashTransaction]:
    """Categorise, leaving already-classified transfers alone.

    Transfer detection runs before this and is more reliable than pattern
    matching, so it is never overridden here.
    """
    from dataclasses import replace

    out: List[CashTransaction] = []
    for txn in transactions:
        if txn.kind is CashFlowKind.TRANSFER:
            out.append(txn)
            continue
        matched = next((r for r in rules if r.matches(txn.description)), None)
        if matched is None:
            out.append(txn)
            continue
        out.append(replace(
            txn,
            kind=matched.kind,
            category=matched.category,
            merchant=matched.merchant or txn.merchant,
        ))
    return out


def unmatched_merchants(transactions: Sequence[CashTransaction],
                        rules: Sequence[Rule],
                        limit: int = 40) -> List[Tuple[str, int, float]]:
    """Descriptions with no rule, ranked by absolute spend.

    Ranked by money rather than count so the effort of writing rules goes
    where it changes the numbers.
    """
    totals: Dict[str, float] = defaultdict(float)
    counts: Dict[str, int] = defaultdict(int)
    for txn in transactions:
        if txn.kind is CashFlowKind.TRANSFER:
            continue
        if any(r.matches(txn.description) for r in rules):
            continue
        key = _normalise(txn.description)
        totals[key] += abs(txn.amount)
        counts[key] += 1
    ranked = sorted(totals.items(), key=lambda item: -item[1])
    return [(desc, counts[desc], total) for desc, total in ranked[:limit]]


def _normalise(description: str) -> str:
    """Strip the variable parts of a merchant string.

    Card descriptors carry reference numbers, dates and store ids that differ
    per transaction; without stripping them every purchase looks like a new
    merchant and nothing ever groups.
    """
    text = description.upper()
    text = re.sub(r"\b\d{2}[/-]\d{2}([/-]\d{2,4})?\b", " ", text)  # dates
    text = re.sub(r"\b\d{6,}\b", " ", text)                        # long refs
    text = re.sub(r"\b[A-Z]{2}\d{4,}\b", " ", text)                # mixed refs
    text = re.sub(r"[^A-Z0-9 &.-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def spend_by_category(transactions: Iterable[CashTransaction]) -> Dict[str, float]:
    """Total expenditure per category. Transfers are excluded by definition."""
    out: Dict[str, float] = defaultdict(float)
    for txn in transactions:
        if txn.counts_as_spending:
            out[txn.category or "uncategorised"] += -txn.amount
    return dict(out)


def coverage(transactions: Sequence[CashTransaction]) -> Tuple[float, float]:
    """(categorised share by value, by count) across non-transfer outflows."""
    spend = [t for t in transactions
             if t.kind is not CashFlowKind.TRANSFER and t.amount < 0]
    if not spend:
        return 1.0, 1.0
    total = sum(abs(t.amount) for t in spend)
    done = sum(abs(t.amount) for t in spend if t.category)
    by_count = sum(1 for t in spend if t.category) / len(spend)
    return (done / total if total else 1.0), by_count
