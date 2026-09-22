"""The decision task: label space, featurisation, and the CODE decoder.

The model makes CLASSIFICATIONS over a closed grammar and TAGS spans of the
member's own words.  It never emits a canonical character.  `assemble_from`
below is the only thing that writes a canonical, out of a template drawn from
the training inventory and fills drawn from the terminal vocabularies, so an
illegal command name or an invented field cannot be produced at all.
"""
from __future__ import annotations

import json
import os
import re

from canon_decomp import decompose, assemble, HOLE_TYPES, GRAMMAR, HERE
from render import normalise

DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

# Slots the model classifies (closed vocabulary), with their slot budget.
CLOSED_SLOTS = {
    "KIND": 5, "FIELD": 4, "CMP": 2, "WIN": 2, "VERB": 2, "REF": 2,
    "DIR": 1, "ARG": 4, "REASON": 1, "DATE": 2, "NUM": 2, "DUR": 1,
}
# Slots the model COPIES out of the input text (BIO tagging).
COPY_SLOTS = {"LIT": 5}
NONE = "<none>"


def slot_names():
    out = []
    for t, k in CLOSED_SLOTS.items():
        out += ["%s%d" % (t, i) for i in range(k)]
    return out


def bio_labels():
    out = ["O"]
    for t, k in COPY_SLOTS.items():
        for i in range(k):
            out += ["B-%s%d" % (t, i), "I-%s%d" % (t, i)]
    return out


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("target") == "Unparsed":
                continue
            rows.append(r)
    return rows


def gold_rows():
    """The 434 corpus turns, in infer.py's order, with gold prev threaded."""
    rows = json.load(open(os.path.join(GRAMMAR, "map.json"), encoding="utf-8"))["turns"]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


class Label:
    __slots__ = ("template", "closed", "lits")

    def __init__(self, template, closed, lits):
        self.template = template
        self.closed = closed      # {"KIND0": "events", ...}
        self.lits = lits          # {"LIT0": 'Tahoe', ...} (unquoted)


def label_of(canonical):
    d = decompose(normalise(canonical))
    closed, lits = {}, {}
    for h in d.holes:
        key = "%s%d" % (h.type, h.index)
        if h.type == "LIT":
            lits[key] = h.value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        else:
            closed[key] = h.value
    return Label(d.template, closed, lits)


# --------------------------------------------------------------------------
# decoding: template + head argmaxes -> canonical string, by CODE


def quote(value):
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')


HOLE_RX = re.compile(r"<(%s)#(\d+)>" % "|".join(HOLE_TYPES))


def assemble_from(template, closed, lits, prev_canonical=None):
    """Fill the template's holes.  A LIT the tagger did not find falls back to
    the SAME slot of the previous canonical (a `refine`/`act` turn keeps the
    literal it is refining), then to the empty string."""
    prev_lits = {}
    if prev_canonical and prev_canonical != "NONE":
        try:
            prev_lits = label_of(prev_canonical).lits
        except Exception:
            prev_lits = {}
    fills = {}
    for m in HOLE_RX.finditer(template):
        ty, idx = m.group(1), m.group(2)
        key = "%s%s" % (ty, idx)
        if ty == "LIT":
            val = lits.get(key) or prev_lits.get(key) or ""
            fills[m.group(0)] = quote(val)
        else:
            fills[m.group(0)] = closed.get(key, "") or ""
    return assemble(template, fills)
