#!/usr/bin/env python3
"""Your health settings: daily food targets, water, steps, sleep, training days, weight goal.

health/settings.json holds them. The health-bot skill fills it in on first use with a short
onboarding (it asks you, then runs `set`). Until then, and for any key left out, the neutral
DEFAULTS below apply, so the bot works from day one. The timezone comes from the repo's own
settings.json (bots/settings.py), not from here.

  health_settings.py show                      the settings in force, in plain words
  health_settings.py set --args-json <file>    merge a JSON object into health/settings.json
                                               (checked: unknown keys and odd numbers are refused)
  health_settings.py onboarded                 prints yes or no

HEALTH_SETTINGS overrides the file's path (tests use it).

These are estimates and habits to aim at, not medical advice: a doctor or dietitian sets
targets for anyone with a medical condition, pregnancy or an eating disorder.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from datetime import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HEALTH.parent / "bots"))
import settings as repo_settings  # noqa: E402  (bots/settings.py: timezone)

# Neutral starting points for a generic adult (roughly in line with common dietary
# guidelines). The onboarding replaces them with the user's own.
DEFAULTS = {
    "onboarded": False,
    "goal": "maintain",              # lose | maintain | gain (weight)
    "diet": "",                      # the user's own words: "vegetarian", "low carb", "no pork"...
    "targets": {
        "kcal": [1800, 2200],
        "protein_g": [90, 130],
        "carbs_g": [180, 260],
        "fat_g": [60, 85],
        "sat_fat_g_max": 20,
        "fibre_g_min": 30,
        "veg_servings": [3, 5],
        "fruit_servings_min": 2,
    },
    "water_ml": 2000,                # a day; tea, coffee and other unsweetened drinks count
    "steps": [8000, 12000],          # a day: the weekly target uses the first number
    "sleep_h": 7.5,                  # a night's goal; the app shows a band from half an hour under to 1.5 h over
    "weight_goal_kg": None,          # optional
    "strength_days_per_week": 3,
    "cardio_per_week": 1,            # runs, rides or rows
    "debrief_at": "21:00",           # the evening debrief, local time; water is paced to it
}
RANGES = {  # key: (lo, hi) for every number in it
    "kcal": (800, 6000), "protein_g": (20, 400), "carbs_g": (0, 800), "fat_g": (10, 300),
    "sat_fat_g_max": (5, 100), "fibre_g_min": (5, 100), "veg_servings": (0, 15), "fruit_servings_min": (0, 10),
    "water_ml": (500, 6000), "steps": (500, 40000), "sleep_h": (4, 12), "weight_goal_kg": (30, 300),
    "strength_days_per_week": (0, 7), "cardio_per_week": (0, 14),
}


def path() -> Path:
    return Path(os.environ.get("HEALTH_SETTINGS") or HEALTH / "settings.json")


def load() -> dict:
    """DEFAULTS with the file's values on top (targets merged key by key)."""
    out = copy.deepcopy(DEFAULTS)
    try:
        data = json.loads(path().read_text())
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    for k, v in data.items():
        if k == "targets" and isinstance(v, dict):
            out["targets"].update({tk: tv for tk, tv in v.items() if tk in DEFAULTS["targets"]})
        elif k in DEFAULTS:
            out[k] = v
    return out


def targets() -> dict:
    return load()["targets"]


def water_ml() -> int:
    return int(load()["water_ml"])


def steps_band() -> list:
    s = load()["steps"]
    return [int(s), int(s) + 4000] if isinstance(s, (int, float)) else [int(s[0]), int(s[1])]


def sleep_goal() -> float:
    s = load()["sleep_h"]
    return float(s) if isinstance(s, (int, float)) else (float(s[0]) + float(s[1])) / 2


def sleep_band() -> list:
    s = load()["sleep_h"]
    return [float(s) - 0.5, float(s) + 1.5] if isinstance(s, (int, float)) else [float(s[0]), float(s[1])]


def debrief_at() -> time:
    try:
        hh, mm = str(load()["debrief_at"]).split(":")
        return time(int(hh), int(mm))
    except (ValueError, TypeError):
        return time(21, 0)


def tz():
    return repo_settings.tz()


def tz_name() -> str:
    return str(repo_settings.get("timezone") or repo_settings.DEFAULTS["timezone"])


def profile(base: dict) -> dict:
    """The training plan (training/profile.json) with the user's own numbers on top."""
    s = load()
    out = dict(base)
    out["strength_days_per_week"] = int(s["strength_days_per_week"])
    out["cardio_per_week"] = int(s["cardio_per_week"])
    out["daily_targets"] = {"sleep_h": sleep_band(), "steps": steps_band()}
    return out


# ------------------------------------------------------------------ checking a change

def _check_num(key: str, v, allow_none: bool = False):
    if v is None and allow_none:
        return None
    vals = v if isinstance(v, list) else [v]
    if not vals or len(vals) > 2 or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in vals):
        raise ValueError(f"{key}: give a number (or [low, high])")
    lo, hi = RANGES[key]
    if not all(lo <= x <= hi for x in vals):
        raise ValueError(f"{key}: {v} is outside {lo}-{hi}")
    if len(vals) == 2 and vals[0] > vals[1]:
        raise ValueError(f"{key}: low is above high")
    return v


def clean(change: dict) -> dict:
    """Validate a change; raises ValueError with the reason."""
    if not isinstance(change, dict):
        raise ValueError("expected a JSON object")
    out: dict = {}
    for k, v in change.items():
        if k == "targets":
            if not isinstance(v, dict):
                raise ValueError("targets: expected an object")
            bad = set(v) - set(DEFAULTS["targets"])
            if bad:
                raise ValueError(f"unknown target(s): {', '.join(sorted(bad))}")
            out["targets"] = {tk: _check_num(tk, tv) for tk, tv in v.items()}
        elif k == "goal":
            if v not in ("lose", "maintain", "gain"):
                raise ValueError("goal: lose, maintain or gain")
            out[k] = v
        elif k == "diet":
            if not isinstance(v, str) or len(v) > 200:
                raise ValueError("diet: a short description (200 characters at most)")
            out[k] = " ".join(v.split())
        elif k == "onboarded":
            out[k] = bool(v)
        elif k == "debrief_at":
            try:
                hh, mm = str(v).split(":")
                time(int(hh), int(mm))
            except (ValueError, TypeError):
                raise ValueError("debrief_at: HH:MM") from None
            out[k] = f"{int(hh):02d}:{int(mm):02d}"
        elif k in RANGES:
            out[k] = _check_num(k, v, allow_none=(k == "weight_goal_kg"))
        else:
            raise ValueError(f"unknown setting: {k}")
    return out


def save_change(change: dict) -> dict:
    change = clean(change)
    try:
        data = json.loads(path().read_text())
        data = data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        data = {}
    for k, v in change.items():
        if k == "targets":
            data.setdefault("targets", {}).update(v)
        else:
            data[k] = v
    tmp = path().with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    tmp.rename(path())
    return load()


def describe(s: dict) -> str:
    t = s["targets"]
    rng = lambda v, u="": f"{v[0]:,}–{v[1]:,}{u}" if isinstance(v, list) else f"{v:,}{u}"  # noqa: E731
    lines = [
        f"Goal: {s['goal']} weight" + (f", towards {s['weight_goal_kg']:g} kg" if s.get("weight_goal_kg") else ""),
        f"Diet: {s['diet'] or 'no preferences given'}",
        f"Calories {rng(t['kcal'])} kcal · protein {rng(t['protein_g'], ' g')} · carbs {rng(t['carbs_g'], ' g')} · fat {rng(t['fat_g'], ' g')}",
        f"Sat fat under {t['sat_fat_g_max']} g · fibre {t['fibre_g_min']}+ g · veg {rng(t['veg_servings'])} servings · fruit {t['fruit_servings_min']}+",
        f"Water {s['water_ml']:,} ml a day · steps {steps_band()[0]:,} a day · sleep {sleep_goal():g} h a night",
        f"Training: {s['strength_days_per_week']} strength sessions and {s['cardio_per_week']} cardio a week",
        f"Evening debrief at {s['debrief_at']} ({tz_name()})",
    ]
    if not s.get("onboarded"):
        lines.append("(Default values: onboarding hasn't run yet.)")
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show")
    sub.add_parser("onboarded")
    s = sub.add_parser("set")
    s.add_argument("--args-json", required=True, help="a file holding the JSON object to merge in")
    a = p.parse_args(argv)
    if a.cmd == "show":
        print(describe(load()))
    elif a.cmd == "onboarded":
        print("yes" if load().get("onboarded") else "no")
    else:
        try:
            new = save_change(json.loads(Path(a.args_json).read_text()))
        except (OSError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        print("Saved.\n" + describe(new))
    return 0


if __name__ == "__main__":
    sys.exit(main())
