#!/usr/bin/env python3
"""Chinese character data for the character-recognition path: frequency and anatomy.

  hanzi.py char 清                 one character: rank, pinyin, meaning, parts, formation
  hanzi.py band 501 540            scaffolds (JSON) for the characters ranked 501-540, for lesson writers
  hanzi.py family 青               characters that share a component (the phonetic family)

Sources, downloaded once into the same cache as the dictionaries (validate.py):
- Frequency: Jun Da, "Modern Chinese character frequency list" (modern corpus, ~193 million
  characters), https://lingua.mtsu.edu/chinese-computing/statistics/char/list.php?Which=MO
  The top 1,000 characters cover about 89% of modern text, the top 2,000 about 97%.
- Anatomy: Make Me a Hanzi (Shaunak Kishore), dictionary.txt: decomposition (as an
  Ideographic Description Sequence), formation type and, for phono-semantic characters, the
  meaning part and the sound part. https://github.com/skishore/makemeahanzi
- Pinyin and meanings are checked against CC-CEDICT by validate.py.
"""

from __future__ import annotations

import argparse
import json
import os
import pickle
import re
import sys
import urllib.request
from pathlib import Path

CACHE = Path(os.environ.get("KNOWLEDGE_DICTS", Path.home() / ".cache" / "knowledge-dicts"))
JUNDA_URL = "https://lingua.mtsu.edu/chinese-computing/statistics/char/list.php?Which=MO"
MMAH_URL = "https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt"
SOURCES = {
    "freq": {"title": "Jun Da, Modern Chinese character frequency list", "url": JUNDA_URL},
    "anatomy": {"title": "Make Me a Hanzi (character decompositions and etymology)", "url": "https://github.com/skishore/makemeahanzi"},
}
# Make Me a Hanzi's etymology types, in the app's words (the traditional 六书 names in brackets)
FORMATION = {"pictographic": "pictograph", "ideographic": "ideograph", "pictophonetic": "phono-semantic"}
FORMATIONS = {"pictograph", "indicative", "ideograph", "phono-semantic", "other"}
IDS = set("⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻？")


def _fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url} (once) ...", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "knowledge-validate/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(r.read())
        tmp.rename(dest)
    return dest


def ranks() -> dict[str, int]:
    """{character: rank in modern Chinese (1 = most frequent)}."""
    pk = CACHE / "junda_mo.pickle"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    raw = _fetch(JUNDA_URL, CACHE / "junda_mo.html").read_bytes().decode("gb18030", errors="replace")
    out: dict[str, int] = {}
    for n, ch in re.findall(r"(?:^|<br>|<pre>|\n)(\d+)\t(\S)\t\d+\t", raw.replace("\r", "")):
        out.setdefault(ch, int(n))
    if len(out) < 5000:
        raise RuntimeError(f"the frequency list looks wrong ({len(out)} characters)")
    pk.write_bytes(pickle.dumps(out))
    return out


def anatomy() -> dict[str, dict]:
    """{character: Make Me a Hanzi entry: definition, pinyin, decomposition, etymology, radical}."""
    pk = CACHE / "mmah.pickle"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    out = {}
    for line in _fetch(MMAH_URL, CACHE / "mmah_dictionary.txt").read_text(encoding="utf-8").splitlines():
        if line.strip():
            e = json.loads(line)
            out[e["character"]] = {k: e.get(k) for k in ("definition", "pinyin", "decomposition", "etymology", "radical")}
    pk.write_bytes(pickle.dumps(out))
    return out


def components(ch: str, data: dict | None = None) -> list[str]:
    """The parts in a character's decomposition (its first level), without the layout symbols."""
    e = (data or anatomy()).get(ch) or {}
    return [c for c in (e.get("decomposition") or "") if c not in IDS]


def deep_components(ch: str, data: dict | None = None, depth: int = 3) -> set[str]:
    """Parts at any level (a part of a part counts): 清 → 氵 青 龶 月 ..."""
    data = data or anatomy()
    seen: set[str] = set()
    todo = [(ch, 0)]
    while todo:
        c, d = todo.pop()
        for p in components(c, data):
            if p not in seen:
                seen.add(p)
                if d + 1 < depth:
                    todo.append((p, d + 1))
    return seen


def scaffold(ch: str) -> dict:
    """What the sources say about one character: the starting point for a char card."""
    a = anatomy().get(ch) or {}
    ety = a.get("etymology") or {}
    parts = []
    if ety.get("type") == "pictophonetic":
        if ety.get("semantic"):
            parts.append({"part": ety["semantic"], "role": "meaning", "name": ety.get("hint") or ""})
        if ety.get("phonetic"):
            parts.append({"part": ety["phonetic"], "role": "sound"})
    else:
        parts = [{"part": p, "role": "form"} for p in components(ch)]
    return {"text": ch, "rank": ranks().get(ch), "pinyin": a.get("pinyin"), "definition": a.get("definition"),
            "decomposition": a.get("decomposition"), "formation": FORMATION.get(ety.get("type"), "other"),
            "etymology_hint": ety.get("hint"), "radical": a.get("radical"), "parts": parts}


def by_rank(lo: int, hi: int) -> list[str]:
    r = ranks()
    return [c for c, n in sorted(r.items(), key=lambda x: x[1]) if lo <= n <= hi]


def family(part: str, limit: int = 40) -> list[tuple[str, int]]:
    """Characters whose decomposition includes `part`, most frequent first."""
    r, a = ranks(), anatomy()
    hits = [(c, r[c]) for c, e in a.items() if c in r and part in (e.get("decomposition") or "")]
    return sorted(hits, key=lambda x: x[1])[:limit]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("char")
    c.add_argument("ch")
    b = sub.add_parser("band")
    b.add_argument("lo", type=int)
    b.add_argument("hi", type=int)
    f = sub.add_parser("family")
    f.add_argument("part")
    a = p.parse_args(argv)
    if a.cmd == "char":
        print(json.dumps(scaffold(a.ch), ensure_ascii=False, indent=1))
    elif a.cmd == "band":
        print(json.dumps([scaffold(ch) for ch in by_rank(a.lo, a.hi)], ensure_ascii=False, indent=1))
    else:
        print(" ".join(f"{ch}({n})" for ch, n in family(a.part)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
