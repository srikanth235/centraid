"""Assemble THE prompt -- one file, fed whole to any model.

    python3 makeprompt.py            # writes prompt.md
    python3 makeprompt.py --check    # non-zero if prompt.md is stale

Generated, never hand-edited, because every part of it is derived from
something that can change underneath it:

  * the instruction block from the generated `Doctrine.swift`
  * the form, the vocabularies and the 153 write commands from `frame.py`
    and the ontology, via `vocabblock`
  * `today` from `crates/evalsuite/<corpus>.json`, the file the scorer reads
  * the rules of use from `crates/evalsuite/grammar/GRAMMAR.md`

Hand-editing the output would let it drift from the grammar it claims to
describe, which is the failure this whole file exists to prevent. Edit a
source or edit `USAGE` below, then regenerate.

ORDER IS DELIBERATE. `today` goes near the TOP. Measured 2026-09-22: the same
sentence appended to the END of a 27k-character prompt was ignored on five of
six date-bearing turns, while the model still dated its answers to the real
wall clock. A fact the model must apply on most turns does not go last.
"""

from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (HERE, AFM):
    if path not in sys.path:
        sys.path.insert(0, path)

import doctrine      # noqa: E402
import vocabblock    # noqa: E402
import datefact      # noqa: E402

OUT = os.path.join(HERE, "prompt.md")
CORPORA = ("suite", "blind", "holdout")

# The grammar's SEMANTICS. `vocabblock` generates the grammar's TERMINALS --
# which kinds, which fields, which verbs -- and no prompt has ever carried the
# rules of USE that `crates/evalsuite/grammar/GRAMMAR.md` states alongside
# them. Every line below cites the rule it comes from, so this block is
# auditable as spec-derived and not as tuning against a model's mistakes.
#
# This is prose, not generated, because GRAMMAR.md is prose. It is the one
# hand-written part of this file and each line must keep its citation.
USAGE = """\
## Which door

The same table reached through two doors is two different kinds, and their
rows do not correspond. Choose by the app the sentence is about.
[GRAMMAR.md:143-144, 172]

    parties        people, through People
    members        people, through Tally
    events         the diary
    activities     logged interactions
    documents      filed paperwork
    locker items   stored secrets and logins
    notes          the Notes library
    journal notes  People's own journal

Naming a person with no money context is `parties`. Locker is not a search
domain, so `locker items` never reaches the text-search plane. [GRAMMAR.md:174]

## Naming a row

Match a row by its label with `called "X"`. Do not write an explicit
`title contains` or `description contains` filter to do the same job:
`called` is a ranked retrieval against the search plane, and it is the only
form that resolves a collision between two rows of the same name.
[GRAMMAR.md:198, 283, C6]

Use the words the person used. Do not guess at a stored title.

## What the words already carry

"due", "overdue", "still to do" carry `status != "completed"` beside their
window. A completed task is not due; it is done. [GRAMMAR.md C1]

"outstanding", "owes", "owed", "unsettled" carry `settled_at is null`.
[GRAMMAR.md C1]

`before now` is the overdue comparison. A named period is a calendar period;
a vague one is a rolling window. Both are inclusive and compared on the date
part. [GRAMMAR.md:223]

## What a reference means

`it` and `them` are the rows the last LIST answered. [GRAMMAR.md:261]

A value question does not replace them. After "who do I owe money to" /
"how much?" / "pay it off", `it` in the third turn is still the party from
the first. [GRAMMAR.md R-X2]

`the last thing I added` is the row the last command created. [GRAMMAR.md:265]

`the earlier one` is the answer TWO turns back. [GRAMMAR.md C13]

An ordinal indexes the answer in the order it was delivered. [GRAMMAR.md C4]

When the PERSON named the antecedent a turn or two back, write the name and
not a reference. After "and Ray?", "log that I called him about it today" is
`on (parties called "Ray Alvarez")`. [GRAMMAR.md C14]

## When to refuse

`fabricated_secret` — only when a WRITE requires a secret value the person
did not supply. Reading a secret the locker already holds is the locker's
purpose and is not a refusal. [GRAMMAR.md R-R3]

`unbounded_destruction` — a destructive verb over a set with no `called`, no
`that` and no window. [GRAMMAR.md R-R4]

`out_of_ontology` — only for what the vault does not hold at all.
"""

# NOT in GRAMMAR.md. Read off gold canonicals (s117 t0 and s95 t1 for the
# first; s65 t1 against s117 t2 for the second), which makes them tuned
# against samples rather than derived from the spec. Included by default
# because the prompt is meant to work, excluded by `--strict-spec` so the
# spec-only prompt stays measurable. Either ground them in GRAMMAR.md or
# amend GRAMMAR.md to state them, then move them into USAGE.
INFERRED = """\
## Not yet in the grammar document

"when did I last …" asks for the ROW, not the maximum:
`show (first 1 of (… ordered by <time field> desc))`.

Write `them` where the previous answer was several rows, `it` where it was
one.
"""

ASK = """\
Say what this turn MEANS by filling in the form. Use only the options offered.
Copy any name, title or value WORD FOR WORD out of the sentence, or out of the
previous turn when the person is refining it. Leave a slot out when the
sentence does not say it.
"""


def build(strict_spec=False):
    parts = [
        "# The form-filling task",
        "",
        doctrine.text().strip(),
        "",
        "# " + datefact.line(CORPORA),
        "",
        "Every relative date resolves against that date: \"friday\", "
        "\"tomorrow\", \"today\",\n\"the 21st\", \"last week\". It is not the "
        "date of any other calendar.",
        "",
        "# The form",
        "",
        vocabblock.block("spec").strip(),
        "",
        "# Rules of use",
        "",
        USAGE.strip(),
    ]
    if not strict_spec:
        parts += ["", INFERRED.strip()]
    parts += ["", "# What to do", "", ASK.strip(), ""]
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="non-zero if prompt.md does not match the sources")
    ap.add_argument("--strict-spec", action="store_true",
                    help="leave out the two rules that are read off gold "
                         "canonicals rather than stated in GRAMMAR.md")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    text = build(args.strict_spec)
    if args.check:
        current = open(args.out, encoding="utf-8").read() if \
            os.path.exists(args.out) else ""
        if current != text:
            print("STALE: %s does not match its sources; regenerate" % args.out)
            return 1
        print("ok: %s matches its sources" % args.out)
        return 0
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("%s  %d chars" % (args.out, len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
