#!/usr/bin/env python3
"""Reminders: the secretary bot messages the owner at a set time.

  remind.py add --at "2026-10-16 16:00" Renew the passport    one-off (your local time)
  remind.py add --at +30m Call the bank                       relative: +45m, +2h, +1d
  remind.py add --at "2026-10-20 09:00" --repeat weekdays Stand-up notes
  remind.py add --at "2026-10-20 09:00" --text-file /tmp/r.txt          the text from a file (message text: never the shell)
  remind.py list                                              pending reminders
  remind.py cancel r3
  remind.py snooze r3 [--minutes 30]                          again in N minutes
  remind.py due                                               seconds until the next one (0 = due now)
  remind.py send                                              send every due reminder now

The listener (bot/listen.py) calls send_due() on every poll, so a reminder goes
out within about a minute of its time without waking the agent. Times are in your
timezone (settings.json at the repo root).
Reminders live in secretary/data/reminders.csv, which is bot data (straight to
main). Keep them to what the owner asked for in their own words: no card or
account numbers, no calendar details.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parent / "bots"))
import settings  # noqa: E402

TZ = settings.tz()
FIELDS = ["id", "due", "text", "repeat", "status", "created", "sent_at"]
REPEATS = {"", "daily", "weekdays", "weekly"}
LATE = timedelta(minutes=10)  # later than this, the message says when it was due
IDLE = 86400  # `due` when nothing is pending


def path() -> Path:
    return Path(os.environ.get("SECRETARY_REMINDERS", HERE / "data" / "reminders.csv"))


def load() -> List[dict]:
    p = path()
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as fh:
        return [dict(r) for r in csv.DictReader(fh)]


def save(rows: List[dict]) -> None:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    tmp.replace(p)


def _iso(dt: datetime) -> str:
    return dt.astimezone(TZ).isoformat(timespec="minutes")


def _when(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone(TZ)


def parse_at(text: str, now: datetime) -> datetime:
    """"2026-10-16 16:00", "2026-10-16T16:00+08:00", "16:00" (today, or tomorrow if past), "+30m"."""
    t = text.strip()
    m = re.fullmatch(r"\+(\d+)\s*([mhd])", t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return now + timedelta(**{{"m": "minutes", "h": "hours", "d": "days"}[unit]: n})
    if re.fullmatch(r"\d{1,2}:\d{2}", t):
        hh, mm = map(int, t.split(":"))
        at = now.astimezone(TZ).replace(hour=hh, minute=mm, second=0, microsecond=0)
        return at if at > now else at + timedelta(days=1)
    dt = datetime.fromisoformat(t.replace(" ", "T"))
    return (dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt).astimezone(TZ)


def next_repeat(due: datetime, repeat: str, now: datetime) -> datetime:
    step = timedelta(days=7 if repeat == "weekly" else 1)
    nxt = due + step
    while nxt <= now or (repeat == "weekdays" and nxt.weekday() >= 5):
        nxt += timedelta(days=1) if repeat == "weekdays" else step
    return nxt


def label(dt: datetime) -> str:
    return dt.astimezone(TZ).strftime("%a %-d %b, %H:%M")


def add(text: str, at: datetime, repeat: str = "", now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(TZ)
    if repeat not in REPEATS:
        raise ValueError("repeat must be one of: daily, weekdays, weekly")
    if not text.strip():
        raise ValueError("a reminder needs some text")
    rows = load()
    n = max([int(r["id"][1:]) for r in rows if r["id"][1:].isdigit()] or [0]) + 1
    row = {"id": f"r{n}", "due": _iso(at), "text": " ".join(text.split()), "repeat": repeat,
           "status": "pending", "created": _iso(now), "sent_at": ""}
    rows.append(row)
    save(rows)
    return row


def pending(rows: Optional[List[dict]] = None) -> List[dict]:
    return sorted((r for r in (load() if rows is None else rows) if r["status"] == "pending"),
                  key=lambda r: _when(r["due"]))


def due_in(now: datetime) -> int:
    p = pending()
    if not p:
        return IDLE
    return max(0, int((_when(p[0]["due"]) - now).total_seconds()))


def message(r: dict, now: datetime) -> str:
    due = _when(r["due"])
    late = f"\n(due {label(due)}; I was offline then)" if now - due > LATE else ""
    again = {"daily": "every day", "weekdays": "every weekday", "weekly": "every week"}.get(r["repeat"])
    tail = f"\nRepeats {again}. Reply \"stop {r['id']}\" to end it." if again else ""
    return f"⏰ {r['text']}{late}{tail}"


def send_text(text: str) -> bool:
    try:
        subprocess.run([str(HERE / "bot" / "send.sh")], input=text, text=True, check=True,
                       capture_output=True, timeout=60)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False


def send_due(now: Optional[datetime] = None, sender: Optional[Callable[[str], bool]] = None) -> List[dict]:
    """Send every reminder whose time has come. A failed send stays pending for the next try."""
    now = now or datetime.now(TZ)
    sender = sender or send_text
    rows = load()
    sent = []
    for r in rows:
        if r["status"] != "pending" or _when(r["due"]) > now:
            continue
        if not sender(message(r, now)):
            continue
        r["sent_at"] = _iso(now)
        if r["repeat"]:
            r["due"] = _iso(next_repeat(_when(r["due"]), r["repeat"], now))
        else:
            r["status"] = "sent"
        sent.append(dict(r))
    if sent:
        save(rows)
    return sent


def _find(rows: List[dict], rid: str) -> dict:
    for r in rows:
        if r["id"] == rid:
            return r
    raise KeyError(rid)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--at", required=True)
    a.add_argument("--repeat", default="", choices=sorted(REPEATS))
    a.add_argument("--text-file", help="read the reminder's text from this file (UTF-8)")
    a.add_argument("text", nargs="*")
    sub.add_parser("list")
    c = sub.add_parser("cancel")
    c.add_argument("id")
    s = sub.add_parser("snooze")
    s.add_argument("id")
    s.add_argument("--minutes", type=int, default=30)
    sub.add_parser("due")
    sub.add_parser("send")
    args = p.parse_args(argv)
    now = datetime.now(TZ)

    if args.cmd == "add":
        text = Path(args.text_file).read_text(encoding="utf-8") if args.text_file else " ".join(args.text)
        if not text.strip():
            print("a reminder needs some text (words, or --text-file)")
            return 1
        at = parse_at(args.at, now)
        if at <= now - timedelta(minutes=1):
            print(f"{label(at)} has passed; give a time from now on")
            return 1
        r = add(text, at, args.repeat, now)
        rep = f", repeats {r['repeat']}" if r["repeat"] else ""
        print(f"Reminder {r['id']} set for {label(at)}{rep}: {r['text']}")
    elif args.cmd == "list":
        rows = pending()
        for r in rows:
            rep = f" ({r['repeat']})" if r["repeat"] else ""
            print(f"{r['id']}  {label(_when(r['due']))}{rep}  {r['text']}")
        if not rows:
            print("no reminders pending")
    elif args.cmd in ("cancel", "snooze"):
        rows = load()
        try:
            r = _find(rows, args.id)
        except KeyError:
            print(f"no reminder {args.id}")
            return 1
        if args.cmd == "cancel":
            r["status"] = "cancelled"
            print(f"Cancelled {r['id']}: {r['text']}")
        else:
            at = now + timedelta(minutes=args.minutes)
            if r["repeat"] and r["status"] == "pending":
                # a repeating one keeps its schedule; the snooze is a one-off copy
                save(rows)
                r = add(r["text"], at, "", now)
                print(f"Snoozed: again at {label(at)} ({r['id']})")
                return 0
            r["due"], r["status"] = _iso(at), "pending"
            print(f"Snoozed {r['id']}: again at {label(at)}")
        save(rows)
    elif args.cmd == "due":
        print(due_in(now))
    elif args.cmd == "send":
        sent = send_due(now)
        print(f"sent {len(sent)} reminder(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
