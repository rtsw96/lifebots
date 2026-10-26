"""Tests for the workout log. Run: python3 -m unittest health/foodbot/test_workoutlog.py"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Pinned: the tests use the neutral defaults (health_settings.DEFAULTS) and Asia/Singapore,
# never the settings files of whoever runs them.
os.environ["HEALTH_SETTINGS"] = str(HERE / "no-such-health-settings.json")
os.environ["SETTINGS_JSON"] = str(HERE / "no-such-settings.json")
sys.path.insert(0, str(HERE))

import workoutlog as wl  # noqa: E402


def run(*args) -> str:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        wl.main(list(args))
    return out.getvalue()


class Library(unittest.TestCase):
    def test_every_exercise_is_well_formed(self):
        for e in wl.LIB["exercises"]:
            self.assertIn(e["kind"], {"weight", "reps", "time", "cardio"}, e["id"])
            self.assertIn(e["load"], {"pair", "side", "total", "none"}, e["id"])
            for m in e["primary"] + e["secondary"]:
                self.assertIn(m, wl.LIB["muscles"], e["id"])
            if e["kind"] != "cardio":
                self.assertTrue(e["primary"], e["id"])

    def test_names_and_aliases_are_unambiguous(self):
        seen = {}
        for e in wl.LIB["exercises"]:
            for k in [e["id"], e["name"], *e["aliases"]]:
                n = wl.norm(k)
                self.assertIn(seen.setdefault(n, e["id"]), {e["id"]}, f"'{k}' maps to two exercises")

    def test_resolve(self):
        self.assertEqual(wl.resolve("DB Bench"), "db_bench_press")
        self.assertEqual(wl.resolve("Dumbbell Kickbacks"), "db_kickback")
        with self.assertRaises(SystemExit):
            wl.resolve("underwater basket weaving")


class Arithmetic(unittest.TestCase):
    def test_parse_sets(self):
        bench, dip, hold = wl.EX["db_bench_press"], wl.EX["bench_dip"], wl.EX["plank"]
        self.assertEqual(wl.parse_sets(bench, "12x14, 4x8@22")[0], {"reps": 12.0, "weight_kg": 14.0})
        self.assertEqual(len(wl.parse_sets(bench, "4x8@22")), 4)
        self.assertEqual(wl.parse_sets(dip, "3x16"), [{"reps": 16.0}] * 3)
        self.assertEqual(wl.parse_sets(hold, "0:20,3x25s"), [{"seconds": 20}] + [{"seconds": 25}] * 3)
        with self.assertRaises(SystemExit):
            wl.parse_sets(bench, "heavy")

    def test_e1rm_and_volume(self):
        self.assertAlmostEqual(wl.e1rm(100, 1), 100)
        self.assertAlmostEqual(wl.e1rm(30, 10), 40)
        self.assertAlmostEqual(wl.e1rm(30, 20), wl.e1rm(30, 12))    # capped
        sets = [{"weight_kg": "10", "reps": "10"}] * 2
        self.assertEqual(wl.volume(wl.EX["hammer_curl"], sets), 400)  # both dumbbells count
        self.assertEqual(wl.volume(wl.EX["lat_pulldown"], sets), 200)

    def test_pace_line(self):
        def row(ex, seq, gap="", plan="", rir=""):
            return {"exercise_id": ex, "seq": str(seq), "rest_s": gap, "rest_plan_s": plan, "rir": rir}
        sets = [row("lat_pulldown", 1), row("lat_pulldown", 2, "200", "120"),
                row("db_bench_press", 3, "170", "120", "2"), row("db_bench_press", 4, "1200", "120", "2")]
        out = wl.pace_line(sets).splitlines()
        self.assertEqual(out[0], "Order done: Lat Pulldown → Dumbbell Bench Press")
        self.assertIn("3:05 on average, plan 2:50", out[1])    # the 20-minute gap is a break, left out
        self.assertIn("92% of plan pace", out[1])
        self.assertEqual(out[2], "Reps left in the tank: Dumbbell Bench Press 2")
        quick = [row("lat_pulldown", 1), row("lat_pulldown", 2, "0", "0")]
        self.assertIn("quicker than plan", wl.pace_line(quick))
        self.assertEqual(wl.pace_line([row("lat_pulldown", 1)]), "")


class Log(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.env = mock_env = {"WORKOUT_CSV": str(d / "w.csv"), "BODY_CSV": str(d / "b.csv"), "ACTIVITY_CSV": str(d / "a.csv")}
        self._old = {k: os.environ.get(k) for k in mock_env}
        os.environ.update(mock_env)

    def tearDown(self):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_add_groups_sets_into_one_workout_and_flags_progress(self):
        run("add", "--exercise", "db row", "--sets", "4x6@22", "--date", "2026-09-27", "--time", "14:53")
        run("add", "--exercise", "db curl", "--sets", "4x8@12", "--date", "2026-09-27", "--time", "15:20")
        out = run("add", "--exercise", "db row", "--sets", "3x8@22", "--date", "2026-10-09", "--time", "19:35")
        rows = wl.load(wl.log_path())
        self.assertEqual(len({r["workout_id"] for r in rows if r["date"] == "2026-09-27"}), 1)
        self.assertIn("PR", out)
        self.assertIn("vs 2026-09-27", out)

    def test_ref_dedup_and_undo(self):
        args = ["add", "--exercise", "db bench", "--sets", "10x26", "--ref", "55"]
        run(*args)
        self.assertIn("Already logged", run(*args))
        run("undo")
        self.assertEqual(wl.load(wl.log_path()), [])

    def test_import_and_warmups_do_not_count(self):
        w = {"date": "2026-10-01", "time": "12:18", "ref": "fitbod:x", "blocks": [
            {"block": "A", "exercises": [{"exercise": "db bench", "sets": "10x10,10x26,10x26"}]}]}
        p = Path(self.tmp.name) / "w.json"
        p.write_text(json.dumps(w))
        run("import", "--json", str(p))
        self.assertIn("Skipped", run("import", "--json", str(p)))
        ms = wl.muscle_sets(wl.load(wl.log_path()))
        self.assertEqual(ms["chest"], 2)          # the 10 kg ramp set is a warm-up
        self.assertEqual(ms["triceps"], 1)        # secondary counts half

    def test_run_and_body(self):
        self.assertIn("5:30/km", run("run", "--km", "5", "--minutes", "27.5", "--date", "2026-10-05"))
        run("body", "--weight", "80.4", "--date", "2026-10-01")
        out = run("body", "--weight", "80.0", "--date", "2026-10-08")
        self.assertIn("-0.4 kg vs the week before", out)
        week = run("week", "--end", "2026-10-08")
        self.assertIn("1 cardio, 5 km", week)

    def test_watch_runs_and_rides_reach_the_training_log_once(self):
        acts = [
            {"id": "a1", "date": "2026-10-05", "start": "07:10", "end": "07:38", "name": "Outdoor Run", "min": "28", "kcal": "300", "km": "5.1"},  # = the logged run
            {"id": "a2", "date": "2026-10-06", "start": "06:45", "end": "07:17", "name": "Outdoor Run", "min": "32", "kcal": "290", "km": "5.42"},
            {"id": "a3", "date": "2026-10-07", "start": "21:28", "end": "22:28", "name": "Indoor Cycling", "min": "60", "kcal": "450", "km": ""},
            {"id": "a4", "date": "2026-10-07", "start": "18:40", "end": "18:58", "name": "Outdoor Walk", "min": "18", "kcal": "80", "km": "1.6"},
            {"id": "a5", "date": "2026-10-08", "start": "17:10", "end": "17:44", "name": "Traditional Strength Training", "min": "34", "kcal": "130", "km": ""},
        ]
        wl.save(wl.activity_path(), acts, list(acts[0]))
        run("run", "--km", "5", "--minutes", "27.5", "--date", "2026-10-05", "--time", "07:12")
        # the weekly review counts the Watch's runs, rides and strength sessions before any copy is made
        week = run("week", "--end", "2026-10-08")
        self.assertIn("1 strength sessions", week)
        self.assertIn("3 cardio, 10.42 km", week)
        self.assertIn("Watch only", week)
        self.assertIn("2 Watch cardio session(s) added", run("sync-apple"))
        self.assertIn("already has every", run("sync-apple"))
        rows = wl.load(wl.log_path())
        got = sorted((r["date"], r["exercise_id"], r["seconds"], r["distance_km"], r["ref"]) for r in rows)
        self.assertEqual(got, [("2026-10-05", "run", "1650", "5.0", ""),
                               ("2026-10-06", "run", "1920", "5.42", "apple:a2"),
                               ("2026-10-07", "bike", "3600", "", "apple:a3")])
        self.assertIn("3 cardio, 10.42 km", run("week", "--end", "2026-10-08"))  # no double counting after the copy


if __name__ == "__main__":
    unittest.main()
