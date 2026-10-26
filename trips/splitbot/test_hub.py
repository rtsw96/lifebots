"""Tests for the travel topic: solo trips, trip:<id>, /linktrip, and the bot group's other topics
left alone. Run: python3 -m unittest trips/splitbot/test_hub.py"""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


listen = _load("splitbot_listen_hub", "listen.py")
splitlog = _load("splitbot_splitlog_hub", "splitlog.py")
send = _load("splitbot_send_hub", "send.py")
commands = _load("splitbot_commands_hub", "commands.py")

OWNER, BOTGROUP, TRAVEL, FOOD, NEWGROUP = "111", "-100500", 301, 15, "-4004"
BOT = {"id": 42, "username": "tripsplit_bot"}
HUB = {"chat_id": BOTGROUP, "thread": TRAVEL}


def msg(uid, chat, sender, thread=None, **m):
    out = {"message_id": uid * 10, "date": 1791000000 + uid, "chat": {"id": int(chat), "type": "supergroup", "title": "bot group"},
           "from": {"id": int(sender), "first_name": f"U{sender}"}, **m}
    if thread is not None:
        out.update(is_topic_message=True, message_thread_id=thread)
    return {"update_id": uid, "message": out}


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        (d / "data").mkdir()
        (d / "data" / "trips.json").write_text(json.dumps({"trips": []}))
        (d / "group.json").write_text(json.dumps({"chat_id": int(BOTGROUP), "topics": {"food": FOOD, "travel": TRAVEL}}))
        self.env = {"SPLIT_DATA": str(d / "data"), "BOTS_GROUP_CONFIG": str(d / "group.json"),
                    "SPLITBOT_HOME": str(d / "home"), "SPLIT_OWNER_ID": OWNER, "SPLITBOT_NO_SYNC": "1"}
        self.old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def run_cli(self, *args) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = splitlog.main(list(args))
        text = out.getvalue()
        self.assertEqual(rc, 0, text)
        return text

    def trips(self) -> list[dict]:
        return json.loads((Path(self.env["SPLIT_DATA"]) / "trips.json").read_text())["trips"]


class BotGroup(Env):
    def test_only_the_owner_in_the_travel_topic_gets_through(self):
        resp = {"ok": True, "result": [
            msg(1, BOTGROUP, OWNER, TRAVEL, text="plan Japan in December, just me for now"),
            msg(2, BOTGROUP, OWNER, FOOD, text="water 500"),                    # the food bot's topic: dropped
            msg(3, BOTGROUP, OWNER, None, text="paid 20 for lunch"),            # General: dropped
            msg(4, BOTGROUP, "999", TRAVEL, text="paid 100"),                   # not the owner: dropped
            msg(5, BOTGROUP, OWNER, TRAVEL, photo=[{"file_id": "s"}, {"file_id": "b"}]),
            msg(6, BOTGROUP, OWNER, FOOD, text="/here food"),                   # another bot's claim: dropped
        ]}
        nxt, evs = listen.parse_updates(resp, OWNER, set(), BOT, {}, frozenset(), HUB)
        self.assertEqual(nxt, 7)
        self.assertEqual([e["update_id"] for e in evs], [1, 5])
        self.assertTrue(evs[0]["hub"] and evs[0]["thread"] == TRAVEL and evs[0]["chat_title"] == "travel topic")
        self.assertEqual(evs[1]["file_id"], "b")

    def test_here_travel_claims_the_topic(self):
        resp = {"ok": True, "result": [msg(1, BOTGROUP, OWNER, 333, text="/here travel"),
                                       msg(2, BOTGROUP, "999", 333, text="/here trips")]}  # not the owner
        _, evs = listen.parse_updates(resp, OWNER, set(), BOT, {}, frozenset(), {"chat_id": BOTGROUP, "thread": None})
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["claim"], {"key": "travel", "chat_id": int(BOTGROUP), "thread": 333})

    def test_the_bot_group_is_dropped_before_the_topic_is_claimed(self):
        resp = {"ok": True, "result": [msg(1, BOTGROUP, OWNER, FOOD, text="paid 30 dinner")]}
        _, evs = listen.parse_updates(resp, OWNER, set(), BOT, {}, frozenset(), {"chat_id": BOTGROUP, "thread": None})
        self.assertEqual(evs, [])

    def test_trip_groups_work_as_before(self):
        resp = {"ok": True, "result": [msg(1, "-1001", "222", None, text="paid 8400 for the taxi")]}
        _, evs = listen.parse_updates(resp, OWNER, {"-1001"}, BOT, {}, frozenset(), HUB)
        self.assertEqual(len(evs), 1)
        self.assertNotIn("hub", evs[0])


class SoloTrips(Env):
    def test_plan_alone_then_link_to_a_group(self):
        out = self.run_cli("trip", "new", "--planning", "--chat", "hub", "--name", "Japan", "--currency", "JPY",
                           "--window", "Dec 2026", "--members", f"Ana:{OWNER}")
        self.assertIn("Planning 'Japan'", out)
        self.run_cli("trip", "new", "--planning", "--chat", "hub", "--name", "Seoul", "--currency", "KRW",
                     "--members", f"Ana:{OWNER}")                       # several solo trips at once
        japan, seoul = self.trips()
        self.assertEqual((japan["chat_id"], seoul["chat_id"]), ("", ""))
        ref = f"trip:{japan['id']}"
        self.run_cli("add", "--chat", ref, "--payer", "Ana", "--amount", "300", "--currency", "SGD",
                     "--desc", "flight deposit", "--category", "transport", "--fx", "1")
        listing = self.run_cli("trip", "list")
        self.assertIn(f"Japan\t{ref}\tno group yet\tJPY", listing)
        out = self.run_cli("trip", "link", "--chat", ref, "--to", NEWGROUP)
        self.assertIn("Japan now lives in this group", out)
        self.assertIn("Everyone else: send /join", out)
        self.assertEqual(self.trips()[0]["chat_id"], NEWGROUP)
        self.assertIn("S$300.00", self.run_cli("balances", "--chat", NEWGROUP))  # the deposit came along
        # a group holds one open trip
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = splitlog.main(["trip", "link", "--chat", f"trip:{seoul['id']}", "--to", NEWGROUP])
        self.assertEqual(rc, 1)
        self.assertIn("already has an open trip (Japan)", out.getvalue())

    def test_a_trip_must_be_named_from_the_hub(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = splitlog.main(["balances", "--chat", "hub"])
        self.assertEqual(rc, 1)
        self.assertIn("Name the trip", out.getvalue())

    def test_replies_go_to_the_trips_group_or_the_travel_topic(self):
        self.run_cli("trip", "new", "--planning", "--chat", "hub", "--name", "Japan", "--currency", "JPY", "--members", "Ana")
        tid = self.trips()[0]["id"]
        self.assertEqual(send.resolve("hub"), (BOTGROUP, TRAVEL))
        self.assertEqual(send.resolve(f"trip:{tid}"), (BOTGROUP, TRAVEL))          # no group yet
        self.assertEqual(send.resolve(BOTGROUP), (BOTGROUP, TRAVEL))               # never General
        self.run_cli("trip", "link", "--chat", f"trip:{tid}", "--to", NEWGROUP)
        self.assertEqual(send.resolve(f"trip:{tid}"), (NEWGROUP, None))
        self.assertEqual(send.resolve(NEWGROUP), (NEWGROUP, None))
        self.assertIn(BOTGROUP, send.allowed_chats())
        self.assertEqual(splitlog.chat_ref(self.trips()[0]), NEWGROUP)

    def test_the_owner_menu_skips_trips_with_no_group(self):
        self.run_cli("trip", "new", "--planning", "--chat", "hub", "--name", "Japan", "--currency", "JPY", "--members", "Ana")
        calls = commands.plan_calls()   # would raise on int("") before
        self.assertFalse(any('"chat_member"' in (f.get("scope") or "") for _, f in calls))


if __name__ == "__main__":
    unittest.main()
