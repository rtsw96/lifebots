"""Tagging and concentration risk.

Slicing by your own dimensions (sector, region, bucket: whatever tags.csv
defines) and measuring how concentrated the book is.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .portfolio import Snapshot, ValuedPosition


# --------------------------------------------------------------------------
# Tagging
# --------------------------------------------------------------------------

@dataclass
class TagSet:
    by_instrument: Dict[str, Dict[str, str]] = field(default_factory=dict)

    @classmethod
    def from_csv(cls, path: Path) -> "TagSet":
        tags: Dict[str, Dict[str, str]] = {}
        if path.exists():
            with path.open(newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    iid = row.pop("instrument_id", "").strip()
                    if iid:
                        tags[iid] = {k: v.strip() for k, v in row.items() if v.strip()}
        return cls(by_instrument=tags)

    def get(self, instrument_id: str, dimension: str) -> str:
        # Instrument ids carry an exchange suffix; tags are keyed on the bare
        # symbol so the same name tags consistently across accounts.
        bare = instrument_id.split("@")[0]
        return (self.by_instrument.get(instrument_id, {}).get(dimension)
                or self.by_instrument.get(bare, {}).get(dimension)
                or "untagged")

    def group(self, positions: List[ValuedPosition],
              dimension: str) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for p in positions:
            out[self.get(p.instrument_id, dimension)] += p.market_value_base
        return dict(out)

    @property
    def dimensions(self) -> List[str]:
        seen: set[str] = set()
        for tags in self.by_instrument.values():
            seen.update(tags)
        return sorted(seen - {"note"})


# --------------------------------------------------------------------------
# Concentration
# --------------------------------------------------------------------------

@dataclass
class Concentration:
    top_1: float
    top_5: float
    top_10: float
    hhi: float
    effective_positions: float
    largest: List[Tuple[str, float]]

    @property
    def verdict(self) -> str:
        """HHI reads as the reciprocal of the effective number of holdings."""
        if self.hhi >= 0.25:
            return "highly concentrated"
        if self.hhi >= 0.15:
            return "concentrated"
        if self.hhi >= 0.10:
            return "moderately concentrated"
        return "diversified"


def concentration(positions: List[ValuedPosition]) -> Optional[Concentration]:
    values = sorted(((f"{p.account_id}/{p.symbol}", p.market_value_base)
                     for p in positions if p.market_value_base > 0),
                    key=lambda item: -item[1])
    total = sum(v for _, v in values)
    if total <= 0:
        return None
    weights = [v / total for _, v in values]
    hhi = sum(w * w for w in weights)
    return Concentration(
        top_1=sum(weights[:1]),
        top_5=sum(weights[:5]),
        top_10=sum(weights[:10]),
        hhi=hhi,
        effective_positions=1.0 / hhi if hhi else 0.0,
        largest=values[:10],
    )


def drawdown(series: List[Tuple[object, float]]) -> Tuple[float, Optional[object]]:
    """Maximum peak-to-trough decline and the date it bottomed."""
    peak = float("-inf")
    worst = 0.0
    worst_at = None
    for when, value in sorted(series, key=lambda item: item[0]):
        peak = max(peak, value)
        if peak > 0:
            dd = value / peak - 1.0
            if dd < worst:
                worst, worst_at = dd, when
    return worst, worst_at
