#!/usr/bin/env python3
"""Build a synthetic /api/data file for the preview scripts: two weeks of made-up meals,
workouts, weigh-ins, water and a small checklist, written through the bot's own tools into
a temporary folder (never the repo's logs), then turned into a snapshot.

  python3 health/app/preview/sample_data.py <out.json>      a synthetic snapshot
  python3 health/app/preview/sample_data.py <out.json> --empty   the snapshot of the empty templates

Then, for example: node health/app/preview/screenshots.mjs <shots-dir> <out.json>
Nothing here is anyone's real data.
"""

import json
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

HEALTH = Path(__file__).resolve().parents[2]
REPO = HEALTH.parent


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2
    out = Path(sys.argv[1]).resolve()
    if REPO in out.parents:
        print("Write the file outside the repo (a scratch folder).", file=sys.stderr)
        return 2
    d = Path(tempfile.mkdtemp())
    names = {"FOODLOG_CSV": "food.csv", "WORKOUT_CSV": "w.csv", "BODY_CSV": "body.csv", "WORKOUT_EDITS_CSV": "edits.csv",
             "ACTIVITY_CSV": "a.csv", "DAILY_CSV": "daily.csv", "OURA_CSV": "oura.csv", "WATER_CSV": "water.csv",
             "HABIT_CSV": "habits.csv", "WEEKLY_JSON": "weekly.json", "PLAN_JSON": "plan.json", "FOODBOT_HOME": "home"}
    os.environ.update({k: str(d / v) for k, v in names.items()})
    (d / "plan.json").write_text('{"tasks": [], "habits": []}')
    sys.path.insert(0, str(HEALTH / "foodbot"))
    import app_sync
    import foodlog as fl
    import plan
    import waterlog as water
    import workoutlog as wl

    if "--empty" not in sys.argv:
        today = wl.now().date()
        meals = [("Oats with milk and a banana", 420, 18, 65, 9, 3, 6, 0, 1), ("Chicken salad wrap", 520, 38, 45, 18, 4, 5, 1.5, 0),
                 ("Salmon, rice and greens", 650, 40, 60, 24, 5, 4, 2, 0), ("Greek yoghurt and berries", 220, 17, 22, 6, 3, 3, 0, 1)]
        rows = []
        for back in range(13, -1, -1):
            day = today - timedelta(days=back)
            for i, (desc, kcal, p, c, f, sat, fib, veg, fruit) in enumerate(meals if back else meals[:2]):
                rows.append({"entry_id": str(len(rows) + 1), "logged_at": "", "meal_date": day.isoformat(),
                             "meal_time": ["08:00", "12:30", "19:00", "16:00"][i], "meal": ["breakfast", "lunch", "dinner", "snack"][i],
                             "description": desc, "kcal": kcal + back * 5, "protein_g": p, "carbs_g": c, "fat_g": f, "sat_fat_g": sat,
                             "fibre_g": fib, "veg_servings": veg, "fruit_servings": fruit, "confidence": "medium", "source": "text",
                             "tg_update_id": "", "notes": ""})
            drinks = water.load()
            for k, ml in enumerate([500, 250, 500, 500] if back else [500, 250]):
                water.add(drinks, ml, day.isoformat(), f"{9 + 3 * k:02d}:00", "chat", ref=f"s{back}-{k}")
            water.save(drinks)
        fl.save(rows)
        sets = wl.load(wl.log_path())
        for back, ex in ((12, ["db_bench_press", "lat_pulldown", "plank"]), (9, ["goblet_squat", "db_rdl", "calf_raise"]),
                         (5, ["db_bench_press", "lat_pulldown", "plank"]), (2, ["goblet_squat", "db_rdl", "calf_raise"])):
            day = (today - timedelta(days=back)).isoformat()
            for e in ex:
                spec = {"plank": "3x40s", "calf_raise": "3x15"}.get(e, f"3x10@{20 + (12 - back)}")
                parsed = wl.parse_sets(wl.EX[e], spec)
                wl.append_sets(sets, e, parsed, d=day, t="18:00", workout=f"{day}T1800", block="A", source="sample", ref=f"sample-{back}")
        wl.save(wl.log_path(), sets, wl.FIELDS)
        body = [{"date": (today - timedelta(days=b)).isoformat(), "time": "07:00", "weight_kg": f"{75 + b * 0.05:.1f}",
                 "waist_cm": "", "source": "sample", "notes": ""} for b in range(13, -1, -2)]
        wl.save(wl.body_path(), body, wl.BODY_FIELDS)
        p = plan.load()
        plan.add(p, {"type": "daily", "title": "Stretch", "when": "evening"})
        plan.add(p, {"type": "step", "title": "Book a dental check-up", "due": (today + timedelta(days=10)).isoformat()})
        plan.save(p)
    data = {"ok": True, "snap": app_sync.snapshot(), "queue": [], "draft": None}
    out.write_text(json.dumps(data))
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
