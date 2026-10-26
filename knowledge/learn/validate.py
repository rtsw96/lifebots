#!/usr/bin/env python3
"""Check the learning content against SCHEMA.md and the dictionaries.

  validate.py                    every track; exit 1 on any error
  validate.py ja zh              only these tracks
  validate.py --no-dict          skip the dictionary checks (offline)
  validate.py --root DIR         check another learn folder (tests use a fixture); also KNOWLEDGE_LEARN

Japanese words are checked against JMdict (word + reading), Chinese words against CC-CEDICT
(characters + pinyin, citation tones), when a track in that language is checked. The
dictionaries are downloaded at run time into ~/.cache/knowledge-dicts (JMdict: EDRDG licence;
CC-CEDICT: CC BY-SA 4.0) and never committed. Nothing is downloaded with --no-dict.
Other languages have no automatic dictionary check: their cards cite the dictionary they were
checked against in `source`.

With no tracks yet (a fresh install), it prints "no tracks yet" and exits 0.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import pickle
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hanzi  # noqa: E402  (character frequency and anatomy, for char cards)
CACHE = Path(os.environ.get("KNOWLEDGE_DICTS", Path.home() / ".cache" / "knowledge-dicts"))
JMDICT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
CEDICT_URL = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz"

QTYPES = {"mcq", "multi", "tf", "cloze", "numeric", "order", "match", "free"}
PLACEMENT_QTYPES = {"mcq", "tf", "cloze", "numeric", "match"}
EVIDENCE = {"strong", "moderate", "weak", "mixed"}
KINDS = {"kana", "word", "sentence", "pattern", "concept", "read", "char"}
PLAIN: set[str] = set()   # tracks written for a layperson ("plain": true in tracks.json)
GRADED: set[str] = set()  # tracks whose concept cards grade their evidence ("graded": true)
STRAND_RE = re.compile(r"^[a-z][a-z0-9-]{0,19}$")  # "main" (default), "mine" (Your words) or any side path
TRACK_RE = re.compile(r"^[a-z]{2,12}$")             # the app's Worker accepts only these track ids
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
KANJI_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff々〆ヶ]")
KATAKANA_WORD = re.compile(r"^[\u30a0-\u30ffー]+$")

# Hepburn romaji for katakana (and hiragana via conversion), as taught in the app.
KANA = {
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o", "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
    "サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so", "タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
    "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no", "ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
    "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo", "ヤ": "ya", "ユ": "yu", "ヨ": "yo",
    "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro", "ワ": "wa", "ヲ": "wo", "ン": "n",
    "ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go", "ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
    "ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do", "バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
    "パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po", "ヴ": "vu",
    "キャ": "kya", "キュ": "kyu", "キョ": "kyo", "シャ": "sha", "シュ": "shu", "ショ": "sho", "チャ": "cha", "チュ": "chu", "チョ": "cho",
    "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo", "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo", "ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
    "リャ": "rya", "リュ": "ryu", "リョ": "ryo", "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo", "ジャ": "ja", "ジュ": "ju", "ジョ": "jo",
    "ビャ": "bya", "ビュ": "byu", "ビョ": "byo", "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
    "ティ": "ti", "ディ": "di", "トゥ": "tu", "ドゥ": "du", "ファ": "fa", "フィ": "fi", "フェ": "fe", "フォ": "fo", "フュ": "fyu",
    "ウィ": "wi", "ウェ": "we", "ウォ": "wo", "ヴァ": "va", "ヴィ": "vi", "ヴェ": "ve", "ヴォ": "vo",
    "シェ": "she", "ジェ": "je", "チェ": "che", "ツァ": "tsa", "ツィ": "tsi", "ツェ": "tse", "ツォ": "tso", "イェ": "ye",
    "テュ": "tyu", "デュ": "dyu",
}


def kata_to_hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


# ------------------------------------------------------------------ dictionaries

def _fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            f.write(r.read())
        tmp.rename(dest)
    return dest


def jmdict() -> dict[str, set[str]]:
    """{written form or kana form: set of readings in hiragana}."""
    pk = CACHE / "jmdict.pickle"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    import xml.etree.ElementTree as ET
    src = _fetch(JMDICT_URL, CACHE / "JMdict_e.gz")
    out: dict[str, set[str]] = {}
    # JMdict uses DTD entities (&n; &v5k; ...); expat refuses unknown entities, so blank them.
    data = gzip.decompress(src.read_bytes()).decode("utf-8")
    data = re.sub(r"<!DOCTYPE.*?]>", "", data, count=1, flags=re.S)
    data = re.sub(r"&([\w-]+);", r"\1", data)
    for entry in ET.fromstring(data).iter("entry"):
        kebs = [k.text for k in entry.iter("keb")]
        rebs = [r.text for r in entry.iter("reb")]
        for r in rebs:
            out.setdefault(r, set()).add(kata_to_hira(r))
            for k in kebs:
                out.setdefault(k, set()).add(kata_to_hira(r))
    pk.write_bytes(pickle.dumps(out))
    return out


TONE = {"a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ"}


def numbered_to_marks(syl: str) -> str:
    """'hui4' -> 'huì', 'lu:4' -> 'lǜ', 'ma5' -> 'ma'."""
    m = re.fullmatch(r"([a-zü:]+)([1-5])", syl.lower().replace("u:", "ü").replace("v", "ü"))
    if not m:
        return syl.lower().replace("u:", "ü")
    body, tone = m.group(1), int(m.group(2))
    if tone == 5:
        return body
    for v in ("a", "e"):
        if v in body:
            i = body.index(v)
            return body[:i] + TONE[v][tone - 1] + body[i + 1:]
    if "ou" in body:
        i = body.index("o")
        return body[:i] + TONE["o"][tone - 1] + body[i + 1:]
    for i in range(len(body) - 1, -1, -1):
        if body[i] in TONE:
            return body[:i] + TONE[body[i]][tone - 1] + body[i + 1:]
    return body


def norm_pinyin(s: str) -> str:
    s = unicodedata.normalize("NFC", s.lower())
    return re.sub(r"[\s'’·\-,，.。]", "", s)


def cedict() -> dict[str, set[str]]:
    """{simplified or traditional: set of normalised tone-marked pinyin}."""
    pk = CACHE / "cedict.pickle"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    src = _fetch(CEDICT_URL, CACHE / "cedict.txt.gz")
    out: dict[str, set[str]] = {}
    for line in gzip.decompress(src.read_bytes()).decode("utf-8").splitlines():
        m = re.match(r"^(\S+) (\S+) \[([^\]]+)\] /", line)
        if not m:
            continue
        trad, simp, pin = m.groups()
        marked = norm_pinyin("".join(numbered_to_marks(x) for x in pin.split()))
        for k in {trad, simp}:
            out.setdefault(k, set()).add(marked)
    pk.write_bytes(pickle.dumps(out))
    return out


# ------------------------------------------------------------------ checks

class Report:
    def __init__(self):
        self.errors: list[str] = []

    def err(self, where: str, msg: str):
        self.errors.append(f"{where}: {msg}")


def has_source(x) -> bool:
    if isinstance(x, list):
        return any(has_source(s) for s in x)
    return isinstance(x, dict) and bool(x.get("url") or x.get("cite") or x.get("dict") or x.get("note") or x.get("title"))


def check_question(q: dict, where: str, rep: Report, allowed=QTYPES):
    t = q.get("type")
    if t not in allowed:
        return rep.err(where, f"question type '{t}' not allowed here")
    if not str(q.get("prompt", "")).strip():
        rep.err(where, "question without a prompt")
    if t != "free" and not str(q.get("explain", "")).strip():
        rep.err(where, "question without an explain")
    if t in ("mcq", "multi"):
        opts = q.get("options") or []
        if not (2 <= len(opts) <= 5) or len(set(map(str, opts))) != len(opts):
            rep.err(where, "mcq needs 2-5 distinct options")
        ans = q.get("answer")
        idx = ans if isinstance(ans, list) else [ans]
        if t == "mcq" and not isinstance(ans, int):
            rep.err(where, "mcq answer must be an index")
        if not idx or any(not isinstance(i, int) or not 0 <= i < len(opts) for i in idx):
            rep.err(where, "answer index out of range")
        if any("all of the above" in str(o).lower() or "none of the above" in str(o).lower() for o in opts):
            rep.err(where, "no 'all/none of the above' options")
    elif t == "tf":
        if not isinstance(q.get("answer"), bool):
            rep.err(where, "tf answer must be true or false")
    elif t == "cloze":
        if q.get("prompt", "").count("___") != 1:
            rep.err(where, "cloze prompt needs exactly one ___")
        ans = q.get("answer")
        if not isinstance(ans, list) or not ans or not all(isinstance(a, str) and a for a in ans):
            rep.err(where, "cloze answer must be a list of accepted strings")
        elif q.get("options") and not any(a in q["options"] for a in ans):
            rep.err(where, "cloze options don't include an accepted answer")
    elif t == "numeric":
        if not isinstance(q.get("answer"), (int, float)) or not isinstance(q.get("tolerance"), (int, float)) or not 0 < q["tolerance"] < 1:
            rep.err(where, "numeric needs a number answer and a relative tolerance between 0 and 1")
    elif t == "order":
        if len(q.get("items") or []) < 3 or len(set(q["items"])) != len(q["items"]):
            rep.err(where, "order needs 3+ distinct items")
    elif t == "match":
        pairs = q.get("pairs") or []
        if not 3 <= len(pairs) <= 6 or any(len(p) != 2 for p in pairs) or len({p[0] for p in pairs}) != len(pairs) or len({p[1] for p in pairs}) != len(pairs):
            rep.err(where, "match needs 3-6 pairs with distinct sides")
    elif t == "free":
        if not q.get("rubric"):
            rep.err(where, "free question needs a rubric")


def check_char(c: dict, where: str, rep: Report, dicts: dict):
    """A Chinese character card (character recognition): the character, its pinyin and meaning
    (CC-CEDICT), its frequency rank (Jun Da), how it's formed and its parts (Make Me a Hanzi),
    and 1-3 common words that use it (CC-CEDICT)."""
    text, reading = c.get("text", ""), c.get("reading", "")
    if c.get("lang") != "zh" or len(text) != 1 or not reading or not c.get("meaning"):
        return rep.err(where, "char needs lang zh, one character as text, a reading and a meaning")
    if "zh" in dicts:
        got = dicts["zh"].get(text)
        if not got:
            rep.err(where, f"{text} is not in CC-CEDICT")
        elif norm_pinyin(reading) not in got:
            rep.err(where, f"{text} pinyin '{reading}', CC-CEDICT has {sorted(got)[:4]}")
    words = c.get("words") or []
    if not 1 <= len(words) <= 3:
        rep.err(where, "char needs 1-3 words that use it")
    for w in words:
        wt = w.get("text", "")
        if text not in wt or len(wt) < 2 or not (w.get("reading") and w.get("meaning")):
            rep.err(where, f"word '{wt}' must contain {text}, with a reading and a meaning")
        elif "zh" in dicts:
            wg = dicts["zh"].get(wt)
            if not wg:
                rep.err(where, f"word {wt} is not in CC-CEDICT")
            elif norm_pinyin(w["reading"]) not in wg:
                rep.err(where, f"word {wt} pinyin '{w['reading']}', CC-CEDICT has {sorted(wg)[:4]}")
    if c.get("formation") not in hanzi.FORMATIONS:
        rep.err(where, f"formation must be one of {sorted(hanzi.FORMATIONS)}")
    for x in c.get("parts") or []:
        if x.get("role") not in ("meaning", "sound", "form") or not x.get("part"):
            rep.err(where, "each part needs part and role (meaning, sound or form)")
    if "anatomy" in dicts:
        a = dicts["anatomy"].get(text)
        if a is None:
            rep.err(where, f"{text} is not in Make Me a Hanzi")
        else:
            ety = a.get("etymology") or {}
            want = hanzi.FORMATION.get(ety.get("type"))
            f = c.get("formation")
            ok = (want is None) or f == want or (f == "indicative" and want in ("ideograph", "pictograph"))
            if not ok:
                rep.err(where, f"{text} formation '{f}', Make Me a Hanzi says {want}")
            known = hanzi.deep_components(text, dicts["anatomy"]) | {ety.get("semantic"), ety.get("phonetic")}
            for x in c.get("parts") or []:
                if x.get("part") and x["part"] not in known:
                    rep.err(where, f"{x['part']} is not a part of {text} in Make Me a Hanzi")
                if want == "phono-semantic" and x.get("role") == "meaning" and ety.get("semantic") and x["part"] != ety["semantic"]:
                    rep.err(where, f"{text}: the meaning part is {ety['semantic']}, not {x['part']}")
                if want == "phono-semantic" and x.get("role") == "sound" and ety.get("phonetic") and x["part"] != ety["phonetic"]:
                    rep.err(where, f"{text}: the sound part is {ety['phonetic']}, not {x['part']}")
    if "ranks" in dicts and c.get("rank") is not None and dicts["ranks"].get(text) != c["rank"]:
        rep.err(where, f"{text} rank {c['rank']}, the frequency list has {dicts['ranks'].get(text)}")
    if not has_source(c.get("source")):
        rep.err(where, "char without a source")


def check_card(c: dict, track: str, where: str, rep: Report, dicts: dict):
    kind = c.get("kind")
    if kind not in KINDS:
        return rep.err(where, f"unknown kind '{kind}'")
    if kind == "kana":
        ch = c.get("char", "")
        if KANA.get(ch) != c.get("romaji") and KANA.get(ch.translate(str.maketrans({chr(h): chr(h + 0x60) for h in range(0x3041, 0x3097)}))) != c.get("romaji"):
            rep.err(where, f"kana {ch} romaji '{c.get('romaji')}' (expected {KANA.get(ch)})")
    elif kind == "word":
        lang, text, reading = c.get("lang"), c.get("text", ""), c.get("reading", "")
        if not (text and reading and c.get("meaning")):
            rep.err(where, "word needs text, reading and meaning")
        if lang == "ja" and "ja" in dicts:
            readings = dicts["ja"].get(text)
            if not readings:
                rep.err(where, f"{text} is not in JMdict")
            elif kata_to_hira(reading) not in readings:
                rep.err(where, f"{text} read '{reading}', JMdict has {sorted(readings)[:4]}")
        if lang == "zh" and "zh" in dicts:
            got = dicts["zh"].get(text)
            if not got:
                rep.err(where, f"{text} is not in CC-CEDICT")
            elif norm_pinyin(reading) not in got:
                rep.err(where, f"{text} pinyin '{reading}', CC-CEDICT has {sorted(got)[:4]}")
            if c.get("trad") and c["trad"] not in dicts["zh"]:
                rep.err(where, f"traditional {c['trad']} is not in CC-CEDICT")
        if not has_source(c.get("source")):
            rep.err(where, "word without a source")
    elif kind == "char":
        check_char(c, where, rep, dicts)
    elif kind == "sentence":
        if "".join(c.get("tiles") or []) != c.get("text"):
            rep.err(where, "tiles don't join up to the text")
        if not (c.get("meaning") and c.get("reading")):
            rep.err(where, "sentence needs a reading and a meaning")
        if not has_source(c.get("source")):
            rep.err(where, "sentence without a source")
    elif kind == "read":
        # reading practice: kana only (no kanji, so no furigana), with a meaning; a single katakana
        # word is checked against JMdict and its romaji against the kana table
        text = c.get("text", "")
        if c.get("lang") != "ja" or not text or not c.get("meaning"):
            rep.err(where, "read needs lang ja, text and meaning")
        if KANJI_RE.search(text):
            rep.err(where, "read text must be kana only (no kanji)")
        if c.get("script") not in ("hiragana", "katakana", "mixed"):
            rep.err(where, "read needs script: hiragana, katakana or mixed")
        if c.get("script") == "katakana":
            if not KATAKANA_WORD.match(text):
                rep.err(where, "a katakana read card is one katakana word")
            elif "ja" in dicts and text not in dicts["ja"]:
                rep.err(where, f"{text} is not in JMdict")
            if c.get("romaji") and c["romaji"] != kana_romaji(text):
                rep.err(where, f"romaji '{c['romaji']}' (expected {kana_romaji(text)})")
        if not has_source(c.get("source")):
            rep.err(where, "read without a source")
    elif kind in ("pattern", "concept"):
        if not str(c.get("explain", "")).strip():
            rep.err(where, f"{kind} without an explain")
        elif len(c["explain"].split()) > 160:
            rep.err(where, f"explain is {len(c['explain'].split())} words (keep it under 120)")
        qs = c.get("questions") or []
        if len(qs) < (2 if kind == "pattern" else 2):
            rep.err(where, f"{kind} needs at least 2 questions")
        for i, q in enumerate(qs):
            check_question(q, f"{where} q{i + 1}", rep)
        if not has_source(c.get("sources")) or not any(s.get("url") or s.get("cite") for s in c.get("sources") or []):
            rep.err(where, f"{kind} needs a source with a url or an exact citation")
        if track in GRADED and kind == "concept" and c.get("evidence") not in EVIDENCE:
            rep.err(where, "this track grades evidence: the concept needs evidence: strong, moderate, weak or mixed")
        elif c.get("evidence") is not None and c.get("evidence") not in EVIDENCE:
            rep.err(where, "evidence must be strong, moderate, weak or mixed")
        if track in PLAIN:
            check_plain(c, where, rep)


def check_plain(c: dict, where: str, rep: "Report") -> None:
    """A layperson's card never leans on papers the reader hasn't read: studies are described in
    plain words in the text, and their titles live only in the sources."""
    texts = [("explain", c.get("explain", ""))]
    for i, q in enumerate(c.get("questions") or []):
        texts += [(f"q{i + 1} prompt", q.get("prompt", "")), (f"q{i + 1} explain", q.get("explain", ""))]
    for name, t in texts:
        if re.search(r"\bet al\b", str(t)):
            rep.err(where, f"{name} cites a paper by author ('et al.'): say what the study showed in plain words; the title goes in sources")
    if len(str(c.get("explain", "")).split()) > 120:
        rep.err(where, f"explain is {len(c['explain'].split())} words (a plain track keeps it to 120)")


def kana_romaji(text: str) -> str | None:
    """Romaji for a katakana word, as the app builds it from the kana cards: longest match first,
    ッ doubles the next consonant, ー repeats the last vowel."""
    out, i, dbl = "", 0, False
    while i < len(text):
        c = text[i]
        if c in "ッっ":
            dbl, i = True, i + 1
            continue
        if c == "ー":
            out += out[-1] if out and out[-1] in "aeiou" else ""
            i += 1
            continue
        r, n = KANA.get(text[i:i + 2]), 2
        if not r:
            r, n = KANA.get(c), 1
        if not r:
            return None
        out += r[0] + r if dbl else r
        dbl, i = False, i + n
    return out


def check_track(tdir: Path, rep: Report, dicts: dict) -> dict:
    track = tdir.name
    ids: dict[str, str] = {}
    units = sorted((tdir / "units").glob("*.json")) if (tdir / "units").exists() else []
    unit_ids = []
    for f in units:
        where = f"{track}/units/{f.name}"
        try:
            u = json.loads(f.read_text())
        except ValueError as e:
            rep.err(where, f"bad JSON: {e}")
            continue
        m = re.match(r"(\d{2,3})-", f.name)
        if not m or u.get("id") != f"{track}-{m.group(1)}":
            rep.err(where, f"unit id '{u.get('id')}' should be {track}-NN matching the filename")
        unit_ids.append(u.get("id"))
        if not STRAND_RE.match(str(u.get("strand", "main"))):
            rep.err(where, f"strand '{u.get('strand')}' (a short lower-case name: main, mine or a side path like reading)")
        for k in ("title", "level", "goal", "lessons", "cards"):
            if not u.get(k) and not (k == "cards" and all(l.get("checkpoint") for l in u.get("lessons", []))):
                rep.err(where, f"unit without {k}")
        cards = {c.get("id"): c for c in u.get("cards", [])}
        for c in u.get("cards", []):
            cid = c.get("id")
            if not cid:
                rep.err(where, "card without an id")
                continue
            if cid in ids:
                rep.err(where, f"card id {cid} also in {ids[cid]}")
            ids[cid] = f.name
            check_card(c, track, f"{where} {cid}", rep, dicts)
        used = set()
        for l in u.get("lessons", []):
            if not l.get("id") or not l.get("title"):
                rep.err(where, "lesson without id or title")
            for cid in l.get("cards", []):
                if cid not in cards:
                    rep.err(where, f"lesson {l.get('id')} uses missing card {cid}")
                used.add(cid)
            if not l.get("checkpoint") and not 2 <= len(l.get("cards", [])) <= 10:
                rep.err(where, f"lesson {l.get('id')} has {len(l.get('cards', []))} cards (2-10)")
        for cid in set(cards) - used:
            rep.err(where, f"card {cid} is in no lesson")
    pf = tdir / "placement.json"
    if pf.exists():  # optional: without one, the path starts at the first unit
        p = json.loads(pf.read_text())
        bands = {b.get("band"): b for b in p.get("bands", [])}
        if not 4 <= len(bands) <= 6 or sorted(bands) != list(range(len(bands))):
            rep.err(f"{track}/placement.json", "needs 4-6 bands numbered from 0")
        for b in bands.values():
            if b.get("start") and b["start"] not in unit_ids:
                rep.err(f"{track}/placement.json", f"band {b.get('band')} starts at missing unit {b['start']}")
        per = {}
        for i, it in enumerate(p.get("items", [])):
            per[it.get("band")] = per.get(it.get("band"), 0) + 1
            check_question(it.get("q") or {}, f"{track}/placement.json item {i + 1}", rep, PLACEMENT_QTYPES)
            if it.get("q", {}).get("type") == "cloze" and not it["q"].get("options"):
                rep.err(f"{track}/placement.json item {i + 1}", "placement cloze needs options")
            if not has_source(it.get("source")):
                rep.err(f"{track}/placement.json item {i + 1}", "item without a source")
        for b in bands:
            if per.get(b, 0) < 3:
                rep.err(f"{track}/placement.json", f"band {b} has {per.get(b, 0)} items (3-4)")
    return {"units": len(units), "cards": len(ids)}


def check_tracks_file(meta, rep: Report) -> None:
    """tracks.json: each track has a short id the app accepts, a name, a short name, a colour and an about line."""
    seen = set()
    for i, t in enumerate(meta.get("tracks") or []):
        where = f"tracks.json track {i + 1}"
        tid = t.get("id", "")
        if not TRACK_RE.match(str(tid)):
            rep.err(where, f"id '{tid}' must be 2-12 lower-case letters (e.g. 'spanish', 'ja', 'history')")
        if tid in seen:
            rep.err(where, f"id '{tid}' is used twice")
        seen.add(tid)
        for k in ("name", "short", "about"):
            if not str(t.get(k, "")).strip():
                rep.err(where, f"track without {k}")
        if t.get("color") and not COLOR_RE.match(str(t["color"])):
            rep.err(where, "color must look like #3e8ef7")
        if t.get("lang") and not re.fullmatch(r"[a-z]{2,3}", str(t["lang"])):
            rep.err(where, "lang must be a language code like en, es, ja or zh")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("tracks", nargs="*")
    ap.add_argument("--no-dict", action="store_true")
    ap.add_argument("--root", help="the learn folder to check (default: this one, or KNOWLEDGE_LEARN)")
    a = ap.parse_args(argv)
    root = a.root or os.environ.get("KNOWLEDGE_LEARN")
    base = Path(root).resolve() if root else HERE
    tf = base / "tracks.json"
    meta = json.loads(tf.read_text()) if tf.exists() else {"tracks": []}
    if not meta.get("tracks"):
        print("no tracks yet: tell the bot what you want to learn and it writes the first one")
        print("0 error(s)")
        return 0
    want = a.tracks or [t["id"] for t in meta["tracks"]]
    PLAIN.update(t["id"] for t in meta["tracks"] if t.get("plain"))
    GRADED.update(t["id"] for t in meta["tracks"] if t.get("graded"))
    dicts = {}
    if not a.no_dict:
        langs = {t.get("lang") for t in meta["tracks"] if t["id"] in want}
        if "ja" in langs:
            dicts["ja"] = jmdict()
        if "zh" in langs:
            dicts["zh"] = cedict()
            dicts["anatomy"] = hanzi.anatomy()
            dicts["ranks"] = hanzi.ranks()
    rep = Report()
    check_tracks_file(meta, rep)
    unknown = set(want) - {t["id"] for t in meta["tracks"]}
    for u in sorted(unknown):
        rep.err(u, "not in tracks.json")
    for t in meta["tracks"]:
        if t["id"] in want:
            if not (base / t["id"]).is_dir():
                rep.err(t["id"], "no folder")
                continue
            n = check_track(base / t["id"], rep, dicts)
            print(f"{t['id']}: {n['units']} units, {n['cards']} cards")
    for e in rep.errors:
        print(f"! {e}")
    print(f"{len(rep.errors)} error(s)")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
