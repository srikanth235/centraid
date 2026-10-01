"""The one fact the corpora assume and no prompt has ever stated.

`crates/evalsuite/{suite,blind,holdout}.json` each declare

    "today": "2026-06-15"

and the scorer resolves every relative date against it.  Nothing in
`doctrine.text()` or in any `vocabblock` block says so, so a model answers
about the real wall-clock day and is marked wrong for being right about the
world.  Measured 2026-09-22: the container clock and `claude -p` both say
2026-09-22, three months after the corpus.  43/248 suite turns, 17/72 blind
and 24/114 holdout resolve a relative date, touching a QUARTER of the sessions
in every corpus -- and a session passes only if every turn passes, so that
quarter is unpassable without this line.

Supplying it is not a hint and not tuning: the harness runs a world anchored
to that date and asks questions inside it.  It is derived, at runtime, from
the same file the scorer reads -- never hardcoded, so it cannot drift from
what the scorer assumes, and never from a model's output or from `Expected`.

The weekday is included because it is load-bearing, not decorative: suite s05
turn 0 asks "who am I having dinner with on tuesday?" and its gold canonical
is `... during tomorrow`, which resolves only if 2026-06-15 is known to be a
Monday.  Both facts come from the corpus value by plain date arithmetic.
"""

from __future__ import annotations

import datetime
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")


def today(corpus):
    """The corpus's own `today`, read from the file the scorer reads."""
    path = os.path.join(EVAL, "%s.json" % corpus)
    with open(path, encoding="utf-8") as fh:
        value = json.load(fh).get("today")
    if not value:
        raise AssertionError("%s declares no `today`" % path)
    return value


def line(corpora):
    """One sentence of fact, or nothing.

    Every corpus in a run must agree, because the prompt is built once for the
    whole run.  If they ever diverge this raises rather than silently stating
    one corpus's date while scoring another's.
    """
    seen = sorted({today(c) for c in corpora})
    if len(seen) != 1:
        raise AssertionError(
            "corpora disagree on `today` (%s); the prompt is built once per "
            "run and cannot state two dates." % ", ".join(seen))
    value = seen[0]
    day = datetime.date.fromisoformat(value)
    return "Today is %s %s." % (day.strftime("%A"), value)


if __name__ == "__main__":
    print(line(("suite", "blind", "holdout")))
