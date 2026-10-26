#!/usr/bin/env python3
"""The knowledge vault (knowledge/vault/): read it, check it, report on it.

  vault.py check              broken [[links]], duplicate filenames, missing or bad frontmatter;
                              exit 1 if a note written today has a problem (older ones are reported only)
  vault.py stats              counts by type and status, draft and [!review] backlog
  vault.py find <words>       notes whose title or text match, best first (title hits count most)

Links resolve by filename, whatever the folder (as Obsidian does): `[[Note Title]]`,
`[[Note Title|shown text]]`, `[[Note Title#Heading]]` and `[[raw/2026-05-01_slug]]`.
The vault's own rules are vault/CLAUDE.md; this script only reads.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAULT = Path(os.environ.get("KNOWLEDGE_VAULT", HERE.parent / "vault"))
LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
TYPES = {"concept", "entity", "concept-moc", "entity-moc", "theme-moc"}
STATUSES = {"stub", "draft", "reviewed"}
SKIP_LINKS = {"note title", "<concept-moc>", "<entity>", "raw/yyyy-mm-dd_slug", "..."}  # templates in the rules files


def notes(vault: Path = VAULT) -> dict[str, Path]:
    """Every markdown file, keyed by its lower-case name without .md."""
    out: dict[str, Path] = {}
    for p in sorted(vault.rglob("*.md")):
        out.setdefault(p.stem.lower(), p)
    return out


def frontmatter(text: str) -> dict[str, str]:
    """The simple key: value lines of a YAML front block (lists are kept as raw text)."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out, key = {}, None
    for line in text[3:end].splitlines():
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            out[key] = m.group(2).strip()
        elif key and line.strip():
            out[key] = (out[key] + "\n" + line.strip()).strip()
    return out


def link_target(raw: str) -> str:
    t = raw.strip().split("/")[-1].lower()
    return t[:-3] if t.endswith(".md") else t


def is_rules(p: Path, vault: Path) -> bool:
    return p.parent == vault and p.name in ("CLAUDE.md", "_PATTERN.md", "_HISTORY.md", "index.md", "log.md")


def check(vault: Path = VAULT, today: date | None = None) -> tuple[list[str], list[str]]:
    """(problems in notes updated today, older problems)."""
    today_s = (today or date.today()).isoformat()
    names = notes(vault)
    fresh, old = [], []
    seen = Counter(p.name for p in vault.rglob("*.md"))
    for name, n in seen.items():
        if n > 1:
            fresh.append(f"duplicate filename ({n}x): {name}: links to it are ambiguous")
    for key, p in names.items():
        text = p.read_text(encoding="utf-8")
        rel = p.relative_to(vault).as_posix()
        if is_rules(p, vault):
            continue
        fm = frontmatter(text)
        out = fresh if fm.get("updated", "") >= today_s or fm.get("created", "") >= today_s else old
        if not rel.startswith("raw/"):
            if not fm:
                out.append(f"{rel}: no frontmatter")
            else:
                if fm.get("type") not in TYPES:
                    out.append(f"{rel}: type is '{fm.get('type', '')}'")
                if fm.get("status") not in STATUSES:
                    out.append(f"{rel}: status is '{fm.get('status', '')}'")
                for k in ("created", "updated", "as_of"):
                    if fm.get(k) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fm[k]):
                        out.append(f"{rel}: {k} is '{fm[k]}'")
                if fm.get("type") == "entity" and not fm.get("as_of"):
                    out.append(f"{rel}: entity note without as_of")
        for m in LINK.finditer(text):
            t = link_target(m.group(1))
            if t not in names and t not in SKIP_LINKS and not t.startswith("<"):
                out.append(f"{rel}: broken link [[{m.group(1).strip()[:90]}]]")
    return fresh, old


def stats(vault: Path = VAULT) -> str:
    types, status = Counter(), Counter()
    review = 0
    for p in notes(vault).values():
        if is_rules(p, vault) or p.relative_to(vault).parts[0] == "raw":
            continue
        text = p.read_text(encoding="utf-8")
        fm = frontmatter(text)
        types[fm.get("type", "?")] += 1
        status[fm.get("status", "?")] += 1
        review += "> [!review]" in text
    raw = len(list((vault / "raw").glob("*.md")))
    inbox = [p for p in (vault / "To be filed").glob("*") if p.name != ".gitkeep"] if (vault / "To be filed").exists() else []
    return (f"Notes: " + (", ".join(f"{v} {k}" for k, v in types.most_common()) or "none yet") + f"; {raw} raw sources\n"
            + "Status: " + (", ".join(f"{v} {k}" for k, v in status.most_common()) or "-") + f"; {review} with a [!review] flag\n"
            + f"To be filed: {len(inbox)}")


def find(words: list[str], vault: Path = VAULT, limit: int = 10) -> list[tuple[int, str]]:
    ws = [w.lower() for w in words if w.strip()]
    hits = []
    for p in notes(vault).values():
        if is_rules(p, vault):
            continue
        title = p.stem.lower()
        text = p.read_text(encoding="utf-8").lower()
        score = sum(10 * (w in title) + min(5, text.count(w)) for w in ws)
        if score and all(w in title or w in text for w in ws):
            hits.append((score, p.relative_to(vault).as_posix()))
    return sorted(hits, key=lambda x: (-x[0], x[1]))[:limit]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("stats")
    s = sub.add_parser("find")
    s.add_argument("words", nargs="+")
    a = p.parse_args(argv)
    if a.cmd == "check":
        fresh, old = check()
        for x in fresh:
            print(f"! {x}")
        print(f"{len(fresh)} problem(s) in notes written or updated today; {len(old)} in older notes (first 40 below)")
        for x in old[:40]:
            print(f"  {x}")
        return 1 if fresh else 0
    if a.cmd == "stats":
        print(stats())
    elif a.cmd == "find":
        for score, rel in find(a.words):
            print(f"{score:3d}  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
