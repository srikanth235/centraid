"""`render_frames.render_one`, plus a crash guard -- and NOTHING else.

    python3 render_guard.py --in out/raw-suite.jsonl \
                            --out out/raw-suite.rendered.jsonl

WHY THIS FILE EXISTS.  The local arms decode under a GBNF grammar, so the
frames `render_frames.py` sees are always structurally legal JSON-schema
instances even when they are semantically wrong.  A FREE-RUNNING model has no
such constraint, and Sonnet emitted at least one frame whose `args` is a list
of STRINGS rather than a list of objects:

    {"cmds": [{"args": ["Rolls to sort"], ...}], "head": "write"}

`render_frames.content_literals` does `arg.get("name")` on that string and
raises `AttributeError` OUTSIDE `render_one`'s try blocks, which kills the
process instead of recording the turn.

THIS IS NOT A REPAIR AND NOT A WEAKENING.  The guard can only ever turn a
CRASH into an EMPTY canonical -- the same failure the row already deserved,
recorded rather than fatal.  It cannot turn a failure into a pass: the success
path is `render_frames.render_one`'s own return value, untouched.  The shared
`experiments/afm-spike/render_frames.py` is deliberately NOT edited, so no
other lane's numbers move.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (AFM, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import render_frames  # noqa: E402

CRASHES = []

# Bound ONCE, at import, so the guard always calls the real implementation
# even while `render_frames.render_one` is patched to point at the guard.
_REAL = render_frames.render_one


def render_one(stage_b, haystack):
    try:
        return _REAL(stage_b, haystack)
    except Exception as exc:          # a frame shape the grammar forbade
        CRASHES.append(stage_b)
        return "", "unrenderable: %s: %s" % (type(exc).__name__, exc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    args = ap.parse_args()
    # `run_batch` verbatim, with the guarded `render_one`.
    render_frames.render_one = render_one
    try:
        rc = render_frames.run_batch(args.src, args.dst)
    finally:
        render_frames.render_one = _REAL
    if CRASHES:
        print("guard: %d frame(s) crashed the renderer and were recorded as "
              "unrenderable failures" % len(CRASHES))
        for raw in CRASHES:
            print("   %s" % json.dumps(raw)[:200])
    return rc


if __name__ == "__main__":
    sys.exit(main())
