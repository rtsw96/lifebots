"""Price and FX history, cached locally.

The cache is the primary source, not an optimisation. Reading marks from a
local file rather than a live API means a report for any past date reproduces
exactly, runs offline, and does not silently pick up a provider's revisions.
Providers only ever fill gaps in the cache.

No provider is wired in by default: market-data APIs need their own keys and
plans. `PriceStore` works fully without any provider, serving whatever has
been cached or seeded.
"""

from __future__ import annotations

import csv
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Protocol, Tuple

from .core.money import BASE_CURRENCY


@dataclass(frozen=True)
class PricePoint:
    instrument_id: str
    when: date
    close: float
    currency: str
    source: str


class PriceProvider(Protocol):
    """Anything that can supply history for one instrument."""

    name: str

    def fetch(self, instrument_id: str, symbol: str,
              start: date, end: date) -> List[PricePoint]:
        ...


class PriceStore:
    """Dated closes per instrument, with as-of lookup.

    Lookup is as-of rather than exact: a valuation on a weekend or a market
    holiday should use the last close before it, not fail. `max_staleness`
    bounds how far back that is allowed to reach so a long-dead mark cannot
    quietly stand in for a current one.
    """

    def __init__(self, max_staleness: timedelta = timedelta(days=7)) -> None:
        self._points: Dict[str, List[Tuple[date, PricePoint]]] = {}
        self._sorted: Dict[str, bool] = {}
        self.max_staleness = max_staleness
        self.stale_lookups: List[Tuple[str, date, date]] = []
        self.misses: List[Tuple[str, date]] = []

    # -- loading ------------------------------------------------------
    @classmethod
    def from_csv(cls, path: Path, **kwargs) -> "PriceStore":
        store = cls(**kwargs)
        if path.exists():
            with path.open(newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    store.add(PricePoint(
                        instrument_id=row["instrument_id"],
                        when=date.fromisoformat(row["date"]),
                        close=float(row["close"]),
                        currency=row["currency"],
                        source=row.get("source", ""),
                    ))
        return store

    def add(self, point: PricePoint) -> None:
        self._points.setdefault(point.instrument_id, []).append((point.when, point))
        self._sorted[point.instrument_id] = False

    def extend(self, points: Iterable[PricePoint]) -> None:
        for point in points:
            self.add(point)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = sorted(
            (p for series in self._points.values() for _, p in series),
            key=lambda p: (p.instrument_id, p.when),
        )
        with path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(["instrument_id", "date", "close", "currency", "source"])
            for p in rows:
                writer.writerow([p.instrument_id, p.when.isoformat(),
                                 f"{p.close:.10g}", p.currency, p.source])

    # -- lookup -------------------------------------------------------
    def _ensure_sorted(self, instrument_id: str) -> List[Tuple[date, PricePoint]]:
        series = self._points.get(instrument_id, [])
        if series and not self._sorted.get(instrument_id):
            series.sort(key=lambda item: item[0])
            # Later entries for the same date win: a refresh supersedes a seed.
            deduped: List[Tuple[date, PricePoint]] = []
            for when, point in series:
                if deduped and deduped[-1][0] == when:
                    deduped[-1] = (when, point)
                else:
                    deduped.append((when, point))
            series[:] = deduped
            self._sorted[instrument_id] = True
        return series

    def as_of(self, instrument_id: str, when: date) -> Optional[PricePoint]:
        series = self._ensure_sorted(instrument_id)
        if not series:
            self.misses.append((instrument_id, when))
            return None
        idx = bisect_right([d for d, _ in series], when)
        if idx == 0:
            self.misses.append((instrument_id, when))
            return None
        found_date, point = series[idx - 1]
        if when - found_date > self.max_staleness:
            self.stale_lookups.append((instrument_id, when, found_date))
        return point

    def latest(self, instrument_id: str) -> Optional[PricePoint]:
        series = self._ensure_sorted(instrument_id)
        return series[-1][1] if series else None

    def coverage(self) -> Dict[str, Tuple[date, date, int]]:
        out: Dict[str, Tuple[date, date, int]] = {}
        for iid in self._points:
            series = self._ensure_sorted(iid)
            if series:
                out[iid] = (series[0][0], series[-1][0], len(series))
        return out

    @property
    def instruments(self) -> List[str]:
        return sorted(self._points)

    def dates_between(self, start: date, end: date) -> List[date]:
        """Every date on which any instrument has an observation."""
        seen = {d for series in self._points.values() for d, _ in series}
        return sorted(d for d in seen if start <= d <= end)


class FxStore(PriceStore):
    """Same machinery, keyed by currency rather than instrument.

    Rates are 'how many base units one unit of this currency buys', matching
    `FxTable`. FX history matters: with holdings in several currencies,
    currency moves are a material share of the return, and undated rates make
    the whole net-worth series wrong rather than merely imprecise.
    """

    def rate(self, currency: str, when: date, base: str = BASE_CURRENCY) -> Optional[float]:
        if currency.upper() == base:
            return 1.0
        point = self.as_of(currency.upper(), when)
        return point.close if point else None


def seed_from_snapshot(positions_csv: Path, when: date) -> List[PricePoint]:
    """Turn a generated positions file into cache entries.

    Lets the price history start accumulating from the marks already in hand,
    so the net-worth series has real observations from day one instead of
    waiting on a backfill.
    """
    if not positions_csv.exists():
        return []
    points: List[PricePoint] = []
    with positions_csv.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            mark = float(row["mark"])
            if mark == 0:
                continue
            points.append(PricePoint(
                instrument_id=row["instrument_id"],
                when=when,
                close=mark,
                currency=row["currency"],
                source=f"snapshot:{row['mark_source']}",
            ))
    return points
