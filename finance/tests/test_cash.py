"""Negative cash: confirmed borrowing versus unexplained gaps."""

from __future__ import annotations

import unittest
from datetime import date
from pathlib import Path

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import portfolio
from finance.portfolio import Snapshot

DATA = Path(__file__).resolve().parents[1] / "data"


def snap(cash, asserted):
    s = Snapshot(as_of=date(2026, 9, 30), base_currency="SGD", positions=[], cash=cash,
                 issues=[], income_by_type={}, accounts={})
    s._cash_base = dict(cash)
    s.asserted_cash = set(asserted)
    return s


class NegativeCashTests(unittest.TestCase):
    def test_asserted_negative_is_a_margin_loan_not_an_error(self):
        s = snap({("Broker", "SGD"): -100.0, ("Fund", "SGD"): -5.0, ("Broker", "EUR"): 50.0},
                 {("Broker", "SGD"), ("Broker", "EUR")})
        self.assertEqual(s.margin_loans(), [(("Broker", "SGD"), -100.0)])
        self.assertEqual(s.unexplained_negative_cash(), [(("Fund", "SGD"), -5.0)])
        self.assertEqual(s.margin_loans_base(), -100.0)

    def test_assertions_dated_after_as_of_are_ignored(self):
        import shutil
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            data = Path(d) / "data"
            shutil.copytree(DATA, data)
            (data / "reference" / "fx_rates.csv").write_text("currency,rate_to_base,date,source\nEUR,1.5,,test\n")
            (data / "reference" / "balance_assertions.csv").write_text(
                "account_id,currency,balance,as_of,reason\nBroker,EUR,100,2026-09-30,statement\n")
            before = portfolio.build(data, as_of=date(2026, 9, 21))
            after = portfolio.build(data, as_of=date(2026, 9, 30))
        self.assertNotIn(("Broker", "EUR"), before.asserted_cash)
        self.assertIn(("Broker", "EUR"), after.asserted_cash)
        self.assertAlmostEqual(after.cash_value, 150.0)


if __name__ == "__main__":
    unittest.main()
