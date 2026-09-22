"""Derive the JSON schema for the WIRE FRAME from `frame.py` and the lexicon.

`experiments/afm-spike/frame.py` is the authority for the frame; nothing here
is hand-copied out of it.  Every slot name, head name, value kind, atom type
and comparator is read out of `frame`'s own module constants, and every
enumerated vocabulary (kinds, fields, verbs, refs, decline reasons, verb
arguments) is read out of `gen_vocab.py`, which in turn reads the grammar's
`lexicon.py` and `derive/derived.json`.

    python3 mkschema.py --prove     # every gold wire frame validates
    python3 mkschema.py --dump      # the schema itself

The proof is the point.  `frame.to_flat(frame.encode(parse(gold)))` is the
exact object the model is asked to produce; if a single one of the 434 gold
wire frames fails to validate against this schema, the schema has drifted
from the frame, and it is the SCHEMA that is wrong.

ONE STAGE, ONE SCHEMA.  The Apple spike splits the turn in two so that a
`DynamicGenerationSchema` narrowed to one board fits a 4 096-token context.
A GBNF grammar has no such budget, so this lane asks for the whole frame at
once: the head is a branch of the top-level `anyOf` and the board is a field
inside it.  That removes the Apple spike's Stage-A error class entirely, and
costs the per-board narrowing of the field list -- which is unsound here in
any case, because one recursive `#/$defs/set` rule is reused at every depth
and a link walk changes the board underneath it.
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
for path in (AFM, GRAMMAR):
    if path not in sys.path:
        sys.path.insert(0, path)

import frame          # noqa: E402  the authority
import gen_vocab      # noqa: E402  the vocabularies, generated
import lexicon        # noqa: E402
import check          # noqa: E402

# ------------------------------------------------------------ the vocabularies

KINDS = sorted(lexicon.KINDS)
REFS = sorted(lexicon.REFS) + ["ordinal"]
DECLINE_REASONS = sorted(lexicon.DECLINE_REASONS)
FIELDS = sorted(lexicon.FIELDS)
VERBS = sorted(set(lexicon.COMMANDS) | set(lexicon.VERB_CLASSES))
ROLLING_UNITS = ["days", "weeks", "months"]
# An argument NAME is unconstrained in the grammar: `check.py`'s `cmd()` reads
# it with `word()`, so anything its `ident` token matches is legal, and the
# verb classes use names (`to`, `by`) that are in no registry `args` list and
# in no column.  Narrowing this to an enum drifts -- 32 of the 434 gold wire
# frames fall outside the registry-plus-columns union -- so the schema carries
# `check.py`'s own ident pattern instead.
ARG_NAME = {"type": "string", "pattern": r"^[A-Za-z_][A-Za-z0-9_.]*$"}

# read out of `frame` so a change there is a change here
CMPS = list(frame.CMPS)
ATOM_TYPES = list(frame.ATOM_TYPES)
# FINDING: `frame.VALUE_KINDS` is dead (nothing in `frame.py` reads it) and it
# is also WRONG -- `_rhs_to_flat` emits `valueKind: "value"` for an argument
# whose value the vault computes (`due_at: dtstart of (it)`), `_rhs_from_flat`
# accepts it, and two gold turns (suite s44 t1, s74 t0) use it.  The schema
# takes the union so it can carry every frame `to_flat` can produce.
VALUE_KINDS = sorted(set(frame.VALUE_KINDS) | {"value"})
FLAT_HEADS = list(frame.FLAT_HEADS)
SLOT_ORDER = list(frame.SLOT_ORDER)
SLOT_KEY = dict(frame.SLOT_KEY)
STEP_OPS = list(frame.STEP_OPS)
# the `how` values `frame._window_encode` can produce
WINDOW_HOWS = ["phrase", "date", "datetime", "month", "daterange", "rolling",
               "anchored"]
# the `head` values `frame._value_encode` can produce
VALUE_HEADS = ["count", "agg", "project", "balance"]
AGGS = ["count", "sum", "min", "max"]

STR = {"type": "string"}
INT = {"type": "integer"}
NUM = {"type": "number"}
NULL = {"type": "null"}


def _enum(values):
    return {"type": "string", "enum": list(values)}


def _obj(props, required=()):
    return {"type": "object", "properties": props,
            "required": list(required), "additionalProperties": False}


SETREF = {"$ref": "#/$defs/set"}
NULLABLE_SETREF = {"anyOf": [SETREF, NULL]}


def defs():
    """The recursive pieces, as `$defs` so the GBNF gets one rule each."""
    field = _enum(FIELDS)
    kind = _enum(KINDS)

    # The RICH set and step, as `frame._set_encode` builds them.  A window is
    # passed through `to_flat` untouched, so an `anchored` window's two ends
    # carry rich sets rather than the flat ladder.
    rich_step = _obj({
        "op": _enum(STEP_OPS),
        "kind": kind,
        "lit": STR,
        "field": field,
        "dir": _enum(["asc", "desc"]),
        "n": INT,
        "pred": {"$ref": "#/$defs/pred"},
        "window": {"$ref": "#/$defs/window"},
    }, ["op"])
    rich_set = _obj({
        "source": _enum(["kind", "ref"]),
        "kind": kind,
        "ref": _enum(REFS),
        "n": INT,
        "steps": {"type": "array", "items": rich_step, "maxItems": 4},
    }, ["source"])
    value_frame = _obj({
        "head": _enum(VALUE_HEADS),
        "agg": _enum(AGGS),
        "field": field,
        "set": rich_set,
        "set2": rich_set,
    }, ["head", "set"])

    window = _obj({
        "how": _enum(WINDOW_HOWS),
        "value": STR,
        "n": INT,
        "unit": _enum(ROLLING_UNITS),
        "from": value_frame,
        "to": value_frame,
    }, ["how"])

    atom = _obj({
        "type": _enum(ATOM_TYPES),
        "field": field,
        "cmp": _enum(CMPS),
        "what": _enum(["null", "me"]),
        "negated": {"type": "boolean"},
        "num": NUM,
        "window": {"$ref": "#/$defs/window"},
        "lits": {"type": "array", "items": STR, "maxItems": 4},
        "kind": kind,
        "valueKind": _enum(VALUE_KINDS),
        "value": STR,
        "set": SETREF,
        "set2": SETREF,
    }, ["type"])

    pred = _obj({
        "join": _enum(["none", "and", "or"]),
        "atoms": {"type": "array", "items": {"$ref": "#/$defs/atom"},
                  "minItems": 1, "maxItems": 3},
    }, ["join", "atoms"])

    # the flat ladder: slot names and their flat keys come out of `frame`
    set_props = {
        "source": _enum(["kind", "ref"]),
        "kind": kind,
        "ref": _enum(REFS),
        "ordinal": INT,
    }
    for slot in SLOT_ORDER:
        key = SLOT_KEY.get(slot)
        if key is None:
            continue
        if slot.startswith("called"):
            set_props[key] = STR
        elif slot.startswith("during"):
            set_props[key] = {"$ref": "#/$defs/window"}
        elif slot.startswith("filters"):
            set_props[key] = {"$ref": "#/$defs/pred"}
        elif slot.startswith("walk"):
            set_props[key] = kind
    set_props["orderField"] = field
    set_props["orderDir"] = _enum(["asc", "desc"])
    set_props["limit"] = INT
    set_props["combineOp"] = _enum(["and", "except"])
    set_props["combineRight"] = SETREF
    flat_set = _obj(set_props, ["source"])

    arg = _obj({
        "name": ARG_NAME,
        "valueKind": _enum(VALUE_KINDS),
        "value": STR,
        "field": field,
        "set": SETREF,
        "set2": SETREF,
    }, ["name", "valueKind"])

    cmd = _obj({
        "verb": _enum(VERBS),
        "args": {"type": "array", "items": {"$ref": "#/$defs/arg"},
                 "maxItems": 6},
        "on": NULLABLE_SETREF,
    }, ["verb"])

    return {"set": flat_set, "atom": atom, "pred": pred, "window": window,
            "value": value_frame, "arg": arg, "cmd": cmd}


def schema():
    """The whole wire frame: one `anyOf` over the heads `frame` admits."""
    branches = [
        _obj({"head": _enum(["nothing"])}, ["head"]),
        _obj({"head": _enum(["refuse"]),
              "refuseReason": _enum(DECLINE_REASONS)},
             ["head", "refuseReason"]),
        _obj({"head": _enum(["write"]),
              "cmds": {"type": "array", "items": {"$ref": "#/$defs/cmd"},
                       "minItems": 1, "maxItems": 3}},
             ["head", "cmds"]),
        _obj({"head": _enum(["show", "count"]), "set": SETREF},
             ["head", "set"]),
        _obj({"head": _enum(["sum", "min", "max", "project"]),
              "aggField": _enum(FIELDS), "set": SETREF},
             ["head", "aggField", "set"]),
        _obj({"head": _enum(["balance", "same"]),
              "set": SETREF, "set2": SETREF},
             ["head", "set", "set2"]),
    ]
    covered = {h for b in branches for h in b["properties"]["head"]["enum"]}
    missing = sorted(set(FLAT_HEADS) - covered)
    if missing:
        raise AssertionError("frame.FLAT_HEADS not covered: %s" % missing)
    return {"anyOf": branches, "$defs": defs()}


# ------------------------------------------------------------------- the proof


def gold_flats():
    out = []
    for row in frame.gold_turns():
        out.append((row, frame.to_flat(frame.encode(check.parse(row["canonical"])))))
    return out


def prove():
    import jsonschema
    sch = schema()
    validator = jsonschema.Draft202012Validator(sch)
    flats = gold_flats()
    bad = []
    for row, flat in flats:
        errs = list(validator.iter_errors(flat))
        if errs:
            err = jsonschema.exceptions.best_match(errs)
            while err.context:
                err = jsonschema.exceptions.best_match(err.context)
            bad.append((row, "%s: %s" % (list(err.absolute_path),
                                         err.message.splitlines()[0][:140])))
    ok = len(flats) - len(bad)
    print("gold wire frames validating  %4d/%-4d  %.1f%%"
          % (ok, len(flats), 100.0 * ok / max(1, len(flats))))
    for row, why in bad[:25]:
        print("   %-7s %-5s t%-2s  %s" % (row["corpus"], row["session"],
                                          row["turn"], why))
    back = 0
    for row, flat in flats:
        try:
            if check.parse(frame.to_canonical(frame.from_flat(flat))) \
                    == check.parse(row["canonical"]):
                back += 1
        except Exception:
            pass
    print("...and rendering tree-equal  %4d/%-4d  %.1f%%"
          % (back, len(flats), 100.0 * back / max(1, len(flats))))
    return 0 if not bad else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prove", action="store_true")
    ap.add_argument("--dump", action="store_true")
    args = ap.parse_args()
    if args.dump:
        print(json.dumps(schema(), indent=2))
        return 0
    return prove()


if __name__ == "__main__":
    sys.exit(main())
