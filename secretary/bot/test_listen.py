"""Secretary listener tests. Run: python3 -m unittest discover -s secretary/bot"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import listen  # noqa: E402

OWNER = "111"
GROUP = -1009
CFG = {"chat_id": GROUP, "topics": {"finance": 5, "secretary": 6}}


def upd(uid, text="", chat=GROUP, sender=OWNER, thread=6, photo=False):
    m = {"message_id": uid, "date": 1, "chat": {"id": chat, "type": "supergroup" if chat == GROUP else "private"}, "from": {"id": int(sender)}}
    if text:
        m["text"] = text
    if thread is not None and chat == GROUP:
        m.update(message_thread_id=thread, is_topic_message=True)
    if photo:
        m["photo"] = [{"file_id": "small", "file_size": 10}, {"file_id": "big", "file_size": 900}]
        m["caption"] = "Grab to the airport, claim"
    return {"update_id": uid, "message": m}


class Parse(unittest.TestCase):
    def test_only_the_owner_in_the_secretary_topic_or_private_chat(self):
        resp = {"ok": True, "result": [upd(1, "find me 2h tomorrow"), upd(2, "hi", thread=5), upd(3, "hi", sender="222"),
                                       upd(4, "", photo=True), upd(5, "dinner fri 7pm", chat=int(OWNER))]}
        nxt, events = listen.parse_updates(resp, OWNER, CFG)
        self.assertEqual(nxt, 6)
        self.assertEqual([e["update_id"] for e in events], [1, 4, 5])
        photo = next(e for e in events if e["update_id"] == 4)
        self.assertEqual(photo["file_meta"]["id"], "big")  # the largest size
        self.assertEqual(photo["text"], "Grab to the airport, claim")

    def test_claim_and_done(self):
        resp = {"ok": True, "result": [upd(7, "/here secretary", thread=6)]}
        _, events = listen.parse_updates(resp, OWNER, CFG)
        self.assertEqual(events[0]["claim"]["key"], "secretary")
        with tempfile.TemporaryDirectory() as d:
            os.environ["SECRETARYBOT_HOME"] = d
            try:
                box = listen.inbox()
                (box / "9.json").write_text(json.dumps({"update_id": 9}))
                (box / "9-receipt.jpg").write_bytes(b"x")
                (box / "10.json").write_text("{}")
                listen.done(["9"])
                self.assertEqual(sorted(p.name for p in box.iterdir()), ["10.json"])
            finally:
                del os.environ["SECRETARYBOT_HOME"]


if __name__ == "__main__":
    unittest.main()
