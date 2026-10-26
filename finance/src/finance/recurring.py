"""Recurring payments: what leaves every week, month, quarter or year.

Built from three sources, so nothing that recurs is missed:
- the transaction ledger: payments to the same payee at a regular interval;
- the insurance policy list (data/reference/insurance_policies.csv), which knows
  premiums that haven't come round yet in the statements on file, and those
  paid from somewhere other than a bank account (`paid_from`);
- data/reference/recurring_manual.csv, for what never touches a bank account
  (a part of a loan paid from a pension or savings scheme, cash), and for
  payments you say have ended (cadence "ended", name as the app shows it,
  start = the end date).

Sections: insurance, subscriptions, regular (family and other standing
payments), mortgage (and property), taxes, others.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import median
from typing import Dict, List, Optional, Sequence

from .core.money import BASE_CURRENCY
from .spending import merchant_of

SECTION_OF = {
    "insurance": "insurance", "subscriptions": "subscriptions", "family": "regular",
    "housing_mortgage": "mortgage", "housing_fees": "mortgage", "tax": "taxes",
    "utilities_home": "others", "utilities_telco": "others", "fitness": "others", "donations": "others",
    "education": "others", "bank_fees": "others", "car": "others",
}
SECTIONS = ["insurance", "subscriptions", "regular", "mortgage", "taxes", "others"]

# Payee names: statements append order or reference codes; these map lines to one
# name. A starter set of common subscriptions; add your own as rows of
# data/reference/payee_names.csv (pattern,name), which are tried first.
NAMES = [
    (r"SPOTIFY", "Spotify"), (r"NETFLIX", "Netflix"), (r"DISNEY", "Disney+"), (r"YOUTUBE", "YouTube Premium"),
    (r"GOOGLE ONE|G1SK", "Google One"), (r"GOOGLE ?\*?CLOUD", "Google Cloud"), (r"MICROSOFT", "Microsoft 365"),
    (r"APPLE\.COM", "Apple"), (r"DROPBOX", "Dropbox"), (r"OPENAI|CHATGPT", "ChatGPT"), (r"CLAUDE", "Claude"),
    (r"TELEGRAM", "Telegram"), (r"SUBSTACK", "Substack"),
]
# Lines that recur but aren't worth a row of their own (FX fees on each foreign charge).
SKIP = re.compile(r"CCY CONVERSION FEE|FX CONVERSION FEE|FOREIGN (CURRENCY|TRANSACTION) FEE", re.I)
# Seen once but known to repeat on this cycle.
KNOWN = [(r"SEASON PARKING", "monthly"), (r"ANNUAL (MEMBERSHIP )?FEE", "annual")]
# Bills whose due date is fixed by the payee, not by when it was last paid: name -> (month, day).
DUE_ON: Dict[str, tuple] = {}
# Payees whose amount identifies a separate subscription (Apple bills each one apart).
SPLIT_BY_AMOUNT = {"Apple"}
# Sections where each distinct amount is its own commitment (a standing order vs one-off extras).
# An amount seen fewer than MIN_STANDING times is folded into "<payee> (other transfers)".
SPLIT_SECTIONS = {"regular"}
MIN_STANDING = 3

CADENCES = [("weekly", 7, 52 / 12), ("fortnightly", 14, 26 / 12), ("monthly", 30.4, 1.0), ("quarterly", 91, 1 / 3),
            ("half-yearly", 182, 1 / 6), ("annual", 365, 1 / 12)]
STEP = {c: d for c, d, _ in CADENCES}
PER_MONTH = {c: f for c, _, f in CADENCES}


def _names(ref: Optional[Path]) -> List[tuple]:
    """Your payee names (reference/payee_names.csv) first, then the starter set."""
    own: List[tuple] = []
    p = ref / "payee_names.csv" if ref else None
    if p and p.exists():
        with p.open(newline="", encoding="utf-8") as f:
            own = [(r["pattern"], r["name"]) for r in csv.DictReader(f) if (r.get("pattern") or "").strip() and r.get("name")]
    return own + NAMES


def payee(t, names: Optional[List[tuple]] = None) -> str:
    text = f"{t.description} {t.merchant or ''}".upper()
    for pat, name in (names if names is not None else NAMES):
        if re.search(pat, text):
            return name
    if t.category == "family":
        return t.merchant or merchant_of(t)
    m = re.search(r"TO: (.+?)(?: OTHR|$)", t.description, re.I)  # PayNow: the payee follows "To:"
    return (m.group(1).title() if m else merchant_of(t)).strip()


def cadence_of(dates: List[date]) -> Optional[str]:
    if len(dates) < 2:
        return None
    gaps = [(b - a).days for a, b in zip(dates, dates[1:]) if (b - a).days > 0]
    if not gaps:
        return None
    g = median(gaps)
    for name, lo, hi in (("weekly", 4, 10), ("fortnightly", 11, 20), ("monthly", 21, 45), ("quarterly", 70, 115),
                         ("half-yearly", 150, 220), ("annual", 300, 400)):
        if lo <= g <= hi:
            return name
    return "irregular"


def _policies(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r.get("in_force", "Yes") == "Yes"]


def _next_anniversary(start: str, today: date) -> Optional[str]:
    try:
        y, m, d = (int(x) for x in start[:10].split("-"))
    except ValueError:
        return None
    for yr in (today.year, today.year + 1):
        try:
            nd = date(yr, m, d)
        except ValueError:
            nd = date(yr, m, 28)
        if nd >= today:
            return nd.isoformat()
    return None


def _roll(due: date, step: float, today: date) -> date:
    """The next due date on or after today: a payment already due is just not in the statements yet."""
    while due < today:
        due += timedelta(days=round(step))
    return due


def _fixed_due(month: int, day: int, today: date) -> date:
    d = date(today.year, month, day)
    return d if d >= today else date(today.year + 1, month, day)


def build(txns: Sequence, ref: Path, today: date, through: Optional[Dict[str, str]] = None) -> dict:
    """`through`: last statement date per account, so a payment isn't called stopped
    just because that account's statements end earlier (card statements lag)."""
    through = through or {}
    names = _names(ref)
    cur = BASE_CURRENCY
    groups: Dict[tuple, list] = defaultdict(list)
    for t in txns:
        if t.currency != cur or t.amount >= 0 or t.category not in SECTION_OF or SKIP.search(t.description):
            continue
        name = payee(t, names)
        sec = SECTION_OF[t.category]
        key = (sec, name, round(-t.amount, 2) if name in SPLIT_BY_AMOUNT or sec in SPLIT_SECTIONS else None)
        groups[key].append(t)
    # in split sections, amounts that don't repeat are extras, not a standing order
    for key in [k for k in groups if k[0] in SPLIT_SECTIONS and k[2] is not None]:
        if len({t.date for t in groups[key]}) < MIN_STANDING:
            groups[(key[0], f"{key[1]} (other transfers)", None)].extend(groups.pop(key))
    first_seen = min((t.date for t in txns), default=today)

    items: List[dict] = []
    for (section, name, amt_key), ts in groups.items():
        ts.sort(key=lambda t: t.date)
        # one payment per day: a fee and its GST, or a split charge, count once
        per_day: Dict[date, float] = defaultdict(float)
        for t in ts:
            per_day[t.date] += -t.amount
        dates = sorted(per_day)
        amounts = [per_day[d] for d in dates]
        cad = cadence_of(dates)
        extras = name.endswith("(other transfers)")
        if extras:
            cad = "irregular"
        if cad is None:
            text = " ".join(t.description.upper() for t in ts)
            cad = next((c for pat, c in KNOWN if re.search(pat, text)), None)
            if cad is None and (section in ("insurance", "taxes") or (section == "subscriptions" and amounts[0] >= 100)):
                cad = "annual"
            if cad is None:
                continue  # one payment with no known cycle: not (yet) recurring
        if cad == "irregular" and len(dates) < 3 and not extras:
            continue
        typical = round(median(amounts[-3:]), 2)
        seen_to = max((date.fromisoformat(through[t.account_id]) for t in ts if t.account_id in through), default=today)
        if extras:  # averaged over every month on file, not just the months they happened
            span_months = max(1.0, ((seen_to - first_seen).days + 1) / 30.4)
        else:
            # first to last payment, plus one cycle for the last one
            span_months = max(7 / 30.4, ((dates[-1] - dates[0]).days + STEP.get(cad, 30.4)) / 30.4)
        if cad in ("irregular", "weekly", "fortnightly"):
            # amounts and gaps wander (two payments one week, none the next): use the run rate,
            # leaving out one-off gifts (over 3x the usual) unless the whole row is one-offs
            usual = amounts if cad == "irregular" or extras else [a for a in amounts if a <= 3 * median(amounts)]
            monthly = round(sum(usual) / span_months, 2)
        else:
            monthly = round(typical * PER_MONTH[cad], 2)
        nxt = None
        status = "active"
        if cad in STEP:
            if (seen_to - dates[-1]).days > STEP[cad] * 2 + 7:
                status = "stopped?"
            else:
                nxt = _roll(dates[-1] + timedelta(days=round(STEP[cad])), STEP[cad], today).isoformat()
        if name in DUE_ON:
            nxt = _fixed_due(*DUE_ON[name], today).isoformat()
        label = f"{name} {cur} {amt_key:,.0f}" if amt_key is not None and section in SPLIT_SECTIONS else f"{name} {cur} {amt_key:,.2f}" if amt_key is not None else name
        item = {"name": label, "section": section, "category": ts[-1].category, "cadence": cad,
                      "amount": typical, "monthly": monthly, "yearly": round(monthly * 12, 2),
                      "last": dates[-1].isoformat(), "next": nxt, "count": len(ts), "status": status,
                      "paid_from": "cash", "source": "statements", "account": ts[-1].account_id,
                      "history": [[d.isoformat(), round(per_day[d], 2)] for d in dates]}
        if extras:
            item["note"] = "Not a standing order: one-off transfers, averaged over all the months on file."
        items.append(item)

    # insurance: the policy list is the record; statement lines attach to their policy by payee
    by_name = {i["name"]: i for i in items if i["section"] == "insurance"}
    pol_groups: Dict[str, List[dict]] = defaultdict(list)
    for p in _policies(ref / "insurance_policies.csv"):
        pol_groups[p.get("payee") or f"{p['insurer']} {p['policy_name']}"].append(p)
    for name, ps in pol_groups.items():
        annual = round(sum(float(p.get("annual_premium") or p.get("annual_premium_sgd") or 0) for p in ps), 2)
        seen = by_name.get(name)
        policies = [f"{p['policy_name']} ({p['insurer']})" for p in ps]
        sources = {"cash" if (p.get("paid_from") or "cash").strip().lower() == "cash" else p["paid_from"].strip() for p in ps}
        paid_from = sources.pop() if len(sources) == 1 else "cash"
        if seen:
            seen.update({"policies": policies, "source": "statements + policy list",
                         "note": f"Policy list: {cur} {annual:,.2f} a year"})
            continue
        items.append({"name": name or policies[0], "section": "insurance", "category": "insurance", "cadence": "annual",
                      "amount": annual, "monthly": round(annual / 12, 2), "yearly": annual, "last": None,
                      "next": _next_anniversary(ps[0]["commenced"], today), "count": 0, "status": "not seen yet",
                      "paid_from": paid_from, "source": "policy list", "policies": policies, "history": [],
                      "note": "Not in the statements on file yet; premium and date from your policy list."})
    for name, i in by_name.items():
        if name not in pol_groups:
            i.setdefault("note", "Not on your policy list.")

    # what never touches a bank account
    mp = ref / "recurring_manual.csv"
    if mp.exists():
        with mp.open(newline="", encoding="utf-8") as f:
            manual = list(csv.DictReader(f))
        ended = {r["name"]: r for r in manual if r["cadence"] == "ended"}
        for i in items:
            if i["name"] in ended:
                i["status"] = "stopped?"
                i["note"] = f"You said this ended ({ended[i['name']]['start']}). {ended[i['name']].get('note') or ''}".strip()
        for r in manual:
            if r["cadence"] == "ended":
                continue
            amt = float(r["amount"])
            per = PER_MONTH.get(r["cadence"], 1.0)
            nxt = None
            if r["cadence"] == "monthly":
                first = date(today.year, today.month, 1)
                nxt = (first if first >= today else date(today.year + (today.month == 12), today.month % 12 + 1, 1)).isoformat()
            items.append({"name": r["name"], "section": r["section"], "category": "", "cadence": r["cadence"],
                          "amount": amt, "monthly": round(amt * per, 2), "yearly": round(amt * per * 12, 2),
                          "last": None, "next": nxt, "count": 0, "status": "active", "paid_from": r["paid_from"],
                          "source": "you told us", "note": r.get("note", ""), "history": []})

    items.sort(key=lambda i: (SECTIONS.index(i["section"]) if i["section"] in SECTIONS else 99, -i["monthly"]))
    cash = [i for i in items if i["paid_from"] == "cash" and i["status"] != "stopped?"]
    return {
        "as_of": today.isoformat(), "items": items,
        "sections": {s: round(sum(i["monthly"] for i in items if i["section"] == s and i["status"] != "stopped?"), 2) for s in SECTIONS},
        "monthly_cash": round(sum(i["monthly"] for i in cash), 2),
        "monthly_all": round(sum(i["monthly"] for i in items if i["status"] != "stopped?"), 2),
    }
