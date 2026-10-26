#!/usr/bin/env python3
"""Workout log: store sets, runs and body weight; report progress.

The agent (or the health app) works out what was done and calls this script;
the script stores one row per set and does every sum, so volumes, PRs and
weekly set counts are never done in the model's head.

  workoutlog.py add --exercise "db bench" --sets "12x14,10x26,8x26,8x26" [--block A]
      [--date 2026-10-09 --time 19:35] [--source text] [--ref 123]
  workoutlog.py import --json workout.json      (a whole workout; see import_workout)
  workoutlog.py run --km 5 --minutes 27.5 [--date ... --time ...] [--ref 123]
  workoutlog.py body --weight 72.1 [--waist 80] [--date ...]
  workoutlog.py summary [--workout ID]           (default: the latest workout)
  workoutlog.py week [--end 2026-10-09]
  workoutlog.py history --exercise "db row" [--n 8]
  workoutlog.py prs
  workoutlog.py undo
  workoutlog.py sync-apple                       (copy Watch runs and rides missing from the log;
                                                  app_sync.py apply does this on every bot run)

Set notation for --sets, comma separated:
  weight exercises  "12x14" = 12 reps at 14 kg; "4x8@22" = 4 sets of 8 at 22 kg
  bodyweight reps   "16" = one set of 16; "3x16" = 3 sets of 16
  timed holds       "0:20" or "20s" = 20 seconds; "3x25s" = 3 sets of 25 s
Weights are as the gym labels them: per dumbbell for two-dumbbell lifts, the
whole stack or bar for machines, cables and barbells (see exercises.json "load").
"""

import argparse
import csv
import difflib
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEALTH = HERE.parent
sys.path.insert(0, str(HERE))
import health_settings as hs  # noqa: E402
LIB = json.loads((HEALTH / "training" / "exercises.json").read_text())
PROFILE = hs.profile(json.loads((HEALTH / "training" / "profile.json").read_text()))
EX = {e["id"]: e for e in LIB["exercises"]}

FIELDS = ["set_id", "workout_id", "date", "time", "block", "exercise_id", "set_no",
          "weight_kg", "reps", "seconds", "distance_km", "rpe", "source", "ref",
          "logged_at", "notes",
          # from the health app's live workout: when the set was ticked (local time), its place in
          # the order the sets were actually done, the time since the previous set (rest plus
          # the set itself), the rest the app had planned before it, and the reps the owner
          # felt were left in the tank after the exercise's last set
          "done_at", "seq", "rest_s", "rest_plan_s", "rir",
          # the Apple Watch's average and max heart rate over that exercise's sets
          # (filled in by app_sync.py when the Watch workout arrives)
          "hr_avg", "hr_max"]
BODY_FIELDS = ["date", "time", "weight_kg", "waist_cm", "source", "notes"]
# The user's edits to the app's planned workouts: what they swapped (from -> to), removed
# or added, at the plan stage or mid-workout, and what was in the same superset ("with").
# The planner learns from these (prefs()); so does the bot when it suggests workouts.
EDIT_FIELDS = ["date", "time", "workout_id", "stage", "kind", "slot", "from_ex", "to_ex", "with_ex", "ref"]
PREF_DAYS = 120  # edits older than this stop counting: gyms and habits change
SAME_WORKOUT_HOURS = 3


def tz():
    return hs.tz()


def now() -> datetime:
    return datetime.now(tz())


def log_path() -> Path:
    return Path(os.environ.get("WORKOUT_CSV", HEALTH / "workout_log.csv"))


def body_path() -> Path:
    return Path(os.environ.get("BODY_CSV", HEALTH / "body_log.csv"))


def edits_path() -> Path:
    return Path(os.environ.get("WORKOUT_EDITS_CSV", HEALTH / "workout_edits.csv"))


def load(p: Path) -> list[dict]:
    if not p.exists():
        return []
    with p.open(newline="") as f:
        return list(csv.DictReader(f))


def save(p: Path, rows: list[dict], fields: list[str]) -> None:
    tmp = p.with_suffix(".tmp")
    with tmp.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    tmp.rename(p)


def num(v) -> float | None:
    return None if v in (None, "") else float(v)


def fmt(x: float) -> str:
    return f"{x:g}" if x == int(x) else f"{x:.1f}"


# ------------------------------------------------------------------ exercises

def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def resolve(name: str) -> str:
    """Exercise id from an id, name or alias. Exits with suggestions if unknown."""
    n = norm(name)
    for e in EX.values():
        if n in {norm(e["id"]), norm(e["name"]), *(norm(a) for a in e["aliases"])}:
            return e["id"]
    keys = {norm(k): e["id"] for e in EX.values() for k in [e["name"], *e["aliases"]]}
    close = difflib.get_close_matches(n, list(keys), 4, 0.6)
    hint = ", ".join(sorted({EX[keys[c]]["name"] for c in close})) or "none close"
    sys.exit(f"Unknown exercise '{name}'. Closest: {hint}. "
             "Use one of those, or add it to health/training/exercises.json in a code change.")


def factor(ex: dict) -> int:
    """Both dumbbells, or both sides one at a time, count towards volume."""
    return 2 if ex["load"] in ("pair", "side") else 1


def e1rm(weight: float, reps: float) -> float:
    """Epley. Above 12 reps it overstates, so it is capped there."""
    if reps <= 1:
        return weight
    return weight * (1 + min(reps, 12) / 30)


def set_text(ex: dict, s: dict) -> str:
    w, r, sec = num(s.get("weight_kg")), num(s.get("reps")), num(s.get("seconds"))
    if ex["kind"] == "weight":
        return f"{fmt(r or 0)}x{fmt(w or 0)}"
    if ex["kind"] == "time":
        return f"{int(sec or 0)}s"
    if ex["kind"] == "cardio":
        km = num(s.get("distance_km")) or 0
        return f"{fmt(km)} km in {int((sec or 0) // 60)}:{int((sec or 0) % 60):02d}"
    return f"{fmt(r or 0)}"


def parse_sets(ex: dict, spec: str) -> list[dict]:
    out = []
    for tok in [t.strip().lower() for t in spec.split(",") if t.strip()]:
        n = 1
        m = re.fullmatch(r"(\d+)\s*x\s*(.+)", tok)
        if ex["kind"] == "weight":
            m2 = re.fullmatch(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*@\s*(\d+(?:\.\d+)?)\s*(?:kg)?", tok)
            m1 = re.fullmatch(r"(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(?:kg)?", tok)
            if m2:
                n, reps, w = int(m2[1]), float(m2[2]), float(m2[3])
            elif m1:
                reps, w = float(m1[1]), float(m1[2])
            else:
                sys.exit(f"Can't read set '{tok}' for {ex['name']}: use 12x14 (reps x kg) or 4x8@22")
            out += [{"reps": reps, "weight_kg": w} for _ in range(n)]
            continue
        if m:
            n, tok = int(m[1]), m[2]
        if ex["kind"] == "time":
            mt = re.fullmatch(r"(?:(\d+):)?(\d+)\s*s?", tok)
            if not mt:
                sys.exit(f"Can't read hold '{tok}' for {ex['name']}: use 0:20, 20s or 3x20s")
            sec = int(mt[1] or 0) * 60 + int(mt[2])
            out += [{"seconds": sec} for _ in range(n)]
        elif ex["kind"] == "reps":
            if not re.fullmatch(r"\d+", tok):
                sys.exit(f"Can't read reps '{tok}' for {ex['name']}: use 16 or 3x16")
            out += [{"reps": float(tok)} for _ in range(n)]
        else:
            sys.exit(f"{ex['name']} is cardio: use `run`")
    if not out:
        sys.exit("No sets given")
    return out


# ------------------------------------------------------------------ writing

def workout_for(rows: list[dict], d: str, t: str) -> str:
    """Join the latest workout that day if it started within a few hours."""
    when = datetime.fromisoformat(f"{d}T{t}")
    same = [r for r in rows if r["date"] == d]
    if same:
        last = max(same, key=lambda r: r["workout_id"])
        start = datetime.fromisoformat(f"{last['date']}T{last['workout_id'][11:13]}:{last['workout_id'][13:15]}")
        if timedelta(0) <= when - start <= timedelta(hours=SAME_WORKOUT_HOURS):
            return last["workout_id"]
    return f"{d}T{t.replace(':', '')}"


def _clock(ms) -> str:
    """App tick time (epoch ms) as local HH:MM:SS, '' when absent."""
    try:
        return datetime.fromtimestamp(float(ms) / 1000, tz()).strftime("%H:%M:%S")
    except (TypeError, ValueError):
        return ""


def append_sets(rows: list[dict], ex_id: str, sets: list[dict], *, d: str, t: str,
                workout: str | None, block: str, source: str, ref: str, notes: str = "",
                distance=None, rir=None) -> list[dict]:
    wid = workout or workout_for(rows, d, t)
    next_id = max((int(r["set_id"]) for r in rows), default=0) + 1
    prev_no = max((int(r["set_no"]) for r in rows
                   if r["workout_id"] == wid and r["exercise_id"] == ex_id), default=0)
    stamp = now().isoformat(timespec="seconds")
    new = []
    for k, s in enumerate(sets):
        new.append({"set_id": next_id + k, "workout_id": wid, "date": d, "time": t,
                    "block": block, "exercise_id": ex_id, "set_no": prev_no + k + 1,
                    "weight_kg": s.get("weight_kg", ""), "reps": s.get("reps", ""),
                    "seconds": s.get("seconds", ""), "distance_km": s.get("distance_km", ""),
                    "rpe": s.get("rpe", ""), "source": source, "ref": ref,
                    "logged_at": stamp, "notes": notes,
                    "done_at": _clock(s.get("at")), "seq": s.get("seq", ""), "rest_s": s.get("gap_s", ""),
                    "rest_plan_s": s.get("plan_s", ""), "rir": "" if rir is None else rir})
    rows += new
    return new


def when_args(a) -> tuple[str, str]:
    t = now()
    return (a.date or t.date().isoformat(), a.time or t.strftime("%H:%M"))


def cmd_add(a) -> int:
    rows = load(log_path())
    ex_id = resolve(a.exercise)
    if a.ref and any(r["ref"] == a.ref and r["exercise_id"] == ex_id for r in rows):
        print(f"Already logged (ref {a.ref}).")
        return 0
    d, t = when_args(a)
    sets = parse_sets(EX[ex_id], a.sets)
    for s in sets:
        if a.rpe:
            s["rpe"] = a.rpe
    new = append_sets(rows, ex_id, sets, d=d, t=t, workout=a.workout, block=a.block or "",
                      source=a.source, ref=a.ref or "", notes=a.notes or "")
    save(log_path(), rows, FIELDS)
    print(f"Logged {EX[ex_id]['name']}: {', '.join(set_text(EX[ex_id], s) for s in new)}")
    print(exercise_line(rows, new[0]["workout_id"], ex_id))
    return 0


def import_workout(rows: list[dict], w: dict) -> list[dict]:
    """w = {"date", "time", "source", "ref", "notes",
            "blocks": [{"block": "A", "exercises": [{"exercise": "db bench", "sets": "12x14,10x26"}]}]}
    "sets" may also be a list of {"reps", "weight_kg", "seconds"} dicts. Dedup on ref."""
    if w.get("ref") and any(r["ref"] == w["ref"] for r in rows):
        return []
    new = []
    wid = f"{w['date']}T{w['time'].replace(':', '')}"
    for b in w["blocks"]:
        for e in b["exercises"]:
            ex_id = resolve(e["exercise"])
            sets = e["sets"] if isinstance(e["sets"], list) else parse_sets(EX[ex_id], e["sets"])
            new += append_sets(rows, ex_id, sets, d=w["date"], t=w["time"], workout=wid,
                               block=b.get("block", ""), source=w.get("source", "import"),
                               ref=w.get("ref", ""), notes=e.get("notes", ""), rir=e.get("rir"))
    return new


def log_edits(rows: list[dict], w: dict, edits: list[dict]) -> list[dict]:
    """Append a workout's edits (dedup on the workout's ref). Returns the new rows."""
    ref = w.get("ref", "")
    if not edits or (ref and any(r["ref"] == ref for r in rows)):
        return []
    wid = f"{w['date']}T{w['time'].replace(':', '')}"
    new = []
    for e in edits:
        if e.get("kind") not in ("swap", "remove", "add", "split"):
            continue
        new.append({"date": w["date"], "time": w["time"], "workout_id": wid, "stage": e.get("stage", "live"),
                    "kind": e["kind"], "slot": e.get("slot") or "", "from_ex": e.get("from") or "",
                    "to_ex": e.get("to") or "", "with_ex": ";".join(e.get("with") or []), "ref": ref})
    rows.extend(new)
    return new


def prefs(rows: list[dict], today: date | None = None, days: int = PREF_DAYS) -> dict:
    """What the edits say, for the app's planner:
    {"ex": {id: {"out": removed or swapped away, "in": swapped to or added}},
     "slot": {slot: {id: times swapped to}},
     "pairs": {"a|b": times one was swapped out, removed or moved out while the other was in its
               superset}}. A split (an exercise moved out of its superset) counts only as a pair: the
    exercise itself was kept."""
    today = today or now().date()
    since = (today - timedelta(days=days)).isoformat()
    ex: dict = {}
    slot: dict = {}
    pairs: dict = {}

    def bump(i, k):
        ex.setdefault(i, {"out": 0, "in": 0})[k] += 1
    for r in rows:
        if r["date"] < since:
            continue
        f, t = r.get("from_ex") or "", r.get("to_ex") or ""
        if f:
            if r.get("kind") != "split":
                bump(f, "out")
            for w in filter(None, (r.get("with_ex") or "").split(";")):
                k = "|".join(sorted((f, w)))
                pairs[k] = pairs.get(k, 0) + 1
        if t:
            bump(t, "in")
            if r.get("kind") == "swap" and r.get("slot"):
                s = slot.setdefault(r["slot"], {})
                s[t] = s.get(t, 0) + 1
    return {"ex": ex, "slot": slot, "pairs": pairs, "since": since}


def prefs_text(rows: list[dict], today: date | None = None) -> str:
    """The edits in plain words, for the bot's workout suggestions."""
    p = prefs(rows, today)
    name = lambda i: EX[i]["name"] if i in EX else i  # noqa: E731
    lines = []
    outs = sorted(((v["out"] - v["in"], i) for i, v in p["ex"].items() if v["out"] - v["in"] >= 1), reverse=True)
    if outs:
        lines.append("Usually removed or swapped out: " + ", ".join(f"{name(i)} ({n}x)" for n, i in outs[:8]))
    ins = sorted(((v["in"], i) for i, v in p["ex"].items() if v["in"] >= 1), reverse=True)
    if ins:
        lines.append("Usually swapped to or added: " + ", ".join(f"{name(i)} ({n}x)" for n, i in ins[:8]))
    pr = sorted(((n, k) for k, n in p["pairs"].items()), reverse=True)
    if pr:
        lines.append("Split apart in a superset (swapped, removed or moved apart): " + ", ".join(f"{name(k.split('|')[0])} + {name(k.split('|')[1])} ({n}x)" for n, k in pr[:6]))
    if not lines:
        return f"No workout edits since {p['since']}."
    return f"Workout edits since {p['since']} (the app's planner avoids these from 2x):\n" + "\n".join(lines)


def cmd_prefs(a) -> int:
    print(prefs_text(load(edits_path())))
    return 0


def cmd_import(a) -> int:
    rows = load(log_path())
    data = json.loads(Path(a.json).read_text())
    done = []
    for w in data if isinstance(data, list) else [data]:
        new = import_workout(rows, w)
        if new:
            done.append(new[0]["workout_id"])
        else:
            print(f"Skipped {w['date']} {w['time']}: already logged (ref {w.get('ref')}).")
    save(log_path(), rows, FIELDS)
    for wid in done:
        print(summary(rows, wid))
        print()
    return 0


def cmd_run(a) -> int:
    rows = load(log_path())
    if a.ref and any(r["ref"] == a.ref for r in rows):
        print(f"Already logged (ref {a.ref}).")
        return 0
    d, t = when_args(a)
    sec = round(a.minutes * 60)
    ex_id = resolve(a.kind)
    new = append_sets(rows, ex_id, [{"seconds": sec, "distance_km": a.km}], d=d, t=t,
                      workout=f"{d}T{t.replace(':', '')}", block="", source=a.source,
                      ref=a.ref or "", notes=a.notes or "")
    save(log_path(), rows, FIELDS)
    pace = sec / a.km if a.km else 0
    print(f"Logged {EX[ex_id]['name']}: {fmt(a.km)} km in {sec // 60}:{sec % 60:02d} "
          f"({int(pace // 60)}:{int(pace % 60):02d}/km)")
    runs = [r for r in rows if EX.get(r["exercise_id"], {}).get("kind") == "cardio"
            and r["set_id"] != str(new[0]["set_id"]) and num(r["distance_km"])]
    near = [r for r in runs if abs(num(r["distance_km"]) - a.km) <= 0.5]
    if near:
        best = min(near, key=lambda r: num(r["seconds"]) / num(r["distance_km"]))
        bp = num(best["seconds"]) / num(best["distance_km"])
        tag = "new best pace at this distance" if pace < bp else f"best {int(bp // 60)}:{int(bp % 60):02d}/km on {best['date']}"
        print(f"  {tag}")
    return 0


# ------------------------------------------------- Apple Watch <-> training log

# Watch workouts that are training-log cardio. Walks and hikes stay in the
# activity log only; strength sessions need their sets from a screenshot or the app.
APPLE_CARDIO = [(re.compile(r"indoor run|treadmill", re.I), "treadmill"), (re.compile(r"run|jog", re.I), "run"),
                (re.compile(r"cycl|bik", re.I), "bike"), (re.compile(r"row", re.I), "rower")]
APPLE_STRENGTH = re.compile(r"strength|hiit|core|cross ?training|functional", re.I)
TWIN_MINUTES = 45   # the same window the health app uses to pair a Watch workout with a logged one


def activity_path() -> Path:
    return Path(os.environ.get("ACTIVITY_CSV", HEALTH / "activity_log.csv"))


def apple_kind(name: str) -> str | None:
    return next((ex for rx, ex in APPLE_CARDIO if rx.search(name or "")), None)


def _mins(t: str) -> int:
    hh, mm = (t or "0:0").split(":")[:2]
    return int(hh) * 60 + int(mm)


def twin(rows: list[dict], act: dict, cardio: bool) -> bool:
    """A training-log session that is this Watch workout: the same day, started within
    45 minutes, and the same kind (cardio or not), or one already copied from it."""
    for r in rows:
        if r["ref"] == f"apple:{act['id']}":
            return True
        if (r["date"] == act["date"] and (EX.get(r["exercise_id"], {}).get("kind") == "cardio") == cardio
                and abs(_mins(r["time"]) - _mins(act["start"])) <= TWIN_MINUTES):
            return True
    return False


def from_apple(rows: list[dict], acts: list[dict]) -> list[dict]:
    """Copy Watch runs, rides and rows that the training log doesn't have yet into it,
    one cardio row each (time, distance, source apple-health, ref apple:<activity id>).
    Returns the new rows; `rows` is changed in place."""
    new = []
    for a in sorted(acts, key=lambda r: (r["date"], r["start"])):
        ex_id = apple_kind(a["name"])
        if not ex_id or twin(rows, a, cardio=True):
            continue
        s = {}
        if num(a.get("min")):
            s["seconds"] = round(num(a["min"]) * 60)
        if num(a.get("km")):
            s["distance_km"] = num(a["km"])
        new += append_sets(rows, ex_id, [s], d=a["date"], t=a["start"][:5], workout=f"{a['date']}T{a['start'][:5].replace(':', '')}",
                           block="", source="apple-health", ref=f"apple:{a['id']}")
    return new


def watch_only_strength(rows: list[dict], acts: list[dict], start: date, end: date) -> list[dict]:
    """Watch strength workouts in [start, end] with no logged sets to go with them."""
    return [a for a in acts if APPLE_STRENGTH.search(a["name"] or "") and start <= date.fromisoformat(a["date"]) <= end
            and not twin(rows, a, cardio=False)]


def cmd_sync_apple(a) -> int:
    rows = load(log_path())
    new = from_apple(rows, load(activity_path()))
    if new:
        save(log_path(), rows, FIELDS)
    print(f"{len(new)} Watch cardio session(s) added to the training log" if new else "Training log already has every Watch run and ride.")
    return 0


def cmd_body(a) -> int:
    rows = load(body_path())
    d, t = when_args(a)
    rows = [r for r in rows if r["date"] != d]   # one reading a day; the latest wins
    rows.append({"date": d, "time": t, "weight_kg": a.weight if a.weight else "",
                 "waist_cm": a.waist if a.waist else "", "source": a.source, "notes": a.notes or ""})
    rows.sort(key=lambda r: r["date"])
    save(body_path(), rows, BODY_FIELDS)
    print(f"Logged {d}: " + ", ".join(x for x in [
        f"{fmt(a.weight)} kg" if a.weight else "", f"waist {fmt(a.waist)} cm" if a.waist else ""] if x))
    print(body_trend(rows, date.fromisoformat(d)))
    return 0


def cmd_undo(a) -> int:
    rows = load(log_path())
    if not rows:
        print("Nothing to undo.")
        return 0
    last = rows[-1]["logged_at"]
    gone = [r for r in rows if r["logged_at"] == last]
    rows = [r for r in rows if r["logged_at"] != last]
    save(log_path(), rows, FIELDS)
    names = sorted({EX.get(r["exercise_id"], {"name": r["exercise_id"]})["name"] for r in gone})
    print(f"Removed {len(gone)} set(s): {', '.join(names)}")
    return 0


# ------------------------------------------------------------------ reporting

def by_workout(rows: list[dict]) -> dict[str, list[dict]]:
    out = defaultdict(list)
    for r in rows:
        out[r["workout_id"]].append(r)
    return dict(sorted(out.items()))


def best(ex: dict, sets: list[dict]) -> float:
    """The number progress is judged on: e1RM, reps, seconds."""
    if ex["kind"] == "weight":
        return max(e1rm(num(s["weight_kg"]) or 0, num(s["reps"]) or 0) for s in sets)
    if ex["kind"] == "time":
        return max(num(s["seconds"]) or 0 for s in sets)
    return max(num(s["reps"]) or 0 for s in sets)


def volume(ex: dict, sets: list[dict]) -> float:
    if ex["kind"] != "weight":
        return 0.0
    return sum((num(s["weight_kg"]) or 0) * (num(s["reps"]) or 0) for s in sets) * factor(ex)


def exercise_line(rows: list[dict], wid: str, ex_id: str) -> str:
    ex = EX[ex_id]
    sets = [r for r in rows if r["workout_id"] == wid and r["exercise_id"] == ex_id]
    earlier = [r for r in rows if r["workout_id"] < wid and r["exercise_id"] == ex_id]
    cur = best(ex, sets)
    unit = {"weight": "kg e1RM", "time": "s", "reps": "reps"}.get(ex["kind"], "")
    line = f"  {ex['name']}: {' '.join(set_text(ex, s) for s in sets)}"
    if ex["kind"] == "weight":
        line += f" · e1RM {fmt(round(cur, 1))} kg"
    if earlier:
        prev_wid = max(r["workout_id"] for r in earlier)
        prev = [r for r in earlier if r["workout_id"] == prev_wid]
        pb = best(ex, prev)
        top = max(best(ex, [r]) for r in earlier)
        delta = cur - pb
        line += f" · vs {prev_wid[:10]}: {'+' if delta >= 0 else ''}{fmt(round(delta, 1))} {unit}"
        pv, cv = volume(ex, prev), volume(ex, sets)
        if ex["kind"] == "weight" and pv and abs(cv - pv) / pv >= 0.05:
            line += f", volume {(cv - pv) / pv:+.0%}"
        if cur > top + 1e-9:
            line += " · PR"
        if ex["kind"] == "weight":
            hw = max(num(s["weight_kg"]) or 0 for s in sets)
            if hw > max(num(r["weight_kg"]) or 0 for r in earlier):
                line += " · heaviest yet"
    else:
        line += " · first time logged"
    return line


def summary(rows: list[dict], wid: str) -> str:
    sets = [r for r in rows if r["workout_id"] == wid]
    if not sets:
        return "No such workout."
    order = list(dict.fromkeys(r["exercise_id"] for r in sets))
    vol = sum(volume(EX[e], [r for r in sets if r["exercise_id"] == e]) for e in order)
    n = len([r for r in sets if EX[r["exercise_id"]]["kind"] != "cardio"])
    head = f"Workout {wid[:10]} {wid[11:13]}:{wid[13:15]} · {len(order)} exercises · {n} sets"
    if vol:
        head += f" · volume {vol:,.0f} kg"
    partial = any("partial" in r["notes"] for r in sets)
    lines = [head + (" · partial record" if partial else "")]
    lines += [exercise_line(rows, wid, e) for e in order]
    pace = pace_line(sets)
    if pace:
        lines.append(pace)
    return "\n".join(lines)


SEC_PER_SET = {"compound": 50, "isolation": 40, "core": 40, "stretch": 65}   # as the app's engine.js


def pace_line(sets: list[dict]) -> str:
    """From app-logged sets: the order actually done, time between sets against the plan,
    and reps left in the tank. '' for sets without timing (screenshots, typed)."""
    timed = sorted([r for r in sets if r.get("seq")], key=lambda r: int(r["seq"]))
    if len(timed) < 2:
        return ""
    gaps = [(num(r["rest_s"]), num(r["rest_plan_s"]), r) for r in timed if r.get("rest_s") and r.get("rest_plan_s")]
    gaps = [(g, p, r) for g, p, r in gaps if g is not None and p is not None and g <= 900]   # longer is a break
    out = []
    order = list(dict.fromkeys(EX[r["exercise_id"]]["name"] for r in timed))
    out.append("Order done: " + " → ".join(order))
    if gaps:
        actual = sum(g for g, _, _ in gaps) / len(gaps)
        plan = sum(p + SEC_PER_SET.get(EX[r["exercise_id"]].get("role"), 40) for _, p, r in gaps) / len(gaps)
        pace = "quicker than plan" if actual < plan else f"{round(plan / actual * 100)}% of plan pace"
        out.append(f"Time between sets {int(actual // 60)}:{int(actual % 60):02d} on average, plan {int(plan // 60)}:{int(plan % 60):02d} "
                   f"(rest plus the set): {pace}")
    rir = {EX[r["exercise_id"]]["name"]: r["rir"] for r in timed if r.get("rir") not in (None, "")}
    if rir:
        out.append("Reps left in the tank: " + ", ".join(f"{k} {v}" for k, v in rir.items()))
    hr = hr_line(timed)
    if hr:
        out.append(hr)
    return "\n".join(out)


def hr_line(sets: list[dict]) -> str:
    """'Heart rate (Watch), average / max: Lat Pulldown 106/113, ...' in the order done."""
    hr = {}
    for r in sorted(sets, key=lambda r: int(r.get("seq") or 0)):
        if r.get("hr_avg") and r["exercise_id"] not in hr:
            hr[r["exercise_id"]] = f"{EX[r['exercise_id']]['name']} {r['hr_avg']}/{r.get('hr_max') or '?'}"
    return "Heart rate (Watch), average / max: " + ", ".join(hr.values()) if hr else ""


def set_heart_rate(rows: list[dict], workout_id: str, hr_ex: dict) -> list[str]:
    """Write the Watch's per-exercise heart rate onto that workout's set rows. Returns the
    exercise ids that changed; `rows` is changed in place."""
    changed = []
    for ex, v in (hr_ex or {}).items():
        try:
            avg, mx = int(v["avg"]), int(v["max"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (25 <= avg <= 250 and avg <= mx <= 250):
            continue
        hit = [r for r in rows if r["workout_id"] == workout_id and r["exercise_id"] == ex]
        if hit and any(r.get("hr_avg") != str(avg) or r.get("hr_max") != str(mx) for r in hit):
            for r in hit:
                r["hr_avg"], r["hr_max"] = str(avg), str(mx)
            changed.append(ex)
    return changed


def cmd_summary(a) -> int:
    rows = load(log_path())
    ws = by_workout(rows)
    if not ws:
        print("No workouts logged yet.")
        return 0
    wid = a.workout or list(ws)[-1]
    print(summary(rows, wid))
    return 0


WARMUP_SHARE = 0.6


def is_warmup(r: dict, rows: list[dict]) -> bool:
    """A weighted set under 60% of that exercise's top weight in the same workout."""
    if EX[r["exercise_id"]]["kind"] != "weight":
        return False
    top = max(num(x["weight_kg"]) or 0 for x in rows
              if x["workout_id"] == r["workout_id"] and x["exercise_id"] == r["exercise_id"])
    return (num(r["weight_kg"]) or 0) < WARMUP_SHARE * top


def muscle_sets(rows: list[dict]) -> dict[str, float]:
    """Hard sets per muscle: 1 for a primary muscle, 0.5 for a secondary one. Warm-ups and
    stretches don't count."""
    out = defaultdict(float)
    for r in rows:
        ex = EX.get(r["exercise_id"])
        if not ex or ex["kind"] == "cardio" or ex.get("role") == "stretch" or is_warmup(r, rows):
            continue
        for m in ex["primary"]:
            out[m] += 1
        for m in ex["secondary"]:
            out[m] += 0.5
    return out


GROUPS = {"Chest": ["chest"], "Shoulders": ["front_delts", "side_delts", "rear_delts"],
          "Back": ["lats", "upper_back", "traps"], "Arms": ["biceps", "triceps"],
          "Legs": ["quads", "hamstrings", "glutes", "adductors", "calves"],
          "Core": ["abs", "obliques", "lower_back"]}


def body_trend(rows: list[dict], end: date) -> str:
    pts = [(date.fromisoformat(r["date"]), num(r["weight_kg"])) for r in rows if num(r["weight_kg"])]
    if not pts:
        return "  No body weight logged yet."
    last7 = [w for d, w in pts if end - timedelta(days=6) <= d <= end]
    prev7 = [w for d, w in pts if end - timedelta(days=13) <= d <= end - timedelta(days=7)]
    if not last7:
        return f"  Last weight {fmt(pts[-1][1])} kg on {pts[-1][0]}"
    avg = sum(last7) / len(last7)
    s = f"  7-day average {avg:.1f} kg ({len(last7)} readings)"
    if prev7:
        p = sum(prev7) / len(prev7)
        s += f", {avg - p:+.1f} kg vs the week before"
    return s


def cmd_week(a) -> int:
    rows = load(log_path())
    end = date.fromisoformat(a.end) if a.end else now().date()
    start = end - timedelta(days=6)
    wk = [r for r in rows if start <= date.fromisoformat(r["date"]) <= end]
    strength = {r["workout_id"] for r in wk if EX[r["exercise_id"]]["kind"] != "cardio"}
    runs = [r for r in wk if EX[r["exercise_id"]]["kind"] == "cardio"]
    # The Watch's own record counts too: runs and rides it saw that aren't copied
    # in yet, and strength sessions with no sets logged.
    acts = load(activity_path())
    extra = from_apple([dict(r) for r in rows], [x for x in acts if start <= date.fromisoformat(x["date"]) <= end])
    runs += extra
    watch_only = watch_only_strength(rows, acts, start, end)
    lo, hi = PROFILE["weekly_sets_per_muscle"]
    print(f"Week {start} to {end}: {len(strength) + len(watch_only)} strength sessions "
          f"(plan {PROFILE['strength_days_per_week']}), {len(runs)} cardio, "
          f"{sum(num(r['distance_km']) or 0 for r in runs):g} km")
    if watch_only:
        print(f"  {len(watch_only)} of the strength sessions are on the Watch only, with no sets logged: "
              + ", ".join(f"{x['date']} {x['start']} ({x['name']}, {fmt(num(x['min']) or 0)} min)" for x in watch_only))
    ms = muscle_sets(wk)
    print(f"Hard sets per muscle (target {lo}-{hi}; secondary muscles count half):")
    for g, muscles in GROUPS.items():
        parts = []
        for m in muscles:
            v = ms.get(m, 0)
            flag = "" if lo <= v <= hi else (" low" if v < lo else " high")
            parts.append(f"{m.replace('_', ' ')} {fmt(v)}{flag}")
        print(f"  {g}: " + ", ".join(parts))
    vol = sum(volume(EX[r["exercise_id"]], [r]) for r in wk)
    print(f"Volume {vol:,.0f} kg")
    print("Body:")
    print(body_trend(load(body_path()), end))
    return 0


def cmd_history(a) -> int:
    rows = load(log_path())
    ex_id = resolve(a.exercise)
    ex = EX[ex_id]
    ws = by_workout([r for r in rows if r["exercise_id"] == ex_id])
    if not ws:
        print(f"No {ex['name']} logged yet.")
        return 0
    print(f"{ex['name']}, last {min(a.n, len(ws))} sessions:")
    for wid, sets in list(ws.items())[-a.n:]:
        b = best(ex, sets)
        tail = f" · e1RM {fmt(round(b, 1))} kg · volume {volume(ex, sets):,.0f} kg" if ex["kind"] == "weight" else ""
        print(f"  {wid[:10]}: {' '.join(set_text(ex, s) for s in sets)}{tail}")
    return 0


def cmd_prs(a) -> int:
    rows = load(log_path())
    by_ex = defaultdict(list)
    for r in rows:
        by_ex[r["exercise_id"]].append(r)
    for ex_id, sets in sorted(by_ex.items(), key=lambda kv: EX[kv[0]]["name"]):
        ex = EX[ex_id]
        if ex["kind"] == "cardio":
            continue
        top = max(sets, key=lambda s: best(ex, [s]))
        if ex["kind"] == "weight":
            hw = max(num(s["weight_kg"]) or 0 for s in sets)
            print(f"  {ex['name']}: e1RM {fmt(round(best(ex, [top]), 1))} kg "
                  f"({set_text(ex, top)} on {top['date']}), heaviest {fmt(hw)} kg")
        else:
            print(f"  {ex['name']}: {set_text(ex, top)} on {top['date']}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def when(sp):
        sp.add_argument("--date")
        sp.add_argument("--time")
        sp.add_argument("--source", default="text")
        sp.add_argument("--ref")
        sp.add_argument("--notes")

    s = sub.add_parser("add")
    s.add_argument("--exercise", required=True)
    s.add_argument("--sets", required=True)
    s.add_argument("--block")
    s.add_argument("--workout")
    s.add_argument("--rpe")
    when(s)
    s.set_defaults(func=cmd_add)
    s = sub.add_parser("import")
    s.add_argument("--json", required=True)
    s.set_defaults(func=cmd_import)
    s = sub.add_parser("run")
    s.add_argument("--km", type=float, required=True)
    s.add_argument("--minutes", type=float, required=True)
    s.add_argument("--kind", default="run")
    when(s)
    s.set_defaults(func=cmd_run)
    s = sub.add_parser("body")
    s.add_argument("--weight", type=float)
    s.add_argument("--waist", type=float)
    when(s)
    s.set_defaults(func=cmd_body)
    s = sub.add_parser("summary")
    s.add_argument("--workout")
    s.set_defaults(func=cmd_summary)
    s = sub.add_parser("week")
    s.add_argument("--end")
    s.set_defaults(func=cmd_week)
    s = sub.add_parser("history")
    s.add_argument("--exercise", required=True)
    s.add_argument("--n", type=int, default=8)
    s.set_defaults(func=cmd_history)
    sub.add_parser("prs").set_defaults(func=cmd_prs)
    sub.add_parser("prefs", help="what your workout edits say (swaps, removals, additions)").set_defaults(func=cmd_prefs)
    sub.add_parser("undo").set_defaults(func=cmd_undo)
    sub.add_parser("sync-apple").set_defaults(func=cmd_sync_apple)
    a = p.parse_args(argv)
    if a.cmd == "body" and not (a.weight or a.waist):
        p.error("body needs --weight and/or --waist")
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
