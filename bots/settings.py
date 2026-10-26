"""The owner's settings, from settings.json at the repo root (filled in during setup).

    from settings import get, tz, home_currency, owner_name
    get("timezone")             # "Asia/Singapore"
    tz()                        # ZoneInfo for that timezone
    home_currency()             # "SGD"

SETTINGS_JSON overrides the file's path (tests use it). Missing keys fall back to
DEFAULTS, so a half-filled file still works.
"""

import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {"owner_name": "Owner", "contact_email": "", "timezone": "Asia/Singapore",
            "home_currency": "SGD", "holiday_calendar": "", "bots": {}}


def load() -> dict:
    path = Path(os.environ.get("SETTINGS_JSON") or ROOT / "settings.json")
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    return {**DEFAULTS, **(data if isinstance(data, dict) else {})}


def get(key: str, default=None):
    return load().get(key, default)


def tz() -> ZoneInfo:
    try:
        return ZoneInfo(get("timezone") or DEFAULTS["timezone"])
    except Exception:
        return ZoneInfo(DEFAULTS["timezone"])


def home_currency() -> str:
    return (get("home_currency") or DEFAULTS["home_currency"]).upper()


def owner_name() -> str:
    return get("owner_name") or DEFAULTS["owner_name"]


def enabled(bot: str) -> bool:
    return bool((get("bots") or {}).get(bot))
