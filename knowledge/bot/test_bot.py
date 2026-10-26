"""Tests for the KnowledgeBot plumbing. Run: python3 -m unittest discover -s knowledge/bot"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

NOTE = """---
type: concept
created: 2026-01-05
updated: 2026-01-05
status: draft
mocs:
  - "[[Astronomy Basics]]"
sources:
  - "[[raw/2026-01-04_planetarium_talk]]"
tags:
  - astronomy/earth
---
# Seasons come from axial tilt

> [!review] Borderline: one source.
> Check against a textbook.

Claim. The tilt changes how directly sunlight hits each hemisphere.
"""
PATH = "concepts/astronomy/Seasons come from axial tilt.md"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.vault, self.data, self.home = d / "vault", d / "data", d / "home"
        self.learn = d / "learn"
        for sub in ("concepts/astronomy", "raw", "To be filed"):
            (self.vault / sub).mkdir(parents=True)
        (self.vault / PATH).write_text(NOTE)
        self.learn.mkdir()
        (self.learn / "tracks.json").write_text('{"tracks": []}')
        self.env = {"KNOWLEDGE_VAULT": str(self.vault), "KNOWLEDGE_DATA": str(self.data), "KNOWLEDGEBOT_HOME": str(self.home),
                    "KNOWLEDGE_LEARN": str(self.learn)}
        self.old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        for m in ("kb", "app_sync"):
            sys.modules.pop(m, None)

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()


class Threads(Base):
    def test_a_thread_is_filed_verbatim_once(self):
        import kb
        tid = kb.new_thread("Why is the sky blue?")
        kb.add(tid, "a", "Air molecules scatter short (blue) wavelengths more than long ones: Rayleigh scattering.")
        kb.add(tid, "q", "And why are sunsets red?")
        raw = kb.file_thread(tid)
        self.assertTrue(raw.name.startswith(f"{datetime.now(kb.TZ).date().isoformat()}_qa_why_is_the_sky_blue"))
        text = raw.read_text()
        self.assertIn("## Answer", text)
        self.assertIn("And why are sunsets red?", text)
        self.assertEqual(kb.file_thread(tid), raw)  # filing twice: same file
        self.assertIn(f"- Filed: raw/{raw.name}", kb.thread_path(tid).read_text())
        self.assertEqual(kb.prune(0), 0)  # filed threads are kept

    def test_unfiled_threads_are_pruned(self):
        import kb
        tid = kb.new_thread("Old question")
        p = kb.thread_path(tid)
        p.rename(p.with_name("t20200101000000.md"))
        self.assertEqual(kb.prune(30), 1)

    def test_reminder_and_status(self):
        import kb
        t = datetime(2026, 1, 14, 19, 0, tzinfo=kb.TZ)
        p = {"settings": {"remind": "20:00"}, "xp": {}, "streak": {"count": 3, "last": "2026-01-13"}, "cards": {"a": {"due": 0}}, "lessons": {"x": {}}}
        self.assertEqual(kb.remind_in(p, t), 3600)
        self.assertEqual(kb.remind_in(p, t.replace(hour=21)), 0)
        self.assertEqual(kb.remind_in({**p, "xp": {"2026-01-14": 20}}, t), -1)  # studied today
        self.assertIn("No topics yet", kb.status(p, t))  # a fresh install: ask what to learn
        (self.learn / "tracks.json").write_text('{"tracks": [{"id": "spanish", "name": "Spanish", "lang": "es"}]}')
        self.assertIn("Streak 3 day(s) · XP today 0/60 · 1 review(s) due", kb.status(p, t))
        self.assertEqual(kb.tracks()[0]["id"], "spanish")

    def test_speaking_language_is_any_code(self):
        import kb
        kb.main(["lang", "es"])
        self.assertEqual((self.home / "stt_lang").read_text(), "es")
        with self.assertRaises(SystemExit):
            kb.main(["lang", "rm -rf"])


class Queue(Base):
    def test_approving_marks_reviewed_and_clears_the_flag(self):
        import app_sync
        lines, done = app_sync.apply([{"id": "1", "kind": "note_status", "data": {"path": PATH, "status": "reviewed"}}], self.vault)
        text = (self.vault / PATH).read_text()
        self.assertIn("status: reviewed", text)
        self.assertNotIn("[!review]", text)
        self.assertNotIn("Check against a textbook", text)
        self.assertIn("Claim. The tilt changes", text)
        self.assertIn("(review flag cleared)", lines[0])
        self.assertEqual(done, ["1"])

    def test_edits_check_the_base_and_paths_are_fenced(self):
        import hashlib
        import app_sync
        p = self.vault / PATH
        base = hashlib.sha1(p.read_bytes()).hexdigest()[:12]
        lines, _ = app_sync.apply([{"id": "1", "kind": "note_edit", "data": {"path": PATH, "base": "000000000000", "text": "---\nx\n---\n"}}], self.vault)
        self.assertTrue(lines[0].startswith("CONFLICT"))
        lines, _ = app_sync.apply([{"id": "2", "kind": "note_edit", "data": {"path": PATH, "base": base, "text": NOTE.replace("each hemisphere", "each hemisphere over the year")}}], self.vault)
        self.assertIn("over the year", p.read_text())
        for bad in ("raw/2026-01-04_planetarium_talk.md", "concepts/../CLAUDE.md", "CLAUDE.md"):
            lines, _ = app_sync.apply([{"id": "3", "kind": "note_status", "data": {"path": bad, "status": "reviewed"}}], self.vault)
            self.assertTrue(lines[0].startswith("Skipped"), bad)

    def test_capture_and_requests(self):
        import app_sync
        lines, done = app_sync.apply([
            {"id": "1", "kind": "capture", "data": {"title": "Sourdough notes", "text": "Starter ratios…"}},
            {"id": "2", "kind": "ask", "data": {"q": "What is a leap year?", "path": None}},
            {"id": "3", "kind": "curriculum", "data": {"track": "spanish", "band": 3, "label": "B2"}},
            {"id": "4", "kind": "topic", "data": {"text": "Spanish for a trip", "level": "beginner"}},
        ], self.vault)
        self.assertTrue(lines[0].startswith("CAPTURED: To be filed/"))
        self.assertTrue(any(p.name.endswith("_sourdough_notes.md") for p in (self.vault / "To be filed").iterdir()))
        self.assertTrue(lines[1].startswith("ASK: "))
        self.assertTrue(lines[2].startswith("CURRICULUM: "))
        self.assertTrue(lines[3].startswith("TOPIC: ") and "Spanish for a trip" in lines[3])
        self.assertEqual(done, ["1", "2", "3", "4"])

    def test_the_vault_bundle_reads_frontmatter(self):
        import app_sync
        b = app_sync.vault_bundle(self.vault)
        n = b["notes"][0]
        self.assertEqual((n["ty"], n["st"], n["mocs"], n["src"], n["tags"]), ("concept", "draft", ["Astronomy Basics"], ["raw/2026-01-04_planetarium_talk"], ["astronomy/earth"]))
        self.assertTrue(n["b"].startswith("# Seasons come"))
        blob, ver = app_sync.pack(b)
        self.assertEqual(app_sync.pack({**b, "built": "later"})[1], ver)  # the version ignores the build time

    def test_a_fresh_install_has_an_empty_vault_and_no_tracks(self):
        import app_sync
        empty = Path(self.tmp.name) / "empty"
        (empty / "raw").mkdir(parents=True)
        (empty / "CLAUDE.md").write_text("rules")
        self.assertEqual(app_sync.vault_bundle(empty)["notes"], [])
        lb = app_sync.learn_bundle(self.learn)
        self.assertEqual((lb["tracks"], lb["units"], lb["placement"]), ([], {}, {}))
        self.assertTrue(lb["tz"])  # the app counts days in the user's timezone


class Send(unittest.TestCase):
    def test_the_app_button_needs_telegram_sign_in_so_groups_get_a_t_me_link(self):
        import send
        cfg = {"url": "https://knowledge-app.example.com", "bot_username": "ExampleKnowledgeBot"}
        self.assertEqual(send.app_button("App", True, cfg), {"text": "App", "web_app": {"url": cfg["url"]}})
        self.assertEqual(send.app_button("App", False, cfg), {"text": "App", "url": "https://t.me/ExampleKnowledgeBot?startapp"})
        self.assertIsNone(send.app_button("App", False, {"url": cfg["url"]}))


class Validate(Base):
    def run_validate(self, *args):
        import contextlib, io
        sys.path.insert(0, str(HERE.parent / "learn"))
        import validate
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = validate.main(list(args))
        return rc, out.getvalue()

    def test_an_empty_install_and_the_fixture_pass_and_a_bad_track_fails(self):
        rc, out = self.run_validate("--root", str(self.learn), "--no-dict")
        self.assertEqual((rc, "no tracks yet" in out), (0, True))
        rc, out = self.run_validate("--root", str(HERE.parent / "app" / "preview" / "fixture" / "learn"), "--no-dict")
        self.assertEqual(rc, 0, out)
        bad = self.learn / "Bad" / "units"
        (self.learn / "tracks.json").write_text('{"tracks": [{"id": "Bad", "name": "x", "short": "x", "about": "x"}]}')
        bad.mkdir(parents=True)
        (bad / "01-a.json").write_text('{"id": "Bad-01", "title": "t", "level": "l", "goal": "g", "lessons": [{"id": "l1", "title": "t", "cards": ["c1"]}], '
                                       '"cards": [{"id": "c1", "kind": "concept", "explain": "x", "questions": [], "sources": []}]}')
        rc, out = self.run_validate("--root", str(self.learn), "--no-dict")
        self.assertEqual(rc, 1)
        self.assertIn("2-12 lower-case letters", out)
        self.assertIn("needs a source with a url", out)


class Listener(Base):
    def test_taps_and_files_only_from_the_owner(self):
        import listen
        cfg = {}
        own = {"chat": {"id": 111, "type": "private"}, "from": {"id": 111}}
        resp = {"ok": True, "result": [
            {"update_id": 1, "callback_query": {"id": "cb1", "data": "file:t20260114090000", "from": {"id": 111}, "message": {"message_id": 50, **own}}},
            {"update_id": 2, "callback_query": {"id": "cb2", "data": "file:x", "from": {"id": 222}, "message": {"message_id": 51, **own}}},
            {"update_id": 3, "message": {"message_id": 52, **own, "document": {"file_id": "F", "file_name": "notes.pdf", "file_size": 1000}, "caption": "file this"}},
            {"update_id": 4, "message": {"message_id": 53, "chat": {"id": 222, "type": "private"}, "from": {"id": 222}, "text": "hi"}},
        ]}
        nxt, evs = listen.parse_updates(resp, "111", cfg)
        self.assertEqual(nxt, 5)
        self.assertEqual([e["update_id"] for e in evs], [1, 3])
        self.assertEqual(evs[0]["callback"], "file:t20260114090000")
        self.assertEqual((evs[1]["file_id"], evs[1]["file_name"], evs[1]["text"]), ("F", "notes.pdf", "file this"))


if __name__ == "__main__":
    unittest.main()
