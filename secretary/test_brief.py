"""Morning brief tests. Run: python3 -m unittest discover -s secretary"""

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import brief as B  # noqa: E402

TODAY = datetime.now(B.TZ).date()
D = TODAY.isoformat()
NEXT = (TODAY + timedelta(days=1)).isoformat()
PREV = (TODAY - timedelta(days=1)).isoformat()


def at(day: str, hhmm: str) -> str:
    """A local time in the owner's timezone, as the Worker sends it (ISO with offset)."""
    return datetime.fromisoformat(f"{day}T{hhmm}").replace(tzinfo=B.TZ).isoformat()


def ev(title, s, e, **kw):
    return {"id": title, "cal": "p", "title": title, "start": at(D, s), "end": at(D, e), "allDay": False, **kw}


EVENTS = [
    ev("Client call", "09:30", "10:00", loc="Online"),
    ev("Lunch — Sam", "12:00", "13:30"),
    ev("Project review", "13:00", "14:00"),          # clashes with lunch
    ev("Gym", "18:00", "19:15", free=True),          # marked free: listed, not counted
    ev("Dinner — Ben", "19:00", "21:00", declined=True),  # declined: left out
    {"id": "h", "cal": "h", "title": "Public Holiday", "start": D, "end": NEXT, "allDay": True},
    {"id": "t", "cal": "p", "title": "Late flight", "start": at(PREV, "23:30"), "end": at(D, "01:00"), "allDay": False},
    {"id": "n", "cal": "p", "title": "Team stand-up", "start": at(NEXT, "08:30"), "end": at(NEXT, "09:00"), "allDay": False},
]


class Brief(unittest.TestCase):
    def test_the_brief_lists_the_day_clashes_gaps_and_tomorrow(self):
        text = B.brief(EVENTS, TODAY)
        self.assertTrue(text.startswith(f"Good morning. {TODAY.strftime('%a %-d %b')}"))
        self.assertIn("Public holiday: Public Holiday", text)
        self.assertIn("4 events, 3.5h booked:", text)  # late flight, call, lunch, review; the gym is marked free
        self.assertIn("• …–01:00 Late flight", text)
        self.assertIn("• 09:30–10:00 Client call (Online)", text)
        self.assertIn("• 18:00–19:15 Gym (marked free)", text)
        self.assertNotIn("Dinner — Ben", text)
        self.assertIn("Clash: Lunch — Sam (12:00) overlaps Project review (13:00)", text)
        self.assertIn("Open: 08:00–09:30, 10:00–12:00, 14:00–22:30", text)
        self.assertIn("Tomorrow starts 08:30: Team stand-up", text)

    def test_an_empty_day(self):
        text = B.brief([], TODAY)
        self.assertIn("Nothing in the calendar today.", text)
        self.assertNotIn("Open:", text)

    def test_due_wakes_the_bot_at_eight_once_a_day(self):
        def local(hh, mm):
            return datetime(TODAY.year, TODAY.month, TODAY.day, hh, mm, tzinfo=B.TZ)
        with tempfile.TemporaryDirectory() as d:
            os.environ["SECRETARYBOT_HOME"] = d
            try:
                self.assertEqual(B.due_in(local(7, 0)), 3600)
                self.assertEqual(B.due_in(local(8, 20)), 0)
                # a run starting at noon doesn't send a late "good morning": next one is tomorrow 08:00
                self.assertEqual(B.due_in(local(12, 3)), 19 * 3600 + 57 * 60)
                (Path(d) / "brief_sent").write_text(D)
                self.assertEqual(B.due_in(local(8, 20)), 23 * 3600 + 40 * 60)
            finally:
                os.environ.pop("SECRETARYBOT_HOME", None)


if __name__ == "__main__":
    unittest.main()
