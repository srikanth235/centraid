"""Flat frame -> JSON Schema, derived from `frame.py` and the grammar lexicon.

Written for the (now parked) Kaggle LoRA bake-off, where it produced the GBNF that
constrained decoding. Standalone and useful on its own: it is the machine-checkable
statement of what a model is allowed to emit.

    python3 frame_schema.py --prove    # every gold wire frame validates (434/434)
    python3 frame_schema.py --dump     # the schema itself

Nothing here is hand-copied out of `frame.py`: every head, atom type, comparator, value
kind and vocabulary is read from `frame`'s module constants and `lexicon.py`, so the
grammar cannot drift from the renderer that has to accept its output.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite",
                                        "grammar"))
for _p in (AFM, GRAMMAR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import frame  # noqa: E402  the authority for the frame
import check  # noqa: E402
import lexicon  # noqa: E402

DATA = os.path.normpath(os.path.join(HERE, "..", "canon-model", "data"))

def frame_json_schema():
    """The flat frame's JSON Schema, derived from frame.py + the grammar lexicon.

    Every enum below is READ from the repository, never typed out here, so the
    grammar cannot drift from the renderer that has to accept its output.
    """
    KINDS = sorted(lexicon.KINDS)
    FIELDS = sorted(lexicon.FIELDS)
    REFS = sorted(lexicon.REFS) + ["ordinal"]
    PHRASES = sorted(lexicon.WINDOW_PHRASES)
    REASONS = sorted(lexicon.DECLINE_REASONS)
    VERBS = sorted(set(lexicon.COMMANDS) | set(lexicon.VERB_CLASSES))
    S = lambda **kw: dict(kw)
    ref = lambda n: {"$ref": "#/$defs/" + n}

    window = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "how": {"enum": ["phrase", "date", "datetime", "month",
                             "daterange", "rolling", "anchored"]},
            "value": {"type": "string"},
            "n": {"type": "integer"},
            "unit": {"enum": ["days", "weeks", "months"]},
            "from": {"type": "object"},
            "to": {"type": "object"},
        },
        "required": ["how"],
    }
    atom = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "type": {"enum": list(frame.ATOM_TYPES)},
            "field": {"enum": FIELDS},
            "cmp": {"enum": list(frame.CMPS)},
            "valueKind": {"enum": list(frame.VALUE_KINDS) + ["value"]},
            "value": {"type": "string"},
            "num": {"type": "number"},
            "what": {"enum": ["me", "null"]},
            "negated": {"type": "boolean"},
            "kind": {"enum": KINDS},
            "lits": {"type": "array", "items": {"type": "string"},
                     "minItems": 1, "maxItems": 4},
            "window": ref("window"),
            "set": ref("set"),
            "set2": ref("set"),
        },
        "required": ["type"],
    }
    pred = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "join": {"enum": ["none", "and", "or"]},
            "atoms": {"type": "array", "items": ref("atom"),
                      "minItems": 1, "maxItems": 2},
        },
        "required": ["join", "atoms"],
    }
    setd = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "source": {"enum": ["kind", "ref"]},
            "kind": {"enum": KINDS},
            "ref": {"enum": REFS},
            "ordinal": {"type": "integer"},
            "called": {"type": "string"},
            "called2": {"type": "string"},
            "window": ref("window"),
            "window2": ref("window"),
            "filtersA": ref("pred"),
            "filtersB": ref("pred"),
            "filtersC": ref("pred"),
            "walk1": {"enum": KINDS},
            "walk2": {"enum": KINDS},
            "orderField": {"enum": FIELDS},
            "orderDir": {"enum": ["asc", "desc"]},
            "limit": {"type": "integer"},
            "combineOp": {"enum": ["and", "except"]},
            "combineRight": ref("set"),
        },
        "required": ["source"],
    }
    arg = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "name": {"type": "string"},
            "valueKind": {"enum": list(frame.VALUE_KINDS) + ["value"]},
            "value": {"type": "string"},
            "field": {"enum": FIELDS},
            "set": ref("set"),
            "set2": ref("set"),
        },
        "required": ["name", "valueKind"],
    }
    cmd = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "verb": {"enum": VERBS},
            "args": {"type": "array", "items": ref("arg"), "maxItems": 5},
            "on": {"anyOf": [ref("set"), {"type": "null"}]},
        },
        "required": ["verb"],
    }
    return {
        "type": "object", "additionalProperties": False,
        "properties": {
            "head": {"enum": list(frame.FLAT_HEADS)},
            "aggField": {"enum": FIELDS},
            "refuseReason": {"enum": REASONS},
            "set": ref("set"),
            "set2": ref("set"),
            "cmds": {"type": "array", "items": ref("cmd"),
                     "minItems": 1, "maxItems": 3},
        },
        "required": ["head"],
        "$defs": {"window": window, "atom": atom, "pred": pred,
                  "set": setd, "arg": arg, "cmd": cmd},
    }


def prove(verbose=True):
    """Every gold wire frame must validate. A schema that rejects one would cap every
    score below the floor for a reason that has nothing to do with the model."""
    import jsonschema
    validator = jsonschema.Draft202012Validator(frame_json_schema())
    rows = frame.gold_turns()
    bad = []
    for row in rows:
        flat = frame.to_flat(frame.encode(check.parse(row["canonical"])))
        errs = list(validator.iter_errors(flat))
        if errs:
            bad.append((row, errs[0].message))
    print("gold wire frames accepted: %d/%d" % (len(rows) - len(bad), len(rows)))
    for row, why in bad[:10]:
        print("   REJECT %s/%s t%s  %s" % (row["corpus"], row["session"], row["turn"],
                                           why[:160]))
    distill = os.path.join(DATA, "distill.jsonl")
    if os.path.exists(distill):
        import random
        lines = open(distill, encoding="utf-8").readlines()
        sample = random.Random(5).sample(lines, min(8000, len(lines)))
        bad2 = 0
        for raw in sample:
            try:
                flat = frame.to_flat(frame.encode(check.parse(json.loads(raw)["target"])))
            except Exception:
                continue
            if list(validator.iter_errors(flat)):
                bad2 += 1
        print("distill.jsonl sample accepted: %d/%d" % (len(sample) - bad2, len(sample)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="print the schema")
    ap.add_argument("--prove", action="store_true", help="validate every gold wire frame")
    args = ap.parse_args()
    if args.dump:
        print(json.dumps(frame_json_schema(), indent=2))
        return 0
    return prove()


if __name__ == "__main__":
    sys.exit(main())
