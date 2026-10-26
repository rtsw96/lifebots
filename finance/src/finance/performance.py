"""Time-weighted return, per-position IRR, and FX attribution.

Money-weighted return at portfolio level is deliberately absent. It needs a
complete external funding history, which the ledger may not contain --
deposits are often never recorded. Reporting one anyway would mean
presenting a number derived from flows we know to be incomplete.

What *is* computable, and is here:

- **Security-level TWR** over the invested portfolio. Every buy and sell is
  dated and priced, so money entering and leaving each holding is known even
  though money entering the accounts is not. This measures selection, with
  cash drag excluded by construction rather than by accident.
- **Per-position IRR**, where buys are outflows and sells, income and the
  closing value are inflows. Self-contained per holding, so the missing
  account-level funding history does not affect it.
- **FX attribution**, splitting return into what the asset did in its own
  currency and what the currency did.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Sequence, Tuple

from .core.model import Transaction, TxnType
from .core.money import BASE_CURRENCY
from .prices import FxStore, PriceStore


@dataclass
class PeriodReturn:
    start: date
    end: date
    value_start: float
    value_end: float
    net_flow: float
    ret: float


@dataclass
class TwrResult:
    periods: List[PeriodReturn]
    total_return: float
    annualised: Optional[float]
    gaps: List[str] = field(default_factory=list)

    @property
    def days(self) -> int:
        if not self.periods:
            return 0
        return (self.periods[-1].end - self.periods[0].start).days


def chain_link(periods: Sequence[PeriodReturn]) -> Tuple[float, Optional[float]]:
    """Compound period returns, and annualise if the span allows."""
    if not periods:
        return 0.0, None
    growth = 1.0
    for p in periods:
        growth *= (1.0 + p.ret)
    total = growth - 1.0
    days = (periods[-1].end - periods[0].start).days
    if days <= 0 or growth <= 0:
        return total, None
    return total, growth ** (365.25 / days) - 1.0


def twr(values: Sequence[Tuple[date, float]],
        flows: Dict[date, float]) -> TwrResult:
    """Chain-linked time-weighted return.

    `values` is the portfolio value at each observation date; `flows` is the
    net external contribution on a date (positive = money in). Flows are
    treated as occurring at the end of their period, the standard convention
    when chaining at observation frequency.
    """
    periods: List[PeriodReturn] = []
    gaps: List[str] = []
    ordered = sorted(values, key=lambda item: item[0])

    for (d0, v0), (d1, v1) in zip(ordered, ordered[1:]):
        flow = sum(amount for when, amount in flows.items() if d0 < when <= d1)
        if v0 <= 0:
            # A position opened inside this period: the flow *is* the start
            # value, so there is no return to measure yet.
            if abs(flow) > 1e-9:
                gaps.append(f"{d0}..{d1}: opened with flow {flow:,.2f}, no return")
            continue
        ret = (v1 - flow) / v0 - 1.0
        periods.append(PeriodReturn(d0, d1, v0, v1, flow, ret))

    total, annualised = chain_link(periods)
    return TwrResult(periods=periods, total_return=total,
                     annualised=annualised, gaps=gaps)


def xirr(cashflows: Sequence[Tuple[date, float]],
         guess: float = 0.1) -> Optional[float]:
    """Internal rate of return for dated cashflows.

    Bisection rather than Newton: it cannot diverge, and these series are
    small enough that the extra iterations are free. Returns None when the
    flows do not bracket a root (all one sign, or a single flow).

    Day count is actual/365.25, consistent with every other annualisation in
    this package. Excel's XIRR uses actual/365, so results differ slightly --
    by roughly 0.07% relative on a one-year span, more where a leap year is
    involved. The difference is a convention, not an error, but it is worth
    knowing before comparing against a spreadsheet.
    """
    flows = sorted(cashflows, key=lambda item: item[0])
    if len(flows) < 2:
        return None
    if not (any(a > 0 for _, a in flows) and any(a < 0 for _, a in flows)):
        return None

    t0 = flows[0][0]

    def npv(rate: float) -> float:
        if rate <= -1.0:
            return float("inf")
        return sum(amount / (1.0 + rate) ** ((when - t0).days / 365.25)
                   for when, amount in flows)

    low, high = -0.9999, 10.0
    f_low, f_high = npv(low), npv(high)
    if f_low * f_high > 0:
        return None
    for _ in range(200):
        mid = (low + high) / 2.0
        f_mid = npv(mid)
        if abs(f_mid) < 1e-9:
            return mid
        if f_low * f_mid < 0:
            high, f_high = mid, f_mid
        else:
            low, f_low = mid, f_mid
    return (low + high) / 2.0


def position_cashflows(transactions: Sequence[Transaction],
                       closing_value: float,
                       closing_date: date) -> List[Tuple[date, float]]:
    """Cashflows for one holding, from the investor's point of view.

    Buys and covers are money out (negative); sells, shorts, income and the
    closing mark are money in (positive). A short's closing mark is negative:
    what it would cost to buy back.
    """
    flows: List[Tuple[date, float]] = []
    for txn in transactions:
        if txn.type in (TxnType.BUY, TxnType.COVER):
            flows.append((txn.date, -(txn.quantity * txn.price + txn.fees)))
        elif txn.type in (TxnType.SELL, TxnType.SELL_ALL, TxnType.SHORT):
            flows.append((txn.date, txn.quantity * txn.price - txn.fees))
        elif txn.type.is_income:
            flows.append((txn.date, txn.amount))
    if abs(closing_value) > 1e-9:
        flows.append((closing_date, closing_value))
    return flows


# --------------------------------------------------------------------------
# FX attribution
# --------------------------------------------------------------------------

@dataclass
class FxAttribution:
    instrument_id: str
    currency: str
    local_return: float
    fx_return: float
    total_return: float
    # total = (1 + local)(1 + fx) - 1; the difference is the cross term,
    # which is small but real and reported rather than swept into one side.
    cross_term: float

    @property
    def fx_share(self) -> Optional[float]:
        """Fraction of the total return attributable to currency."""
        if abs(self.total_return) < 1e-12:
            return None
        return self.fx_return / self.total_return


def attribute_fx(instrument_id: str, currency: str,
                 price_start: float, price_end: float,
                 fx_start: float, fx_end: float) -> FxAttribution:
    """Split a holding's return into asset and currency components.

    Material rather than academic: a portfolio reported in one currency with
    most of its risk in others can have a good year in local terms and a flat
    one in the home currency, and the single combined number cannot tell you
    which happened.
    """
    local = price_end / price_start - 1.0 if price_start else 0.0
    fx = fx_end / fx_start - 1.0 if fx_start else 0.0
    total = ((price_end * fx_end) / (price_start * fx_start) - 1.0
             if price_start and fx_start else 0.0)
    return FxAttribution(
        instrument_id=instrument_id,
        currency=currency,
        local_return=local,
        fx_return=fx,
        total_return=total,
        cross_term=total - local - fx,
    )


# --------------------------------------------------------------------------
# Portfolio-level series
# --------------------------------------------------------------------------

def value_series(transactions: Sequence[Transaction],
                 prices: PriceStore,
                 fx: FxStore,
                 dates: Sequence[date],
                 base: str = BASE_CURRENCY) -> Tuple[List[Tuple[date, float]], List[str]]:
    """Portfolio value in base currency at each date, by replaying holdings.

    Returns the series plus a list of gaps -- dates where a held instrument
    had no price. A gap understates the portfolio, so it is reported rather
    than interpolated.
    """
    from .positions import replay

    series: List[Tuple[date, float]] = []
    gaps: List[str] = []

    for when in sorted(dates):
        upto = [t for t in transactions if t.date <= when]
        if not upto:
            continue
        state = replay(upto)
        total = 0.0
        for (_acct, iid), pos in state.open_positions.items():
            point = prices.as_of(iid, when)
            if point is None:
                gaps.append(f"{when}: no price for {iid}")
                continue
            rate = fx.rate(point.currency, when, base)
            if rate is None:
                gaps.append(f"{when}: no {point.currency} rate")
                continue
            total += pos.quantity * point.close * rate
        series.append((when, total))
    return series, gaps


def external_flows(transactions: Sequence[Transaction],
                   fx: FxStore, base: str = BASE_CURRENCY) -> Dict[date, float]:
    """Net money into the invested portfolio, per date.

    A buy moves money in, a sell moves it out. This is flow into *securities*,
    not into the accounts -- which is precisely why this works despite the
    missing deposit history.
    """
    flows: Dict[date, float] = defaultdict(float)
    for txn in transactions:
        rate = fx.rate(txn.currency, txn.date, base) or 1.0
        if txn.type in (TxnType.BUY, TxnType.COVER):
            flows[txn.date] += (txn.quantity * txn.price + txn.fees) * rate
        elif txn.type in (TxnType.SELL, TxnType.SELL_ALL, TxnType.SHORT):
            flows[txn.date] -= (txn.quantity * txn.price - txn.fees) * rate
    return dict(flows)
