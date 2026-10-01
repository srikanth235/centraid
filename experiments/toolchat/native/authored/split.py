"""The train / val split of the authored worlds, chosen once and written to authored/split.json.

    python3 authored/split.py            # (re)write split.json, print the split
    python3 authored/split.py --check    # fail if split.json differs from what the rule picks

Three names, no others: train (the worlds the model learns from), val (whole worlds held out of
training; every fix and every decision is derived here), test (the old hand-written sessions,
eval/sets/test.jsonl; scored only at milestones). Val is whole worlds, never a slice of a world:
a world's people, places and rows are shared by all its sessions, so a slice would leak them.

The rule (deterministic, no randomness): rank the worlds by size (rows across every kind, world
name breaks ties); val is the world at the 90th percentile (large), the median (mid) and the 10th
percentile (small). The picked worlds' authored sessions must total 350-470.

Other code imports the helpers:

    from split import drop_val, keep_val, is_val, val_worlds, train_worlds

    train_records = drop_val(records)     # records / sessions (dicts with "world") or world names
                                          # or session ids ("T07-012", "train-T07-012")
    val_sessions = keep_val(sessions)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
SPLIT = HERE / "split.json"
WORLD_ID = re.compile(r"T\d\d")
SESSIONS_OK = (350, 470)  # total authored sessions of the val worlds
QUANTILES = {"large": 0.9, "mid": 0.5, "small": 0.1}


def all_worlds() -> list[str]:
    return sorted(p.stem for p in (HERE / "worlds").glob("T[0-9][0-9].json"))


def world_size(world: str) -> int:
    """Rows across every kind of the world file (lists of rows; scalars like `me` do not count)."""
    spec = json.loads((HERE / "worlds" / f"{world}.json").read_text())
    return sum(len(v) for v in spec.values() if isinstance(v, list))


def load_sessions(world: str) -> list[dict]:
    """The world's authored sessions, exactly as authored/build.py loads them:
    sessions/<W>.py first, then sessions/<W>_*.py in name order."""
    sys.path.insert(0, str(NATIVE / "eval"))
    import gold

    gold._SESSIONS.clear()
    files = [HERE / "sessions" / f"{world}.py"] + sorted((HERE / "sessions").glob(f"{world}_*.py"))
    for f in files:
        spec = importlib.util.spec_from_file_location(f"authored_{f.stem}", f)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    out = [json.loads(json.dumps(s)) for s in gold.sessions()]
    gold._SESSIONS.clear()
    return out


def pick() -> dict:
    worlds = all_worlds()
    ranked = sorted(worlds, key=lambda w: (world_size(w), w))
    val: list[str] = []
    for name, q in QUANTILES.items():
        w = ranked[round(q * (len(ranked) - 1))]
        if w in val:
            raise SystemExit(f"split: the {name} pick {w} is already chosen; too few worlds")
        val.append(w)
    sessions = sum(len(load_sessions(w)) for w in val)
    if not SESSIONS_OK[0] <= sessions <= SESSIONS_OK[1]:
        raise SystemExit(f"split: val worlds {val} hold {sessions} sessions, outside {SESSIONS_OK}")
    return {"val": sorted(val), "train": [w for w in worlds if w not in val]}


def load() -> dict:
    return json.loads(SPLIT.read_text())


def val_worlds() -> list[str]:
    return load()["val"]


def train_worlds() -> list[str]:
    return load()["train"]


def world_of(item) -> str:
    """The world of a record/session dict, a world name, or a session id ("T07-012", "train-T07-012")."""
    if isinstance(item, dict):
        if item.get("world"):
            return item["world"]
        item = item.get("id", "")
    m = WORLD_ID.search(str(item))
    if not m:
        raise ValueError(f"no authored world in {item!r}")
    return m.group(0)


def is_val(item) -> bool:
    return world_of(item) in set(val_worlds())


def drop_val(items):
    """The items that are not in a val world (the training data)."""
    held = set(val_worlds())
    return [x for x in items if world_of(x) not in held]


def keep_val(items):
    """The items in a val world."""
    held = set(val_worlds())
    return [x for x in items if world_of(x) in held]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    split = pick()
    text = json.dumps(split, indent=1) + "\n"
    if a.check:
        if not SPLIT.exists() or SPLIT.read_text() != text:
            raise SystemExit("split.json is stale: run python3 authored/split.py")
        print("split.json is current")
    else:
        SPLIT.write_text(text)
    for w in split["val"]:
        s = load_sessions(w)
        print(f"val {w}: {world_size(w)} rows, {len(s)} sessions, {sum(len(x['turns']) for x in s)} turns")
    print(f"train: {len(split['train'])} worlds")


if __name__ == "__main__":
    main()
