#!/usr/bin/env python3
"""Send a message from the KnowledgeBot to the owner. Text from --text-file (or stdin).

  python3 knowledge/bot/send.py --text-file <file> [--file-it <thread id>] [--app "Open the app"] [--reply-to <message id>]
  python3 knowledge/bot/send.py --doc <file> ["caption"]      a document
  python3 knowledge/bot/send.py --photo <png> ["caption"]     an image

Replies go where the owner last wrote (the private chat or the bot's topic in the bot group,
bots/route.py). --file-it adds the "File it" button (callback file:<id>); --app adds a button that
opens the Knowledge app (in a group topic, a t.me link: see app_button). Plain text (no Markdown parsing), split at 4,000 characters. Prints
"send: ok <message_id>" (the last part's id). Never prints the token.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / "bots"))
import route  # noqa: E402
import curlcfg  # noqa: E402  (bot token off the command line)


def api_base() -> str:
    return os.environ.get("KNOWLEDGEBOT_API", "https://api.telegram.org")


def call(method: str, fields: dict, files: dict | None = None) -> dict:
    token = os.environ.get("KNOWLEDGE_BOT_TOKEN", "")
    if not token:
        raise SystemExit("send: KNOWLEDGE_BOT_TOKEN not set")
    url = f"{api_base()}/bot{token}/{method}"
    args = ["curl", "-sS", "--max-time", "60"]
    for k, v in fields.items():
        if v is None:
            continue
        # --form-string, not -F: a caption starting with @ or < would make curl read a local file
        args += ["--form-string" if files else "--data-urlencode", f"{k}={v if isinstance(v, str) else json.dumps(v)}"]
    for k, path in (files or {}).items():
        args += ["-F", f"{k}=@{path}"]
    out = curlcfg.run(args, url, capture_output=True, text=True).stdout
    try:
        d = json.loads(out)
    except ValueError:
        raise SystemExit("send: no answer from Telegram")
    if not d.get("ok"):
        raise SystemExit(f"send: telegram error: {d.get('description')}")
    return d["result"]


def chunks(text: str, n: int = 4000) -> list[str]:
    out = []
    while len(text) > n:
        cut = text.rfind("\n", 0, n)
        cut = cut if cut > n // 2 else n
        out.append(text[:cut])
        text = text[cut:].lstrip("\n")
    return out + [text] if text else out


def app_config() -> dict:
    try:
        return json.loads((HERE.parent / "app" / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def app_button(text: str, private: bool, cfg: dict | None = None) -> dict | None:
    """The App button. In the private chat it opens the Mini App. Telegram allows Mini App buttons
    only there, and the app needs Telegram's sign-in, so in a group the button is a t.me link: it
    opens the app directly once a Main Mini App is set in BotFather, else the bot's chat, where the
    App menu button is."""
    cfg = app_config() if cfg is None else cfg
    if private:
        return {"text": text, "web_app": {"url": cfg["url"]}} if cfg.get("url") else None
    bot = cfg.get("bot_username")
    return {"text": text, "url": f"https://t.me/{bot}?startapp"} if bot else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file-it")
    ap.add_argument("--app")
    ap.add_argument("--reply-to", type=int)
    ap.add_argument("--doc")
    ap.add_argument("--photo")
    ap.add_argument("--text-file", help="the message text (written with the Write tool, never typed into a shell)")
    ap.add_argument("caption", nargs="?")
    a = ap.parse_args(argv)
    owner = os.environ.get("KNOWLEDGE_CHAT_ID") or os.environ.get("OWNER_TELEGRAM_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    if not owner:
        raise SystemExit("send: OWNER_TELEGRAM_ID not set")
    home = Path(os.environ.get("KNOWLEDGEBOT_HOME", Path.home() / ".knowledgebot"))
    chat, thread = route.target("knowledge", home, owner)
    base = {"chat_id": chat, **({"message_thread_id": str(thread)} if thread is not None else {})}
    if a.doc or a.photo:
        path = a.doc or a.photo
        if not Path(path).is_file():
            raise SystemExit("send: no such file")
        r = call("sendDocument" if a.doc else "sendPhoto", {**base, "caption": a.caption or ""}, {"document" if a.doc else "photo": path})
        print(f"send: ok {r['message_id']}")
        return 0
    text = (Path(a.text_file).read_text(encoding="utf-8") if a.text_file else sys.stdin.read()).strip()
    if not text:
        raise SystemExit("send: empty message")
    buttons = []
    if a.file_it:
        buttons.append({"text": "📥 File it", "callback_data": f"file:{a.file_it}"})
    btn = app_button(a.app, str(chat) == str(owner)) if a.app else None
    if btn:
        buttons.append(btn)
    parts = chunks(text)
    last = None
    for i, part in enumerate(parts):
        fields = {**base, "text": part, "disable_web_page_preview": "true"}
        if i == 0 and a.reply_to:
            fields["reply_parameters"] = {"message_id": a.reply_to, "allow_sending_without_reply": True}
        if i == len(parts) - 1 and buttons:
            fields["reply_markup"] = {"inline_keyboard": [buttons]}
        last = call("sendMessage", fields)
    print(f"send: ok {last['message_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
