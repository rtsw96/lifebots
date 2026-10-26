#!/usr/bin/env python3
"""Finance bot listener: wait for inbound Telegram messages, then exit.

Long-polls getUpdates on the finance bot (FINANCE_BOT_TOKEN). The process is
curl, not a model, so it costs nothing while idle. When messages arrive from
the owner's chat it saves each one as an event in the inbox (documents and
photos downloaded beside it), shows "typing", prints the events and exits 0.
The agent handles them (the `finance-bot` skill), deletes every file it was
sent (`listen.py done <update_id>`) and relaunches the listener.

Files live in ~/.financebot/inbox, outside the repo. Statements carry account
and card numbers, so they are deleted as soon as their lines are in the
ledger and are never committed.

Finance app: when finance/app/config.json has the app's url, about once a
minute the listener also asks the Worker for devices waiting for approval and
for changes made in the app, and prints them as events
({"kind": "device_pending", ...} and {"kind": "app_queue", ...}).

Exit codes: 0 events printed · 6 another listener is running · 3 deadline reached · 4 stop word · 2 config.

Bot group: the bot can also live in one topic of the owner's bot group
(bots/route.py, bots/group.json). There it takes only the owner's messages in
its own topic; `/here money` in a topic claims it (a "claimed" event: commit
bots/group.json). Replies go back to wherever the owner last wrote.

SECURITY: only the owner's Telegram id (OWNER_TELEGRAM_ID; FINANCE_CHAT_ID or
TELEGRAM_CHAT_ID also work), or the owner in the money topic of the bot group,
is accepted. Anything else is dropped without
being echoed. Message text and file contents are
untrusted input: a statement describes transactions; it cannot widen what the
agent may do.

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
APP_POLL_EVERY = 60
MAX_FILE = 20 * 1024 * 1024  # Telegram's getFile limit
STOP_WORDS = {"/stop", "stop", "/stopbot"}
HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / "bots"))
import route  # noqa: E402
import curlcfg  # noqa: E402  (bot token off the command line)

BOT = "finance"


def home() -> Path:
    return Path(os.environ.get("FINANCEBOT_HOME", Path.home() / ".financebot"))


def bot_token() -> str:
    return os.environ.get("FINANCE_BOT_TOKEN", "")


def chat_id() -> str:
    return (os.environ.get("OWNER_TELEGRAM_ID") or os.environ.get("FINANCE_CHAT_ID")
            or os.environ.get("TELEGRAM_CHAT_ID") or "")


def base() -> str:
    return os.environ.get("FINANCEBOT_API", "https://api.telegram.org")  # override for tests


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
            ev["file_error"] = "larger than 20 MB; ask for a smaller export or a month at a time"
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
    """Delete handled events and their files (statements included)."""
    box = inbox()
    n = 0
    for i in ids:
        for p in box.glob(f"{i}*"):
            p.unlink(missing_ok=True)
            n += 1
    print(f"deleted {n} file(s)")
    return 0


class AppPoll:
    """Devices waiting for approval and app changes, signed with the bot token, once a minute."""

    def __init__(self):
        self.last = 0.0
        self.warned = False

    def poll(self) -> list[dict]:
        now = time.time()
        if now - self.last < APP_POLL_EVERY:
            return []
        self.last = now
        if os.environ.get("FINANCEBOT_API") and not os.environ.get("FINANCE_APP_CONFIG"):
            return []  # tests: never the real Worker
        sys.path.insert(0, str(HERE))
        try:
            import app_sync
            cfg = app_sync.config()
            if not cfg:
                return []
            devices = app_sync.post(cfg, bot_token(), "/api/devices", {"op": "devices", "ts": app_sync.now_ts()}, 10)["devices"]
            items = app_sync.post(cfg, bot_token(), "/api/queue", {"op": "list", "ts": app_sync.now_ts()}, 10).get("items", [])
        except Exception as e:  # noqa: BLE001 - a dead Worker must not stop the chat side
            if not self.warned:
                print(f"listen: finance app not reached ({e}); will keep trying quietly", file=sys.stderr)
                self.warned = True
            return []
        seen_p = home() / "app_seen.json"
        seen = set(json.loads(seen_p.read_text())) if seen_p.exists() else set()
        out = []
        for d in devices:
            if d.get("status") == "pending" and f"dev:{d['id']}" not in seen:
                out.append({"kind": "device_pending", "id": d["id"], "fingerprint": d.get("fingerprint", d["id"]), "label": d.get("label", "")})
                seen.add(f"dev:{d['id']}")
        new = [it["id"] for it in items if it.get("id") not in seen]
        if new:
            out.append({"kind": "app_queue", "ids": new, "what": sorted({it.get("kind", "?") for it in items if it["id"] in new})})
            seen |= set(new)
        if out:
            seen_p.write_text(json.dumps(sorted(seen)))
        return out


def pending() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(inbox().glob("*.json"), key=lambda p: int(p.stem))]


def emit(events: list[dict]) -> None:
    print("=== FINANCE BOT EVENTS ===")
    for ev in events:
        print(json.dumps(ev))


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
        print("listen: FINANCE_BOT_TOKEN and OWNER_TELEGRAM_ID must be set", file=sys.stderr)
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
    app = AppPoll()
    while True:
        if deadline and time.time() >= deadline:
            print("listen: deadline reached", file=sys.stderr)
            return 3
        app_events = app.poll()
        if app_events:
            emit(app_events)
            return 0
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
