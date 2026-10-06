"""Hygiene for one eval world's new sessions: near-duplicates (cos >= 0.95, 6+ words) against the
train corpus (pair shown) and against the held-out pool (own message only; the held-out text is never shown).

    HF_HUB_OFFLINE=1 $PY authored/evalkit/hyg.py MINE.gold.jsonl [--train GLOB] [--held DIR]

MINE is the world's `<W>.gold.jsonl` from build.py. --train is a glob of the train worlds' built
`*.gold.jsonl` (default: the TRAIN_GOLD environment variable); sessions of val worlds are dropped
(authored/split.py). --held is the directory of the held-out sets, val.jsonl and test.jsonl
(default: eval/sets of this repo). A message of MINE with six words or more is a problem when it
repeats an earlier message of MINE (SELF-DUP), sits within cos 0.95 of a train message (TRAIN-DUP) or
equals or sits within cos 0.95 of a held-out message (HELD-DUP). Shorter messages are exempt: short
generic messages collide by nature. Sessions already frozen in the held-out sets show up as HELD-DUP.
Exit 1 on any problem.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "authored"))
import gate  # noqa: E402
import split  # noqa: E402

DUP_COS, MIN_WORDS = 0.95, 6
norm = lambda x: " ".join(x.lower().split())  # noqa: E731


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mine")
    ap.add_argument("--train", default=os.environ.get("TRAIN_GOLD"), help="glob of the train worlds' *.gold.jsonl")
    ap.add_argument("--held", default=str(REPO / "eval" / "sets"), help="directory with val.jsonl and test.jsonl")
    a = ap.parse_args()
    if not a.train:
        sys.exit("hyg.py: give --train GLOB or set TRAIN_GOLD (the train worlds' built *.gold.jsonl)")
    mine = [(s["id"], t["user"]) for l in open(a.mine) if l.strip() for s in [json.loads(l)] for t in s["turns"]]
    mine6 = [(i, m) for i, m in mine if len(m.split()) >= MIN_WORDS]
    seen, dup = {}, []
    for i, m in mine:
        if len(m.split()) >= MIN_WORDS and norm(m) in seen:
            dup.append((i, m, seen[norm(m)]))
        seen.setdefault(norm(m), i)
    train_ses = split.drop_val([json.loads(l) for f in sorted(glob.glob(a.train)) for l in open(f) if l.strip()])
    train = sorted({t["user"] for s in train_ses for t in s["turns"]})
    if not train:
        sys.exit(f"hyg.py: no train sessions match {a.train!r}")
    sets = [Path(a.held) / f for f in ("val.jsonl", "test.jsonl")]
    if not all(f.exists() for f in sets):
        sys.exit(f"hyg.py: no val.jsonl and test.jsonl in {a.held} (--held)")
    held = [t["user"] for f in sets for l in open(f) if l.strip() for t in json.loads(l)["turns"]]
    bad = 0
    if mine6:
        E, Et, Eh = gate.embed([m for _, m in mine6]), gate.embed(train), gate.embed(held)
        st, sh = E @ Et.T, E @ Eh.T
        held_norm = {norm(h) for h in held}
        for k, (i, m) in enumerate(mine6):
            j = int(st[k].argmax())
            if st[k, j] >= DUP_COS:
                bad += 1
                print(f"TRAIN-DUP {i}: {m!r} ~ train {train[j]!r} ({st[k, j]:.3f})")
            if sh[k].max() >= DUP_COS or norm(m) in held_norm:
                bad += 1
                print(f"HELD-DUP {i}: {m!r} is too close to a held-out message; reword it")
    for i, m, o in dup:
        bad += 1
        print(f"SELF-DUP {i}: {m!r} repeats {o}")
    print(f"hygiene: {bad} problems over {len(mine)} messages -> {'PASS' if bad == 0 else 'FAIL'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
