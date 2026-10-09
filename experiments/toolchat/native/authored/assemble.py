"""Assemble the trainer's two data files from per-world builds (#1044, phase 7).

    python3 authored/assemble.py train --natural NAT --drills DRILLS --out data/train.jsonl.gz [--ratio 2.0] [--seed 0] [--stats F]
    python3 authored/assemble.py val --build VAL_OUT --out data/train-val.jsonl.gz

`train`: the natural sessions of every train world of authored/split.json, in its order (`NAT/<W>/<W>.jsonl.gz`, build.py
output), then the decision drills (`DRILLS/<W>.kept.jsonl.gz`, authored/gen/drills.py output) capped at RATIO times the
natural turns: whole minimal pairs only, drawn at random with SEED. A drill record without a `pair:<id>` tag (drills.py
output from before it wrote one) gets the tag from its id (`<W>-D0001a` / `b`), so train.py batches the two siblings in one
step. Fails on a missing world, an orphaned sibling, a val world or a duplicate id.

`val`: the loss slice. The val-world and recipe-authored builds (`VAL_OUT/<W>.jsonl.gz` for T12 T03 T23 D B A C, in that
order) kept only when the session is in eval/sets/val.jsonl, its messages are the set's messages, and no turn of it is a
val-only fix (`eval/regen.py` FIXES): the build's gold does not carry those fixes, so such a session would put the old gold
in the loss. Records are not changed.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import io
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VAL_WORLDS = ("T12", "T03", "T23", "D", "B", "A", "C")


def read(path: Path) -> list[dict]:
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def write(path: Path, records: list[dict]) -> None:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, filename="") as g:
        for r in records:
            g.write((json.dumps(r, ensure_ascii=False) + "\n").encode())
    Path(path).write_bytes(buf.getvalue())


def train(a) -> int:
    split = json.load(open(ROOT / "authored/split.json"))
    worlds, val = split["train"], set(split["val"])
    nat, per_world = [], collections.Counter()
    for w in worlds:
        p = Path(a.natural) / w / f"{w}.jsonl.gz"
        if not p.exists():
            sys.exit(f"natural build missing for {w}: {p}")
        rs = read(p)
        assert all(r["world"] == w for r in rs), w
        nat += rs
        per_world[w] = len(rs)
    nat_turns = sum(r["n_turns"] for r in nat)
    pairs = collections.defaultdict(list)
    for w in worlds:
        p = Path(a.drills) / f"{w}.kept.jsonl.gz"
        if not p.exists():
            sys.exit(f"drills missing for {w}: {p}")
        for r in read(p):
            m = re.match(r"(?:train-)?(.*-D\d+)[ab]$", r["id"])
            assert m, r["id"]
            if not any(str(t).startswith("pair:") for t in r.get("tags", [])):
                r["tags"] = [*r.get("tags", []), "pair:" + m.group(1)]
            pairs[m.group(1)].append(r)
    orphans = [k for k, v in pairs.items() if len(v) != 2]
    assert not orphans, f"{len(orphans)} orphaned siblings, e.g. {orphans[:3]}"
    keys = sorted(pairs)
    random.Random(a.seed).shuffle(keys)
    budget, drills, dturns = a.ratio * nat_turns, [], 0
    for k in keys:
        t = sum(r["n_turns"] for r in pairs[k])
        if dturns + t <= budget:
            drills += pairs[k]
            dturns += t
    assert not any(r["world"] in val for r in nat + drills), "a val world in train"
    ids = [r["id"] for r in nat + drills]
    assert len(ids) == len(set(ids)), "duplicate ids"
    write(Path(a.out), nat + drills)
    stats = {"natural_sessions": len(nat), "natural_turns": nat_turns, "natural_per_world": dict(per_world),
             "drill_pairs_kept": len(pairs), "drill_sessions": len(drills), "drill_turns": dturns,
             "drill_cells": dict(collections.Counter(r["tags"][1] for r in drills)),
             "drill_per_world": dict(collections.Counter(r["world"] for r in drills)),
             "records": len(nat) + len(drills), "turns": nat_turns + dturns, "ratio": a.ratio, "seed": a.seed}
    print(json.dumps({k: v for k, v in stats.items() if not isinstance(v, dict)}))
    if a.stats:
        Path(a.stats).write_text(json.dumps(stats, indent=1))
    return 0


def val_slice(a) -> int:
    sys.path.insert(0, str(ROOT / "eval"))
    import regen  # noqa: E402

    sets = {s["id"]: s for s in map(json.loads, open(ROOT / "eval/sets/val.jsonl"))}
    fixed = {sid for sid, _turn in regen.FIXES}
    out, why = [], collections.Counter()
    for w in VAL_WORLDS:
        for r in read(Path(a.build) / f"{w}.jsonl.gz"):
            sid = r["id"].split("-", 1)[1]
            if sid not in sets:
                why["not in val"] += 1
                continue
            if sid in fixed:
                why["val fix"] += 1
                continue
            users = [m["content"] for m in r["messages"] if m["role"] == "user"]
            want = [t["user"] for t in sets[sid]["turns"]]  # a record's user message is the harness block, a blank line, the message
            if len(users) != len(want) or any(u.split("\n\n")[-1] != v for u, v in zip(users, want)):
                why["message differs from val"] += 1
                continue
            out.append(r)
    write(Path(a.out), out)
    print(len(out), "records,", sum(r["n_turns"] for r in out), "turns;", dict(collections.Counter(r["world"] for r in out)),
          "left out", dict(why))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--natural", required=True)
    t.add_argument("--drills", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--ratio", type=float, default=2.0)
    t.add_argument("--seed", type=int, default=0)
    t.add_argument("--stats")
    v = sub.add_parser("val")
    v.add_argument("--build", required=True)
    v.add_argument("--out", required=True)
    a = ap.parse_args()
    return train(a) if a.cmd == "train" else val_slice(a)


if __name__ == "__main__":
    sys.exit(main())
