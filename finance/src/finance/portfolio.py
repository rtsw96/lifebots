"""Assemble the full picture: ledger + manual assets + marks -> valued snapshot."""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from .core.model import Account, AssetKind, Instrument, Ownership, Position
from .core.money import FxTable
from .ingest import trades
from .positions import ReplayIssue, ReplayResult, replay


@dataclass
class ValuedPosition:
    account_id: str
    instrument_id: str
    symbol: str
    name: str
    kind: AssetKind
    currency: str
    quantity: float
    mark: float
    market_value_local: float
    market_value_base: float
    cost_basis_local: float
    cost_basis_base: float
    mark_source: str
    unvalued_receipts: int = 0

    @property
    def is_marked(self) -> bool:
        return self.mark != 0

    @property
    def unrealised(self) -> float:
        """Gain against cost. Meaningless where there is no mark.

        An unmarked position values at zero, so this would return the whole
        cost as a loss. Callers displaying it must check `is_marked` first --
        the position is unvalued, not down 100%.
        """
        return self.market_value_base - self.cost_basis_base


@dataclass
class Snapshot:
    as_of: date
    base_currency: str
    positions: List[ValuedPosition]
    cash: Dict[Tuple[str, str], float]
    issues: List[ReplayIssue]
    income_by_type: Dict[str, Dict[str, float]]
    accounts: Dict[str, Account]
    unmarked: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def securities_value(self) -> float:
        return sum(p.market_value_base for p in self.positions)

    @property
    def cash_value(self) -> float:
        return sum(self._cash_base.values())

    @property
    def net_worth(self) -> float:
        return self.securities_value + self.cash_value

    _cash_base: Dict[Tuple[str, str], float] = field(default_factory=dict)
    # (account, currency) pairs whose balance is stated in balance_assertions.csv
    # (taken from a broker statement), as opposed to inferred from the flows.
    asserted_cash: Set[Tuple[str, str]] = field(default_factory=set)

    def unexplained_negative_cash(self) -> List[Tuple[Tuple[str, str], float]]:
        """Negative balances nobody has confirmed: usually deposits that were
        never keyed in, so they are reconciliation errors."""
        return sorted((k, v) for k, v in self.cash.items()
                      if v < -0.01 and k not in self.asserted_cash)

    def margin_loans(self) -> List[Tuple[Tuple[str, str], float]]:
        """Negative balances confirmed by a statement: real borrowing."""
        return sorted((k, v) for k, v in self.cash.items()
                      if v < -0.01 and k in self.asserted_cash)

    def margin_loans_base(self) -> float:
        return sum(self._cash_base.get(k, 0.0) for k, _ in self.margin_loans())

    def by_account(self) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for p in self.positions:
            out[p.account_id] += p.market_value_base
        for (acct, _ccy), v in self._cash_base.items():
            out[acct] += v
        return dict(out)

    def by_kind(self) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for p in self.positions:
            out[p.kind.value] += p.market_value_base
        if self._cash_base:
            out[AssetKind.CASH.value] += sum(self._cash_base.values())
        return dict(out)

    def by_currency(self) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for p in self.positions:
            out[p.currency] += p.market_value_base
        for (_acct, ccy), v in self._cash_base.items():
            out[ccy] += v
        return dict(out)


def load_accounts(path: Path) -> Dict[str, Account]:
    accounts: Dict[str, Account] = {}
    if not path.exists():
        return accounts
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            start = row["tracking_start"].strip()
            accounts[row["account_id"]] = Account(
                account_id=row["account_id"],
                name=row["name"],
                broker=row["broker"],
                ownership=Ownership(row["ownership"]),
                base_currency=row["base_currency"],
                include_in_net_worth=row["include_in_net_worth"].lower() == "true",
                tracking_start=date.fromisoformat(start) if start else None,
                note=row.get("note", ""),
            )
    return accounts


def _load_csv(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return [r for r in csv.DictReader(fh) if any(v.strip() for v in r.values())]


def build(data_dir: Path, as_of: Optional[date] = None) -> Snapshot:
    ref = data_dir / "reference"
    as_of = as_of or date.today()

    accounts = load_accounts(ref / "accounts.csv")
    fx = FxTable.from_csv(ref / "fx_rates.csv")

    # The ledger is data/canonical/trades.csv (finance trade, finance ibkr sync).
    extra, instruments, trade_problems = trades.load(data_dir / "canonical" / "trades.csv")
    extra = [t for t in extra if t.date <= as_of]

    # A balance stated on a later date is not known yet at as_of.
    assertions = [a for a in _load_csv(ref / "balance_assertions.csv")
                  if date.fromisoformat(a["as_of"]) <= as_of]
    rr: ReplayResult = replay(extra, assertions)

    marks = {m["instrument_id"]: m for m in _load_csv(ref / "marks.csv")}

    notes: List[str] = list(trade_problems)
    unmarked: List[str] = []
    valued: List[ValuedPosition] = []

    # Identity corrections: a new name in trades.csv arrives as LISTED, so a
    # private fund, bond or crypto wallet gets its kind (and a clearer name)
    # from instrument_overrides.csv.
    for row in _load_csv(ref / "instrument_overrides.csv"):
        iid = row["instrument_id"]
        if iid not in instruments:
            notes.append(f"instrument_overrides references unknown instrument '{iid}'")
            continue
        inst = instruments[iid]
        instruments[iid] = Instrument(
            instrument_id=inst.instrument_id,
            symbol=inst.symbol,
            name=row.get("name") or inst.name,
            kind=AssetKind(row["kind"]) if row.get("kind") else inst.kind,
            currency=inst.currency,
            exchange=inst.exchange,
            isin=inst.isin,
            maturity=inst.maturity,
        )

    for (acct_id, iid), pos in sorted(rr.open_positions.items()):
        inst = instruments[iid]
        acct = accounts.get(acct_id)
        if acct is None:
            notes.append(f"Account '{acct_id}' appears in trades.csv but not in accounts.csv")
            continue
        if not acct.include_in_net_worth:
            continue

        override = marks.get(iid)
        if override:
            mark = float(override["mark"])
            mark_ccy = override["currency"]
            mark_source = override["source"]
        else:
            mark, mark_ccy, mark_source = 0.0, inst.currency, "none"

        if mark == 0.0:
            unmarked.append(f"{acct_id}/{inst.symbol}")

        mv_local = pos.quantity * mark
        try:
            mv_base = fx.to_base(mv_local, mark_ccy)
            cost_base = fx.to_base(pos.cost_basis, inst.currency)
        except Exception as exc:  # missing rate
            notes.append(f"FX unavailable for {inst.symbol}: {exc} (add a row to reference/fx_rates.csv)")
            continue

        valued.append(ValuedPosition(
            account_id=acct_id,
            instrument_id=iid,
            symbol=inst.symbol,
            name=inst.name,
            kind=inst.kind,
            currency=mark_ccy,
            quantity=pos.quantity,
            mark=mark,
            market_value_local=mv_local,
            market_value_base=mv_base,
            cost_basis_local=pos.cost_basis,
            cost_basis_base=cost_base,
            mark_source=mark_source,
            unvalued_receipts=pos.unvalued_receipts,
        ))

    # --- manual assets: holdings with no trades (property, a private fund) --
    for row in _load_csv(ref / "manual_assets.csv"):
        iid = row["instrument_id"]
        acct_id = row["account_id"]
        if acct_id not in accounts:
            notes.append(f"Manual asset '{iid}' references unknown account '{acct_id}'")
            continue
        qty = float(row["quantity"])
        override = marks.get(iid)
        mark = float(override["mark"]) if override else float(row["cost_per_unit"])
        mark_ccy = override["currency"] if override else row["currency"]
        cost = qty * float(row["cost_per_unit"])
        try:
            mv_base, cost_base = fx.to_base(qty * mark, mark_ccy), fx.to_base(cost, row["currency"])
        except Exception as exc:  # missing rate
            notes.append(f"FX unavailable for {iid}: {exc}")
            continue
        valued.append(ValuedPosition(
            account_id=acct_id,
            instrument_id=iid,
            symbol=row["symbol"],
            name=row["name"],
            kind=AssetKind(row["kind"]),
            currency=mark_ccy,
            quantity=qty,
            mark=mark,
            market_value_local=qty * mark,
            market_value_base=mv_base,
            cost_basis_local=cost,
            cost_basis_base=cost_base,
            mark_source=override["source"] if override else "manual_assets",
        ))

    cash_base: Dict[Tuple[str, str], float] = {}
    for (acct_id, ccy), bal in rr.cash.items():
        if abs(bal) < 0.01:
            continue
        acct = accounts.get(acct_id)
        if acct and not acct.include_in_net_worth:
            continue
        try:
            cash_base[(acct_id, ccy)] = fx.to_base(bal, ccy)
        except Exception as exc:  # missing rate: say so, never crash the whole book
            notes.append(f"FX unavailable for {acct_id} {ccy} cash: {exc} (add a row to reference/fx_rates.csv)")

    snap = Snapshot(
        as_of=as_of,
        base_currency=fx.base,
        positions=sorted(valued, key=lambda p: -p.market_value_base),
        cash=rr.cash,
        issues=rr.issues,
        income_by_type=rr.income_by_type,
        accounts=accounts,
        unmarked=unmarked,
        notes=notes,
    )
    snap._cash_base = cash_base
    snap.asserted_cash = {(a["account_id"], a["currency"]) for a in assertions}

    if rr.premium_receipts:
        total = len(rr.premium_receipts)
        snap.notes.append(
            f"{total} in-kind premium receipts are booked at zero cost. "
            "Income is understated and future capital gains overstated until "
            "they are valued at receipt-date prices.")
    return snap
