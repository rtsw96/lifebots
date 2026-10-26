"""Matching movements between your own accounts.

Two jobs, and the first one is the single most common way a DIY finance
tracker produces nonsense.

**Card payments.** A card statement shows a $200 dinner. The bank statement
shows a $3,000 payment to the card. Counting both makes expenditure meaningless
-- once as the charge, again as the payment. The fix is structural: the card is
a liability account, its payment is a TRANSFER between two of your accounts,
and only the underlying charges are expenditure.

**Bank to broker.** Matching these reconstructs the deposit history the
portfolio side is missing, which is what makes a savings rate computable and
repairs the portfolio module's one structural gap -- prospectively, from the
point statements start.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import timedelta
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .core.model import CashFlowKind, CashTransaction


@dataclass
class TransferMatch:
    outflow: CashTransaction
    inflow: CashTransaction
    day_gap: int
    amount: float
    confidence: str  # "exact" | "near"

    @property
    def describe(self) -> str:
        return (f"{self.outflow.account_id} -> {self.inflow.account_id} "
                f"{self.amount:,.2f} {self.outflow.currency} "
                f"({self.day_gap}d, {self.confidence})")


def match_transfers(transactions: Sequence[CashTransaction],
                    window_days: int = 5,
                    tolerance: float = 0.01) -> Tuple[List[TransferMatch],
                                                      List[CashTransaction]]:
    """Pair each outflow with a matching inflow in another account.

    Matching is greedy over the smallest day gap first, so when several
    candidates fit the closest pairing wins. A transaction can be used once.

    Returns the matches and the full transaction list with both legs of every
    match retyped as TRANSFER.
    """
    matches: List[TransferMatch] = []
    used: Set[str] = set()

    outflows = sorted((t for t in transactions if t.amount < 0),
                      key=lambda t: t.date)
    inflows = [t for t in transactions if t.amount > 0]

    candidates: List[Tuple[int, CashTransaction, CashTransaction]] = []
    for out in outflows:
        for inn in inflows:
            if inn.account_id == out.account_id:
                continue
            if inn.currency != out.currency:
                continue
            if abs(abs(out.amount) - inn.amount) > tolerance:
                continue
            gap = abs((inn.date - out.date).days)
            if gap > window_days:
                continue
            candidates.append((gap, out, inn))

    for gap, out, inn in sorted(candidates, key=lambda c: c[0]):
        if out.txn_id in used or inn.txn_id in used:
            continue
        used.add(out.txn_id)
        used.add(inn.txn_id)
        matches.append(TransferMatch(
            outflow=out, inflow=inn, day_gap=gap,
            amount=abs(out.amount),
            confidence="exact" if gap == 0 else "near",
        ))

    updated: List[CashTransaction] = []
    partner: Dict[str, str] = {}
    for m in matches:
        partner[m.outflow.txn_id] = m.inflow.account_id
        partner[m.inflow.txn_id] = m.outflow.account_id
    for txn in transactions:
        if txn.txn_id in partner:
            updated.append(replace(txn, kind=CashFlowKind.TRANSFER,
                                   counterparty_account=partner[txn.txn_id]))
        else:
            updated.append(txn)
    return matches, updated


def mark_card_payments(transactions: Sequence[CashTransaction],
                       liability_accounts: Set[str]) -> List[CashTransaction]:
    """Retype inflows to a card account as transfers.

    A payment arriving at a credit card is never income. Even where the paying
    side is unknown -- the bank statement is missing, or the payment came from
    an account not tracked -- it must not be counted as money earned.
    """
    out: List[CashTransaction] = []
    for txn in transactions:
        if (txn.account_id in liability_accounts
                and txn.amount > 0
                and txn.kind is not CashFlowKind.REFUND):
            out.append(replace(txn, kind=CashFlowKind.TRANSFER,
                               category=txn.category or "card_payment"))
        else:
            out.append(txn)
    return out


def broker_deposits(matches: Sequence[TransferMatch],
                    broker_accounts: Set[str]) -> List[TransferMatch]:
    """Transfers whose destination is an investment account.

    These are the deposit records the portfolio ledger lacks.
    """
    return [m for m in matches if m.inflow.account_id in broker_accounts]


def savings_rate(transactions: Sequence[CashTransaction],
                 ) -> Optional[Tuple[float, float, float]]:
    """(income, expenditure, rate) over the supplied transactions.

    Transfers are excluded from both sides -- moving your own money between
    accounts is neither earning nor spending, and including it is the fastest
    way to compute a savings rate above 100%.
    """
    income = sum(t.amount for t in transactions
                 if t.kind is CashFlowKind.INCOME and t.amount > 0)
    spend = sum(-t.amount for t in transactions if t.counts_as_spending)
    if income <= 0:
        return None
    return income, spend, (income - spend) / income
