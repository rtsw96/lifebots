"""Tests for statement ingest, categorisation and transfer matching.

The double-counting test is the important one. Counting a card charge and the
bank's payment of that card as two expenses is the classic way a DIY finance
tracker produces a spending figure that is simply wrong, and nothing about it
looks broken.
"""

from __future__ import annotations

import textwrap
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance.categorise import (Rule, apply_rules, coverage, load_rules,
                                spend_by_category, unmatched_merchants,
                                _normalise)
from finance.core.model import CashFlowKind, CashTransaction
from finance.ingest.banking import (StatementFormat, dedupe, ingest_statement,
                                    load_formats, _num)
from finance.transfers import (mark_card_payments, match_transfers,
                               broker_deposits, savings_rate)

REF = Path(__file__).resolve().parents[1] / "data" / "reference"

BANK_CSV = textwrap.dedent("""\
    Transaction date,Description,Withdrawals (SGD),Deposits (SGD)
    01/03/2026,MONTHLY SALARY ACME PTE LTD,,8500.00
    03/03/2026,NTUC FAIRPRICE FINEST,142.30,
    05/03/2026,CARD PAYMENT - BANK B,1250.00,
    07/03/2026,GRAB *RIDE 12345,18.40,
    09/03/2026,FUND TRANSFER TO BROKER,"5,000.00",
    11/03/2026,SOME UNKNOWN VENDOR 9987,233.00,
    """)

CARD_CSV = textwrap.dedent("""\
    date,description,amount
    2026-03-02,SAMPLE RESTAURANT,-88.00
    2026-03-04,NETFLIX.COM,-19.98
    2026-03-06,PAYMENT - THANK YOU,1250.00
    2026-03-08,SHOPEE ORDER,-64.50
    """)


def _fmt_bank() -> StatementFormat:
    return StatementFormat(
        name="test_bank", account_id="Bank A",
        date_column="Transaction date", date_formats=["%d/%m/%Y"],
        description_columns=["Description"],
        debit_column="Withdrawals (SGD)", credit_column="Deposits (SGD)",
        currency="SGD")


def _fmt_card() -> StatementFormat:
    return StatementFormat(
        name="test_card", account_id="Card B",
        date_column="date", date_formats=["%Y-%m-%d"],
        description_columns=["description"], amount_column="amount",
        currency="SGD")


class NumberParsingTests(unittest.TestCase):
    def test_thousands_separator(self):
        self.assertEqual(_num("5,000.00"), 5000.0)

    def test_parenthesised_negative(self):
        self.assertEqual(_num("(123.45)"), -123.45)

    def test_currency_symbol(self):
        self.assertEqual(_num("S$1,234.50"), 1234.50)

    def test_blank(self):
        self.assertEqual(_num(""), 0.0)


class IngestTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        bank = Path(self._tmp.name) / "bank.csv"
        bank.write_text(BANK_CSV, encoding="utf-8")
        card = Path(self._tmp.name) / "card.csv"
        card.write_text(CARD_CSV, encoding="utf-8")
        self.bank = ingest_statement(bank, _fmt_bank())
        self.card = ingest_statement(card, _fmt_card())

    def tearDown(self):
        self._tmp.cleanup()

    def test_debit_credit_columns_normalise_to_signed(self):
        salary = next(t for t in self.bank if "SALARY" in t.description)
        groceries = next(t for t in self.bank if "FAIRPRICE" in t.description)
        self.assertEqual(salary.amount, 8500.0)
        self.assertEqual(groceries.amount, -142.30)

    def test_signed_column_passes_through(self):
        dinner = next(t for t in self.card if "SAMPLE RESTAURANT" in t.description)
        self.assertEqual(dinner.amount, -88.0)

    def test_row_counts(self):
        self.assertEqual(len(self.bank), 6)
        self.assertEqual(len(self.card), 4)

    def test_reingest_is_idempotent(self):
        self.assertEqual(len(dedupe(self.bank + self.bank)), len(self.bank))

    def test_shipped_formats_parse(self):
        formats = load_formats(REF / "statement_formats.json")
        self.assertEqual(sorted(formats), ["generic_signed"])  # "_example..." is documentation
        self.assertEqual(formats["generic_signed"].amount_column, "amount")


class CategorisationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        bank = Path(self._tmp.name) / "bank.csv"
        bank.write_text(BANK_CSV, encoding="utf-8")
        self.txns = ingest_statement(bank, _fmt_bank())
        self.rules = load_rules(REF / "category_rules.csv")

    def tearDown(self):
        self._tmp.cleanup()

    def test_shipped_rules_load(self):
        self.assertGreater(len(self.rules), 15)

    def test_groceries_and_transport_classified(self):
        done = apply_rules(self.txns, self.rules)
        by_desc = {t.description: t for t in done}
        self.assertEqual(
            by_desc["NTUC FAIRPRICE FINEST"].category, "groceries")
        self.assertEqual(
            by_desc["GRAB *RIDE 12345"].category, "transport_ride")

    def test_salary_is_income_not_expense(self):
        done = apply_rules(self.txns, self.rules)
        salary = next(t for t in done if "SALARY" in t.description)
        self.assertEqual(salary.kind, CashFlowKind.INCOME)
        self.assertFalse(salary.counts_as_spending)

    def test_card_payment_is_a_transfer(self):
        done = apply_rules(self.txns, self.rules)
        payment = next(t for t in done if "CARD PAYMENT" in t.description)
        self.assertEqual(payment.kind, CashFlowKind.TRANSFER)
        self.assertFalse(payment.counts_as_spending)

    def test_priority_beats_file_order(self):
        rules = [
            Rule(pattern="NTUC", category="broad", kind=CashFlowKind.EXPENSE,
                 priority=200),
            Rule(pattern="NTUC FAIRPRICE", category="specific",
                 kind=CashFlowKind.EXPENSE, priority=10),
        ]
        rules.sort(key=lambda r: r.priority)
        done = apply_rules(self.txns, rules)
        target = next(t for t in done if "FAIRPRICE" in t.description)
        self.assertEqual(target.category, "specific")

    def test_unmatched_ranked_by_value(self):
        unmatched = unmatched_merchants(self.txns, self.rules)
        self.assertTrue(unmatched)
        self.assertIn("SOME UNKNOWN VENDOR", unmatched[0][0])

    def test_normalise_strips_reference_numbers(self):
        a = _normalise("GRAB *RIDE 998877")
        b = _normalise("GRAB *RIDE 112233")
        self.assertEqual(a, b)

    def test_coverage_reports_gap(self):
        done = apply_rules(self.txns, self.rules)
        by_value, _by_count = coverage(done)
        self.assertLess(by_value, 1.0)


class TransferTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        bank = Path(self._tmp.name) / "bank.csv"
        bank.write_text(BANK_CSV, encoding="utf-8")
        card = Path(self._tmp.name) / "card.csv"
        card.write_text(CARD_CSV, encoding="utf-8")
        self.txns = (ingest_statement(bank, _fmt_bank())
                     + ingest_statement(card, _fmt_card()))

    def tearDown(self):
        self._tmp.cleanup()

    def test_card_payment_pairs_across_accounts(self):
        matches, _ = match_transfers(self.txns)
        amounts = {round(m.amount, 2) for m in matches}
        self.assertIn(1250.00, amounts)

    def test_matched_legs_are_retyped(self):
        _, updated = match_transfers(self.txns)
        legs = [t for t in updated if abs(abs(t.amount) - 1250.0) < 0.01]
        self.assertEqual(len(legs), 2)
        for leg in legs:
            self.assertEqual(leg.kind, CashFlowKind.TRANSFER)
            self.assertIsNotNone(leg.counterparty_account)

    def test_card_spend_is_not_double_counted(self):
        """The headline risk: the charge and its payment are the same money."""
        _, updated = match_transfers(self.txns)
        rules = load_rules(REF / "category_rules.csv")
        done = apply_rules(updated, rules)
        spend = spend_by_category(done)
        # Card charges: 88.00 + 19.98 + 64.50 = 172.48. The 1,250 payment
        # must not appear anywhere in spending.
        self.assertNotIn("card_payment", spend)
        self.assertLess(sum(spend.values()), 1250.0)

    def test_unmatched_card_credit_still_not_income(self):
        card_only = [t for t in self.txns if t.account_id == "Card B"]
        marked = mark_card_payments(card_only, {"Card B"})
        credit = next(t for t in marked if t.amount > 0)
        self.assertEqual(credit.kind, CashFlowKind.TRANSFER)

    def test_broker_deposit_identified(self):
        extra = CashTransaction(
            txn_id="broker-in", date=date(2026, 3, 9), account_id="Broker",
            description="DEPOSIT", amount=5000.0, currency="SGD")
        matches, _ = match_transfers(self.txns + [extra])
        deposits = broker_deposits(matches, {"Broker"})
        self.assertEqual(len(deposits), 1)
        self.assertAlmostEqual(deposits[0].amount, 5000.0)

    def test_savings_rate_excludes_transfers(self):
        _, updated = match_transfers(self.txns)
        rules = load_rules(REF / "category_rules.csv")
        done = apply_rules(updated, rules)
        income, spend, rate = savings_rate(done)
        self.assertAlmostEqual(income, 8500.0)
        self.assertLess(spend, 1000.0)     # transfers excluded
        self.assertGreater(rate, 0.8)

    def test_no_transaction_matched_twice(self):
        matches, _ = match_transfers(self.txns)
        used = [m.outflow.txn_id for m in matches] + \
               [m.inflow.txn_id for m in matches]
        self.assertEqual(len(used), len(set(used)))


if __name__ == "__main__":
    unittest.main()
