"""Tests for the transaction ledger the money bot writes.

What matters: no card or account number survives into the ledger, the same
statement imported twice adds nothing, card payments never count as spending,
and a manual category beats the rules.
"""

from __future__ import annotations

import json
import shutil
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import spending

REF = Path(__file__).resolve().parents[1] / "data" / "reference"


class Ledger(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.data = Path(self.tmp.name)
        shutil.copytree(REF, self.data / "reference")

    def tearDown(self):
        self.tmp.cleanup()

    def lines(self, rows):
        p = self.data / "lines.json"
        p.write_text(json.dumps(rows))
        return p

    def test_numbers_are_masked(self):
        # Every number here is made up.
        self.assertEqual(spending.redact("PAYMENT FROM 4000 1234 5678 9010 THANK YOU"), "PAYMENT FROM x9010 THANK YOU")
        self.assertEqual(spending.redact("FAST TRF 123-456789-0 SAM"), "FAST TRF x7890 SAM")
        self.assertEqual(spending.redact("GRAB 12OCT SG 2026"), "GRAB 12OCT SG 2026")
        self.assertEqual(spending.redact("STARBUCKS #1234567"), "STARBUCKS #1234567")
        self.assertEqual(spending.redact("IBG TAX ITX S1234567A"), "IBG TAX ITX [ID]")
        self.assertEqual(spending.redact("Insurer Ltd POL11112222/01231234567A 01231234567A"),
                         "Insurer Ltd POLx2222/xA xA")
        self.assertEqual(spending.redact("IBKR FUNDING U1234567 REF"), "IBKR FUNDING [acct] REF")
        self.assertEqual(spending.redact("INTERACTIVE BROKERS U12345678/SGD"), "INTERACTIVE BROKERS [acct]/SGD")
        self.assertEqual(spending.redact("UNIT U123 ROUTE U123456789"), "UNIT U123 ROUTE Ux6789")
        self.assertEqual(spending.redact("TOP-UP TO WALLET : 90001234 TF000011112222333344"), "TOP-UP TO WALLET : x1234 TFx3344")
        self.assertEqual(spending.redact("To: SAMPLE MOTORS PTE. LTD. OTHR SAB1234C"), "To: SAMPLE MOTORS PTE. LTD. OTHR [plate]")
        self.assertEqual(spending.redact("OTHR rent unit #2-01 and # 03-15"), "OTHR rent unit #[unit] and #[unit]")
        self.assertEqual(spending.redact("BANK:4000123412341234:I-BANK Transfer"), "BANK:x1234:I-BANK Transfer")
        self.assertEqual(spending.redact("SGD 12345.67 on 3 Mar 2026"), "SGD 12345.67 on 3 Mar 2026")

    def test_import_is_idempotent_and_keeps_same_day_repeats(self):
        rows = [{"date": "2026-09-03", "description": "RIDE CO *TRIP", "amount": -12.4},
                {"date": "2026-09-03", "description": "RIDE CO *TRIP", "amount": -12.4},
                {"date": "2026-09-05", "description": "PAYMENT RECEIVED 4000123412341234", "amount": 900}]
        p = self.lines(rows)
        self.assertEqual(spending.import_json(self.data, p, "Card A"), (3, 0))
        self.assertEqual(spending.import_json(self.data, p, "Card A"), (0, 3))
        text = spending.ledger_path(self.data).read_text()
        self.assertNotIn("4000123412341234", text)
        self.assertIn("x1234", text)

    def test_bad_lines_are_refused(self):
        with self.assertRaises(ValueError):
            spending.import_json(self.data, self.lines([{"date": "3 Sep", "description": "X", "amount": -1}]), "Card A")
        with self.assertRaises(ValueError):
            spending.import_json(self.data, self.lines([{"date": "2026-09-03", "description": " ", "amount": -1}]), "Card A")

    def test_card_payment_is_not_spending_and_manual_category_wins(self):
        (self.data / "reference" / "spend_accounts.csv").write_text(
            "account_id,kind,institution,product,note\nCard B,card,Bank B,Rewards card,\n")
        spending.import_json(self.data, self.lines([
            {"date": "2026-09-03", "description": "SOME CAFE", "amount": -20},
            {"date": "2026-09-10", "description": "PAYMENT RECEIVED", "amount": 500},
            {"date": "2026-09-12", "description": "MYSTERY MERCHANT", "amount": -80}]), "Card B")
        txns = spending.transactions(self.data)
        pay = next(t for t in txns if t.amount > 0)
        self.assertEqual(pay.kind.value, "TRANSFER")
        mystery = next(t for t in txns if "MYSTERY" in t.description)
        self.assertTrue(spending.set_category(self.data, mystery.txn_id, "shopping", "Mystery"))
        s = spending.summary(spending.transactions(self.data))
        sep = s["months"][0]
        self.assertEqual(sep["month"], "2026-09")
        self.assertEqual(sep["spend"], 100.0)
        self.assertEqual(sep["categories"]["shopping"], 80.0)
        self.assertEqual(sep["income"], 0.0)
        self.assertIsNone(sep["savings_rate"])
        self.assertEqual(len(s["recent"]), 3)


if __name__ == "__main__":
    unittest.main()
