#!/usr/bin/env python3
"""Secretary bot listener: wait for inbound Telegram messages, then exit.

Long-polls getUpdates on the secretary bot (SECRETARY_BOT_TOKEN). The process is
curl, not a model, so it costs nothing while idle. When messages arrive from
the owner's chat (or the owner in the bot's topic of the bot group) it saves
each one as an event in the inbox (receipt photos and PDFs downloaded beside
it), shows "typing", prints the events and exits 0. The agent handles them
(the `secretary` skill), deletes every file it was sent (`listen.py done
<update_id>`) and relaunches the listener.

Files live in ~/.secretarybot/inbox, outside the repo. A receipt kept for a
claim goes to the Secretary app's private storage (claims.py add --receipt),
never into the repo; the inbox copy is deleted either way.

Reminders (secretary/remind.py) are sent from here: before each poll, any that are
due go out through send.sh, and the listener exits 5 so the agent commits
secretary/data/reminders.csv.

Exit codes: 0 events printed · 5 reminders sent · 6 another listener is running · 3 deadline reached ·
4 stop word · 2 config.

Usage: listen.py [deadline_seconds]      wait for events
       listen.py done <update_id> ...    delete an event and its file
"""

import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

POLL_TIMEOUT = 45
MAX_FILE = 20 * 1024 * 1024  # Telegram's getFile limit
STOP_WORDS = {"/stop", "stop", "/stopbot"}
HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / "bots"))
sys.path.append(str(HERE.parent))
import route  # noqa: E402
import curlcfg  # noqa: E402  (bot token off the command line)

BOT = "secretary"


def home() -> Path:
    return Path(os.environ.get("SECRETARYBOT_HOME", Path.home() / ".secretarybot"))


def bot_token() -> str:
    return os.environ.get("SECRETARY_BOT_TOKEN", "")


def chat_id() -> str:
    """The owner's Telegram id (OWNER_TELEGRAM_ID; the older names still work)."""
    return (os.environ.get("OWNER_TELEGRAM_ID") or os.environ.get("SECRETARY_CHAT_ID")
            or os.environ.get("TELEGRAM_CHAT_ID") or "")


def base() -> str:
    return os.environ.get("SECRETARYBOT_API", "https://api.telegram.org")  # override for tests


def inbox() -> Path:
    p = home() / "inbox"
    p.mkdir(parents=True, exist_ok=True)
    os.chmod(p, 0o700)
    return p


def curl_json(url: str, max_time: int) -> dict:
    out = curlcfg.run(["curl", "-sS", "--max-time", str(max_time)], url, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def safe_name(name: str) -> str:
    base_name = (name or "file").replace("\\", "/").split("/")[-1]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", base_name)[-80:].lstrip("._")
    return stem or "file"


def parse_updates(resp: dict, chat: str, cfg: dict | None = None) -> tuple[int | None, list[dict]]:
    """Return (next offset, events from the owner's chat or the bot's group topic).
    Pure apart from reading bots/group.json when cfg is None."""
    cfg = route.load() if cfg is None else cfg
    if not resp.get("ok"):
        return None, []
    results = resp.get("result") or []
    if not results:
        return None, []
    last = max(u.get("update_id", 0) for u in results)
    events = []
    for u in results:
        m = u.get("message") or {}
        where = route.claim(m, chat, BOT)
        if where:
            events.append({"update_id": u["update_id"], "message_id": m.get("message_id"), "date": m.get("date"),
                           "text": "", "file_meta": None, "claim": where, "where": route.where_from(m)})
            continue
        if not route.accepts(m, chat, BOT, cfg):
            continue  # not the owner, or another bot's topic: drop, never echo
        file = None
        if m.get("document"):
            d = m["document"]
            file = {"id": d["file_id"], "name": safe_name(d.get("file_name", "")), "mime": d.get("mime_type", ""),
                    "size": d.get("file_size", 0)}
        elif m.get("photo"):
            p = m["photo"][-1]
            file = {"id": p["file_id"], "name": "photo.jpg", "mime": "image/jpeg", "size": p.get("file_size", 0)}
        text = (m.get("caption") or m.get("text") or "").strip()
        if not file and not text:
            continue
        events.append({"update_id": u["update_id"], "message_id": m.get("message_id"), "date": m.get("date"),
                       "text": text, "file_meta": file, "where": route.where_from(m)})
    return last + 1, events


def save_event(api: str, ev: dict) -> dict:
    """Download the file (if any) and write the event JSON into the inbox."""
    box = inbox()
    ev = dict(ev)
    meta = ev.pop("file_meta")
    ev["file"] = None
    if ev.get("claim"):
        where = ev.pop("claim")
        ev["text"] = route.save_claim(where.pop("key", BOT), where)
        ev["claimed"] = True
    if meta:
        if meta.get("size") and meta["size"] > MAX_FILE:
            ev["file_error"] = "larger than 20 MB; ask for a smaller photo or PDF"
        else:
            info = curl_json(f"{api}/getFile?file_id={meta['id']}", 30)
            fpath = info["result"]["file_path"]
            name = meta["name"] if "." in meta["name"] else meta["name"] + (Path(fpath).suffix or "")
            dest = box / f"{ev['update_id']}-{name}"
            curlcfg.run(["curl", "-sS", "--fail", "--max-time", "120", "-o", str(dest)], f"{base()}/file/bot{bot_token()}/{fpath}", check=True)
            os.chmod(dest, 0o600)
            ev["file"] = str(dest)
            ev["mime"] = meta.get("mime", "")
    tmp = box / f"{ev['update_id']}.json.tmp"
    tmp.write_text(json.dumps(ev))
    tmp.rename(box / f"{ev['update_id']}.json")
    return ev


def done(ids: list[str]) -> int:
    """Delete handled events and their files (receipts included)."""
    box = inbox()
    n = 0
    for i in ids:
        for p in box.glob(f"{i}*"):
            p.unlink(missing_ok=True)
            n += 1
    print(f"deleted {n} file(s)")
    return 0


def pending() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(inbox().glob("*.json"), key=lambda p: int(p.stem))]


def emit(events: list[dict]) -> None:
    print("=== SECRETARY BOT EVENTS ===")
    for ev in events:
        print(json.dumps(ev))


def send_reminders() -> list[dict]:
    """Send any reminder that is due. A broken reminders file never stops the listener."""
    try:
        import remind
        return remind.send_due()
    except Exception as exc:  # noqa: BLE001
        print(f"listen: reminders skipped ({type(exc).__name__})", file=sys.stderr)
        return []


def single_instance():
    home().mkdir(parents=True, exist_ok=True)
    fh = open(home() / "listen.lock", "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def main(argv: list[str]) -> int:
    if argv[:1] == ["done"]:
        return done(argv[1:])
    token, chat = bot_token(), chat_id()
    if not token or not chat:
        print("listen: SECRETARY_BOT_TOKEN and OWNER_TELEGRAM_ID must be set", file=sys.stderr)
        return 2
    lock = single_instance()
    if lock is None:
        print("listen: another listener is already running; not starting a second one", file=sys.stderr)
        return 6
    api = f"{base()}/bot{token}"
    deadline = time.time() + int(argv[0]) if argv else None
    state = home() / "offset"
    left = pending()
    if left:
        emit(left)
        return 0
    offset = int(state.read_text()) if state.exists() else 0
    while True:
        sent = send_reminders()
        if sent:
            print("=== REMINDERS SENT ===")
            for r in sent:
                print(json.dumps({"id": r["id"], "text": r["text"], "repeat": r["repeat"], "status": r["status"]}))
            return 5
        if deadline and time.time() >= deadline:
            print("listen: deadline reached", file=sys.stderr)
            return 3
        try:
            resp = curl_json(f"{api}/getUpdates?timeout={POLL_TIMEOUT}&offset={offset}"
                             "&allowed_updates=%5B%22message%22%5D", POLL_TIMEOUT + 15)
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            time.sleep(3)
            continue
        nxt, events = parse_updates(resp, chat)
        if nxt is None:
            continue
        stop = [e for e in events if e["text"].lower() in STOP_WORDS and not e["file_meta"] and not e.get("claim")]
        try:
            saved = [save_event(api, e) for e in events if e not in stop]
        except (subprocess.CalledProcessError, KeyError, json.JSONDecodeError):
            time.sleep(3)
            continue  # offset not advanced, so the batch is fetched again
        state.write_text(str(nxt))
        offset = nxt
        if saved:
            route.remember(home(), saved[-1]["where"])
            to, thread = route.target(BOT, home(), chat)
            curlcfg.run(["curl", "-sS", "--max-time", "10", "-o", "/dev/null"], f"{api}/sendChatAction?chat_id={to}&action=typing{route.thread_param(thread)}")
            emit(saved)
        if stop:
            print("=== STOP REQUESTED ===")
            return 4
        if saved:
            return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
