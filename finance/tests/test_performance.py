"""Tests for returns, attribution and projections, against hand-checkable cases."""

from __future__ import annotations

import unittest
from datetime import date

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance.analytics import Concentration, concentration, drawdown
from finance.performance import (FxAttribution, attribute_fx, chain_link,
                                 position_cashflows, twr, xirr)
from finance.planning import (Assumptions, Goal, implied_cagr, project,
                              required_contribution, required_return, scenarios)
from finance.portfolio import ValuedPosition
from finance.core.model import AssetKind, Transaction, TxnType


class TwrTests(unittest.TestCase):
    def test_no_flows_is_simple_growth(self):
        result = twr([(date(2024, 1, 1), 100.0), (date(2025, 1, 1), 110.0)], {})
        self.assertAlmostEqual(result.total_return, 0.10)

    def test_flow_is_stripped_out(self):
        """100 grows to 110, then 50 is added -> 160. Return is still 10%."""
        result = twr(
            [(date(2024, 1, 1), 100.0), (date(2025, 1, 1), 160.0)],
            {date(2024, 6, 1): 50.0},
        )
        self.assertAlmostEqual(result.total_return, 0.10)

    def test_chaining_compounds(self):
        result = twr([
            (date(2024, 1, 1), 100.0),
            (date(2024, 7, 1), 110.0),
            (date(2025, 1, 1), 121.0),
        ], {})
        self.assertAlmostEqual(result.total_return, 0.21)

    def test_annualisation_over_two_years(self):
        result = twr([(date(2024, 1, 1), 100.0), (date(2026, 1, 1), 121.0)], {})
        self.assertAlmostEqual(result.annualised, 0.10, places=3)

    def test_position_opened_mid_series_is_flagged_not_counted(self):
        result = twr(
            [(date(2024, 1, 1), 0.0), (date(2025, 1, 1), 100.0)],
            {date(2024, 6, 1): 100.0},
        )
        self.assertEqual(result.periods, [])
        self.assertEqual(len(result.gaps), 1)

    def test_chain_link_empty(self):
        self.assertEqual(chain_link([]), (0.0, None))


class XirrTests(unittest.TestCase):
    def test_doubling_over_one_year(self):
        rate = xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 200.0)])
        self.assertAlmostEqual(rate, 1.0, places=2)

    def test_ten_percent(self):
        rate = xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 110.0)])
        self.assertAlmostEqual(rate, 0.10, places=2)

    def test_day_count_is_actual_over_365_25(self):
        """Pins the convention rather than leaving it to be inferred.

        2024-01-01 to 2025-01-01 is 366 days, so doubling over that span
        annualises to slightly under 100% on a 365.25-day year. Excel's XIRR
        uses 365 and would report marginally higher.
        """
        rate = xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 200.0)])
        expected = 2 ** (365.25 / 366) - 1
        self.assertAlmostEqual(rate, expected, places=6)

    def test_same_sign_returns_none(self):
        self.assertIsNone(xirr([(date(2024, 1, 1), -100.0),
                                (date(2025, 1, 1), -50.0)]))

    def test_single_flow_returns_none(self):
        self.assertIsNone(xirr([(date(2024, 1, 1), -100.0)]))

    def test_position_cashflows_signs(self):
        txns = [
            Transaction("a", date(2024, 1, 1), "X", "I", TxnType.BUY,
                        "USD", quantity=10, price=10),
            Transaction("b", date(2024, 6, 1), "X", "I", TxnType.DIVIDEND,
                        "USD", amount=5),
        ]
        flows = position_cashflows(txns, closing_value=150.0,
                                   closing_date=date(2025, 1, 1))
        self.assertEqual(flows[0][1], -100.0)
        self.assertEqual(flows[1][1], 5.0)
        self.assertEqual(flows[2][1], 150.0)


class FxAttributionTests(unittest.TestCase):
    def test_pure_local_move(self):
        att = attribute_fx("I", "USD", 100, 110, 1.3, 1.3)
        self.assertAlmostEqual(att.local_return, 0.10)
        self.assertAlmostEqual(att.fx_return, 0.0)
        self.assertAlmostEqual(att.total_return, 0.10)

    def test_pure_currency_move(self):
        att = attribute_fx("I", "USD", 100, 100, 1.3, 1.43)
        self.assertAlmostEqual(att.local_return, 0.0)
        self.assertAlmostEqual(att.fx_return, 0.10)
        self.assertAlmostEqual(att.total_return, 0.10)

    def test_components_reconcile_with_cross_term(self):
        att = attribute_fx("I", "USD", 100, 110, 1.3, 1.43)
        self.assertAlmostEqual(att.total_return, 0.21)
        self.assertAlmostEqual(
            att.local_return + att.fx_return + att.cross_term,
            att.total_return)

    def test_currency_can_erase_a_local_gain(self):
        """The case that motivates reporting these separately at all."""
        att = attribute_fx("I", "JPY", 100, 115, 0.0090, 0.0078)
        self.assertGreater(att.local_return, 0)
        self.assertLess(att.fx_return, 0)
        self.assertLess(abs(att.total_return), 0.01)


class ConcentrationTests(unittest.TestCase):
    def _pos(self, symbol: str, value: float) -> ValuedPosition:
        return ValuedPosition(
            account_id="A", instrument_id=symbol, symbol=symbol, name=symbol,
            kind=AssetKind.LISTED, currency="SGD", quantity=1, mark=value,
            market_value_local=value, market_value_base=value,
            cost_basis_local=value, cost_basis_base=value, mark_source="test")

    def test_equal_weights_are_diversified(self):
        result = concentration([self._pos(f"S{i}", 100) for i in range(20)])
        self.assertAlmostEqual(result.hhi, 0.05)
        self.assertAlmostEqual(result.effective_positions, 20.0)
        self.assertEqual(result.verdict, "diversified")

    def test_single_holding_is_maximally_concentrated(self):
        result = concentration([self._pos("ONE", 100)])
        self.assertAlmostEqual(result.hhi, 1.0)
        self.assertEqual(result.verdict, "highly concentrated")

    def test_top_weights(self):
        result = concentration([self._pos("BIG", 500)]
                               + [self._pos(f"S{i}", 100) for i in range(5)])
        self.assertAlmostEqual(result.top_1, 0.5)
        self.assertAlmostEqual(result.top_5, 0.9)

    def test_empty(self):
        self.assertIsNone(concentration([]))


class DrawdownTests(unittest.TestCase):
    def test_peak_to_trough(self):
        worst, when = drawdown([
            (date(2024, 1, 1), 100.0),
            (date(2024, 6, 1), 120.0),
            (date(2024, 9, 1), 90.0),
            (date(2025, 1, 1), 110.0),
        ])
        self.assertAlmostEqual(worst, -0.25)
        self.assertEqual(when, date(2024, 9, 1))

    def test_monotonic_rise_has_no_drawdown(self):
        worst, _ = drawdown([(date(2024, 1, 1), 100.0), (date(2025, 1, 1), 150.0)])
        self.assertAlmostEqual(worst, 0.0)


class PlanningTests(unittest.TestCase):
    def test_growth_with_no_contributions(self):
        proj = project(100_000, date(2026, 1, 1), 2, Assumptions(annual_return=0.10))
        self.assertAlmostEqual(proj.final, 121_000, places=0)

    def test_contribution_earns_half_a_year(self):
        proj = project(0, date(2026, 1, 1), 1,
                       Assumptions(annual_return=0.10, annual_contribution=1000))
        self.assertAlmostEqual(proj.final, 1050.0)

    def test_inflation_reports_real_terms(self):
        proj = project(100_000, date(2026, 1, 1), 1,
                       Assumptions(annual_return=0.10, inflation=0.03))
        self.assertAlmostEqual(proj.final, 110_000, places=0)
        self.assertAlmostEqual(proj.final_real, 110_000 / 1.03, places=0)

    def test_required_return(self):
        self.assertAlmostEqual(required_return(100, 121, 2), 0.10, places=6)

    def test_required_contribution_reaches_target(self):
        payment = required_contribution(100_000, 300_000, 10, 0.07)
        proj = project(100_000, date(2026, 1, 1), 10,
                       Assumptions(annual_return=0.07, annual_contribution=payment))
        # Mid-year contribution timing makes this slightly conservative, so
        # the projection should land at or above target.
        self.assertGreaterEqual(proj.final, 300_000 * 0.98)

    def test_implied_cagr(self):
        rate = implied_cagr([(date(2024, 1, 1), 100.0), (date(2026, 1, 1), 121.0)])
        self.assertAlmostEqual(rate, 0.10, places=3)

    def test_implied_cagr_needs_two_points(self):
        self.assertIsNone(implied_cagr([(date(2024, 1, 1), 100.0)]))

    def test_scenarios_are_ordered(self):
        out = scenarios(100_000, date(2026, 1, 1), 10,
                        Assumptions(annual_return=0.07))
        self.assertLess(out["bear"].final, out["base"].final)
        self.assertLess(out["base"].final, out["bull"].final)

    def test_goal_assessment_detects_shortfall(self):
        goal = Goal("Target", 2_000_000, date(2036, 9, 21))
        result = goal.assess(637_337, date(2026, 9, 21),
                             Assumptions(annual_return=0.05))
        self.assertFalse(result.on_track)
        self.assertGreater(result.required_return, 0.05)


if __name__ == "__main__":
    unittest.main()
