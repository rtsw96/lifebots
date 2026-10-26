"""Tests for the optional IBKR Flex sync: parsing, planning and the CLI on synthetic data."""

from __future__ import annotations

import contextlib
import csv
import io
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

from finance import cli
from finance.ingest import ibkr_flex as fx

REPO = Path(__file__).resolve().parents[1]

XML = b"""<FlexQueryResponse queryName="sample" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U0000000" fromDate="20261009" toDate="20261015" period="Last7CalendarDays">
<Trades>
<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="AAA" description="ALPHA ETF" listingExchange="NASDAQ" tradeID="9001" tradeDate="20261014" quantity="10" tradePrice="21.5" ibCommission="-1.02" buySell="BUY" openCloseIndicator="O" levelOfDetail="EXECUTION"/>
<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="BBB" description="BETA CO" listingExchange="NYSE" tradeID="9002" tradeDate="20261015" quantity="-50" tradePrice="60.1" ibCommission="-1.00" buySell="SELL" openCloseIndicator="C" levelOfDetail="EXECUTION"/>
<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="BBB" description="BETA CO" listingExchange="NYSE" tradeID="9003" tradeDate="20261015" quantity="-50" tradePrice="60.0" ibCommission="-1.00" buySell="SELL" openCloseIndicator="C" levelOfDetail="EXECUTION"/>
<Trade accountId="U0000000" currency="USD" assetCategory="OPT" symbol="XYZ   261218P00100000" description="XYZ 18DEC26 100 P" listingExchange="CBOE" tradeID="9004" tradeDate="20261015" quantity="1" tradePrice="21.3" ibCommission="-0.70" buySell="BUY" openCloseIndicator="O" levelOfDetail="EXECUTION"/>
<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="NEWCO" description="NEW COMPANY" listingExchange="NYSE" tradeID="9005" tradeDate="20261015" quantity="5" tradePrice="10" ibCommission="-1" buySell="BUY" openCloseIndicator="O" levelOfDetail="EXECUTION"/>
<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="EEE" description="EPSILON ETF" listingExchange="BATS" tradeID="8001" tradeDate="20261008" quantity="-300" tradePrice="41.17" ibCommission="-1.50" buySell="SELL" openCloseIndicator="C" levelOfDetail="EXECUTION"/>
</Trades>
<OpenPositions>
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="CCC" listingExchange="ARCA" position="150" costBasisPrice="30.5" levelOfDetail="SUMMARY"/>
<OpenPosition accountId="U0000000" currency="JPY" assetCategory="STK" symbol="7203" listingExchange="TSEJ" position="300" costBasisPrice="1000" levelOfDetail="SUMMARY"/>
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="BBB" listingExchange="NYSE" position="100" costBasisPrice="50" levelOfDetail="SUMMARY"/>
<OpenPosition accountId="U0000000" currency="HKD" assetCategory="STK" symbol="5" listingExchange="SEHK" position="4000" levelOfDetail="SUMMARY"/>
<OpenPosition accountId="U0000000" currency="USD" assetCategory="OPT" symbol="XYZ   261218P00100000" listingExchange="CBOE" position="1" levelOfDetail="SUMMARY"/>
</OpenPositions>
<CashReport>
<CashReportCurrency accountId="U0000000" currency="BASE_SUMMARY" levelOfDetail="BaseCurrency" endingCash="1000"/>
<CashReportCurrency accountId="U0000000" currency="USD" levelOfDetail="Currency" endingCash="8123.456"/>
<CashReportCurrency accountId="U0000000" currency="SGD" levelOfDetail="Currency" endingCash="-2500.5"/>
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>"""


class Helpers(unittest.TestCase):
    def test_ledger_symbol(self):
        self.assertEqual(fx.ledger_symbol("7203", "TSEJ"), "7203.T")
        self.assertEqual(fx.ledger_symbol("700", "SEHK"), "0700.HK")
        self.assertEqual(fx.ledger_symbol("ABCD", "LSEETF"), "ABCD.L")
        self.assertEqual(fx.ledger_symbol("BRK B", "NYSE"), "BRK-B")
        self.assertEqual(fx.ledger_symbol("CCC", "ARCA"), "CCC")

    def test_types(self):
        t = fx.FlexTrade("1", date(2026, 10, 1), "X", "", "USD", "STK", "SELL", "O", 1, 1, 0)
        self.assertEqual(t.ledger_type, "SHORT")
        t.side, t.open_close = "BUY", "C"
        self.assertEqual(t.ledger_type, "COVER")
        t.open_close = "C;O"
        self.assertEqual(t.ledger_type, "BUY")
        t.side = "SELL"
        self.assertEqual(t.ledger_type, "SELL")

    def test_parse(self):
        [st] = fx.parse(XML)
        self.assertEqual((st.from_date, st.to_date), (date(2026, 10, 9), date(2026, 10, 15)))
        self.assertEqual(len(st.trades), 6)
        self.assertEqual(st.cash, {"USD": 8123.46, "SGD": -2500.5})
        self.assertEqual(st.trades[0].fees, 1.02)

    def test_orders_win_over_executions(self):
        xml = XML.replace(b'tradeID="9002" tradeDate="20261015" quantity="-50"',
                          b'tradeID="9002" tradeDate="20261015" quantity="-100"').replace(
            b'tradeID="9002"', b'tradeID="9002" ').replace(
            b'levelOfDetail="EXECUTION"/>\n<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="BBB" description="BETA CO" listingExchange="NYSE" tradeID="9003"',
            b'levelOfDetail="ORDER"/>\n<Trade accountId="U0000000" currency="USD" assetCategory="STK" symbol="BBB" description="BETA CO" listingExchange="NYSE" tradeID="9003"')
        [st] = fx.parse(xml)
        self.assertEqual([t.trade_id for t in st.trades], ["9002"])

    def test_fetch_polls_and_hides_the_token(self):
        calls = []

        def get(url, timeout):
            calls.append(url)
            if "SendRequest" in url:
                return (b"<FlexStatementResponse><Status>Success</Status><ReferenceCode>42</ReferenceCode>"
                        b"<Url>https://example.test/GetStatement</Url></FlexStatementResponse>")
            if len(calls) == 2:
                return (b"<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode>"
                        b"<ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>")
            return XML

        self.assertEqual(fx.fetch("SECRET", "123", wait=0, get=get), XML)
        self.assertEqual(len(calls), 3)

        def bad(url, timeout):
            return (b"<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode>"
                    b"<ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>")

        with self.assertRaises(fx.FlexError) as e:
            fx.fetch("SECRET", "123", get=bad)
        self.assertIn("1012", str(e.exception))
        self.assertNotIn("SECRET", str(e.exception))

    def test_two_statements_go_to_the_matching_alias(self):
        a = fx.FlexAccount("A", None, None, positions=[fx.FlexPosition("CCC", "ARCA", "USD", "STK", 1)])
        b = fx.FlexAccount("B", None, None, positions=[fx.FlexPosition("5", "SEHK", "HKD", "STK", 1)])
        held = {"IBKR": {"CCC"}, "IBKR Joint": {"0005.HK"}}
        self.assertEqual(fx.match_accounts([a, b], ["IBKR", "IBKR Joint"], held), {0: "IBKR", 1: "IBKR Joint"})
        self.assertEqual(fx.match_accounts([a], ["Broker IB"], {}), {0: "Broker IB"})
        self.assertEqual(fx.match_accounts([a], ["IBKR", "IBKR Joint"], {"IBKR Joint": {"CCC"}}), {0: "IBKR Joint"})


TRADES = """date,account_id,instrument_id,type,quantity,price,amount,currency,fees,name,note
2026-09-01,IBKR,AAA@NASDAQ,BUY,100,20,,USD,1,Alpha ETF,
2026-09-01,IBKR,BBB@NYSE,BUY,200,50,,USD,1,Beta Co,
2026-09-01,IBKR,CCC@ARCA,BUY,150,30,,USD,,Gamma ETF,
2026-09-01,IBKR,7203.T@TSE,BUY,300,1000,,JPY,,Sample KK,
2026-09-01,IBKR,0005.HK@HKG,BUY,4000,1,,HKD,,Sample HK,
2026-09-01,IBKR,DDD@NMS,BUY,100,10,,USD,,Delta Co,
2026-09-01,IBKR,EEE@BATS,BUY,300,40,,USD,,Epsilon ETF,
2026-10-08,IBKR,EEE@BATS,SELL,300,41.17,,USD,1.50,,keyed by hand
"""


def synthetic_data(root: Path, with_account: bool = True) -> Path:
    """A data folder from the shipped empty templates plus a small made-up book."""
    data = root / "data"
    shutil.copytree(REPO / "data", data, ignore=shutil.ignore_patterns("derived"))
    (data / "derived").mkdir()
    (data / "canonical" / "trades.csv").write_text(TRADES)
    (data / "reference" / "fx_rates.csv").write_text(
        "currency,rate_to_base,date,source\nUSD,1.30,,test\nJPY,0.0088,,test\nHKD,0.17,,test\n")
    if with_account:
        (data / "reference" / "accounts.csv").write_text(
            "account_id,name,broker,ownership,base_currency,include_in_net_worth,tracking_start,note\n"
            "IBKR,Interactive Brokers,IBKR,SELF,SGD,true,2026-01-01,\n")
    return data


class Sync(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = synthetic_data(self.tmp)
        self.xml = self.tmp / "flex.xml"
        self.xml.write_bytes(XML)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_cli(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["--data", str(self.data), "ibkr", "sync", "--file", str(self.xml), *extra])
        return code, out.getvalue()

    def rows(self, name):
        sub = "canonical" if name == "trades.csv" else "reference"
        with (self.data / sub / name).open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def test_files_new_trades_once(self):
        before = len(self.rows("trades.csv"))
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        new = self.rows("trades.csv")[before:]
        self.assertEqual([(r["instrument_id"], r["type"], r["quantity"], r["note"]) for r in new], [
            ("AAA@NASDAQ", "BUY", "10", "IBKR Flex 9001"),
            ("BBB@NYSE", "SELL", "50", "IBKR Flex 9002"),
            ("BBB@NYSE", "SELL", "50", "IBKR Flex 9003"),
            ("NEWCO@NYSE", "BUY", "5", "IBKR Flex 9005")])
        self.assertEqual(new[-1]["name"], "NEW COMPANY")  # a new name is filed with IBKR's description
        self.assertIn("already in the ledger: 1", out)  # the EEE sale keyed by hand on 8 Oct
        self.assertIn("option): not filed automatically", out)
        self.assertIn("new names", out)
        cash = [r for r in self.rows("balance_assertions.csv") if r["as_of"] == "2026-10-15"]
        self.assertEqual({(r["currency"], r["balance"]) for r in cash}, {("USD", "8123.46"), ("SGD", "-2500.50")})
        # positions: CCC, 7203.T, BBB (after the sale) and 0005.HK match; the rest are missing at IBKR
        for sym in ("CCC:", "7203.T:", "BBB:", "0005.HK:"):
            self.assertNotIn(sym, out)
        self.assertIn("DDD: IBKR 0, ledger 100", out)
        self.assertIn("XYZ", out.split("positions differ:")[1])
        self.assertNotIn("U0000000", out)

        again_before = len(self.rows("trades.csv"))
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.rows("trades.csv")), again_before)
        self.assertIn("trades filed: 0; already in the ledger: 5", out)

    def test_first_sync_adds_the_account_alias(self):
        shutil.rmtree(self.tmp)
        self.tmp = Path(tempfile.mkdtemp())
        self.data = synthetic_data(self.tmp, with_account=False)
        (self.data / "canonical" / "trades.csv").write_text(TRADES.splitlines()[0] + "\n")
        self.xml = self.tmp / "flex.xml"
        self.xml.write_bytes(XML)
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        self.assertIn("Added the account 'IBKR'", out)
        opening = {r["instrument_id"]: r for r in self.rows("trades.csv") if "opening" in r["note"]}
        # held before the period: CCC, 7203.T and BBB (100 now + 100 sold) at IBKR's cost; EEE sold in full,
        # priced at its sale; 0005.HK has no cost from IBKR, so it is left for a person
        self.assertEqual({k: (r["quantity"], r["price"], r["date"]) for k, r in opening.items()}, {
            "CCC@ARCA": ("150", "30.5", "2026-10-07"), "7203.T@TSEJ": ("300", "1000", "2026-10-07"),
            "BBB@NYSE": ("200", "50", "2026-10-07"), "EEE@BATS": ("300", "41.17", "2026-10-07")})
        self.assertIn("first sync: 4 opening position(s)", out)
        self.assertIn("0005.HK: IBKR 4000, ledger 0", out)
        self.assertEqual([r["account_id"] for r in self.rows("accounts.csv")], ["IBKR"])
        self.assertNotIn("U0000000", (self.data / "reference" / "accounts.csv").read_text())

    def test_dry_run_writes_nothing(self):
        before = (self.data / "canonical" / "trades.csv").read_text()
        code, out = self.run_cli("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("Dry run", out)
        self.assertEqual((self.data / "canonical" / "trades.csv").read_text(), before)

    def test_bad_trade_rolls_everything_back(self):
        self.xml.write_bytes(XML.replace(b'quantity="-50" tradePrice="60.1"', b'quantity="-5000" tradePrice="60.1"'))
        before = {p: p.read_text() for p in [self.data / "canonical" / "trades.csv",
                                             self.data / "reference" / "balance_assertions.csv"]}
        code, out = self.run_cli()
        self.assertEqual(code, 1, out)
        self.assertIn("Rejected", out)
        for p, text in before.items():
            self.assertEqual(p.read_text(), text)

    def test_missing_token(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch.dict("os.environ", {}, clear=True):
            code = cli.main(["--data", str(self.data), "ibkr", "sync"])
        self.assertEqual(code, 2)
        self.assertIn("environment settings", out.getvalue())


import unittest.mock  # noqa: E402

if __name__ == "__main__":
    unittest.main()
