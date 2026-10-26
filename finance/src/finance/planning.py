"""Forward projection and goal tracking.

Anchored on net worth CAGR, which is the metric that actually drives
decisions here. Every projection states the assumptions it rests on, because
the inputs -- expected return and annual contribution -- are guesses, and a
projection that hides that reads as a forecast when it is arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Sequence, Tuple


@dataclass
class Assumptions:
    annual_return: float
    annual_contribution: float = 0.0
    contribution_growth: float = 0.0   # contributions rising with income
    inflation: float = 0.0             # >0 reports in today's money

    def describe(self) -> str:
        parts = [f"{self.annual_return * 100:.1f}% return"]
        if self.annual_contribution:
            parts.append(f"{self.annual_contribution:,.0f}/yr added")
        if self.contribution_growth:
            parts.append(f"contributions +{self.contribution_growth * 100:.1f}%/yr")
        if self.inflation:
            parts.append(f"{self.inflation * 100:.1f}% inflation (real terms)")
        return ", ".join(parts)


@dataclass
class ProjectionPoint:
    year: int
    when: date
    opening: float
    contribution: float
    growth: float
    closing: float
    closing_real: float


@dataclass
class Projection:
    start_value: float
    start_date: date
    assumptions: Assumptions
    points: List[ProjectionPoint] = field(default_factory=list)

    @property
    def final(self) -> float:
        return self.points[-1].closing if self.points else self.start_value

    @property
    def final_real(self) -> float:
        return self.points[-1].closing_real if self.points else self.start_value

    @property
    def total_contributed(self) -> float:
        return sum(p.contribution for p in self.points)

    @property
    def total_growth(self) -> float:
        return sum(p.growth for p in self.points)


def project(start_value: float, start_date: date, years: int,
            assumptions: Assumptions) -> Projection:
    """Compound forward, one row per year.

    Contributions are applied mid-year (half a year of growth), which avoids
    the systematic overstatement of assuming they all land on 1 January.
    """
    proj = Projection(start_value=start_value, start_date=start_date,
                      assumptions=assumptions)
    value = start_value
    contribution = assumptions.annual_contribution

    for year in range(1, years + 1):
        opening = value
        growth = (opening * assumptions.annual_return
                  + contribution * assumptions.annual_return / 2.0)
        value = opening + contribution + growth
        deflator = (1.0 + assumptions.inflation) ** year if assumptions.inflation else 1.0
        proj.points.append(ProjectionPoint(
            year=year,
            when=date(start_date.year + year, start_date.month, start_date.day)
            if not (start_date.month == 2 and start_date.day == 29)
            else date(start_date.year + year, 3, 1),
            opening=opening,
            contribution=contribution,
            growth=growth,
            closing=value,
            closing_real=value / deflator,
        ))
        contribution *= (1.0 + assumptions.contribution_growth)
    return proj


@dataclass
class Goal:
    name: str
    target: float
    by: date

    def assess(self, current: float, current_date: date,
               assumptions: Assumptions) -> "GoalAssessment":
        years = max((self.by - current_date).days / 365.25, 0.0)
        proj = project(current, current_date, max(int(round(years)), 1), assumptions)
        projected = proj.final if years >= 1 else current
        required = required_return(current, self.target, years) if years > 0 else None
        return GoalAssessment(
            goal=self, current=current, years=years,
            projected=projected, shortfall=self.target - projected,
            required_return=required,
            required_contribution=required_contribution(
                current, self.target, years, assumptions.annual_return),
        )


@dataclass
class GoalAssessment:
    goal: Goal
    current: float
    years: float
    projected: float
    shortfall: float
    required_return: Optional[float]
    required_contribution: Optional[float]

    @property
    def on_track(self) -> bool:
        return self.shortfall <= 0


def required_return(current: float, target: float, years: float) -> Optional[float]:
    """The CAGR that gets from here to the target with no contributions."""
    if current <= 0 or years <= 0 or target <= 0:
        return None
    return (target / current) ** (1.0 / years) - 1.0


def required_contribution(current: float, target: float, years: float,
                          annual_return: float) -> Optional[float]:
    """Level annual contribution needed, given an assumed return.

    Future value of a growing balance plus an annuity, solved for the payment.
    """
    if years <= 0:
        return None
    n = years
    r = annual_return
    if abs(r) < 1e-9:
        return (target - current) / n
    fv_current = current * (1.0 + r) ** n
    annuity_factor = ((1.0 + r) ** n - 1.0) / r
    needed = target - fv_current
    if annuity_factor <= 0:
        return None
    return needed / annuity_factor


def implied_cagr(series: Sequence[Tuple[date, float]]) -> Optional[float]:
    """CAGR between the first and last observation of a net worth series."""
    ordered = sorted(series, key=lambda item: item[0])
    if len(ordered) < 2:
        return None
    (d0, v0), (d1, v1) = ordered[0], ordered[-1]
    days = (d1 - d0).days
    if days <= 0 or v0 <= 0 or v1 <= 0:
        return None
    return (v1 / v0) ** (365.25 / days) - 1.0


def scenarios(start_value: float, start_date: date, years: int,
              base: Assumptions,
              spread: float = 0.04) -> Dict[str, Projection]:
    """Bear / base / bull around a central return assumption.

    A single projected number invites false precision. Three make the range
    visible without pretending to a distribution nobody can estimate.
    """
    out: Dict[str, Projection] = {}
    for label, delta in (("bear", -spread), ("base", 0.0), ("bull", spread)):
        assumptions = Assumptions(
            annual_return=base.annual_return + delta,
            annual_contribution=base.annual_contribution,
            contribution_growth=base.contribution_growth,
            inflation=base.inflation,
        )
        out[label] = project(start_value, start_date, years, assumptions)
    return out


@dataclass
class MaturityEvent:
    instrument_id: str
    name: str
    when: date
    amount: float
    currency: str

    def days_away(self, from_date: date) -> int:
        return (self.when - from_date).days


def maturity_ladder(events: Sequence[MaturityEvent],
                    from_date: date,
                    horizon: timedelta = timedelta(days=730),
                    ) -> List[MaturityEvent]:
    """Upcoming maturities, nearest first.

    Private credit and bonds return principal on a date. That is cash landing
    in the plan and a reinvestment decision arriving, both of which are easy
    to forget until the week they happen.
    """
    limit = from_date + horizon
    return sorted((e for e in events if from_date <= e.when <= limit),
                  key=lambda e: e.when)
