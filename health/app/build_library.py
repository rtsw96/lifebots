#!/usr/bin/env python3
"""Build the app's exercise library: public/library.json and public/ex/*.webp.

Takes health/training/exercises.json and adds, for each exercise with an
`illustration` id, the step-by-step instructions and the two position photos
from the public-domain free-exercise-db (github.com/yuhonas/free-exercise-db,
Unlicense). Photos are resized to 360 px wide WebP so the app ships them itself
(no third-party requests from the page).

Run after changing exercises.json; commit the output. Needs network and Pillow.
  python3 health/app/build_library.py
"""

import io
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "training" / "exercises.json"
OUT = HERE / "public"
RAW = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main"
WIDTH = 360


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def main() -> int:
    lib = json.loads(LIB.read_text())
    db = {x["id"]: x for x in json.loads(get(f"{RAW}/dist/exercises.json"))}
    (OUT / "ex").mkdir(parents=True, exist_ok=True)
    out = []
    for e in lib["exercises"]:
        item = {k: e[k] for k in ("id", "name", "kind", "equipment", "primary", "secondary", "load", "role")}
        item.update({k: e[k] for k in ("sides", "hold", "cue") if k in e})
        src = db.get(e.get("illustration") or "")
        if src:
            item["steps"] = e.get("steps") or src.get("instructions", [])
            item["images"] = []
            for k, rel in enumerate(src.get("images", [])[:2]):
                name = f"{e['id']}-{k}.webp"
                dest = OUT / "ex" / name
                if not dest.exists():
                    im = Image.open(io.BytesIO(get(f"{RAW}/exercises/{rel}"))).convert("RGB")
                    im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
                    im.save(dest, "WEBP", quality=72, method=6)
                item["images"].append(f"ex/{name}")
        out.append(item)
    doc = {"source": "Exercise photos and steps: free-exercise-db (public domain, Unlicense).",
           "muscles": lib["muscles"], "exercises": out}
    (OUT / "library.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    size = sum(p.stat().st_size for p in (OUT / "ex").glob("*.webp"))
    print(f"{len(out)} exercises, {sum(1 for x in out if x.get('images'))} illustrated, "
          f"images {size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
