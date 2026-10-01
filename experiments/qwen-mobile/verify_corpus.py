"""Verify a training corpus against the frame, the renderer and the sentence.

Written for the (now parked) Kaggle LoRA bake-off, where it filtered the training set.
Standalone: it needs only the repository's own modules and Python.

    python3 verify_corpus.py                       # every corpus, the comparison table
    python3 verify_corpus.py ../canon-model/data/distill.jsonl

Two gates, and the difference between them is the finding.

**Gate 1, the round trip.** `target -> check.parse -> frame.encode -> to_flat -> JSON ->
from_flat -> to_canonical -> check.parse`, tree-equal to the original parse, with
`render_frames.render_one` doing the rebuild so the VERBATIM rule runs too. This is
exactly the path the model plus the renderer runs at inference, so a row that fails it is
a row no model could get right.

**Gate 2, handle recoverability.** Is every literal the target carries recoverable from
what the person said? Split by class: HANDLES (`called`, and the content-bearing write
arguments -- things that NAME something in the vault) against KEYWORDS (`status:
"completed"` for "mark it done", `currency in ("GBP")` for "in pounds"). A row whose
HANDLE appears nowhere in the sentence or the previous canonical is a row the model
cannot get right by reading, and some of them are simply mispaired. Keyword absence is a
lexical mapping the model must learn and is NOT a drop.

Measured at commit 11c9c796:

| corpus | rows | gate 1 | + gate 2 | kept |
| --- | --- | --- | --- | --- |
| distill.jsonl | 45 779 | 1 (0.002%) | 56 (0.12%) | 45 722 (99.88%) |
| distill_val.jsonl | 2 159 | 0 | 2 (0.09%) | 2 157 (99.91%) |
| val.jsonl (templates) | 2 213 | 30 (1.36%) | 36 (1.63%) | 2 147 (97.02%) |
| train.jsonl (templates) | 14 043 | 243 (1.73%), 20 do not parse | 279 (1.99%) | 13 521 (96.28%) |

THE COMPARISON IS THE FINDING, not either number alone: the old template corpus is ~16x
more likely than the distilled corpus to hand a model a target whose handle the sentence
never says -- i.e. to train it to invent a name. That is a concrete mechanism behind the
training lane's observation that no model output ever copied a world handle out of a
request.

WHAT THIS DOES **NOT** MEASURE: whether each sentence actually MEANS its canonical. That
is a semantic judgement, `DISTILL.md` says so plainly, and no mechanical gate in this
repository settles it. A drop rate of 0.002% is not a generator error rate and must not be
quoted as one. An execution check is also not available for these rows: `distill.jsonl`'s
canonicals name an invented second world whose handles exist in no vault, so running them
through `run-model` would return nothing for essentially every row.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite",
                                        "grammar"))
CANON = os.path.normpath(os.path.join(HERE, "..", "canon-model"))
for _p in (AFM, GRAMMAR, os.path.join(CANON, "encoder")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import frame  # noqa: E402
import check  # noqa: E402
import render_frames  # noqa: E402

DATA = os.path.join(CANON, "data")

# A value that NAMES something in the vault. Everything else is a keyword.
HANDLE_ARGS = set(render_frames.CONTENT_ARGS) | {"notebook", "album", "folder"}


def literals(flat):
    """(class, where, value) for every string literal a flat frame carries."""
    out = []

    def walk(node, where):
        if not isinstance(node, dict):
            return
        for key in ("called", "called2"):
            if node.get(key):
                out.append(("handle", where + "." + key, node[key]))
        for key in ("filtersA", "filtersB", "filtersC"):
            pred = node.get(key)
            if not pred:
                continue
            for atom in pred.get("atoms") or []:
                if atom.get("valueKind") == "literal" and isinstance(atom.get("value"), str):
                    out.append(("keyword", where + ".filter", atom["value"]))
                for lit in atom.get("lits") or []:
                    if isinstance(lit, str):
                        out.append(("keyword", where + ".oneof", lit))
                if atom.get("set"):
                    walk(atom["set"], where + ".atomset")
        if node.get("combineRight"):
            walk(node["combineRight"], where + ".right")

    if flat.get("set"):
        walk(flat["set"], "set")
    if flat.get("set2"):
        walk(flat["set2"], "set2")
    for cmd in flat.get("cmds") or []:
        for arg in cmd.get("args") or []:
            name = str(arg.get("name"))
            if (arg.get("valueKind") or "literal") == "literal" and \
                    isinstance(arg.get("value"), str):
                out.append(("handle" if name in HANDLE_ARGS else "keyword",
                            "arg." + name, arg["value"]))
            if arg.get("set"):
                walk(arg["set"], "arg.on")
        if cmd.get("on"):
            walk(cmd["on"], "cmd.on")
    return out


def verify(path, label=None, keep=True, examples=4):
    """(kept rows, stats). `kept` rows carry {prev, request, flat, target, ...}."""
    label = label or os.path.basename(path)
    kept, stats = [], collections.Counter()
    hl_tot = hl_abs = kw_tot = kw_abs = 0
    sites = collections.Counter()
    shown = []
    n = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            n += 1
            target = row["target"]
            prev, _, utterance = row["input"].partition(" ||| ")
            prev = "" if prev == "NONE" else prev
            try:
                gold = check.parse(target)
            except Exception:
                stats["target does not parse"] += 1
                continue
            try:
                flat = json.loads(json.dumps(frame.to_flat(frame.encode(gold))))
            except Exception as exc:
                stats["not expressible as a frame (%s)" % type(exc).__name__] += 1
                continue
            haystack = "%s %s" % (prev, utterance)
            canonical, reason = render_frames.render_one(json.dumps(flat), haystack)
            if not canonical:
                stats["renderer refused: " + reason.split(":")[0]] += 1
                continue
            if check.parse(canonical) != gold:
                stats["round-trip is not tree-equal"] += 1
                continue
            said = render_frames.words(haystack)
            unrecoverable = False
            for klass, where, value in literals(flat):
                words = render_frames.words(value)
                if not words:
                    continue
                if klass == "handle":
                    hl_tot += 1
                    if not (words & said):
                        hl_abs += 1
                        unrecoverable = True
                        sites[where] += 1
                        if len(shown) < examples:
                            shown.append((where, value, utterance[:80], target[:80]))
                else:
                    kw_tot += 1
                    if not (words & said):
                        kw_abs += 1
            if unrecoverable:
                stats["handle the sentence never says"] += 1
                continue
            if keep:
                kept.append({"prev": prev, "request": utterance, "flat": flat,
                             "target": target, "head": flat["head"],
                             "template_id": row.get("template_id", ""),
                             "move": row.get("move", "")})
    dropped = sum(stats.values())
    print("\n%-34s rows %6d   verified %6d (%.3f%%)   dropped %d (%.3f%%)"
          % (label, n, n - dropped, 100.0 * (n - dropped) / n, dropped,
             100.0 * dropped / n))
    for why, count in stats.most_common():
        print("      %-46s %d" % (why, count))
    print("      handles %6d absent %4d (%.2f%%) | keywords %5d absent %4d (%.2f%%)"
          "  [keyword absence is NOT a drop]"
          % (hl_tot, hl_abs, 100.0 * hl_abs / max(1, hl_tot),
             kw_tot, kw_abs, 100.0 * kw_abs / max(1, kw_tot)))
    if sites:
        print("      unrecoverable handle sites:", dict(sites.most_common(6)))
    for where, value, utterance, target in shown:
        print("      e.g. %-16s %r\n           said: %s\n           gold: %s"
              % (where, value, utterance, target))
    return kept, {"rows": n, "kept": n - dropped, "dropped": dropped,
                  "why": dict(stats), "handle_literals": hl_tot,
                  "handle_absent": hl_abs, "keyword_literals": kw_tot,
                  "keyword_absent": kw_abs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("corpora", nargs="*", help="JSONL files; default: all four")
    args = ap.parse_args()
    paths = args.corpora or [
        os.path.join(DATA, "distill.jsonl"),
        os.path.join(DATA, "distill_val.jsonl"),
        os.path.join(DATA, "val.jsonl"),
        os.path.join(DATA, "train.jsonl"),
    ]
    report = {}
    for path in paths:
        if not os.path.exists(path):
            print("missing:", path)
            continue
        _kept, stats = verify(path, keep=False)
        report[os.path.basename(path)] = stats
    print("\n" + "=" * 78)
    print("DROP RATE, stated plainly:")
    for name, stats in report.items():
        print("  %-26s %6d rows, dropped %4d (%.3f%%)"
              % (name, stats["rows"], stats["dropped"],
                 100.0 * stats["dropped"] / stats["rows"]))
    print("This is a FRAME-EXPRESSIBILITY and HANDLE-RECOVERABILITY rate. It is NOT the\n"
          "distillation generator's semantic error rate, which stays unmeasured. The\n"
          "number worth carrying forward is the RATIO between the distilled corpus and\n"
          "the template corpus, not either one alone.")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
