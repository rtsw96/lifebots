#!/usr/bin/env python3
"""Water: what you drink, logged by chat or from the health app.

  waterlog.py add --ml 500 [--date 2026-10-13 --time 14:05] [--ref <update_id>]
  waterlog.py undo [--date ...]           remove today's last entry
  waterlog.py today [--date ...]          today's total against the goal and the pace

Rows go to health/water_log.csv (bot data). Water, tea, coffee and other unsweetened
drinks count; alcohol doesn't. The day's goal is `water_ml` in health/settings.json
(2 L unless the onboarding set another). Through the day the pace runs from nothing at
08:00 to the full goal at the evening debrief (21:00 unless set otherwise), with two
glasses of slack, so an empty early morning reads as fine; the health app's pet takes
half its mood from how today is going against that pace (weekly.py, app.js).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import workoutlog as wl  # noqa: E402
import health_settings as hs  # noqa: E402

FIELDS = ["id", "date", "time", "ml", "source", "ref", "logged_at"]
GOAL_ML = hs.water_ml()
_END = hs.debrief_at()
DAY_START = 8 * 60                       # minutes: the pace runs from 08:00
DAY_END = max(DAY_START + 60, _END.hour * 60 + _END.minute)   # to the evening debrief
SLACK_ML = 400                           # slack, so an empty early morning reads as fine
GLASS_ML, BOTTLE_ML = 250, 500


def log_path() -> Path:
    return Path(os.environ.get("WATER_CSV", HEALTH / "water_log.csv"))


def load() -> list[dict]:
    return wl.load(log_path())


def save(rows: list[dict]) -> None:
    wl.save(log_path(), sorted(rows, key=lambda r: (r["date"], r["time"], r["id"])), FIELDS)


def total(rows: list[dict], d: str) -> int:
    return int(sum(float(r["ml"]) for r in rows if r["date"] == d))


def expected_by(mins: int, goal: int = GOAL_ML) -> int:
    """Where the day should be by this time (minutes after midnight)."""
    share = min(1.0, max(0.0, (mins - DAY_START) / (DAY_END - DAY_START)))
    return round(goal * share)


def pace(ml: float, mins: int, goal: int = GOAL_ML) -> float:
    """0 to 1: today's water against where it should be by now (app.js has the same sum)."""
    return round(min(1.0, (ml + SLACK_ML) / (expected_by(mins, goal) + SLACK_ML)), 2)


def add(rows: list[dict], ml: int, d: str, t: str, source: str, ref: str = "", row_id: str = "") -> dict | None:
    """Append one drink. Dedup on ref. Returns the row, or None if it was already logged."""
    if ref and any(r["ref"] == ref for r in rows):
        return None
    if not (0 < ml <= 3000):
        raise SystemExit(f"{ml} ml looks wrong: give the amount in ml (a glass is {GLASS_ML}).")
    row = {"id": row_id or f"c{int(wl.now().timestamp() * 1000)}", "date": d, "time": t, "ml": str(int(ml)),
           "source": source, "ref": ref, "logged_at": wl.now().isoformat(timespec="seconds")}
    rows.append(row)
    return row


def remove(rows: list[dict], row_id: str) -> dict | None:
    for r in rows:
        if r["id"] == row_id:
            rows.remove(r)
            return r
    return None


def litres(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".") + " L"


def today_line(rows: list[dict], now: datetime) -> str:
    d = now.date().isoformat()
    ml = total(rows, d)
    mins = now.hour * 60 + now.minute
    exp = expected_by(mins)
    n = len([r for r in rows if r["date"] == d])
    head = f"Water today: {litres(ml)} of {litres(GOAL_ML)} ({round(ml / GOAL_ML * 100)}%, {n} drink{'s' if n != 1 else ''})"
    if ml >= GOAL_ML:
        return head + ". Goal reached."
    if mins >= DAY_END:
        return head + f". {GOAL_ML - ml:,} ml short of the goal."
    if ml >= exp:
        return head + f". On pace (about {litres(exp)} by now)."
    return head + f". {exp - ml:,} ml behind the pace for {now.strftime('%H:%M')}; {GOAL_ML - ml:,} ml to go by {DAY_END // 60:02d}:{DAY_END % 60:02d}."


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("add")
    s.add_argument("--ml", type=float, required=True)
    s.add_argument("--date")
    s.add_argument("--time")
    s.add_argument("--ref", default="")
    s = sub.add_parser("undo")
    s.add_argument("--date")
    s = sub.add_parser("today")
    s.add_argument("--date")
    a = p.parse_args(argv)
    now = wl.now()
    rows = load()
    if a.cmd == "add":
        d = a.date or now.date().isoformat()
        t = a.time or now.strftime("%H:%M")
        date.fromisoformat(d)
        if not add(rows, round(a.ml), d, t, "chat", a.ref):
            print(f"Already logged (ref {a.ref}).")
        else:
            save(rows)
    elif a.cmd == "undo":
        d = a.date or now.date().isoformat()
        mine = sorted([r for r in rows if r["date"] == d], key=lambda r: (r["time"], r["logged_at"]))
        if not mine:
            print("No water logged that day.")
            return 0
        remove(rows, mine[-1]["id"])
        save(rows)
        print(f"Removed {mine[-1]['ml']} ml at {mine[-1]['time']}.")
    if a.date and a.date != now.date().isoformat():   # a past day: show it as it ended
        now = datetime.combine(date.fromisoformat(a.date), datetime.max.time().replace(microsecond=0), now.tzinfo)
    print(today_line(rows, now))
    return 0


if __name__ == "__main__":
    sys.exit(main())
