"""Your mix against the train corpus on four of dist.py's shape features (words per message, answer
filter, act verb, tools) and two phrasing rates. Prints each bucket as mine/train in %, the total
variation distance (TVD) per feature and the line it must stay under.

    $PY authored/evalkit/mix.py MINE.gold.jsonl [--train GLOB]

MINE is the world's `<W>.gold.jsonl` from build.py. --train is a glob of the train worlds' built
`*.gold.jsonl` (default: the TRAIN_GOLD environment variable); sessions of val worlds are dropped
(authored/split.py). The last line is `mix+phrasing: PASS` or `OFF`; the exit status is always 0.
Phrasing lines: messages with a ", i ..." clause stay at or under 6%, messages with spoken numbers,
dates or ranges ("twenty", "fifth", "between", "up to", month names) stay at or over 18%.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "authored"))
import dist  # noqa: E402
import split  # noqa: E402

LINE = {"words per message": 5, "answer filter": 7, "act verb": 10, "tools": 4}
SP = (r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|"
      r"first|second|third|fourth|fifth|tenth|twentieth|thirtieth|\w+teenth|january|february|march|april|may|june|july|"
      r"august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|between|up to|end of|"
      r"till|until|half|quarter|fortnight)\b")
CI_MAX, SP_MIN = 6, 18


def phrasing(ses: list[dict]) -> tuple[float, float]:
    """(% of messages with a ', i' clause, % with spoken numbers, dates or ranges)."""
    msgs = [t["user"].lower() for s in ses for t in s["turns"]]
    n = max(len(msgs), 1)
    return (100 * sum(bool(re.search(r",\s*i\b", x)) for x in msgs) / n,
            100 * sum(bool(re.search(SP, x)) for x in msgs) / n)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mine")
    ap.add_argument("--train", default=os.environ.get("TRAIN_GOLD"), help="glob of the train worlds' *.gold.jsonl")
    a = ap.parse_args()
    if not a.train:
        sys.exit("mix.py: give --train GLOB or set TRAIN_GOLD (the train worlds' built *.gold.jsonl)")
    mine = dist.load([a.mine])
    train = split.drop_val(dist.load(sorted(glob.glob(a.train))))
    if not train:
        sys.exit(f"mix.py: no train sessions match {a.train!r}")
    hm, ht = dist.shape_hists(mine), dist.shape_hists(train)
    bad = 0
    for f, line in LINE.items():
        x, y = hm[f], ht[f]
        nx, ny = sum(x.values()) or 1, sum(y.values()) or 1
        d = dist.tvd(x, y)
        bad += d > line
        keys = sorted(set(x) | set(y), key=lambda k: -y[k])
        print(f"{f}: TVD {d:.1f} (line {line}) {'ok' if d <= line else 'OFF'}")
        print("   " + "  ".join(f"{k}: {100 * x[k] / nx:.0f}/{100 * y[k] / ny:.0f}" for k in keys))
    print("mix:", "PASS" if not bad else f"{bad} feature(s) off")
    ci, sp = phrasing(mine)
    ci_t, sp_t = phrasing(train)
    ok = ci <= CI_MAX and sp >= SP_MIN
    print(f'phrasing: ", i ..." in {ci:.1f}% of messages (train {ci_t:.1f}, line <= {CI_MAX}); '
          f"spoken numbers/dates/ranges in {sp:.1f}% (train {sp_t:.1f}, line >= {SP_MIN}) {'ok' if ok else 'OFF'}")
    print("mix+phrasing:", "PASS" if not bad and ok else "OFF")


if __name__ == "__main__":
    main()
