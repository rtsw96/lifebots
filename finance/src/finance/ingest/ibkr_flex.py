"""IBKR Flex Web Service: an IBKR account's trades, positions and cash (optional).

A Flex token is read-only: it returns a saved Flex Query (an Activity
statement) and cannot place orders. To use it, make a Flex Query in IBKR's
Client Portal with the Open Positions, Trades and Cash Report sections, then
put the token and the query id in the cloud environment as IBKR_FLEX_TOKEN
and IBKR_FLEX_QUERY_ID. Never print either.

`finance ibkr sync` fetches the statement and:
- files trades that are not in data/canonical/trades.csv yet, each with the
  note "IBKR Flex <tradeID>" so a rerun adds nothing. A trade already keyed
  in by hand (same day, name, side and total quantity) is left alone;
- writes the closing cash per currency to balance_assertions.csv;
- compares IBKR's open positions with the ledger's and lists any gap.

A stock or ETF the ledger hasn't seen is filed as SYMBOL@<listing exchange>
with IBKR's description as its name; it has no price until a row is added to
reference/marks.csv. Options, futures and FX conversions are listed for a
person to file, not guessed. The IBKR account number is never
written or printed: statements map to the ledger's account alias.
"""

from __future__ import annotations

import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
NOTE = "IBKR Flex"
IN_PROGRESS = {"1001", "1004", "1005", "1006", "1007", "1008", "1009", "1018", "1019", "1021"}

# IBKR listing exchange -> the ledger's ticker suffix (700 on SEHK -> 0700.HK)
SUFFIX = {"SEHK": ".HK", "TSEJ": ".T", "LSE": ".L", "LSEETF": ".L", "LSEIOB1": ".L",
          "IBIS": ".DE", "IBIS2": ".DE", "FWB": ".DE", "FWB2": ".DE", "GETTEX": ".DE",
          "SGX": ".SI", "ASX": ".AX", "AEB": ".AS", "SBF": ".PA", "EBS": ".SW", "KSE": ".KS"}


class FlexError(RuntimeError):
    """IBKR refused the request. The message is IBKR's; it never holds the token."""


@dataclass
class FlexTrade:
    trade_id: str
    when: date
    symbol: str
    exchange: str
    currency: str
    asset: str
    side: str
    open_close: str
    quantity: float
    price: float
    fees: float
    description: str = ""

    @property
    def ledger_symbol(self) -> str:
        return ledger_symbol(self.symbol, self.exchange)

    @property
    def ledger_type(self) -> str:
        oc = set(self.open_close.replace(";", " ").split())
        if self.side == "SELL":
            return "SHORT" if oc == {"O"} else "SELL"
        return "COVER" if oc == {"C"} else "BUY"


@dataclass
class FlexPosition:
    symbol: str
    exchange: str
    currency: str
    asset: str
    quantity: float
    cost_price: float = 0.0  # IBKR's average cost per unit, in the instrument's currency
    description: str = ""

    @property
    def ledger_symbol(self) -> str:
        return ledger_symbol(self.symbol, self.exchange)


@dataclass
class FlexAccount:
    account_ref: str  # IBKR's account id: used to tell statements apart, never stored or shown
    from_date: Optional[date]
    to_date: Optional[date]
    trades: List[FlexTrade] = field(default_factory=list)
    positions: List[FlexPosition] = field(default_factory=list)
    cash: Dict[str, float] = field(default_factory=dict)


def ledger_symbol(symbol: str, exchange: str) -> str:
    s = (symbol or "").strip().replace(" ", "-")
    suffix = SUFFIX.get((exchange or "").strip().upper(), "")
    if suffix == ".HK" and s.isdigit():
        s = s.zfill(4)
    return s + suffix if suffix and not s.endswith(suffix) else s


def _date(value: str) -> Optional[date]:
    v = (value or "").strip()
    digits = "".join(ch for ch in v.split(";")[0].split(",")[0].split(" ")[0] if ch.isdigit())
    if len(digits) < 8:
        return None
    return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))


def _num(value: str) -> float:
    v = (value or "").strip().replace(",", "")
    try:
        return float(v) if v else 0.0
    except ValueError:
        return 0.0


# --- fetching ---------------------------------------------------------------

def _get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "lifebots/finance"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as exc:  # the URL holds the token: never echo it
        raise FlexError(f"could not reach IBKR ({type(exc).__name__})") from None


def _status(xml: bytes) -> Tuple[str, str, str, ET.Element]:
    root = ET.fromstring(xml)
    if root.tag != "FlexStatementResponse":
        return "Data", "", "", root
    return ((root.findtext("Status") or "").strip(), (root.findtext("ErrorCode") or "").strip(),
            (root.findtext("ErrorMessage") or "").strip(), root)


def fetch(token: str, query_id: str, timeout: float = 30, tries: int = 12,
          wait: float = 5.0, get=_get) -> bytes:
    """The statement XML for the saved query. IBKR builds it on request, so poll."""
    q = urllib.parse.urlencode({"t": token, "q": query_id, "v": "3"})
    status, code, msg, root = _status(get(f"{BASE}/SendRequest?{q}", timeout))
    if status != "Success":
        raise FlexError(f"IBKR error {code}: {msg}")
    ref = (root.findtext("ReferenceCode") or "").strip()
    url = (root.findtext("Url") or f"{BASE}/GetStatement").strip()
    q2 = urllib.parse.urlencode({"t": token, "q": ref, "v": "3"})
    for _ in range(tries):
        body = get(f"{url}?{q2}", timeout)
        status, code, msg, _root = _status(body)
        if status == "Data":
            return body
        if code not in IN_PROGRESS:
            raise FlexError(f"IBKR error {code}: {msg}")
        time.sleep(wait)
    raise FlexError("IBKR is still building the statement; try again in a few minutes")


# --- parsing ----------------------------------------------------------------

def parse(xml: bytes) -> List[FlexAccount]:
    root = ET.fromstring(xml)
    out: List[FlexAccount] = []
    for st in root.iter("FlexStatement"):
        acct = FlexAccount(account_ref=st.get("accountId", ""), from_date=_date(st.get("fromDate", "")),
                           to_date=_date(st.get("toDate", "")))
        rows = list(st.iter("Trade"))
        levels = {(r.get("levelOfDetail") or "EXECUTION").upper() for r in rows}
        # an order row sums its fills; use orders when the query has them, else executions
        want = "ORDER" if "ORDER" in levels else "EXECUTION"
        for r in rows:
            if (r.get("levelOfDetail") or "EXECUTION").upper() != want:
                continue
            when = _date(r.get("tradeDate", "")) or _date(r.get("dateTime", ""))
            if not when:
                continue
            side = (r.get("buySell") or "").upper().replace(" (CA.)", "").replace(" (EX.)", "")
            qty = _num(r.get("quantity", ""))
            if side not in ("BUY", "SELL"):
                side = "BUY" if qty > 0 else "SELL"
            acct.trades.append(FlexTrade(
                trade_id=(r.get("tradeID") or r.get("ibOrderID") or r.get("transactionID") or "").strip(),
                when=when, symbol=r.get("symbol", ""), exchange=r.get("listingExchange", ""),
                currency=(r.get("currency") or "").upper(), asset=(r.get("assetCategory") or "").upper(),
                side=side, open_close=(r.get("openCloseIndicator") or "").upper(), quantity=abs(qty),
                price=_num(r.get("tradePrice", "")), fees=abs(_num(r.get("ibCommission", ""))),
                description=r.get("description", "")))
        for r in st.iter("OpenPosition"):
            if (r.get("levelOfDetail") or "SUMMARY").upper() not in ("SUMMARY", ""):
                continue
            acct.positions.append(FlexPosition(
                symbol=r.get("symbol", ""), exchange=r.get("listingExchange", ""),
                currency=(r.get("currency") or "").upper(), asset=(r.get("assetCategory") or "").upper(),
                quantity=_num(r.get("position", "")), cost_price=_num(r.get("costBasisPrice", "")),
                description=r.get("description", "")))
        for r in st.iter("CashReportCurrency"):
            ccy = (r.get("currency") or "").upper()
            if not ccy or ccy == "BASE_SUMMARY" or (r.get("levelOfDetail") or "Currency").upper() != "CURRENCY":
                continue
            acct.cash[ccy] = round(_num(r.get("endingCash", "")), 2)
        out.append(acct)
    return out


# --- planning ---------------------------------------------------------------

@dataclass
class Plan:
    account_id: str
    period: str
    new_rows: List[dict] = field(default_factory=list)
    already: int = 0
    by_hand: int = 0
    flags: List[str] = field(default_factory=list)
    cash_rows: List[dict] = field(default_factory=list)
    new_names: Dict[str, str] = field(default_factory=dict)  # instrument id -> name, first seen here


def resolve(symbol: str, known: Iterable[str]) -> Tuple[Optional[str], List[str]]:
    """The ledger id for a ticker (VWRA.L -> VWRA.L@LSE): (id, candidates)."""
    matches = sorted(k for k in set(known) if k.split("@")[0].upper() == symbol.upper())
    return (matches[0] if len(matches) == 1 else None), matches


def match_accounts(accounts: List[FlexAccount], ledger_accounts: List[str],
                   held: Dict[str, set]) -> Dict[int, Optional[str]]:
    """Statement index -> ledger account alias. With one statement and one IBKR alias,
    that alias; otherwise each statement goes to the IBKR alias whose holdings it
    overlaps most (an alias with nothing in common is never guessed)."""
    if len(accounts) == 1 and len(ledger_accounts) == 1:
        return {0: ledger_accounts[0]}
    out: Dict[int, Optional[str]] = {}
    for i, a in enumerate(accounts):
        syms = {p.ledger_symbol.upper() for p in a.positions}
        scores = sorted(((len(syms & held.get(acc, set())), acc) for acc in ledger_accounts), reverse=True)
        best = scores[0] if scores else (0, None)
        tie = len(scores) > 1 and scores[1][0] == best[0]
        out[i] = best[1] if best[0] > 0 and not tie else None
    return out


def plan(acct: FlexAccount, account_id: str, ledger: List[dict], known: Iterable[str],
         held: Dict[str, float], assertions: List[dict], first_sync: bool = False) -> Plan:
    """What to file from one statement. `held` is the ledger's quantity per ledger symbol.

    `first_sync` (the ledger has nothing for this account yet): stocks held before the
    statement's period are filed as opening BUYs the day before it starts, so the period's
    trades replay onto them and the ledger ends where IBKR does. Each is priced at IBKR's
    average cost (or the first trade's price when IBKR no longer holds it) and noted
    "IBKR Flex opening"."""
    period = f"{acct.from_date or '?'} to {acct.to_date or '?'}"
    p = Plan(account_id=account_id, period=period)
    known = set(known)
    filed = {(r.get("note") or "").split(NOTE, 1)[1].split()[0].strip(";,")
             for r in ledger if NOTE in (r.get("note") or "") and (r.get("note") or "").split(NOTE, 1)[1].split()}
    manual: Dict[tuple, float] = defaultdict(float)
    for r in ledger:
        if NOTE not in (r.get("note") or "") and r.get("account_id") == account_id:
            manual[(r["date"], r["instrument_id"], r["type"].upper())] += _num(r.get("quantity", ""))

    groups: Dict[tuple, List[Tuple[FlexTrade, str]]] = defaultdict(list)
    for t in acct.trades:
        if t.trade_id and t.trade_id in filed:
            p.already += 1
            continue
        if t.asset not in ("STK", ""):
            what = {"OPT": "option", "FOP": "futures option", "FUT": "future", "CASH": "FX conversion"}.get(t.asset, t.asset)
            p.flags.append(f"{t.when} {t.side} {t.quantity:g} {t.description or t.symbol} ({what}): not filed automatically")
            continue
        iid, cands = resolve(t.ledger_symbol, known)
        if not iid and cands:
            p.flags.append(f"{t.when} {t.side} {t.quantity:g} {t.ledger_symbol} @ {t.price:g} {t.currency}: "
                           f"ambiguous: {', '.join(cands)}")
            continue
        if not iid:
            # A name the ledger hasn't seen: SYMBOL@<IBKR listing exchange>, named from IBKR.
            iid = f"{t.ledger_symbol}@{(t.exchange or 'IBKR').strip().upper()}"
            known.add(iid)
            p.new_names[iid] = t.description.strip() or t.symbol
        groups[(t.when.isoformat(), iid, t.ledger_type)].append((t, iid))

    for key, items in sorted(groups.items()):
        total = sum(t.quantity for t, _ in items)
        if key in manual:
            if abs(manual[key] - total) <= 1e-6 * max(1.0, total):
                p.by_hand += len(items)
            else:
                p.flags.append(f"{key[0]} {key[2]} {key[1]}: IBKR has {total:g}, the ledger has {manual[key]:g} "
                               "keyed by hand; check and fix by hand")
            continue
        for t, iid in items:
            p.new_rows.append({"date": t.when.isoformat(), "account_id": account_id, "instrument_id": iid,
                               "type": t.ledger_type, "quantity": f"{t.quantity:g}", "price": f"{t.price:g}",
                               "amount": "", "currency": t.currency, "fees": f"{t.fees:.2f}" if t.fees else "",
                               "name": p.new_names.get(iid, ""), "note": f"{NOTE} {t.trade_id}"})

    if first_sync:
        _opening(p, acct, account_id, known)

    if acct.to_date and acct.cash:
        stated = {(a["account_id"], a["currency"], a["as_of"]) for a in assertions}
        for ccy, bal in sorted(acct.cash.items()):
            if (account_id, ccy, acct.to_date.isoformat()) not in stated:
                p.cash_rows.append({"account_id": account_id, "currency": ccy, "balance": f"{bal:.2f}",
                                    "as_of": acct.to_date.isoformat(),
                                    "reason": f"{NOTE} statement {period}: closing cash"})
    return p


def position_gaps(acct: FlexAccount, held: Dict[str, float], new_rows: List[dict]) -> List[str]:
    """Names where IBKR's quantity and the ledger's (after filing) differ."""
    after = defaultdict(float, held)
    sign = {"BUY": 1, "COVER": 1, "SELL": -1, "SHORT": -1}
    for r in new_rows:
        after[r["instrument_id"].split("@")[0].upper()] += sign.get(r["type"], 0) * _num(r["quantity"])
    ibkr = defaultdict(float)
    for pos in acct.positions:
        if pos.asset in ("STK", ""):
            ibkr[pos.ledger_symbol.upper()] += pos.quantity
    gaps = []
    for sym in sorted(set(ibkr) | {s for s, q in after.items() if abs(q) > 1e-9}):
        a, b = after.get(sym, 0.0), ibkr.get(sym, 0.0)
        if abs(a - b) > 1e-6 * max(1.0, abs(b)):
            gaps.append(f"{sym}: IBKR {b:g}, ledger {a:g}")
    others = [f"{p.symbol} ({p.asset})" for p in acct.positions if p.asset not in ("STK", "")]
    if others:
        gaps.append("held at IBKR but not in the ledger's types: " + ", ".join(others))
    return gaps


def _opening(p: Plan, acct: FlexAccount, account_id: str, known: set) -> None:
    sign = {"BUY": 1, "COVER": 1, "SELL": -1, "SHORT": -1}
    net: Dict[str, float] = defaultdict(float)
    first_price: Dict[str, Tuple[float, str, str]] = {}
    for r in p.new_rows:
        net[r["instrument_id"]] += sign.get(r["type"], 0) * _num(r["quantity"])
        first_price.setdefault(r["instrument_id"], (_num(r["price"]), r["currency"], r.get("name", "")))
    end: Dict[str, FlexPosition] = {}
    for pos in acct.positions:
        if pos.asset not in ("STK", ""):
            continue
        iid, cands = resolve(pos.ledger_symbol, known | set(net))
        if not iid and cands:
            continue
        iid = iid or f"{pos.ledger_symbol}@{(pos.exchange or 'IBKR').strip().upper()}"
        end[iid] = pos
    starts = [d for d in [acct.from_date] + [date.fromisoformat(r["date"]) for r in p.new_rows] if d]
    if not starts:
        return
    day = date.fromordinal(min(starts).toordinal() - 1).isoformat()
    rows = []
    for iid in sorted(set(end) | set(net)):
        pos = end.get(iid)
        qty = (pos.quantity if pos else 0.0) - net.get(iid, 0.0)
        if qty <= 1e-9:
            continue
        if pos and pos.cost_price:
            price, ccy, name = pos.cost_price, pos.currency, pos.description
        elif iid in first_price:
            price, ccy, name = first_price[iid]
        else:
            continue
        if iid not in known:
            p.new_names.setdefault(iid, name.strip() or iid.split("@")[0])
        rows.append({"date": day, "account_id": account_id, "instrument_id": iid, "type": "BUY",
                     "quantity": f"{qty:g}", "price": f"{price:g}", "amount": "", "currency": ccy, "fees": "",
                     "name": p.new_names.get(iid, ""), "note": f"{NOTE} opening position (at IBKR's average cost)"})
    p.new_rows[:0] = rows
