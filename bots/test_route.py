"""Bot group routing tests. Run: python3 -m unittest discover -s bots"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import route  # noqa: E402

OWNER = "111"
GROUP = -1009
CFG = {"chat_id": GROUP, "topics": {"food": 3, "finance": 5}}


def msg(text="hi", chat=GROUP, kind="supergroup", sender=OWNER, thread=None):
    m = {"message_id": 1, "date": 1, "text": text, "chat": {"id": chat, "type": kind}, "from": {"id": int(sender)}}
    if thread is not None:
        m.update(message_thread_id=thread, is_topic_message=True)
    return m


class Accepts(unittest.TestCase):
    def test_private_chat_is_only_the_owner(self):
        self.assertTrue(route.accepts(msg(chat=111, kind="private"), OWNER, "food", {}))
        self.assertFalse(route.accepts(msg(chat=222, kind="private", sender="222"), OWNER, "food", CFG))

    def test_group_takes_only_the_owner_in_the_bots_own_topic(self):
        self.assertTrue(route.accepts(msg(thread=3), OWNER, "food", CFG))
        self.assertFalse(route.accepts(msg(thread=5), OWNER, "food", CFG))        # finance's topic
        self.assertTrue(route.accepts(msg(thread=5), OWNER, "finance", CFG))
        self.assertFalse(route.accepts(msg(), OWNER, "food", CFG))                # General topic
        self.assertFalse(route.accepts(msg(thread=3, sender="222"), OWNER, "food", CFG))  # someone else
        self.assertFalse(route.accepts(msg(chat=-1, thread=3), OWNER, "food", CFG))       # another group
        self.assertFalse(route.accepts(msg(thread=3), OWNER, "food", {}))          # no group set up

    def test_reply_in_general_is_not_a_topic_message(self):
        m = msg(thread=3)
        m["is_topic_message"] = False  # Telegram sets a thread id on replies in General too
        self.assertFalse(route.accepts(m, OWNER, "food", CFG))


class Claim(unittest.TestCase):
    def test_here_claims_only_for_the_named_bot(self):
        self.assertEqual(route.claim(msg("/here food", thread=7), OWNER, "food"), {"key": "food", "chat_id": GROUP, "thread": 7})
        self.assertEqual(route.claim(msg("/here@MyMoneyBot money", thread=8), OWNER, "finance"),
                         {"key": "finance", "chat_id": GROUP, "thread": 8})
        # The reports bot has no listener: the finance listener records its topic, the food one ignores it.
        self.assertEqual(route.claim(msg("/here reports", thread=9), OWNER, "finance"),
                         {"key": "reports", "chat_id": GROUP, "thread": 9})
        self.assertIsNone(route.claim(msg("/here reports", thread=9), OWNER, "food"))
        self.assertIsNone(route.claim(msg("/here food", thread=7), OWNER, "finance"))
        self.assertIsNone(route.claim(msg("/here food", thread=7, sender="222"), OWNER, "food"))
        self.assertIsNone(route.claim(msg("/here food", chat=111, kind="private"), OWNER, "food"))
        self.assertIsNone(route.claim(msg("here food", thread=7), OWNER, "food"))
        self.assertEqual(route.claim(msg("/here secretary", thread=6), OWNER, "secretary"), {"key": "secretary", "chat_id": GROUP, "thread": 6})
        self.assertIsNone(route.claim(msg("/here secretary", thread=6), OWNER, "finance"))

    def test_save_claim_refuses_general_and_resets_on_a_new_group(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "group.json"
            self.assertIn("Topics", route.save_claim("food", {"chat_id": GROUP, "thread": None}, p))
            self.assertFalse(p.exists())
            route.save_claim("food", {"chat_id": GROUP, "thread": 3}, p)
            route.save_claim("finance", {"chat_id": GROUP, "thread": 5}, p)
            self.assertEqual(route.load(p), CFG)
            route.save_claim("food", {"chat_id": -2, "thread": 9}, p)
            self.assertEqual(route.load(p), {"chat_id": -2, "topics": {"food": 9}})


class Target(unittest.TestCase):
    def test_reply_goes_where_the_owner_last_wrote(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            self.assertEqual(route.target("food", home, OWNER, {}), (OWNER, None))
            self.assertEqual(route.target("food", home, OWNER, CFG), (str(GROUP), 3))
            route.remember(home, {"chat_id": int(OWNER), "thread": None})
            self.assertEqual(route.target("food", home, OWNER, CFG), (OWNER, None))
            route.remember(home, {"chat_id": GROUP, "thread": 3})
            self.assertEqual(route.target("food", home, OWNER, CFG), (str(GROUP), 3))
            route.remember(home, {"chat_id": -555, "thread": 1})  # a group the bot no longer belongs to
            self.assertEqual(route.target("food", home, OWNER, CFG), (str(GROUP), 3))


class Reports(unittest.TestCase):
    def test_reports_go_to_the_topic_once_claimed(self):
        self.assertEqual(route.reports_target(OWNER, CFG), (OWNER, None))
        self.assertEqual(route.reports_target(OWNER, {**CFG, "topics": {**CFG["topics"], "reports": 9}}), (str(GROUP), 9))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "g.json"
            route.save_claim("food", {"chat_id": GROUP, "thread": 3}, p)
            self.assertIn("Reports", route.save_claim("reports", {"chat_id": GROUP, "thread": 9}, p))
            self.assertEqual(route.load(p)["topics"], {"food": 3, "reports": 9})


# A fake curl: logs its arguments, then what it read on stdin (the URL, with the
# token, arrives there through -K -) as "STDIN:" lines.
FAKE_CURL = ('#!/bin/sh\nprintf "%s\\n" "$@" >> {log}\n'
             'for a in "$@"; do [ "$a" = "-K" ] && sed "s/^/STDIN:/" >> {log}; done\n'
             'echo \'{{"ok":true}}\'\n')


class SendScripts(unittest.TestCase):
    """send.sh replies into the topic, with a fake curl that records its arguments."""

    def run_send(self, script, home_var, bot):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "curl.log"
            (d / "curl").write_text(FAKE_CURL.format(log=log))
            (d / "curl").chmod(0o755)
            home = d / "home"
            route.remember(home, {"chat_id": GROUP, "thread": 3 if bot == "food" else 5})
            cfg = d / "group.json"
            cfg.write_text(json.dumps(CFG))
            env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", home_var: str(home), "BOTS_GROUP_CONFIG": str(cfg),
                   "TELEGRAM_CHAT_ID": OWNER, "FOOD_LOG_BOT_TOKEN": "x", "FINANCE_BOT_TOKEN": "x"}
            env.pop("FOOD_CHAT_ID", None)
            env.pop("FINANCE_CHAT_ID", None)
            subprocess.run(["bash", str(ROOT / script)], input="hello", text=True, env=env,
                           check=True, capture_output=True)
            return log.read_text().splitlines()

    def test_report_lands_in_the_reports_topic(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "curl.log"
            (d / "curl").write_text(FAKE_CURL.format(log=log))
            (d / "curl").chmod(0o755)
            (d / "r.pdf").write_bytes(b"%PDF")
            cfg = d / "group.json"
            cfg.write_text(json.dumps({**CFG, "topics": {**CFG["topics"], "reports": 9}}))
            env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", "BOTS_GROUP_CONFIG": str(cfg),
                   "OWNER_TELEGRAM_ID": OWNER, "FINANCE_BOT_TOKEN": "fin", "FOOD_LOG_BOT_TOKEN": "food"}
            env.pop("FINANCE_CHAT_ID", None)
            subprocess.run(["bash", str(ROOT / "bots" / "report.sh"), "--doc", str(d / "r.pdf"), "cap"], env=env,
                           check=True, capture_output=True, text=True)
            args = log.read_text().splitlines()
            # Without the money bot: private chat through another installed bot, never the group.
            log.write_text("")
            env.pop("FINANCE_BOT_TOKEN")
            subprocess.run(["bash", str(ROOT / "bots" / "report.sh"), "--doc", str(d / "r.pdf"), "cap"], env=env,
                           check=True, capture_output=True, text=True)
            fallback = log.read_text().splitlines()
        self.assertIn(f"chat_id={GROUP}", args)
        self.assertIn("message_thread_id=9", args)
        self.assertTrue(any(a.startswith("STDIN:") and "/botfin/" in a for a in args))  # posted by the finance bot
        self.assertFalse(any("/bot" in a for a in args if not a.startswith("STDIN:")))  # token never in argv
        self.assertIn("caption=cap", args)
        self.assertIn(f"chat_id={OWNER}", fallback)
        self.assertFalse(any("message_thread_id" in a for a in fallback))
        self.assertTrue(any(a.startswith("STDIN:") and "/botfood/" in a for a in fallback))

    def test_charts_go_as_photos_into_the_topic(self):
        for script, home_var, bot, thread in (("health/foodbot/send.sh", "FOODBOT_HOME", "food", 3),
                                              ("finance/bot/send.sh", "FINANCEBOT_HOME", "finance", 5)):
            with tempfile.TemporaryDirectory() as d:
                d = Path(d)
                log = d / "curl.log"
                (d / "curl").write_text(FAKE_CURL.format(log=log))
                (d / "curl").chmod(0o755)
                (d / "c.png").write_bytes(b"\x89PNG")
                home = d / "home"
                route.remember(home, {"chat_id": GROUP, "thread": thread})
                cfg = d / "group.json"
                cfg.write_text(json.dumps(CFG))
                env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", home_var: str(home), "BOTS_GROUP_CONFIG": str(cfg),
                       "TELEGRAM_CHAT_ID": OWNER, "FOOD_LOG_BOT_TOKEN": "x", "FINANCE_BOT_TOKEN": "x"}
                env.pop("FOOD_CHAT_ID", None)
                env.pop("FINANCE_CHAT_ID", None)
                subprocess.run(["bash", str(ROOT / script), "--photo", str(d / "c.png"), "cap"], env=env,
                               check=True, capture_output=True, text=True)
                args = log.read_text().splitlines()
            self.assertIn(f"message_thread_id={thread}", args, script)
            self.assertTrue(any(a.startswith("STDIN:") and a.endswith('/sendPhoto"') for a in args), script)
            self.assertFalse(any("/bot" in a for a in args if not a.startswith("STDIN:")), script)
            self.assertTrue(any(a.startswith("photo=@") for a in args), script)

    def test_food_reply_lands_in_the_food_topic(self):
        args = self.run_send("health/foodbot/send.sh", "FOODBOT_HOME", "food")
        self.assertIn(f"chat_id={GROUP}", args)
        self.assertIn("message_thread_id=3", args)

    def test_finance_reply_lands_in_the_finance_topic(self):
        args = self.run_send("finance/bot/send.sh", "FINANCEBOT_HOME", "finance")
        self.assertIn(f"chat_id={GROUP}", args)
        self.assertIn("message_thread_id=5", args)


if __name__ == "__main__":
    unittest.main()
