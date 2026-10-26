"""Reminder tests. Run: python3 -m unittest discover -s secretary"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "bot"))
import remind as R  # noqa: E402

# "Now" is 12:50 local time on the coming Friday, so weekday repeats are predictable.
_t = datetime.now(R.TZ).date()
FRI = _t + timedelta(days=(4 - _t.weekday()) % 7)
MON = FRI + timedelta(days=3)
THU = FRI - timedelta(days=1)


def at(day, hh, mm, ss=0):
    return datetime(day.year, day.month, day.day, hh, mm, ss, tzinfo=R.TZ)


NOW = at(FRI, 12, 50)
F = FRI.strftime("%a %-d %b")  # e.g. "Fri 30 Oct"


class Reminders(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"SECRETARY_REMINDERS": str(Path(self.tmp.name) / "reminders.csv")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_parse_times(self):
        self.assertEqual(R.parse_at(f"{FRI} 16:00", NOW), at(FRI, 16, 0))
        self.assertEqual(R.parse_at("+30m", NOW), at(FRI, 13, 20))
        self.assertEqual(R.parse_at("+2h", NOW).hour, 14)
        self.assertEqual(R.parse_at("16:00", NOW).date(), FRI)       # later today
        self.assertEqual(R.parse_at("09:00", NOW).date(), FRI + timedelta(days=1))  # passed: tomorrow
        utc = at(FRI, 16, 0).astimezone(timezone.utc).isoformat()
        self.assertEqual(R.parse_at(utc, NOW), at(FRI, 16, 0))  # any offset in, local time out

    def test_one_off_is_sent_once_at_its_time(self):
        R.add("Renew the passport", at(FRI, 16, 0), now=NOW)
        self.assertEqual(R.due_in(NOW), 3 * 3600 + 10 * 60)
        got = []
        self.assertEqual(R.send_due(NOW, lambda t: got.append(t) or True), [])
        sender = lambda t: got.append(t) or True  # noqa: E731
        sent = R.send_due(at(FRI, 16, 0, 30), sender)
        self.assertEqual([r["id"] for r in sent], ["r1"])
        self.assertEqual(got, ["⏰ Renew the passport"])
        self.assertEqual(R.send_due(at(FRI, 17, 0), sender), [])
        self.assertEqual(R.load()[0]["status"], "sent")
        self.assertEqual(R.due_in(NOW), R.IDLE)

    def test_a_failed_send_stays_pending(self):
        R.add("Call the bank", NOW, now=NOW)
        self.assertEqual(R.send_due(NOW, lambda t: False), [])
        self.assertEqual(R.load()[0]["status"], "pending")
        self.assertEqual(R.due_in(NOW), 0)

    def test_late_reminders_say_so(self):
        R.add("Pay the card", at(FRI, 0, 0), now=at(THU, 9, 0))
        got = []
        R.send_due(NOW, lambda t: got.append(t) or True)
        self.assertIn(f"due {F}, 00:00; I was offline then", got[0])

    def test_weekdays_repeat_skips_the_weekend(self):
        R.add("Stand-up notes", at(FRI, 9, 0), "weekdays", now=NOW)
        got = []
        R.send_due(at(FRI, 9, 1), lambda t: got.append(t) or True)
        r = R.load()[0]
        self.assertEqual((r["status"], r["due"]), ("pending", R._iso(at(MON, 9, 0))))  # Monday
        self.assertIn('Reply "stop r1"', got[0])

    def test_cli_add_list_snooze_cancel(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(R, "datetime", wraps=datetime) as dt:
            dt.now.return_value = NOW
            self.assertEqual(R.main(["add", "--at", f"{FRI} 16:00", "Renew", "the", "passport"]), 0)
            self.assertEqual(R.main(["list"]), 0)
            self.assertEqual(R.main(["snooze", "r1", "--minutes", "15"]), 0)
            self.assertEqual(R.main(["cancel", "r1"]), 0)
            self.assertEqual(R.main(["add", "--at", f"{FRI} 09:00", "too", "late"]), 1)
        text = out.getvalue()
        self.assertIn(f"Reminder r1 set for {F}, 16:00: Renew the passport", text)
        self.assertIn(f"r1  {F}, 16:00  Renew the passport", text)
        self.assertIn(f"Snoozed r1: again at {F}, 13:05", text)
        self.assertIn("Cancelled r1", text)
        self.assertIn("has passed", text)
        self.assertEqual(R.pending(), [])

    def test_text_from_a_file_is_taken_as_is(self):
        f = Path(self.tmp.name) / "text.txt"
        f.write_text("Call Ben; rm -rf / $(whoami) 'quoted'\n", encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(R, "datetime", wraps=datetime) as dt:
            dt.now.return_value = NOW
            self.assertEqual(R.main(["add", "--at", f"{FRI} 16:00", "--text-file", str(f)]), 0)
            self.assertEqual(R.main(["add", "--at", f"{FRI} 16:00"]), 1)  # no text at all
        self.assertEqual(R.load()[0]["text"], "Call Ben; rm -rf / $(whoami) 'quoted'")


class Listener(unittest.TestCase):
    def test_listener_sends_due_reminders_and_exits_5(self):
        import listen as L
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {
                "SECRETARY_BOT_TOKEN": "x", "OWNER_TELEGRAM_ID": "111", "SECRETARYBOT_HOME": d,
                "SECRETARY_REMINDERS": str(Path(d) / "reminders.csv")}):
            now = datetime.now(R.TZ)
            R.add("Renew the passport", now - timedelta(minutes=1), now=now - timedelta(hours=1))
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(R, "send_text", return_value=True), \
                    mock.patch.object(L, "curl_json", side_effect=AssertionError("polled before sending")):
                code = L.main(["60"])
            self.assertEqual(code, 5)
            self.assertIn("=== REMINDERS SENT ===", out.getvalue())
            self.assertIn('"id": "r1"', out.getvalue())


if __name__ == "__main__":
    unittest.main()
