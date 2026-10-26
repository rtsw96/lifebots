#!/usr/bin/env python3
"""Your checklist (health/plan.json): daily items to tick and one-off steps.

You fill it in yourself, by asking the health bot ("add stretching to my daily checklist",
"remind me to book a dental check-up by March"). The health app shows it on the Today tab
with a tick per item; ticks are saved to health/habit_log.csv.

  plan.py list
  plan.py add --args-json <file>     {"type": "daily", "title": "Stretch", "when": "evening"}
                                     {"type": "step", "title": "Book a check-up", "detail": "...",
                                      "due": "2026-11-30", "group": "Appointments"}
  plan.py remove --id <id>
  plan.py done --id <id> [--undo]    tick a one-off step (or reopen it)

Titles and timing only: no doses. Medicines and supplements are whatever you and your
doctor decided; the checklist only helps you remember to take them, and the bot never
suggests what to take, stop or change. Text goes in through a file (--args-json), never
on the command line, because it comes from a chat message.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import health_settings as hs  # noqa: E402  (the local date)
DOSE = re.compile(r"\d\s*(mg|mcg|µg|ug|iu|units?|g|ml|tabs?|tablets?|capsules?|pills?)\b", re.I)


def path() -> Path:
    return Path(os.environ.get("PLAN_JSON", HEALTH / "plan.json"))


def load() -> dict:
    try:
        data = json.loads(path().read_text())
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    data.setdefault("tasks", [])
    data.setdefault("habits", [])
    return data


def save(plan: dict) -> None:
    tmp = path().with_suffix(".tmp")
    tmp.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
    tmp.rename(path())


def _text(v, field: str, limit: int, required: bool = False) -> str:
    if v is None or v == "":
        if required:
            raise ValueError(f"{field} is needed")
        return ""
    if not isinstance(v, str):
        raise ValueError(f"{field}: expected text")
    v = " ".join(v.split())
    if len(v) > limit:
        raise ValueError(f"{field}: {limit} characters at most")
    if DOSE.search(v):
        raise ValueError(f"{field}: keep doses out of the checklist; write the item's name only")
    return v


def new_id(title: str, taken: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:30] or "item"
    i, out = 2, base
    while out in taken:
        out = f"{base[:27]}_{i}"
        i += 1
    return out


def add(plan: dict, d: dict) -> dict:
    if not isinstance(d, dict) or d.get("type") not in ("daily", "step"):
        raise ValueError('type is "daily" or "step"')
    taken = {x["id"] for x in plan["tasks"] + plan["habits"]}
    title = _text(d.get("title"), "title", 60, required=True)
    item = {"id": new_id(title, taken), "title": title}
    if d["type"] == "daily":
        item["when"] = _text(d.get("when"), "when", 40) or "daily"
        if len(plan["habits"]) >= 20:
            raise ValueError("20 daily items at most")
        plan["habits"].append(item)
    else:
        item["detail"] = _text(d.get("detail"), "detail", 300)
        item["group"] = _text(d.get("group"), "group", 40) or "Steps"
        due = d.get("due")
        if due:
            date.fromisoformat(str(due))
            item["due"] = str(due)
        item["done"] = None
        if len(plan["tasks"]) >= 40:
            raise ValueError("40 steps at most")
        plan["tasks"].append(item)
    return item


def describe(plan: dict) -> str:
    lines = []
    if plan["habits"]:
        lines.append("Daily:")
        lines += [f"  {h['id']}: {h['title']} ({h.get('when', 'daily')})" for h in plan["habits"]]
    if plan["tasks"]:
        lines.append("Steps:")
        lines += [f"  {t['id']}: {t['title']}" + (f", due {t['due']}" if t.get("due") else "")
                  + (f", done {t['done']}" if t.get("done") else "") for t in plan["tasks"]]
    return "\n".join(lines) or "The checklist is empty."


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    s = sub.add_parser("add")
    s.add_argument("--args-json", required=True)
    s = sub.add_parser("remove")
    s.add_argument("--id", required=True)
    s = sub.add_parser("done")
    s.add_argument("--id", required=True)
    s.add_argument("--undo", action="store_true")
    a = p.parse_args(argv)
    plan = load()
    if a.cmd == "list":
        print(describe(plan))
        return 0
    try:
        if a.cmd == "add":
            item = add(plan, json.loads(Path(a.args_json).read_text()))
            print(f"Added: {item['title']} (id {item['id']})")
        elif a.cmd == "remove":
            before = len(plan["tasks"]) + len(plan["habits"])
            plan["tasks"] = [t for t in plan["tasks"] if t["id"] != a.id]
            plan["habits"] = [h for h in plan["habits"] if h["id"] != a.id]
            if len(plan["tasks"]) + len(plan["habits"]) == before:
                raise ValueError(f"no item {a.id}")
            print(f"Removed {a.id}.")
        else:
            t = next((t for t in plan["tasks"] if t["id"] == a.id), None)
            if not t:
                raise ValueError(f"no step {a.id}")
            t["done"] = None if a.undo else datetime.now(hs.tz()).date().isoformat()
            print(f"{'Reopened' if a.undo else 'Done'}: {t['title']}")
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    save(plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
