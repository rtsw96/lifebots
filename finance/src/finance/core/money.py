"""FX conversion into the reporting base currency (your home currency).

The base currency is `home_currency` in settings.json at the repo root (read
through bots/settings.py); SGD when that file or key is missing. The
FINANCE_BASE_CURRENCY environment variable overrides it (tests use it).

Rates live in data/reference/fx_rates.csv: one row per currency, "how many
units of the home currency one unit is worth". Spot rates cover today's
valuation; historical rates (for cost basis and the net-worth series) are
keyed by date and fall back to spot with an explicit warning rather than
silently.
"""

from __future__ import annotations

import csv
import importlib.util
import os
from datetime import date
from pathlib import Path
from typing import Dict, Optional, Tuple

DEFAULT_CURRENCY = "SGD"
_SETTINGS = Path(__file__).resolve().parents[4] / "bots" / "settings.py"


def home_currency() -> str:
    """The reporting currency: FINANCE_BASE_CURRENCY, else settings.json's home_currency, else SGD."""
    env = (os.environ.get("FINANCE_BASE_CURRENCY") or "").strip()
    if env:
        return env.upper()
    try:
        spec = importlib.util.spec_from_file_location("lifebots_settings", _SETTINGS)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return (mod.home_currency() or DEFAULT_CURRENCY).upper()
    except Exception:  # no shared core (the package used on its own): the default
        return DEFAULT_CURRENCY


BASE_CURRENCY = home_currency()


class FxError(Exception):
    pass


class FxTable:
    """Currency -> base-currency rates, optionally dated.

    A rate is "how many units of the base currency one unit is worth", so
    with an SGD base, USD 1.275 means USD 1 = SGD 1.275.
    """

    def __init__(self, base: Optional[str] = None) -> None:
        base = (base or home_currency()).upper()
        self.base = base
        self._spot: Dict[str, float] = {base: 1.0}
        self._dated: Dict[Tuple[str, date], float] = {}
        self.missing: set[str] = set()
        self.fell_back_to_spot: set[Tuple[str, date]] = set()

    @classmethod
    def from_csv(cls, path: Path, base: Optional[str] = None) -> "FxTable":
        table = cls(base)
        if not path.exists():
            return table
        with path.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ccy = row["currency"].strip().upper()
                rate = float(row["rate_to_base"])
                raw_date = (row.get("date") or "").strip()
                if raw_date:
                    table._dated[(ccy, date.fromisoformat(raw_date))] = rate
                else:
                    table._spot[ccy] = rate
        return table

    def spot(self, currency: str) -> float:
        ccy = currency.strip().upper()
        if ccy in self._spot:
            return self._spot[ccy]
        self.missing.add(ccy)
        raise FxError(f"No spot rate for {ccy} -> {self.base}")

    def on(self, currency: str, when: date) -> float:
        """Rate on a given date, falling back to spot with a recorded warning.

        Falling back is wrong but bounded, and recording it means the
        reconciliation report can say exactly which figures are affected
        rather than presenting an estimate as a measurement.
        """
        ccy = currency.strip().upper()
        if ccy == self.base:
            return 1.0
        if (ccy, when) in self._dated:
            return self._dated[(ccy, when)]
        self.fell_back_to_spot.add((ccy, when))
        return self.spot(ccy)

    def to_base(self, amount: float, currency: str, when: Optional[date] = None) -> float:
        rate = self.spot(currency) if when is None else self.on(currency, when)
        return amount * rate

    @property
    def currencies(self) -> list[str]:
        return sorted(self._spot)
