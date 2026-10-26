#!/usr/bin/env python3
"""The morning brief: today's calendar at 08:00 your time, from the secretary bot.

  brief.py             print today's brief (reads the calendar through the Worker)
  brief.py --send      send it to the owner once a day (secretary/bot/send.sh), then remember the day
  brief.py --due       seconds until the next brief is due: 0 if today's is due and not sent yet.
                       The bot caps each listener wait at this, so it wakes at 08:00.

The brief lists today's events in time order (declined ones left out; "free" ones
marked), all-day items and public holidays, clashes, open stretches of an hour or
more inside the awake window (targets.json), and tomorrow's first event. Titles and
times only, as the app keeps them: no descriptions, guests or meeting details.
Times are in your timezone (settings.json at the repo root). The day it was sent is
kept outside the repo (~/.secretarybot/brief_sent).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sync  # noqa: E402
import settings  # noqa: E402  (bots/settings.py, on the path through sync)

TZ = settings.tz()
BRIEF_AT = time(8, 0)
BRIEF_UNTIL = time(11, 0)  # a run that starts later skips the day: no "good morning" at noon
MIN_GAP = 60  # minutes: shorter open stretches aren't worth listing


def home() -> Path:
    return Path(os.environ.get("SECRETARYBOT_HOME", Path.home() / ".secretarybot"))


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(TZ)


def _hm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def _mins(t: str) -> int:
    hh, mm = t.split(":")[:2]
    return int(hh) * 60 + int(mm)


def day_items(events: list[dict], d: date) -> tuple[list[dict], list[str], list[str]]:
    """Timed events on day d as {s, e, title, ...} in minutes (clipped to the day),
    plus all-day titles and public holidays."""
    timed, allday, hols = [], [], []
    for ev in events:
        if ev.get("declined"):
            continue
        if ev.get("allDay"):
            if ev["start"] <= d.isoformat() < ev["end"]:
                (hols if ev.get("cal") == "h" else allday).append(ev["title"])
            continue
        s, e = _dt(ev["start"]), _dt(ev["end"])
        lo = datetime.combine(d, time(0), TZ)
        hi = lo + timedelta(days=1)
        if e <= lo or s >= hi:
            continue
        sm = max(0, int((s - lo).total_seconds() // 60))
        em = min(1440, int((e - lo).total_seconds() // 60))
        timed.append({"s": sm, "e": max(em, sm), "title": ev["title"], "loc": ev.get("loc"), "free": bool(ev.get("free")),
                      "from_before": s < lo})
    timed.sort(key=lambda x: (x["s"], x["e"]))
    return timed, allday, hols


def clashes(timed: list[dict]) -> list[tuple[dict, dict]]:
    busy = [x for x in timed if not x["free"]]
    out = []
    for i, a in enumerate(busy):
        for b in busy[i + 1:]:
            if b["s"] < a["e"] and a["s"] < b["e"]:
                out.append((a, b))
    return out


def gaps(timed: list[dict], window: tuple[str, str], after: int = 0) -> list[tuple[int, int]]:
    """Open stretches of MIN_GAP minutes or more in the awake window, from `after` on."""
    lo, hi = max(_mins(window[0]), after), _mins(window[1])
    out, cur = [], lo
    for x in timed:
        if x["free"]:
            continue
        if x["s"] > cur:
            out.append((cur, min(x["s"], hi)))
        cur = max(cur, x["e"])
    if hi > cur:
        out.append((cur, hi))
    return [(a, b) for a, b in out if b - a >= MIN_GAP and a < hi]


def brief(events: list[dict], today: date, window: tuple[str, str] = ("08:00", "22:30")) -> str:
    timed, allday, hols = day_items(events, today)
    lines = [f"Good morning. {today.strftime('%a %-d %b')}"]
    if hols:
        lines.append(f"Public holiday: {', '.join(hols)}")
    if allday:
        lines.append(f"All day: {', '.join(allday)}")
    if not timed:
        lines.append("Nothing in the calendar today.")
    else:
        busy = [x for x in timed if not x["free"]]
        hours = len({m for x in busy for m in range(x["s"], x["e"])}) / 60  # overlaps count once
        lines.append(f"{len(busy)} {'event' if len(busy) == 1 else 'events'}, {hours:.1f}h booked:")
        for x in timed:
            when = f"{'…' if x['from_before'] else _hm(x['s'])}–{_hm(x['e'])}"
            extra = []
            if x["loc"]:
                extra.append(x["loc"])
            if x["free"]:
                extra.append("marked free")
            lines.append(f"• {when} {x['title']}" + (f" ({', '.join(extra)})" if extra else ""))
    for a, b in clashes(timed):
        lines.append(f"Clash: {a['title']} ({_hm(a['s'])}) overlaps {b['title']} ({_hm(b['s'])})")
    g = gaps(timed, window)
    if timed and g:
        lines.append("Open: " + ", ".join(f"{_hm(a)}–{_hm(b)}" for a, b in g))
    nxt, _, _ = day_items(events, today + timedelta(days=1))
    first = next((x for x in nxt if not x["free"]), None)
    if first:
        lines.append(f"Tomorrow starts {_hm(first['s'])}: {first['title']}")
    return "\n".join(lines)


def sent_day() -> str:
    try:
        return (home() / "brief_sent").read_text().strip()
    except OSError:
        return ""


def due_in(now: datetime) -> int:
    """Seconds until the next brief: 0 when today's is due and not sent yet."""
    now = now.astimezone(TZ)
    at = datetime.combine(now.date(), BRIEF_AT, TZ)
    if now >= at:
        if sent_day() != now.date().isoformat() and now.time() < BRIEF_UNTIL:
            return 0
        at += timedelta(days=1)
    return int((at - now).total_seconds())


def window() -> tuple[str, str]:
    try:
        w = json.loads((HERE / "targets.json").read_text()).get("awake_window")
        return (w[0], w[1]) if w else ("08:00", "22:30")
    except (OSError, ValueError, IndexError):
        return ("08:00", "22:30")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--send", action="store_true")
    p.add_argument("--due", action="store_true")
    a = p.parse_args(argv)
    now = datetime.now(TZ)
    if a.due:
        print(due_in(now))
        return 0
    cfg, tok = sync.config(), sync.token()
    if not cfg:
        print("secretary app not configured; no brief")
        return 1
    ev = sync.post(cfg, tok, "/api/events", {"op": "events", "ts": datetime.now(timezone.utc).isoformat()})
    text = brief(((ev.get("events") or {}).get("items")) or [], now.date(), window())
    if ev.get("error"):
        text += f"\n(Calendar may be out of date: {ev['error']})"
    if not a.send:
        print(text)
        return 0
    if due_in(now):
        print("no brief due now (already sent today, or outside 08:00-11:00)")
        return 0
    subprocess.run([str(HERE / "bot" / "send.sh")], input=text, text=True, check=True)
    home().mkdir(parents=True, exist_ok=True)
    (home() / "brief_sent").write_text(now.date().isoformat())
    print("morning brief sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
