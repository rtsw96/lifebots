#!/usr/bin/env python3
"""Weekly health targets, tracked day by day, and the 21:00 debrief.

Each week (Monday to Sunday, local time) gets a set of targets, made the first
time the week is looked at and kept in health/weekly_targets.json (bot data). They
come from the plan in health/settings.json (food targets, training days, sleep, steps,
water on 5 days of the week) and training/profile.json. Where last week fell short of
the plan, the week's target is a step toward it (halfway, rounded) rather than the full
jump, so it stays reachable.

  weekly.py status [--date 2026-10-14]    where each target stands, and what the rest of the week needs
  weekly.py set [--week 2026-10-19]       make (or remake) a week's targets
  weekly.py due                           seconds until tonight's debrief (debrief_at, default 21:00; 0 once due, until midnight)
  weekly.py sent                          remember that tonight's debrief went out
  weekly.py pet [--date ...]              the health app pet's mood, level and wish, in one line

The script does all the counting; the bot adds the coaching (health-bot skill,
"Daily debrief").
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import foodlog as fl  # noqa: E402
import waterlog as water  # noqa: E402
import workoutlog as wl  # noqa: E402
import health_settings as hs  # noqa: E402

DEBRIEF_AT = hs.debrief_at()
PLAN_STEPS = hs.steps_band()[0]
PLAN_SLEEP_H = round(hs.sleep_goal() * 4) / 4   # to the quarter hour
PLAN_WATER_DAYS = 5


def targets_path() -> Path:
    return Path(os.environ.get("WEEKLY_JSON", HEALTH / "weekly_targets.json"))


def daily_path() -> Path:
    return Path(os.environ.get("DAILY_CSV", HEALTH / "daily_metrics.csv"))


def oura_path() -> Path:
    return Path(os.environ.get("OURA_CSV", HEALTH / "oura_daily.csv"))


def bot_home() -> Path:
    return Path(os.environ.get("FOODBOT_HOME", Path.home() / ".foodbot"))


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def days_of(week: date) -> list[str]:
    return [(week + timedelta(days=i)).isoformat() for i in range(7)]


# ------------------------------------------------------------------ measures, one week at a time

def _food(days: list[str]) -> dict[str, dict]:
    rows = fl.load()
    return {d: fl.totals(rows, d) for d in days}


def _sessions(week: date) -> dict[str, list[str]]:
    """Strength and cardio sessions by day, the Watch included (as workoutlog.py week counts them)."""
    start, end = week, week + timedelta(days=6)
    rows = wl.load(wl.log_path())
    acts = wl.load(wl.activity_path())
    wk = [r for r in rows if start <= date.fromisoformat(r["date"]) <= end]
    out: dict[str, list[str]] = {"strength": [], "cardio": []}
    seen = set()
    for r in wk:
        kind = "cardio" if wl.EX.get(r["exercise_id"], {}).get("kind") == "cardio" else "strength"
        if (r["workout_id"], kind) not in seen:
            seen.add((r["workout_id"], kind))
            out[kind].append(r["date"])
    for r in wl.from_apple([dict(x) for x in rows], [a for a in acts if start <= date.fromisoformat(a["date"]) <= end]):
        out["cardio"].append(r["date"])
    out["strength"] += [a["date"] for a in wl.watch_only_strength(rows, acts, start, end)]
    return out


def _daily(days: list[str]) -> tuple[dict[str, float], dict[str, float]]:
    """Steps and sleep by day. Sleep is the night ending that morning; Oura first, the Watch otherwise."""
    steps, sleep = {}, {}
    for r in wl.load(daily_path()):
        if r["date"] in days:
            if wl.num(r.get("steps")):
                steps[r["date"]] = wl.num(r["steps"])
            if wl.num(r.get("sleep_h")):
                sleep[r["date"]] = wl.num(r["sleep_h"])
    for r in wl.load(oura_path()):
        if r["date"] in days and wl.num(r.get("sleep_h")):
            sleep[r["date"]] = wl.num(r["sleep_h"])
    return steps, sleep


def measure(week: date) -> dict:
    days = days_of(week)
    food = _food(days)
    steps, sleep = _daily(days)
    t = fl.targets()
    lo, hi = t["kcal"]
    drinks = water.load()
    return {
        "days": days,
        "food_days": [d for d in days if food[d]["meals"]],
        "strength": _sessions(week)["strength"],
        "cardio": _sessions(week)["cardio"],
        "protein": [d for d in days if food[d]["protein_g"] >= t["protein_g"][0]],
        "kcal": [d for d in days if food[d]["meals"] and lo <= food[d]["kcal"] <= hi + 100],
        "veg": [d for d in days if food[d]["veg_servings"] >= t["veg_servings"][0]],
        "sat_fat": [d for d in days if food[d]["meals"] and food[d]["sat_fat_g"] <= t["sat_fat_g_max"]],
        "water": [d for d in days if water.total(drinks, d) >= water.GOAL_ML],
        "water_logged": any(r["date"] in days for r in drinks),
        "steps": steps,
        "sleep": sleep,
    }


# ------------------------------------------------------------------ targets

def _halfway(last: float | None, plan: float, step: float) -> float:
    if last is None or last >= plan:
        return plan
    return min(plan, math.ceil(round(((last + plan) / 2) / step, 6)) * step)


def make_targets(week: date) -> dict:
    last = measure(week - timedelta(days=7))
    t, prof = fl.targets(), wl.PROFILE
    avg = lambda xs: (sum(xs) / len(xs)) if xs else None  # noqa: E731

    def stepped(key: str, label: str, kind: str, plan: float, last_v: float | None, step: float, unit: str = "") -> dict:
        goal = _halfway(last_v, plan, step)
        shown = (lambda v: f"{v:,.0f}") if key == "steps" else (lambda v: f"{v:g}{unit}")
        why = f"plan {shown(plan)}" + (f"; last week {shown(round(last_v, 1))}, so halfway" if last_v is not None and goal < plan else "")
        return {"key": key, "label": label, "kind": kind, "target": goal, "plan": plan, "why": why}

    out = [
        {"key": "strength", "label": "Strength sessions", "kind": "count", "target": prof["strength_days_per_week"],
         "plan": prof["strength_days_per_week"], "why": "the training plan"},
        {"key": "cardio", "label": "Run, ride or row", "kind": "count", "target": prof.get("cardio_per_week", 1),
         "plan": prof.get("cardio_per_week", 1), "why": "the training plan"},
        stepped("steps", "Steps a day", "avg", PLAN_STEPS, avg(list(last["steps"].values())), 500),
        stepped("sleep", "Sleep a night (h)", "avg", PLAN_SLEEP_H, avg(list(last["sleep"].values())), 0.25, " h"),
        stepped("protein", f"Days with {t['protein_g'][0]} g+ protein", "days", 6, len(last["protein"]), 1, " days"),
        stepped("kcal", f"Days at {t['kcal'][0]:,}-{t['kcal'][1]:,} kcal", "days", 5, len(last["kcal"]), 1, " days"),
        stepped("veg", f"Days with {t['veg_servings'][0]}+ veg servings", "days", 5, len(last["veg"]), 1, " days"),
        stepped("sat_fat", f"Days at {t['sat_fat_g_max']} g sat fat or less", "days", 5, len(last["sat_fat"]), 1, " days"),
        water_target(len(last["water"]) if last["water_logged"] else None),
    ]
    return {"week": week.isoformat(), "set_at": wl.now().isoformat(timespec="minutes"), "targets": out}


def water_target(last_days: int | None) -> dict:
    goal = _halfway(last_days, PLAN_WATER_DAYS, 1)
    why = f"plan {PLAN_WATER_DAYS} days" + (f"; last week {last_days}, so halfway" if last_days is not None and goal < PLAN_WATER_DAYS else "")
    return {"key": "water", "label": f"Days with {water.litres(water.GOAL_ML)}+ water", "kind": "days", "target": goal,
            "plan": PLAN_WATER_DAYS, "why": why}


def load_all() -> dict:
    try:
        return json.loads(targets_path().read_text())
    except (OSError, ValueError):
        return {"weeks": {}}


def targets_for(week: date, create: bool = True) -> dict | None:
    data = load_all()
    wk = data["weeks"].get(week.isoformat())
    if wk is None and create:
        data["weeks"][week.isoformat()] = make_targets(week)
        targets_path().write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    return data["weeks"].get(week.isoformat())


# ------------------------------------------------------------------ status

def _fmt(key: str, v: float) -> str:
    return f"{v:,.0f}" if key == "steps" else f"{v:.1f}" if key == "sleep" else f"{v:g}"


def status(today: date) -> str:
    week = monday(today)
    tg = targets_for(week)
    m = measure(week)
    elapsed = today.weekday() + 1          # days so far, today included
    left = 7 - elapsed                     # days after today
    lines = [f"Week of {week.strftime('%-d %b')}, day {elapsed} of 7 ({left} to go)"]
    behind = []
    for t in tg["targets"]:
        k, goal = t["key"], t["target"]
        if t["kind"] in ("count", "days"):
            done = len(m[k]) if t["kind"] == "count" else len([d for d in m[k] if d <= today.isoformat()])
            need = goal - done
            if need <= 0:
                lines.append(f"✓ {t['label']}: {done} of {goal}")
                continue
            if need > left:
                state = f"out of reach this week ({need} more, {left} days left)"
            else:
                state = f"{need} more in {left} days" if left else f"{need} short"
            pace_ok = done >= math.floor(goal * elapsed / 7)
            lines.append(f"{'·' if pace_ok and need <= left else '!'} {t['label']}: {done} of {goal}, {state}")
            if not pace_ok or need >= left:
                behind.append((need / max(left, 1), t, need))
        else:
            vals = m[k]
            have = [v for d, v in vals.items() if d <= today.isoformat()]
            if not have:
                lines.append(f"· {t['label']}: no data yet (target {_fmt(k, goal)})")
                continue
            avg = sum(have) / len(have)
            if avg >= goal:
                lines.append(f"✓ {t['label']}: {_fmt(k, avg)} average (target {_fmt(k, goal)})")
                continue
            n_total = len(have) + left
            need = (goal * n_total - sum(have)) / left if left else None
            tail = f", needs {_fmt(k, need)} a day from here" if need is not None else ""
            lines.append(f"! {t['label']}: {_fmt(k, avg)} average (target {_fmt(k, goal)}){tail}")
            behind.append(((goal - avg) / goal * 7, t, need))
    if behind:
        behind.sort(key=lambda x: -x[0])
        lines.append("Most behind: " + ", ".join(b[1]["label"] for b in behind[:2]))
    lines.append(f"Food logged on {len([d for d in m['food_days'] if d <= today.isoformat()])} of {elapsed} days")
    now = wl.now()
    lines.append(water.today_line(water.load(), now if now.date() == today else
                                  datetime.combine(today, time(23, 59), now.tzinfo)).replace("Water today", "Water"))
    lines.append(wl.body_trend(wl.load(wl.body_path()), today).strip())
    return "\n".join(lines)


def targets_text(week: date) -> str:
    tg = targets_for(week)
    return "\n".join([f"Targets for the week of {week.strftime('%-d %b')}:"]
                     + [f"• {t['label']}: {_fmt(t['key'], t['target']) if t['kind'] == 'avg' else t['target']} ({t['why']})"
                        for t in tg["targets"]])


# ------------------------------------------------------------------ the pet
# The health app's pet lives on these numbers (app.js draws it). Each target gets a
# pace score from 0 to 1: how far along it is against where the week should be by
# now, with a little slack so a fresh Monday reads as fine. Targets group into three
# needs (food, rest, fitness). Water is a fourth need, scored on today alone: what's
# been drunk against where the day should be by now (waterlog.pace). Water weighs
# half, so the pet's mood is half water and half the average of the other three. Every target hit in a finished week is a star, and
# stars raise the pet's level.

NEEDS = {"food": ["protein", "kcal", "veg", "sat_fat"], "rest": ["sleep"], "fitness": ["strength", "cardio", "steps"]}
TIPS = {
    "strength": "One more strength session would make my day.",
    "cardio": "A run, a ride or a row this week, please!",
    "steps": "Walk me! About {need} steps a day from here.",
    "sleep": "An early night? We need {need} h a night from here.",
    "protein": "Feed me protein: {protein} g today.",
    "kcal": "Let's keep calories in the plan's range today.",
    "veg": "Greens, please: {veg} servings today.",
    "sat_fat": "Easy on the sat fat today: {sat} g or less.",
    "water": "I'm thirsty! About {need} ml to catch up.",
}
WATER_WEIGHT = 0.5
STARS_PER_LEVEL = 6


def _score(t: dict, m: dict, today: date) -> dict:
    """One target: what's done, what's left, and a pace score."""
    k, goal = t["key"], t["target"]
    elapsed = today.weekday() + 1
    left = 7 - elapsed
    out = {"key": k, "label": t["label"], "kind": t["kind"], "target": goal}
    if t["kind"] in ("count", "days"):
        done = len(m[k]) if t["kind"] == "count" else len([d for d in m[k] if d <= today.isoformat()])
        expect = goal * (elapsed - 1) / 7          # where the week should be by last night
        out.update(done=done, need=max(0, goal - done))
        out["pace"] = round(min(1.0, (done + 0.5) / (expect + 0.5)), 2)
        out["state"] = "hit" if done >= goal else "out" if goal - done > left else "pace" if out["pace"] >= 0.75 else "behind"
    else:
        have = [v for d, v in m[k].items() if d <= today.isoformat()]
        if not have:
            out.update(avg=None, pace=None, state="nodata")
            return out
        avg = sum(have) / len(have)
        need = (goal * (len(have) + left) - sum(have)) / left if left else None
        out.update(avg=round(avg, 2), need=round(need, 2) if need is not None and avg < goal else None)
        out["pace"] = round(min(1.0, avg / goal), 2)
        out["state"] = "hit" if avg >= goal else "pace" if out["pace"] >= 0.9 else "behind"
    return out


def week_hits(week: date) -> tuple[int, int]:
    """Targets hit in a finished week, out of how many."""
    tg = targets_for(week, create=False)
    if not tg:
        return 0, 0
    m = measure(week)
    end = week + timedelta(days=6)
    rows = [_score(t, m, end) for t in tg["targets"]]
    return sum(r["state"] == "hit" for r in rows), len(rows)


def food_streak(today: date) -> int:
    """Days in a row with food logged, up to today (or yesterday, if nothing is logged yet today)."""
    rows = fl.load()
    logged = {r["meal_date"] for r in rows}
    d = today if today.isoformat() in logged else today - timedelta(days=1)
    n = 0
    while d.isoformat() in logged:
        n += 1
        d -= timedelta(days=1)
    return n


def mood_of(needs: dict) -> int:
    """Half water, half the average of food, rest and fitness (app.js has the same sum)."""
    rest = [v for k, v in needs.items() if k != "water" and v is not None]
    other = sum(rest) / len(rest) if rest else 0.7
    w = needs.get("water")
    return round((other if w is None else WATER_WEIGHT * w + (1 - WATER_WEIGHT) * other) * 100)


def view(today: date, now: datetime | None = None) -> dict:
    """The week for the health app and its pet. Water is scored as of `now` (default:
    the current time today, the end of the day for another date)."""
    now = now or wl.now()
    mins = now.hour * 60 + now.minute if now.date() == today else 24 * 60
    week = monday(today)
    tg = targets_for(week)
    m = measure(week)
    scores = [_score(t, m, today) for t in tg["targets"]]
    by = {s["key"]: s for s in scores}
    needs = {}
    for name, keys in NEEDS.items():
        vals = [by[k]["pace"] for k in keys if k in by and by[k]["pace"] is not None]
        needs[name] = round(sum(vals) / len(vals), 2) if vals else None
    drunk = water.total(water.load(), today.isoformat())
    needs["water"] = water.pace(drunk, mins)
    mood = mood_of(needs)
    worst = sorted([s for s in scores if s["state"] in ("behind", "pace") and s["pace"] is not None and s["key"] != "water"],
                   key=lambda s: s["pace"])   # water's wish comes from today's pace, below
    tip = None
    behind_ml = water.expected_by(mins) - drunk
    if needs["water"] < 0.75 and behind_ml > 0:
        tip = TIPS["water"].format(need=f"{behind_ml:,}")
    elif worst:
        s = worst[0]
        need = s.get("need")
        t = fl.targets()
        tip = TIPS[s["key"]].format(need=(f"{need:,.0f}" if s["key"] == "steps" else f"{need:.1f}") if isinstance(need, (int, float)) else "",
                                    protein=t["protein_g"][0], veg=f"{t['veg_servings'][0]:g}", sat=f"{t['sat_fat_g_max']:g}")
    history = []
    for w in sorted(load_all()["weeks"]):
        if w < week.isoformat():
            hit, total = week_hits(date.fromisoformat(w))
            history.append({"week": w, "hit": hit, "total": total})
    stars = sum(h["hit"] for h in history)
    return {"week": week.isoformat(), "day": today.weekday() + 1, "targets": scores, "needs": needs, "mood": mood, "tip": tip,
            "history": history, "stars": stars, "level": 1 + stars // STARS_PER_LEVEL, "next_level_at": (stars // STARS_PER_LEVEL + 1) * STARS_PER_LEVEL,
            "hit_this_week": sum(s["state"] == "hit" for s in scores), "streak": food_streak(today),
            "water_weight": WATER_WEIGHT}


def mood_word(mood: int) -> str:
    return "thriving" if mood >= 85 else "happy" if mood >= 65 else "peckish" if mood >= 40 else "under the weather"


# ------------------------------------------------------------------ timing

def sent_day() -> str:
    try:
        return (bot_home() / "debrief_sent").read_text().strip()
    except OSError:
        return ""


def due_in(now: datetime) -> int:
    """Seconds until tonight's 21:00 debrief; 0 from 21:00 to midnight until it is sent."""
    at = datetime.combine(now.date(), DEBRIEF_AT, now.tzinfo)
    if now >= at:
        if sent_day() != now.date().isoformat():
            return 0
        at += timedelta(days=1)
    return int((at - now).total_seconds())


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status")
    s.add_argument("--date")
    s = sub.add_parser("set")
    s.add_argument("--week")
    sub.add_parser("due")
    sub.add_parser("sent")
    s = sub.add_parser("pet")
    s.add_argument("--date")
    a = p.parse_args(argv)
    now = wl.now()
    if a.cmd == "status":
        print(status(date.fromisoformat(a.date) if a.date else now.date()))
    elif a.cmd == "set":
        week = monday(date.fromisoformat(a.week)) if a.week else monday(now.date())
        data = load_all()
        data["weeks"].pop(week.isoformat(), None)
        targets_path().write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        print(targets_text(week))
    elif a.cmd == "due":
        print(due_in(now))
    elif a.cmd == "pet":
        v = view(date.fromisoformat(a.date) if a.date else now.date())
        print(f"Pet: {mood_word(v['mood'])} (mood {v['mood']}/100, level {v['level']}, {v['stars']} stars"
              f"{', food streak ' + str(v['streak']) + ' days' if v['streak'] > 1 else ''})" + (f". {v['tip']}" if v["tip"] else ""))
    elif a.cmd == "sent":
        bot_home().mkdir(parents=True, exist_ok=True)
        (bot_home() / "debrief_sent").write_text(now.date().isoformat())
    return 0


if __name__ == "__main__":
    sys.exit(main())
