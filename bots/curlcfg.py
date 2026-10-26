"""Run curl without a bot token on its command line.

A Telegram Bot API URL carries the token (`https://api.telegram.org/bot<token>/...`).
Passed as an argument, it shows in `ps` and in /proc/<pid>/cmdline to every process
in the container for as long as curl runs (a long poll: up to a minute). Here the
URL goes to curl as a config file on stdin (`-K -`), which only curl reads.

    curlcfg.run(["curl", "-sS", "--max-time", "30"], url, capture_output=True, text=True)

The call must not use stdin for anything else (no `-d @-`, no `-T -`).
"""

from __future__ import annotations

import subprocess
from typing import List


def url_config(url: str) -> str:
    """One curl config line for this URL, quoted as curl's config parser expects."""
    if any(c in url for c in "\r\n\0"):
        raise ValueError("newline in URL")
    return 'url = "' + url.replace("\\", "\\\\").replace('"', '\\"') + '"\n'


def run(args: List[str], url: str, **kw) -> subprocess.CompletedProcess:
    if "input" in kw or "stdin" in kw:
        raise ValueError("curlcfg.run needs stdin for the URL")
    cfg = url_config(url)
    textual = kw.get("text") or kw.get("universal_newlines") or kw.get("encoding") or kw.get("errors")
    return subprocess.run([*args, "-K", "-"], input=cfg if textual else cfg.encode(), **kw)
