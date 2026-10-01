"""Build the SCREENING SET: 30 sessions of each corpus, stratified by category.

    python3 make_screen.py            # writes screen90.json
    python3 make_screen.py --check    # non-zero if the file is stale

The exploratory sweep screens wide and shallow, then promotes survivors to the
full 434.  A screen is only worth anything if every model sees the SAME
sessions, so the set is written to a file once and loaded by every run; it is
never regenerated per model.

STRATIFIED, not head-of-list.  `suite` has 18 categories and `blind` 14, with
long tails (`correction` 2, `cross_app_hop` 1).  Taking the first 30 session
ids in sort order drops whole categories, and a screen that never asks a
`refusal` question measures something other than the corpus.  So each category
gets `round(30 * share)` sessions, every category that exists gets at least
one, and the remainder goes to the largest categories.  Within a category the
pick is a seeded shuffle, so it is reproducible and is not "the first ones",
which correlate with authoring order.

BY SESSION, never by turn.  Strict sessions is the metric and half a session
is not a session: a follow-up turn without its opening turn is a different
question.

HONEST PRECISION.  30 sessions per corpus puts the confidence interval near
+/-15 points around 50%.  That answers "is this model anywhere near the floor"
and does NOT rank two models a few points apart.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")
OUT = os.path.join(HERE, "screen90.json")

PER_CORPUS = 30
SEED = 20260922


def pick(corpus, want=PER_CORPUS, seed=SEED):
    rows = json.load(open(os.path.join(EVAL, "%s.json" % corpus),
                          encoding="utf-8"))["sessions"]
    by_category = {}
    for session in rows:
        by_category.setdefault(session.get("category", "?"), []).append(session["id"])
    total = len(rows)
    # proportional, floor, then at least one per category
    quota = {c: max(1, int(round(want * len(ids) / total)))
             for c, ids in by_category.items()}
    # trim or grow to exactly `want`, always off the largest categories first
    order = sorted(by_category, key=lambda c: (-len(by_category[c]), c))
    while sum(quota.values()) > want:
        for category in reversed(order):
            if sum(quota.values()) == want:
                break
            if quota[category] > 1:
                quota[category] -= 1
    while sum(quota.values()) < want:
        for category in order:
            if sum(quota.values()) == want:
                break
            if quota[category] < len(by_category[category]):
                quota[category] += 1
    chosen = []
    for category in sorted(by_category):
        ids = sorted(by_category[category])
        rng = random.Random("%s/%s/%d" % (corpus, category, seed))
        rng.shuffle(ids)
        chosen += ids[:quota[category]]
    if len(chosen) != want:
        raise AssertionError("%s: picked %d, wanted %d" % (corpus, len(chosen), want))
    return sorted(chosen), {c: quota[c] for c in sorted(quota)}


def build():
    out = {"$note": "the screening set -- 30 sessions per corpus, stratified "
                    "by category, seed %d. Regenerating this invalidates every "
                    "screen number already taken." % SEED,
           "seed": SEED, "per_corpus": PER_CORPUS, "sessions": {},
           "quota": {}}
    for corpus in ("suite", "blind", "holdout"):
        chosen, quota = pick(corpus)
        out["sessions"][corpus] = chosen
        out["quota"][corpus] = quota
    return out


DEV = os.path.join(HERE, "dev10.json")
DEV15 = os.path.join(HERE, "dev15.json")
DEV_N = 10


def build_dev(seed=SEED):
    """DEV-10: ten suite sessions that are NOT in the screening set.

    A prompt tuned on screening sessions would contaminate every screen
    number already taken and every one still to come, so the tuning loop gets
    its own sessions and never sees `screen90`.  Suite holds 120 sessions and
    the screen uses 30, so 90 are untouched and ten of them cost nothing.

    Stratified the same way, for the same reason: ten sessions all of one
    category would tune the prompt for that category.
    """
    rows = json.load(open(os.path.join(EVAL, "suite.json"),
                         encoding="utf-8"))["sessions"]
    taken = set(load()["sessions"]["suite"])
    free = [s for s in rows if s["id"] not in taken]
    by_category = {}
    for session in free:
        by_category.setdefault(session.get("category", "?"), []).append(session["id"])
    # one from each of the ten largest untouched categories: with ten slots
    # and eighteen categories, breadth beats proportion
    order = sorted(by_category, key=lambda c: (-len(by_category[c]), c))
    chosen = []
    for category in order[:DEV_N]:
        ids = sorted(by_category[category])
        rng = random.Random("dev/%s/%d" % (category, seed))
        rng.shuffle(ids)
        chosen.append(ids[0])
    if len(chosen) != DEV_N:
        raise AssertionError("dev: picked %d" % len(chosen))
    overlap = sorted(set(chosen) & taken)
    if overlap:
        raise AssertionError("DEV-10 overlaps the screening set: %s" % overlap)
    return {"$note": "the tuning set. NEVER iterate against screen90.json; "
                     "these ten suite sessions are disjoint from it.",
            "seed": seed, "sessions": {"suite": sorted(chosen)},
            "categories": {c: by_category[c][0] for c in order[:DEV_N]}}


def dev_keys():
    """{(corpus, session)} for the tuning set, PROVEN disjoint from the screen."""
    return _tuning_keys(DEV)


def dev15_keys():
    """DEV-15: dev10 plus one session each for the five categories dev10 has
    none of -- correction, reference_into_result, undo, write_only, write_set.

    dev10 takes one session from each of the ten LARGEST untouched categories,
    which is the right rule for a ten-slot set and leaves the small categories
    out entirely.  A tuning set with no write-only and no undo session cannot
    say anything about writes or undo, so the five are added explicitly rather
    than by raising DEV_N (which would re-draw the ten and invalidate every
    dev-10 number already taken).  `dev10.json` is untouched and still
    selectable on its own.
    """
    return _tuning_keys(DEV15)


def _tuning_keys(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = {(corpus, name)
           for corpus, names in data["sessions"].items() for name in names}
    clash = sorted(out & keys())
    if clash:
        raise AssertionError(
            "the tuning set overlaps the screening set (%s). Tuning against a "
            "screening session invalidates every screen number already "
            "reported." % clash)
    return out


def load():
    with open(OUT, encoding="utf-8") as fh:
        return json.load(fh)


def keys():
    """{(corpus, session)} -- what a runner filters on."""
    data = load()
    return {(corpus, name)
            for corpus, names in data["sessions"].items() for name in names}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    built = build()
    if args.check:
        if not os.path.exists(OUT) or load() != built:
            print("screen90.json is stale; re-run make_screen.py")
            return 1
        print("screen90.json is current")
        return 0
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(built, fh, indent=1, sort_keys=True)
        fh.write("\n")
    turns = 0
    rows = {}
    for corpus in ("suite", "blind", "holdout"):
        data = json.load(open(os.path.join(EVAL, "%s.json" % corpus),
                              encoding="utf-8"))
        wanted = set(built["sessions"][corpus])
        got = [s for s in data["sessions"] if s["id"] in wanted]
        n = sum(len(s["turns"]) for s in got)
        rows[corpus] = (len(got), n, len(data["sessions"]),
                        sum(len(s["turns"]) for s in data["sessions"]))
        turns += n
    print("wrote %s" % OUT)
    for corpus, (sessions, n, all_sessions, all_turns) in rows.items():
        print("  %-8s %2d/%-3d sessions  %3d/%-3d turns  %d categories"
              % (corpus, sessions, all_sessions, n, all_turns,
                 len(built["quota"][corpus])))
    print("  total     90 sessions, %d turns" % turns)
    return 0


if __name__ == "__main__":
    sys.exit(main())
