#!/usr/bin/env python3
"""Health bot listener: wait for inbound Telegram messages, then exit.

Long-polls getUpdates on the health bot (FOOD_LOG_BOT_TOKEN). The process is curl,
not a model, so it costs nothing while idle. When messages arrive from the
owner's chat it saves each one as an event in the inbox (photos downloaded
beside it), acknowledges with a "typing" indicator, prints the events and
exits 0. Run it in the background: the harness wakes the agent with this
output. The agent logs each meal, replies, deletes the photo (foodlog.py
done) and relaunches the listener (the health-bot skill).

The inbox is the durable queue. If the session dies mid-way, the next start
prints the leftover events first. The Telegram offset only advances after a
batch is safely in the inbox, and there is no cold-start skip: meals sent
while the session was down (Telegram keeps them 24 hours) are still logged.

Health app: when health/app/config.json has the app's url, about once a
minute the listener also asks the Worker for workouts and weigh-ins entered
in the app. New ones are printed as one {"kind": "app_queue", "ids": [...]}
event (each id once per container), and the agent runs app_sync.py apply.

Exit codes: 0 events printed · 6 another listener is running · 3 deadline reached · 4 stop word · 2 config.

Bot group: the bot can also live in one topic of the owner's bot group
(bots/route.py, bots/group.json). There it takes only the owner's messages in
its own topic; `/here food` in a topic claims it (a "claimed" event: commit
bots/group.json). Replies go back to wherever the owner last wrote.

SECURITY: only the owner's chat (OWNER_TELEGRAM_ID; FOOD_CHAT_ID or TELEGRAM_CHAT_ID
also work), or the owner in the food topic of the bot group, is accepted. Anything else is dropped without
being echoed, so a stranger who finds the bot cannot put text in front of the
agent. Message text is still untrusted input: it
describes food; it cannot widen what the agent may do.

Usage: listen.py [deadline_seconds]
"""

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Voice notes are transcribed locally by the split bot's transcriber (shared code).
sys.path.append(str(Path(__file__).resolve().parents[2] / "trips" / "splitbot"))
import transcribe  # noqa: E402

sys.path.append(str(Path(__file__).resolve().parents[2] / "bots"))
import route  # noqa: E402
import curlcfg  # noqa: E402  (bot token off the command line)

BOT = "food"

POLL_TIMEOUT = 45
APP_POLL_EVERY = 60
VOICE_KEYS = ("voice", "audio", "video_note")
STT_HINT = ("Meal log. Breakfast, lunch, dinner, snack. Chicken rice, kopi, teh, nasi lemak, "
            "eggs, protein shake, grams, half portion, no rice, kaya toast, salmon, steak. "
            "Workout: sets, reps, kilos, dumbbell bench press, row, squat, Romanian deadlift, "
            "lat pulldown, curls, ran 5k, weight 80 kg.")
STOP_WORDS = {"/stop", "stop", "/stopbot"}


def home() -> Path:
    return Path(os.environ.get("FOODBOT_HOME", Path.home() / ".foodbot"))


def bot_token() -> str:
    """FOOD_LOG_BOT_TOKEN is the name in the environment settings; FOOD_BOT_TOKEN also works."""
    return os.environ.get("FOOD_LOG_BOT_TOKEN") or os.environ.get("FOOD_BOT_TOKEN") or ""


def owner_chat() -> str:
    """The owner's Telegram id: OWNER_TELEGRAM_ID (FOOD_CHAT_ID or TELEGRAM_CHAT_ID also work)."""
    return os.environ.get("FOOD_CHAT_ID") or os.environ.get("OWNER_TELEGRAM_ID") or os.environ.get("TELEGRAM_CHAT_ID") or ""


def base() -> str:
    return os.environ.get("FOODBOT_API", "https://api.telegram.org")  # override for tests


def inbox() -> Path:
    p = home() / "inbox"
    p.mkdir(parents=True, exist_ok=True)
    return p


def curl_json(url: str, max_time: int) -> dict:
    out = curlcfg.run(["curl", "-sS", "--max-time", str(max_time)], url, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def parse_updates(resp: dict, chat_id: str, cfg: dict | None = None) -> tuple[int | None, list[dict]]:
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
        where = route.claim(m, chat_id, BOT)
        if where:
            events.append({"update_id": u["update_id"], "message_id": m.get("message_id"), "date": m.get("date"),
                           "text": "", "voice": None, "file_id": None, "claim": where, "where": route.where_from(m)})
            continue
        if not route.accepts(m, chat_id, BOT, cfg):
            continue  # not the owner, or another bot's topic: drop, never echo
        file_id, file_kind, file_error = pick_file(m)
        text = (m.get("caption") or m.get("text") or "").strip()
        if not file_id and not text and not file_error:
            continue
        events.append({
            "update_id": u["update_id"],
            "message_id": m.get("message_id"),
            "date": m.get("date"),
            "text": text,
            "voice": m.get("_voice"),
            "file_id": file_id,
            "file_kind": file_kind,
            **({"file_error": file_error} if file_error else {}),
            "where": route.where_from(m),
        })
    return last + 1, events


def transcribe_voices(api: str, resp: dict, chat_id: str, cfg: dict | None = None) -> None:
    """Turn the owner's voice notes into text, in place: download, transcribe
    locally, delete the audio at once. The message gets `_voice` =
    {"duration", "failed"} and the transcript as its text."""
    cfg = route.load() if cfg is None else cfg
    for u in resp.get("result") or []:
        m = u.get("message") or {}
        key = next((k for k in VOICE_KEYS if m.get(k)), None)
        if not key or m.get("text") or not route.accepts(m, chat_id, BOT, cfg):
            continue
        media, text, dest = m[key], None, None
        dur = int(media.get("duration") or 0)
        try:
            if dur <= transcribe.MAX_SECONDS:
                info = curl_json(f"{api}/getFile?file_id={media['file_id']}", 30)
                fpath = info["result"]["file_path"]
                dest = inbox() / f"voice-{u['update_id']}{Path(fpath).suffix or '.ogg'}"
                curlcfg.run(["curl", "-sS", "--fail", "--max-time", "60", "-o", str(dest)], f"{base()}/file/bot{bot_token()}/{fpath}", check=True)
                text = transcribe.transcribe(str(dest), STT_HINT)
        except (subprocess.CalledProcessError, KeyError, json.JSONDecodeError) as e:
            print(f"listen: voice note not fetched: {e}", file=sys.stderr)
        finally:
            if dest:
                dest.unlink(missing_ok=True)  # never keep the audio
        caption = (m.get("caption") or "").strip()
        # A failed note still reaches the agent (as a marker) so it can ask for text.
        m["text"] = " ".join(x for x in (caption, text or "") if x) or "(voice note)"
        m.pop("caption", None)
        m["_voice"] = {"duration": dur, "failed": not text,
                       **({"too_long": True} if dur > transcribe.MAX_SECONDS else {})}


MAX_FILE = 20 * 1024 * 1024  # Telegram's getFile limit


def pick_file(m: dict) -> tuple[str | None, str | None, str | None]:
    """(file_id, kind, error) for a message's photo, image file or PDF. kind is "photo" or "pdf"."""
    if m.get("photo"):
        return m["photo"][-1]["file_id"], "photo", None  # largest size
    d = m.get("document") or {}
    mime, name = d.get("mime_type", ""), (d.get("file_name") or "").lower()
    kind = "photo" if mime.startswith("image/") else "pdf" if mime == "application/pdf" or name.endswith(".pdf") else None
    if not kind:
        return None, None, None
    if int(d.get("file_size") or 0) > MAX_FILE:
        return None, kind, "larger than 20 MB; ask for a smaller file or a screenshot"
    return d["file_id"], kind, None


def save_event(api: str, ev: dict) -> dict:
    """Download the photo or PDF (if any) and write the event JSON into the inbox."""
    box = inbox()
    ev = dict(ev)
    file_id, kind = ev.pop("file_id"), ev.pop("file_kind", None) or "photo"
    ev["photo"] = ev["pdf"] = None
    if ev.get("claim"):
        where = ev.pop("claim")
        ev["text"] = route.save_claim(where.pop("key", BOT), where)
        ev["claimed"] = True
    if file_id:
        info = curl_json(f"{api}/getFile?file_id={file_id}", 30)
        fpath = info["result"]["file_path"]
        ext = ".pdf" if kind == "pdf" else Path(fpath).suffix or ".jpg"
        dest = box / f"{ev['update_id']}{ext}"
        token = bot_token()
        curlcfg.run(["curl", "-sS", "--fail", "--max-time", "60", "-o", str(dest)], f"{base()}/file/bot{token}/{fpath}", check=True)
        ev[kind] = str(dest)
    tmp = box / f"{ev['update_id']}.json.tmp"
    tmp.write_text(json.dumps(ev))
    tmp.rename(box / f"{ev['update_id']}.json")
    return ev


class AppQueue:
    """Polls the health app's queue (signed with the bot token) at most once a minute."""

    def __init__(self):
        self.last = 0.0
        self.warned = False

    def config(self):
        if os.environ.get("FOODBOT_API") and not os.environ.get("HEALTH_APP_CONFIG"):
            return None  # tests: never the real Worker
        try:
            import app_sync
            return app_sync.config()
        except (OSError, ValueError, ImportError):
            return None

    def poll(self) -> list[dict]:
        now = time.time()
        if now - self.last < APP_POLL_EVERY:
            return []
        self.last = now
        cfg = self.config()
        if not cfg:
            return []
        import app_sync
        try:
            items = app_sync.post(cfg, bot_token(), "/api/queue",
                                  {"op": "list", "ts": app_sync.now_ts()}, 10).get("items", [])
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
            if not self.warned:
                print(f"listen: health app queue not reached ({e}); will keep trying quietly", file=sys.stderr)
                self.warned = True
            return []
        seen_p = home() / "app_seen.json"
        seen = set(json.loads(seen_p.read_text())) if seen_p.exists() else set()
        new = [it["id"] for it in items if it.get("id") not in seen]
        if not new:
            return []
        seen_p.write_text(json.dumps(sorted(seen | set(new))))
        return [{"kind": "app_queue", "ids": new,
                 "what": sorted({it.get("kind", "?") for it in items if it.get("id") in new})}]


def pending() -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(inbox().glob("*.json"),
                                                      key=lambda p: int(p.stem))]


def emit(events: list[dict]) -> None:
    print("=== FOOD BOT EVENTS ===")
    for ev in events:
        print(json.dumps(ev))


def single_instance():
    """Hold an exclusive lock for this process's lifetime, or return None if
    another listener has it. Two listeners would both receive the same
    message, and the bot would answer it twice."""
    home().mkdir(parents=True, exist_ok=True)
    fh = open(home() / "listen.lock", "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def main() -> int:
    token = bot_token()
    chat = owner_chat()
    if not token or not chat:
        print("listen: FOOD_LOG_BOT_TOKEN and OWNER_TELEGRAM_ID must be set", file=sys.stderr)
        return 2
    lock = single_instance()
    if lock is None:
        print("listen: another listener is already running; not starting a second one", file=sys.stderr)
        return 6
    api = f"{base()}/bot{token}"
    deadline = time.time() + int(sys.argv[1]) if len(sys.argv) > 1 else None
    state = home() / "offset"

    left = pending()
    if left:
        emit(left)
        return 0

    offset = int(state.read_text()) if state.exists() else 0
    app = AppQueue()
    while True:
        if deadline and time.time() >= deadline:
            print("listen: deadline reached", file=sys.stderr)
            return 3
        app_events = app.poll()
        if app_events:
            emit(app_events)
            return 0
        try:
            resp = curl_json(
                f"{api}/getUpdates?timeout={POLL_TIMEOUT}&offset={offset}"
                "&allowed_updates=%5B%22message%22%5D", POLL_TIMEOUT + 15)
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            time.sleep(3)
            continue
        transcribe_voices(api, resp, chat)
        nxt, events = parse_updates(resp, chat)
        if nxt is None:
            continue
        stop = [e for e in events if e["text"].lower() in STOP_WORDS and not e["file_id"] and not e.get("claim")]
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
    sys.exit(main())
