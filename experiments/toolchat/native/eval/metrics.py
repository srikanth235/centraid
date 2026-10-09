"""Fixed metrics.json schema for replay / eval comparisons, and a before/after diff CLI.

    python3 metrics.py BEFORE.json AFTER.json          # compact delta table + flipped counts
    python3 metrics.py --validate FILE.json [...]      # schema check only

Schema (all keys required):
    name, run, gold            str   label, run file path, gold file path
    sessions, session_pass     int
    session_pass_rate          float (session_pass / sessions)
    turns, turn_pass           int
    turn_pass_rate             float
    by_class                   {class: count of FAILED turns in this run} (classes: slices.py)
    flipped_up / flipped_down  [turn ids "<session id>:t<n>"], n 1-based; relative to the baseline
                               (the recorded run) the file was built against; [] when none
    diverged                   [turn ids] whose replayed step sequence differs from the recording
    notes                      str
"""

from __future__ import annotations

import argparse
import json
import sys

SCHEMA = {"name": str, "run": str, "gold": str, "sessions": int, "session_pass": int,
          "session_pass_rate": float, "turns": int, "turn_pass": int, "turn_pass_rate": float,
          "by_class": dict, "flipped_up": list, "flipped_down": list, "diverged": list, "notes": str}


def validate(m: dict) -> list[str]:
    """Problems with a metrics dict ([] when it matches the schema exactly)."""
    errs = [f"missing key {k}" for k in SCHEMA if k not in m]
    errs += [f"unexpected key {k}" for k in m if k not in SCHEMA]
    for k, t in SCHEMA.items():
        if k in m and not (isinstance(m[k], t) or (t is float and isinstance(m[k], int) and not isinstance(m[k], bool))):
            errs.append(f"{k}: want {t.__name__}, got {type(m[k]).__name__}")
    if isinstance(m.get("by_class"), dict):
        errs += [f"by_class[{k!r}] not a non-negative int" for k, v in m["by_class"].items()
                 if not isinstance(v, int) or v < 0]
    for k in ("flipped_up", "flipped_down", "diverged"):
        if isinstance(m.get(k), list) and not all(isinstance(x, str) for x in m[k]):
            errs.append(f"{k}: ids must be strings")
    return errs


def build(name: str, run: str, gold: str, sessions: int, session_pass: int, turns: int, turn_pass: int,
          by_class: dict, flipped_up: list, flipped_down: list, diverged: list, notes: str = "") -> dict:
    m = {"name": name, "run": run, "gold": gold, "sessions": sessions, "session_pass": session_pass,
         "session_pass_rate": session_pass / sessions if sessions else 0.0, "turns": turns, "turn_pass": turn_pass,
         "turn_pass_rate": turn_pass / turns if turns else 0.0, "by_class": dict(sorted(by_class.items())),
         "flipped_up": sorted(flipped_up), "flipped_down": sorted(flipped_down), "diverged": sorted(diverged),
         "notes": notes}
    errs = validate(m)
    if errs:
        raise ValueError("metrics.json invalid: " + "; ".join(errs))
    return m


def load(path: str) -> dict:
    m = json.load(open(path))
    errs = validate(m)
    if errs:
        raise SystemExit(f"{path}: invalid metrics.json: " + "; ".join(errs))
    return m


def diff_table(a: dict, b: dict) -> str:
    rows = [("session_pass", a["session_pass"], b["session_pass"], a["sessions"], b["sessions"]),
            ("turn_pass", a["turn_pass"], b["turn_pass"], a["turns"], b["turns"])]
    lines = [f"before: {a['name']}   after: {b['name']}", "",
             f"{'metric':<22}{'before':>14}{'after':>14}{'delta':>8}{'rate delta':>12}"]
    for k, x, y, nx, ny in rows:
        lines.append(f"{k:<22}{f'{x}/{nx}':>14}{f'{y}/{ny}':>14}{y - x:>+8d}{100 * (y / ny - x / nx):>+11.2f}pp")
    classes = sorted(set(a["by_class"]) | set(b["by_class"]), key=lambda c: -(a["by_class"].get(c, 0)))
    lines += ["", f"{'failed-turn class':<44}{'before':>8}{'after':>8}{'delta':>8}"]
    for c in classes:
        x, y = a["by_class"].get(c, 0), b["by_class"].get(c, 0)
        lines.append(f"{c:<44}{x:>8}{y:>8}{y - x:>+8d}")
    # flips of `after` are relative to its own baseline; also recompute across the two files when
    # both name the same baseline turn set (flipped_* of each side are against the recording)
    lines += ["", f"flipped_up {len(b['flipped_up'])}  flipped_down {len(b['flipped_down'])}  "
                  f"diverged {len(b['diverged'])} (after vs its recorded baseline)"]
    up_a, down_a = set(a["flipped_up"]), set(a["flipped_down"])
    up_b, down_b = set(b["flipped_up"]), set(b["flipped_down"])
    if True:
        # turns whose pass state differs between the two files, reconstructed from the flips
        gained = (up_b - up_a) | (down_a - down_b)
        lost = (down_b - down_a) | (up_a - up_b)
        lines.append(f"net between the two files: +{len(gained)} turns gained, -{len(lost)} lost")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--validate", action="store_true", help="only validate the given files")
    args = ap.parse_args()
    if args.validate:
        bad = 0
        for f in args.files:
            errs = validate(json.load(open(f)))
            print(f"{f}: {'ok' if not errs else '; '.join(errs)}")
            bad += bool(errs)
        sys.exit(1 if bad else 0)
    if len(args.files) != 2:
        ap.error("give BEFORE.json AFTER.json")
    print(diff_table(load(args.files[0]), load(args.files[1])))


if __name__ == "__main__":
    main()
