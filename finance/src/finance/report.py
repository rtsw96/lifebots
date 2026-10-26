"""Rendering and the net-worth series.

Net worth CAGR is the headline metric, so the series it needs starts
accumulating from the first run -- even before historical prices are
backfilled. One row per run, appended, never rewritten.
"""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .portfolio import Snapshot


def _fmt(value: float, dp: int = 0) -> str:
    return f"{value:,.{dp}f}"


def _price(value: float) -> str:
    """Prices span fractions of a unit (a penny stock) to six figures (a
    property), so a single format spec either loses precision at the bottom
    or goes exponential at the top."""
    if value == 0:
        return "—"
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    if abs(value) >= 1:
        return f"{value:,.2f}"
    return f"{value:,.4f}"


def append_networth(snapshot: Snapshot, path: Path) -> None:
    """Append today's net worth. Re-running on the same day overwrites that day."""
    rows: List[dict] = []
    if path.exists():
        with path.open(newline="", encoding="utf-8") as fh:
            rows = [r for r in csv.DictReader(fh)
                    if r["date"] != snapshot.as_of.isoformat()]
    rows.append({
        "date": snapshot.as_of.isoformat(),
        "net_worth": f"{snapshot.net_worth:.2f}",
        "securities": f"{snapshot.securities_value:.2f}",
        "cash": f"{snapshot.cash_value:.2f}",
        "currency": snapshot.base_currency,
    })
    rows.sort(key=lambda r: r["date"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["date", "net_worth", "securities", "cash", "currency"])
        writer.writeheader()
        writer.writerows(rows)


def networth_cagr(path: Path) -> Optional[Tuple[float, float, int]]:
    """(cagr, total_return, days) between the first and last observation."""
    if not path.exists():
        return None
    with path.open(newline="", encoding="utf-8") as fh:
        rows = sorted(csv.DictReader(fh), key=lambda r: r["date"])
    if len(rows) < 2:
        return None
    first, last = rows[0], rows[-1]
    start, end = float(first["net_worth"]), float(last["net_worth"])
    days = (date.fromisoformat(last["date"]) - date.fromisoformat(first["date"])).days
    if days <= 0 or start <= 0:
        return None
    total = end / start - 1.0
    cagr = (end / start) ** (365.25 / days) - 1.0
    return cagr, total, days


def render(snapshot: Snapshot, history: Optional[Path] = None) -> str:
    base = snapshot.base_currency
    out: List[str] = []
    add = out.append

    add(f"# Portfolio snapshot — {snapshot.as_of.isoformat()}")
    add("")
    add(f"**Net worth: {base} {_fmt(snapshot.net_worth)}**  ")
    add(f"Securities {base} {_fmt(snapshot.securities_value)} · "
        f"Cash {base} {_fmt(snapshot.cash_value)}")
    add("")

    if history:
        cagr = networth_cagr(history)
        if cagr:
            rate, total, days = cagr
            add(f"Net worth CAGR: **{rate * 100:.2f}%** "
                f"({total * 100:+.2f}% over {days} days)")
        else:
            add("_Net worth CAGR: needs a second observation — the series starts today._")
        add("")

    add("## By asset kind")
    add("")
    add(f"| Kind | {base} | Share |")
    add("| --- | ---: | ---: |")
    total = snapshot.net_worth or 1.0
    for kind, value in sorted(snapshot.by_kind().items(), key=lambda x: -x[1]):
        add(f"| {kind} | {_fmt(value)} | {value / total * 100:.1f}% |")
    add("")

    add("## By account")
    add("")
    add(f"| Account | {base} |")
    add("| --- | ---: |")
    for acct, value in sorted(snapshot.by_account().items(), key=lambda x: -x[1]):
        add(f"| {acct} | {_fmt(value)} |")
    add("")

    add("## By currency")
    add("")
    add(f"| Currency | {base} | Share |")
    add("| --- | ---: | ---: |")
    for ccy, value in sorted(snapshot.by_currency().items(), key=lambda x: -x[1]):
        add(f"| {ccy} | {_fmt(value)} | {value / total * 100:.1f}% |")
    add("")

    add("## Positions")
    add("")
    add(f"| Account | Symbol | Kind | Qty | Mark | {base} | Cost | Unreal. | Mark src |")
    add("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
    for p in snapshot.positions:
        # Unmarked positions value at zero, which would show the entire cost
        # as a loss. They are unvalued, not down 100%.
        unreal = _fmt(p.unrealised) if p.is_marked else "n/m"
        add(f"| {p.account_id} | {p.symbol} | {p.kind.value} | {p.quantity:,.6g} | "
            f"{_price(p.mark)} | {_fmt(p.market_value_base)} | "
            f"{_fmt(p.cost_basis_base)} | {unreal} | {p.mark_source} |")
    add("")

    if snapshot.cash:
        add("## Cash")
        add("")
        add("| Account | Currency | Balance |")
        add("| --- | --- | ---: |")
        for (acct, ccy), bal in sorted(snapshot.cash.items()):
            if abs(bal) < 0.01:
                continue
            flag = "  ⚠ negative" if bal < 0 else ""
            add(f"| {acct} | {ccy} | {_fmt(bal, 2)}{flag} |")
        add("")

    if snapshot.income_by_type:
        add("## Income recorded")
        add("")
        unvalued = sum(p.unvalued_receipts for p in snapshot.positions)
        holders = sum(1 for p in snapshot.positions if p.unvalued_receipts)
        for kind, by_ccy in sorted(snapshot.income_by_type.items()):
            parts = ", ".join(f"{c} {_fmt(v, 2)}"
                              for c, v in sorted(by_ccy.items()) if v)
            if kind == "PREMIUM_INCOME" and not parts:
                add("- **PREMIUM_INCOME**: received in kind, not yet valued "
                    "— needs receipt-date prices")
            else:
                add(f"- **{kind}**: {parts or 'none recorded'}")
        if unvalued:
            add(f"- {unvalued} unvalued receipt(s) sit in {holders} open "
                f"position(s); the rest were received into positions since closed.")
        add("")

    add("## Reconciliation")
    add("")
    errors = [i for i in snapshot.issues if i.severity == "error"]
    warnings = [i for i in snapshot.issues if i.severity == "warning"]
    negative = snapshot.unexplained_negative_cash()

    # Counted the same way `check` counts them, so the two never disagree.
    add(f"{len(errors) + len(negative)} error(s), "
        f"{len(warnings) + (1 if snapshot.unmarked else 0)} warning(s)")
    add("")
    for issue in errors:
        add(f"- `ERROR` **{issue.code}** "
            f"{issue.account_id}/{issue.instrument_id} {issue.when}: {issue.detail}")
    for (acct, ccy), bal in negative:
        add(f"- `ERROR` **NEGATIVE_CASH** {acct}/{ccy}: {_fmt(bal, 2)} — "
            f"deposits were never keyed in; add a row to "
            f"`reference/balance_assertions.csv`")
    for issue in warnings:
        add(f"- `WARNING` **{issue.code}** "
            f"{issue.account_id}/{issue.instrument_id} {issue.when}: {issue.detail}")
    if snapshot.unmarked:
        add(f"- `WARNING` **NO_MARK** {len(snapshot.unmarked)} position(s) "
            f"have no price: {', '.join(snapshot.unmarked)}")
    add("")
    if negative:
        add("> Net worth above is a **floor**: the unconfirmed negative cash is "
            "probably missing deposit history, not an overdraft.")
        add("")
    loans = snapshot.margin_loans()
    if loans:
        add(f"> **Margin loans: {snapshot.base_currency} "
            f"{_fmt(-snapshot.margin_loans_base())}**, confirmed by broker statement "
            f"(" + ", ".join(f"{a}/{c} {_fmt(b, 2)}" for (a, c), b in loans)
            + "). Net worth already deducts them.")
        add("")

    if snapshot.notes:
        add("## Notes")
        add("")
        for note in snapshot.notes:
            add(f"- {note}")
        add("")

    return "\n".join(out)


def write_positions_csv(snapshot: Snapshot, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow([
            "account_id", "instrument_id", "symbol", "kind", "currency",
            "quantity", "mark", "market_value_local", "market_value_base",
            "cost_basis_base", "unrealised_base", "mark_source",
        ])
        for p in snapshot.positions:
            writer.writerow([
                p.account_id, p.instrument_id, p.symbol, p.kind.value, p.currency,
                f"{p.quantity:.10g}", f"{p.mark:.10g}",
                f"{p.market_value_local:.2f}", f"{p.market_value_base:.2f}",
                f"{p.cost_basis_base:.2f}", f"{p.unrealised:.2f}", p.mark_source,
            ])
