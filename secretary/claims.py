#!/usr/bin/env python3
"""Expense claims: receipts in, a claim pack out, paid when the money lands.

The record is secretary/data/claims.csv: one line per receipt, no card or
account numbers. Receipt images live in the Secretary app's private storage
(the Worker's KV, owner-only), never in the repo, and are deleted 60 days after
the claim is paid (`purge`).

  claims.py add --date 2026-10-04 --merchant "Grab" --amount 182000 --currency VND
                [--category transport] [--description "Airport to hotel"] [--trip "Hanoi Oct 2026"|--no-trip]
                [--home 9.62] [--receipt FILE [--crop x0,y0,x1,y1 | --no-trim]] [--note ...]
  claims.py add --args-json FILE [--receipt FILE]   the same fields as JSON (merchant, description, note, trip, date,
                                        amount, currency, category, home): use it for text from a message, never the shell
  claims.py receipt ID FILE [--crop x0,y0,x1,y1 | --no-trim]   (replace a claim's receipt, e.g. after a bad trim)
  claims.py list [--trip NAME] [--status to_claim|submitted|paid|rejected|open]
  claims.py set ID [ID ...] --status submitted|paid|rejected [--on YYYY-MM-DD]
  claims.py edit ID --field value ...   (merchant, description, category, amount, currency, home, trip, note, date)
  claims.py delete ID                   (and its receipt)
  claims.py trip start "Hanoi Oct 2026" | trip end | trip   (new receipts are tagged to the open trip)
  claims.py export OUT_DIR [--trip NAME] [--status to_claim]   (for whoever processes your claims: an Excel sheet,
                                        one line per receipt; a zip of the receipts named to match; and the PDF)
  claims.py pack [--trip NAME] [--status to_claim] OUT.pdf   (the PDF alone: the table, then one page per receipt)

Receipts are trimmed to the paper when stored (receipt.py): upright, cropped,
at most 1800 px, JPEG; a PDF receipt becomes an image too. `add` writes the
result beside the input as <file>.receipt.jpg so it can be checked.
  claims.py match                       (reimbursements in the money bot's ledger vs submitted claims)
  claims.py purge                       (delete receipts of claims paid over 60 days ago)
  claims.py summary                     (totals by status and trip, as JSON)

Amounts are converted to your home currency (settings.json at the repo root;
SGD by default) at the ECB rate on the receipt date (frankfurter.dev, cached in
secretary/data/fx_cache.json), unless --home gives what the card actually charged.
The ledger's `home` column is that converted amount.
"""

from __future__ import annotations

import argparse
import base64
import csv
import html
import json
import mimetypes
import os
import secrets
import subprocess
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = Path(os.environ.get("SECRETARY_DATA", HERE / "data"))
FIELDS = ["id", "date", "merchant", "description", "category", "amount", "currency", "fx", "home", "trip", "status",
          "submitted_on", "paid_on", "receipt", "added_at", "note"]
CATEGORIES = ["meal", "transport", "hotel", "flight", "client", "phone", "supplies", "other"]
STATUSES = ["to_claim", "submitted", "paid", "rejected"]
KEEP_DAYS = 60
MAX_RECEIPT = 3 * 1024 * 1024
sys.path.insert(0, str(HERE))
import sync  # noqa: E402
import settings  # noqa: E402  (bots/settings.py, on the path through sync)

HOME = settings.home_currency()  # what claims are totalled in
WHOLE = ("JPY", "KRW", "VND", "IDR")  # currencies written without decimals


def now_local() -> datetime:
    return datetime.now(settings.tz())


def path() -> Path:
    return DATA / "claims.csv"


def load() -> list[dict]:
    p = path()
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def save(rows: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (r["date"], r["id"]))
    tmp = path().with_suffix(".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    tmp.replace(path())


def state() -> dict:
    p = DATA / "state.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_state(s: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "state.json").write_text(json.dumps(s, indent=1) + "\n")


# ------------------------------------------------------------------ fx
def _curl_json(url: str) -> dict:
    out = subprocess.run(["curl", "-sS", "--fail", "--max-time", "20", url], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def fetch_rate(ccy: str, day: str, home: str | None = None) -> tuple[float, str, str]:
    """Home currency per 1 unit of ccy on day: ECB via frankfurter.dev, else Yahoo (latest)."""
    home = (home or HOME).upper()
    try:  # quoted as units per home and inverted: the API rounds small rates (IDR) otherwise
        d = _curl_json(f"https://api.frankfurter.dev/v1/{day}?base={home}&symbols={ccy}")
        if d.get("rates", {}).get(ccy):
            return 1 / float(d["rates"][ccy]), d["date"], "ECB (frankfurter.dev)"
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        pass
    d = _curl_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{home}{ccy}=X?range=5d&interval=1d")
    px = d["chart"]["result"][0]["meta"]["regularMarketPrice"]
    return 1 / float(px), date.today().isoformat(), f"Yahoo {home}{ccy}=X (latest)"


def rate(ccy: str, day: str) -> float:
    """Home currency per 1 unit of ccy on day (ECB), cached so a re-run gives the same answer."""
    ccy = ccy.upper()
    if ccy == HOME:
        return 1.0
    cache_p = DATA / "fx_cache.json"
    cache = json.loads(cache_p.read_text()) if cache_p.exists() else {}
    key = f"{ccy}:{HOME}:{day}"
    if key not in cache:
        r, d, src = fetch_rate(ccy, day)
        cache[key] = {"rate": r, "date": d, "source": src}
        DATA.mkdir(parents=True, exist_ok=True)
        cache_p.write_text(json.dumps(cache, indent=1, sort_keys=True) + "\n")
    return float(cache[key]["rate"])


# ------------------------------------------------------------------ receipts (the app's storage)
def _app():
    cfg, tok = sync.config(), sync.token()
    if not cfg or not tok:
        raise SystemExit("The Secretary app isn't set up (secretary/app/config.json and SECRETARY_BOT_TOKEN): receipts can't be stored yet.")
    return cfg, tok


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def trim_check(cid: str, info: dict) -> str:
    """What the bot must do next: look at the stored image, and fix it if the paper doesn't fill it."""
    if info.get("how") == "by hand":
        return f"CHECK: open {info['preview']} and confirm the receipt fills it."
    why = "it was NOT trimmed" if not info.get("cropped") else "the automatic trim often leaves background"
    return (f"CHECK: open {info['preview']} now ({why}). If more than a thin border of table, floor or hand shows, "
            f"or any of the receipt is cut off, redo it: claims.py receipt {cid} <original file> --crop x0,y0,x1,y1 "
            f"(fractions of the original photo, around the paper's corners).")


def put_receipt(cid: str, file: Path, crop: str | None = None, trim: bool = True) -> dict:
    """Trim the receipt to the paper, store it in the app, and leave a preview beside the input."""
    import receipt as R
    raw = file.read_bytes()
    if len(raw) > 25 * 1024 * 1024:
        raise SystemExit(f"Receipt is {len(raw) // (1024 * 1024)} MB; send a smaller photo or PDF.")
    mime = mimetypes.guess_type(file.name)[0] or ("application/pdf" if raw[:5] == b"%PDF-" else "image/jpeg")
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"):
        raise SystemExit(f"Receipts can be photos (JPEG, PNG, WebP) or PDFs, not {mime}.")
    cfg, tok = _app()
    try:
        data, info = R.prepare(raw, mime, R.parse_crop(crop), trim)
    except Exception as e:  # noqa: BLE001 - an image Pillow can't read
        raise SystemExit(f"Couldn't read that receipt ({e}). Send it as a JPEG photo or a PDF.")
    preview = file.with_name(file.name + ".receipt.jpg")
    preview.write_bytes(data)
    info["preview"] = str(preview)
    sync.post(cfg, tok, "/api/receipt", {"op": "receipt", "ts": _ts(), "id": cid, "mime": "image/jpeg", "data": base64.b64encode(data).decode()}, max_time=60)
    return info


def get_receipt(cid: str) -> tuple[str, bytes] | None:
    cfg, tok = _app()
    try:
        r = sync.post(cfg, tok, "/api/receipt/get", {"op": "receipt_get", "ts": _ts(), "id": cid}, max_time=60)
    except RuntimeError:
        return None
    return r["mime"], base64.b64decode(r["data"])


def drop_receipt(cid: str) -> None:
    cfg, tok = _app()
    sync.post(cfg, tok, "/api/receipt/delete", {"op": "receipt_delete", "ts": _ts(), "id": cid})


# ------------------------------------------------------------------ commands
def new_id(day: str) -> str:
    return f"{day.replace('-', '')}-{secrets.token_hex(3)}"


def money(x: float, ccy: str) -> str:
    return f"{ccy} {x:,.0f}" if ccy in WHOLE else f"{ccy} {x:,.2f}"


def add(a) -> dict:
    day = a.date or now_local().date().isoformat()
    date.fromisoformat(day)
    ccy = a.currency.upper()
    if a.category not in CATEGORIES:
        raise SystemExit(f"category must be one of {', '.join(CATEGORIES)}")
    fx = rate(ccy, day)
    home = round(a.home if a.home is not None else a.amount * fx, 2)
    trip = "" if a.no_trip else (a.trip if a.trip is not None else state().get("trip", ""))
    rows = load()
    dup = [r for r in rows if r["date"] == day and r["merchant"].lower() == a.merchant.lower() and abs(float(r["amount"]) - a.amount) < 0.005 and r["currency"] == ccy]
    if dup and not a.force:
        raise SystemExit(f"Looks like a duplicate of {dup[0]['id']} ({dup[0]['merchant']} {money(float(dup[0]['amount']), ccy)} on {day}). Add --force if it isn't.")
    row = {"id": new_id(day), "date": day, "merchant": a.merchant.strip()[:80], "description": (a.description or "").strip()[:160],
           "category": a.category, "amount": f"{a.amount:.2f}", "currency": ccy, "fx": f"{fx:.6f}", "home": f"{home:.2f}", "trip": trip,
           "status": "to_claim", "submitted_on": "", "paid_on": "", "receipt": "", "added_at": now_local().isoformat(timespec="seconds"),
           "note": (a.note or "").strip()[:200]}
    if a.receipt:
        row["_receipt"] = put_receipt(row["id"], Path(a.receipt), a.crop, not a.no_trim)
        row["receipt"] = "app"
    rows.append(row)
    save(rows)
    return row


def select(rows: list[dict], trip: str | None = None, status: str | None = None) -> list[dict]:
    out = rows
    if trip:
        out = [r for r in out if r["trip"].lower() == trip.lower()]
    if status == "open":
        out = [r for r in out if r["status"] in ("to_claim", "submitted")]
    elif status:
        out = [r for r in out if r["status"] == status]
    return out


def summary(rows: list[dict]) -> dict:
    by_status = defaultdict(float)
    by_trip: dict[str, dict] = {}
    for r in rows:
        by_status[r["status"]] += float(r["home"])
        t = by_trip.setdefault(r["trip"] or "(no trip)", {"count": 0, "home": 0.0, "open": 0.0})
        t["count"] += 1
        t["home"] += float(r["home"])
        if r["status"] in ("to_claim", "submitted"):
            t["open"] += float(r["home"])
    return {"by_status": {k: round(v, 2) for k, v in by_status.items()},
            "by_trip": {k: {**v, "home": round(v["home"], 2), "open": round(v["open"], 2)} for k, v in by_trip.items()},
            "open_trip": state().get("trip", ""), "currency": HOME}


def set_status(ids: list[str], status: str, on: str | None) -> list[dict]:
    if status not in STATUSES:
        raise SystemExit(f"status must be one of {', '.join(STATUSES)}")
    rows = load()
    by = {r["id"]: r for r in rows}
    missing = [i for i in ids if i not in by]
    if missing:
        raise SystemExit(f"no claim {', '.join(missing)}")
    day = on or now_local().date().isoformat()
    for i in ids:
        r = by[i]
        r["status"] = status
        if status == "submitted":
            r["submitted_on"] = r["submitted_on"] or day
        if status == "paid":
            r["paid_on"] = day
    save(rows)
    return [by[i] for i in ids]


def rate_text(r: dict) -> str:
    """The rate as people say it: "1 SGD = 20,161 VND", or "—" in the home currency."""
    fx = float(r["fx"] or 0)
    if r["currency"] == HOME or not fx:
        return "—"
    inv = 1 / fx
    return f"1 {HOME} = {inv:,.0f} {r['currency']}" if inv >= 100 else f"1 {HOME} = {inv:,.4f} {r['currency']}"


def pack(rows: list[dict], out: Path, title: str) -> Path:
    """A claim pack: a summary table, then each receipt on its own page."""
    if not rows:
        raise SystemExit("Nothing to pack.")
    esc = html.escape
    total = sum(float(r["home"]) for r in rows)
    by_cat = defaultdict(float)
    for r in rows:
        by_cat[r["category"]] += float(r["home"])
    trs = "".join(
        f"<tr><td>{esc(r['date'])}</td><td>{esc(r['merchant'])}<small>{esc(r['description'])}</small></td><td>{esc(r['category'])}</td>"
        f"<td class=r>{esc(money(float(r['amount']), r['currency']))}</td><td class=r>{esc(rate_text(r))}</td><td class=r>{float(r['home']):,.2f}</td>"
        f"<td>{'✓' if r['receipt'] else '—'}</td></tr>" for r in rows)
    cats = "".join(f"<tr><td>{esc(c)}</td><td class=r>{v:,.2f}</td></tr>" for c, v in sorted(by_cat.items(), key=lambda x: -x[1]))
    pages = []
    for r in rows:
        if not r["receipt"]:
            continue
        got = get_receipt(r["id"])
        if not got:
            pages.append(f"<section class=rc><h2>{esc(r['date'])} · {esc(r['merchant'])}</h2><p>Receipt not found in storage.</p></section>")
            continue
        mime, raw = got
        cap = f"{esc(r['date'])} · {esc(r['merchant'])} · {esc(money(float(r['amount']), r['currency']))} ({HOME} {float(r['home']):,.2f})"
        if mime == "application/pdf":
            pages.append(f"<section class=rc><h2>{cap}</h2><p>PDF receipt: attached separately ({r['id']}.pdf).</p></section>")
            (out.parent / f"{r['id']}.pdf").write_bytes(raw)
        else:
            pages.append(f"<section class=rc><h2>{cap}</h2><div class=img><img src='data:{mime};base64,{base64.b64encode(raw).decode()}'></div></section>")
    doc = f"""<!doctype html><meta charset=utf-8><title>{esc(title)}</title><style>
@page {{ size: A4; margin: 16mm 14mm; }}
body {{ font: 10.5pt/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d1a2a; }}
h1 {{ font-size: 18pt; margin: 0 0 4pt; }} .sub {{ color: #555; margin: 0 0 12pt; }}
table {{ width: 100%; border-collapse: collapse; margin-bottom: 12pt; }} th, td {{ text-align: left; padding: 4pt 5pt; border-bottom: .5pt solid #ccc; vertical-align: top; }}
th {{ font-size: 9pt; color: #555; }} td small {{ display: block; color: #666; font-size: 8.5pt; }} .r {{ text-align: right; white-space: nowrap; }}
tfoot td {{ font-weight: 700; border-top: 1pt solid #333; }}
.rc {{ break-before: page; height: 265mm; display: flex; flex-direction: column; overflow: hidden; }}
.rc h2 {{ font-size: 10.5pt; margin: 0 0 6pt; flex: none; }}
.rc .img {{ flex: 1; min-height: 0; display: flex; align-items: flex-start; justify-content: center; }}
.rc img {{ max-width: 100%; max-height: 100%; object-fit: contain; border: .5pt solid #ddd; }}
</style>
<h1>{esc(title)}</h1><p class=sub>{len(rows)} receipts · {HOME} {total:,.2f} · prepared {now_local().date().isoformat()} · {HOME} at the ECB rate on each receipt's date unless the card's charge was given</p>
<table><thead><tr><th>Date</th><th>Merchant</th><th>Type</th><th class=r>Amount</th><th class=r>Rate</th><th class=r>{HOME}</th><th>Receipt</th></tr></thead>
<tbody>{trs}</tbody><tfoot><tr><td colspan=5>Total</td><td class=r>{total:,.2f}</td><td></td></tr></tfoot></table>
<table style="width:50%"><thead><tr><th>By type</th><th class=r>{HOME}</th></tr></thead><tbody>{cats}</tbody></table>
{''.join(pages)}"""
    html_p = out.with_suffix(".html")
    html_p.write_text(doc, encoding="utf-8")
    subprocess.run(["bash", str(ROOT / "bots" / "render.sh"), str(html_p), str(out)], check=True, capture_output=True)
    html_p.unlink()
    return out


def _slug(t: str, n: int = 28) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-")[:n] or "receipt"


EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf"}


def export(rows: list[dict], out_dir: Path, name: str) -> list[Path]:
    """An Excel file whoever processes the claims can work from, and a zip of the receipts named after their line numbers."""
    import zipfile
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    if not rows:
        raise SystemExit("Nothing to export.")
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{now_local().strftime('%Y.%m.%d')}_{name} Claims"
    receipts: list[tuple[str, bytes]] = []
    wb = Workbook()
    ws = wb.active
    ws.title = "Claims"
    head = ["No.", "Date", "Merchant", "What for", "Type", "Amount", "Currency", f"Rate to {HOME}", HOME, "Trip", "Receipt file", "Status", "Claim ID"]
    ws.append([f"Expense claims · {name}"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([f"{len(rows)} receipts · prepared {now_local().date().isoformat()} · {HOME} at the ECB rate on each receipt's date, unless the card's charge was given"])
    ws["A2"].font = Font(italic=True, color="666666")
    ws.append([])
    ws.append(head)
    for c in ws[4]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2F2A5E")
        c.alignment = Alignment(vertical="center")
    first = 5
    for i, r in enumerate(rows, 1):
        fname = ""
        if r["receipt"]:
            got = get_receipt(r["id"])
            if got:
                mime, raw = got
                fname = f"{i:02d}_{r['date']}_{_slug(r['merchant'])}{EXT.get(mime, '')}"
                receipts.append((fname, raw))
            else:
                fname = "(missing)"
        ws.append([i, date.fromisoformat(r["date"]), r["merchant"], r["description"], r["category"], float(r["amount"]), r["currency"],
                   float(r["fx"]), float(r["home"]), r["trip"], fname or "(none)", r["status"].replace("_", " "), r["id"]])
    last = first + len(rows) - 1
    ws.append([])
    ws.append(["", "", "", "", "Total", "", "", "", f"=SUM(I{first}:I{last})"])
    for c in ws[last + 2]:
        c.font = Font(bold=True)
    for row in ws.iter_rows(min_row=first, max_row=last + 2):
        row[1].number_format = "dd mmm yyyy"
        row[5].number_format = "#,##0.00"
        row[7].number_format = "0.000000"
        row[8].number_format = "#,##0.00"
    for i, w in enumerate([5, 12, 26, 30, 11, 13, 9, 12, 11, 18, 34, 11, 17], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A5"
    ws.auto_filter.ref = f"A4:M{last}"
    by = wb.create_sheet("By type")
    by.append(["Type", "Receipts", HOME])
    for c in by[1]:
        c.font = Font(bold=True)
    for k, cat in enumerate(sorted({r["category"] for r in rows}), 2):
        by.append([cat, f'=COUNTIF(Claims!E{first}:E{last},A{k})', f'=SUMIF(Claims!E{first}:E{last},A{k},Claims!I{first}:I{last})'])
        by.cell(k, 3).number_format = "#,##0.00"
    by.column_dimensions["A"].width = 14
    by.column_dimensions["C"].width = 12
    xlsx = out_dir / f"{stem}.xlsx"
    wb.save(xlsx)
    out = [xlsx, pack(rows, out_dir / f"{stem}.pdf", f"Expense claims · {name}")]
    if receipts:
        z = out_dir / f"{stem} Receipts.zip"
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for fname, raw in receipts:
                zf.writestr(fname, raw)
        out.append(z)
    return out


def match(rows: list[dict], txns: list[dict], tolerance: float = 0.02) -> list[dict]:
    """Reimbursements in the bank ledger that equal a submitted batch (same submission day, or one claim)."""
    out = []
    batches: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["status"] == "submitted":
            batches[r["submitted_on"] or "?"].append(r)
    for t in txns:
        amt = float(t["amount"])
        if amt <= 0:
            continue
        for day, rs in batches.items():
            if day != "?" and t["date"] < day:
                continue
            total = sum(float(r["home"]) for r in rs)
            singles = [r for r in rs if abs(float(r["home"]) - amt) <= max(0.05, tolerance * amt)]
            if abs(total - amt) <= max(0.5, tolerance * total):
                out.append({"txn": t, "claims": [r["id"] for r in rs], "home": round(total, 2), "kind": "batch"})
            elif singles:
                out.append({"txn": t, "claims": [singles[0]["id"]], "home": float(singles[0]["home"]), "kind": "single"})
    return out


def reimbursements() -> list[dict]:
    """Money in, categorised as reimbursement, from the money bot's ledger (date, amount,
    description). Empty when the money bot isn't set up: then the owner says when a claim is paid."""
    sys.path.insert(0, str(ROOT / "finance" / "src"))
    try:
        from finance import spending
        txns = spending.transactions(ROOT / "finance" / "data")
    except Exception:  # noqa: BLE001 - no money bot, or no ledger yet
        return []
    out = []
    for t in txns:
        if t.amount > 0 and t.category in ("reimbursement", "income_other") and t.currency == HOME:
            out.append({"date": t.date.isoformat(), "amount": f"{t.amount:.2f}", "desc": t.description[:60], "account": t.account_id})
    return out


def purge(rows: list[dict], today: date | None = None) -> list[str]:
    today = today or now_local().date()
    gone = []
    for r in rows:
        if r["receipt"] and r["status"] in ("paid", "rejected") and r["paid_on"] and (today - date.fromisoformat(r["paid_on"])).days > KEEP_DAYS:
            drop_receipt(r["id"])
            r["receipt"] = ""
            gone.append(r["id"])
    if gone:
        save(rows)
    return gone


def line(r: dict) -> str:
    return (f"{r['id']}  {r['date']}  {r['merchant'][:28]:28}  {money(float(r['amount']), r['currency']):>16}  {HOME} {float(r['home']):>9,.2f}  "
            f"{r['status']:9} {r['trip'] or '-'}{'  [receipt]' if r['receipt'] else ''}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--date")
    a.add_argument("--merchant")
    a.add_argument("--amount", type=float)
    a.add_argument("--args-json", help="a JSON file with any of the fields above (for text from a message)")
    a.add_argument("--currency", default=HOME)
    a.add_argument("--category", default="other")
    a.add_argument("--description")
    a.add_argument("--trip")
    a.add_argument("--no-trip", action="store_true")
    a.add_argument("--home", type=float, help=f"what the card actually charged, in {HOME}")
    a.add_argument("--receipt")
    a.add_argument("--crop")
    a.add_argument("--no-trim", action="store_true")
    a.add_argument("--note")
    a.add_argument("--force", action="store_true")
    rc = sub.add_parser("receipt")
    rc.add_argument("id")
    rc.add_argument("file")
    rc.add_argument("--crop")
    rc.add_argument("--no-trim", action="store_true")
    ls = sub.add_parser("list")
    ls.add_argument("--trip")
    ls.add_argument("--status")
    st = sub.add_parser("set")
    st.add_argument("ids", nargs="+")
    st.add_argument("--status", required=True)
    st.add_argument("--on")
    ed = sub.add_parser("edit")
    ed.add_argument("id")
    for f in ("merchant", "description", "category", "currency", "trip", "note", "date"):
        ed.add_argument(f"--{f}")
    ed.add_argument("--amount", type=float)
    ed.add_argument("--home", type=float)
    dl = sub.add_parser("delete")
    dl.add_argument("id")
    tr = sub.add_parser("trip")
    tr.add_argument("action", nargs="?", choices=["start", "end"])
    tr.add_argument("name", nargs="?")
    ex = sub.add_parser("export")
    ex.add_argument("out_dir")
    ex.add_argument("--trip")
    ex.add_argument("--status", default="to_claim")
    ex.add_argument("--name")
    pk = sub.add_parser("pack")
    pk.add_argument("out")
    pk.add_argument("--trip")
    pk.add_argument("--status", default="to_claim")
    sub.add_parser("match")
    sub.add_parser("purge")
    sub.add_parser("summary")
    args = p.parse_args(argv)

    if args.cmd == "add":
        if args.args_json:
            extra = json.loads(Path(args.args_json).read_text(encoding="utf-8"))
            if not isinstance(extra, dict):
                raise SystemExit("--args-json must hold a JSON object")
            for k in ("merchant", "description", "note", "trip", "date", "currency", "category"):
                if extra.get(k) is not None:
                    setattr(args, k, str(extra[k]))
            for k in ("amount", "home"):
                if extra.get(k) is not None:
                    setattr(args, k, float(extra[k]))
        if not args.merchant or args.amount is None:
            raise SystemExit("add needs a merchant and an amount (--merchant/--amount or --args-json)")
        r = add(args)
        trip = f" · trip {r['trip']}" if r["trip"] else ""
        info = r.pop("_receipt", None)
        kept = f" · receipt stored ({info['how']}{', ' + str(round(info['kept'] * 100)) + '% of the photo' if info.get('kept') else ''})" if info else ""
        print(f"Logged {r['id']}: {r['merchant']} {money(float(r['amount']), r['currency'])} = {HOME} {float(r['home']):,.2f}{trip}{kept}")
        if info:
            print(trim_check(r["id"], info))
    elif args.cmd == "receipt":
        rows = load()
        r = next((x for x in rows if x["id"] == args.id), None)
        if not r:
            raise SystemExit(f"no claim {args.id}")
        info = put_receipt(r["id"], Path(args.file), args.crop, not args.no_trim)
        r["receipt"] = "app"
        save(rows)
        print(f"Receipt for {r['id']} replaced ({info['how']})")
        print(trim_check(r["id"], info))
    elif args.cmd == "list":
        rows = select(load(), args.trip, args.status)
        for r in rows:
            print(line(r))
        print(f"{len(rows)} claims · {HOME} {sum(float(r['home']) for r in rows):,.2f}")
    elif args.cmd == "set":
        for r in set_status(args.ids, args.status, args.on):
            print(line(r))
    elif args.cmd == "edit":
        rows = load()
        r = next((x for x in rows if x["id"] == args.id), None)
        if not r:
            raise SystemExit(f"no claim {args.id}")
        for f in ("merchant", "description", "category", "trip", "note", "date"):
            v = getattr(args, f)
            if v is not None:
                if f == "category" and v not in CATEGORIES:
                    raise SystemExit(f"category must be one of {', '.join(CATEGORIES)}")
                r[f] = v
        if args.currency:
            r["currency"] = args.currency.upper()
        if args.amount is not None:
            r["amount"] = f"{args.amount:.2f}"
        if args.amount is not None or args.currency or args.date:
            r["fx"] = f"{rate(r['currency'], r['date']):.6f}"
            r["home"] = f"{float(r['amount']) * float(r['fx']):.2f}"
        if args.home is not None:
            r["home"] = f"{args.home:.2f}"
        save(rows)
        print(line(r))
    elif args.cmd == "delete":
        rows = load()
        r = next((x for x in rows if x["id"] == args.id), None)
        if not r:
            raise SystemExit(f"no claim {args.id}")
        if r["receipt"]:
            drop_receipt(r["id"])
        save([x for x in rows if x["id"] != args.id])
        print(f"Deleted {args.id}")
    elif args.cmd == "trip":
        s = state()
        if args.action == "start":
            if not args.name:
                raise SystemExit("trip start needs a name")
            s.update(trip=args.name, since=now_local().date().isoformat())
            save_state(s)
            print(f"Trip open: {args.name}. New receipts are tagged to it until `trip end`.")
        elif args.action == "end":
            print(f"Trip closed: {s.pop('trip', '(none)')}")
            s.pop("since", None)
            save_state(s)
        else:
            print(s.get("trip") or "No trip open.")
    elif args.cmd == "pack":
        rows = select(load(), args.trip, args.status)
        title = f"Expense claim · {args.trip}" if args.trip else f"Expense claim · {now_local().strftime('%d %b %Y')}"
        print(pack(rows, Path(args.out), title))
    elif args.cmd == "export":
        rows = select(load(), args.trip, args.status)
        name = args.name or args.trip or now_local().strftime("%b %Y")
        for f in export(rows, Path(args.out_dir), name):
            print(f)
    elif args.cmd == "match":
        hits = match(load(), reimbursements())
        for m in hits:
            t = m["txn"]
            print(f"{t['date']}  {HOME} {float(t['amount']):,.2f}  {t['desc']}  ->  {m['kind']} {', '.join(m['claims'])} ({HOME} {m['home']:,.2f})")
        if not hits:
            print("No reimbursement in the money bot's ledger matches a submitted claim yet (or the money bot isn't set up).")
    elif args.cmd == "purge":
        gone = purge(load())
        print(f"Deleted {len(gone)} receipts of claims paid over {KEEP_DAYS} days ago." if gone else "Nothing to purge.")
    elif args.cmd == "summary":
        print(json.dumps(summary(load()), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
