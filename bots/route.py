#!/usr/bin/env python3
"""Where the food, finance, secretary, knowledge and trip bots listen and reply.

Each bot always accepts the owner's private chat. It can also live in one topic
of the owner's bot group, a Telegram group with Topics turned on that holds
all the bots. `group.json` beside this file records that group and the topic
each bot owns:

    {"chat_id": -1001234567890, "topics": {"food": 3, "finance": 5}}

Chat and topic ids aren't secrets: nobody can post in the group without being
added to it. In the group, a message reaches a bot only when the owner sent it,
in that bot's topic. Everything else (other topics, the General topic, anyone
else) is dropped in the listener, before any model sees it, so a group costs no
tokens for messages meant for another bot. Telegram never delivers one bot's
messages to another, so the bots can't talk to each other in a loop.

The owner claims a topic by sending `/here food`, `/here money`, `/here secretary`, `/here knowledge`,
`/here travel` (the trip bot: its trip groups stay as they are; the topic is where the owner plans
alone and edits any trip) or `/here reports`
in it (the money bot's listener records the Reports topic: the money bot posts
finished reports there). The
listener then rewrites group.json (moving to a new group drops the old topics),
and the agent commits it.

Replies go back to where the owner last wrote (`reply_to` in the bot's home,
set by the listener). With no `reply_to`, they go to the bot's group topic if
one is set, otherwise to the private chat.

CLI (used by the send.sh scripts):
    route.py target <bot> <home> <owner_chat>    prints "<chat_id> <thread_id or ->"
    route.py reports <owner_chat>                same, for finished reports (bots/report.sh)
"""

import json
import os
import re
import sys
from pathlib import Path

CONFIG = Path(__file__).resolve().with_name("group.json")


def config_path() -> Path:
    return Path(os.environ.get("BOTS_GROUP_CONFIG") or CONFIG)  # override for tests
# Words the owner can use in `/here <word>`, per topic key.
CLAIM_WORDS = {"food": {"food", "health"}, "finance": {"money", "finance"}, "reports": {"reports", "report"},
               "secretary": {"secretary", "sec", "calendar", "claims"},
               "knowledge": {"knowledge", "learn", "library", "kb"}, "travel": {"travel", "trip", "trips"}}
# Which listener records which keys. The money (finance) bot posts finished reports
# (bots/report.sh), so its listener records the Reports topic.
OWNS = {"food": ["food"], "finance": ["finance", "reports"], "secretary": ["secretary"], "knowledge": ["knowledge"],
        "trips": ["travel"]}
CLAIM = re.compile(r"^/here(?:@\w+)?\s+(\w+)\s*$", re.I)


def load(path: Path | None = None) -> dict:
    path = path or config_path()
    try:
        cfg = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return cfg if isinstance(cfg, dict) and cfg.get("chat_id") else {}


def _owner_sent(m: dict, owner: str) -> bool:
    return str((m.get("from") or {}).get("id")) == str(owner)


def accepts(m: dict, owner: str, bot: str, cfg: dict) -> bool:
    """True when this message is for this bot: the owner's private chat, or the
    owner writing in this bot's topic of the configured group."""
    chat = m.get("chat") or {}
    if chat.get("type", "private") == "private":
        return str(chat.get("id")) == str(owner)
    if not _owner_sent(m, owner) or not cfg or str(chat.get("id")) != str(cfg.get("chat_id")):
        return False
    topic = (cfg.get("topics") or {}).get(bot)
    return topic is not None and bool(m.get("is_topic_message")) and m.get("message_thread_id") == topic


def claim(m: dict, owner: str, bot: str) -> dict | None:
    """`/here food` from the owner inside a group topic, for a key this bot records:
    return {"key", "chat_id", "thread"}."""
    chat = m.get("chat") or {}
    hit = CLAIM.match((m.get("text") or "").strip())
    word = hit.group(1).lower() if hit else ""
    key = next((k for k in OWNS.get(bot, []) if word in CLAIM_WORDS[k]), None)
    if not key or chat.get("type") not in ("group", "supergroup") or not _owner_sent(m, owner):
        return None
    if not m.get("is_topic_message") or m.get("message_thread_id") is None:
        return {"key": key, "chat_id": chat.get("id"), "thread": None}  # General topic or no Topics: refused by save_claim
    return {"key": key, "chat_id": chat.get("id"), "thread": m["message_thread_id"]}


def save_claim(key: str, where: dict, path: Path | None = None) -> str:
    """Record the claimed topic for `key` (food, finance or reports). Returns a one-line result for the owner."""
    path = path or config_path()
    if where.get("thread") is None:
        return "Turn on Topics for the group and send /here in the bot's own topic, not General."
    cfg = load(path)
    if str(cfg.get("chat_id")) != str(where["chat_id"]):
        cfg = {"chat_id": where["chat_id"], "topics": {}}
    cfg["topics"][key] = where["thread"]
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=1) + "\n")
    tmp.rename(path)
    return ("Reports will be posted in this topic." if key == "reports" else f"This topic is now the {key} bot's.")


def where_from(m: dict) -> dict:
    chat = m.get("chat") or {}
    thread = m.get("message_thread_id") if m.get("is_topic_message") else None
    return {"chat_id": chat.get("id"), "thread": thread}


def remember(home: Path, where: dict) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "reply_to").write_text(json.dumps(where))


def target(bot: str, home: Path, owner: str, cfg: dict | None = None) -> tuple[str, int | None]:
    cfg = load() if cfg is None else cfg
    try:
        last = json.loads((home / "reply_to").read_text())
        chat_id = last.get("chat_id")
        # Only a chat this bot may still use: the owner's private chat or the current group.
        if str(chat_id) == str(owner) or (cfg and str(chat_id) == str(cfg.get("chat_id"))):
            return str(chat_id), last.get("thread")
    except (OSError, ValueError):
        pass
    topic = (cfg.get("topics") or {}).get(bot) if cfg else None
    if topic is not None:
        return str(cfg["chat_id"]), topic
    return str(owner), None


def reports_target(owner: str, cfg: dict | None = None) -> tuple[str, int | None]:
    """Where finished reports go: the Reports topic of the bot group, else the private chat."""
    cfg = load() if cfg is None else cfg
    topic = (cfg.get("topics") or {}).get("reports") if cfg else None
    return (str(cfg["chat_id"]), topic) if topic is not None else (str(owner), None)


def thread_param(thread: int | None) -> str:
    return f"&message_thread_id={thread}" if thread is not None else ""


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "target":
        chat_id, thread = target(sys.argv[2], Path(sys.argv[3]), sys.argv[4])
        print(chat_id, "-" if thread is None else thread)
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "reports":
        chat_id, thread = reports_target(sys.argv[2])
        print(chat_id, "-" if thread is None else thread)
        sys.exit(0)
    print(__doc__.split("CLI (used by the send.sh scripts):")[1].strip(), file=sys.stderr)
    sys.exit(2)
