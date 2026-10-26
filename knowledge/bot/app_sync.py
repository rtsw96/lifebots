#!/usr/bin/env python3
"""Sync the Knowledge app (Cloudflare Worker + KV) with the repo.

The repo is the record. The app reads two bundles the bot uploads (the vault and the learning
content, gzipped JSON) and keeps the user's learning progress in KV. Things done in the app
that change the repo (approving a draft note, editing or deleting a note, capturing a source,
asking a question, a written answer, reporting a mistake, a placement that needs new units,
a new topic to learn) wait in the Worker's queue until the bot applies them.

  app_sync.py push            build both bundles; upload the ones that changed (and meta)
  app_sync.py pull            save the app's progress to knowledge/data/progress.json (bot data)
  app_sync.py queue           print the queued items (JSON lines)
  app_sync.py apply           apply queued items to the vault; print what the agent must handle
                              (TOPIC, ASK, ANSWER, REPORT, CURRICULUM lines); ack what was applied
  app_sync.py settings JSON   merge settings into the app's progress (e.g. '{"daily_min": 15}')
  app_sync.py --dry-run       build the bundles and print their sizes (no config or token needed)

Bundles and meta go straight to KV through the Cloudflare API (CLOUDFLARE_API_TOKEN,
CLOUDFLARE_ACCOUNT_ID), so a large upload costs the Worker nothing. Queue and settings calls go
to the Worker, signed with HMAC_SHA256(key = HMAC_SHA256("KnowledgeSync", bot token), body).
Never prints a token. Not configured (no knowledge/app/config.json): one line, exit 0.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
KNOW = HERE.parent
sys.path.append(str(KNOW.parent / "bots"))
import settings  # noqa: E402  (the user's timezone: the app counts days in it)

VAULT = Path(os.environ.get("KNOWLEDGE_VAULT", KNOW / "vault"))
LEARN = Path(os.environ.get("KNOWLEDGE_LEARN", KNOW / "learn"))
DATA = Path(os.environ.get("KNOWLEDGE_DATA", KNOW / "data"))
APP = KNOW / "app"
CONFIG = APP / "config.json"
SKIP = {"CLAUDE.md", "_PATTERN.md", "_HISTORY.md", "index.md", "log.md"}


def token() -> str:
    return os.environ.get("KNOWLEDGE_BOT_TOKEN", "")


def config() -> dict | None:
    p = Path(os.environ.get("KNOWLEDGE_APP_CONFIG") or CONFIG)
    if not p.exists():
        return None
    cfg = json.loads(p.read_text())
    if not cfg.get("url"):
        return None
    if not cfg.get("kv"):
        m = re.search(r'^id = "([0-9a-f]{32})"$', (APP / "wrangler.toml").read_text(), re.M)
        cfg["kv"] = m.group(1) if m else None
    return cfg


def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sign(tok: str, body: bytes) -> str:
    key = hmac.new(b"KnowledgeSync", tok.encode(), hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def signed(cfg: dict, path: str, obj: dict, max_time: int = 30) -> dict:
    body = json.dumps({**obj, "ts": now_ts()}, separators=(",", ":"), ensure_ascii=False).encode()
    out = subprocess.run(
        ["curl", "-sS", "--max-time", str(max_time), "-X", "POST", "-H", "Content-Type: application/json",
         "-H", f"X-Sync-Signature: {sign(token(), body)}", "--data-binary", "@-", cfg["url"].rstrip("/") + path],
        input=body, capture_output=True, check=True).stdout
    res = json.loads(out or b"{}")
    if not res.get("ok"):
        raise RuntimeError(f"{path}: {res.get('error', 'failed')}")
    return res


# ------------------------------------------------------------------ KV through the Cloudflare API

def kv_url(cfg: dict, key: str) -> str:
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return f"https://api.cloudflare.com/client/v4/accounts/{acct}/storage/kv/namespaces/{cfg['kv']}/values/{key}"


def kv(cfg: dict, method: str, key: str, data: bytes | None = None) -> bytes | None:
    tok = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not tok or not os.environ.get("CLOUDFLARE_ACCOUNT_ID") or not cfg.get("kv"):
        raise RuntimeError("CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and the KV id are needed")
    req = urllib.request.Request(kv_url(cfg, key), data=data, method=method,
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == "GET":
            return None
        raise RuntimeError(f"KV {method} {key}: HTTP {e.code}") from None


# ------------------------------------------------------------------ bundles

def split_front(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    try:
        fm = yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError:
        fm = {}
    body = text[end + 4:].lstrip("\n")
    return (fm if isinstance(fm, dict) else {}), body


def _list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x is not None]
    return [str(v)]


def _strip_link(s: str) -> str:
    return re.sub(r"^\[\[|\]\]$", "", s.strip()).split("|")[0]


def _date(v) -> str | None:
    return str(v)[:10] if v else None


def note_record(p: Path, vault: Path) -> dict:
    raw = p.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    fm, body = split_front(text)
    return {
        "p": p.relative_to(vault).as_posix(), "t": p.stem, "h": hashlib.sha1(raw).hexdigest()[:12],
        "ty": fm.get("type"), "st": fm.get("status"), "title": fm.get("title"),
        "mocs": [_strip_link(x) for x in _list(fm.get("mocs"))], "tags": _list(fm.get("tags")),
        "cr": _date(fm.get("created")), "up": _date(fm.get("updated")), "as": _date(fm.get("as_of")),
        "src": [_strip_link(x) for x in _list(fm.get("sources"))], "b": body,
    }


def vault_bundle(vault: Path = VAULT) -> dict:
    notes = [note_record(p, vault) for p in sorted(vault.rglob("*.md")) if not (p.parent == vault and p.name in SKIP)]
    return {"notes": notes, "built": now_ts()}


def learn_bundle(learn: Path = LEARN) -> dict:
    """Every track's units and placement test, plus the user's timezone (streaks and the daily goal
    count days in it). A fresh install has no tracks: the app then asks what to learn."""
    tf = learn / "tracks.json"
    tracks = (json.loads(tf.read_text()).get("tracks") or []) if tf.exists() else []
    units, placement = {}, {}
    for t in tracks:
        d = learn / t["id"]
        units[t["id"]] = [json.loads(f.read_text()) for f in sorted((d / "units").glob("*.json"))] if (d / "units").exists() else []
        if (d / "placement.json").exists():
            placement[t["id"]] = json.loads((d / "placement.json").read_text())
    return {"tracks": tracks, "units": units, "placement": placement, "tz": settings.get("timezone") or "UTC", "built": now_ts()}


def pack(obj: dict) -> tuple[bytes, str]:
    """gzip of the JSON (stable bytes: mtime 0), and a version hash of the content without `built`."""
    stable = {k: v for k, v in obj.items() if k != "built"}
    ver = hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    obj = {**obj, "version": ver}
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0, compresslevel=9), ver


def push(cfg: dict, quiet: bool = False) -> str:
    meta_raw = kv(cfg, "GET", "meta")
    meta = json.loads(meta_raw) if meta_raw else {}
    changed = []
    for name, build in (("vault", vault_bundle), ("learn", learn_bundle)):
        obj = build()
        blob, ver = pack(obj)
        if (meta.get(name) or {}).get("v") == ver:
            continue
        kv(cfg, "PUT", f"blob:{name}", blob)
        meta[name] = {"v": ver, "bytes": len(blob), "built": obj["built"],
                      **({"notes": len(obj["notes"])} if name == "vault" else {"tracks": len(obj["tracks"])})}
        changed.append(f"{name} {ver} ({len(blob) // 1024} KB)")
    if changed:
        kv(cfg, "PUT", "meta", json.dumps(meta).encode())
    line = "pushed: " + ", ".join(changed) if changed else "app already up to date"
    if not quiet:
        print(line)
    return line


def pull(cfg: dict) -> bool:
    raw = kv(cfg, "GET", "progress")
    if not raw:
        print("no progress in the app yet")
        return False
    prog = json.loads(raw)
    DATA.mkdir(parents=True, exist_ok=True)
    p = DATA / "progress.json"
    new = json.dumps(prog, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    if p.exists() and p.read_text() == new:
        print("progress unchanged")
        return False
    p.write_text(new)
    print("progress saved to knowledge/data/progress.json")
    return True


# ------------------------------------------------------------------ the queue

SAFE = re.compile(r"^(concepts|entities|themes)/[^\0]+\.md$")


def vault_path(rel: str, vault: Path = VAULT) -> Path | None:
    """A note the app may change: under concepts/, entities/ or themes/, never raw/ or the rules."""
    if not isinstance(rel, str) or ".." in rel or not SAFE.match(rel):
        return None
    p = (vault / rel).resolve()
    return p if p.is_relative_to(vault.resolve()) else None


def set_status(text: str, status: str, today: str) -> str:
    def sub(key, val, t):
        if re.search(rf"^{key}:.*$", t, re.M):
            return re.sub(rf"^{key}:.*$", f"{key}: {val}", t, count=1, flags=re.M)
        return t.replace("\n---", f"\n{key}: {val}\n---", 1)
    head_end = text.find("\n---", 3)
    head, rest = text[:head_end + 4], text[head_end + 4:]
    head = sub("status", status, head)
    head = sub("updated", today, head)
    return head + rest


def clear_review_flags(text: str) -> str:
    """Remove `> [!review]` callouts (the flag and its quoted lines): the owner approved the note."""
    out, skipping = [], False
    for line in text.split("\n"):
        if re.match(r"^\s*>\s*\[!review\]", line):
            skipping = True
            continue
        if skipping and re.match(r"^\s*>", line):
            continue
        if skipping and not line.strip() and out and not out[-1].strip():
            continue  # don't leave a double blank line where the callout was
        skipping = False
        out.append(line)
    return "\n".join(out)


def slug(s: str, n: int = 50) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:n] or "note"


def apply(items: list[dict], vault: Path = VAULT) -> tuple[list[str], list[str]]:
    """Apply queue items. Returns (lines to print, ids handled)."""
    today = datetime.now(settings.tz()).date().isoformat()
    out, done = [], []
    for it in items:
        k, d, iid = it.get("kind"), it.get("data") or {}, it.get("id")
        try:
            if k == "note_status":
                p = vault_path(d.get("path"), vault)
                if not p or not p.exists() or d.get("status") not in ("draft", "reviewed"):
                    out.append(f"Skipped a status change for {d.get('path')!r}: not a note the app may change.")
                else:
                    text = set_status(p.read_text(), d["status"], today)
                    flags = d["status"] == "reviewed" and "[!review]" in text
                    if flags:
                        text = clear_review_flags(text)
                    p.write_text(text)
                    out.append(f"Marked {d['status']}: {p.relative_to(vault).as_posix()}" + (" (review flag cleared)" if flags else ""))
            elif k in ("note_edit", "note_delete"):
                p = vault_path(d.get("path"), vault)
                if not p or not p.exists():
                    out.append(f"Skipped an edit to {d.get('path')!r}: not a note the app may change.")
                elif hashlib.sha1(p.read_bytes()).hexdigest()[:12] != d.get("base"):
                    out.append(f"CONFLICT: {p.relative_to(vault).as_posix()} changed since the app loaded it; the owner's edit was not saved. "
                               "Tell the owner and ask them to edit it again after the app refreshes.")
                elif k == "note_delete":
                    p.unlink()
                    out.append(f"Deleted: {p.relative_to(vault).as_posix()} (remove its links from MOCs and index.md)")
                else:
                    text = str(d.get("text", ""))
                    if not text.startswith("---") or len(text) > 64 * 1024:
                        out.append(f"Skipped an edit to {d['path']}: the frontmatter is missing or the note is too long.")
                    else:
                        p.write_text(text if text.endswith("\n") else text + "\n")
                        out.append(f"Edited: {p.relative_to(vault).as_posix()} (check links and index.md)")
            elif k == "capture":
                title = str(d.get("title") or "").strip() or str(d.get("text", ""))[:60]
                dest = vault / "To be filed" / f"{today}_{slug(title)}.md"
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text((f"# {title}\n\n" if d.get("title") else "") + str(d.get("text", "")).strip() + "\n")
                out.append(f"CAPTURED: {dest.relative_to(vault).as_posix()}. Run the vault's Ingest workflow on it now, then reply with the notes written (0–3).")
            elif k == "ask":
                out.append("ASK: " + json.dumps({"question": d.get("q"), "note": d.get("path")}, ensure_ascii=False)
                           + " — answer in Telegram as a tutor (kb.py thread), with the File it button.")
            elif k == "answer":
                out.append("ANSWER: " + json.dumps(d, ensure_ascii=False) + " — give feedback in Telegram against the rubric.")
            elif k == "report":
                out.append("REPORT: " + json.dumps(d, ensure_ascii=False) + " — check the card against its sources; fix or remove it, validate, push.")
            elif k == "curriculum":
                out.append("CURRICULUM: " + json.dumps(d, ensure_ascii=False) + " — write this band's units (skill: Curriculum), validate, push.")
            elif k == "topic":
                out.append("TOPIC: " + json.dumps(d, ensure_ascii=False) + " — the user wants to learn this: start a track (skill: New topic), validate, push.")
            else:
                out.append(f"Skipped an unknown item kind {k!r}.")
            done.append(iid)
        except OSError as e:
            out.append(f"Failed on {k} ({e}); left in the queue.")
    return out, done


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", nargs="?", choices=["push", "pull", "queue", "apply", "settings"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.dry_run:
        for name, build in (("vault", vault_bundle), ("learn", learn_bundle)):
            obj = build()
            blob, ver = pack(obj)
            raw = len(json.dumps(obj, ensure_ascii=False).encode())
            print(f"{name}: {ver}, {raw // 1024} KB JSON, {len(blob) // 1024} KB gzipped")
        return 0
    cfg = config()
    if not cfg:
        print("app_sync: the Knowledge app is not set up yet (knowledge/app/config.json); skipped")
        return 0
    if not token() and a.cmd not in ("push", "pull"):
        print("app_sync: KNOWLEDGE_BOT_TOKEN is not set", file=sys.stderr)
        return 2
    if a.cmd == "push":
        push(cfg)
    elif a.cmd == "pull":
        pull(cfg)
    elif a.cmd == "queue":
        for it in signed(cfg, "/api/queue", {"op": "list"}).get("items", []):
            print(json.dumps(it, ensure_ascii=False))
    elif a.cmd == "apply":
        items = signed(cfg, "/api/queue", {"op": "list"}).get("items", [])
        lines, done = apply(items)
        for l in lines or ["Nothing new from the app."]:
            print(l)
        if done:
            signed(cfg, "/api/queue/ack", {"op": "ack", "ids": done})
    elif a.cmd == "settings":
        print(json.dumps(signed(cfg, "/api/settings", {"op": "settings", "settings": json.loads(a.arg or "{}")}).get("settings")))
    else:
        ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
