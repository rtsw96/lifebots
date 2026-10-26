#!/usr/bin/env python3
"""Sync the health app (Cloudflare Worker + KV) with the repo.

The repo stays the record. The app shows a snapshot the bot session pushes
after each commit, and workouts or weigh-ins entered in the app wait in the
Worker's queue until the bot session writes them into the logs.

  app_sync.py push          send the snapshot; then ack queued items that are in the logs
  app_sync.py queue         print the queued items (JSON lines)
  app_sync.py apply         write queued workouts and weigh-ins into the logs (dedup-safe),
                            print each workout's summary, and copy Apple Health data
                            (Watch workouts, daily steps, sleep, resting heart rate)
                            into health/activity_log.csv and health/daily_metrics.csv.
                            Also meals added, edited or deleted in the app, checklist
                            steps and daily ticks (plan.json, habit_log.csv), water
                            taps (water_log.csv) and Oura daily summaries
                            (oura_daily.csv). Commit, then run `push`.
  app_sync.py ingest-key --send   send you the Health Auto Export setup (URL and
                            key) through the health bot; the key is never printed here
  app_sync.py --dry-run     build the snapshot and print its size (no config or token needed)

Requests are signed with HMAC_SHA256(key = HMAC_SHA256(key="HealthSync",
msg=bot token), msg = body), so the health bot's token is the only secret.
Not configured (no health/app/config.json, or no token): one line, exit 0.

The snapshot holds: targets and training plan, daily food totals (120 days),
every meal of those 120 days, every logged set and run, body weight, Apple Watch
workouts and daily Apple metrics, the checklist (plan.json) and its ticks, and
water (daily totals, today's drinks). Nothing else from health/ (no reports, no
lab results, no scans).
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
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import foodlog as fl  # noqa: E402
import health_settings as hs  # noqa: E402
import workoutlog as wl  # noqa: E402

CONFIG = HEALTH / "app" / "config.json"
FOOD_DAYS = 120
MEAL_DAYS = 120   # the Food tab's history
PLAN = HEALTH / "plan.json"
HABITS = HEALTH / "habit_log.csv"
HABIT_FIELDS = ["date", "habit", "logged_at"]
MEAL_FIELDS = {"desc": "description", "kcal": "kcal", "protein_g": "protein_g", "carbs_g": "carbs_g", "fat_g": "fat_g",
               "sat_fat_g": "sat_fat_g", "fibre_g": "fibre_g", "veg": "veg_servings", "fruit": "fruit_servings"}
ACTIVITY = HEALTH / "activity_log.csv"
DAILY = HEALTH / "daily_metrics.csv"
ACT_FIELDS = ["id", "date", "start", "end", "name", "min", "kcal", "km", "avg_hr", "max_hr"]
DAY_FIELDS = ["date", "steps", "active_kcal", "exercise_min", "walk_km", "resting_hr", "hrv_ms",
              "sleep_h", "deep_h", "rem_h", "bed", "wake", "weight_kg"]
OURA = HEALTH / "oura_daily.csv"
OURA_FIELDS = ["date", "sleep_score", "readiness", "sleep_h", "deep_h", "rem_h", "awake_h", "efficiency", "bed", "wake",
               "hrv", "rhr", "resp", "temp_dev", "spo2", "steps", "active_kcal"]
NUM = ["kcal", "protein_g", "carbs_g", "fat_g", "sat_fat_g", "fibre_g", "veg_servings", "fruit_servings"]


def token() -> str:
    return os.environ.get("FOOD_LOG_BOT_TOKEN") or os.environ.get("FOOD_BOT_TOKEN") or ""


def config() -> dict | None:
    p = Path(os.environ.get("HEALTH_APP_CONFIG") or CONFIG)
    if not p.exists():
        return None
    cfg = json.loads(p.read_text())
    return cfg if cfg.get("url") else None


def sign(tok: str, body: bytes) -> str:
    key = hmac.new(b"HealthSync", tok.encode(), hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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


# ------------------------------------------------------------------ snapshot

def f(v):
    if v in (None, ""):
        return None
    x = float(v)
    return int(x) if x == int(x) else round(x, 2)


def food_view(today: date) -> dict:
    p = Path(os.environ.get("FOODLOG_CSV", HEALTH / "food_log.csv"))
    rows = []
    if p.exists():
        with p.open(newline="") as fh:
            rows = list(csv.DictReader(fh))
    days = defaultdict(lambda: {k: 0.0 for k in NUM} | {"meals": 0})
    meals = []
    first = today - timedelta(days=FOOD_DAYS - 1)
    for r in rows:
        d = date.fromisoformat(r["meal_date"])
        if d < first or d > today:
            continue
        t = days[r["meal_date"]]
        for k in NUM:
            t[k] += float(r[k] or 0)
        t["meals"] += 1
        if d > today - timedelta(days=MEAL_DAYS):
            meals.append({"id": r["entry_id"], "date": r["meal_date"], "time": r["meal_time"], "meal": r["meal"],
                          "desc": r["description"][:160], "kcal": f(r["kcal"]), "protein_g": f(r["protein_g"]),
                          "carbs_g": f(r["carbs_g"]), "fat_g": f(r["fat_g"]), "sat_fat_g": f(r["sat_fat_g"]),
                          "fibre_g": f(r["fibre_g"]), "veg": f(r["veg_servings"]), "fruit": f(r["fruit_servings"]),
                          "confidence": r["confidence"]})
    return {"days": [{"date": d, **{k: round(v, 1) for k, v in t.items()}} for d, t in sorted(days.items())],
            "meals": meals}


def sets_view() -> list[dict]:
    out = []
    for r in wl.load(wl.log_path()):
        s = {"wid": r["workout_id"], "date": r["date"], "time": r["time"], "block": r["block"],
             "ex": r["exercise_id"]}
        for k, src in (("kg", "weight_kg"), ("reps", "reps"), ("sec", "seconds"), ("km", "distance_km")):
            v = f(r[src])
            if v is not None:
                s[k] = v
        if r["notes"].startswith("partial"):
            s["partial"] = True
        out.append(s)
    return out


def body_view() -> list[dict]:
    return [{"date": r["date"], "kg": f(r["weight_kg"]), "waist": f(r["waist_cm"])}
            for r in wl.load(wl.body_path())]


def activity_path() -> Path:
    return Path(os.environ.get("ACTIVITY_CSV", ACTIVITY))


def daily_path() -> Path:
    return Path(os.environ.get("DAILY_CSV", DAILY))


def apple_view(today: date) -> dict:
    first = (today - timedelta(days=FOOD_DAYS - 1)).isoformat()
    acts = [{k: (f(r[k]) if k in ("min", "kcal", "km", "avg_hr", "max_hr") else r[k]) for k in ACT_FIELDS}
            for r in wl.load(activity_path())]
    days = {}
    for r in wl.load(daily_path()):
        if r["date"] >= first:
            days[r["date"]] = {k: (r[k] if k in ("bed", "wake") else f(r[k])) for k in DAY_FIELDS[1:] if r[k] != ""}
    return {"workouts": {a["id"]: a for a in acts}, "days": days}


def plan_path() -> Path:
    return Path(os.environ.get("PLAN_JSON", PLAN))


def habits_path() -> Path:
    return Path(os.environ.get("HABIT_CSV", HABITS))


def plan_view(today: date) -> dict | None:
    """The checklist you filled in (plan.json): one-off steps, daily items and the last
    14 days' ticks. No lab values or doses live in plan.json, by design."""
    if not plan_path().exists():
        return None
    plan = json.loads(plan_path().read_text())
    if not (plan.get("tasks") or plan.get("habits")):
        return None   # nothing filled in yet: the app leaves the card out
    first = (today - timedelta(days=13)).isoformat()
    log = [{"date": r["date"], "habit": r["habit"]} for r in wl.load(habits_path()) if r["date"] >= first]
    return {"tasks": plan.get("tasks", []), "habits": plan.get("habits", []), "log": log}


def oura_path() -> Path:
    return Path(os.environ.get("OURA_CSV", OURA))


def water_view(today: date) -> dict:
    """Daily water totals (60 days), today's drinks, and the goal and pace the app
    scores the pet with (waterlog.py)."""
    import waterlog as water
    rows = water.load()
    first = (today - timedelta(days=60)).isoformat()
    days: dict[str, int] = {}
    for r in rows:
        if r["date"] >= first:
            days[r["date"]] = days.get(r["date"], 0) + int(float(r["ml"]))
    return {"goal_ml": water.GOAL_ML, "start_min": water.DAY_START, "end_min": water.DAY_END, "slack_ml": water.SLACK_ML,
            "days": [{"date": d, "ml": days[d]} for d in sorted(days)],
            "today": [{"id": r["id"], "time": r["time"], "ml": int(float(r["ml"]))} for r in rows if r["date"] == today.isoformat()]}


def weekly_view(today: date) -> dict | None:
    """The week's targets and the pet's numbers (weekly.py). Never stops a push."""
    try:
        import weekly
        return weekly.view(today)
    except Exception as e:  # noqa: BLE001
        print(f"weekly view skipped: {e}", file=sys.stderr)
        return None


def snapshot(today: date | None = None) -> dict:
    today = today or wl.now().date()
    targets = dict(hs.targets())
    profile = {k: v for k, v in wl.PROFILE.items() if not k.startswith("_")}
    return {"generated_at": now_ts(), "today": today.isoformat(), "tz": hs.tz_name(), "targets": targets, "profile": profile,
            "food": food_view(today), "sets": sets_view(), "body": body_view(), "apple": apple_view(today),
            "plan": plan_view(today), "suggest": json.loads((HERE / "suggestions.json").read_text()).get("items", []),
            "water": water_view(today), "weekly": weekly_view(today), "workout_prefs": wl.prefs(wl.load(wl.edits_path()), today)}


# ------------------------------------------------------------------ queue

def ref_for(item: dict) -> str:
    return f"app:{item['id']}"


def applied_path() -> Path:
    return Path(os.environ.get("FOODBOT_HOME", Path.home() / ".foodbot")) / "app_applied.json"


def applied() -> set[str]:
    """Refs of app items handled in this container: edits, deletes, checklist ticks
    and daily ticks leave no ref in the logs themselves."""
    p = applied_path()
    return set(json.loads(p.read_text())) if p.exists() else set()


def remember_applied(ref: str) -> None:
    p = applied_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(sorted(applied() | {ref})))


def logged_refs() -> set[str]:
    refs = {r["ref"] for r in wl.load(wl.log_path()) if r["ref"]}
    refs |= {r["notes"] for r in wl.load(wl.body_path()) if r["notes"].startswith("app:")}
    refs |= {n for r in fl.load() for n in r["notes"].split() if n.startswith("app:")}
    import waterlog as water
    refs |= {r["ref"] for r in water.load() if r["ref"]}
    return refs | applied()


def meal_number(v) -> str:
    x = float(v or 0)
    if not (0 <= x <= 10000):
        raise ValueError("out of range")
    return f"{x:g}"


def apply_meal(it: dict, ref: str) -> str:
    """meal_add / meal_edit / meal_delete from the app, through foodlog's own storage."""
    d = it.get("data") or {}
    rows = fl.load()
    kind = it["kind"]
    if kind == "meal_add":
        when = datetime.fromisoformat(f"{d['date']}T{d['time']}")
        r = {"entry_id": str(max((int(x["entry_id"]) for x in rows), default=0) + 1),
             "logged_at": datetime.now(fl.tz()).isoformat(timespec="seconds"),
             "meal_date": d["date"], "meal_time": d["time"], "meal": d.get("meal") if d.get("meal") in fl.MEALS else fl.guess_meal(when),
             "description": str(d.get("desc", "")).replace("\n", " ").strip()[:300],
             "confidence": "medium", "source": "manual", "tg_update_id": "", "notes": ref}
        for src, col in MEAL_FIELDS.items():
            if col != "description":
                r[col] = meal_number(d.get(src))
        rows.append(r)
        fl.save(rows)
        return "Logged from the app:\n" + fl.meal_line(r) + "\n\n" + fl.day_report(rows, r["meal_date"])
    target = next((r for r in rows if r["entry_id"] == str(d.get("id"))), None)
    if target is None:
        return f"App asked to change entry {d.get('id')}, which isn't in the log (already deleted?)."
    if kind == "meal_delete":
        rows = [r for r in rows if r is not target]
        fl.save(rows)
        return f"Deleted entry {target['entry_id']} ({target['description'][:60]}) from the app.\n\n" + fl.day_report(rows, target["meal_date"])
    for src, col in MEAL_FIELDS.items():
        if src in d and d[src] is not None:
            target[col] = str(d[src]).replace("\n", " ").strip()[:300] if col == "description" else meal_number(d[src])
    target["notes"] = (target["notes"] + " edited-in-app").strip()
    fl.save(rows)
    return "Edited in the app:\n" + fl.meal_line(target) + "\n\n" + fl.day_report(rows, target["meal_date"])


def apply_plan(it: dict) -> str:
    d = it.get("data") or {}
    plan = json.loads(plan_path().read_text())
    if it["kind"] == "plan_task":
        task = next((t for t in plan["tasks"] if t["id"] == d.get("id")), None)
        if not task:
            return ""
        task["done"] = (d.get("date") or wl.now().date().isoformat()) if d.get("done") else None
        plan_path().write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
        return f"Checklist: {'done' if task['done'] else 'reopened'}: {task['title']}"
    # habit tick: one row per date and habit
    habits = {h["id"] for h in plan.get("habits", [])}
    if d.get("habit") not in habits:
        return ""
    rows = [r for r in wl.load(habits_path()) if not (r["date"] == d["date"] and r["habit"] == d["habit"])]
    if d.get("done"):
        rows.append({"date": d["date"], "habit": d["habit"], "logged_at": wl.now().isoformat(timespec="seconds")})
    rows.sort(key=lambda r: (r["date"], r["habit"]))
    wl.save(habits_path(), rows, HABIT_FIELDS)
    return "tick"


def apply(items: list[dict]) -> list[str]:
    """Write queued items into the logs. Returns printable summaries."""
    out = []
    ticks = 0
    done = logged_refs()
    for it in items:
        ref = ref_for(it)
        if ref in done:
            continue
        d = it.get("data") or {}
        if it.get("kind") == "workout":
            w = {"date": d["date"], "time": d["time"], "source": "app", "ref": ref, "blocks": [
                {"block": b.get("block", ""), "exercises": [
                    {"exercise": e["ex"], "sets": [
                        {k: s[k] for k in ("reps", "weight_kg", "seconds", "at", "seq", "gap_s", "plan_s") if s.get(k) is not None}
                        for s in e["sets"]], "notes": e.get("notes", ""), "rir": e.get("rir")}
                    for e in b["items"] if e["sets"]]}
                for b in d["blocks"]]}
            w["blocks"] = [b for b in w["blocks"] if b["exercises"]]
            if not w["blocks"]:
                out.append(f"Skipped an empty workout from the app ({d.get('date')}).")
                continue
            rows = wl.load(wl.log_path())
            new = wl.import_workout(rows, w)
            wl.save(wl.log_path(), rows, wl.FIELDS)
            if new:
                out.append(wl.summary(rows, new[0]["workout_id"]))
            if d.get("edits"):
                erows = wl.load(wl.edits_path())
                if wl.log_edits(erows, w, d["edits"]):
                    wl.save(wl.edits_path(), erows, wl.EDIT_FIELDS)
        elif it.get("kind") in ("meal_add", "meal_edit", "meal_delete"):
            out.append(apply_meal(it, ref))
            remember_applied(ref)
        elif it.get("kind") in ("water", "water_delete"):
            line = apply_water(it, ref)
            remember_applied(ref)
            if line:
                out.append(line)
        elif it.get("kind") in ("plan_task", "habit"):
            line = apply_plan(it)
            remember_applied(ref)
            if line == "tick":
                ticks += 1
            elif line:
                out.append(line)
        elif it.get("kind") == "body":
            rows = [r for r in wl.load(wl.body_path()) if r["date"] != d["date"]]
            rows.append({"date": d["date"], "time": d.get("time", ""), "weight_kg": d.get("kg") or "",
                         "waist_cm": d.get("waist") or "", "source": "app", "notes": ref})
            rows.sort(key=lambda r: r["date"])
            wl.save(wl.body_path(), rows, wl.BODY_FIELDS)
            out.append(f"Weigh-in {d['date']}: " + ", ".join(
                x for x in [f"{d['kg']} kg" if d.get("kg") else "", f"waist {d['waist']} cm" if d.get("waist") else ""] if x)
                + "\n" + wl.body_trend(wl.load(wl.body_path()), date.fromisoformat(d["date"])))
    if ticks:
        out.append(f"Saved {ticks} checklist tick(s).")
    return out


def apply_apple(apple: dict) -> str:
    """Upsert Apple summaries into the CSVs; a weigh-in from a smart scale goes to
    body_log only on days with no manual reading. Returns one line, or ''."""
    acts = {r["id"]: r for r in wl.load(activity_path())}
    new_w = 0
    for w in (apple.get("workouts") or {}).values():
        row = {k: ("" if w.get(k) is None else w.get(k)) for k in ACT_FIELDS}
        if w["id"] not in acts:
            new_w += 1
        acts[w["id"]] = {k: str(v) for k, v in row.items()}
    days = {r["date"]: r for r in wl.load(daily_path())}
    changed = 0
    for d, v in (apple.get("days") or {}).items():
        row = {"date": d, **{k: ("" if v.get(k) is None else str(v.get(k))) for k in DAY_FIELDS[1:]}}
        old = days.get(d)
        merged = {k: (row[k] if row[k] != "" else (old or {}).get(k, "")) for k in DAY_FIELDS}
        if merged != old:
            changed += 1
        days[d] = merged
    if new_w or changed:
        wl.save(activity_path(), sorted(acts.values(), key=lambda r: (r["date"], r["start"])), ACT_FIELDS)
        wl.save(daily_path(), [days[d] for d in sorted(days)], DAY_FIELDS)
    body = {r["date"]: r for r in wl.load(wl.body_path())}
    scale = 0
    for d, v in (apple.get("days") or {}).items():
        if (v.get("weight_kg") and (d not in body or body[d]["source"] == "apple")
                and (d not in body or body[d]["weight_kg"] != str(v["weight_kg"]))):
            body[d] = {"date": d, "time": "", "weight_kg": str(v["weight_kg"]), "waist_cm": (body.get(d) or {}).get("waist_cm", ""),
                       "source": "apple", "notes": ""}
            scale += 1
    if scale:
        wl.save(wl.body_path(), [body[d] for d in sorted(body)], wl.BODY_FIELDS)
    # Keep the training log in step: Watch runs and rides it doesn't have yet go in.
    log = wl.load(wl.log_path())
    trained = wl.from_apple(log, list(acts.values()))
    # Heart rate per exercise: the Worker matched the Watch's minutes to the app's set times.
    hr_lines = []
    for w in (apple.get("workouts") or {}).values():
        if w.get("app") and w.get("hr_ex") and wl.set_heart_rate(log, w["app"], w["hr_ex"]):
            sets = [r for r in log if r["workout_id"] == w["app"]]
            hr_lines.append(f"Workout {sets[0]['date']} {sets[0]['time']}: " + wl.hr_line(sets))
    if trained or hr_lines:
        wl.save(wl.log_path(), log, wl.FIELDS)
    if not (new_w or changed or scale or trained or hr_lines):
        return ""
    head = (f"Apple Health: {new_w} new workout(s), {changed} day(s) updated" + (f", {scale} scale reading(s)" if scale else "")
            + (f", {len(trained)} run(s) or ride(s) added to the training log" if trained else ""))
    return "\n".join([head, *hr_lines])


def apply_water(it: dict, ref: str) -> str:
    """A drink tapped in the app (its row id is the queue item's id, so the app can undo
    it before or after the bot logs it), or an undo. Returns the day's line."""
    import waterlog as water
    d = it.get("data") or {}
    rows = water.load()
    if it["kind"] == "water":
        if not water.add(rows, int(d["ml"]), d["date"], d["time"], "app", ref=ref, row_id=it["id"]):
            return ""
        day = d["date"]
    else:
        gone = water.remove(rows, str(d.get("id", "")))
        if not gone:
            return ""
        day = gone["date"]
    water.save(rows)
    now = wl.now()
    when = now if day == now.date().isoformat() else datetime.combine(date.fromisoformat(day), datetime.max.time(), now.tzinfo)
    return water.today_line(rows, when).replace("Water today", f"Water {day}" if day != now.date().isoformat() else "Water today")


def apply_oura(oura: dict) -> str:
    """Upsert Oura daily summaries into oura_daily.csv. Returns one line, or ''."""
    days = {r["date"]: r for r in wl.load(oura_path())}
    changed = 0
    for d, v in (oura.get("days") or {}).items():
        row = {"date": d, **{k: ("" if v.get(k) is None else str(v.get(k))) for k in OURA_FIELDS[1:]}}
        if row != days.get(d):
            changed += 1
        days[d] = row
    if changed:
        wl.save(oura_path(), [days[d] for d in sorted(days)], OURA_FIELDS)
    return f"Oura: {changed} day(s) updated" if changed else ""


def ingest_key(tok: str) -> str:
    return hmac.new(b"HealthIngest", tok.encode(), hashlib.sha256).hexdigest()[:40]


def send_setup(cfg: dict, tok: str) -> None:
    """Message the owner the Health Auto Export settings, key included. Never printed."""
    chat = os.environ.get("FOOD_CHAT_ID") or os.environ.get("OWNER_TELEGRAM_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    if not chat:
        raise SystemExit("OWNER_TELEGRAM_ID not set")
    url = f"{cfg['url'].rstrip('/')}/api/apple"
    key = ingest_key(tok)
    text = (
        "Apple Health → health app: setup\n"
        "Health Auto Export needs Premium for automations. Each automation sends ONE data type, so make two: one for health metrics, one for workouts.\n\n"
        "AUTOMATION 1: health metrics\n"
        "1. Sidebar → Automations → New Automation → Automation Type: REST API\n"
        "2. Name: Health app – metrics\n"
        f"3. URL: {url}\n"
        "4. HTTP Headers → Add Headers: left field X-Health-Key, right field the key below\n"
        "5. Data Type: Health Metrics. Select Health Metrics: Step Count, Active Energy, Apple Exercise Time, "
        "Walking + Running Distance, Resting Heart Rate, Heart Rate Variability, Sleep Analysis, Weight (Body Mass)\n"
        "6. Export Format: JSON · Export Version: Version 2\n"
        "7. Date Range: Previous 7 Days · Summarize Data: ON · Time Grouping: Day · Batch Requests: OFF\n"
        "8. Sync Cadence: every 1 hour (or the shortest offered). Save.\n\n"
        "AUTOMATION 2: workouts\n"
        "Same steps 1-4 (name it Health app – workouts, same URL and header), then:\n"
        "5. Data Type: Workouts · Include Route Data: OFF · Include Workout Metrics: OFF\n"
        "6. Export Format: JSON · Export Version: Version 2\n"
        "7. Date Range: Previous 7 Days · Batch Requests: OFF\n"
        "8. Sync Cadence: every 1 hour. Save.\n\n"
        "TEST: open each automation → Manual Export → pick the last 7 days → Export. Then open the app: "
        "Today → Body shows your data, or says why the last attempt was refused. "
        "The automation's 'View Activity Logs' shows the HTTP status (200 = arrived, 401 = header or key wrong).\n\n"
        "Exports only run while the phone is unlocked and Background App Refresh is on; the app's Home Screen widget helps.\n\n"
        "Key (copy exactly, no spaces):"
    )
    # The key goes in its own message so it can be long-pressed and copied on its own.
    for msg in (text, key):
        body = urllib.parse.urlencode({"chat_id": chat, "text": msg, "disable_web_page_preview": "true"}).encode()
        with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage", data=body, timeout=30) as r:
            if not json.loads(r.read()).get("ok"):
                raise SystemExit("Telegram refused the message")
    print("sent the Health Auto Export setup to your chat with the health bot (steps, then the key on its own)")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("cmd", nargs="?", default="push", choices=["push", "queue", "apply", "ingest-key"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--send", action="store_true")
    a = p.parse_args(argv)
    if a.dry_run:
        s = json.dumps(snapshot(), separators=(",", ":")).encode()
        print(f"snapshot {len(s):,} bytes")
        return 0
    cfg, tok = config(), token()
    if not cfg or not tok:
        print("health app not configured (health/app/config.json or FOOD_LOG_BOT_TOKEN missing); skipped")
        return 0
    if a.cmd == "push":
        res = post(cfg, tok, "/api/sync", {"op": "snapshot", "ts": now_ts(), "snap": snapshot()}, 60)
        print(f"health app updated ({res.get('bytes', 0):,} bytes)")
        items = post(cfg, tok, "/api/queue", {"op": "list", "ts": now_ts()}).get("items", [])
        done = logged_refs()
        ids = [it["id"] for it in items if ref_for(it) in done]
        if ids:
            post(cfg, tok, "/api/queue/ack", {"op": "ack", "ts": now_ts(), "ids": ids})
            print(f"cleared {len(ids)} app item(s) now in the logs")
        return 0
    if a.cmd == "ingest-key":
        if not a.send:
            print("Use --send: the key goes to the owner's Telegram, never to this terminal.")
            return 1
        send_setup(cfg, tok)
        return 0
    items = post(cfg, tok, "/api/queue", {"op": "list", "ts": now_ts()}).get("items", [])
    if a.cmd == "queue":
        for it in items:
            print(json.dumps(it))
        return 0
    out = apply(items)
    line = apply_apple(post(cfg, tok, "/api/apple/list", {"op": "apple", "ts": now_ts()}).get("apple") or {})
    if line:
        out.append(line)
    line = apply_oura(post(cfg, tok, "/api/oura/list", {"op": "oura", "ts": now_ts()}).get("oura") or {})
    if line:
        out.append(line)
    for s in out or ["Nothing new from the app."]:
        print(s)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
