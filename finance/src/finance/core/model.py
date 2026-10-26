"""Canonical data model.

The single most important rule in this file: `quantity` and `amount` are
different things and are never stored in the same field.

Broker exports often overload one column for both (a share count on buy and
sell rows, a cash amount on dividend rows). Any such ambiguity is resolved at
the ingest boundary and never propagates past it, so nothing downstream has
to know or care.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Optional


class TxnType(str, Enum):
    """Canonical transaction types."""

    BUY = "BUY"
    SELL = "SELL"
    SELL_ALL = "SELL_ALL"          # quantity is implied: the full remaining position
    SHORT = "SHORT"                # sell short: opens or adds to a negative position
    COVER = "COVER"                # buy to cover: reduces a short
    DIVIDEND = "DIVIDEND"
    INTEREST = "INTEREST"
    PREMIUM_INCOME = "PREMIUM_INCOME"  # option premium received, often in kind
    FEE = "FEE"
    DEPOSIT = "DEPOSIT"            # external cash in
    WITHDRAWAL = "WITHDRAWAL"      # external cash out
    BALANCE_ASSERT = "BALANCE_ASSERT"  # "balance was X on date D" -- not a flow

    @property
    def is_income(self) -> bool:
        return self in (TxnType.DIVIDEND, TxnType.INTEREST, TxnType.PREMIUM_INCOME)

    @property
    def moves_quantity(self) -> bool:
        """Whether this type changes the share/unit count of a position."""
        return self in (TxnType.BUY, TxnType.SELL, TxnType.SELL_ALL, TxnType.SHORT,
                        TxnType.COVER, TxnType.PREMIUM_INCOME)


class AssetKind(str, Enum):
    """What sort of thing an instrument is.

    Drives marking, grouping and whether a market price even exists. Many
    holdings have no ISIN -- property, a private fund, private credit and
    crypto wallets -- which is why identity is a synthetic instrument_id
    (SYMBOL@EXCHANGE) rather than ISIN.
    """

    LISTED = "LISTED"              # equities and ETFs
    BOND = "BOND"
    PRIVATE_FUND = "PRIVATE_FUND"
    PRIVATE_CREDIT = "PRIVATE_CREDIT"
    PROPERTY = "PROPERTY"
    CRYPTO = "CRYPTO"
    CASH = "CASH"

    @property
    def is_marked_manually(self) -> bool:
        """True where no market feed exists and the mark is hand-maintained."""
        return self in (
            AssetKind.PRIVATE_FUND,
            AssetKind.PRIVATE_CREDIT,
            AssetKind.PROPERTY,
        )


class Ownership(str, Enum):
    SELF = "SELF"      # wholly yours
    FAMILY = "FAMILY"  # family member's account you track
    JOINT = "JOINT"    # shared, held via a fractional stake


@dataclass(frozen=True)
class Account:
    account_id: str
    name: str
    broker: str
    ownership: Ownership
    base_currency: str
    include_in_net_worth: bool
    # Entries before this date are migration snapshots, not real history.
    # Performance for this account is only meaningful from here onward.
    tracking_start: Optional[date] = None
    note: str = ""


@dataclass(frozen=True)
class Instrument:
    instrument_id: str
    symbol: str
    name: str
    kind: AssetKind
    currency: str
    exchange: str = ""
    isin: Optional[str] = None
    # PRIVATE_CREDIT / BOND only
    maturity: Optional[date] = None


@dataclass(frozen=True)
class Transaction:
    """One ledger event.

    `quantity` is units of the instrument. `amount` is cash in `currency`.
    Income rows carry `amount` and (for in-kind premium) also `quantity`.
    Trade rows carry `quantity` and `price`.
    """

    txn_id: str
    date: date
    account_id: str
    instrument_id: str
    type: TxnType
    currency: str
    quantity: float = 0.0
    price: float = 0.0
    amount: float = 0.0
    fees: float = 0.0
    fx_rate: Optional[float] = None
    note: str = ""
    source: str = ""
    # True where this row was inferred rather than observed in a source file
    # (e.g. a plug inserted to satisfy a balance assertion).
    derived: bool = False

    @property
    def gross_amount(self) -> float:
        """Cash value of the event in its own currency."""
        if self.type.is_income:
            return self.amount
        return self.quantity * self.price


class CashFlowKind(str, Enum):
    """What a bank or card line actually represents."""

    EXPENSE = "EXPENSE"
    INCOME = "INCOME"
    TRANSFER = "TRANSFER"    # between your own accounts; never an expense
    REFUND = "REFUND"
    FEE = "FEE"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class CashTransaction:
    """One line from a bank or credit card statement.

    Shares the account spine with `Transaction` but not its shape: an expense
    has a merchant and a category, not a quantity and a price. Keeping them as
    separate types means neither carries columns that are meaningless for it.

    `is_liability_account` is what stops card spend being double-counted. A
    card charge and the bank's payment of that card are the same money; the
    payment is a TRANSFER between two of your accounts, and only the
    underlying charge is expenditure.
    """

    txn_id: str
    date: date
    account_id: str
    description: str
    amount: float           # negative = money out
    currency: str
    kind: CashFlowKind = CashFlowKind.UNKNOWN
    category: str = ""
    merchant: str = ""
    counterparty_account: Optional[str] = None  # set when matched as a transfer
    fx_rate: Optional[float] = None
    source: str = ""
    note: str = ""

    @property
    def is_outflow(self) -> bool:
        return self.amount < 0

    @property
    def counts_as_spending(self) -> bool:
        return self.kind is CashFlowKind.EXPENSE and self.amount < 0


@dataclass
class Position:
    account_id: str
    instrument_id: str
    quantity: float = 0.0
    cost_basis: float = 0.0  # in the instrument's own currency
    realised_pnl: float = 0.0
    income: float = 0.0
    # Receipts booked at zero cost whose value has not been established.
    unvalued_receipts: int = 0
    lots: list = field(default_factory=list)

    @property
    def average_cost(self) -> float:
        return self.cost_basis / self.quantity if self.quantity else 0.0

    @property
    def is_open(self) -> bool:
        return abs(self.quantity) > 1e-9
