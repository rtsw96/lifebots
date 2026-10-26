#!/usr/bin/env python3
"""Your words: words the user met and couldn't read or didn't know, collected and filed as lessons.

Works for any language track. Chinese and Japanese words are checked against CC-CEDICT and
JMdict (downloaded at run time, never committed); for other languages the session looks each
word up in a dictionary before adding it.

  words.py --track T look WORD          dictionary entries (zh, ja), each Chinese character's parts and
                                        rank, and whether the track already teaches the word
  words.py --track T add --file F       collect the words in F, one per line (skips ones already
                                        collected or learnt); `add WORD ...` also works for plain words
  words.py --track T next               where the waiting words go (JSON): append to the open
                                        "Your words" lesson, start a lesson or a unit, or wait
  words.py --track T filed WORD --card ID --lesson ID
                                        mark a word as written into a lesson
  words.py --track T scan [FILE]        Chinese only: the words in a text (from FILE or stdin) the
                                        user probably can't read yet (JSON), easiest first, judged
                                        by character frequency against their level; the text is
                                        never saved
  words.py --track T drop WORD          forget a word still waiting to be filed

The words go into the track's "Your words" strand (`strand: "mine"`, units numbered 900 and on so
they never clash with the main path), up to 10 cards a lesson and 6 lessons a unit. A lesson the
user has done is never added to (its new cards would never come up for review), so later words
start the next lesson. knowledge/data/words.json keeps only the words, the track and dates: never
the photo, the sentence, the link or the place they came from.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import pickle
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / "bots"))
import settings  # noqa: E402  (the user's timezone)

DATA = Path(os.environ.get("KNOWLEDGE_DATA", HERE.parent / "data"))
LEARN = Path(os.environ.get("KNOWLEDGE_LEARN", HERE.parent / "learn"))
STRAND = "mine"
PER_LESSON, PER_UNIT = 10, 6
FIRST_UNIT = 900
DEFAULT_LEVEL = 500   # Chinese: characters assumed known before the user takes a placement test
MAX_SCAN = 20         # words a scan returns
HAN = re.compile(r"[㐀-鿿豈-﫿]")
TRACK_RE = re.compile(r"^[a-z]{2,12}$")


def _learn():
    sys.path.insert(0, str(HERE.parent / "learn"))
    import hanzi  # noqa: E402
    import validate  # noqa: E402
    return hanzi, validate


def track_lang(track: str) -> str:
    try:
        ts = json.loads((LEARN / "tracks.json").read_text()).get("tracks") or []
    except (OSError, ValueError):
        ts = []
    t = next((x for x in ts if x.get("id") == track), None)
    if t is None:
        raise SystemExit(f"no track {track!r} in tracks.json: start the track first")
    return t.get("lang") or "en"


# ------------------------------------------------------------------ the log (words only)

def log_path() -> Path:
    return DATA / "words.json"


def load_all() -> dict:
    p = log_path()
    return json.loads(p.read_text()) if p.exists() else {}


def load(track: str) -> dict:
    return load_all().get(track) or {"words": []}


def save(track: str, log: dict) -> None:
    data = load_all()
    data[track] = log
    DATA.mkdir(parents=True, exist_ok=True)
    log_path().write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n")


# ------------------------------------------------------------------ the track's lessons

def units(track: str) -> list[tuple[Path, dict]]:
    d = LEARN / track / "units"
    return [(f, json.loads(f.read_text())) for f in sorted(d.glob("*.json"))] if d.exists() else []


def taught(track: str) -> dict[str, tuple[str, str]]:
    """{word or character: (lesson id, how) where the track already has it}."""
    out: dict[str, tuple[str, str]] = {}
    for _, u in units(track):
        where = {cid: l["id"] for l in u.get("lessons", []) for cid in l.get("cards", [])}
        for c in u.get("cards", []):
            lesson = where.get(c.get("id"), u.get("id"))
            if c.get("kind") in ("word", "char", "read") and c.get("text"):
                out.setdefault(c["text"], (lesson, f"{c['kind']} card"))
            for w in c.get("words") or []:
                out.setdefault(w.get("text", ""), (lesson, f"a word on the {c.get('text')} card"))
    out.pop("", None)
    return out


def done_lessons() -> set[str]:
    p = DATA / "progress.json"
    return set(json.loads(p.read_text()).get("lessons", {})) if p.exists() else set()


# ------------------------------------------------------------------ dictionaries

def cedict_entries() -> dict[str, list[dict]]:
    """{simplified or traditional: [{simp, trad, pinyin, defs, proper}]} from the cached CC-CEDICT.
    `proper`: the dictionary capitalises the pinyin of names (people, places, brands)."""
    hanzi, v = _learn()
    pk = v.CACHE / "cedict_defs2.pickle"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    src = v._fetch(v.CEDICT_URL, v.CACHE / "cedict.txt.gz")
    out: dict[str, list[dict]] = {}
    for line in gzip.decompress(src.read_bytes()).decode("utf-8").splitlines():
        m = re.match(r"^(\S+) (\S+) \[([^\]]+)\] /(.*)/\s*$", line)
        if not m:
            continue
        trad, simp, pin, defs = m.groups()
        e = {"simp": simp, "trad": trad, "pinyin": " ".join(v.numbered_to_marks(x) for x in pin.split()),
             "defs": [d for d in defs.split("/") if d], "proper": pin[:1].isupper()}
        for k in {simp, trad}:
            out.setdefault(k, []).append(e)
    pk.write_bytes(pickle.dumps(out))
    return out


def dictionary(lang: str):
    """A lookup for the track's language: {word: entries} for zh and ja, else None (no automatic check)."""
    if lang == "zh":
        return cedict_entries()
    if lang == "ja":
        _, v = _learn()
        return v.jmdict()
    return None


def look(track: str, word: str) -> dict:
    lang = track_lang(track)
    t = taught(track).get(word)
    out = {"text": word, "lang": lang, "taught": t and {"lesson": t[0], "as": t[1], "done": t[0] in done_lessons()}}
    if lang == "zh":
        hanzi, _ = _learn()
        chars = [c for c in word if HAN.match(c)]
        out["cedict"] = cedict_entries().get(word, [])
        out["chars"] = [{k: s.get(k) for k in ("text", "rank", "pinyin", "definition", "formation", "parts")}
                        for s in (hanzi.scaffold(c) for c in dict.fromkeys(chars))]
    elif lang == "ja":
        out["jmdict_readings"] = sorted(dictionary("ja").get(word, set()))
    else:
        out["dictionary"] = "none built in: look the word up in a named dictionary and cite it on the card"
    return out


def add(track: str, words: list[str], today: str | None = None, dic=False) -> list[str]:
    """Collect words; returns one line per word for the session. A word the track already has
    is skipped only when the user has done that lesson (placement may have skipped it).
    `dic`: a dictionary to check against (tests pass one); by default the track language's."""
    lang = track_lang(track)
    log, have, done = load(track), taught(track), done_lessons()
    dic = dictionary(lang) if dic is False else dic
    seen = {w["text"] for w in log["words"]}
    today = today or datetime.now(settings.tz()).date().isoformat()
    name = {"zh": "CC-CEDICT", "ja": "JMdict"}.get(lang, "the dictionary")
    lines = []
    for w in dict.fromkeys(x.strip() for x in words):
        if not w:
            continue
        if lang == "zh" and not HAN.search(w):
            lines.append(f"{w}: not Chinese characters")
        elif w in seen:
            lines.append(f"{w}: already collected")
        elif w in have and have[w][0] in done:
            lines.append(f"{w}: already learnt in {have[w][0]} ({have[w][1]}); it comes back in reviews")
        elif dic is not None and w not in dic:
            lines.append(f"{w}: not in {name}; use the dictionary form, or split it into dictionary words")
        else:
            log["words"].append({"text": w, "added": today, "status": "pending"})
            seen.add(w)
            lines.append(f"{w}: added" + (f" (also in {have[w][0]}, not reached yet)" if w in have else ""))
    save(track, log)
    return lines


def next_unit_no(us: list[tuple[Path, dict]]) -> int:
    taken = {int(m.group(1)) for f, _ in us if (m := re.match(r"(\d{2,3})-", f.name))}
    n = FIRST_UNIT
    while n in taken:
        n += 1
    return n


def plan(track: str, log: dict | None = None, done: set[str] | None = None) -> dict:
    """Where the waiting words go next."""
    log = log or load(track)
    done = done_lessons() if done is None else done
    pending = [w["text"] for w in log["words"] if w["status"] == "pending"]
    us = units(track)
    mine = [(f, u) for f, u in us if u.get("strand") == STRAND]
    out: dict = {"track": track, "pending": pending}
    if not pending:
        return {**out, "action": "nothing"}
    if mine:
        f, u = mine[-1]
        lessons = [l for l in u["lessons"] if not l.get("checkpoint")]
        last = lessons[-1] if lessons else None
        if last and last["id"] not in done and len(last["cards"]) < PER_LESSON:
            room = PER_LESSON - len(last["cards"])
            return {**out, "action": "append", "file": str(f), "unit": u["id"], "lesson": last["id"],
                    "words": pending[:room]}
    if len(pending) < 2:
        return {**out, "action": "wait", "why": "a new lesson needs 2 words; this one joins the next"}
    if mine and len([l for l in mine[-1][1]["lessons"] if not l.get("checkpoint")]) < PER_UNIT:
        f, u = mine[-1]
        k = len([l for l in u["lessons"] if not l.get("checkpoint")]) + 1
        return {**out, "action": "new-lesson", "file": str(f), "unit": u["id"], "lesson": f"{u['id']}-{k}",
                "words": pending[:PER_LESSON]}
    n = next_unit_no(us)
    nth = len(mine) + 1
    name = "your-words" if nth == 1 else f"your-words-{nth}"
    return {**out, "action": "new-unit", "file": str(LEARN / track / "units" / f"{n}-{name}.json"),
            "unit": f"{track}-{n}", "lesson": f"{track}-{n}-1", "words": pending[:PER_LESSON]}


def filed(track: str, word: str, card: str, lesson: str) -> bool:
    log = load(track)
    for w in log["words"]:
        if w["text"] == word and w["status"] == "pending":
            w.update(status="filed", card=card, lesson=lesson)
            save(track, log)
            return True
    return False


def drop(track: str, word: str) -> bool:
    log = load(track)
    keep = [w for w in log["words"] if not (w["text"] == word and w["status"] == "pending")]
    if len(keep) == len(log["words"]):
        return False
    save(track, {**log, "words": keep})
    return True


# ------------------------------------------------------------------ Chinese: what can't they read yet?

def level(track: str) -> tuple[int, bool, set[str]]:
    """(rank up to which characters count as known, whether the user is placed, characters
    learnt in lessons they've done). Placement at a unit means the ranks before it are known."""
    p = DATA / "progress.json"
    prog = json.loads(p.read_text()) if p.exists() else {}
    st = (prog.get("tracks") or {}).get(track) or {}
    done = set(prog.get("lessons") or {})
    known: set[str] = set()
    lvl, placed = DEFAULT_LEVEL, bool(st.get("placed"))
    for _, u in units(track):
        where = {cid: l["id"] for l in u.get("lessons", []) for cid in l.get("cards", [])}
        ranks = [c["rank"] for c in u.get("cards", []) if c.get("kind") == "char" and c.get("rank")]
        if placed and u.get("id") == st.get("start"):
            lvl = (min(ranks) - 1) if ranks else lvl
        for c in u.get("cards", []):
            if where.get(c.get("id")) in done:
                known.update(ch for ch in c.get("text", "") if HAN.match(ch))
    if placed and not st.get("start"):
        lvl = 0
    return lvl, placed, known


def segment(text: str, dic: dict) -> list[str]:
    """Words by longest dictionary match, Chinese characters only."""
    out, i = [], 0
    while i < len(text):
        if not HAN.match(text[i]):
            i += 1
            continue
        for n in range(min(8, len(text) - i), 0, -1):
            w = text[i:i + n]
            if n == 1 or (w in dic and all(HAN.match(c) for c in w)):
                out.append(w)
                i += n
                break
    return out


def _is_name(entries: list[dict]) -> bool:
    """CC-CEDICT gives names (people, places, brands) capitalised pinyin."""
    return bool(entries) and all(e.get("proper") for e in entries)


def scan(track: str, text: str) -> dict:
    if track_lang(track) != "zh":
        raise SystemExit("scan works for Chinese tracks; for other languages, pick the words yourself")
    hanzi, _ = _learn()
    dic, ranks = cedict_entries(), hanzi.ranks()
    lvl, placed, known = level(track)
    have, done, log = taught(track), done_lessons(), load(track)
    collected = {w["text"] for w in log["words"]}
    words = segment(text, dic)
    chars = [c for w in words for c in w]
    easy = lambda c: c in known or (ranks.get(c) or 10 ** 6) <= lvl  # noqa: E731
    seen: dict[str, dict] = {}
    for w in words:
        hard = [c for c in w if not easy(c)]
        if not hard:
            continue
        if w in seen:
            seen[w]["count"] += 1
            continue
        entries = dic.get(w, [])
        real = [e for e in entries if not e.get("proper")] or entries
        status = ("learnt" if w in have and have[w][0] in done else "collected" if w in collected else "new")
        seen[w] = {"text": w, "pinyin": real[0]["pinyin"] if real else "",
                   "meaning": re.sub(r"\s*CL:\S+", "", real[0]["defs"][0]).strip() if real else "",
                   "rank": max((ranks.get(c) or 10 ** 5) for c in hard), "count": 1,
                   "name": _is_name(entries), "in_dictionary": bool(entries), "status": status}
    found = sorted(seen.values(), key=lambda x: (x["name"], not x["in_dictionary"], x["status"] != "new", x["rank"]))
    return {"level": lvl, "placed": placed, "characters": len(chars),
            "known_share": round(sum(easy(c) for c in chars) / len(chars), 2) if chars else None,
            "words": found[:MAX_SCAN], "more": max(0, len(found) - MAX_SCAN)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--track", required=True, help="the track's id in tracks.json")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("look").add_argument("word")
    ad = sub.add_parser("add")
    ad.add_argument("words", nargs="*")
    ad.add_argument("--file", help="one word per line (text from a message or a photo never goes on a command line)")
    sub.add_parser("next")
    f = sub.add_parser("filed")
    f.add_argument("word")
    f.add_argument("--card", required=True)
    f.add_argument("--lesson", required=True)
    sub.add_parser("scan").add_argument("file", nargs="?")
    sub.add_parser("drop").add_argument("word")
    a = p.parse_args(argv)
    if not TRACK_RE.match(a.track):
        raise SystemExit("--track: the track id (2-12 lower-case letters)")
    t = a.track
    if a.cmd == "look":
        print(json.dumps(look(t, a.word), ensure_ascii=False, indent=1))
    elif a.cmd == "add":
        ws = list(a.words) + (Path(a.file).read_text(encoding="utf-8").splitlines() if a.file else [])
        if not any(w.strip() for w in ws):
            raise SystemExit("add: no words (give them in --file, one per line)")
        print("\n".join(add(t, ws)))
    elif a.cmd == "next":
        print(json.dumps(plan(t), ensure_ascii=False, indent=1))
    elif a.cmd == "scan":
        text = Path(a.file).read_text(encoding="utf-8") if a.file else sys.stdin.read()
        print(json.dumps(scan(t, text), ensure_ascii=False, indent=1))
    elif a.cmd == "drop":
        if not drop(t, a.word):
            print(f"{a.word} is not waiting", file=sys.stderr)
            return 1
        print(f"{a.word}: dropped")
    else:
        if not filed(t, a.word, a.card, a.lesson):
            print(f"{a.word} is not waiting", file=sys.stderr)
            return 1
        print(f"{a.word}: filed in {a.lesson}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
