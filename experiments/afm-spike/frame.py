"""The FRAME: a flat, enumerable description of one canonical turn.

The model never writes canonical text.  It fills this frame under guided
generation and CODE renders the frame to the existing canonical grammar
(`crates/evalsuite/grammar/GRAMMAR.md`), via `check.py`'s own tree and the
encoder lane's unparser `experiments/canon-model/encoder/render.py`.

Two directions, and the proof is that they compose:

    encode(tree)  -> frame        (gold canonical -> frame; offline only)
    decode(frame) -> tree         (what the harness runs at inference)

`python3 frame.py` proves `parse(gold) -> encode -> decode` is TREE-EQUAL to
`parse(gold)` over every gold canonical in `grammar/map.json`.  That number is
the ceiling of the whole spike.  The encoder lane's flat template classifier
capped the corpus at 65.7% because its inventory was a CLOSED SET OF WHOLE
SHAPES; this frame is compositional — a source, a list of postfix steps, a
two-atom predicate — so a shape nobody saw is still expressible.

Shape (mirrored field-for-field by `Sources/afm-spike/Frame.swift`):

    Frame   { head, agg, field, set, set2, cmds[], reason }
    Set     { source: kind|ref|union|except, kind, ref, n, left, right,
              steps[] }
    Step    { op: walk|called|that|during|ordered_by|first,
              kind, lit, pred, window, field, dir, n }
    Pred    { op: and|or|none, atoms[] }           -- at most 2 atoms
    Atom    { type, field, cmp, rhs, lits[], window, set, num, what, negated }
    Rhs     { kind: string|number|date|datetime|month|keyword|duration|
                    bool|null|me|field|set|value, ... }
    Window  { how: phrase|date|datetime|month|daterange|rolling|anchored, ... }
    Cmd     { verb, args[{name, rhs}], on }

Nothing here repairs anything.  `decode` raises on a frame it cannot render;
the caller writes an empty canonical and counts it.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite", "grammar"))
ENCODER = os.path.normpath(os.path.join(HERE, "..", "canon-model", "encoder"))
for path in (GRAMMAR, ENCODER):
    if path not in sys.path:
        sys.path.insert(0, path)

import check  # noqa: E402
import lexicon  # noqa: E402
import render as unparse  # noqa: E402

MAP = os.path.join(GRAMMAR, "map.json")

STEP_OPS = ("walk", "called", "that", "during", "ordered_by", "first")
ATOM_TYPES = ("cmp", "contains", "is", "pwindow", "member", "band", "oneof",
              "countwalk")
HEADS = ("show", "count", "agg", "project", "balance", "cmd", "seq", "same",
         "nothing", "refuse", "clarify")
LIT_TYPES = ("string", "number", "date", "datetime", "month", "daterange",
             "keyword", "duration")


class Unframeable(Exception):
    """The tree holds a shape the frame cannot carry (encode side)."""


class Unrenderable(Exception):
    """The frame holds something that is not a legal canonical (decode side)."""


# ---------------------------------------------------------------- encode side


def _rhs_encode(node):
    n = node["node"]
    if n == "lit":
        if node["type"] not in LIT_TYPES:
            raise Unframeable("lit type %r" % node["type"])
        if node["type"] == "keyword" and node["value"] in ("null", "true", "false", "me"):
            return {"kind": node["value"]}
        return {"kind": node["type"], "value": str(node["value"])}
    if n == "fieldref":
        return {"kind": "field", "field": node["field"]}
    if n == "setarg":
        return {"kind": "set", "set": _set_encode(node["set"])}
    if n in ("agg", "project", "balance"):
        return {"kind": "value", "value": _value_encode(node)}
    raise Unframeable("rhs %r" % n)


def _value_encode(node):
    n = node["node"]
    if n == "agg":
        return {"head": "count" if node["agg"] == "count" else "agg",
                "agg": node["agg"], "field": node.get("field"),
                "set": _set_encode(node["set"])}
    if n == "project":
        return {"head": "project", "field": node["field"],
                "set": _set_encode(node["set"])}
    if n == "balance":
        return {"head": "balance", "set": _set_encode(node["of"]),
                "set2": _set_encode(node["in"])}
    raise Unframeable("value %r" % n)


def _window_encode(w):
    how = w["how"]
    if how in ("phrase", "date", "datetime", "month", "daterange"):
        return {"how": how, "value": w["value"]}
    if how == "rolling":
        return {"how": how, "n": w["n"], "unit": w["unit"]}
    if how == "anchored":
        return {"how": how, "from": _value_encode(w["from"]),
                "to": _value_encode(w["to"])}
    raise Unframeable("window %r" % how)


def _atom_encode(p):
    n = p["node"]
    if n == "cmp":
        return {"type": "cmp", "field": p["field"], "cmp": p["op"],
                "rhs": _rhs_encode(p["rhs"])}
    if n == "contains":
        return {"type": "contains", "field": p["field"], "lit": p["lit"]}
    if n == "is":
        return {"type": "is", "field": p["field"], "what": p["what"],
                "negated": bool(p["not"])}
    if n == "pwindow":
        return {"type": "pwindow", "field": p["field"],
                "window": _window_encode(p["window"])}
    if n == "member":
        return {"type": "member", "set": _set_encode(p["set"])}
    if n == "band":
        return {"type": "band", "field": p["field"], "num": p["centre"]}
    if n == "oneof":
        return {"type": "oneof", "field": p["field"], "lits": list(p["lits"])}
    if n == "countwalk":
        return {"type": "countwalk", "kind": p["kind"], "cmp": p["op"],
                "num": p["n"]}
    raise Unframeable("pred atom %r" % n)


def _pred_encode(p):
    """A predicate is a FLAT list of at most three atoms under one connective.

    Every predicate in the corpus is one or two atoms; three is one step of
    headroom.  `not` never appears in the corpus and is carried only by `is`,
    which has its own `negated` flag.
    """
    if p["node"] in ("and", "or"):
        left, right = p["left"], p["right"]
        atoms = []
        for side in (left, right):
            if side["node"] == p["node"]:
                sub = _pred_encode(side)
                atoms.extend(sub["atoms"])
            else:
                atoms.append(_atom_encode(side))
        if len(atoms) > 3:
            raise Unframeable("predicate with %d atoms" % len(atoms))
        return {"op": p["node"], "atoms": atoms}
    if p["node"] == "not":
        raise Unframeable("bare not")
    return {"op": "none", "atoms": [_atom_encode(p)]}


def _set_encode(s):
    """Linearise a Set into a source plus an ORDERED list of postfix steps."""
    steps = []
    node = s
    while True:
        n = node["node"]
        if n == "called":
            steps.append({"op": "called", "lit": node["lit"]})
            node = node["set"]
        elif n == "filter":
            steps.append({"op": "that", "pred": _pred_encode(node["pred"])})
            node = node["set"]
        elif n == "during":
            steps.append({"op": "during", "window": _window_encode(node["window"])})
            node = node["set"]
        elif n == "order":
            steps.append({"op": "ordered_by", "field": node["field"],
                          "dir": node["dir"]})
            node = node["set"]
        elif n == "first":
            steps.append({"op": "first", "n": node["n"]})
            node = node["set"]
        elif n == "walk":
            steps.append({"op": "walk", "kind": node["kind"]["kind"]})
            node = node["from"]
        else:
            break
    steps.reverse()
    if node["node"] == "kind":
        base = {"source": "kind", "kind": node["kind"]}
    elif node["node"] == "ref":
        base = {"source": "ref", "ref": node["ref"]}
        if node["ref"] == "ordinal":
            base["n"] = node["n"]
    elif node["node"] in ("union", "except"):
        base = {"source": node["node"],
                "left": _set_encode(node["left"]),
                "right": _set_encode(node["right"])}
    else:
        raise Unframeable("set source %r" % node["node"])
    base["steps"] = steps
    return base


def _cmd_encode(c):
    args = []
    for name, val in c["args"].items():
        args.append({"name": name, "rhs": _rhs_encode(val)})
    return {"verb": c["verb"], "args": args,
            "on": _set_encode(c["on"]) if c["on"] is not None else None}


def encode(tree):
    """A check.py tree -> a frame.  Raises `Unframeable` on a shape it lacks."""
    n = tree["node"]
    if n == "nothing":
        return {"head": "nothing"}
    if n in ("refuse", "clarify"):
        return {"head": n, "reason": tree["reason"]}
    if n == "show":
        return {"head": "show", "set": _set_encode(tree["set"])}
    if n == "same":
        return {"head": "same", "set": _set_encode(tree["left"]),
                "set2": _set_encode(tree["right"])}
    if n in ("agg", "project", "balance"):
        return _value_encode(tree)
    if n == "cmd":
        return {"head": "cmd", "cmds": [_cmd_encode(tree)]}
    if n == "seq":
        return {"head": "seq", "cmds": [_cmd_encode(s) for s in tree["steps"]]}
    raise Unframeable("turn %r" % n)


# ---------------------------------------------------------------- decode side


def _need(frame, key):
    value = frame.get(key)
    if value in (None, ""):
        raise Unrenderable("missing %r" % key)
    return value


def _kind_node(name):
    if name not in lexicon.KINDS:
        raise Unrenderable("unknown kind %r" % name)
    entity, door = lexicon.KINDS[name]
    return {"node": "kind", "kind": name, "entity": entity, "door": door}


def _field(name):
    if name not in lexicon.FIELDS:
        raise Unrenderable("unknown field %r" % name)
    return name


def _rhs_decode(r):
    kind = _need(r, "kind")
    if kind in ("null", "true", "false", "me"):
        return {"node": "lit", "type": "keyword", "value": kind}
    if kind == "field":
        return {"node": "fieldref", "field": _field(_need(r, "field"))}
    if kind == "set":
        return {"node": "setarg", "set": _set_decode(_need(r, "set"))}
    if kind == "value":
        return _value_decode(_need(r, "value"))
    if kind in LIT_TYPES:
        value = r.get("value")
        if value is None:
            raise Unrenderable("literal with no value")
        if kind == "number":
            value = float(value) if "." in str(value) else int(value)
        return {"node": "lit", "type": kind, "value": value}
    raise Unrenderable("rhs kind %r" % kind)


def _value_decode(v):
    head = _need(v, "head")
    if head == "count":
        return {"node": "agg", "agg": "count", "field": None,
                "set": _set_decode(_need(v, "set"))}
    if head == "agg":
        agg = _need(v, "agg")
        if agg not in ("sum", "min", "max"):
            raise Unrenderable("agg %r" % agg)
        return {"node": "agg", "agg": agg, "field": _field(_need(v, "field")),
                "set": _set_decode(_need(v, "set"))}
    if head == "project":
        return {"node": "project", "field": _field(_need(v, "field")),
                "set": _set_decode(_need(v, "set"))}
    if head == "balance":
        return {"node": "balance", "of": _set_decode(_need(v, "set")),
                "in": _set_decode(_need(v, "set2"))}
    raise Unrenderable("value head %r" % head)


def _window_decode(w):
    how = _need(w, "how")
    if how == "phrase":
        value = _need(w, "value")
        if value not in lexicon.WINDOW_PHRASES:
            raise Unrenderable("window phrase %r" % value)
        return {"node": "window", "how": "phrase", "value": value}
    if how in ("date", "datetime", "month", "daterange"):
        return {"node": "window", "how": how, "value": _need(w, "value")}
    if how == "rolling":
        unit = _need(w, "unit")
        if unit not in ("days", "weeks", "months"):
            raise Unrenderable("rolling unit %r" % unit)
        return {"node": "window", "how": "rolling", "n": int(_need(w, "n")),
                "unit": unit}
    if how == "anchored":
        return {"node": "window", "how": "anchored",
                "from": _value_decode(_need(w, "from")),
                "to": _value_decode(_need(w, "to"))}
    raise Unrenderable("window how %r" % how)


CMPS = ("=", "!=", "<", "<=", ">", ">=")


def _atom_decode(a):
    ty = _need(a, "type")
    if ty == "cmp":
        op = _need(a, "cmp")
        if op not in CMPS:
            raise Unrenderable("cmp %r" % op)
        return {"node": "cmp", "field": _field(_need(a, "field")), "op": op,
                "rhs": _rhs_decode(_need(a, "rhs"))}
    if ty == "contains":
        return {"node": "contains", "field": _field(_need(a, "field")),
                "lit": _need(a, "lit")}
    if ty == "is":
        what = _need(a, "what")
        if what not in ("null", "me"):
            raise Unrenderable("is %r" % what)
        return {"node": "is", "field": _field(_need(a, "field")),
                "what": what, "not": bool(a.get("negated"))}
    if ty == "pwindow":
        return {"node": "pwindow", "field": _field(_need(a, "field")),
                "window": _window_decode(_need(a, "window"))}
    if ty == "member":
        return {"node": "member", "set": _set_decode(_need(a, "set"))}
    if ty == "band":
        return {"node": "band", "field": _field(_need(a, "field")),
                "centre": float(_need(a, "num"))}
    if ty == "oneof":
        lits = _need(a, "lits")
        if not isinstance(lits, list) or not lits:
            raise Unrenderable("oneof with no literals")
        return {"node": "oneof", "field": _field(_need(a, "field")),
                "lits": [str(x) for x in lits]}
    if ty == "countwalk":
        op = _need(a, "cmp")
        if op not in CMPS:
            raise Unrenderable("cmp %r" % op)
        kind = _need(a, "kind")
        if kind not in lexicon.KINDS:
            raise Unrenderable("unknown kind %r" % kind)
        return {"node": "countwalk", "kind": kind, "op": op,
                "n": int(_need(a, "num"))}
    raise Unrenderable("atom type %r" % ty)


def _pred_decode(p):
    atoms = _need(p, "atoms")
    if not isinstance(atoms, list) or not atoms:
        raise Unrenderable("predicate with no atoms")
    nodes = [_atom_decode(a) for a in atoms]
    if len(nodes) == 1:
        return nodes[0]
    op = p.get("op") or "and"
    if op not in ("and", "or"):
        raise Unrenderable("connective %r" % op)
    # left-associative, matching check.py's own pred loop
    out = nodes[0]
    for right in nodes[1:]:
        out = {"node": op, "left": out, "right": right}
    return out


def _set_decode(s):
    source = _need(s, "source")
    if source == "kind":
        node = _kind_node(_need(s, "kind"))
    elif source == "ref":
        ref = _need(s, "ref")
        if ref == "ordinal":
            node = {"node": "ref", "ref": "ordinal", "n": int(_need(s, "n"))}
        elif ref in lexicon.REFS:
            node = {"node": "ref", "ref": ref}
        else:
            raise Unrenderable("ref %r" % ref)
    elif source in ("union", "except"):
        node = {"node": source, "left": _set_decode(_need(s, "left")),
                "right": _set_decode(_need(s, "right"))}
    else:
        raise Unrenderable("set source %r" % source)
    for step in s.get("steps") or []:
        op = _need(step, "op")
        if op == "walk":
            node = {"node": "walk", "kind": _kind_node(_need(step, "kind")),
                    "from": node}
        elif op == "called":
            node = {"node": "called", "set": node, "lit": _need(step, "lit")}
        elif op == "that":
            node = {"node": "filter", "set": node,
                    "pred": _pred_decode(_need(step, "pred"))}
        elif op == "during":
            node = {"node": "during", "set": node,
                    "window": _window_decode(_need(step, "window"))}
        elif op == "ordered_by":
            direction = _need(step, "dir")
            if direction not in ("asc", "desc"):
                raise Unrenderable("dir %r" % direction)
            node = {"node": "order", "set": node,
                    "field": _field(_need(step, "field")), "dir": direction}
        elif op == "first":
            node = {"node": "first", "n": int(_need(step, "n")), "set": node}
        else:
            raise Unrenderable("step op %r" % op)
    return node


def _cmd_decode(c):
    verb = _need(c, "verb")
    if verb not in lexicon.COMMANDS and verb not in lexicon.VERB_CLASSES:
        raise Unrenderable("unknown verb %r" % verb)
    args = {}
    for arg in c.get("args") or []:
        name = _need(arg, "name")
        args[name] = _rhs_decode(_need(arg, "rhs"))
    on = c.get("on")
    return {"node": "cmd", "verb": verb, "args": args,
            "on": _set_decode(on) if on else None}


def decode(frame):
    """A frame -> a check.py tree.  Raises `Unrenderable`; never repairs."""
    if not isinstance(frame, dict):
        raise Unrenderable("frame is not an object")
    head = _need(frame, "head")
    if head == "nothing":
        return {"node": "nothing"}
    if head in ("refuse", "clarify"):
        reason = _need(frame, "reason")
        if reason not in lexicon.DECLINE_REASONS:
            raise Unrenderable("decline reason %r" % reason)
        return {"node": head, "reason": reason}
    if head == "show":
        return {"node": "show", "set": _set_decode(_need(frame, "set"))}
    if head == "same":
        return {"node": "same", "left": _set_decode(_need(frame, "set")),
                "right": _set_decode(_need(frame, "set2"))}
    if head in ("count", "agg", "project", "balance"):
        return _value_decode(frame)
    if head in ("cmd", "seq"):
        cmds = _need(frame, "cmds")
        if not isinstance(cmds, list) or not cmds:
            raise Unrenderable("no commands")
        if len(cmds) == 1:
            return _cmd_decode(cmds[0])
        return {"node": "seq", "steps": [_cmd_decode(c) for c in cmds]}
    raise Unrenderable("head %r" % head)


# ------------------------------------------------------- the FLAT (wire) frame
#
# The frame above is what CODE composes.  What the MODEL fills is flatter
# still: one object with named slots, because a `DynamicGenerationSchema` the
# model can hold in a 4 096-token context cannot be a recursive tree.
#
# The slot order below is the postfix order the corpus actually uses, read off
# every gold Set shape:  called, during, filtersA, walk1, filtersB, walk2,
# orderBy, first — then, outermost, one union/except against a second set.
# `prove_flat` shows that this ladder expresses every gold turn, so the
# narrowing costs nothing.
#
# Flat wire shape (mirrored by `Sources/afm-spike/Frame.swift`):
#
#   { move, head, aggField, set, set2, cmds[], refuseReason }
#   set  { source, kind, ref, ordinal, called, window, filtersA, walk1,
#          filtersB, walk2, orderField, orderDir, limit,
#          combineOp, combineRight }
#   pred { join, atoms[] }
#   atom { type, field, cmp, valueKind, value, num, what, negated, window,
#          lits[], set, kind }
#   cmd  { verb, args[{name, valueKind, value, set}], on }

SLOT_ORDER = ("called", "filtersA", "during", "walk1", "called2", "filtersB",
              "during2", "walk2", "filtersC", "ordered_by", "first")
SLOT_FOR_OP = {"called": ("called", "called2"),
               "during": ("during", "during2"),
               "that": ("filtersA", "filtersB", "filtersC"),
               "walk": ("walk1", "walk2"),
               "ordered_by": ("ordered_by",), "first": ("first",)}
# the flat key each slot writes into
SLOT_KEY = {"called": "called", "called2": "called2", "during": "window",
            "during2": "window2", "filtersA": "filtersA",
            "filtersB": "filtersB", "filtersC": "filtersC",
            "walk1": "walk1", "walk2": "walk2"}
FLAT_HEADS = ("show", "count", "sum", "min", "max", "project", "balance",
              "same", "write", "nothing", "refuse")
VALUE_KINDS = ("literal", "number", "date", "datetime", "month", "daterange",
               "duration", "keyword", "bool", "null", "me", "field", "set")
_LIT_FOR_VALUE_KIND = {"literal": "string", "number": "number", "date": "date",
                       "datetime": "datetime", "month": "month",
                       "daterange": "daterange", "duration": "duration",
                       "keyword": "keyword"}


class Unflat(Exception):
    """The flat slots do not describe a set the grammar can build."""


def _rhs_to_flat(rhs):
    kind = rhs["kind"]
    if kind == "string":
        return {"valueKind": "literal", "value": rhs["value"]}
    if kind in _LIT_FOR_VALUE_KIND.values():
        return {"valueKind": kind, "value": rhs["value"]}
    if kind in ("null", "true", "false", "me"):
        return {"valueKind": "bool" if kind in ("true", "false") else kind,
                "value": kind}
    if kind == "field":
        return {"valueKind": "field", "value": rhs["field"]}
    if kind == "set":
        return {"valueKind": "set", "set": _set_to_flat(rhs["set"])}
    if kind == "value":
        # `due_at: dtstart of (it)` — an argument whose value the vault holds
        value = rhs["value"]
        out = {"valueKind": "value", "value": value["head"],
               "set": _set_to_flat(value["set"])}
        if value.get("agg"):
            out["value"] = value["agg"]
        if value.get("field"):
            out["field"] = value["field"]
        if value.get("set2"):
            out["set2"] = _set_to_flat(value["set2"])
        return out
    raise Unframeable("rhs kind %r has no flat spelling" % kind)


def _rhs_from_flat(a):
    vk = a.get("valueKind") or "literal"
    if vk == "literal":
        return {"kind": "string", "value": _need(a, "value")}
    if vk in ("number", "date", "datetime", "month", "daterange", "duration",
              "keyword"):
        return {"kind": vk, "value": _need(a, "value")}
    if vk == "bool":
        value = str(a.get("value", "")).lower()
        if value not in ("true", "false"):
            raise Unrenderable("bool %r" % a.get("value"))
        return {"kind": value}
    if vk in ("null", "me"):
        return {"kind": vk}
    if vk == "field":
        return {"kind": "field", "field": _need(a, "value")}
    if vk == "set":
        return {"kind": "set", "set": _set_from_flat(_need(a, "set"))}
    if vk == "value":
        which = _need(a, "value")
        value = {"set": _set_from_flat(_need(a, "set"))}
        if which == "count":
            value["head"] = "count"
        elif which in ("sum", "min", "max"):
            value["head"] = "agg"
            value["agg"] = which
            value["field"] = _need(a, "field")
        elif which == "balance":
            value["head"] = "balance"
            value["set2"] = _set_from_flat(_need(a, "set2"))
        elif which == "project":
            value["head"] = "project"
            value["field"] = _need(a, "field")
        else:
            raise Unrenderable("value %r" % which)
        return {"kind": "value", "value": value}
    raise Unrenderable("valueKind %r" % vk)


def _atom_to_flat(a):
    out = {"type": a["type"]}
    for key in ("field", "cmp", "what", "negated", "num", "window", "lits",
                "kind", "lit"):
        if key in a:
            out[key] = a[key]
    if "rhs" in a:
        out.update(_rhs_to_flat(a["rhs"]))
    if a["type"] == "member":
        out["set"] = _set_to_flat(a["set"])
    if a["type"] == "contains":
        out["valueKind"] = "literal"
        out["value"] = a["lit"]
        out.pop("lit", None)
    return out


def _atom_from_flat(a):
    ty = _need(a, "type")
    out = {"type": ty}
    for key in ("field", "cmp", "what", "negated", "num", "window", "lits",
                "kind"):
        if a.get(key) not in (None, ""):
            out[key] = a[key]
    if ty == "cmp":
        out["rhs"] = _rhs_from_flat(a)
    elif ty == "contains":
        out["lit"] = _need(a, "value")
    elif ty == "member":
        out["set"] = _set_from_flat(_need(a, "set"))
    return out


def _pred_to_flat(p):
    return {"join": p["op"], "atoms": [_atom_to_flat(a) for a in p["atoms"]]}


def _pred_from_flat(p):
    atoms = _need(p, "atoms")
    return {"op": p.get("join") or "none",
            "atoms": [_atom_from_flat(a) for a in atoms]}


def _simple_set_to_flat(s):
    """One side of a union/except: source plus the same slot ladder."""
    return _set_to_flat(s)


def _set_to_flat(s):
    flat = {}
    if s["source"] in ("union", "except"):
        left = _simple_set_to_flat(s["left"])
        flat.update(left)
        flat["combineOp"] = "and" if s["source"] == "union" else "except"
        flat["combineRight"] = _simple_set_to_flat(s["right"])
    else:
        flat["source"] = s["source"]
        if s["source"] == "kind":
            flat["kind"] = s["kind"]
        else:
            flat["ref"] = s["ref"]
            if "n" in s:
                flat["ordinal"] = s["n"]
    if flat.get("combineOp") and s.get("steps"):
        # a postfix OUTSIDE the union applies after the combine
        tail, cursor = {}, SLOT_ORDER.index("ordered_by")
        for step in s["steps"]:
            slot = _place(step, tail, cursor)
            cursor = SLOT_ORDER.index(slot)
        flat.update(tail)
        return flat
    cursor = 0
    for step in s.get("steps") or []:
        slot = _place(step, flat, cursor)
        cursor = SLOT_ORDER.index(slot)
    return flat


def _place(step, into, cursor):
    for slot in SLOT_FOR_OP[step["op"]]:
        at = SLOT_ORDER.index(slot)
        key = SLOT_KEY.get(slot, slot)
        if at < cursor or key in into:
            continue
        if step["op"] == "called":
            into[key] = step["lit"]
        elif step["op"] == "during":
            into[key] = step["window"]
        elif step["op"] == "that":
            into[key] = _pred_to_flat(step["pred"])
        elif step["op"] == "walk":
            into[key] = step["kind"]
        elif step["op"] == "ordered_by":
            into["orderField"] = step["field"]
            into["orderDir"] = step["dir"]
        elif step["op"] == "first":
            into["limit"] = step["n"]
        return slot
    raise Unframeable("no free slot for %r after %s"
                      % (step["op"], SLOT_ORDER[cursor]))


def _steps_from_flat(f, slots):
    steps = []
    for slot in slots:
        key = SLOT_KEY.get(slot, slot)
        if slot.startswith("called") and f.get(key):
            steps.append({"op": "called", "lit": f[key]})
        elif slot.startswith("during") and f.get(key):
            steps.append({"op": "during", "window": f[key]})
        elif slot.startswith("filters") and f.get(key):
            steps.append({"op": "that", "pred": _pred_from_flat(f[key])})
        elif slot.startswith("walk") and f.get(key):
            steps.append({"op": "walk", "kind": f[key]})
        elif slot == "ordered_by" and f.get("orderField"):
            steps.append({"op": "ordered_by", "field": f["orderField"],
                          "dir": f.get("orderDir") or "asc"})
        elif slot == "first" and f.get("limit"):
            steps.append({"op": "first", "n": int(f["limit"])})
    return steps


def _base_from_flat(f):
    source = f.get("source") or ("kind" if f.get("kind") else "ref")
    if source == "kind":
        base = {"source": "kind", "kind": _need(f, "kind")}
    else:
        base = {"source": "ref", "ref": _need(f, "ref")}
        if f.get("ordinal"):
            base["ref"] = "ordinal"
            base["n"] = int(f["ordinal"])
    return base


def _set_from_flat(f):
    if not isinstance(f, dict):
        raise Unrenderable("set is not an object")
    inner = SLOT_ORDER[:SLOT_ORDER.index("ordered_by")]
    outer = SLOT_ORDER[SLOT_ORDER.index("ordered_by"):]
    left = _base_from_flat(f)
    if f.get("combineOp"):
        left["steps"] = _steps_from_flat(f, inner)
        right = _set_from_flat(_need(f, "combineRight"))
        op = f["combineOp"]
        if op not in ("and", "except"):
            raise Unrenderable("combineOp %r" % op)
        node = {"source": "union" if op == "and" else "except",
                "left": left, "right": right,
                "steps": _steps_from_flat(f, outer)}
        return node
    left["steps"] = _steps_from_flat(f, SLOT_ORDER)
    return left


def to_flat(frame):
    """A frame -> the flat wire object the model fills. Offline only."""
    head = frame["head"]
    flat = {}
    if head == "nothing":
        return {"head": "nothing"}
    if head in ("refuse", "clarify"):
        return {"head": "refuse", "refuseReason": frame["reason"]}
    if head in ("cmd", "seq"):
        flat["head"] = "write"
        flat["cmds"] = []
        for cmd in frame["cmds"]:
            args = [dict({"name": a["name"]}, **_rhs_to_flat(a["rhs"]))
                    for a in cmd["args"]]
            flat["cmds"].append({
                "verb": cmd["verb"], "args": args,
                "on": _set_to_flat(cmd["on"]) if cmd["on"] else None})
        return flat
    if head == "show":
        flat["head"] = "show"
    elif head == "count":
        flat["head"] = "count"
    elif head == "agg":
        flat["head"] = frame["agg"]
        flat["aggField"] = frame["field"]
    elif head == "project":
        flat["head"] = "project"
        flat["aggField"] = frame["field"]
    elif head == "balance":
        flat["head"] = "balance"
    elif head == "same":
        flat["head"] = "same"
    else:
        raise Unframeable("head %r" % head)
    flat["set"] = _set_to_flat(frame["set"])
    if frame.get("set2"):
        flat["set2"] = _set_to_flat(frame["set2"])
    return flat


def from_flat(flat):
    """The flat wire object -> a frame.  Raises `Unrenderable`."""
    if not isinstance(flat, dict):
        raise Unrenderable("flat frame is not an object")
    head = _need(flat, "head")
    if head == "nothing":
        return {"head": "nothing"}
    if head == "refuse":
        return {"head": "refuse", "reason": _need(flat, "refuseReason")}
    if head == "write":
        cmds = _need(flat, "cmds")
        if not isinstance(cmds, list) or not cmds:
            raise Unrenderable("write with no command")
        out = []
        for cmd in cmds:
            args = []
            for arg in cmd.get("args") or []:
                args.append({"name": _need(arg, "name"),
                             "rhs": _rhs_from_flat(arg)})
            out.append({"verb": _need(cmd, "verb"), "args": args,
                        "on": _set_from_flat(cmd["on"]) if cmd.get("on") else None})
        return {"head": "seq" if len(out) > 1 else "cmd", "cmds": out}
    if head not in FLAT_HEADS:
        raise Unrenderable("head %r" % head)
    frame = {"set": _set_from_flat(_need(flat, "set"))}
    if head == "show":
        frame["head"] = "show"
    elif head == "count":
        frame["head"] = "count"
    elif head in ("sum", "min", "max"):
        frame["head"] = "agg"
        frame["agg"] = head
        frame["field"] = _need(flat, "aggField")
    elif head == "project":
        frame["head"] = "project"
        frame["field"] = _need(flat, "aggField")
    elif head == "balance":
        frame["head"] = "balance"
        frame["set2"] = _set_from_flat(_need(flat, "set2"))
    elif head == "same":
        frame["head"] = "same"
        frame["set2"] = _set_from_flat(_need(flat, "set2"))
    return frame


def to_canonical(frame):
    """A frame -> a canonical STRING in the corpus's paren style.

    The string is re-parsed before it is returned: a frame that renders to
    something `check.py` will not read back is `Unrenderable`, not output.
    """
    tree = decode(frame)
    text = unparse.render(tree)
    check.parse(text)
    return text


# ------------------------------------------------------------------- the proof


def gold_turns():
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


def prove(rows, label, through_flat=True):
    """gold canonical -> parse -> encode -> [flat ->] decode -> render.

    `through_flat` runs the WHOLE path the harness runs at inference: the
    frame is flattened to the wire object a `DynamicGenerationSchema` can
    describe and rebuilt from it, so the number measures the surface the
    model actually fills and not a richer one only Python can reach.
    """
    ok, failures = 0, []
    for row in rows:
        canonical = row["canonical"]
        try:
            gold = check.parse(canonical)
        except Exception as exc:  # the corpus is meant to parse; report if not
            failures.append((row, "gold does not parse: %s" % exc))
            continue
        try:
            frame = encode(gold)
            if through_flat:
                frame = from_flat(json.loads(json.dumps(to_flat(frame))))
            back = check.parse(to_canonical(frame))
        except Exception as exc:
            failures.append((row, "%s: %s" % (type(exc).__name__, exc)))
            continue
        if back == gold:
            ok += 1
        else:
            failures.append((row, "tree differs"))
    print("%-28s %4d/%-4d  %.1f%%" % (label, ok, len(rows),
                                      100.0 * ok / max(1, len(rows))))
    return ok, failures


def main():
    rows = gold_turns()
    prove(rows, "gold, frame only", through_flat=False)
    ok, failures = prove(rows, "gold, through the wire")
    for row, why in failures:
        print("   %-7s %-5s t%-2s  %s\n            %s"
              % (row["corpus"], row["session"], row["turn"], why,
                 row["canonical"]))
    train = os.path.join(HERE, "..", "canon-model", "data", "train.jsonl")
    if os.path.exists(train):
        seen, trows = set(), []
        with open(train, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                target = r.get("target") or r.get("canonical") or ""
                if not target or target == "Unparsed" or target in seen:
                    continue
                seen.add(target)
                trows.append({"canonical": target, "corpus": "train",
                              "session": "-", "turn": 0})
        tok, tfail = prove(trows, "train.jsonl (distinct)")
        why = {}
        for _row, reason in tfail:
            why[reason.split(":")[0]] = why.get(reason.split(":")[0], 0) + 1
        if why:
            print("   train failure classes:", why)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
