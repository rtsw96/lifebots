#!/usr/bin/env python3
"""KnowledgeBot helpers: Q&A threads, filing them into the vault, the inbox, the speaking language,
the daily reminder.

  kb.py thread new --q-file F [--note concepts/x.md]       start a thread with the question in file F; prints its id
                                            (--q "question" also works, for fixed text only)
  kb.py thread add <id> --role q|a          append the owner's follow-up (q) or the answer (a), text on stdin
  kb.py thread show <id>                    print a thread
  kb.py thread last                         the id of the most recent thread
  kb.py file <id>                           archive the thread verbatim to vault/raw/YYYY-MM-DD_qa_<slug>.md
                                            (prints the path; the agent then atomises it by the vault's rules)
  kb.py threads prune [--days 30]           delete threads never filed, older than N days
  kb.py done --update-id N                  remove an inbox event and its downloaded file
  kb.py lang <code>|auto                    the language voice notes are transcribed in (en, es, ja, zh, ...)
  kb.py status                              streak, XP today, reviews due (from knowledge/data/progress.json)
  kb.py remind                              seconds until today's reminder is due (0 = send it now; -1 = not today)
  kb.py tracks                              the tracks written so far (none on a fresh install: ask what to learn)
  kb.py reminded                            remember that today's reminder went out

Threads live in knowledge/data/threads/ (bot data, committed to the user's private copy) so a
File it tap works after the session restarts. A thread is filed only when the user taps File it.
Times are in the timezone from settings.json (bots/settings.py).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
KNOW = HERE.parent
sys.path.append(str(KNOW.parent / "bots"))
import settings  # noqa: E402  (the user's timezone)

VAULT = Path(os.environ.get("KNOWLEDGE_VAULT", KNOW / "vault"))
DATA = Path(os.environ.get("KNOWLEDGE_DATA", KNOW / "data"))
LEARN = Path(os.environ.get("KNOWLEDGE_LEARN", KNOW / "learn"))
TZ = settings.tz()
GOAL_XP = 60
ID_RE = re.compile(r"^t\d{14}$")
LANG_RE = re.compile(r"^([a-z]{2,3}|auto)$")


def now() -> datetime:
    return datetime.now(TZ)


def home() -> Path:
    return Path(os.environ.get("KNOWLEDGEBOT_HOME", Path.home() / ".knowledgebot"))


def threads() -> Path:
    p = DATA / "threads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def slug(s: str, n: int = 50) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:n] or "question"


def thread_path(tid: str) -> Path:
    if not ID_RE.match(tid or ""):
        raise SystemExit(f"bad thread id {tid!r}")
    p = threads() / f"{tid}.md"
    if not p.exists():
        raise SystemExit(f"no thread {tid}")
    return p


def new_thread(q: str, note: str | None = None) -> str:
    t = now()
    tid = "t" + t.strftime("%Y%m%d%H%M%S")
    while (threads() / f"{tid}.md").exists():
        t += timedelta(seconds=1)
        tid = "t" + t.strftime("%Y%m%d%H%M%S")
    head = [f"# {q.strip().splitlines()[0][:120]}", "", f"- Thread: {tid}", f"- Started: {t.isoformat(timespec='minutes')}", "- Filed: no"]
    if note:
        head.append(f"- About: [[{Path(note).stem}]]")
    (threads() / f"{tid}.md").write_text("\n".join(head) + f"\n\n## Question ({t.strftime('%H:%M')})\n\n{q.strip()}\n")
    (home()).mkdir(parents=True, exist_ok=True)
    (home() / "last_thread").write_text(tid)
    return tid


def add(tid: str, role: str, text: str) -> None:
    p = thread_path(tid)
    label = "Question" if role == "q" else "Answer"
    with p.open("a") as f:
        f.write(f"\n## {label} ({now().strftime('%H:%M')})\n\n{text.strip()}\n")
    (home()).mkdir(parents=True, exist_ok=True)
    (home() / "last_thread").write_text(tid)


def file_thread(tid: str) -> Path:
    """Copy the thread verbatim into raw/ (House Rule #10). Filing twice returns the same file."""
    p = thread_path(tid)
    text = p.read_text()
    m = re.search(r"^- Filed: (raw/\S+)$", text, re.M)
    if m:
        return VAULT / m.group(1)
    title = text.splitlines()[0].lstrip("# ").strip()
    day = re.search(r"^- Started: (\d{4}-\d{2}-\d{2})", text, re.M).group(1)
    raw = VAULT / "raw" / f"{day}_qa_{slug(title)}.md"
    n = 2
    while raw.exists():
        raw = VAULT / "raw" / f"{day}_qa_{slug(title)}_{n}.md"
        n += 1
    raw.write_text(text)
    rel = raw.relative_to(VAULT).as_posix()
    p.write_text(text.replace("- Filed: no", f"- Filed: {rel}", 1))
    return raw


def prune(days: int) -> int:
    cut = now() - timedelta(days=days)
    gone = 0
    for p in threads().glob("t*.md"):
        text = p.read_text()
        if "- Filed: no" in text:
            started = datetime.strptime(p.stem[1:], "%Y%m%d%H%M%S").replace(tzinfo=TZ)
            if started < cut:
                p.unlink()
                gone += 1
    return gone


def progress() -> dict:
    try:
        return json.loads((DATA / "progress.json").read_text())
    except (OSError, ValueError):
        return {}


def tracks() -> list[dict]:
    try:
        return json.loads((LEARN / "tracks.json").read_text()).get("tracks") or []
    except (OSError, ValueError):
        return []


def status(p: dict, t: datetime) -> str:
    if not tracks():
        return "No topics yet: tell me what you'd like to learn (a language, a science, history, anything) and I'll write your first lessons."
    if not p:
        return "No learning yet: open the App for your first lesson."
    today = t.date().isoformat()
    xp = (p.get("xp") or {}).get(today, 0)
    due = sum(1 for c in (p.get("cards") or {}).values() if (c.get("due") or 0) <= t.timestamp() * 1000)
    st = p.get("streak") or {}
    alive = st.get("last") in (today, (t.date() - timedelta(days=1)).isoformat())
    return (f"Streak {st.get('count', 0) if alive else 0} day(s){' (done today)' if st.get('last') == today else ''} · "
            f"XP today {xp}/{GOAL_XP} · {due} review(s) due · {len(p.get('lessons') or {})} lesson(s) done")


def remind_in(p: dict, t: datetime) -> int:
    """Seconds until the reminder (the user's time, default 20:00); 0 when due; -1 when not needed today."""
    today = t.date().isoformat()
    if not p or (p.get("xp") or {}).get(today, 0) > 0:
        return -1
    try:
        if (home() / "reminded").read_text().strip() == today:
            return -1
    except OSError:
        pass
    hh, mm = map(int, ((p.get("settings") or {}).get("remind") or "20:00").split(":"))
    at = t.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return 0 if t >= at else int((at - t).total_seconds())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    th = sub.add_parser("thread")
    th.add_argument("op", choices=["new", "add", "show", "last"])
    th.add_argument("id", nargs="?")
    th.add_argument("--q")
    th.add_argument("--q-file", help="the question, from a file (message text never goes on a command line)")
    th.add_argument("--note")
    th.add_argument("--role", choices=["q", "a"])
    f = sub.add_parser("file")
    f.add_argument("id")
    pr = sub.add_parser("threads")
    pr.add_argument("op", choices=["prune"])
    pr.add_argument("--days", type=int, default=30)
    d = sub.add_parser("done")
    d.add_argument("--update-id", required=True)
    lg = sub.add_parser("lang")
    lg.add_argument("lang")
    sub.add_parser("status")
    sub.add_parser("tracks")
    sub.add_parser("remind")
    sub.add_parser("reminded")
    a = ap.parse_args(argv)
    if a.cmd == "thread":
        if a.op == "new":
            q = Path(a.q_file).read_text(encoding="utf-8") if a.q_file else a.q
            if not (q or "").strip():
                raise SystemExit("--q-file (or --q) is needed")
            print(new_thread(q, a.note))
        elif a.op == "add":
            add(a.id, a.role or "a", sys.stdin.read())
        elif a.op == "show":
            print(thread_path(a.id).read_text())
        else:
            try:
                print((home() / "last_thread").read_text().strip())
            except OSError:
                print("")
    elif a.cmd == "file":
        print(file_thread(a.id).relative_to(VAULT).as_posix())
    elif a.cmd == "threads":
        print(f"pruned {prune(a.days)} unfiled thread(s)")
    elif a.cmd == "done":
        box = home() / "inbox"
        for p in list(box.glob(f"{a.update_id}.json")) + list(box.glob(f"{a.update_id}-*")):
            p.unlink(missing_ok=True)
    elif a.cmd == "lang":
        if not LANG_RE.match(a.lang):
            raise SystemExit("lang: a language code like en, es, ja or zh, or auto")
        home().mkdir(parents=True, exist_ok=True)
        (home() / "stt_lang").write_text(a.lang)
        print(f"voice notes now transcribed as {a.lang}")
    elif a.cmd == "status":
        print(status(progress(), now()))
    elif a.cmd == "tracks":
        ts = tracks()
        print("\n".join(f"{t['id']}: {t.get('name', '')} ({t.get('lang', 'en')})" for t in ts) or "no tracks yet")
    elif a.cmd == "remind":
        print(remind_in(progress(), now()))
    elif a.cmd == "reminded":
        home().mkdir(parents=True, exist_ok=True)
        (home() / "reminded").write_text(now().date().isoformat())
    return 0


if __name__ == "__main__":
    sys.exit(main())
