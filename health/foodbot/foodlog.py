#!/usr/bin/env python3
"""Food log: append meals, report daily totals against the plan's targets.

The agent estimates each meal (from a photo or a text description) and calls
`add`; this script only stores numbers and does the arithmetic, so totals are
never done in the model's head. Photos are never stored: `done` deletes the
inbox copy once a meal is logged.

  foodlog.py add --desc "chicken rice, no skin" --kcal 520 --protein 35 \
      --carbs 60 --fat 14 --sat-fat 4 --fibre 2 --veg 0.5 --fruit 0 \
      --confidence medium --source photo --update-id 123
  foodlog.py today [--date 2026-09-28]
  foodlog.py week [--end 2026-09-28]
  foodlog.py undo
  foodlog.py edit --entry 7 --kcal 450 --protein 30
  foodlog.py pending
  foodlog.py done --update-id 123
"""

import argparse
import csv
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import health_settings as hs  # noqa: E402  (targets from health/settings.json)

FIELDS = ["entry_id", "logged_at", "meal_date", "meal_time", "meal", "description",
          "kcal", "protein_g", "carbs_g", "fat_g", "sat_fat_g", "fibre_g",
          "veg_servings", "fruit_servings", "confidence", "source",
          "tg_update_id", "notes"]
NUM = ["kcal", "protein_g", "carbs_g", "fat_g", "sat_fat_g", "fibre_g",
       "veg_servings", "fruit_servings"]
MEALS = ["breakfast", "lunch", "snack", "dinner", "supper", "drink"]


def tz():
    return hs.tz()


def targets() -> dict:
    return hs.targets()


def csv_path() -> Path:
    return Path(os.environ.get("FOODLOG_CSV", HERE.parent / "food_log.csv"))


def inbox() -> Path:
    return Path(os.environ.get("FOODBOT_HOME", Path.home() / ".foodbot")) / "inbox"


def load() -> list[dict]:
    p = csv_path()
    if not p.exists():
        return []
    with p.open(newline="") as f:
        return list(csv.DictReader(f))


def save(rows: list[dict]) -> None:
    p = csv_path()
    tmp = p.with_suffix(".tmp")
    with tmp.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    tmp.rename(p)


def guess_meal(t: datetime) -> str:
    hm = t.hour + t.minute / 60
    if hm < 10.5:
        return "breakfast"
    if hm < 15:
        return "lunch"
    if hm < 17.5:
        return "snack"
    if hm < 21.5:
        return "dinner"
    return "supper"


def num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def fmt(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 10 or x == int(x) else f"{x:.1f}"


def totals(rows: list[dict], day: str) -> dict:
    t = {k: 0.0 for k in NUM}
    n = 0
    for r in rows:
        if r["meal_date"] == day:
            n += 1
            for k in NUM:
                t[k] += num(r[k])
    t["meals"] = n
    return t


def day_report(rows: list[dict], day: str) -> str:
    t = totals(rows, day)
    T = targets()
    lo, hi = T["kcal"]
    plo, phi = T["protein_g"]
    clo, chi = T["carbs_g"]
    flo, fhi = T["fat_g"]
    vlo, vhi = T["veg_servings"]
    lines = [
        f"Today so far ({t['meals']} {'entry' if t['meals'] == 1 else 'entries'}): "
        f"{fmt(t['kcal'])} kcal of {lo:,}–{hi:,}",
        f"Protein {fmt(t['protein_g'])}/{plo}–{phi} g · Carbs {fmt(t['carbs_g'])}/{clo}–{chi} g · "
        f"Fat {fmt(t['fat_g'])}/{flo}–{fhi} g",
        f"Sat fat {fmt(t['sat_fat_g'])}/<{T['sat_fat_g_max']} g · Fibre {fmt(t['fibre_g'])}/{T['fibre_g_min']}+ g · "
        f"Veg {fmt(t['veg_servings'])}/{vlo}–{vhi} · Fruit {fmt(t['fruit_servings'])}/{T['fruit_servings_min']}",
    ]
    left = []
    k_lo, k_hi = lo - t["kcal"], hi - t["kcal"]
    if k_hi <= 0:
        left.append("calories: at or over target")
    else:
        left.append(f"~{fmt(max(k_lo, 0))}–{fmt(k_hi)} kcal")
    if t["protein_g"] < plo:
        left.append(f"{fmt(plo - t['protein_g'])}–{fmt(phi - t['protein_g'])} g protein")
    left.append(f"carbs ≤{fmt(max(chi - t['carbs_g'], 0))} g")
    left.append(f"sat fat ≤{fmt(max(T['sat_fat_g_max'] - t['sat_fat_g'], 0))} g")
    if t["fibre_g"] < T["fibre_g_min"]:
        left.append(f"fibre {fmt(T['fibre_g_min'] - t['fibre_g'])} g more")
    if t["veg_servings"] < vlo:
        left.append(f"{fmt(vlo - t['veg_servings'])} veg servings")
    lines.append("Left today: " + ", ".join(left))
    return "\n".join(lines)


def meal_line(r: dict) -> str:
    return (f"Logged #{r['entry_id']} {r['meal']} {r['meal_time']}: {r['description']}\n"
            f"~{fmt(num(r['kcal']))} kcal · P {fmt(num(r['protein_g']))} · C {fmt(num(r['carbs_g']))} · "
            f"F {fmt(num(r['fat_g']))} (sat {fmt(num(r['sat_fat_g']))}) · fibre {fmt(num(r['fibre_g']))} · "
            f"veg {fmt(num(r['veg_servings']))} · fruit {fmt(num(r['fruit_servings']))} "
            f"[{r['confidence']} confidence]")


def event_time(update_id: int | None) -> datetime | None:
    if update_id is None:
        return None
    p = inbox() / f"{update_id}.json"
    if p.exists():
        d = json.loads(p.read_text()).get("date")
        if d:
            return datetime.fromtimestamp(int(d), tz())
    return None


def cmd_add(a) -> int:
    rows = load()
    if a.update_id is not None and any(r["tg_update_id"] == str(a.update_id) for r in rows):
        print(f"already logged: update {a.update_id} (no change)")
        return 0
    if a.when:
        when = datetime.fromisoformat(a.when)
        when = when if when.tzinfo else when.replace(tzinfo=tz())
    else:
        when = event_time(a.update_id) or datetime.now(tz())
    when = when.astimezone(tz())
    r = {
        "entry_id": str(max((int(x["entry_id"]) for x in rows), default=0) + 1),
        "logged_at": datetime.now(tz()).isoformat(timespec="seconds"),
        "meal_date": when.date().isoformat(),
        "meal_time": when.strftime("%H:%M"),
        "meal": a.meal or guess_meal(when),
        "description": a.desc.replace("\n", " ").strip(),
        "kcal": a.kcal, "protein_g": a.protein, "carbs_g": a.carbs, "fat_g": a.fat,
        "sat_fat_g": a.sat_fat, "fibre_g": a.fibre, "veg_servings": a.veg,
        "fruit_servings": a.fruit, "confidence": a.confidence, "source": a.source,
        "tg_update_id": "" if a.update_id is None else str(a.update_id),
        "notes": (a.notes or "").replace("\n", " "),
    }
    for k in NUM:
        r[k] = f"{float(r[k]):g}"
    rows.append(r)
    save(rows)
    print(meal_line(r))
    print()
    print(day_report(rows, r["meal_date"]))
    return 0


def cmd_today(a) -> int:
    day = a.date or datetime.now(tz()).date().isoformat()
    rows = load()
    for r in rows:
        if r["meal_date"] == day:
            print(f"#{r['entry_id']} {r['meal_time']} {r['meal']}: {r['description']} "
                  f"(~{fmt(num(r['kcal']))} kcal, P {fmt(num(r['protein_g']))})")
    print(day_report(rows, day))
    return 0


def cmd_week(a) -> int:
    end = date.fromisoformat(a.end) if a.end else datetime.now(tz()).date()
    rows = load()
    days = [(end - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    logged = [d for d in days if totals(rows, d)["meals"]]
    print(f"Week to {end.isoformat()}: {len(logged)} of 7 days logged")
    print("date | kcal | protein | carbs | fat | sat | fibre | veg | fruit")
    for d in logged:
        t = totals(rows, d)
        print(f"{d} | {fmt(t['kcal'])} | {fmt(t['protein_g'])} | {fmt(t['carbs_g'])} | "
              f"{fmt(t['fat_g'])} | {fmt(t['sat_fat_g'])} | {fmt(t['fibre_g'])} | "
              f"{fmt(t['veg_servings'])} | {fmt(t['fruit_servings'])}")
    if logged:
        avg = {k: sum(totals(rows, d)[k] for d in logged) / len(logged) for k in NUM}
        print(f"Average (logged days): {fmt(avg['kcal'])} kcal, P {fmt(avg['protein_g'])} g, "
              f"C {fmt(avg['carbs_g'])} g, F {fmt(avg['fat_g'])} g, sat {fmt(avg['sat_fat_g'])} g, "
              f"fibre {fmt(avg['fibre_g'])} g, veg {fmt(avg['veg_servings'])}, fruit {fmt(avg['fruit_servings'])}")
        vlo = targets()["veg_servings"][0]
        hit = sum(1 for d in logged if totals(rows, d)["veg_servings"] >= vlo)
        print(f"Days at {vlo}+ veg servings: {hit} of {len(logged)}")
    return 0


def cmd_undo(a) -> int:
    rows = load()
    if not rows:
        print("nothing to undo")
        return 1
    last = max(rows, key=lambda r: int(r["entry_id"]))
    rows.remove(last)
    save(rows)
    print(f"Removed #{last['entry_id']} {last['meal']} {last['meal_date']} {last['meal_time']}: {last['description']}")
    print()
    print(day_report(rows, last["meal_date"]))
    return 0


def cmd_edit(a) -> int:
    rows = load()
    match = [r for r in rows if r["entry_id"] == str(a.entry)]
    if not match:
        print(f"no entry #{a.entry}")
        return 1
    r = match[0]
    changes = {"kcal": a.kcal, "protein_g": a.protein, "carbs_g": a.carbs, "fat_g": a.fat,
               "sat_fat_g": a.sat_fat, "fibre_g": a.fibre, "veg_servings": a.veg,
               "fruit_servings": a.fruit, "description": a.desc, "meal": a.meal,
               "confidence": a.confidence, "notes": a.notes}
    for k, v in changes.items():
        if v is not None:
            r[k] = f"{float(v):g}" if k in NUM else str(v).replace("\n", " ")
    save(rows)
    print("Updated " + meal_line(r))
    print()
    print(day_report(rows, r["meal_date"]))
    return 0


def cmd_pending(a) -> int:
    box = inbox()
    evs = sorted(box.glob("*.json"), key=lambda p: int(p.stem)) if box.exists() else []
    for p in evs:
        print(p.read_text())
    if not evs:
        print("inbox empty")
    return 0


def cmd_done(a) -> int:
    box = inbox()
    removed = 0
    for p in box.glob(f"{a.update_id}.*"):
        p.unlink()
        removed += 1
    print(f"cleared update {a.update_id} ({removed} file{'s' if removed != 1 else ''} deleted)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def macros(p, required: bool):
        for flag in ("kcal", "protein", "carbs", "fat", "sat-fat", "fibre", "veg", "fruit"):
            p.add_argument(f"--{flag}", type=float, required=required and flag in ("kcal", "protein", "carbs", "fat"),
                           default=None if not required else 0.0)

    p = sub.add_parser("add")
    p.add_argument("--desc", required=True)
    macros(p, True)
    p.add_argument("--meal", choices=MEALS)
    p.add_argument("--when", help="ISO time; default: the Telegram message time, else now")
    p.add_argument("--confidence", choices=["low", "medium", "high"], default="medium")
    p.add_argument("--source", choices=["photo", "text", "photo+text", "voice", "manual"], default="photo")
    p.add_argument("--update-id", type=int)
    p.add_argument("--notes")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("today")
    p.add_argument("--date")
    p.set_defaults(fn=cmd_today)

    p = sub.add_parser("week")
    p.add_argument("--end")
    p.set_defaults(fn=cmd_week)

    p = sub.add_parser("undo")
    p.set_defaults(fn=cmd_undo)

    p = sub.add_parser("edit")
    p.add_argument("--entry", type=int, required=True)
    p.add_argument("--desc")
    p.add_argument("--meal", choices=MEALS)
    p.add_argument("--confidence", choices=["low", "medium", "high"])
    p.add_argument("--notes")
    macros(p, False)
    p.set_defaults(fn=cmd_edit)

    p = sub.add_parser("pending")
    p.set_defaults(fn=cmd_pending)

    p = sub.add_parser("done")
    p.add_argument("--update-id", type=int, required=True)
    p.set_defaults(fn=cmd_done)

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
