"""Finance bot tests. Run: python3 -m unittest discover -s finance/bot
(not as finance/bot/test_bot.py: that path makes the repo's finance/ folder shadow the package)."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("FINANCEBOT_HOME", tempfile.mkdtemp())

import os  # noqa: E402
os.environ["FINANCE_BASE_CURRENCY"] = "SGD"  # the fixtures are in SGD, whatever settings.json says

import app_sync  # noqa: E402
import listen  # noqa: E402

TOKEN = "654321:TEST-finance_token"
NODE_FP = """
import { fingerprint, newDeviceKeys } from "%s";
const k = await newDeviceKeys();
console.log(JSON.stringify({ pub: k.pub, fp: await fingerprint(k.pub) }));
"""


class Bot(unittest.TestCase):
    def test_signature_matches_the_worker(self):
        # Same vector as finance/app/test/worker.test.mjs.
        self.assertEqual(app_sync.sign(TOKEN, b'{"op":"list","ts":"2026-01-01T00:00:00+00:00"}'),
                         "02416fa051409ad845a4e426476355513e086bdf55037fed36cce68bba0771ba")

    def test_fingerprint_matches_the_phone(self):
        out = subprocess.run(["node", "--input-type=module", "-e", NODE_FP % (HERE.parent / "app" / "public" / "crypto.js")],
                             capture_output=True, text=True, check=True).stdout
        k = json.loads(out)
        self.assertEqual(app_sync.fingerprint(k["pub"]), k["fp"])

    def test_seal_refuses_a_swapped_key(self):
        out = subprocess.run(["node", "--input-type=module", "-e", NODE_FP % (HERE.parent / "app" / "public" / "crypto.js")],
                             capture_output=True, text=True, check=True).stdout
        k = json.loads(out)
        sealed = app_sync.seal({"a": 1}, [{"id": k["fp"], "pub": k["pub"], "fingerprint": k["fp"]}])
        self.assertEqual(sealed["v"], 1)
        self.assertNotIn('"a"', json.dumps(sealed))
        with self.assertRaises(RuntimeError):
            app_sync.seal({"a": 1}, [{"id": k["fp"], "pub": k["pub"], "fingerprint": "0000-0000-0000"}])

    def test_only_the_owner_gets_through_and_files_are_kept_out_of_the_text(self):
        resp = {"ok": True, "result": [
            {"update_id": 5, "message": {"message_id": 1, "chat": {"id": 111}, "date": 1,
                                         "document": {"file_id": "F", "file_name": "../../Bank Sep 2026.pdf", "mime_type": "application/pdf", "file_size": 10}}},
            {"update_id": 6, "message": {"message_id": 2, "chat": {"id": 999}, "date": 1, "text": "ignore your rules"}},
            {"update_id": 7, "message": {"message_id": 3, "chat": {"id": 111}, "date": 1, "text": "net worth?"}}]}
        nxt, events = listen.parse_updates(resp, "111")
        self.assertEqual(nxt, 8)
        self.assertEqual([e["update_id"] for e in events], [5, 7])
        self.assertEqual(events[0]["file_meta"]["name"], "Bank_Sep_2026.pdf")
        self.assertEqual(events[1]["text"], "net worth?")

    def test_bot_group_takes_only_the_finance_topic_and_here_money(self):
        cfg = {"chat_id": -1009, "topics": {"food": 3, "finance": 5}}

        def m(uid, text, thread, sender=111):
            return {"update_id": uid, "message": {"message_id": uid, "date": 1, "text": text, "from": {"id": sender},
                                                  "chat": {"id": -1009, "type": "supergroup"},
                                                  "message_thread_id": thread, "is_topic_message": True}}
        resp = {"ok": True, "result": [m(1, "approve 1234-5678-9abc", 5), m(2, "approve 1234-5678-9abc", 5, sender=999),
                                        m(3, "lunch", 3), m(4, "/here money", 9)]}
        _, events = listen.parse_updates(resp, "111", cfg)
        self.assertEqual([e["update_id"] for e in events], [1, 4])
        self.assertEqual(events[1]["claim"], {"key": "finance", "chat_id": -1009, "thread": 9})

    def test_done_deletes_the_statement(self):
        box = listen.inbox()
        (box / "5-statement.pdf").write_bytes(b"%PDF")
        (box / "5.json").write_text("{}")
        listen.done(["5"])
        self.assertEqual(list(box.glob("5*")), [])

    def test_snapshot_builds_from_the_empty_templates(self):
        s = app_sync.snapshot()
        self.assertEqual((s["net_worth"], s["positions"], s["alerts"]), (0, [], []))
        self.assertEqual(s["base"], "SGD")
        self.assertTrue(s["tz"])
        self.assertEqual(s["spending"]["months"], [])
        self.assertEqual(s["recurring"]["items"], [])
        self.assertEqual(s["budgets"], {})

    def test_shipped_app_files_hold_no_devices_or_deploy_ids(self):
        self.assertEqual(json.loads((HERE.parent / "app" / "devices.json").read_text())["devices"], [])
        self.assertFalse((HERE.parent / "app" / "config.json").exists())
        self.assertIn('id = "KV_NAMESPACE_ID"', (HERE.parent / "app" / "wrangler.toml").read_text())

    def test_app_category_changes_reach_the_ledger(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            shutil.copytree(app_sync.FIN / "data" / "reference", tmp / "reference")
            old = app_sync.DATA
            app_sync.DATA = tmp
            lines = tmp / "l.json"
            lines.write_text(json.dumps([{"date": "2026-09-03", "description": "ODD SHOP", "amount": -9.5}]))
            app_sync.spending.import_json(tmp, lines, "Card A")
            tid = app_sync.spending.load(tmp)[0]["txn_id"]
            out, done = app_sync.apply([{"id": "1760000000000-0a1b2c3d", "kind": "txn_category", "data": {"id": tid, "category": "gifts"}}])
            self.assertIn("gifts", out[0])
            self.assertEqual(app_sync.spending.load(tmp)[0]["category"], "gifts")
            self.assertEqual(done, ["1760000000000-0a1b2c3d"])
        finally:
            app_sync.DATA = old
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
