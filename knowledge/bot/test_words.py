"""Tests for Your words (words.py). Run: python3 -m unittest discover -s knowledge/bot"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def card(cid, text, kind="word", words=None):
    c = {"id": cid, "kind": kind, "lang": "zh", "text": text}
    if words:
        c["words"] = [{"text": w} for w in words]
    return c


class YourWords(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data, self.learn = root / "data", root / "learn"
        self.units = self.learn / "zh" / "units"
        self.data.mkdir()
        self.units.mkdir(parents=True)
        (self.learn / "tracks.json").write_text(json.dumps({"tracks": [
            {"id": "zh", "name": "Chinese", "short": "Chinese", "lang": "zh", "about": "x"},
            {"id": "spanish", "name": "Spanish", "short": "Spanish", "lang": "es", "about": "x"}]}))
        os.environ["KNOWLEDGE_DATA"], os.environ["KNOWLEDGE_LEARN"] = str(self.data), str(self.learn)
        import importlib
        import words
        self.z = importlib.reload(words)
        self.unit("01-greetings.json", {"id": "zh-01", "strand": "side",
                  "cards": [card("zh-w-你好", "你好")], "lessons": [{"id": "zh-01-1", "cards": ["zh-w-你好"]}]})
        self.unit("02-characters.json", {"id": "zh-02",
                  "cards": [card("zh-c-的", "的", "char", ["目的"])], "lessons": [{"id": "zh-02-1", "cards": ["zh-c-的"]}]})

    def tearDown(self):
        self.tmp.cleanup()
        for k in ("KNOWLEDGE_DATA", "KNOWLEDGE_LEARN"):
            os.environ.pop(k, None)

    def unit(self, name, u, track="zh"):
        d = self.learn / track / "units"
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(json.dumps(u, ensure_ascii=False))

    def pending(self, *ws, track="zh"):
        self.z.save(track, {"words": [{"text": w, "added": "2026-01-05", "status": "pending"} for w in ws]})

    def test_taught_finds_cards_and_the_words_on_char_cards(self):
        t = self.z.taught("zh")
        self.assertEqual(t["你好"], ("zh-01-1", "word card"))
        self.assertEqual(t["目的"][0], "zh-02-1")

    def test_one_word_waits_two_start_the_first_your_words_unit(self):
        self.pending("天气")
        self.assertEqual(self.z.plan("zh", done=set())["action"], "wait")
        self.pending("天气", "预报")
        p = self.z.plan("zh", done=set())
        self.assertEqual((p["action"], p["unit"], p["lesson"]), ("new-unit", "zh-900", "zh-900-1"))
        self.assertTrue(p["file"].endswith("900-your-words.json"))

    def test_an_unopened_lesson_takes_words_until_it_has_ten(self):
        ids = [f"zh-m-{i}" for i in range(8)]
        self.unit("900-your-words.json", {"id": "zh-900", "strand": "mine", "cards": [card(i, i) for i in ids],
                                           "lessons": [{"id": "zh-900-1", "cards": ids}]})
        self.pending("天气", "预报", "下雨")
        p = self.z.plan("zh", done=set())
        self.assertEqual((p["action"], p["lesson"], p["words"]), ("append", "zh-900-1", ["天气", "预报"]))

    def test_a_done_lesson_is_never_added_to(self):
        self.unit("900-your-words.json", {"id": "zh-900", "strand": "mine", "cards": [card("zh-m-a", "a"), card("zh-m-b", "b")],
                                           "lessons": [{"id": "zh-900-1", "cards": ["zh-m-a", "zh-m-b"]}]})
        self.pending("天气", "预报")
        p = self.z.plan("zh", done={"zh-900-1"})
        self.assertEqual((p["action"], p["lesson"]), ("new-lesson", "zh-900-2"))
        self.pending("天气")
        self.assertEqual(self.z.plan("zh", done={"zh-900-1"})["action"], "wait")

    def test_a_full_unit_starts_the_next_free_number(self):
        lessons = [{"id": f"zh-900-{k}", "cards": ["zh-m-a", "zh-m-b"]} for k in range(1, 7)]
        self.unit("900-your-words.json", {"id": "zh-900", "strand": "mine", "cards": [card("zh-m-a", "a"), card("zh-m-b", "b")], "lessons": lessons})
        self.unit("901-something-else.json", {"id": "zh-901", "strand": "side", "cards": [], "lessons": []})
        self.pending("天气", "预报")
        p = self.z.plan("zh", done={l["id"] for l in lessons})
        self.assertEqual((p["action"], p["unit"]), ("new-unit", "zh-902"))
        self.assertTrue(p["file"].endswith("902-your-words-2.json"))

    def test_filed_marks_a_waiting_word(self):
        self.pending("天气")
        self.assertTrue(self.z.filed("zh", "天气", "zh-m-天气", "zh-900-1"))
        self.assertFalse(self.z.filed("zh", "天气", "zh-m-天气", "zh-900-1"))
        self.assertEqual(self.z.load("zh")["words"][0]["status"], "filed")
        self.assertEqual(self.z.plan("zh", done=set())["action"], "nothing")

    def test_any_language_track_collects_words_and_tracks_are_kept_apart(self):
        lines = self.z.add("spanish", ["reunión", "reunión", "  "], today="2026-01-05")
        self.assertEqual(lines, ["reunión: added"])
        self.assertEqual(self.z.load("zh")["words"], [])
        self.assertEqual([w["text"] for w in self.z.load("spanish")["words"]], ["reunión"])
        stored = json.loads((self.data / "words.json").read_text())
        self.assertEqual(set(stored), {"spanish"})
        self.assertEqual(set(stored["spanish"]["words"][0]), {"text", "added", "status"})  # words only
        self.pending("mesa", "silla", track="spanish")
        p = self.z.plan("spanish", done=set())
        self.assertEqual((p["action"], p["unit"]), ("new-unit", "spanish-900"))
        with self.assertRaises(SystemExit):
            self.z.add("nosuch", ["x"])

    def test_a_dictionary_rejects_words_it_does_not_have(self):
        lines = self.z.add("zh", ["天气", "abc", "龘龘"], today="2026-01-05", dic={"天气": [{}]})
        self.assertEqual(lines[0], "天气: added")
        self.assertIn("not Chinese characters", lines[1])
        self.assertIn("not in CC-CEDICT", lines[2])

    def fake_dicts(self):
        from types import SimpleNamespace
        from unittest import mock
        dic = {w: [{"simp": w, "trad": w, "pinyin": py, "defs": [d], "proper": prop}]
               for w, py, d, prop in [("天气", "tiān qì", "weather", False), ("预报", "yù bào", "forecast", False),
                                      ("我们", "wǒ men", "we", False), ("王小明", "Wáng Xiǎo míng", "a given name (example)", True),
                                      ("的", "de", "of", False)]}
        ranks = {"我": 10, "们": 30, "说": 20, "的": 1, "预": 520, "报": 400, "天": 300, "气": 625, "王": 2073, "小": 900, "明": 450}
        hz = SimpleNamespace(ranks=lambda: ranks)
        return [mock.patch.object(self.z, "cedict_entries", lambda: dic), mock.patch.object(self.z, "_learn", lambda: (hz, None))]

    def test_scan_picks_words_above_the_level_easiest_first_names_last(self):
        for p in self.fake_dicts():
            p.start()
            self.addCleanup(p.stop)
        out = self.z.scan("zh", "我们的天气，王小明说预报天气。")
        self.assertEqual(out["level"], self.z.DEFAULT_LEVEL)
        self.assertEqual([w["text"] for w in out["words"]], ["预报", "天气", "王小明"])
        self.assertEqual(next(w for w in out["words"] if w["text"] == "天气")["count"], 2)
        self.assertTrue(out["words"][-1]["name"])
        self.assertLess(out["known_share"], 1)
        with self.assertRaises(SystemExit):
            self.z.scan("spanish", "hola")  # Chinese only

    def test_placement_and_done_lessons_set_what_counts_as_known(self):
        for p in self.fake_dicts():
            p.start()
            self.addCleanup(p.stop)
        self.unit("09-characters.json", {"id": "zh-09", "cards": [
            {"id": "zh-c-气", "kind": "char", "text": "气", "rank": 625}, {"id": "zh-c-预", "kind": "char", "text": "预", "rank": 520}],
            "lessons": [{"id": "zh-09-1", "cards": ["zh-c-气"]}, {"id": "zh-09-2", "cards": ["zh-c-预"]}]})
        (self.data / "progress.json").write_text(json.dumps({"tracks": {"zh": {"placed": True, "start": "zh-09"}},
                                                             "lessons": {"zh-09-1": {}}}))
        lvl, placed, known = self.z.level("zh")
        self.assertEqual((lvl, placed), (519, True))
        self.assertIn("气", known)
        self.assertEqual([w["text"] for w in self.z.scan("zh", "天气预报")["words"]], ["预报"])

    def test_drop_forgets_only_a_waiting_word(self):
        self.pending("天气")
        self.assertTrue(self.z.drop("zh", "天气"))
        self.assertFalse(self.z.drop("zh", "天气"))
        self.assertEqual(self.z.load("zh")["words"], [])


if __name__ == "__main__":
    unittest.main()
