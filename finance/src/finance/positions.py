"""Stateful replay of the ledger into positions.

Order matters. `SELL_ALL` rows carry no quantity, so the only way to know what
was sold is to know what was held at that moment. That makes this an ordered
fold over the transaction list, not a row-wise transform.

Cost basis is FIFO.

Shorts are negative quantities. Their cost basis is negative too (the net
proceeds received), so market value minus cost basis is the short's
unrealised P&L without any special-casing downstream. Short lots carry the
net proceeds per unit, fees included, so a fully covered short leaves no
residue in cost basis.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Tuple

from .core.model import Position, Transaction, TxnType


@dataclass
class Lot:
    quantity: float
    price: float
    acquired: date


@dataclass
class ReplayIssue:
    severity: str          # "error" | "warning"
    code: str
    account_id: str
    instrument_id: str
    when: date
    detail: str


@dataclass
class ReplayResult:
    positions: Dict[Tuple[str, str], Position]
    cash: Dict[Tuple[str, str], float]      # (account, currency) -> balance
    issues: List[ReplayIssue] = field(default_factory=list)
    income_by_type: Dict[str, Dict[str, float]] = field(default_factory=dict)
    premium_receipts: List[Transaction] = field(default_factory=list)

    @property
    def open_positions(self) -> Dict[Tuple[str, str], Position]:
        return {k: v for k, v in self.positions.items() if v.is_open}

    @property
    def errors(self) -> List[ReplayIssue]:
        return [i for i in self.issues if i.severity == "error"]


def _consume_fifo(lots: List[Lot], quantity: float) -> float:
    """Remove `quantity` from the front of the lot queue, returning its cost."""
    remaining = quantity
    cost = 0.0
    while remaining > 1e-12 and lots:
        lot = lots[0]
        take = min(lot.quantity, remaining)
        cost += take * lot.price
        lot.quantity -= take
        remaining -= take
        if lot.quantity <= 1e-12:
            lots.pop(0)
    return cost


def replay(transactions: List[Transaction],
           assertions: Optional[List[dict]] = None) -> ReplayResult:
    """Fold the ledger into positions and cash balances.

    `assertions` are manually stated cash balances. They are applied as
    corrections *after* the flows, inserting a derived plug for the difference,
    rather than replacing the flow history. The distinction between what was
    observed and what was asserted is preserved.
    """
    positions: Dict[Tuple[str, str], Position] = {}
    lots: Dict[Tuple[str, str], List[Lot]] = defaultdict(list)
    cash: Dict[Tuple[str, str], float] = defaultdict(float)
    issues: List[ReplayIssue] = []
    income: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    premium: List[Transaction] = []

    def pos(txn: Transaction) -> Position:
        key = (txn.account_id, txn.instrument_id)
        if key not in positions:
            positions[key] = Position(account_id=txn.account_id,
                                      instrument_id=txn.instrument_id)
        return positions[key]

    for txn in sorted(transactions, key=lambda t: (t.date, t.account_id)):
        key = (txn.account_id, txn.instrument_id)

        if txn.type in (TxnType.DEPOSIT, TxnType.WITHDRAWAL):
            sign = 1.0 if txn.type is TxnType.DEPOSIT else -1.0
            cash[(txn.account_id, txn.currency)] += sign * txn.amount
            continue

        if txn.type is TxnType.BUY:
            p = pos(txn)
            if p.quantity < -1e-9:
                issues.append(ReplayIssue(
                    "error", "BUY_WHILE_SHORT", txn.account_id, txn.instrument_id,
                    txn.date, f"position is short {-p.quantity:g}; use COVER to buy it back"))
                continue
            p.quantity += txn.quantity
            p.cost_basis += txn.quantity * txn.price + txn.fees
            lots[key].append(Lot(txn.quantity, txn.price, txn.date))

        elif txn.type is TxnType.PREMIUM_INCOME:
            # Received in kind at zero stated cost. Quantity rises; cost does
            # not. Flagged so valuation can book the income properly once a
            # receipt-date price is available.
            p = pos(txn)
            p.quantity += txn.quantity
            p.unvalued_receipts += 1
            lots[key].append(Lot(txn.quantity, 0.0, txn.date))
            premium.append(txn)
            income["PREMIUM_INCOME"][txn.currency] += 0.0

        elif txn.type is TxnType.SHORT:
            p = pos(txn)
            if p.quantity > 1e-9:
                issues.append(ReplayIssue(
                    "error", "SHORT_WHILE_LONG", txn.account_id, txn.instrument_id,
                    txn.date, f"holding {p.quantity:g} long; sell it before shorting"))
                continue
            net = txn.quantity * txn.price - txn.fees
            p.quantity -= txn.quantity
            p.cost_basis -= net
            lots[key].append(Lot(txn.quantity, net / txn.quantity if txn.quantity else 0.0,
                                 txn.date))

        elif txn.type is TxnType.COVER:
            p = pos(txn)
            short = -p.quantity
            if short <= 1e-9:
                issues.append(ReplayIssue(
                    "error", "COVER_NOTHING_SHORT", txn.account_id, txn.instrument_id,
                    txn.date, "no short position to cover"))
                continue
            if txn.quantity > short + 1e-9:
                issues.append(ReplayIssue(
                    "error", "COVER_EXCEEDS_SHORT", txn.account_id, txn.instrument_id,
                    txn.date, f"covered {txn.quantity:g} but short {short:g}"))
                continue
            proceeds = _consume_fifo(lots[key], txn.quantity)
            p.realised_pnl += proceeds - (txn.quantity * txn.price + txn.fees)
            p.cost_basis += proceeds
            p.quantity += txn.quantity
            if abs(p.quantity) <= 1e-9:
                p.quantity = 0.0
                p.cost_basis = 0.0

        elif txn.type is TxnType.SELL:
            p = pos(txn)
            if p.quantity < -1e-9:
                issues.append(ReplayIssue(
                    "error", "SELL_WHILE_SHORT", txn.account_id, txn.instrument_id,
                    txn.date, f"position is already short {-p.quantity:g}; use SHORT to add"))
                continue
            if txn.quantity > p.quantity + 1e-9:
                issues.append(ReplayIssue(
                    "error", "SELL_EXCEEDS_HOLDING", txn.account_id,
                    txn.instrument_id, txn.date,
                    f"sold {txn.quantity:g} but held {p.quantity:g}"))
            cost = _consume_fifo(lots[key], min(txn.quantity, p.quantity))
            proceeds = txn.quantity * txn.price - txn.fees
            p.realised_pnl += proceeds - cost
            p.cost_basis -= cost
            p.quantity -= txn.quantity

        elif txn.type is TxnType.SELL_ALL:
            p = pos(txn)
            held = p.quantity
            if held <= 1e-9:
                detail = ("position is short; close it with COVER" if held < -1e-9
                          else "no position to close")
                issues.append(ReplayIssue(
                    "warning", "SELL_ALL_NOTHING_HELD", txn.account_id,
                    txn.instrument_id, txn.date, detail))
                continue
            if txn.quantity > 0 and abs(txn.quantity - held) > 1e-6:
                issues.append(ReplayIssue(
                    "warning", "SELL_ALL_QTY_MISMATCH", txn.account_id,
                    txn.instrument_id, txn.date,
                    f"row says {txn.quantity:g}, replay holds {held:g}"))
            cost = _consume_fifo(lots[key], held)
            p.realised_pnl += held * txn.price - cost - txn.fees
            p.cost_basis = 0.0
            p.quantity = 0.0
            lots[key].clear()

        elif txn.type is TxnType.FEE:
            # Paid in kind: reduces quantity, no proceeds.
            p = pos(txn)
            cost = _consume_fifo(lots[key], min(txn.quantity, p.quantity))
            p.cost_basis -= cost
            p.quantity -= txn.quantity
            p.realised_pnl -= cost

        elif txn.type in (TxnType.DIVIDEND, TxnType.INTEREST):
            # Deliberately does NOT credit cash. Cash moves only on explicit
            # DEPOSIT / WITHDRAWAL rows and on stated balances
            # (balance_assertions.csv, which `finance ibkr sync` writes from
            # the broker's closing cash). Crediting income here as well would
            # double-count it the moment a statement balance is recorded.
            p = pos(txn)
            p.income += txn.amount
            income[txn.type.value][txn.currency] += txn.amount

    # --- cash assertions ------------------------------------------------
    for a in assertions or []:
        akey = (a["account_id"], a["currency"])
        stated = float(a["balance"])
        observed = cash.get(akey, 0.0)
        delta = stated - observed
        if abs(delta) > 0.01:
            issues.append(ReplayIssue(
                "warning", "CASH_PLUG", a["account_id"], a["currency"],
                date.fromisoformat(a["as_of"]),
                f"asserted {stated:,.2f} vs observed {observed:,.2f}; "
                f"plugged {delta:+,.2f} -- {a.get('reason', '')}"))
        cash[akey] = stated

    for p in positions.values():
        p.lots = lots.get((p.account_id, p.instrument_id), [])

    return ReplayResult(
        positions=positions,
        cash=dict(cash),
        issues=issues,
        income_by_type={k: dict(v) for k, v in income.items()},
        premium_receipts=premium,
    )
