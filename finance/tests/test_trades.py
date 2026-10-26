"""Tests for the trade ledger (data/canonical/trades.csv) and the replay of shorts."""

from __future__ import annotations

import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance.core.model import AssetKind, Instrument, TxnType
from finance.ingest import trades

HDR = ",".join(trades.FIELDS) + "\n"


class TradeFileTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.path = Path(self._tmp.name) / "trades.csv"
        self.known = {"ABC.DE@GER": Instrument("ABC.DE@GER", "ABC.DE", "Sample AG",
                                               AssetKind.LISTED, "EUR", "GER")}

    def tearDown(self):
        self._tmp.cleanup()

    def test_rows_load_with_fees(self):
        self.path.write_text(HDR + "2026-09-21,Broker,ABC.DE@GER,BUY,10,2,,EUR,,,\n"
                                   "2026-09-28,Broker,ABC.DE@GER,SELL,10,2,,EUR,1,,\n")
        txns, new, problems = trades.load(self.path, self.known)
        self.assertEqual([t.type for t in txns], [TxnType.BUY, TxnType.SELL])
        self.assertEqual(txns[1].fees, 1.0)
        self.assertEqual((new, problems), ({}, []))

    def test_new_instrument_is_created(self):
        self.path.write_text(HDR + "2026-09-24,Broker,XYZ@PCX,BUY,100,25,,USD,,Sample ETF,\n")
        txns, new, _ = trades.load(self.path, self.known)
        self.assertIn("XYZ@PCX", new)
        self.assertEqual(new["XYZ@PCX"].currency, "USD")
        self.assertEqual(new["XYZ@PCX"].name, "Sample ETF")

    def test_unknown_type_is_rejected(self):
        self.path.write_text(HDR + "2026-09-24,Broker,ABC.DE@GER,SWAP,1,1,,EUR,,,\n")
        txns, _, problems = trades.load(self.path, self.known)
        self.assertEqual(txns, [])
        self.assertIn("unknown type", problems[0])

    def test_append_writes_header_once(self):
        trades.append(self.path, {"date": "2026-09-28", "type": "BUY"})
        trades.append(self.path, {"date": "2026-09-29", "type": "BUY"})
        lines = self.path.read_text().splitlines()
        self.assertEqual(lines[0], ",".join(trades.FIELDS))
        self.assertEqual(len(lines), 3)


def _t(kind, qty, price, day=1, fees=0.0, amount=0.0):
    from finance.core.model import Transaction
    return Transaction(txn_id=f"t{day}{kind}", date=date(2026, 10, day), account_id="Broker",
                       instrument_id="BND@NMS", type=TxnType(kind), currency="USD",
                       quantity=qty, price=price, fees=fees, amount=amount)


class ShortTests(unittest.TestCase):
    def run_(self, *txns):
        from finance.positions import replay
        rr = replay(list(txns))
        return rr, rr.positions.get(("Broker", "BND@NMS"))

    def test_short_then_partial_and_full_cover(self):
        rr, p = self.run_(_t("SHORT", 100, 80, 1, fees=1), _t("SHORT", 100, 78, 2, fees=1),
                          _t("COVER", 150, 75, 3, fees=1))
        self.assertEqual(rr.errors, [])
        self.assertAlmostEqual(p.quantity, -50)
        # FIFO: 100 @ 79.99 net + 50 @ 77.99 net = 11,898.5 proceeds; cost to cover 11,251
        self.assertAlmostEqual(p.realised_pnl, 11898.5 - 11251.0)
        self.assertAlmostEqual(p.cost_basis, -(50 * 77.99))
        self.assertTrue(p.is_open)
        rr, p = self.run_(_t("SHORT", 100, 80, 1, fees=1), _t("COVER", 100, 85, 2, fees=1))
        self.assertAlmostEqual(p.realised_pnl, 7999 - 8501)
        self.assertEqual((p.quantity, p.cost_basis), (0.0, 0.0))
        self.assertFalse(p.is_open)

    def test_unrealised_sign_is_right_without_special_cases(self):
        _, p = self.run_(_t("SHORT", 100, 80, 1))
        mark = 70.0
        self.assertAlmostEqual(p.quantity * mark - p.cost_basis, 1000.0)  # price fell: a gain

    def test_dividend_in_lieu_and_borrow_fee_are_negative_income(self):
        rr, p = self.run_(_t("SHORT", 100, 80, 1), _t("DIVIDEND", 0, 0, 2, amount=-32.5),
                          _t("INTEREST", 0, 0, 3, amount=-4.0))
        self.assertAlmostEqual(p.income, -36.5)

    def test_mistakes_are_errors_not_silent_shorts(self):
        codes = lambda *t: [i.code for i in self.run_(*t)[0].errors]
        self.assertEqual(codes(_t("SELL", 10, 80, 1)), ["SELL_EXCEEDS_HOLDING"])
        self.assertEqual(codes(_t("COVER", 10, 80, 1)), ["COVER_NOTHING_SHORT"])
        self.assertEqual(codes(_t("SHORT", 10, 80, 1), _t("COVER", 11, 80, 2)),
                         ["COVER_EXCEEDS_SHORT"])
        self.assertEqual(codes(_t("BUY", 10, 80, 1), _t("SHORT", 5, 80, 2)), ["SHORT_WHILE_LONG"])
        self.assertEqual(codes(_t("SHORT", 10, 80, 1), _t("BUY", 5, 80, 2)), ["BUY_WHILE_SHORT"])
        self.assertEqual(codes(_t("SHORT", 10, 80, 1), _t("SELL", 5, 80, 2)), ["SELL_WHILE_SHORT"])

    def test_cashflows_for_irr(self):
        from finance.performance import position_cashflows
        flows = position_cashflows([_t("SHORT", 100, 80, 1), _t("COVER", 100, 70, 5)],
                                   0.0, date(2026, 10, 5))
        self.assertEqual([f for _, f in flows], [8000.0, -7000.0])

    def test_trade_file_accepts_short_types(self):
        with TemporaryDirectory() as d:
            path = Path(d) / "trades.csv"
            path.write_text(HDR + "2026-10-01,Broker,BND@NMS,SHORT,100,80,,USD,1,Sample Bond Fund,\n"
                                  "2026-10-05,Broker,BND@NMS,COVER,100,70,,USD,1,,\n")
            txns, new, problems = trades.load(path)
            self.assertEqual([t.type for t in txns], [TxnType.SHORT, TxnType.COVER])
            self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
