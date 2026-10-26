"""Your own investment rules, checked against live positions.

Every rule is optional and none is set by default: the shipped
`reference/investment_policy.json` is an empty, documented template. Add the
rules you want to hold yourself to (or ask the bot to). The fund facts the
ETF rule is judged on live in `reference/etf_facts.csv`. Keeping the facts as
data, with an as-of date and a source, matters because they drift: a fund at
18% in its top name passes today and fails after a rally, and a checker with
the numbers baked in would keep passing it.

Four kinds of rule:

- ETF diversification: at least N holdings, and no single issuer above X% of
  assets. Judged by issuer, not by line -- a fund holding a stock and a swap
  on the same stock is as concentrated as the sum. It covers equity ETFs
  only (`applies_to_asset_classes`); bond, commodity and other non-equity
  funds are outside it. A fund with no facts row is treated as equity until
  shown otherwise.
- Restricted single names: may not be held directly (for example a
  name your employer bars you from holding).
- Locked positions: held but not tradeable. Reported, never "fixed" -- a
  locked breach is something to know about, not something to act on.
- Averaging down: `finance addcheck` flags a buy of a single name more than
  `averaging_down.warn_below_cost` (default 3%) below your average cost, so
  adding to a loser is a decision you make on purpose.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

from .portfolio import ValuedPosition


@dataclass
class Restricted:
    name: str
    instrument_ids: List[str]
    reason: str = ""


@dataclass
class Policy:
    applies_to_ownership: List[str] = field(default_factory=lambda: ["SELF"])
    # The ETF diversification rule is off unless one of these is set.
    min_holdings: Optional[int] = None
    max_single_issuer_weight: Optional[float] = None
    facts_max_age_days: int = 120
    # Asset classes the ETF rule covers. Empty means "all, minus exempt".
    applies_to_asset_classes: List[str] = field(default_factory=list)
    exempt_asset_classes: List[str] = field(default_factory=list)
    headroom_weight: float = 0.03
    headroom_holdings: int = 5
    restricted: List[Restricted] = field(default_factory=list)
    locked: Dict[str, str] = field(default_factory=dict)
    average_down_tolerance: float = 0.03

    @property
    def etf_rule(self) -> bool:
        return self.min_holdings is not None or self.max_single_issuer_weight is not None

    @property
    def is_empty(self) -> bool:
        return not (self.etf_rule or self.restricted or self.locked)

    @classmethod
    def from_json(cls, path: Path) -> "Policy":
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        etf = raw.get("etf") or {}
        mh, mw = etf.get("min_holdings"), etf.get("max_single_issuer_weight")
        return cls(
            applies_to_ownership=[o.upper() for o in
                                  raw.get("applies_to_ownership", ["SELF"])],
            min_holdings=int(mh) if mh is not None else None,
            max_single_issuer_weight=float(mw) if mw is not None else None,
            facts_max_age_days=int(etf.get("facts_max_age_days", 120)),
            applies_to_asset_classes=[c.lower() for c in etf.get("applies_to_asset_classes", [])],
            exempt_asset_classes=[c.lower() for c in etf.get("exempt_asset_classes", [])],
            headroom_weight=float(etf.get("headroom_weight", 0.03)),
            headroom_holdings=int(etf.get("headroom_holdings", 5)),
            restricted=[Restricted(r["name"], list(r.get("instrument_ids", [])),
                                   r.get("reason", ""))
                        for r in raw.get("restricted_single_names", [])],
            locked={r["instrument_id"]: r.get("reason", "")
                    for r in raw.get("locked", [])},
            average_down_tolerance=float((raw.get("averaging_down") or {}).get("warn_below_cost", 0.03)),
        )

    def describe(self) -> List[str]:
        """The rules in force, one line each (empty when none are set)."""
        out = []
        if self.etf_rule:
            parts = []
            if self.min_holdings is not None:
                parts.append(f">= {self.min_holdings} holdings")
            if self.max_single_issuer_weight is not None:
                parts.append(f"no issuer above {self.max_single_issuer_weight:.0%}")
            scope = ", ".join(self.applies_to_asset_classes) or "all"
            out.append(f"ETF rule: {' and '.join(parts)} ({scope} funds; "
                       f"{', '.join(self.applies_to_ownership)} accounts)")
        for r in self.restricted:
            out.append(f"Restricted: {r.name} ({', '.join(r.instrument_ids)})")
        for k, why in self.locked.items():
            out.append(f"Locked: {k}" + (f" ({why})" if why else ""))
        return out

    def etf_rule_applies(self, asset_class: str) -> bool:
        asset_class = (asset_class or "equity").lower()
        if self.applies_to_asset_classes:
            return asset_class in self.applies_to_asset_classes
        return asset_class not in self.exempt_asset_classes


@dataclass
class EtfFact:
    instrument_id: str
    name: str = ""
    asset_class: str = "equity"
    domicile: str = ""
    holdings: Optional[int] = None
    top_issuer: str = ""
    top_issuer_weight: Optional[float] = None
    as_of: Optional[date] = None
    source: str = ""
    note: str = ""

    @property
    def is_complete(self) -> bool:
        return self.holdings is not None and self.top_issuer_weight is not None


@dataclass
class PolicyIssue:
    severity: str      # "error" | "warning" | "info"
    code: str
    instrument_id: str
    detail: str
    value: float = 0.0


def _opt_int(value: str) -> Optional[int]:
    value = (value or "").strip().replace(",", "")
    return int(value) if value else None


def _opt_float(value: str) -> Optional[float]:
    value = (value or "").strip()
    return float(value) if value else None


def load_facts(path: Path) -> Dict[str, EtfFact]:
    if not path.exists():
        return {}
    out: Dict[str, EtfFact] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            as_of = (row.get("as_of") or "").strip()
            fact = EtfFact(
                instrument_id=row["instrument_id"].strip(),
                name=row.get("name", "").strip(),
                asset_class=(row.get("asset_class") or "equity").strip().lower(),
                domicile=row.get("domicile", "").strip(),
                holdings=_opt_int(row.get("holdings", "")),
                top_issuer=row.get("top_issuer", "").strip(),
                top_issuer_weight=_opt_float(row.get("top_issuer_weight", "")),
                as_of=date.fromisoformat(as_of) if as_of else None,
                source=row.get("source", "").strip(),
                note=row.get("note", "").strip(),
            )
            out[fact.instrument_id] = fact
    return out


def screen(fact: EtfFact, policy: Policy) -> List[str]:
    """Reasons the fund fails the diversification rule; empty if it passes.

    Missing facts are not a pass. A fund nobody has checked is unknown, and
    returning [] for it would read as compliant.
    """
    if not policy.etf_rule or not policy.etf_rule_applies(fact.asset_class):
        return []
    if not fact.is_complete:
        return ["facts missing"]
    failures = []
    if policy.min_holdings is not None and fact.holdings < policy.min_holdings:
        failures.append(f"{fact.holdings} holdings (< {policy.min_holdings})")
    if policy.max_single_issuer_weight is not None and fact.top_issuer_weight > policy.max_single_issuer_weight:
        failures.append(f"{fact.top_issuer} {fact.top_issuer_weight:.1%} "
                        f"(> {policy.max_single_issuer_weight:.0%})")
    return failures


def near_limit(fact: EtfFact, policy: Policy) -> List[str]:
    """What is within headroom of a limit, for a fund that currently passes.

    A fund at 19% in one name passes today and fails on the next rally; better
    to hear about it before the breach than after.
    """
    if not policy.etf_rule or not fact.is_complete or not policy.etf_rule_applies(fact.asset_class):
        return []
    near = []
    if policy.max_single_issuer_weight is not None and fact.top_issuer_weight > (
            policy.max_single_issuer_weight - policy.headroom_weight):
        near.append(f"{fact.top_issuer} {fact.top_issuer_weight:.1%}")
    if policy.min_holdings is not None and fact.holdings < policy.min_holdings + policy.headroom_holdings:
        near.append(f"{fact.holdings} holdings")
    return near


def _bare(instrument_id: str) -> str:
    return instrument_id.split("@")[0]


def check(positions: Sequence[ValuedPosition],
          facts: Dict[str, EtfFact],
          policy: Policy,
          as_of: date,
          ownership: Dict[str, str],
          min_value: float = 1000.0) -> List[PolicyIssue]:
    """Hold the policy against what is actually held.

    `ownership` maps account_id to its ownership class; only accounts in
    `policy.applies_to_ownership` are in scope (a family or joint account you
    track is not bound by your rules). Holdings below `min_value` are
    skipped, as dust.
    """
    held: Dict[str, float] = {}
    for p in positions:
        if ownership.get(p.account_id, "").upper() not in policy.applies_to_ownership:
            continue
        held[_bare(p.instrument_id)] = held.get(_bare(p.instrument_id), 0.0) \
            + p.market_value_base

    issues: List[PolicyIssue] = []
    restricted_ids = {i: r for r in policy.restricted for i in r.instrument_ids}

    for key, value in held.items():
        if key in restricted_ids:
            r = restricted_ids[key]
            issues.append(PolicyIssue(
                "error", "RESTRICTED_HELD", key,
                f"{r.name} is restricted on this book. {r.reason}".strip(), value))

        fact = facts.get(key)
        if fact is None or value < min_value or not policy.etf_rule:
            continue
        if not policy.etf_rule_applies(fact.asset_class):
            issues.append(PolicyIssue(
                "info", "ETF_EXEMPT", key,
                f"{fact.asset_class} fund, outside the diversification rule "
                "(equity ETFs only)",
                value))
            continue

        failures = screen(fact, policy)
        locked = key in policy.locked
        if failures == ["facts missing"]:
            issues.append(PolicyIssue(
                "warning", "ETF_FACTS_MISSING", key,
                "no holdings count or top-issuer weight in etf_facts.csv", value))
            continue
        if failures:
            if locked:
                issues.append(PolicyIssue(
                    "warning", "LOCKED_BREACH", key,
                    "; ".join(failures)
                    + f" -- locked ({policy.locked[key]})", value))
            else:
                issues.append(PolicyIssue(
                    "error", "ETF_BREACH", key, "; ".join(failures), value))
        else:
            near = near_limit(fact, policy)
            if near:
                issues.append(PolicyIssue(
                    "info", "ETF_NEAR_LIMIT", key,
                    "close to the limit: " + ", ".join(near), value))

        if fact.as_of is None or (as_of - fact.as_of).days > policy.facts_max_age_days:
            age = "undated" if fact.as_of is None else f"{(as_of - fact.as_of).days}d old"
            issues.append(PolicyIssue(
                "warning", "ETF_FACTS_STALE", key,
                f"facts {age}; re-check holdings", value))

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: (order[i.severity], -i.value))
    return issues


def candidates(facts: Dict[str, EtfFact], held: Iterable[str],
               policy: Policy) -> List[tuple]:
    """(fact, failures) for funds on file that are not held -- the screen."""
    held = set(held)
    return [(f, screen(f, policy)) for k, f in sorted(facts.items())
            if k not in held]


@dataclass
class AddCheck:
    instrument_id: str
    allowed: bool
    reasons: List[str]
    notes: List[str]


def check_add(instrument_id: str, price: float, positions: Sequence[ValuedPosition],
              facts: Dict[str, EtfFact], policy: Policy) -> AddCheck:
    """Before buying more: does the buy break a rule, and is it averaging down?

    `positions` are the in-scope holdings (your own accounts). Blocks on a
    restricted or locked name and on an ETF that fails your ETF rule. For a
    single name already held, a price more than `policy.average_down_tolerance`
    below the average cost is flagged too: adding to a loser should be a
    decision made on purpose, with the reason you bought re-checked first.
    """
    bare = _bare(instrument_id)
    reasons: List[str] = []
    notes: List[str] = []
    for r in policy.restricted:
        if bare in r.instrument_ids:
            reasons.append(f"{r.name} is restricted by your policy. {r.reason}".strip())
    if bare in policy.locked:
        reasons.append(f"{bare} is locked by your policy: don't trade it. {policy.locked[bare]}".strip())
    fact = facts.get(bare)
    if fact is not None:
        failures = screen(fact, policy)
        if failures:
            reasons.append("ETF rule: " + "; ".join(failures))
        else:
            notes.append("ETF: averaging down is not checked for funds" +
                         ("; it passes your ETF rule" if policy.etf_rule and policy.etf_rule_applies(fact.asset_class) else ""))
        return AddCheck(bare, not reasons, reasons, notes)
    held = [p for p in positions if _bare(p.instrument_id) == bare and p.quantity > 0]
    if not held:
        notes.append("new position")
        return AddCheck(bare, not reasons, reasons, notes)
    qty = sum(p.quantity for p in held)
    avg = sum(p.cost_basis_local for p in held) / qty
    notes.append(f"held {qty:,.6g} at average cost {avg:,.6g}; proposed price {price:,.6g} "
                 f"({(price / avg - 1) * 100:+.0f}%)")
    if price < avg * (1 - policy.average_down_tolerance):
        reasons.append(f"averaging down: {(1 - price / avg) * 100:.0f}% below your average cost. "
                       "Check the reason you bought still holds before adding.")
    return AddCheck(bare, not reasons, reasons, notes)
