"""Tests for the health app sync. Run: python3 -m unittest health/foodbot/test_app_sync.py"""

import json
from datetime import date
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

import app_sync  # noqa: E402
import workoutlog as wl  # noqa: E402

TOKEN = "123456:TEST-token_for-vectors"


class Sync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.vars = {"WORKOUT_CSV": str(d / "w.csv"), "BODY_CSV": str(d / "b.csv"), "FOODLOG_CSV": str(d / "f.csv"),
                     "ACTIVITY_CSV": str(d / "a.csv"), "DAILY_CSV": str(d / "d.csv"),
                     "PLAN_JSON": str(d / "plan.json"), "HABIT_CSV": str(d / "h.csv"), "FOODBOT_HOME": str(d / "home"),
                     "OURA_CSV": str(d / "o.csv"), "WATER_CSV": str(d / "water.csv"),
                     "WEEKLY_JSON": str(d / "weekly.json"),
                     "WORKOUT_EDITS_CSV": str(d / "edits.csv")}
        self.old = {k: os.environ.get(k) for k in self.vars}
        os.environ.update(self.vars)

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_workout_edits_are_logged_once_and_reach_the_planner(self):
        edits = [{"kind": "swap", "stage": "plan", "slot": "chest_main", "from": "db_bench_press", "to": "machine_chest_press", "with": ["lat_pulldown"]},
                 {"kind": "remove", "stage": "live", "slot": "core", "from": "plank", "with": []},
                 {"kind": "add", "stage": "live", "to": "db_curl"}]
        item = {"id": "1760090000002-0a1b2c3f", "kind": "workout", "data": {
            "date": "2026-10-10", "time": "18:05", "sets": 1, "edits": edits,
            "blocks": [{"block": "A", "items": [{"ex": "machine_chest_press", "sets": [{"weight_kg": 40, "reps": 10}]}]}]}}
        app_sync.apply([item])
        app_sync.apply([item])                                   # second run: nothing new
        rows = wl.load(wl.edits_path())
        self.assertEqual([(r["kind"], r["from_ex"], r["to_ex"]) for r in rows],
                         [("swap", "db_bench_press", "machine_chest_press"), ("remove", "plank", ""), ("add", "", "db_curl")])
        self.assertEqual(rows[0]["with_ex"], "lat_pulldown")
        p = app_sync.snapshot(date(2026, 10, 12))["workout_prefs"]
        self.assertEqual(p["ex"]["db_bench_press"], {"out": 1, "in": 0})
        self.assertEqual(p["slot"]["chest_main"], {"machine_chest_press": 1})
        self.assertEqual(p["pairs"], {"db_bench_press|lat_pulldown": 1})
        self.assertIn("Usually removed or swapped out", wl.prefs_text(rows, date(2026, 10, 12)))
        self.assertEqual(wl.prefs(rows, date(2027, 6, 1))["ex"], {})   # old edits stop counting

    def test_a_split_teaches_the_pair_but_keeps_the_exercise(self):
        item = {"id": "1760090000003-0a1b2c3f", "kind": "workout", "data": {
            "date": "2026-10-11", "time": "18:05", "sets": 1,
            "edits": [{"kind": "split", "stage": "live", "from": "lat_pulldown", "with": ["db_bench_press"]}],
            "blocks": [{"block": "A", "items": [{"ex": "lat_pulldown", "sets": [{"weight_kg": 50, "reps": 10}]}]}]}}
        app_sync.apply([item])
        rows = wl.load(wl.edits_path())
        self.assertEqual([(r["kind"], r["from_ex"], r["with_ex"]) for r in rows], [("split", "lat_pulldown", "db_bench_press")])
        p = wl.prefs(rows, date(2026, 10, 12))
        self.assertEqual(p["pairs"], {"db_bench_press|lat_pulldown": 1})
        self.assertEqual(p["ex"], {})   # moved, not rejected

    def test_signature_matches_the_worker(self):
        # Same vector as health/app/test/worker.test.mjs.
        body = b'{"op":"list","ts":"2026-01-01T00:00:00+00:00"}'
        self.assertEqual(app_sync.sign(TOKEN, body),
                         "7a7080065542fce47b32cca0219a4b200dd0be9d600990d95591f80ba4bf7417")

    def test_apply_is_dedup_safe_and_feeds_the_snapshot(self):
        items = [
            {"id": "1760090000000-0a1b2c3d", "kind": "workout", "data": {
                "date": "2026-10-10", "time": "18:05", "sets": 3, "blocks": [{"block": "A", "items": [
                    {"ex": "db_bench_press", "sets": [{"weight_kg": 26, "reps": 10}, {"weight_kg": 26, "reps": 9}]},
                    {"ex": "plank", "sets": [{"seconds": 40}]}]}]}},
            {"id": "1760090000001-0a1b2c3e", "kind": "body", "data": {"date": "2026-10-10", "kg": 80.4, "waist": None}},
        ]
        out = app_sync.apply(items)
        self.assertEqual(len(out), 2)
        self.assertIn("Dumbbell Bench Press: 10x26 9x26", out[0])
        self.assertEqual(app_sync.apply(items), [])          # second run: nothing new
        rows = wl.load(wl.log_path())
        self.assertEqual(len(rows), 3)
        self.assertEqual({r["ref"] for r in rows}, {"app:1760090000000-0a1b2c3d"})
        self.assertEqual(app_sync.logged_refs(), {"app:1760090000000-0a1b2c3d", "app:1760090000001-0a1b2c3e"})
        snap = app_sync.snapshot()
        self.assertEqual(len(snap["sets"]), 3)
        self.assertEqual(snap["sets"][0]["kg"], 26)
        self.assertEqual(snap["body"], [{"date": "2026-10-10", "kg": 80.4, "waist": None}])
        self.assertNotIn("_source", snap["targets"])

    def test_water_from_the_app_can_be_undone_before_or_after_the_bot_logs_it(self):
        import waterlog as water
        add = {"id": "1792058000000-0a1b2c3d", "kind": "water", "data": {"date": "2026-10-01", "time": "14:05", "ml": 500}}
        out = app_sync.apply([add, {"id": "1792058000001-0a1b2c3e", "kind": "water", "data": {"date": "2026-10-01", "time": "15:00", "ml": 250}}])
        self.assertEqual(len(out), 2)
        self.assertTrue(out[1].startswith("Water 2026-10-01: 0.75 L of 2 L"))
        self.assertEqual(app_sync.apply([add]), [])                                  # second run: nothing new
        rows = water.load()
        self.assertEqual([(r["id"], r["ml"], r["source"]) for r in rows], [("1792058000000-0a1b2c3d", "500", "app"), ("1792058000001-0a1b2c3e", "250", "app")])
        app_sync.apply([{"id": "1792058000002-0a1b2c3f", "kind": "water_delete", "data": {"id": "1792058000000-0a1b2c3d"}}])
        self.assertEqual(water.total(water.load(), "2026-10-01"), 250)
        self.assertEqual(app_sync.apply([add]), [])                                  # an undone drink never comes back
        snap = app_sync.snapshot(date(2026, 10, 1))
        self.assertEqual(snap["water"]["goal_ml"], 2000)
        self.assertEqual(snap["water"]["today"], [{"id": "1792058000001-0a1b2c3e", "time": "15:00", "ml": 250}])
        self.assertEqual(snap["water"]["days"], [{"date": "2026-10-01", "ml": 250}])
        self.assertIn("water", snap["weekly"]["needs"])

    def test_watch_heart_rate_per_exercise_lands_on_the_app_workout(self):
        at = 1792058730000  # 2026-10-13 18:05:30 SGT
        app_sync.apply([{"id": "1792058000000-0a1b2c3d", "kind": "workout", "data": {
            "date": "2026-10-13", "time": "18:00", "sets": 3, "blocks": [
                {"block": "A", "items": [{"ex": "lat_pulldown", "sets": [{"weight_kg": 45, "reps": 10, "at": at, "seq": 1},
                                                                       {"weight_kg": 45, "reps": 9, "at": at + 180000, "seq": 2, "gap_s": 180, "plan_s": 120}]}]},
                {"block": "B", "items": [{"ex": "plank", "sets": [{"seconds": 60, "at": at + 900000, "seq": 3, "gap_s": 720, "plan_s": 120}]}]}]}}])
        w = {"id": "2026-10-13T1800-traditional-strength-training", "name": "Traditional Strength Training", "date": "2026-10-13",
             "start": "18:00", "end": "18:40", "min": 40, "kcal": 210, "km": None, "avg_hr": 120, "max_hr": 150,
             "app": "2026-10-13T1800", "hr_ex": {"lat_pulldown": {"avg": 106, "max": 113}, "plank": {"avg": 130, "max": 135},
                                                 "db_curl": {"avg": 999, "max": 999}}}
        out = app_sync.apply_apple({"workouts": {w["id"]: w}, "days": {}})
        self.assertIn("Workout 2026-10-13 18:00: Heart rate (Watch), average / max: Lat Pulldown 106/113, Plank 130/135", out)
        rows = wl.load(wl.log_path())
        self.assertEqual([(r["exercise_id"], r["hr_avg"], r["hr_max"]) for r in rows],
                         [("lat_pulldown", "106", "113"), ("lat_pulldown", "106", "113"), ("plank", "130", "135")])
        self.assertEqual(app_sync.apply_apple({"workouts": {w["id"]: w}, "days": {}}), "")   # nothing new the second time
        self.assertIn("Lat Pulldown 106/113", wl.summary(rows, "2026-10-13T1800"))

    def test_apple_is_archived_and_scale_weight_never_overrides_a_manual_reading(self):
        wl.save(wl.body_path(), [{"date": "2026-10-09", "time": "07:00", "weight_kg": "80.0", "waist_cm": "",
                                  "source": "app", "notes": ""}], wl.BODY_FIELDS)
        apple = {"workouts": {"2026-10-09T1810-traditional-strength-training": {
                     "id": "2026-10-09T1810-traditional-strength-training", "name": "Traditional Strength Training",
                     "date": "2026-10-09", "start": "18:10", "end": "19:02", "min": 52, "kcal": 230, "km": None,
                     "avg_hr": 118, "max_hr": None}},
                 "days": {"2026-10-09": {"steps": 8123, "weight_kg": 79.9, "sleep_h": 6.9},
                          "2026-10-10": {"steps": 2040, "weight_kg": 79.7}}}
        self.assertIn("1 new workout(s), 2 day(s) updated, 1 scale reading(s)", app_sync.apply_apple(apple))
        self.assertEqual(app_sync.apply_apple(apple), "")            # nothing new the second time
        body = {r["date"]: r for r in wl.load(wl.body_path())}
        self.assertEqual(body["2026-10-09"]["weight_kg"], "80.0")    # the manual reading stays
        self.assertEqual(body["2026-10-10"]["source"], "apple")
        snap = app_sync.snapshot()
        self.assertEqual(snap["apple"]["workouts"]["2026-10-09T1810-traditional-strength-training"]["min"], 52)

    def test_meals_added_edited_and_deleted_from_the_app(self):
        base = {"date": "2026-10-10", "time": "12:30", "meal": "lunch", "desc": "Sliced fish soup + greens",
                "kcal": 330, "protein_g": 34, "carbs_g": 14, "fat_g": 11, "sat_fat_g": 3, "fibre_g": 3, "veg": 1.5, "fruit": 0}
        add = {"id": "1760090000002-0a1b2c3f", "kind": "meal_add", "data": base}
        out = app_sync.apply([add])
        self.assertIn("Logged from the app", out[0])
        self.assertEqual(app_sync.apply([add]), [])                        # dedup
        rows = app_sync.fl.load()
        self.assertEqual(len(rows), 1)
        eid = rows[0]["entry_id"]
        edit = {"id": "1760090000003-0a1b2c40", "kind": "meal_edit", "data": {"id": eid, "kcal": 400, "desc": "Fish soup, big bowl"}}
        self.assertIn("Edited in the app", app_sync.apply([edit])[0])
        rows = app_sync.fl.load()
        self.assertEqual((rows[0]["kcal"], rows[0]["description"], rows[0]["protein_g"]), ("400", "Fish soup, big bowl", "34"))
        dele = {"id": "1760090000004-0a1b2c41", "kind": "meal_delete", "data": {"id": eid}}
        self.assertIn("Deleted entry", app_sync.apply([dele])[0])
        self.assertEqual(app_sync.fl.load(), [])
        self.assertTrue({app_sync.ref_for(x) for x in (add, edit, dele)} <= app_sync.logged_refs())
        snap = app_sync.snapshot()
        self.assertTrue(snap["suggest"])

    def test_checklist_steps_and_daily_ticks(self):
        Path(os.environ["PLAN_JSON"]).write_text(json.dumps({"tasks": [{"id": "book_checkup", "title": "Book a check-up", "done": None}],
                                                            "habits": [{"id": "stretch", "title": "Stretch"}]}))
        out = app_sync.apply([{"id": "1760090000005-0a1b2c42", "kind": "plan_task", "data": {"id": "book_checkup", "done": True, "date": "2026-10-12"}},
                              {"id": "1760090000006-0a1b2c43", "kind": "habit", "data": {"date": "2026-10-12", "habit": "stretch", "done": True}},
                              {"id": "1760090000007-0a1b2c44", "kind": "habit", "data": {"date": "2026-10-12", "habit": "nonsense", "done": True}}])
        self.assertEqual(out, ["Checklist: done: Book a check-up", "Saved 1 checklist tick(s)."])
        plan = app_sync.plan_view(app_sync.date(2026, 10, 12))
        self.assertEqual(plan["tasks"][0]["done"], "2026-10-12")
        self.assertEqual(plan["log"], [{"date": "2026-10-12", "habit": "stretch"}])

    def test_an_empty_checklist_is_left_out_of_the_snapshot(self):
        Path(os.environ["PLAN_JSON"]).write_text('{"tasks": [], "habits": []}')
        self.assertIsNone(app_sync.snapshot(date(2026, 10, 12))["plan"])

    def test_oura_days_are_archived(self):
        oura = {"days": {"2026-10-09": {"sleep_h": 6.2, "bed": "01:40", "hrv": 38, "readiness": 62, "temp_dev": 0.4}}}
        self.assertEqual(app_sync.apply_oura(oura), "Oura: 1 day(s) updated")
        self.assertEqual(app_sync.apply_oura(oura), "")
        row = wl.load(app_sync.oura_path())[0]
        self.assertEqual((row["sleep_h"], row["bed"], row["readiness"]), ("6.2", "01:40", "62"))

    def test_ingest_key_matches_the_worker(self):
        # health/app/test/apple.test.mjs derives the same key in JS.
        self.assertEqual(len(app_sync.ingest_key(TOKEN)), 40)


if __name__ == "__main__":
    unittest.main()
