"""Compile the two scored sets, with checks.

    python3 build_sets.py            # writes sets/test.jsonl and sets/val.jsonl and prints counts

test  the 450 hand-written sessions of sessions/*.py (worlds A to D), one file, set "test". Ids keep the
      names they were written under (dev-A-001, test-B-001, ...); the prefix is history, not a split.
      Scored only at milestones; frozen (FROZEN.md).
val   the authored sessions of the val worlds of authored/split.json (whole worlds held out of
      training), set "val". Every fix and decision is derived here. Scored exactly like test:
      seed the worlds (seed_worlds.py), then `run.py --set sets/val.jsonl`.
"""

from __future__ import annotations

import importlib
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "sessions"))
sys.path.insert(0, str(HERE.parent / "authored"))

import gold  # noqa: E402
import split  # noqa: E402
from conventions import tag as tag_conventions  # noqa: E402
from lib import load_keys  # noqa: E402

MODULES = ["A", "B", "C", "D_dev", "D_test"]


def check(session: dict) -> None:
    keys = load_keys(session["world"])
    for turn in session["turns"]:
        for accept in turn["gold"]:
            names = list(accept.get("rows", [])) + list(accept.get("candidates", [])) + list(accept.get("already", []))
            for row in accept.get("diff", {}).get("rows", []):
                if "key" in row:
                    names.append(row["key"])
            for link in accept.get("diff", {}).get("links", []):
                names += [x for x in (link["from"], link["to"]) if x != "new"]
            names += [r["key"] for r in accept.get("reveal", [])]
            for name in names:
                if name not in keys and not name.startswith("+"):
                    raise SystemExit(f"{session['id']}: unknown key {name!r}")


def main() -> None:
    for name in MODULES:
        if (HERE / "sessions" / f"{name}.py").exists():
            importlib.import_module(name)
    sessions = gold.sessions()
    ids = Counter(s["id"] for s in sessions)
    dupes = [i for i, c in ids.items() if c > 1]
    if dupes:
        raise SystemExit(f"duplicate ids {dupes}")
    out = HERE / "sets"
    out.mkdir(exist_ok=True)
    # the sessions files still say which hand-written half a session came from ("dev" then "test"):
    # only its position in the file, so the file order stays the order it was frozen in
    origin = [s for s in sessions if s["set"] == "dev"] + [s for s in sessions if s["set"] == "test"]
    assert len(origin) == len(sessions)
    write(out / "test.jsonl", "test", origin)
    write(out / "val.jsonl", "val", val_sessions())


def val_sessions() -> list[dict]:
    """The val worlds' authored sessions in the eval session format (gold and ref included)."""
    chosen = []
    for w in split.val_worlds():
        chosen += split.load_sessions(w)
    ids = Counter(s["id"] for s in chosen)
    dupes = [i for i, c in ids.items() if c > 1]
    if dupes:
        raise SystemExit(f"duplicate val ids {dupes}")
    return chosen


def write(path: Path, name: str, chosen: list[dict]) -> None:
    for s in chosen:
        s["set"] = name
        check(s)
        tag_conventions(s)
    with open(path, "w", encoding="utf-8") as handle:
        for s in chosen:
            handle.write(json.dumps(s, ensure_ascii=False) + "\n")
    turns = sum(len(s["turns"]) for s in chosen)
    worlds = Counter(s["world"] for s in chosen)
    print(f"{name}: {len(chosen)} sessions, {turns} turns (avg {turns / max(1, len(chosen)):.2f}), worlds {dict(worlds)}")


if __name__ == "__main__":
    main()
