"""Command line entry point.

    python -m finance snapshot    # report + dashboard + derived outputs
    python -m finance brief       # one-screen summary
    python -m finance check       # reconciliation; non-zero exit on error
    python -m finance dashboard   # regenerate the HTML dashboard only
    python -m finance analyse     # concentration and your tags
    python -m finance plan        # forward projection and goals
    python -m finance spend       # expenditure, once statements are supplied
    python -m finance txn ...     # the bank and card ledger: import, list, category
    python -m finance trade ...   # record a trade, dividend, deposit or withdrawal
    python -m finance policy      # your own rules (empty by default), held against positions
    python -m finance addcheck    # before buying more: rules, and averaging down
    python -m finance ibkr sync   # optional: an IBKR account via its read-only Flex token
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import analytics, dashboard, portfolio, report
from .planning import Assumptions, Goal, implied_cagr, scenarios

DEFAULT_DATA = Path(__file__).resolve().parents[2] / "data"


def _build(args) -> portfolio.Snapshot:
    as_of = date.fromisoformat(args.as_of) if args.as_of else date.today()
    return portfolio.build(Path(args.data), as_of=as_of)


def _history(data: Path) -> List[Tuple[date, float]]:
    path = data / "derived" / "networth_history.csv"
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return [(date.fromisoformat(r["date"]), float(r["net_worth"]))
                for r in csv.DictReader(fh)]


def _extras(args, snapshot: portfolio.Snapshot):
    """Tags and concentration, both optional."""
    ref = Path(args.data) / "reference"
    tags = analytics.TagSet.from_csv(ref / "tags.csv")
    conc = analytics.concentration(snapshot.positions)
    return tags, conc


def cmd_snapshot(args) -> int:
    snap = _build(args)
    data = Path(args.data)
    derived = data / "derived"
    history_path = derived / "networth_history.csv"

    derived.mkdir(parents=True, exist_ok=True)
    report.append_networth(snap, history_path)
    report.write_positions_csv(snap, derived / "positions.csv")
    text = report.render(snap, history_path)
    (derived / "snapshot.md").write_text(text, encoding="utf-8")

    series = _history(data)
    tags, conc = _extras(args, snap)
    dashboard.write(
        snap, derived / "dashboard.html",
        history=series,
        cagr=implied_cagr(series),
        conc=conc, tags=tags,
    )
    print(text)
    print(f"\nDashboard: {derived / 'dashboard.html'}")
    return 0


def cmd_dashboard(args) -> int:
    snap = _build(args)
    data = Path(args.data)
    series = _history(data)
    tags, conc = _extras(args, snap)
    (data / "derived").mkdir(parents=True, exist_ok=True)
    out = dashboard.write(
        snap, data / "derived" / "dashboard.html",
        history=series, cagr=implied_cagr(series),
        conc=conc, tags=tags,
    )
    print(f"Wrote {out}")
    return 0


def cmd_brief(args) -> int:
    snap = _build(args)
    base = snap.base_currency
    print(f"Net worth {base} {snap.net_worth:,.0f} "
          f"(securities {snap.securities_value:,.0f}, cash {snap.cash_value:,.0f})")
    print(f"{len(snap.positions)} positions across "
          f"{len(snap.by_account())} accounts, as of {snap.as_of}")
    for kind, value in sorted(snap.by_kind().items(), key=lambda x: -x[1]):
        print(f"  {kind:<16}{value:>14,.0f}  {value / (snap.net_worth or 1) * 100:5.1f}%")
    errors = [i for i in snap.issues if i.severity == "error"]
    negative = snap.unexplained_negative_cash()
    if snap.margin_loans():
        print(f"Margin loans {base} {snap.margin_loans_base():,.0f} (stated by broker statement)")
    if errors or negative:
        print(f"\n{len(errors) + len(negative)} reconciliation error(s) — run `check`")
    return 0


def cmd_check(args) -> int:
    snap = _build(args)
    errors = [i for i in snap.issues if i.severity == "error"]
    warnings = [i for i in snap.issues if i.severity == "warning"]
    for issue in errors + warnings:
        print(f"{issue.severity.upper():<8}{issue.code:<26}"
              f"{issue.account_id}/{issue.instrument_id} {issue.when}: {issue.detail}")
    for note in snap.notes:
        print(f"NOTE    {note}")
    negative = snap.unexplained_negative_cash()
    for (acct, ccy), bal in negative:
        print(f"ERROR   NEGATIVE_CASH             {acct}/{ccy}: {bal:,.2f} — "
              f"add a row to reference/balance_assertions.csv")
    for (acct, ccy), bal in snap.margin_loans():
        print(f"INFO    MARGIN_LOAN               {acct}/{ccy}: {bal:,.2f} (stated by statement)")
    print(f"\n{len(errors) + len(negative)} error(s), {len(warnings)} warning(s)")
    return 1 if (errors or negative) else 0


def cmd_analyse(args) -> int:
    snap = _build(args)
    tags, conc = _extras(args, snap)
    base = snap.base_currency

    if conc:
        print("CONCENTRATION")
        print(f"  top 1 {conc.top_1 * 100:5.1f}%   top 5 {conc.top_5 * 100:5.1f}%"
              f"   top 10 {conc.top_10 * 100:5.1f}%")
        print(f"  HHI {conc.hhi:.3f} — {conc.verdict} "
              f"({conc.effective_positions:.1f} effective positions)")
        for name, value in conc.largest[:5]:
            print(f"    {name:<34}{value:>12,.0f}")

    if tags and tags.dimensions:
        for dimension in tags.dimensions:
            grouped = sorted(tags.group(snap.positions, dimension).items(),
                             key=lambda x: -x[1])
            if len(grouped) < 2:
                continue
            # Denominator is securities, not net worth: cash carries no tags,
            # and dividing by a net worth depressed by negative cash would
            # push the shares past 100%.
            denominator = snap.securities_value or 1
            print(f"\nBY {dimension.upper()} ({base}, % of securities)")
            for name, value in grouped:
                print(f"  {name:<22}{value:>14,.0f}"
                      f"{value / denominator * 100:>7.1f}%")
    return 0


def cmd_plan(args) -> int:
    snap = _build(args)
    data = Path(args.data)
    series = _history(data)
    base = snap.base_currency
    start = snap.net_worth

    observed = implied_cagr(series)
    if observed is not None:
        print(f"Observed net worth CAGR: {observed * 100:.2f}% "
              f"over {len(series)} observations")
    else:
        print("Observed net worth CAGR: not yet — the series needs a second "
              "observation.")

    base_assumptions = Assumptions(
        annual_return=args.rate,
        annual_contribution=args.contribution,
        inflation=args.inflation,
    )
    print(f"\nAssumptions: {base_assumptions.describe()}")
    print(f"Starting from {base} {start:,.0f} on {snap.as_of}\n")

    outcomes = scenarios(start, snap.as_of, args.years, base_assumptions)
    label_width = 8
    print(f"{'scenario':<{label_width}}{'return':>9}{'final':>16}"
          f"{'real':>16}{'contributed':>14}{'growth':>14}")
    for label in ("bear", "base", "bull"):
        proj = outcomes[label]
        print(f"{label:<{label_width}}"
              f"{proj.assumptions.annual_return * 100:>8.1f}%"
              f"{proj.final:>16,.0f}"
              f"{proj.final_real:>16,.0f}"
              f"{proj.total_contributed:>14,.0f}"
              f"{proj.total_growth:>14,.0f}")

    if args.target:
        goal = Goal("target", args.target,
                    date(snap.as_of.year + args.years, snap.as_of.month,
                         snap.as_of.day))
        assessment = goal.assess(start, snap.as_of, base_assumptions)
        status = ("on track" if assessment.on_track
                  else f"short by {assessment.shortfall:,.0f}")
        print(f"\nGOAL {base} {args.target:,.0f} in {args.years} years")
        print(f"  projected {assessment.projected:,.0f} — {status}")
        if assessment.required_return is not None:
            print(f"  return needed with no contributions: "
                  f"{assessment.required_return * 100:.2f}%")
        if assessment.required_contribution is not None:
            print(f"  or contribute {assessment.required_contribution:,.0f}/yr "
                  f"at {args.rate * 100:.1f}%")

    print("\nProjections are arithmetic on assumed inputs, not forecasts.")
    return 0


def cmd_policy(args) -> int:
    from . import policy as policy_mod

    snap = _build(args)
    base = snap.base_currency
    ref = Path(args.data) / "reference"
    rules = policy_mod.Policy.from_json(ref / "investment_policy.json")
    facts = policy_mod.load_facts(ref / "etf_facts.csv")
    ownership = {k: a.ownership.value if hasattr(a.ownership, "value")
                 else str(a.ownership) for k, a in snap.accounts.items()}

    if rules.is_empty:
        print("No rules set. Add your own to data/reference/investment_policy.json "
              "(the file explains each one), or ask the bot to.")
        return 0
    for line in rules.describe():
        print(line)
    issues = policy_mod.check(snap.positions, facts, rules, snap.as_of, ownership)
    if issues:
        print(f"\n{'':<8}{'code':<20}{'instrument':<12}detail")
        for i in issues:
            value = f"  [{base} {i.value:,.0f}]" if i.value else ""
            print(f"{i.severity.upper():<8}{i.code:<20}{i.instrument_id:<12}"
                  f"{i.detail}{value}")
    else:
        print("\nEverything held passes.")

    held = {p.instrument_id.split("@")[0] for p in snap.positions}
    screened = policy_mod.candidates(facts, held, rules) if rules.etf_rule else []
    if screened:
        print("\nCANDIDATES ON FILE (not held)")
        for fact, failures in screened:
            near = policy_mod.near_limit(fact, rules)
            verdict = ("FAIL: " + "; ".join(failures) if failures else
                       "pass" + (f" (near limit: {', '.join(near)})" if near else ""))
            print(f"  {fact.instrument_id:<10}{fact.holdings or '—':>6} holdings  "
                  f"top {fact.top_issuer or '—'} "
                  f"{(fact.top_issuer_weight or 0):.1%}  {verdict}")
    return 1 if any(i.severity == "error" for i in issues) else 0


def cmd_addcheck(args) -> int:
    from . import policy as policy_mod

    snap = _build(args)
    ref = Path(args.data) / "reference"
    rules = policy_mod.Policy.from_json(ref / "investment_policy.json")
    facts = policy_mod.load_facts(ref / "etf_facts.csv")
    scope = set(rules.applies_to_ownership)
    own = {k for k, a in snap.accounts.items() if str(getattr(a.ownership, "value", a.ownership)).upper() in scope}
    positions = [p for p in snap.positions if p.account_id in own]
    result = policy_mod.check_add(args.instrument, args.price, positions, facts, rules)
    print(f"{result.instrument_id} @ {args.price:,.6g}: {'PASS' if result.allowed else 'CHECK'}")
    for n in result.notes:
        print(f"  · {n}")
    for r in result.reasons:
        print(f"  ✗ {r}")
    return 0 if result.allowed else 1


def cmd_trade(args) -> int:
    from .ingest import trades

    data = Path(args.data)
    ledger = data / "canonical" / "trades.csv"
    accounts = portfolio.load_accounts(data / "reference" / "accounts.csv")
    if args.account not in accounts:
        print(f"Unknown account '{args.account}'. Known: {', '.join(sorted(accounts)) or 'none yet'}. "
              "Add a row to data/reference/accounts.csv first.")
        return 1
    when = date.fromisoformat(args.date) if args.date else date.today()

    # Resolve a bare ticker to the ledger's id (VWRA.L -> VWRA.L@LSE).
    known = set()
    if ledger.exists():
        with ledger.open(newline="", encoding="utf-8") as fh:
            known |= {r["instrument_id"] for r in csv.DictReader(fh)}
    iid = args.instrument
    if iid not in known:
        matches = sorted(k for k in known if k.split("@")[0] == iid)
        if len(matches) == 1:
            iid = matches[0]
        elif len(matches) > 1:
            print(f"'{iid}' is ambiguous: {', '.join(matches)}")
            return 1
        elif "@" not in iid:
            print(f"'{iid}' is new. Give it as SYMBOL@EXCHANGE (e.g. VWRA.L@LSE) with --name.")
            return 1

    kind = args.type.upper()
    row = {"date": when.isoformat(), "account_id": args.account, "instrument_id": iid,
           "type": kind, "quantity": args.quantity, "price": args.price, "amount": args.amount or "",
           "currency": args.currency.upper(), "fees": args.fees or "", "name": args.name or "",
           "note": args.note or ""}
    before = ledger.read_text(encoding="utf-8") if ledger.exists() else None
    trades.append(ledger, row)
    snap = portfolio.build(data, as_of=max(when, date.today()))
    bad = [i for i in snap.issues if i.severity == "error" and i.instrument_id == iid
           and i.account_id == args.account and i.when == when]
    if bad:
        if before is None:
            ledger.unlink()
        else:
            ledger.write_text(before, encoding="utf-8")
        print("Rejected, nothing written:")
        for i in bad:
            print(f"  {i.code}: {i.detail}")
        return 1
    print(f"Recorded: {kind} {args.quantity:g} {iid} @ {args.price:g} {row['currency']} "
          f"on {when} in {args.account}")
    held = [p for p in snap.positions if p.instrument_id == iid and p.account_id == args.account]
    if held:
        p = held[0]
        if p.quantity < 0:
            print(f"Position now short {-p.quantity:,.4g} at average entry "
                  f"{p.cost_basis_local / p.quantity:,.6g} {p.currency}")
        else:
            print(f"Position now {p.quantity:,.4g} at average cost "
                  f"{p.cost_basis_local / p.quantity:,.6g} {p.currency}")
    else:
        print("Position now closed.")
    return 0


def cmd_spend(args) -> int:
    from . import spending

    data = Path(args.data)
    txns = spending.transactions(data)
    if not txns:
        print("No transactions yet. Send a statement to the money bot, or import one:")
        print("  finance txn import --json lines.json --account 'Card A'   (lines the bot extracted)")
        print("  finance txn import --csv export.csv --format generic_signed   (a configured CSV format)")
        return 0
    if args.month:
        txns = [t for t in txns if t.date.isoformat().startswith(args.month)]
    s = spending.summary(txns, months=args.months)
    if args.json:
        print(json.dumps(s, indent=1))
        return 0
    print(f"{len(txns)} transactions, {s['first']} to {s['last']} · categorised {s['coverage'] * 100:.0f}% by value")
    for m in s["months"]:
        rate = f" · savings rate {m['savings_rate'] * 100:.0f}%" if m["savings_rate"] is not None else ""
        odd = (f" · unclassified out {m['unclassified_out']:,.2f} / in {m['unclassified_in']:,.2f}"
               if m["unclassified_out"] or m["unclassified_in"] else "")
        print(f"\n{m['month']}: spend {m['spend']:,.2f} · income {m['income']:,.2f}{rate}{odd}")
        for cat, amt in list(m["categories"].items())[:8]:
            print(f"  {cat:<22}{amt:>12,.2f}")
    left = spending.unmatched(data, txns)
    if left:
        print("\nNO RULE YET (ranked by value — write rules for the top ones)")
        for desc, count, total in left:
            print(f"  {total:>10,.2f}  x{count:<4}{desc}")
    return 0


def cmd_txn(args) -> int:
    from . import spending

    data = Path(args.data)
    if args.txn_cmd == "import":
        if bool(args.json) == bool(args.csv):
            print("Give either --json (lines the bot extracted) or --csv with --format.", file=sys.stderr)
            return 2
        if args.json:
            if not args.account:
                print("--account is needed with --json", file=sys.stderr)
                return 2
            known = spending.accounts(data)
            if known and args.account not in known:
                print(f"Unknown account {args.account!r}. Known: {', '.join(sorted(known))}", file=sys.stderr)
                return 2
            added, skipped = spending.import_json(data, Path(args.json), args.account, args.currency, args.source or "")
        else:
            if not args.format:
                print("--format is needed with --csv", file=sys.stderr)
                return 2
            added, skipped = spending.import_csv(data, Path(args.csv), args.format)
        print(f"added {added} line(s), {skipped} already in the ledger")
        return 0
    if args.txn_cmd == "category":
        ok = spending.set_category(data, args.txn_id, args.category, args.merchant or "")
        print("updated" if ok else f"no transaction {args.txn_id}")
        return 0 if ok else 1
    # list
    txns = spending.transactions(data)
    if args.month:
        txns = [t for t in txns if t.date.isoformat().startswith(args.month)]
    if args.account:
        txns = [t for t in txns if t.account_id == args.account]
    for t in txns[-args.limit:]:
        print(f"{t.txn_id}  {t.date}  {t.account_id:<14}{t.amount:>10,.2f} {t.currency}  "
              f"{(t.category or '-'):<16}{t.description[:60]}")
    return 0


def cmd_ibkr(args) -> int:
    """Pull an IBKR account's Flex statement (optional; read-only token): file new trades
    and closing cash, and list any gap between IBKR's positions and the ledger's."""
    import os

    from .ingest import ibkr_flex as fx, trades

    data = Path(args.data)
    if args.file:
        xml = Path(args.file).read_bytes()
    else:
        token, query = os.environ.get("IBKR_FLEX_TOKEN", ""), os.environ.get("IBKR_FLEX_QUERY_ID", "")
        if not token or not query:
            print("IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID are not set. Add them in the environment "
                  "settings; new sessions pick them up.")
            return 2
        try:
            xml = fx.fetch(token, query)
        except fx.FlexError as exc:
            print(f"IBKR Flex: {exc}")
            return 1
    statements = fx.parse(xml)
    if not statements:
        print("IBKR Flex: the statement has no accounts in it. Check the Flex Query's sections.")
        return 1

    ledger_path = data / "canonical" / "trades.csv"
    assert_path = data / "reference" / "balance_assertions.csv"
    def rows(path: Path) -> List[dict]:
        if not path.exists():
            return []
        with path.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    ledger, assertions = rows(ledger_path), rows(assert_path)
    accounts_path = data / "reference" / "accounts.csv"
    accounts = portfolio.load_accounts(accounts_path)
    ibkr_accounts = [a for a, acc in accounts.items() if acc.broker.upper() == "IBKR"]
    if not ibkr_accounts and not args.dry_run:
        # First sync: give the IBKR account an alias in accounts.csv (never its number).
        _add_account(accounts_path, "IBKR", "Interactive Brokers", "IBKR")
        ibkr_accounts = ["IBKR"]
        print("Added the account 'IBKR' to data/reference/accounts.csv.")
    elif not ibkr_accounts:
        ibkr_accounts = ["IBKR"]
    snap = portfolio.build(data)
    held: Dict[str, Dict[str, float]] = {}
    for p in snap.positions:
        held.setdefault(p.account_id, {})
        sym = p.instrument_id.split("@")[0].upper()
        held[p.account_id][sym] = held[p.account_id].get(sym, 0.0) + p.quantity
    known = {p.instrument_id for p in snap.positions} | {r["instrument_id"] for r in ledger}
    mapping = fx.match_accounts(statements, ibkr_accounts, {a: set(h) for a, h in held.items()})

    plans, gaps = [], {}
    for i, st in enumerate(statements):
        acct = mapping.get(i)
        if not acct:
            print(f"Statement {i + 1} of {len(statements)}: can't tell which IBKR account it is; skipped.")
            continue
        first = not any(r.get("account_id") == acct for r in ledger)
        p = fx.plan(st, acct, ledger, known, held.get(acct, {}), assertions, first_sync=first)
        plans.append(p)
        gaps[acct] = fx.position_gaps(st, held.get(acct, {}), p.new_rows)

    rows = [r for p in plans for r in p.new_rows]
    cash = [r for p in plans for r in p.cash_rows]
    if rows or cash:
        if args.dry_run:
            print("Dry run: nothing written.")
        else:
            before = {path: path.read_text(encoding="utf-8") if path.exists() else None
                      for path in (ledger_path, assert_path)}
            for r in rows:
                trades.append(ledger_path, r)
            if cash:
                new = not assert_path.exists()
                with assert_path.open("a", newline="", encoding="utf-8") as fh:
                    w = csv.DictWriter(fh, fieldnames=["account_id", "currency", "balance", "as_of", "reason"])
                    if new:
                        w.writeheader()
                    w.writerows(cash)
            after = portfolio.build(data)
            filed = {(r["account_id"], r["instrument_id"], r["date"]) for r in rows}
            bad = [i for i in after.issues if i.severity == "error"
                   and (i.account_id, i.instrument_id, str(i.when)) in filed]
            if bad:
                for path, text in before.items():
                    if text is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_text(text, encoding="utf-8")
                print("Rejected, nothing written:")
                for i in bad:
                    print(f"  {i.code}: {i.instrument_id} {i.when}: {i.detail}")
                return 1

    for p in plans:
        print(f"IBKR Flex, {p.account_id}, {p.period}:")
        opening = sum(1 for r in p.new_rows if "opening position" in r["note"])
        print(f"  trades filed: {len(p.new_rows) - opening}; already in the ledger: {p.already + p.by_hand}")
        if opening:
            print(f"  first sync: {opening} opening position(s) filed the day before the period, at IBKR's average cost")
        for r in p.new_rows:
            print(f"    {r['date']} {r['type']} {r['quantity']} {r['instrument_id']} @ {r['price']} {r['currency']}")
        if p.new_names:
            print("  new names (no price until a row is added to reference/marks.csv): "
                  + ", ".join(f"{k} ({v})" for k, v in p.new_names.items()))
        if p.cash_rows:
            print("  closing cash: " + ", ".join(f"{r['currency']} {float(r['balance']):,.2f}" for r in p.cash_rows))
        for f in p.flags:
            print(f"  TO FILE BY HAND: {f}")
        g = gaps.get(p.account_id) or []
        print("  positions: match the ledger" if not g else "  positions differ:")
        for line in g:
            print(f"    {line}")
    return 0


def _add_account(path: Path, account_id: str, name: str, broker: str) -> None:
    from .core.money import home_currency

    fields = ["account_id", "name", "broker", "ownership", "base_currency",
              "include_in_net_worth", "tracking_start", "note"]
    new = not path.exists() or not path.read_text(encoding="utf-8").strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        if new:
            w.writeheader()
        w.writerow({"account_id": account_id, "name": name, "broker": broker, "ownership": "SELF",
                    "base_currency": home_currency(), "include_in_net_worth": "true",
                    "tracking_start": date.today().isoformat(), "note": ""})


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="finance")
    parser.add_argument("--data", default=str(DEFAULT_DATA))
    parser.add_argument("--as-of", default=None, help="YYYY-MM-DD (default: today)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("snapshot").set_defaults(func=cmd_snapshot)
    sub.add_parser("brief").set_defaults(func=cmd_brief)
    sub.add_parser("check").set_defaults(func=cmd_check)
    sub.add_parser("dashboard").set_defaults(func=cmd_dashboard)
    sub.add_parser("analyse").set_defaults(func=cmd_analyse)
    sp = sub.add_parser("spend", help="expenditure by month and category")
    sp.add_argument("--month", help="YYYY-MM only")
    sp.add_argument("--months", type=int, default=3)
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_spend)
    tx = sub.add_parser("txn", help="the bank and card ledger (data/canonical/transactions.csv)")
    txs = tx.add_subparsers(dest="txn_cmd", required=True)
    ti = txs.add_parser("import", help="add statement lines; re-importing the same statement adds nothing")
    ti.add_argument("--json", help="lines extracted from a statement: [{date, description, amount}] (amount signed)")
    ti.add_argument("--account", help="spending account alias (reference/spend_accounts.csv)")
    ti.add_argument("--currency", default=None, help="default: your home currency (settings.json)")
    ti.add_argument("--source", help="e.g. 'Card A statement 2026-09'")
    ti.add_argument("--csv", help="a CSV export read through reference/statement_formats.json")
    ti.add_argument("--format", help="format name for --csv")
    tc = txs.add_parser("category", help="set a line's category by hand (wins over the rules)")
    tc.add_argument("txn_id")
    tc.add_argument("category")
    tc.add_argument("--merchant")
    tl = txs.add_parser("list")
    tl.add_argument("--month")
    tl.add_argument("--account")
    tl.add_argument("--limit", type=int, default=60)
    tx.set_defaults(func=cmd_txn)
    sub.add_parser("policy", help="your own rules (data/reference/investment_policy.json)").set_defaults(func=cmd_policy)
    add = sub.add_parser("addcheck", help="before buying more: your rules, and whether the price is below your average cost")
    add.add_argument("instrument")
    add.add_argument("price", type=float)
    add.set_defaults(func=cmd_addcheck)
    tr = sub.add_parser("trade", help="record a trade in data/canonical/trades.csv")
    tr.add_argument("type", help="BUY, SELL, SELL_ALL, SHORT, COVER, DIVIDEND, INTEREST, FEE, "
                                 "DEPOSIT, WITHDRAWAL. On a short, dividends paid in lieu and "
                                 "borrow fees are DIVIDEND / INTEREST with a negative --amount")
    tr.add_argument("instrument", help="ledger id or bare ticker (VWRA.L); new names as SYMBOL@EXCHANGE")
    tr.add_argument("quantity", type=float)
    tr.add_argument("price", type=float)
    tr.add_argument("--account", required=True)
    tr.add_argument("--currency", required=True)
    tr.add_argument("--date", help="trade date, YYYY-MM-DD (default today)")
    tr.add_argument("--fees", type=float)
    tr.add_argument("--amount", type=float, help="cash amount, for dividends and interest")
    tr.add_argument("--name")
    tr.add_argument("--note")
    tr.set_defaults(func=cmd_trade)
    ib = sub.add_parser("ibkr", help="optional: an IBKR account via its read-only Flex token")
    ibs = ib.add_subparsers(dest="ibkr_command", required=True)
    sync = ibs.add_parser("sync", help="file new trades and closing cash; compare positions")
    sync.add_argument("--file", help="read a saved Flex XML instead of fetching")
    sync.add_argument("--dry-run", action="store_true", help="show what would be filed, write nothing")
    sync.set_defaults(func=cmd_ibkr)

    plan = sub.add_parser("plan")
    plan.add_argument("--years", type=int, default=10)
    plan.add_argument("--rate", type=float, default=0.06,
                      help="assumed annual return, e.g. 0.06")
    plan.add_argument("--contribution", type=float, default=0.0,
                      help="annual amount added")
    plan.add_argument("--inflation", type=float, default=0.0)
    plan.add_argument("--target", type=float, default=None)
    plan.set_defaults(func=cmd_plan)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
