#!/usr/bin/env python3
"""Sync the Secretary app (Cloudflare Worker + KV) with the repo.

The calendar itself never passes through the repo: the Worker reads Google
Calendar directly. What the repo adds is what the calendar can't know:

  - sleep per night (bed, wake, hours): Oura first, Apple Health otherwise
    (health/oura_daily.csv, health/daily_metrics.csv);
  - workouts with their times (health/activity_log.csv, Apple Watch; health/workout_log.csv);
  - the category rules (secretary/categories.json) and targets (secretary/targets.json);
  - the expense claims (secretary/data/claims.csv), line items only;
  - your timezone, home currency and public-holiday calendar (settings.json at the repo root).

Sleep and workouts are optional: they come from the health bot's logs, and when the
health bot isn't installed (no health/ files) the app simply shows no sleep or
workouts. Daily summaries only: no heart rate, no food, no lab results.

  sync.py push        send all of the above to the app
  sync.py events      print the app's cached calendar as JSON (for a bot session's analysis)
  sync.py slots|add|edit|remove --args-json FILE
                      a calendar call through the Worker, its fields from a JSON file (titles and
                      details from a message go in the file, never on the command line); prints the reply
  sync.py --dry-run   build the payload and print its size (no config or token needed)

Requests are signed with HMAC_SHA256(key = HMAC_SHA256(key="SecretarySync",
msg=bot token), msg = body), so the secretary bot's token is the only secret.
Not configured (no secretary/app/config.json, or no SECRETARY_BOT_TOKEN): one line, exit 0.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.append(str(ROOT / "bots"))
import settings  # noqa: E402  (settings.json: timezone, home currency, holiday calendar)

HEALTH = ROOT / "health"
CONFIG = HERE / "app" / "config.json"
DAYS = 120  # what the Trends tab can reach back to


def token() -> str:
    return os.environ.get("SECRETARY_BOT_TOKEN", "")


def config() -> dict | None:
    if not CONFIG.exists():
        return None
    cfg = json.loads(CONFIG.read_text())
    return cfg if cfg.get("url") else None


def sign(tok: str, body: bytes) -> str:
    key = hmac.new(b"SecretarySync", tok.encode(), hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def post(cfg: dict, tok: str, path: str, obj: dict, max_time: int = 30) -> dict:
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
    out = subprocess.run(
        ["curl", "-sS", "--max-time", str(max_time), "-X", "POST", "-H", "Content-Type: application/json",
         "-H", f"X-Sync-Signature: {sign(tok, body)}", "--data-binary", "@-", cfg["url"].rstrip("/") + path],
        input=body, capture_output=True, check=True).stdout
    res = json.loads(out or b"{}")
    if not res.get("ok"):
        raise RuntimeError(f"{path}: {res.get('error', 'failed')}")
    return res


def _rows(p: Path) -> list[dict]:
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _num(v):
    try:
        return round(float(v), 2) if v not in (None, "") else None
    except ValueError:
        return None


def _hhmm(v):
    v = (v or "").strip()
    return v[:5] if len(v) >= 4 and ":" in v else None


def _logged_only(log: list[dict], watch: list[dict], cut: str) -> list[dict]:
    """Training-log sessions with no Watch workout (a training app, or the health app without the Watch
    on): same day, starting within 45 minutes, as the health app pairs them. Cardio
    keeps its own time; a strength session counts as an hour."""
    sessions: dict[str, dict] = {}
    for r in log:
        if r.get("date", "") < cut or not _hhmm(r.get("time")):
            continue
        s = sessions.setdefault(r["workout_id"], {"date": r["date"], "start": _hhmm(r["time"]), "sec": 0, "cardio": True})
        if r.get("exercise_id") in CARDIO:
            s["sec"] += _num(r.get("seconds")) or 0
        else:
            s["cardio"] = False

    def mins(t: str) -> int:
        return int(t[:2]) * 60 + int(t[3:5])
    out = []
    for s in sessions.values():
        if any(w["date"] == s["date"] and abs(mins(w["start"]) - mins(s["start"])) <= 45 for w in watch):
            continue
        m = round(s["sec"] / 60) if s["cardio"] and s["sec"] else 60
        out.append({"date": s["date"], "start": s["start"], "end": None, "name": "Run or ride (logged)" if s["cardio"] else "Strength (logged)", "min": m})
    return out


CARDIO = {"run", "treadmill", "bike", "rower"}


def health(today: date, health_dir: Path = HEALTH) -> dict:
    """Sleep per night (the day you wake up) and timed workouts, last DAYS days."""
    cut = (today - timedelta(days=DAYS)).isoformat()
    days: dict[str, dict] = {}
    # Apple first, then Oura over it: the ring is the better sleep source when both exist.
    for src, path in (("apple", health_dir / "daily_metrics.csv"), ("oura", health_dir / "oura_daily.csv")):
        for r in _rows(path):
            d, h = r.get("date", ""), _num(r.get("sleep_h"))
            if d < cut or not h:
                continue
            days[d] = {"sleep_h": h, "bed": _hhmm(r.get("bed")), "wake": _hhmm(r.get("wake")), "src": src}
    workouts = []
    for r in _rows(health_dir / "activity_log.csv"):
        if r.get("date", "") < cut or not _hhmm(r.get("start")):
            continue
        workouts.append({"date": r["date"], "start": _hhmm(r["start"]), "end": _hhmm(r.get("end")),
                         "name": (r.get("name") or "Workout")[:40], "min": int(float(r["min"])) if _num(r.get("min")) else None})
    workouts += _logged_only(_rows(health_dir / "workout_log.csv"), workouts, cut)
    for d in days.values():
        for k in [k for k, v in d.items() if v is None]:
            del d[k]
    return {"days": dict(sorted(days.items())), "workouts": sorted(workouts, key=lambda w: (w["date"], w["start"])),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def claims() -> dict:
    """The claims ledger for the app's Claims tab (line items; receipts stay in the app's storage)."""
    import claims as C  # here, not at the top: claims imports this module
    rows = C.load()
    return {"rows": rows, "summary": C.summary(rows), "categories": C.CATEGORIES}


GOOGLE_HOLIDAYS = "#holiday@group.v.calendar.google.com"


def holiday_calendar(value: str | None = None) -> str:
    """settings.json's holiday_calendar as a Google Calendar id: "" (none), a region as
    Google spells it ("singapore", "usa", "uk", "australian", "japanese", ...), or a full id."""
    v = (settings.get("holiday_calendar") if value is None else value) or ""
    v = v.strip()
    if not v:
        return ""
    if "@" in v:
        return v
    return f"en.{v.lower().replace(' ', '_')}{GOOGLE_HOLIDAYS}"


def app_settings() -> dict:
    """What the Worker and the app need to know about the owner: their timezone (for
    days, slots and new events), home currency (claims) and public holidays."""
    return {"timezone": settings.get("timezone") or settings.DEFAULTS["timezone"],
            "currency": settings.home_currency(), "holidays": holiday_calendar()}


def payload(today: date | None = None) -> dict:
    today = today or datetime.now(settings.tz()).date()
    return {"health": health(today), "rules": json.loads((HERE / "categories.json").read_text()),
            "targets": json.loads((HERE / "targets.json").read_text()), "claims": claims(),
            "settings": app_settings()}


CALLS = ("slots", "add", "edit", "remove")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", nargs="?", default="push", choices=["push", "events", *CALLS])
    p.add_argument("--args-json", help="the call's fields, as a JSON object in a file")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    if a.dry_run:
        body = payload()
        h = body["health"]
        print(f"payload {len(json.dumps(body)):,} bytes · {len(h['days'])} nights of sleep · {len(h['workouts'])} workouts · "
              f"{len(body['rules']['rules'])} rules · {len(body['claims']['rows'])} claims")
        return 0
    cfg, tok = config(), token()
    if not cfg or not tok:
        print("secretary app not configured (secretary/app/config.json and SECRETARY_BOT_TOKEN): skipped")
        return 0
    now = datetime.now(timezone.utc).isoformat()
    if a.cmd == "events":
        print(json.dumps(post(cfg, tok, "/api/events", {"op": "events", "ts": now})["events"], ensure_ascii=False))
        return 0
    if a.cmd in CALLS:
        fields = json.loads(Path(a.args_json).read_text(encoding="utf-8")) if a.args_json else {}
        if not isinstance(fields, dict):
            print("--args-json must hold a JSON object", file=sys.stderr)
            return 2
        try:
            res = post(cfg, tok, f"/api/{a.cmd}", {**fields, "op": a.cmd, "ts": now})
        except RuntimeError as e:
            print(json.dumps({"ok": False, "error": str(e).split(": ", 1)[-1]}, ensure_ascii=False))
            return 1
        print(json.dumps(res, ensure_ascii=False))
        return 0
    res = post(cfg, tok, "/api/sync", {"op": "push", "ts": now, **payload()}, max_time=60)
    print(f"secretary app updated ({res.get('stored', 0)} parts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
