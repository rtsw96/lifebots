"""Untrusted text reaches the scripts through files, never the shell."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import argfile  # noqa: E402

EVIL = "$(touch PWNED) `touch PWNED2` \"; touch PWNED3; '"


class ExpandTest(unittest.TestCase):
    def write(self, obj):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(obj, f)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_options_flags_lists(self):
        p = self.write({"desc": "-5% off", "logged_by": EVIL, "prorate": True, "multi": False,
                        "option": ["A", "B"], "amount": 8400, "note": None})
        out = argfile.expand(["add", "--chat", "1", "--args-json", p])
        self.assertEqual(out, ["add", "--chat", "1", "--desc=-5% off", f"--logged-by={EVIL}",
                               "--prorate", "--option=A", "--option=B", "--amount=8400"])

    def test_bad_input_refused(self):
        for obj in ({"--chat": "x"}, {"a b": 1}, ["x"], {"x": {"y": 1}}):
            with self.assertRaises(SystemExit):
                argfile.expand(["--args-json", self.write(obj)])
        with self.assertRaises(SystemExit):
            argfile.expand(["--args-json"])

    def test_no_args_json_is_unchanged(self):
        self.assertEqual(argfile.expand(["list", "--chat", "1"]), ["list", "--chat", "1"])


class EndToEnd(unittest.TestCase):
    """A hostile display name and description go through splitlog.py add untouched and inert."""

    def test_splitlog_add_with_hostile_text(self):
        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, "SPLIT_DATA": str(Path(d) / "data"), "SPLITBOT_HOME": str(Path(d) / "home"),
                   "SPLIT_OWNER_ID": "1"}
            run = lambda *a: subprocess.run([sys.executable, str(HERE / "splitlog.py"), *a], cwd=d, env=env,
                                            capture_output=True, text=True, timeout=60)
            args = Path(d) / "args.json"
            r = run("list", "--chat", "-100", "--args-json", str(Path(d) / "missing.json"))
            self.assertNotEqual(r.returncode, 0)  # an unreadable args file is refused
            args.write_text(json.dumps({"name": "Trip", "currency": "SGD", "members": "Ana:1:ana,Ben"}))
            r = run("trip", "new", "--chat", "-100", "--args-json", str(args))
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            args.write_text(json.dumps({"desc": EVIL, "logged_by": EVIL, "category": "other"}))
            r = run("add", "--chat", "-100", "--payer", "1", "--amount", "10", "--fx", "1",
                    "--update-id", "7", "--args-json", str(args))
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            self.assertFalse(any(Path(d).glob("PWNED*")))
            r = run("list", "--chat", "-100")
            self.assertIn("touch PWNED", r.stdout)


if __name__ == "__main__":
    unittest.main()
