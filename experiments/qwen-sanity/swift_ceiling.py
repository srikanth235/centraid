"""How many gold turns can `Sources/afm-spike/Frame.swift` actually express?

`COVERAGE.md` reports 434/434 and concludes "the frame imposes no ceiling".
That number is about `frame.py`'s WIRE FRAME.  It is not about `Frame.swift`,
which is the schema the Apple on-device model is given and therefore the real
ceiling of that spike.

This script reads `Frame.swift`'s slot ladder as a set of predicates over the
gold wire frames and reports, per omission, how many of the 434 it makes
unreachable.  The predicates are written against the file as it stands; each
one cites the line it comes from, and `--show` prints a losing turn per cause.

    python3 swift_ceiling.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (HERE, AFM):
    if path not in sys.path:
        sys.path.insert(0, path)

import frame        # noqa: E402
import check        # noqa: E402
import gen_vocab    # noqa: E402
import mkschema     # noqa: E402

SWIFT = os.path.join(AFM, "Sources", "afm-spike", "Frame.swift")

# ---- what Frame.swift's ObjectSpecs actually offer ------------------------
# Set slots (Frame.swift, `ObjectSpec(name: "Set")`):
SWIFT_SET_SLOTS = {"source", "kind", "ref", "ordinal", "called", "filtersA",
                   "window", "walk1", "filtersB", "walk2", "orderField",
                   "orderDir", "limit", "combineOp", "combineRight"}
# `OtherSet`, the only thing `combineRight` may hold:
SWIFT_OTHERSET_SLOTS = {"source", "kind", "ref", "called"}
SWIFT_ATOM_TYPES = {"cmp", "contains", "is", "pwindow", "band", "oneof",
                    "countwalk"}
SWIFT_ATOM_SLOTS = {"type", "field", "cmp", "valueKind", "value", "num",
                    "what", "negated", "window", "kind"}
SWIFT_ATOM_VALUEKINDS = {"literal", "number", "date", "datetime", "month",
                         "keyword", "bool", "null", "me"}
SWIFT_ARG_SLOTS = {"name", "valueKind", "value"}
SWIFT_ARG_VALUEKINDS = {"literal", "number", "date", "datetime", "month",
                        "duration", "keyword", "bool", "null", "me"}
SWIFT_WINDOW_HOWS = {"phrase", "date", "datetime", "month", "daterange",
                     "rolling"}
SWIFT_CMD_MAX_ARGS = 4
SWIFT_MAX_CMDS = 2

FIELDS_BY_KIND = gen_vocab.per_kind_fields()
WALKS_BY_KIND = gen_vocab.per_kind_walks()
VERBS_BY_KIND = gen_vocab.per_kind_verbs()
VERB_ARGS = {k: set(v["args"]) for k, v in gen_vocab.verb_args().items()}


def arg_names(kind):
    names = set()
    for verb in VERBS_BY_KIND.get(kind) or []:
        names |= VERB_ARGS.get(verb, set())
    if not names:
        names = {"title", "summary", "description", "status", "to", "by"}
    return names


CAUSES = [
    "Set: no called2 slot",
    "Set: no window2 slot",
    "Set: no filtersC slot",
    "Window: no anchored how",
    "Window: exact date goes in `literal`, frame.py reads `value`",
    "Atom: no member type",
    "Atom: no set slot",
    "Atom: no lits slot",
    "Atom: valueKind lacks duration/daterange/field/set/value",
    "Arg: name not in the registry's arg list for this kind",
    "Arg: valueKind lacks set/field/daterange/value",
    "Arg: no set slot",
    "OtherSet: combineRight carries more than source/kind/ref/called",
    "Cmd: more than 4 args, or more than 2 cmds",
    "Field not in this kind's narrowed field list",
]


def audit(flat, kind):
    """Every reason Frame.swift could not have produced this wire frame."""
    hit = set()
    fields = set(FIELDS_BY_KIND.get(kind) or mkschema.FIELDS)
    names = arg_names(kind)

    def note(cause):
        hit.add(cause)

    def do_window(w):
        if not isinstance(w, dict):
            return
        how = w.get("how")
        if how == "anchored":
            note(CAUSES[3])
        elif how in ("date", "datetime", "month", "daterange"):
            note(CAUSES[4])
        elif how not in SWIFT_WINDOW_HOWS:
            note(CAUSES[3])

    def do_atom(a):
        if a.get("type") not in SWIFT_ATOM_TYPES:
            note(CAUSES[5])
        for key in a:
            if key in SWIFT_ATOM_SLOTS:
                continue
            if key == "set":
                note(CAUSES[6])
            elif key == "lits":
                note(CAUSES[7])
            elif key in ("set2",):
                note(CAUSES[6])
        if a.get("valueKind") and a["valueKind"] not in SWIFT_ATOM_VALUEKINDS:
            note(CAUSES[8])
        if a.get("field") and a["field"] not in fields:
            note(CAUSES[14])
        if isinstance(a.get("window"), dict):
            do_window(a["window"])
        if isinstance(a.get("set"), dict):
            do_set(a["set"])

    def do_pred(p):
        for atom in (p or {}).get("atoms") or []:
            do_atom(atom)

    def do_set(s, inner=False):
        if not isinstance(s, dict):
            return
        allowed = SWIFT_OTHERSET_SLOTS if inner else SWIFT_SET_SLOTS
        for key in s:
            if key in allowed:
                continue
            if inner:
                note(CAUSES[12])
            elif key == "called2":
                note(CAUSES[0])
            elif key == "window2":
                note(CAUSES[1])
            elif key == "filtersC":
                note(CAUSES[2])
        for key in ("filtersA", "filtersB", "filtersC"):
            if isinstance(s.get(key), dict):
                do_pred(s[key])
        for key in ("window", "window2"):
            if isinstance(s.get(key), dict):
                do_window(s[key])
        for key in ("orderField",):
            if s.get(key) and s[key] not in fields:
                note(CAUSES[14])
        if isinstance(s.get("combineRight"), dict):
            do_set(s["combineRight"], inner=True)

    head = flat.get("head")
    if head == "write":
        cmds = flat.get("cmds") or []
        if len(cmds) > SWIFT_MAX_CMDS:
            note(CAUSES[13])
        for cmd in cmds:
            args = cmd.get("args") or []
            if len(args) > SWIFT_CMD_MAX_ARGS:
                note(CAUSES[13])
            for arg in args:
                if arg.get("name") not in names:
                    note(CAUSES[9])
                if arg.get("valueKind") not in SWIFT_ARG_VALUEKINDS:
                    note(CAUSES[10])
                for key in arg:
                    if key not in SWIFT_ARG_SLOTS:
                        note(CAUSES[11] if key in ("set", "set2") else CAUSES[10])
                if isinstance(arg.get("set"), dict):
                    do_set(arg["set"])
            if isinstance(cmd.get("on"), dict):
                do_set(cmd["on"])
    else:
        for key in ("set", "set2"):
            if isinstance(flat.get(key), dict):
                do_set(flat[key])
        if flat.get("aggField") and flat["aggField"] not in fields:
            note(CAUSES[14])
    return hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true")
    args = ap.parse_args()

    rows = frame.gold_turns()
    counts = {cause: 0 for cause in CAUSES}
    example = {}
    lost = 0
    for row in rows:
        flat = frame.to_flat(frame.encode(check.parse(row["canonical"])))
        kind = mkschema_base_kind(flat)
        hit = audit(flat, kind)
        if hit:
            lost += 1
            for cause in hit:
                counts[cause] += 1
                example.setdefault(cause, row)
    total = len(rows)
    print("Frame.swift can express  %4d/%-4d  %.1f%%   (frame.py wire frame: "
          "%d/%d)" % (total - lost, total, 100.0 * (total - lost) / total,
                      total, total))
    print()
    print("%-72s turns lost" % "cause (a turn may hit several)")
    for cause in CAUSES:
        if counts[cause]:
            print("  %-70s %4d" % (cause, counts[cause]))
    if args.show:
        print()
        for cause in CAUSES:
            row = example.get(cause)
            if row:
                print("  %s\n     %s/%s t%s  %s"
                      % (cause, row["corpus"], row["session"], row["turn"],
                         row["canonical"]))
    return 0


def mkschema_base_kind(flat):
    def dig(s):
        if not isinstance(s, dict):
            return None
        if s.get("kind"):
            return s["kind"]
        if s.get("combineRight"):
            return dig(s["combineRight"])
        return None
    if flat.get("head") == "write":
        for cmd in flat.get("cmds") or []:
            found = dig(cmd.get("on") or {})
            if found:
                return found
        return "things"
    return dig(flat.get("set") or {}) or "things"


if __name__ == "__main__":
    sys.exit(main())
