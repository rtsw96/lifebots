"""Tests for recurring-payment detection (the Money app's Recurring tab).

What matters: a payment needs a steady rhythm to count, a one-off family
transfer isn't a standing order, the policy list fills in premiums the
statements haven't shown yet, and late card statements don't make a
subscription look stopped.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import recurring

TODAY = date(2026, 10, 11)


def txn(d, amount, desc, category, account="Bank", merchant=None):
    return SimpleNamespace(date=d, amount=-amount, description=desc, merchant=merchant, category=category,
                           currency="SGD", account_id=account)


def monthly(desc, amount, category, start=date(2026, 4, 3), n=6, account="Bank", merchant=None):
    return [txn(start + timedelta(days=30 * k), amount, desc, category, account, merchant) for k in range(n)]


class Detect(unittest.TestCase):
    def build(self, txns, policies="", manual="", through=None, payees=""):
        with tempfile.TemporaryDirectory() as d:
            ref = Path(d)
            if payees:
                (ref / "payee_names.csv").write_text(payees)
            if policies:
                (ref / "insurance_policies.csv").write_text(policies)
            if manual:
                (ref / "recurring_manual.csv").write_text(manual)
            return recurring.build(txns, ref, TODAY, through or {"Bank": "2026-10-10", "Card": "2026-09-15"})

    def item(self, r, name):
        return next(i for i in r["items"] if i["name"] == name)

    def test_monthly_subscription_and_next_due_rolls_past_today(self):
        r = self.build(monthly("NETFLIX.COM SINGAPORE", 19.98, "subscriptions", account="Card", start=date(2026, 3, 28)))
        n = self.item(r, "Netflix")
        self.assertEqual((n["cadence"], n["amount"], n["status"]), ("monthly", 19.98, "active"))
        self.assertGreaterEqual(n["next"], TODAY.isoformat())
        self.assertEqual(r["sections"]["subscriptions"], 19.98)

    def test_late_card_statements_dont_mean_stopped(self):
        # last seen 24 Aug; the card's statements only run to 15 Sep, so it isn't overdue
        r = self.build(monthly("SPOTIFY P1", 11.98, "subscriptions", account="Card", start=date(2026, 3, 27)))
        self.assertEqual(self.item(r, "Spotify")["status"], "active")
        gone = self.build(monthly("SPOTIFY P1", 11.98, "subscriptions", start=date(2026, 1, 5), n=4))
        self.assertEqual(self.item(gone, "Spotify")["status"], "stopped?")
        self.assertEqual(gone["monthly_all"], 0)

    def test_family_standing_order_vs_one_off_transfers(self):
        txns = monthly("Transfer to Ben", 1000, "family", merchant="Ben") + [
            txn(date(2026, 8, 16), 500, "Transfer to Ben", "family", merchant="Ben"),
            txn(date(2026, 9, 10), 500, "Transfer to Ben", "family", merchant="Ben")]
        r = self.build(txns)
        self.assertEqual(self.item(r, "Ben SGD 1,000")["cadence"], "monthly")
        extra = self.item(r, "Ben (other transfers)")
        self.assertEqual(extra["cadence"], "irregular")
        self.assertLess(extra["monthly"], 500)  # averaged over all months on file, not shown as 500 a month
        self.assertNotIn("Ben SGD 500", [i["name"] for i in r["items"]])

    def test_one_payment_needs_a_known_cycle(self):
        r = self.build([txn(date(2026, 9, 1), 80, "SOME SHOP", "subscriptions")])
        self.assertEqual(r["items"], [])
        r = self.build([txn(date(2026, 5, 1), 900.0, "CITY PROPERTY TAX", "tax")])
        pt = self.item(r, "City Property Tax")
        self.assertEqual((pt["cadence"], pt["next"]), ("annual", "2027-05-01"))

    def test_policy_list_fills_in_unseen_premiums(self):
        policies = ("policy,insurer,policy_name,in_force,commenced,annual_premium,paid_from,payee\n"
                    "1,Insurer A,Hospital,Yes,2022-08-19,390.10,Health savings,\n"
                    "2,Insurer B,Life Plan,Yes,2016-01-25,685.60,cash,Insurer B Life Plan\n"
                    "3,Old,Lapsed,No,2016-01-25,100,cash,Old\n")
        r = self.build([], policies=policies)
        names = {i["name"]: i for i in r["items"]}
        self.assertEqual(names["Insurer B Life Plan"]["next"], "2027-01-25")
        self.assertEqual(names["Insurer B Life Plan"]["status"], "not seen yet")
        self.assertEqual(names["Insurer A Hospital"]["paid_from"], "Health savings")
        self.assertNotIn("Old", names)
        self.assertAlmostEqual(r["monthly_cash"], 57.13, places=2)

    def test_manual_items_count_but_not_as_cash(self):
        manual = "name,section,amount,cadence,paid_from,start,note\nMortgage (savings part),mortgage,1800,monthly,Savings scheme,2026-04-01,\n"
        r = self.build(monthly("HOME LOAN INSTALMENT", 1800, "housing_mortgage"), manual=manual)
        self.assertEqual(r["sections"]["mortgage"], 3600)
        self.assertEqual(r["monthly_cash"], 1800)
        self.assertEqual(r["monthly_all"], 3600)

    def test_owner_can_end_a_payment(self):
        manual = "name,section,amount,cadence,paid_from,start,note\nNetflix,subscriptions,0,ended,cash,2026-10-01,Cancelled\n"
        r = self.build(monthly("NETFLIX.COM", 19.98, "subscriptions", account="Card", start=date(2026, 3, 28)), manual=manual)
        self.assertEqual(self.item(r, "Netflix")["status"], "stopped?")
        self.assertEqual(r["monthly_all"], 0)

    def test_weekly_payment_uses_the_run_rate_without_one_off_gifts(self):
        weeks = [date(2026, 4, 5) + timedelta(days=7 * k) for k in range(20)]
        txns = [txn(d, 100, "PayNow To: SAMPLE CHARITY OTHR Weekly", "donations") for d in weeks]
        txns.append(txn(date(2026, 7, 19), 1000, "PayNow To: SAMPLE CHARITY OTHR Gift", "donations"))
        g = self.item(self.build(txns, payees="pattern,name\nSAMPLE CHARITY,Weekly giving\n"), "Weekly giving")
        self.assertEqual(g["cadence"], "weekly")
        self.assertTrue(400 <= g["monthly"] <= 460, g["monthly"])


if __name__ == "__main__":
    unittest.main()
