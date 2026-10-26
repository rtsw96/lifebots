"""The whole book from the shipped empty templates, then from a small made-up one.

What matters: a fresh copy runs every command with nothing filled in, and the
build values trades, manual assets, marks, FX and stated cash correctly.
"""

from __future__ import annotations

import contextlib
import io
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import cli, portfolio

DATA = Path(__file__).resolve().parents[1] / "data"


def run(data: Path, *argv) -> tuple:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(["--data", str(data), "--as-of", "2026-10-20", *argv])
    return code, out.getvalue()


class FromEmpty(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        shutil.copytree(DATA, self.data)

    def tearDown(self):
        self.tmp.cleanup()

    def test_templates_hold_no_data(self):
        for f in sorted((DATA / "canonical").glob("*.csv")) + sorted((DATA / "reference").glob("*.csv")):
            if f.name == "category_rules.csv":
                continue  # a neutral starter set of merchant patterns
            self.assertEqual(len(f.read_text().strip().splitlines()), 1, f"{f.name} should be header-only")
        self.assertEqual([p.name for p in (DATA / "derived").iterdir()], [".gitkeep"])

    def test_every_command_runs_on_an_empty_book(self):
        snap = portfolio.build(self.data, as_of=date(2026, 10, 20))
        self.assertEqual((snap.net_worth, snap.positions, snap.issues), (0, [], []))
        for argv in (["snapshot"], ["brief"], ["check"], ["dashboard"], ["analyse"], ["plan"], ["spend"],
                     ["txn", "list"], ["policy"], ["addcheck", "ABC", "10"]):
            code, out = run(self.data, *argv)
            self.assertEqual(code, 0, f"{argv}: {out}")
        self.assertTrue((self.data / "derived" / "dashboard.html").exists())

    def test_a_trade_needs_a_known_account(self):
        code, out = run(self.data, "trade", "BUY", "ABC@NYSE", "10", "5", "--account", "Broker", "--currency", "USD")
        self.assertEqual(code, 1)
        self.assertIn("accounts.csv", out)


class SmallBook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        shutil.copytree(DATA, self.data)
        ref = self.data / "reference"
        (ref / "accounts.csv").write_text(
            "account_id,name,broker,ownership,base_currency,include_in_net_worth,tracking_start,note\n"
            "Broker,Broker X,Broker X,SELF,SGD,true,2026-01-01,\n"
            "Home,Home,,SELF,SGD,true,,\n")
        (ref / "fx_rates.csv").write_text("currency,rate_to_base,date,source\nUSD,1.25,,test\n")
        (ref / "marks.csv").write_text("instrument_id,mark,currency,as_of,source,note\nABC@NYSE,12,USD,2026-10-19,test,\n")
        (ref / "manual_assets.csv").write_text(
            "instrument_id,account_id,symbol,name,kind,currency,quantity,cost_per_unit,acquired,maturity,note\n"
            "FLAT,Home,FLAT,Sample flat,PROPERTY,SGD,1,100000,2025-01-01,,\n")
        (ref / "balance_assertions.csv").write_text(
            "account_id,currency,balance,as_of,reason\nBroker,USD,200,2026-10-01,statement\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_trades_value_and_reject_mistakes(self):
        code, out = run(self.data, "trade", "BUY", "ABC@NYSE", "100", "10", "--account", "Broker",
                        "--currency", "USD", "--date", "2026-10-02", "--name", "Sample Inc", "--fees", "1")
        self.assertEqual(code, 0, out)
        self.assertIn("average cost 10.01", out)
        code, out = run(self.data, "trade", "SELL", "ABC", "500", "11", "--account", "Broker",
                        "--currency", "USD", "--date", "2026-10-03")
        self.assertEqual(code, 1)
        self.assertIn("SELL_EXCEEDS_HOLDING", out)
        snap = portfolio.build(self.data, as_of=date(2026, 10, 20))
        abc = next(p for p in snap.positions if p.instrument_id == "ABC@NYSE")
        self.assertAlmostEqual(abc.market_value_base, 100 * 12 * 1.25)
        self.assertAlmostEqual(snap.cash_value, 200 * 1.25)
        self.assertAlmostEqual(snap.net_worth, 1500 + 250 + 100000)
        self.assertEqual(snap.base_currency, "SGD")

        code, out = run(self.data, "addcheck", "ABC", "9")
        self.assertEqual(code, 1)
        self.assertIn("averaging down", out)
        code, out = run(self.data, "addcheck", "ABC", "12")
        self.assertEqual(code, 0, out)

    def test_a_missing_rate_is_a_note_not_a_crash(self):
        (self.data / "reference" / "fx_rates.csv").write_text("currency,rate_to_base,date,source\n")
        run(self.data, "trade", "BUY", "ABC@NYSE", "1", "10", "--account", "Broker", "--currency", "USD",
            "--date", "2026-10-02", "--name", "Sample Inc")
        (self.data / "reference" / "balance_assertions.csv").write_text("account_id,currency,balance,as_of,reason\n")
        snap = portfolio.build(self.data, as_of=date(2026, 10, 20))
        self.assertTrue(any("FX unavailable" in n for n in snap.notes))


if __name__ == "__main__":
    unittest.main()
