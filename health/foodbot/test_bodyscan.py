"""Tests for body-composition scans. Run: python3 -m unittest discover -s health/foodbot"""

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

import bodyscan  # noqa: E402
import workoutlog as wl  # noqa: E402

# Synthetic readings, not anyone's scan.
AUG = {"date": "2026-03-02", "time": "07:00", "device": "Scanner A", "weight_kg": 80.0, "body_fat_pct": 24.0,
       "body_fat_kg": 19.2, "skeletal_muscle_kg": 34.0, "visceral_fat_level": 9, "waist_cm": 90.0}


class BodyScans(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.env = {"BODY_SCAN_CSV": str(d / "scans.csv"), "BODY_CSV": str(d / "body.csv")}
        self.old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_a_scan_is_logged_once_and_is_the_days_weigh_in(self):
        row, rows = bodyscan.add(AUG, ref="42")
        self.assertEqual((row["weight_kg"], row["visceral_fat_level"], row["ref"]), (80, 9, "42"))
        self.assertEqual(bodyscan.add(AUG)[0], None)   # the same scan again: skipped
        self.assertEqual(len(bodyscan.load()), 1)
        body = wl.load(wl.body_path())
        self.assertEqual([(b["date"], b["weight_kg"], b["waist_cm"], b["source"]) for b in body], [("2026-03-02", "80", "90", "scan")])

    def test_compare_shows_change_since_the_last_and_the_first_scan_on_the_same_device(self):
        bodyscan.add(AUG)
        bodyscan.add({**AUG, "date": "2026-04-01", "weight_kg": 79.5, "body_fat_pct": 23.4, "skeletal_muscle_kg": 34.3})
        bodyscan.add({"date": "2026-04-10", "device": "Scanner B", "weight_kg": 78.0, "body_fat_pct": 21.0})
        _, rows = bodyscan.add({**AUG, "date": "2026-05-01", "weight_kg": 79.2, "body_fat_pct": 22.9, "skeletal_muscle_kg": 34.6})
        out = bodyscan.compare(rows)
        self.assertIn("Scan 2026-05-01 07:00 (Scanner A)", out)
        self.assertIn("Body fat: 22.9 %; -0.5 % (better) since 2026-04-01; -1.1 % (better) since 2026-03-02", out)
        self.assertIn("Skeletal muscle: 34.6 kg; +0.3 kg (better) since 2026-04-01", out)
        self.assertNotIn("2026-04-10", out)   # another machine's reading isn't compared

    def test_the_cli_reads_the_scan_from_a_file(self):
        import io
        from contextlib import redirect_stdout
        f = Path(self.tmp.name) / "scan.json"
        f.write_text('{"date": "2026-03-02", "time": "07:00", "device": "Scanner A", "weight_kg": 80.0}')
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(bodyscan.main(["add", "--json-file", str(f), "--ref", "7"]), 0)
        self.assertIn("Weight: 80 kg", out.getvalue())

    def test_readings_are_checked(self):
        with self.assertRaisesRegex(ValueError, "Body fat 199"):
            bodyscan.clean({"date": "2026-05-01", "body_fat_pct": 199})
        with self.assertRaisesRegex(ValueError, "at least the weight"):
            bodyscan.clean({"date": "2026-05-01", "device": "Scanner A"})
        with self.assertRaisesRegex(ValueError, "date"):
            bodyscan.clean({"weight_kg": 80})


if __name__ == "__main__":
    unittest.main()
