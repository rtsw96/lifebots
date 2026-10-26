"""Health settings (the onboarding's file) and the checklist. Run: python3 -m unittest discover -s health/foodbot"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Pinned: the tests use the neutral defaults (health_settings.DEFAULTS) and Asia/Singapore,
# never the settings files of whoever runs them.
os.environ["HEALTH_SETTINGS"] = str(HERE / "no-such-health-settings.json")
os.environ["SETTINGS_JSON"] = str(HERE / "no-such-settings.json")
sys.path.insert(0, str(HERE))

import health_settings as hs  # noqa: E402
import plan  # noqa: E402


def quiet(fn, *args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = fn(*args)
    return rc, out.getvalue() + err.getvalue()


class Settings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ["HEALTH_SETTINGS"]
        os.environ["HEALTH_SETTINGS"] = str(Path(self.tmp.name) / "settings.json")

    def tearDown(self):
        os.environ["HEALTH_SETTINGS"] = self.old
        self.tmp.cleanup()

    def arg(self, obj) -> str:
        p = Path(self.tmp.name) / "args.json"
        p.write_text(json.dumps(obj))
        return str(p)

    def test_defaults_until_onboarding(self):
        self.assertFalse(hs.load()["onboarded"])
        self.assertEqual(hs.targets()["kcal"], [1800, 2200])
        self.assertEqual(hs.water_ml(), 2000)
        self.assertEqual(str(hs.tz()), "Asia/Singapore")
        self.assertIn("onboarding hasn't run", hs.describe(hs.load()))

    def test_onboarding_saves_and_merges(self):
        rc, out = quiet(hs.main, ["set", "--args-json", self.arg({
            "onboarded": True, "goal": "lose", "diet": "vegetarian", "targets": {"kcal": [1600, 1800], "protein_g": [100, 120]},
            "water_ml": 2500, "steps": 7000, "weight_goal_kg": 70, "strength_days_per_week": 2})])
        self.assertEqual(rc, 0, out)
        s = hs.load()
        self.assertTrue(s["onboarded"])
        self.assertEqual(s["targets"]["kcal"], [1600, 1800])
        self.assertEqual(s["targets"]["fibre_g_min"], 30)          # untouched targets keep their default
        self.assertEqual(hs.steps_band(), [7000, 11000])
        self.assertEqual(hs.profile({"weekly_sets_per_muscle": [10, 16]})["strength_days_per_week"], 2)
        rc, _ = quiet(hs.main, ["set", "--args-json", self.arg({"water_ml": 3000})])
        self.assertEqual(hs.load()["targets"]["kcal"], [1600, 1800])  # a later change keeps the rest

    def test_odd_values_are_refused(self):
        for bad in ({"targets": {"kcal": [3000, 2000]}}, {"targets": {"kcal": 90000}}, {"water_ml": "lots"},
                    {"nonsense": 1}, {"targets": {"sugar": 1}}, {"goal": "bulk"}, {"debrief_at": "9pm"}):
            rc, out = quiet(hs.main, ["set", "--args-json", self.arg(bad)])
            self.assertEqual(rc, 2, bad)
            self.assertIn("error", out)
        self.assertFalse(Path(os.environ["HEALTH_SETTINGS"]).exists())


class Checklist(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("PLAN_JSON")
        os.environ["PLAN_JSON"] = str(Path(self.tmp.name) / "plan.json")
        Path(os.environ["PLAN_JSON"]).write_text('{"tasks": [], "habits": []}\n')

    def tearDown(self):
        if self.old is None:
            os.environ.pop("PLAN_JSON", None)
        else:
            os.environ["PLAN_JSON"] = self.old
        self.tmp.cleanup()

    def add(self, obj):
        p = Path(self.tmp.name) / "a.json"
        p.write_text(json.dumps(obj))
        return quiet(plan.main, ["add", "--args-json", str(p)])

    def test_add_tick_and_remove(self):
        self.assertEqual(self.add({"type": "daily", "title": "Stretch", "when": "evening"})[0], 0)
        self.assertEqual(self.add({"type": "daily", "title": "Stretch"})[0], 0)
        self.assertEqual(self.add({"type": "step", "title": "Book a check-up", "due": "2026-11-30"})[0], 0)
        p = plan.load()
        self.assertEqual([h["id"] for h in p["habits"]], ["stretch", "stretch_2"])
        self.assertEqual(p["tasks"][0]["done"], None)
        self.assertEqual(quiet(plan.main, ["done", "--id", "book_a_check_up"])[0], 0)
        self.assertTrue(plan.load()["tasks"][0]["done"])
        self.assertEqual(quiet(plan.main, ["remove", "--id", "stretch_2"])[0], 0)
        self.assertEqual(len(plan.load()["habits"]), 1)

    def test_doses_and_junk_are_refused(self):
        rc, out = self.add({"type": "daily", "title": "Vitamin D 1000 IU"})
        self.assertEqual(rc, 2)
        self.assertIn("doses", out)
        self.assertEqual(self.add({"type": "weekly", "title": "x"})[0], 2)
        self.assertEqual(self.add({"type": "step", "title": ""})[0], 2)
        self.assertEqual(plan.load(), {"tasks": [], "habits": []})


if __name__ == "__main__":
    unittest.main()
