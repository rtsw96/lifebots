#!/usr/bin/env python3
"""Body-composition scans (InBody, Tanita and the like), sent to the health bot.

  bodyscan.py add --json-file <file> [--ref <update_id>]
      the file holds {"date": "2026-10-22", "time": "07:10", "device": "InBody 570",
                      "weight_kg": 80.4, "body_fat_pct": 24.0, ...}
      log one scan (the numbers read off the photo or PDF); its weight and waist also go to
      body_log.csv as that day's weigh-in. A scan already logged (same date, time and device)
      is skipped. Prints the comparison below.
  bodyscan.py compare [--date YYYY-MM-DD]
      the latest scan (or the one on that date) against the one before and the first one
  bodyscan.py list

Rows go to health/body_scan_log.csv (bot data): the numbers only. The scan's photo or PDF
is deleted once read, like a meal photo; its name, age and height are never copied.
Readings from different machines aren't comparable, so comparisons use scans from the
same device.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import workoutlog as wl  # noqa: E402

# The measures, in the order they are shown. (field, label, unit, plausible range)
MEASURES = [
    ("weight_kg", "Weight", "kg", (30, 250)),
    ("body_fat_pct", "Body fat", "%", (2, 70)),
    ("body_fat_kg", "Fat mass", "kg", (1, 150)),
    ("skeletal_muscle_kg", "Skeletal muscle", "kg", (10, 80)),
    ("lean_mass_kg", "Lean mass", "kg", (20, 150)),
    ("visceral_fat_level", "Visceral fat level", "", (1, 30)),
    ("visceral_fat_area_cm2", "Visceral fat area", "cm²", (10, 400)),
    ("trunk_fat_kg", "Torso fat", "kg", (0.5, 60)),
    ("waist_cm", "Waist", "cm", (40, 200)),
    ("total_body_water_kg", "Body water", "kg", (15, 100)),
    ("bmr_kcal", "BMR", "kcal", (800, 4000)),
    ("score", "Device score", "", (0, 100)),
]
FIELDS = ["date", "time", "device"] + [m[0] for m in MEASURES] + ["source", "ref", "notes"]
# Which way is better, for the comparison's words (None: no direction)
BETTER = {"body_fat_pct": -1, "body_fat_kg": -1, "skeletal_muscle_kg": 1, "lean_mass_kg": 1,
          "visceral_fat_level": -1, "visceral_fat_area_cm2": -1, "trunk_fat_kg": -1, "waist_cm": -1}


def path() -> Path:
    return Path(os.environ.get("BODY_SCAN_CSV", HEALTH / "body_scan_log.csv"))


def load() -> list[dict]:
    return wl.load(path())


def num(v):
    if v in (None, ""):
        return None
    return float(v)


def clean(data: dict) -> dict:
    """Validate one scan's numbers; raises ValueError with the reason."""
    if not data.get("date") or len(str(data["date"])) != 10:
        raise ValueError("date (YYYY-MM-DD) is required")
    row = {"date": str(data["date"]), "time": str(data.get("time") or "")[:5],
           "device": str(data.get("device") or "unknown")[:40]}
    for f, label, _, (lo, hi) in MEASURES:
        v = num(data.get(f))
        if v is not None and not lo <= v <= hi:
            raise ValueError(f"{label} {v} is outside {lo}-{hi}: check the reading")
        row[f] = "" if v is None else (int(v) if v == int(v) else round(v, 2))
    if row["weight_kg"] == "" and row["body_fat_pct"] == "":
        raise ValueError("a scan needs at least the weight or the body fat %")
    row["notes"] = str(data.get("notes") or "")[:200]
    return row


def add(data: dict, ref: str = "", source: str = "scan") -> tuple[dict | None, list[dict]]:
    rows = load()
    row = clean(data)
    if any(r["date"] == row["date"] and r["time"] == row["time"] and r["device"] == row["device"] for r in rows):
        return None, rows
    row.update(source=source, ref=ref)
    rows.append(row)
    rows.sort(key=lambda r: (r["date"], r["time"]))
    wl.save(path(), rows, FIELDS)
    if row["weight_kg"] != "":  # the scan is that day's weigh-in too
        body = [r for r in wl.load(wl.body_path()) if r["date"] != row["date"]]
        body.append({"date": row["date"], "time": row["time"], "weight_kg": row["weight_kg"],
                     "waist_cm": row["waist_cm"], "source": "scan", "notes": row["device"]})
        body.sort(key=lambda r: r["date"])
        wl.save(wl.body_path(), body, wl.BODY_FIELDS)
    return row, rows


def fmt(v, unit=""):
    s = f"{v:g}" if isinstance(v, (int, float)) else str(v)
    return f"{s} {unit}".strip()


def change(f, a, b):
    """'+0.4 kg' style change from b to a, with a word when one direction is better."""
    d = round(a - b, 2)
    if d == 0:
        return "no change"
    unit = next(m[2] for m in MEASURES if m[0] == f)
    word = ""
    if f in BETTER:
        word = " (better)" if d * BETTER[f] > 0 else " (worse)"
    return f"{d:+g} {unit}".strip() + word


def compare(rows: list[dict], on: str | None = None) -> str:
    if not rows:
        return "No body scans logged yet."
    cur = next((r for r in reversed(rows) if r["date"] == on), None) if on else rows[-1]
    if not cur:
        return f"No scan on {on}."
    same = [r for r in rows if r["device"] == cur["device"] and (r["date"], r["time"]) < (cur["date"], cur["time"])]
    prev, first = (same[-1] if same else None), (same[0] if len(same) > 1 else None)
    lines = [f"Scan {cur['date']}{' ' + cur['time'] if cur['time'] else ''} ({cur['device']}):"]
    for f, label, unit, _ in MEASURES:
        v = num(cur.get(f))
        if v is None:
            continue
        bits = [fmt(v, unit)]
        if prev and num(prev.get(f)) is not None:
            bits.append(f"{change(f, v, num(prev[f]))} since {prev['date']}")
        if first and num(first.get(f)) is not None:
            bits.append(f"{change(f, v, num(first[f]))} since {first['date']}")
        lines.append(f"  {label}: " + "; ".join(bits))
    if not prev:
        lines.append("  First scan on this device: the next one will show the change.")
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    a_ = sub.add_parser("add")
    src = a_.add_mutually_exclusive_group(required=True)
    src.add_argument("--json-file", help="a file holding the scan's JSON (preferred: nothing read off a scan goes on the command line)")
    src.add_argument("--json", help="the scan's JSON inline (numbers only)")
    a_.add_argument("--ref", default="")
    c = sub.add_parser("compare")
    c.add_argument("--date")
    sub.add_parser("list")
    a = p.parse_args(argv)
    if a.cmd == "add":
        try:
            raw = Path(a.json_file).read_text() if a.json_file else a.json
            row, rows = add(json.loads(raw), a.ref)
        except (OSError, ValueError, json.JSONDecodeError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if row is None:
            print("Already logged: that scan (same date, time and device) is in the log.")
            return 0
        print(compare(rows, row["date"]))
    elif a.cmd == "compare":
        print(compare(load(), a.date))
    else:
        for r in load():
            print(f"{r['date']} {r['time']} {r['device']}: " + ", ".join(
                f"{label} {fmt(num(r[f]), unit)}" for f, label, unit, _ in MEASURES if r.get(f) not in ("", None)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
