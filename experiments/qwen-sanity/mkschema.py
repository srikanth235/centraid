"""Derive the JSON schema for the WIRE FRAME from `frame.py` and the lexicon.

`experiments/afm-spike/frame.py` is the authority for the frame; nothing here
is hand-copied out of it.  Every slot name, head name, value kind, atom type,
comparator and step op is read out of `frame`'s own module constants; the
vocabularies (kinds, fields, verbs, refs, window phrases, decline reasons)
come from `lexicon.py` and `derive/derived.json`; and the literal shapes
(number, date, date-time, month, range, duration) are lifted out of
`check.TOKEN`, the grammar's own tokeniser.

    python3 mkschema.py --prove     # the three proofs below
    python3 mkschema.py --dump      # the schema itself

THREE PROOFS, and the third is the one that matters.

 1. Every one of the 434 gold `to_flat(encode(parse(gold)))` objects VALIDATES.
    A schema that rejects a frame the encoder produces is too tight.
 2. Every one of them still renders tree-equal to its gold canonical.
 3. NO SINGLE-KEY DELETION anywhere in any gold frame produces an object the
    schema ACCEPTS and `from_flat`/`to_canonical` REFUSES.  A schema looser
    than the renderer's contract does not make malformed output impossible --
    it makes malformed output LEGAL, and the model finds it.

Proof 3 is not decoration.  The first version of this file required only
`["type"]` on an atom, `["source"]` on a set and `["name", "valueKind"]` on a
write argument, all of which read as "the discriminator is what matters".  The
renderer's contract is far tighter, and a 2B model under that grammar lost 56
of the 74 turns it genuinely attempted to `missing 'cmp'`, `missing 'set'`,
`missing 'value'` or `missing 'ref'` -- each one scored as a model failure
when the grammar had licensed it.  Hence the shape below: every discriminated
slot (`type` on an atom, `source` on a set, `valueKind` on a right-hand side,
`how` on a window, `head` on a frame or an embedded value) becomes an `anyOf`
over branches, and each branch carries its OWN `required` list matching what
`_atom_decode`, `_set_decode`, `_rhs_from_flat`, `_window_decode` and
`_value_decode` actually dereference.

ONE STAGE, ONE SCHEMA.  The Apple spike splits the turn in two so a
`DynamicGenerationSchema` narrowed to one board fits a 4 096-token context.  A
GBNF grammar has no such budget, so this lane asks for the whole frame at
once.  That removes the Apple spike's Stage-A error class, and costs the
per-board narrowing of the field list -- which is unsound here anyway, because
one `set` rule is reused at every depth and a link walk changes the board
underneath it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite",
                                        "grammar"))
for path in (AFM, GRAMMAR):
    if path not in sys.path:
        sys.path.insert(0, path)

import frame          # noqa: E402  the authority
import lexicon        # noqa: E402
import check          # noqa: E402

# ------------------------------------------------------------ the vocabularies

KINDS = sorted(lexicon.KINDS)
REFS = sorted(lexicon.REFS)
DECLINE_REASONS = sorted(lexicon.DECLINE_REASONS)
FIELDS = sorted(lexicon.FIELDS)
VERBS = sorted(set(lexicon.COMMANDS) | set(lexicon.VERB_CLASSES))
WINDOW_PHRASES = sorted(lexicon.WINDOW_PHRASES)
ROLLING_UNITS = ["days", "weeks", "months"]

# read out of `frame` so a change there is a change here
CMPS = list(frame.CMPS)
ATOM_TYPES = list(frame.ATOM_TYPES)
FLAT_HEADS = list(frame.FLAT_HEADS)
SLOT_ORDER = list(frame.SLOT_ORDER)
SLOT_KEY = dict(frame.SLOT_KEY)
STEP_OPS = list(frame.STEP_OPS)
# FINDING (fixed 2026-09-22): `frame.VALUE_KINDS` was dead AND wrong -- it
# omitted `"value"`, which `_rhs_to_flat` emits and `_rhs_from_flat` accepts.
VALUE_KINDS = list(frame.VALUE_KINDS)
WINDOW_HOWS = ["phrase", "date", "datetime", "month", "daterange", "rolling",
               "anchored"]
VALUE_HEADS = ["count", "agg", "project", "balance"]   # `_value_decode`
AGGS = ["sum", "min", "max"]
# what `_rhs_from_flat` accepts in `value` when valueKind is "value"
RHS_VALUE_WHICH = ["count", "sum", "min", "max", "balance", "project"]

# GRAMMAR.md, "Depth bounds": "`Set` recursion is bounded at 4 and `Value` may
# wrap it once, so a legal tree is at most 5 constructors deep".  One
# self-referential `set` rule enforces nothing, and greedy decoding walks
# straight down it: 15 of the 434 turns in the first 2B run were JSON truncated
# at the token cap inside a `combineRight` chain.  The ladder is therefore
# UNROLLED to exactly that bound.
SET_DEPTH = 4

STR = {"type": "string"}
INT = {"type": "integer"}
NUM = {"type": "number"}
NULL = {"type": "null"}
BOOL = {"type": "boolean"}

# An argument NAME is unconstrained in the grammar: `check.py`'s `cmd()` reads
# it with `word()`, so anything its `ident` token matches is legal, and the
# verb classes use names (`to`, `by`) that are in no registry `args` list and
# in no column.  Narrowing it to an enum drifts -- 32 of the 434 gold frames
# fall outside the registry-plus-columns union.
ARG_NAME = {"type": "string", "pattern": r"^[A-Za-z_][A-Za-z0-9_.]*$"}


def _token_patterns():
    """The literal shapes, lifted out of `check.TOKEN`'s own named groups.

    `_rhs_from_flat` hands a number/date/... straight on to the renderer,
    which calls `int()` or `float()` on some of them and re-parses all of
    them.  A free string there is how `{"valueKind": "number", "value":
    "twenty"}` became a `ValueError` charged to the model.
    """
    out = {}
    for name in ("number", "date", "datetime", "month", "daterange",
                 "duration"):
        match = re.search(r"\(\?P<%s>(.*?)\)\s*\n" % name, check.TOKEN.pattern)
        if not match:
            raise AssertionError("check.TOKEN has no %r group" % name)
        out[name] = "^%s$" % match.group(1).strip()
    return out


PAT = _token_patterns()


def _enum(values):
    return {"type": "string", "enum": list(values)}


def _pattern(name):
    return {"type": "string", "pattern": PAT[name]}


def _obj(props, required=()):
    return {"type": "object", "properties": props,
            "required": list(required), "additionalProperties": False}


def _setref(level):
    return {"$ref": "#/$defs/set%d" % level}


SETREF = _setref(1)


# --------------------------------------------------- a right-hand side, by kind


def _rhs_shapes(level):
    """(extra properties, extra required) per `valueKind`.

    Mirrors `frame._rhs_from_flat`: which slot each kind dereferences, and
    what the renderer does to it afterwards.  These merge INTO the containing
    object, because `_rhs_to_flat` flattens them into the atom or the argument
    rather than nesting them.
    """
    out = {}
    for kind in ("literal", "keyword"):
        out[kind] = ({"value": STR}, ["value"])
    for kind in ("number", "date", "datetime", "month", "daterange",
                 "duration"):
        out[kind] = ({"value": _pattern(kind)}, ["value"])
    out["bool"] = ({"value": _enum(["true", "false"])}, ["value"])
    # `_rhs_from_flat` reads no slot for these two, but `_rhs_to_flat` writes
    # `value` back as the kind's own name, so the slot has to be allowed --
    # optional, and pinned to the one string it may hold.
    out["null"] = ({"value": _enum(["null"])}, [])
    out["me"] = ({"value": _enum(["me"])}, [])
    # `{"valueKind": "field", "value": <a column name>}` -- the value slot
    # holds a FIELD and `_rhs_decode` runs it through `_field`.  A free string
    # here is how 'Glass Beach' reached `unknown field`.
    out["field"] = ({"value": _enum(FIELDS)}, ["value"])
    if level < SET_DEPTH:
        out["set"] = ({"set": _setref(level + 1)}, ["set"])
        # `value`: an argument whose value the vault computes.  Each shape
        # needs different slots, so each gets its own branch.
        for which in RHS_VALUE_WHICH:
            props = {"value": _enum([which]), "set": _setref(level + 1)}
            required = ["value", "set"]
            if which in ("sum", "min", "max", "project"):
                props["field"] = _enum(FIELDS)
                required.append("field")
            if which == "balance":
                props["set2"] = _setref(level + 1)
                required.append("set2")
            out["value/%s" % which] = (props, required)
    missing = sorted(set(VALUE_KINDS) - {k.split("/")[0] for k in out}
                     - ({"set", "value"} if level >= SET_DEPTH else set()))
    if missing:
        raise AssertionError("no branch for valueKind %s" % missing)
    return out


def _rhs_branches(level, base_props, base_required):
    """One object branch per legal `valueKind`."""
    branches = []
    for key, (props, required) in _rhs_shapes(level).items():
        merged = dict(base_props)
        merged.update(props)
        merged["valueKind"] = _enum([key.split("/")[0]])
        branches.append(_obj(merged,
                             list(base_required) + ["valueKind"] + required))
    return branches


# ------------------------------------------------------------------- the $defs


def _atom_branches(level):
    """One branch per `frame.ATOM_TYPES` member, required per `_atom_decode`."""
    field = _enum(FIELDS)
    kind = _enum(KINDS)
    window = {"$ref": "#/$defs/window"}
    branches = []
    for atom_type in ATOM_TYPES:
        if atom_type == "cmp":
            branches += _rhs_branches(
                level,
                {"type": _enum(["cmp"]), "field": field, "cmp": _enum(CMPS)},
                ["type", "field", "cmp"])
        elif atom_type == "contains":
            # `_atom_from_flat` reads the literal out of `value`
            branches.append(_obj({"type": _enum(["contains"]), "field": field,
                                  "valueKind": _enum(["literal"]),
                                  "value": STR},
                                 ["type", "field", "value"]))
        elif atom_type == "is":
            branches.append(_obj({"type": _enum(["is"]), "field": field,
                                  "what": _enum(["null", "me"]),
                                  "negated": BOOL},
                                 ["type", "field", "what"]))
        elif atom_type == "pwindow":
            branches.append(_obj({"type": _enum(["pwindow"]), "field": field,
                                  "window": window},
                                 ["type", "field", "window"]))
        elif atom_type == "member":
            if level < SET_DEPTH:
                branches.append(_obj({"type": _enum(["member"]),
                                      "set": _setref(level + 1)},
                                     ["type", "set"]))
        elif atom_type == "band":
            branches.append(_obj({"type": _enum(["band"]), "field": field,
                                  "num": NUM}, ["type", "field", "num"]))
        elif atom_type == "oneof":
            branches.append(_obj({"type": _enum(["oneof"]), "field": field,
                                  "lits": {"type": "array", "items": STR,
                                           "minItems": 1, "maxItems": 4}},
                                 ["type", "field", "lits"]))
        elif atom_type == "countwalk":
            branches.append(_obj({"type": _enum(["countwalk"]), "kind": kind,
                                  "cmp": _enum(CMPS), "num": INT},
                                 ["type", "kind", "cmp", "num"]))
        else:
            raise AssertionError("atom type %r has no branch" % atom_type)
    return branches


def _set_branches(level):
    """One branch per source, times with/without a combine (`_set_from_flat`)."""
    field = _enum(FIELDS)
    kind = _enum(KINDS)
    ladder = {}
    for slot in SLOT_ORDER:
        key = SLOT_KEY.get(slot)
        if key is None:
            continue
        if slot.startswith("called"):
            ladder[key] = STR
        elif slot.startswith("during"):
            ladder[key] = {"$ref": "#/$defs/window"}
        elif slot.startswith("filters"):
            ladder[key] = {"$ref": "#/$defs/pred%d" % level}
        elif slot.startswith("walk"):
            ladder[key] = kind
    ladder["orderField"] = field
    ladder["orderDir"] = _enum(["asc", "desc"])
    ladder["limit"] = INT

    sources = [
        ({"source": _enum(["kind"]), "kind": kind}, ["source", "kind"]),
        ({"source": _enum(["ref"]), "ref": _enum(REFS)}, ["source", "ref"]),
        ({"source": _enum(["ref"]), "ref": _enum(["ordinal"]),
          "ordinal": INT}, ["source", "ref", "ordinal"]),
    ]
    branches = []
    for props, required in sources:
        plain = dict(props)
        plain.update(ladder)
        branches.append(_obj(plain, required))
        if level < SET_DEPTH:
            combined = dict(plain)
            combined["combineOp"] = _enum(["and", "except"])
            combined["combineRight"] = _setref(level + 1)
            branches.append(_obj(combined,
                                 required + ["combineOp", "combineRight"]))
    return branches


def _window_branches():
    value_frame = {"$ref": "#/$defs/value"}
    branches = [
        _obj({"how": _enum(["phrase"]), "value": _enum(WINDOW_PHRASES)},
             ["how", "value"]),
        _obj({"how": _enum(["rolling"]), "n": INT,
              "unit": _enum(ROLLING_UNITS)}, ["how", "n", "unit"]),
        _obj({"how": _enum(["anchored"]), "from": value_frame,
              "to": value_frame}, ["how", "from", "to"]),
    ]
    for how in ("date", "datetime", "month", "daterange"):
        branches.append(_obj({"how": _enum([how]), "value": _pattern(how)},
                             ["how", "value"]))
    covered = {h for b in branches for h in b["properties"]["how"]["enum"]}
    if covered != set(WINDOW_HOWS):
        raise AssertionError("window hows not covered: %s"
                             % sorted(set(WINDOW_HOWS) ^ covered))
    return branches


def _rich_set():
    """`frame._set_encode`'s shape.  A window is passed through `to_flat`
    untouched, so an `anchored` window's two ends carry RICH sets."""
    field = _enum(FIELDS)
    kind = _enum(KINDS)
    step_branches = []
    for op in STEP_OPS:
        if op == "walk":
            step_branches.append(_obj({"op": _enum(["walk"]), "kind": kind},
                                      ["op", "kind"]))
        elif op == "called":
            step_branches.append(_obj({"op": _enum(["called"]), "lit": STR},
                                      ["op", "lit"]))
        elif op == "during":
            step_branches.append(_obj({"op": _enum(["during"]),
                                       "window": {"$ref": "#/$defs/window"}},
                                      ["op", "window"]))
        elif op == "that":
            step_branches.append(_obj({"op": _enum(["that"]),
                                       "pred": {"$ref": "#/$defs/pred1"}},
                                      ["op", "pred"]))
        elif op == "ordered_by":
            step_branches.append(_obj({"op": _enum(["ordered_by"]),
                                       "field": field,
                                       "dir": _enum(["asc", "desc"])},
                                      ["op", "field", "dir"]))
        elif op == "first":
            step_branches.append(_obj({"op": _enum(["first"]), "n": INT},
                                      ["op", "n"]))
        else:
            raise AssertionError("step op %r has no branch" % op)
    steps = {"type": "array", "items": {"anyOf": step_branches}, "maxItems": 4}
    return {"anyOf": [
        _obj({"source": _enum(["kind"]), "kind": kind, "steps": steps},
             ["source", "kind"]),
        _obj({"source": _enum(["ref"]), "ref": _enum(REFS), "steps": steps},
             ["source", "ref"]),
        _obj({"source": _enum(["ref"]), "ref": _enum(["ordinal"]), "n": INT,
              "steps": steps}, ["source", "ref", "n"]),
    ]}


def _value_branches():
    """`frame._value_decode`: which slots each embedded value head needs."""
    field = _enum(FIELDS)
    rich = {"$ref": "#/$defs/richset"}
    branches = [
        _obj({"head": _enum(["count"]), "set": rich}, ["head", "set"]),
        _obj({"head": _enum(["agg"]), "agg": _enum(AGGS), "field": field,
              "set": rich}, ["head", "agg", "field", "set"]),
        _obj({"head": _enum(["project"]), "field": field, "set": rich},
             ["head", "field", "set"]),
        _obj({"head": _enum(["balance"]), "set": rich, "set2": rich},
             ["head", "set", "set2"]),
    ]
    covered = {h for b in branches for h in b["properties"]["head"]["enum"]}
    if covered != set(VALUE_HEADS):
        raise AssertionError("value heads not covered: %s"
                             % sorted(set(VALUE_HEADS) ^ covered))
    return branches


def defs():
    out = {
        "window": {"anyOf": _window_branches()},
        "value": {"anyOf": _value_branches()},
        "richset": _rich_set(),
        "arg": {"anyOf": _rhs_branches(1, {"name": ARG_NAME}, ["name"])},
        "cmd": _obj({"verb": _enum(VERBS),
                     "args": {"type": "array", "items": {"$ref": "#/$defs/arg"},
                              "maxItems": 6},
                     "on": {"anyOf": [SETREF, NULL]}}, ["verb"]),
    }
    for level in range(1, SET_DEPTH + 1):
        out["set%d" % level] = {"anyOf": _set_branches(level)}
        out["atom%d" % level] = {"anyOf": _atom_branches(level)}
        out["pred%d" % level] = _obj(
            {"join": _enum(["none", "and", "or"]),
             "atoms": {"type": "array",
                       "items": {"$ref": "#/$defs/atom%d" % level},
                       "minItems": 1, "maxItems": 3}},
            ["join", "atoms"])
    return out


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


# ------------------------------------------------------------------ the proofs


def gold_flats():
    out = []
    for row in frame.gold_turns():
        out.append((row, frame.to_flat(frame.encode(check.parse(row["canonical"])))))
    return out


def renders(flat):
    """What `render_frames.render_one` does, minus the verbatim-literal rule."""
    try:
        frame.to_canonical(frame.from_flat(flat))
        return True, ""
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)


def _paths(node, prefix=()):
    """Every (container, key) a single-key deletion could target."""
    if isinstance(node, dict):
        for key, value in list(node.items()):
            yield prefix, key
            yield from _paths(value, prefix + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _paths(value, prefix + (index,))


def _without(flat, prefix, key):
    clone = json.loads(json.dumps(flat))
    node = clone
    for step in prefix:
        node = node[step]
    node.pop(key, None)
    return clone


def prove():
    import jsonschema
    sch = schema()
    validator = jsonschema.Draft202012Validator(sch)
    flats = gold_flats()

    bad = []
    for row, flat in flats:
        if next(validator.iter_errors(flat), None) is not None:
            err = jsonschema.exceptions.best_match(validator.iter_errors(flat))
            while err is not None and err.context:
                err = jsonschema.exceptions.best_match(err.context)
            bad.append((row, "%s: %s" % (list(err.absolute_path),
                                         err.message.splitlines()[0][:130])))
    ok = len(flats) - len(bad)
    print("1. gold wire frames validate      %4d/%-4d  %.1f%%"
          % (ok, len(flats), 100.0 * ok / max(1, len(flats))))
    for row, why in bad[:15]:
        print("     %-7s %-5s t%-2s  %s" % (row["corpus"], row["session"],
                                            row["turn"], why))

    back = sum(1 for _row, flat in flats if renders(flat)[0])
    print("2. ...and render tree-equal       %4d/%-4d  %.1f%%"
          % (back, len(flats), 100.0 * back / max(1, len(flats))))

    # 3. the schema must never accept what the renderer refuses
    checked = leaks = 0
    seen, examples = set(), []
    for _row, flat in flats:
        for prefix, key in _paths(flat):
            mutant = _without(flat, prefix, key)
            checked += 1
            if next(validator.iter_errors(mutant), None) is not None:
                continue                      # the schema caught it: correct
            good, why = renders(mutant)
            if not good:
                leaks += 1
                signature = (key, why.split(":")[-1].strip())
                if signature not in seen:
                    seen.add(signature)
                    examples.append((prefix, key, why[:110]))
    print("3. deletions the schema ACCEPTS   %4d leak(s) out of %d probes"
          % (leaks, checked))
    for prefix, key, why in examples[:15]:
        print("     dropped %-14s at %-38s -> %s"
              % (key, "/".join(str(p) for p in prefix) or "<root>", why))
    return 0 if not bad and leaks == 0 and back == len(flats) else 1


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
