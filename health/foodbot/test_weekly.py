"""Weekly targets and the evening debrief. Run: python3 -m unittest discover -s health/foodbot"""

import csv
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Pinned: the tests use the neutral defaults (health_settings.DEFAULTS) and Asia/Singapore,
# never the settings files of whoever runs them.
os.environ["HEALTH_SETTINGS"] = str(HERE / "no-such-health-settings.json")
os.environ["SETTINGS_JSON"] = str(HERE / "no-such-settings.json")
sys.path.insert(0, str(HERE))
import foodlog as fl  # noqa: E402
import waterlog as water  # noqa: E402
import weekly as W  # noqa: E402
import workoutlog as wl  # noqa: E402


def write(p: Path, fields: list[str], rows: list[dict]):
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def meal(d, kcal, protein, veg, sat):
    return {"entry_id": d + str(kcal), "meal_date": d, "meal_time": "12:00", "meal": "lunch", "kcal": kcal,
            "protein_g": protein, "veg_servings": veg, "sat_fat_g": sat}


class Weekly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.env = {"FOODLOG_CSV": d / "food.csv", "WORKOUT_CSV": d / "w.csv", "ACTIVITY_CSV": d / "a.csv",
                    "DAILY_CSV": d / "daily.csv", "OURA_CSV": d / "oura.csv", "BODY_CSV": d / "body.csv",
                    "WEEKLY_JSON": d / "weekly.json", "FOODBOT_HOME": d / "home", "WATER_CSV": d / "water.csv"}
        self.old = {k: os.environ.get(k) for k in self.env}
        os.environ.update({k: str(v) for k, v in self.env.items()})
        # last week (5-11 Oct): ~80 g protein, no veg days, 4,900 steps; this week from Mon 12 Oct
        food = [meal(f"2026-10-{d:02d}", 1950, 80, 1, 26) for d in range(5, 12)]
        food += [meal("2026-10-12", 2000, 140, 4, 15), meal("2026-10-13", 1700, 85, 1, 20), meal("2026-10-14", 2050, 135, 5, 14)]
        write(self.env["FOODLOG_CSV"], fl.FIELDS, food)
        write(self.env["DAILY_CSV"], ["date", "steps", "sleep_h"],
              [{"date": f"2026-10-{d:02d}", "steps": 4900} for d in range(5, 12)]
              + [{"date": "2026-10-12", "steps": 9000, "sleep_h": 6.5}, {"date": "2026-10-13", "steps": 5000, "sleep_h": 7}])
        write(self.env["OURA_CSV"], ["date", "sleep_h"], [{"date": "2026-10-13", "sleep_h": 7.4}])  # Oura wins over the Watch
        write(self.env["ACTIVITY_CSV"], ["id", "date", "start", "end", "name", "min", "kcal", "km", "avg_hr", "max_hr"],
              [{"id": "r1", "date": "2026-10-13", "start": "07:00", "end": "07:30", "name": "Outdoor Run", "min": "30", "km": "5"},
               {"id": "s1", "date": "2026-10-14", "start": "18:00", "end": "19:00", "name": "Traditional Strength Training", "min": "60"}])
        write(self.env["WORKOUT_CSV"], wl.FIELDS,
              [{"set_id": 1, "workout_id": "2026-10-12T1800", "date": "2026-10-12", "time": "18:00", "exercise_id": "db_row", "set_no": 1,
                "weight_kg": 20, "reps": 10}])
        write(self.env["BODY_CSV"], wl.BODY_FIELDS, [])
        # water: nothing last week; 2.6 L on Tuesday, 500 ml by late morning on Wednesday
        write(self.env["WATER_CSV"], water.FIELDS,
              [{"id": "c1", "date": "2026-10-13", "time": "10:00", "ml": 2600, "source": "chat"},
               {"id": "c2", "date": "2026-10-14", "time": "08:30", "ml": 300, "source": "app"},
               {"id": "c3", "date": "2026-10-14", "time": "11:00", "ml": 200, "source": "chat"}])

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_targets_step_halfway_from_last_week_toward_the_plan(self):
        tg = {t["key"]: t for t in W.targets_for(date(2026, 10, 12))["targets"]}
        self.assertEqual(tg["strength"]["target"], 3)
        self.assertEqual(tg["steps"]["target"], 6500)          # halfway from 4,900 to 8,000, up to the next 500
        self.assertIn("last week 4,900, so halfway", tg["steps"]["why"])
        self.assertEqual(tg["protein"]["target"], 3)           # 0 days last week, plan 6
        self.assertEqual(tg["kcal"]["target"], 5)              # 7 days in range last week: the plan itself
        self.assertEqual(tg["veg"]["target"], 3)
        self.assertEqual(tg["sleep"]["target"], 7.5)           # no sleep data last week: the plan
        self.assertEqual(tg["water"]["target"], 5)             # no water logged last week: the plan
        saved = json.loads(self.env["WEEKLY_JSON"].read_text())
        self.assertIn("2026-10-12", saved["weeks"])            # kept, so the week's targets don't move

    def test_status_counts_the_week_and_says_what_is_left(self):
        later = datetime(2026, 10, 20, 9, 0, tzinfo=W.wl.tz())   # the 14th is over, whatever today is
        with mock.patch.object(W.wl, "now", return_value=later):
            text = W.status(date(2026, 10, 14))
        self.assertIn("day 3 of 7 (4 to go)", text)
        self.assertIn("Strength sessions: 2 of 3, 1 more in 4 days", text)   # logged Monday + Watch-only Wednesday
        self.assertIn("✓ Run, ride or row: 1 of 1", text)                    # the Watch run, not yet copied
        self.assertIn("Days with 90 g+ protein: 2 of 3, 1 more in 4 days", text)
        self.assertIn("✓ Steps a day: 7,000 average", text)                   # 9,000 and 5,000
        self.assertIn("Sleep a night (h): 7.0 average (target 7.5), needs 7.8 a day from here", text)  # 6.5, then Oura's 7.4: (7.5 x 6 - 13.9) / 4
        self.assertIn("Food logged on 3 of 3 days", text)
        self.assertIn("Days with 2 L+ water: 1 of 5", text)
        self.assertIn("Water: 0.5 L of 2 L (25%, 2 drinks). 1,500 ml short of the goal.", text)   # a past day, as it ended

    def test_the_pet_lives_on_the_week(self):
        W.targets_for(date(2026, 10, 5))                      # last week had targets too: its hits are stars
        tz = wl.tz()
        v = W.view(date(2026, 10, 14), datetime(2026, 10, 14, 13, 0, tzinfo=tz))
        self.assertEqual(set(v["needs"]), {"food", "rest", "fitness", "water"})
        # water at 13:00: 500 ml against 769 ml by now (5 of 13 hours of 2 L), with 400 ml of slack
        self.assertEqual(v["needs"]["water"], round(900 / 1169, 2))
        other = sum(v["needs"][k] for k in ("food", "rest", "fitness")) / 3
        self.assertEqual(v["mood"], round((0.5 * v["needs"]["water"] + 0.5 * other) * 100))     # water is half the mood
        self.assertTrue(all(0 <= x <= 1 for x in v["needs"].values() if x is not None))
        self.assertTrue(0 <= v["mood"] <= 100)
        self.assertEqual(v["history"][0]["week"], "2026-10-05")
        self.assertEqual(v["stars"], v["history"][0]["hit"])
        self.assertEqual(v["level"], 1 + v["stars"] // W.STARS_PER_LEVEL)
        self.assertEqual(v["streak"], 10)                       # food logged every day from 5 to 14 Oct
        self.assertIn("An early night? We need 7.8 h", v["tip"])  # sleep is the most behind
        thirsty = W.view(date(2026, 10, 14), datetime(2026, 10, 14, 18, 0, tzinfo=tz))
        self.assertEqual(thirsty["tip"], "I'm thirsty! About 1,038 ml to catch up.")   # 1,538 by 18:00, 500 drunk
        self.assertLess(thirsty["mood"], v["mood"])
        fresh = W.view(date(2026, 10, 12), datetime(2026, 10, 12, 8, 30, tzinfo=tz))   # a fresh Monday morning reads as fine
        self.assertGreaterEqual(fresh["mood"], 65)

    def test_water_log_by_chat(self):
        rows = water.load()
        self.assertIsNotNone(water.add(rows, 500, "2026-10-14", "15:00", "chat", ref="7"))
        self.assertIsNone(water.add(rows, 500, "2026-10-14", "15:05", "chat", ref="7"))     # same ref: logged once
        self.assertEqual(water.total(rows, "2026-10-14"), 1000)
        with self.assertRaises(SystemExit):
            water.add(rows, 0, "2026-10-14", "15:00", "chat")
        tz = wl.tz()
        self.assertEqual(water.today_line(rows, datetime(2026, 10, 14, 19, 0, tzinfo=tz)),
                         "Water today: 1 L of 2 L (50%, 3 drinks). 692 ml behind the pace for 19:00; 1,000 ml to go by 21:00.")
        self.assertIn("On pace", water.today_line(rows, datetime(2026, 10, 14, 12, 0, tzinfo=tz)))
        self.assertEqual(water.pace(0, 7 * 60), 1.0)              # before 08:00 nothing is due yet

    def test_debrief_is_due_at_nine_until_sent(self):
        tz = wl.tz()
        self.assertEqual(W.due_in(datetime(2026, 10, 14, 20, 0, tzinfo=tz)), 3600)
        self.assertEqual(W.due_in(datetime(2026, 10, 14, 21, 5, tzinfo=tz)), 0)
        self.env["FOODBOT_HOME"].mkdir()
        (self.env["FOODBOT_HOME"] / "debrief_sent").write_text("2026-10-14")
        self.assertEqual(W.due_in(datetime(2026, 10, 14, 21, 5, tzinfo=tz)), 23 * 3600 + 55 * 60)


if __name__ == "__main__":
    unittest.main()
