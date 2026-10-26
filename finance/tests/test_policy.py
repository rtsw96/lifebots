"""Tests for your own investment rules held against positions (all optional, none by default)."""

from __future__ import annotations

import unittest
from datetime import date
from pathlib import Path

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import policy
from finance.core.model import AssetKind
from finance.portfolio import ValuedPosition

REPO = Path(__file__).resolve().parents[1]
TODAY = date(2026, 9, 25)


def _pos(symbol: str, value: float, account: str = "Broker", qty: float = 1, cost: float = None) -> ValuedPosition:
    cost = value if cost is None else cost
    return ValuedPosition(
        account_id=account, instrument_id=f"{symbol}@X", symbol=symbol, name=symbol,
        kind=AssetKind.LISTED, currency="SGD", quantity=qty, mark=10.0,
        market_value_local=value, market_value_base=value,
        cost_basis_local=cost, cost_basis_base=cost, mark_source="test")


def _fact(symbol: str, holdings, weight, as_of=TODAY, asset_class="equity"):
    return policy.EtfFact(symbol, asset_class=asset_class, holdings=holdings,
                          top_issuer="Top", top_issuer_weight=weight, as_of=as_of)


RULES = policy.Policy(
    min_holdings=30, max_single_issuer_weight=0.20,
    restricted=[policy.Restricted("Example Corp", ["EXMP", "EXMP.L"], "employer rule")],
    locked={"LOCK": "lock-up"},
    exempt_asset_classes=["commodity"])
OWNERSHIP = {"Broker": "SELF", "Joint": "JOINT"}


def _codes(positions, facts):
    return {i.code: i for i in policy.check(positions, facts, RULES, TODAY, OWNERSHIP)}


class ScreenTests(unittest.TestCase):
    def test_passes_inside_both_limits(self):
        self.assertEqual(policy.screen(_fact("A", 30, 0.20), RULES), [])

    def test_too_few_holdings(self):
        self.assertIn("29 holdings", policy.screen(_fact("A", 29, 0.10), RULES)[0])

    def test_issuer_above_cap(self):
        self.assertTrue(policy.screen(_fact("A", 100, 0.2001), RULES))

    def test_missing_facts_are_not_a_pass(self):
        self.assertEqual(policy.screen(_fact("A", None, None), RULES),
                         ["facts missing"])

    def test_commodity_trust_exempt(self):
        self.assertEqual(
            policy.screen(_fact("G", 1, 1.0, asset_class="commodity"), RULES), [])

    def test_equity_only_scope_exempts_bond_funds(self):
        equity_only = policy.Policy(min_holdings=30, max_single_issuer_weight=0.20,
                                    applies_to_asset_classes=["equity"])
        bond = _fact("BND", 40, 1.0, asset_class="bond")  # one issuer: a government
        self.assertEqual(policy.screen(bond, equity_only), [])
        self.assertTrue(policy.screen(_fact("E", 24, 0.26), equity_only))
        self.assertTrue(equity_only.etf_rule_applies(""))  # unknown counts as equity

    def test_no_rule_no_screen(self):
        self.assertEqual(policy.screen(_fact("A", 2, 0.9), policy.Policy()), [])
        self.assertEqual(policy.near_limit(_fact("A", 2, 0.9), policy.Policy()), [])


class CheckTests(unittest.TestCase):
    def test_breach_is_an_error(self):
        issue = _codes([_pos("BAD", 5000)], {"BAD": _fact("BAD", 24, 0.26)})["ETF_BREACH"]
        self.assertEqual(issue.severity, "error")
        self.assertIn("24 holdings", issue.detail)

    def test_locked_breach_is_reported_not_errored(self):
        codes = _codes([_pos("LOCK", 5000)], {"LOCK": _fact("LOCK", 24, 0.26)})
        self.assertNotIn("ETF_BREACH", codes)
        self.assertEqual(codes["LOCKED_BREACH"].severity, "warning")

    def test_near_limit_flagged(self):
        codes = _codes([_pos("NEAR", 5000)], {"NEAR": _fact("NEAR", 34, 0.10)})
        self.assertIn("ETF_NEAR_LIMIT", codes)

    def test_stale_facts_flagged(self):
        old = _fact("OLD", 100, 0.05, as_of=date(2026, 1, 1))
        self.assertIn("ETF_FACTS_STALE", _codes([_pos("OLD", 5000)], {"OLD": old}))

    def test_joint_account_out_of_scope(self):
        codes = _codes([_pos("BAD", 5000, account="Joint")],
                       {"BAD": _fact("BAD", 24, 0.26)})
        self.assertEqual(codes, {})

    def test_restricted_name_held_directly(self):
        self.assertEqual(_codes([_pos("EXMP", 5000)], {})["RESTRICTED_HELD"].severity,
                         "error")

    def test_dust_ignored(self):
        self.assertEqual(_codes([_pos("BAD", 50)], {"BAD": _fact("BAD", 24, 0.26)}), {})

    def test_accounts_aggregate(self):
        """Two small lots of one fund are one holding, not two pieces of dust."""
        codes = _codes([_pos("BAD", 600), _pos("BAD", 600, account="Broker")],
                       {"BAD": _fact("BAD", 24, 0.26)})
        self.assertIn("ETF_BREACH", codes)


class ShippedPolicyTests(unittest.TestCase):
    def test_shipped_policy_is_an_empty_template(self):
        rules = policy.Policy.from_json(REPO / "data" / "reference" / "investment_policy.json")
        self.assertTrue(rules.is_empty)
        self.assertFalse(rules.etf_rule)
        self.assertEqual(rules.describe(), [])
        self.assertAlmostEqual(rules.average_down_tolerance, 0.03)

    def test_empty_policy_passes_everything(self):
        rules = policy.Policy.from_json(REPO / "data" / "reference" / "investment_policy.json")
        issues = policy.check([_pos("BAD", 5000), _pos("EXMP", 5000)],
                              {"BAD": _fact("BAD", 2, 0.9)}, rules, TODAY, OWNERSHIP)
        self.assertEqual(issues, [])

    def test_missing_file_is_an_empty_policy(self):
        self.assertTrue(policy.Policy.from_json(REPO / "no-such-policy.json").is_empty)

    def test_example_block_turns_rules_on(self):
        import json
        import tempfile
        raw = json.loads((REPO / "data" / "reference" / "investment_policy.json").read_text())
        raw.update({k: v for k, v in raw["_example"].items() if not k.startswith("_")})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "p.json"
            path.write_text(json.dumps(raw))
            rules = policy.Policy.from_json(path)
        self.assertEqual((rules.min_holdings, rules.max_single_issuer_weight), (30, 0.20))
        self.assertIn("EXMP2", rules.locked)
        self.assertEqual(len(rules.describe()), 3)

    def test_shipped_facts_are_empty(self):
        self.assertEqual(policy.load_facts(REPO / "data" / "reference" / "etf_facts.csv"), {})


class AddCheckTests(unittest.TestCase):
    def test_new_name_passes(self):
        r = policy.check_add("NEW", 10, [], {}, policy.Policy())
        self.assertTrue(r.allowed)
        self.assertIn("new position", r.notes)

    def test_averaging_down_is_flagged(self):
        held = [_pos("ABC", 800, qty=100, cost=1000)]  # average cost 10
        self.assertTrue(policy.check_add("ABC", 9.8, held, {}, policy.Policy()).allowed)  # within 3%
        r = policy.check_add("ABC@X", 9.0, held, {}, policy.Policy())
        self.assertFalse(r.allowed)
        self.assertIn("averaging down", r.reasons[0])
        self.assertTrue(policy.check_add("ABC", 11, held, {}, policy.Policy()).allowed)

    def test_restricted_and_locked_block(self):
        self.assertFalse(policy.check_add("EXMP", 10, [], {}, RULES).allowed)
        self.assertFalse(policy.check_add("LOCK", 10, [], {}, RULES).allowed)

    def test_etfs_skip_the_average_down_check_but_meet_the_etf_rule(self):
        held = [_pos("FUND", 800, qty=100, cost=1000)]
        facts = {"FUND": _fact("FUND", 100, 0.05)}
        self.assertTrue(policy.check_add("FUND", 5, held, facts, RULES).allowed)
        self.assertFalse(policy.check_add("BAD", 5, [], {"BAD": _fact("BAD", 10, 0.5)}, RULES).allowed)


if __name__ == "__main__":
    unittest.main()
