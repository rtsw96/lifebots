"""Secretary app sync tests. Run: python3 -m unittest discover -s secretary"""

import csv
import json
import re
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sync  # noqa: E402

TOKEN = "123456:TEST-token_for-vectors"
TODAY = date.today()


def d(n: int) -> str:
    """The date n days from today."""
    return (TODAY + timedelta(days=n)).isoformat()


class Sign(unittest.TestCase):
    def test_signature_matches_the_worker(self):
        # secretary/app/test/worker.test.mjs checks the same vector
        body = b'{"op":"events","ts":"2026-01-01T00:00:00+00:00"}'
        self.assertEqual(sync.sign(TOKEN, body), "b80646d30462508391b47838412c9a04f755891e40b60b2a632632b14c4444f5")


class Health(unittest.TestCase):
    def write(self, folder: Path, name: str, rows: list):
        with (folder / name).open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)

    def test_oura_beats_apple_and_only_summaries_go(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t)
            self.write(f, "daily_metrics.csv", [
                {"date": d(-2), "steps": "9000", "resting_hr": "55", "sleep_h": "6.1", "bed": "01:10", "wake": "07:40", "weight_kg": "80"},
                {"date": d(-1), "steps": "9000", "resting_hr": "55", "sleep_h": "7.0", "bed": "00:05", "wake": "07:30", "weight_kg": ""},
                {"date": d(-200), "steps": "1", "resting_hr": "", "sleep_h": "8", "bed": "", "wake": "", "weight_kg": ""}])
            self.write(f, "oura_daily.csv", [
                {"date": d(-1), "sleep_score": "80", "sleep_h": "6.8", "bed": "23:58", "wake": "07:31", "hrv": "40"},
                {"date": d(0), "sleep_score": "", "sleep_h": "", "bed": "", "wake": "", "hrv": ""}])
            self.write(f, "activity_log.csv", [
                {"id": "x", "date": d(-2), "start": "19:35", "end": "20:33", "name": "Traditional Strength Training", "min": "58", "kcal": "255"},
                {"id": "y", "date": d(-2), "start": "", "end": "", "name": "No time", "min": "10", "kcal": "1"}])
            log = [  # the 19:35 session is on the Watch; the two the next day aren't
                {"workout_id": "a", "date": d(-2), "time": "19:35", "exercise_id": "db_row", "reps": "10", "weight_kg": "20"},
                {"workout_id": "b", "date": d(-1), "time": "07:00", "exercise_id": "run", "seconds": "1500", "distance_km": "5"},
                {"workout_id": "c", "date": d(-1), "time": "18:00", "exercise_id": "db_squat", "reps": "8", "weight_kg": "18"}]
            cols = ["workout_id", "date", "time", "exercise_id", "reps", "weight_kg", "seconds", "distance_km"]
            self.write(f, "workout_log.csv", [{k: r.get(k, "") for k in cols} for r in log])
            h = sync.health(TODAY, f)
        self.assertEqual(h["days"][d(-1)], {"sleep_h": 6.8, "bed": "23:58", "wake": "07:31", "src": "oura"})
        self.assertEqual(h["days"][d(-2)]["src"], "apple")
        self.assertNotIn(d(-200), h["days"])  # older than 120 days
        self.assertNotIn(d(0), h["days"])  # no sleep recorded
        self.assertEqual(h["workouts"], [{"date": d(-2), "start": "19:35", "end": "20:33", "name": "Traditional Strength Training", "min": 58},
                                         {"date": d(-1), "start": "07:00", "end": None, "name": "Run or ride (logged)", "min": 25},
                                         {"date": d(-1), "start": "18:00", "end": None, "name": "Strength (logged)", "min": 60}])
        text = json.dumps(h)
        for leak in ("steps", "resting_hr", "hrv", "weight", "kcal", "sleep_score"):
            self.assertNotIn(leak, text)

    def test_without_the_health_bot_there_is_simply_no_sleep_or_workouts(self):
        with tempfile.TemporaryDirectory() as t:
            h = sync.health(TODAY, Path(t) / "health")  # the folder doesn't even exist
        self.assertEqual((h["days"], h["workouts"]), ({}, []))

    def test_payload_has_rules_targets_and_settings(self):
        p = sync.payload(TODAY)
        self.assertTrue(p["rules"]["rules"])
        self.assertIn("sleep_h_per_night", p["targets"])
        for r in p["rules"]["rules"]:
            re.compile(r["match"])  # every pattern is valid
        self.assertEqual(set(p["settings"]), {"timezone", "currency", "holidays"})
        self.assertRegex(p["settings"]["currency"], r"^[A-Z]{3}$")

    def test_holiday_calendar_names(self):
        self.assertEqual(sync.holiday_calendar(""), "")
        self.assertEqual(sync.holiday_calendar("usa"), "en.usa#holiday@group.v.calendar.google.com")
        self.assertEqual(sync.holiday_calendar("Hong Kong"), "en.hong_kong#holiday@group.v.calendar.google.com")
        full = "en.uk#holiday@group.v.calendar.google.com"
        self.assertEqual(sync.holiday_calendar(full), full)

    def test_settings_come_from_settings_json(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "settings.json"
            f.write_text(json.dumps({"timezone": "Europe/London", "home_currency": "gbp", "holiday_calendar": "uk"}))
            with mock.patch.dict("os.environ", {"SETTINGS_JSON": str(f)}):
                self.assertEqual(sync.app_settings(), {"timezone": "Europe/London", "currency": "GBP",
                                                       "holidays": "en.uk#holiday@group.v.calendar.google.com"})

    def test_calendar_calls_take_their_fields_from_a_file(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "ev.json"
            f.write_text(json.dumps({"title": "Dinner — Sam; $(x)", "date": d(2), "start": "19:00", "minutes": 90, "op": "remove"}))
            sent = {}
            with mock.patch.object(sync, "config", return_value={"url": "https://x"}), \
                    mock.patch.object(sync, "token", return_value=TOKEN), \
                    mock.patch.object(sync, "post", side_effect=lambda cfg, tok, path, obj: sent.update(path=path, **obj) or {"ok": True}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(sync.main(["add", "--args-json", str(f)]), 0)
        self.assertEqual(sent["path"], "/api/add")
        self.assertEqual(sent["op"], "add")  # the command decides the call, not the file
        self.assertEqual(sent["title"], "Dinner — Sam; $(x)")

    def test_not_configured_is_quiet(self):
        with mock.patch.object(sync, "config", return_value=None):
            self.assertEqual(sync.main(["push"]), 0)


if __name__ == "__main__":
    unittest.main()
