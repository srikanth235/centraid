"""Enumerate canonical SKELETONS from the grammar by composition.

A skeleton is a canonical turn whose LITERALS are placeholders ({PERSON1},
{DATE1}, ...).  Nothing here reads the evaluation corpora: the composition is
driven by GRAMMAR.md 1-2 and by ontology.py, which is a projection of the same
terminals check.py holds.

Bounds (the brief's, tighter than the grammar's): at most 2 link walks, 2
filters and 1 aggregate wrapper per turn; Set recursion stays inside the
grammar's depth-4 budget.

Run:  python3 enumerate.py            # prints counts
      python3 enumerate.py --dump     # writes skeletons.json
"""
import itertools
import json
import os
import random
import sys

import ontology as O

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = random.Random(20260615)

# `that one` is reachable again: check.py's ref() now tries phrase length 2.
REFS = ["it", "them", "that one", "the other one", "the earlier one",
        "the last thing I added", "the 2nd one", "the 3rd one"]

WINDOWS = [
    ("today", "phrase"), ("tomorrow", "phrase"), ("yesterday", "phrase"),
    ("this week", "phrase"), ("last week", "phrase"), ("next week", "phrase"),
    ("this weekend", "phrase"), ("last weekend", "phrase"),
    ("this month", "phrase"), ("last month", "phrase"), ("next month", "phrase"),
    ("before now", "phrase"), ("recently", "phrase"),
    ("{DATE}", "date"), ("{MONTH}", "month"), ("{RANGE}", "range"),
    ("next 3 days", "rolling"), ("next 2 weeks", "rolling"),
    ("next 2 months", "rolling"),
]

# The anchored window (GRAMMAR.md 2.6): ends the vault itself holds.
ANCHORED = ('from (dtstart of (events called "{EVENT1}")) '
            'to (dtstart of (events called "{EVENT2}"))')

BOARD_KINDS = [k for k in O.KINDS if k != "things"]
LIST_KINDS = BOARD_KINDS + ["things"]


# --------------------------------------------------------------------------
# set construction
# --------------------------------------------------------------------------
def kind(k):
    return {"op": "kind", "kind": k}


def walk(outer, inner):
    return {"op": "walk", "kind": outer, "from": inner}


def called(s, slot):
    return {"op": "called", "set": s, "slot": slot}


def filt(s, pred):
    return {"op": "filter", "set": s, "pred": pred}


def during(s, window):
    return {"op": "during", "set": s, "window": window}


def order(s, field, direction):
    return {"op": "order", "set": s, "field": field, "dir": direction}


def head_kind(s):
    """The Kind a set expression yields, or None for a Ref."""
    op = s["op"]
    if op in ("kind", "walk"):
        return s["kind"]
    if op in ("called", "filter", "during", "order", "first"):
        return head_kind(s["set"])
    if op in ("union", "except"):
        return head_kind(s["left"])
    return s.get("assume")


# --------------------------------------------------------------------------
# predicates
# --------------------------------------------------------------------------
def preds_for(k):
    """Every predicate atom the Kind's declared column shapes allow."""
    spec = O.KINDS[k]
    out = []
    if spec["label"]:
        out.append({"p": "contains", "field": spec["label"], "slot": O.LABEL_SLOT[k]})
    for field in spec["text"][:2]:
        out.append({"p": "contains", "field": field, "slot": O.LABEL_SLOT[k]})
    for field, values in spec["enum"].items():
        out.append({"p": "cmp", "field": field, "op": "=", "rhs": ("lit", values[0])})
        out.append({"p": "cmp", "field": field, "op": "!=", "rhs": ("lit", values[0])})
        if len(values) > 2:
            out.append({"p": "oneof", "field": field, "lits": values[:2]})
    for field in spec["date"]:
        out.append({"p": "pwindow", "field": field, "window": ("today", "phrase")})
        out.append({"p": "pwindow", "field": field, "window": ("this week", "phrase")})
        out.append({"p": "pwindow", "field": field, "window": ("before now", "phrase")})
        out.append({"p": "cmp", "field": field, "op": "<", "rhs": ("date", "{DATE}")})
        out.append({"p": "cmp", "field": field, "op": ">", "rhs": ("date", "{DATE}")})
    for field in spec["num"]:
        out.append({"p": "cmp", "field": field, "op": ">", "rhs": ("num", "{NUM}")})
        out.append({"p": "cmp", "field": field, "op": "<", "rhs": ("num", "{NUM}")})
        out.append({"p": "band", "field": field})
    for field in spec["flag"]:
        out.append({"p": "cmp", "field": field, "op": "=", "rhs": ("kw", "true")})
        out.append({"p": "cmp", "field": field, "op": "=", "rhs": ("kw", "false")})
    for field in spec["party"]:
        out.append({"p": "is", "field": field, "what": "me", "not": False})
        out.append({"p": "is", "field": field, "what": "me", "not": True})
    for field in spec["nullable"]:
        out.append({"p": "is", "field": field, "what": "null", "not": False})
        out.append({"p": "is", "field": field, "what": "null", "not": True})
    if spec["pair"]:
        a, b = spec["pair"]
        out.append({"p": "cmp", "field": a, "op": "=", "rhs": ("field", b)})
        out.append({"p": "cmp", "field": a, "op": ">", "rhs": ("field", b)})
    # count over the walk, read backwards out of the ontology's own edge
    for outer, inner in O.LINKS:
        if inner == k:
            out.append({"p": "countwalk", "kind": outer, "op": "=", "n": "{SMALL}"})
            out.append({"p": "countwalk", "kind": outer, "op": ">", "n": "{SMALL}"})
    # membership through a join table
    if k in ("members", "parties", "photos", "expenses"):
        host = {"members": "groups", "parties": "groups",
                "photos": "albums", "expenses": "groups"}[k]
        out.append({"p": "member", "kind": host, "slot": O.LABEL_SLOT[host]})
    return out


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------
def render_window(window):
    text, how = window
    if how == "anchored":
        return ANCHORED
    return text


def render_pred(p):
    tag = p["p"]
    if tag == "contains":
        return '%s contains "{%s}"' % (p["field"], p["slot"])
    if tag == "oneof":
        return '%s in (%s)' % (p["field"], ", ".join('"%s"' % v for v in p["lits"]))
    if tag == "pwindow":
        return "%s during %s" % (p["field"], render_window(p["window"]))
    if tag == "band":
        return "%s around {NUM}" % p["field"]
    if tag == "is":
        return "%s is %s%s" % (p["field"], "not " if p["not"] else "", p["what"])
    if tag == "countwalk":
        return "count of %s %s %s" % (p["kind"], p["op"], p["n"])
    if tag == "member":
        return 'member of (%s called "{%s}")' % (p["kind"], p["slot"])
    if tag == "cmp":
        how, value = p["rhs"]
        if how == "lit":
            rhs = '"%s"' % value
        elif how in ("num", "date"):
            rhs = value
        elif how == "field":
            rhs = value
        else:
            rhs = value
        return "%s %s %s" % (p["field"], p["op"], rhs)
    if tag in ("and", "or"):
        return "%s %s %s" % (render_pred(p["left"]), tag, render_pred(p["right"]))
    if tag == "not":
        return "not (%s)" % render_pred(p["pred"])
    raise AssertionError(tag)


def render_set(s):
    op = s["op"]
    if op == "kind":
        return s["kind"]
    if op == "ref":
        return s["ref"]
    if op == "walk":
        return "%s of (%s)" % (s["kind"], render_set(s["from"]))
    if op == "called":
        return '%s called "{%s}"' % (render_set(s["set"]), s["slot"])
    if op == "filter":
        return "%s that (%s)" % (render_set(s["set"]), render_pred(s["pred"]))
    if op == "during":
        return "%s during %s" % (render_set(s["set"]), render_window(s["window"]))
    if op == "order":
        return "%s ordered by %s %s" % (render_set(s["set"]), s["field"], s["dir"])
    if op == "first":
        return "first %s of (%s)" % (s["n"], render_set(s["set"]))
    if op in ("union", "except"):
        word = "and" if op == "union" else "except"
        return "(%s) %s (%s)" % (render_set(s["left"]), word, render_set(s["right"]))
    raise AssertionError(op)


# --------------------------------------------------------------------------
# shape measurement (what the bounds are enforced against)
# --------------------------------------------------------------------------
def shape(s, acc=None):
    acc = acc or {"walks": 0, "filters": 0, "depth": 0}
    return _shape(s, acc, 0)


def _shape(s, acc, d):
    op = s["op"]
    acc["depth"] = max(acc["depth"], d + 1)
    if op == "walk":
        acc["walks"] += 1
        _shape(s["from"], acc, d + 1)
    elif op in ("called", "filter", "during"):
        acc["filters"] += 1
        _shape(s["set"], acc, d + 1)
    elif op in ("order", "first"):
        _shape(s["set"], acc, d + 1)
    elif op in ("union", "except"):
        _shape(s["left"], acc, d + 1)
        _shape(s["right"], acc, d + 1)
    return acc


# --------------------------------------------------------------------------
# family signature -- the key a paraphrase family is authored against
# --------------------------------------------------------------------------
def set_sig(s):
    op = s["op"]
    if op == "kind":
        return "K"
    if op == "ref":
        return "REF"
    if op == "walk":
        return "walk(%s)" % set_sig(s["from"])
    if op == "called":
        return "%s.called" % set_sig(s["set"])
    if op == "filter":
        return "%s.that(%s)" % (set_sig(s["set"]), s["pred"]["p"])
    if op == "during":
        return "%s.during" % set_sig(s["set"])
    if op == "order":
        return "%s.order" % set_sig(s["set"])
    if op == "first":
        return "first(%s)" % set_sig(s["set"])
    if op in ("union", "except"):
        return "%s_%s_%s" % (set_sig(s["left"]), op, set_sig(s["right"]))
    raise AssertionError(op)


# --------------------------------------------------------------------------
# enumeration
# --------------------------------------------------------------------------
def cores():
    """Every set PRIMARY: a board, a ref, a one-hop walk, a two-hop walk."""
    out = []
    for k in LIST_KINDS:
        out.append(kind(k))
    # A Ref stands for the rows the last answer held, so its Kind is the
    # session's, not the sentence's.  `assume` records which board those rows
    # came from so a refinement can take its clause from the right columns.
    for r in REFS:
        out.append({"op": "ref", "ref": r})
        for k in BOARD_KINDS:
            out.append({"op": "ref", "ref": r, "assume": k})
    for outer, inner in O.LINKS:
        out.append(walk(outer, kind(inner)))
        out.append(walk(outer, called(kind(inner), O.LABEL_SLOT[inner])))
    # two hops: outer of (middle of (inner called ...))
    by_inner = {}
    for outer, inner in O.LINKS:
        by_inner.setdefault(inner, []).append(outer)
    for mid, inner in O.LINKS:
        for outer in by_inner.get(mid, []):
            if outer == inner:
                continue
            out.append(walk(outer, walk(mid, called(kind(inner), O.LABEL_SLOT[inner]))))
    return out


CHAINS = [
    [], ["called"], ["that"], ["during"], ["order"],
    ["called", "that"], ["called", "during"], ["that", "that"],
    ["that", "during"], ["during", "order"], ["called", "order"],
    ["that", "order"], ["called", "that", "order"],
]


def decorate(core, chain):
    """Apply a postfix chain to a core, choosing operands from the head Kind."""
    k = head_kind(core)
    spec = O.KINDS.get(k) if k else None
    node = core
    for step in chain:
        if step == "called":
            # A Ref is already a set of resolved rows; naming them again is
            # not something a member says, and the surface reads as garbage.
            if node["op"] == "ref" or not spec or not spec["label"]:
                return None
            node = called(node, O.LABEL_SLOT[k])
        elif step == "that":
            if not spec:
                return None
            options = preds_for(k)
            if not options:
                return None
            node = filt(node, RNG.choice(options))
        elif step == "during":
            if not spec or not spec["date"]:
                return None
            window = RNG.choice(WINDOWS)
            if k == "things":
                window = RNG.choice(WINDOWS[:13])
            node = during(node, window)
        elif step == "order":
            if not spec or not spec["sort"]:
                return None
            node = order(node, RNG.choice(spec["sort"]), RNG.choice(["asc", "desc"]))
    return node


def all_sets(limit_per_sig=9):
    """Every set expression inside the bounds, sampled per family signature."""
    seen = {}
    pool = cores()
    for core in pool:
        k = head_kind(core)
        if k == "things":
            usable = [c for c in CHAINS if "called" not in c and "order" not in c
                      and "that" not in c]
        else:
            usable = CHAINS
        for chain in usable:
            node = decorate(core, chain)
            if node is None:
                continue
            metrics = shape(node)
            if metrics["walks"] > 2 or metrics["filters"] > 2 or metrics["depth"] > 4:
                continue
            sig = set_sig(node)
            bucket = seen.setdefault(sig, [])
            if len(bucket) < limit_per_sig:
                bucket.append(node)
    # combinators, over the simple members only
    simple = [n for sig, group in seen.items() if sig in ("K", "K.called", "K.during")
              for n in group]
    for left, right in itertools.islice(
            ((a, b) for a in simple for b in simple
             if head_kind(a) != head_kind(b) or set_sig(a) != set_sig(b)), 0, 4000, 37):
        for op in ("union", "except"):
            node = {"op": op, "left": left, "right": right}
            if shape(node)["depth"] > 4:
                continue
            bucket = seen.setdefault(set_sig(node), [])
            if len(bucket) < limit_per_sig:
                bucket.append(node)
    for sig in ("K.called", "K.during", "K.order", "K"):
        for node in list(seen.get(sig, []))[:4]:
            wrapped = {"op": "first", "n": "{SMALL}", "set": node}
            bucket = seen.setdefault(set_sig(wrapped), [])
            if len(bucket) < limit_per_sig:
                bucket.append(wrapped)
    return seen


# --------------------------------------------------------------------------
# turns
# --------------------------------------------------------------------------
def numeric_fields(k, agg):
    """`sum` folds a NUMBER; `min`/`max` fold a number or a date."""
    spec = O.KINDS.get(k) or {}
    if agg == "sum":
        return list(spec.get("num", []))
    return list(spec.get("num", [])) + list(spec.get("date", []))


def projectable(k):
    spec = O.KINDS.get(k) or {}
    out = []
    if spec.get("label"):
        out.append(spec["label"])
    out += list(spec.get("date", []))[:2] + list(spec.get("num", []))[:2]
    for field in spec.get("enum", {}):
        out.append(field)
    return out


def build_turns():
    sets_by_sig = all_sets()
    flat = [(sig, node) for sig, group in sets_by_sig.items() for node in group]
    turns = []
    counter = itertools.count(1)

    def emit(turn_kind, canonical, family, parts, node=None):
        metrics = shape(node) if node else {"walks": 0, "filters": 0, "depth": 0}
        turns.append({
            "skel_id": "sk%05d" % next(counter),
            "turn": turn_kind,
            "family": family,
            "canonical": canonical,
            "parts": parts,
            "walks": metrics["walks"],
            "filters": metrics["filters"],
            "depth": metrics["depth"] + (1 if turn_kind in ("value", "cmd") else 0),
        })

    # -- show ---------------------------------------------------------------
    for sig, node in flat:
        emit("show", "show %s" % render_set(node), "show|%s" % sig,
             {"set": node, "kind": head_kind(node)}, node)

    # -- values -------------------------------------------------------------
    for sig, node in flat:
        k = head_kind(node)
        if node["op"] == "ref" or k == "things":
            continue
        if RNG.random() < 0.55:
            emit("value", "count of %s" % render_set(node), "count|%s" % sig,
                 {"set": node, "agg": "count", "kind": k}, node)
        for agg in ("sum", "min", "max"):
            fields = numeric_fields(k, agg)
            if not fields or RNG.random() > 0.22:
                continue
            field = RNG.choice(fields)
            emit("value", "%s %s of %s" % (agg, field, render_set(node)),
                 "%s|%s" % (agg, sig),
                 {"set": node, "agg": agg, "field": field, "kind": k}, node)
        if RNG.random() < 0.3:
            fields = projectable(k)
            if fields:
                field = RNG.choice(fields)
                emit("value", "%s of %s" % (field, render_set(node)),
                     "project|%s" % sig,
                     {"set": node, "agg": "project", "field": field, "kind": k}, node)
    # refs get their own value turns, which is how a follow-up folds an answer
    for ref in REFS[:4]:
        node = {"op": "ref", "ref": ref}
        emit("value", "count of %s" % ref, "count|REF",
             {"set": node, "agg": "count", "kind": None}, node)
        for field in ("amount_minor", "effort_min", "due_at", "dtstart"):
            emit("value", "%s of %s" % (field, ref), "project|REF",
                 {"set": node, "agg": "project", "field": field, "kind": None}, node)

    # -- balance (the Tally reader) ----------------------------------------
    who = [kind("members"), called(kind("members"), "PERSON"),
           {"op": "ref", "ref": "it"}, {"op": "ref", "ref": "them"}]
    where = [called(kind("groups"), "GROUP"), kind("groups")]
    for a, b in itertools.product(who, where):
        emit("value", "balance of %s in %s" % (render_set(a), render_set(b)),
             "balance|%s|%s" % (set_sig(a), set_sig(b)),
             {"set": a, "in": b, "agg": "balance", "kind": "members"}, a)

    # -- same? --------------------------------------------------------------
    pairs = [
        (called(kind("members"), "PERSON"), walk("parties", called(kind("events"), "EVENT"))),
        (called(kind("parties"), "PERSON"), called(kind("members"), "PERSON")),
        (called(kind("places"), "PLACE"), called(kind("groups"), "GROUP")),
        ({"op": "ref", "ref": "it"}, called(kind("parties"), "PERSON")),
        ({"op": "ref", "ref": "them"}, walk("parties", called(kind("photos"), "PHOTO"))),
        (called(kind("tasks"), "TASK"), called(kind("events"), "EVENT")),
        (walk("parties", called(kind("expenses"), "EXPENSE")),
         called(kind("parties"), "PERSON")),
        ({"op": "ref", "ref": "the other one"}, called(kind("locker items"), "LOCKER")),
    ]
    for left, right in pairs:
        emit("same", "same? (%s) (%s)" % (render_set(left), render_set(right)),
             "same|%s|%s" % (set_sig(left), set_sig(right)),
             {"left": left, "right": right, "kind": head_kind(left)}, left)

    # -- commands -----------------------------------------------------------
    anchors_by_kind = {}
    for sig, node in flat:
        k = head_kind(node)
        if k is None:
            anchors_by_kind.setdefault("REF", []).append((sig, node))
        else:
            anchors_by_kind.setdefault(k, []).append((sig, node))
    for k, verbs in O.WRITE_VERBS.items():
        options = [(s, n) for s, n in anchors_by_kind.get(k, [])
                   if n["op"] != "kind"] or anchors_by_kind.get(k, [])
        refs = anchors_by_kind.get("REF", [])
        for verb, needs_anchor, args, gloss in verbs:
            if needs_anchor is None:
                emit("cmd", "%s{%s}" % (verb, (" %s " % args) if args else ""),
                     "create|%s|%s" % (k, gloss),
                     {"verb": verb, "gloss": gloss, "kind": k, "args": args,
                      "set": None})
                continue
            picks = RNG.sample(options, min(8, len(options)))
            picks += RNG.sample(refs, min(2, len(refs)))
            for sig, node in picks:
                if gloss in O.DESTRUCTIVE and node["op"] == "kind":
                    continue        # R-R4: no destructive verb over a board
                if node["op"] in ("order", "first"):
                    continue        # an anchor nobody says out loud
                body = (" %s " % args) if args else ""
                emit("cmd", "%s{%s} on %s" % (verb, body, render_set(node)),
                     "cmd|%s|%s|%s" % (k, gloss, sig),
                     {"verb": verb, "gloss": gloss, "kind": k, "args": args,
                      "set": node}, node)

    # -- ordered sequences --------------------------------------------------
    seq_specs = [
        ("tasks", "schedule.set_task_status", 'status: "completed"', "complete",
         "events", "schedule.cancel_event", "", "cancel"),
        ("tasks", "schedule.edit_task", "due_at: {DATE}", "reschedule",
         "events", "schedule.reschedule_event", "dtstart: {DATETIME}", "reschedule"),
        ("expenses", "tally.restore_expense", "", "restore",
         "expenses", "tally.delete_expense", "", "destroy"),
        ("documents", "core.star_document", "", "star",
         "documents", "core.move_document", 'folder: "{FOLDER}"', "move"),
        ("photos", "media.set_favorite", "favorite: true", "favourite",
         "photos", "media.add_to_album", 'album: "{ALBUM}"', "addalbum"),
        ("notes", "knowledge.move_note", 'notebook: "{NOTEBOOK}"', "move",
         "notes", "knowledge.delete_note", "", "destroy"),
        ("parties", "people.log_interaction", "on: {DATE}", "log",
         "parties", "people.set_cadence", "cadence_days: {CADENCE}", "cadence"),
        ("locker items", "locker.edit_item", 'username: "{USERNAME}"', "amend",
         "locker items", "locker.star_item", "", "star"),
    ]
    for ka, va, aa, ga, kb, vb, ab, gb in seq_specs:
        lefts = [n for s, n in anchors_by_kind.get(ka, []) if n["op"] == "called"][:3]
        rights = [n for s, n in anchors_by_kind.get(kb, []) if n["op"] == "called"][:3]
        for left, right in itertools.islice(itertools.product(lefts, rights), 12):
            first = "%s{%s} on %s" % (va, (" %s " % aa) if aa else "", render_set(left))
            second = "%s{%s} on %s" % (vb, (" %s " % ab) if ab else "", render_set(right))
            emit("seq", "%s then %s" % (first, second),
                 "seq|%s|%s|%s|%s" % (ka, ga, kb, gb),
                 {"steps": [{"verb": va, "gloss": ga, "kind": ka, "args": aa, "set": left},
                            {"verb": vb, "gloss": gb, "kind": kb, "args": ab, "set": right}],
                  "kind": ka})

    # A sequence whose anchors are the rows already on screen -- the commonest
    # shape of all: one sentence, two writes, both deictic.
    ref_seq = [
        ("tasks", "schedule.set_task_status", 'status: "completed"', "complete",
         "tasks", "schedule.edit_task", "due_at: {DATE}", "reschedule"),
        ("tasks", "schedule.set_task_status", 'status: "completed"', "complete",
         "events", "schedule.reschedule_event", "dtstart: {DATETIME}", "reschedule"),
        ("documents", "core.star_document", "", "star",
         "documents", "core.trash_document", "", "destroy"),
        ("photos", "media.set_favorite", "favorite: true", "favourite",
         "photos", "media.set_archived", "archived: true", "archive"),
        ("expenses", "tally.restore_expense", "", "restore",
         "expenses", "tally.delete_expense", "", "destroy"),
        ("locker items", "locker.star_item", "", "star",
         "locker items", "locker.archive_item", "", "archive"),
        ("notes", "knowledge.move_note", 'notebook: "{NOTEBOOK}"', "move",
         "notes", "knowledge.delete_note", "", "destroy"),
    ]
    for ka, va, aa, ga, kb, vb, ab, gb in ref_seq:
        for left_ref, right_ref in (("it", "the other one"),
                                    ("the 2nd one", "the 3rd one"),
                                    ("them", "the other one")):
            left = {"op": "ref", "ref": left_ref, "assume": ka}
            right = {"op": "ref", "ref": right_ref, "assume": kb}
            first = "%s{%s} on %s" % (va, (" %s " % aa) if aa else "", left_ref)
            second = "%s{%s} on %s" % (vb, (" %s " % ab) if ab else "", right_ref)
            emit("seq", "%s then %s" % (first, second),
                 "seqref|%s|%s|%s|%s" % (ka, ga, kb, gb),
                 {"steps": [{"verb": va, "gloss": ga, "kind": ka, "args": aa,
                             "set": left},
                            {"verb": vb, "gloss": gb, "kind": kb, "args": ab,
                             "set": right}],
                  "kind": ka})

    # -- C1: "due" / "overdue" / "outstanding" means OPEN --------------------
    # A completed task is not due; it is done.  The window alone would let a
    # ticked-off row answer, so the canonical carries the predicate.
    for text, how in WINDOWS[:13] + [("{DATE}", "date")]:
        node = during(filt(kind("tasks"),
                           {"p": "cmp", "field": "status", "op": "!=",
                            "rhs": ("lit", "completed")}), (text, how))
        emit("show", "show %s" % render_set(node), "due|tasks|%s" % how,
             {"set": node, "kind": "tasks", "convention": "C1"}, node)
    for text, how in WINDOWS[:13][:8]:
        node = during(filt(kind("obligations"),
                           {"p": "is", "field": "settled_at", "what": "null",
                            "not": False}), (text, how))
        emit("show", "show %s" % render_set(node), "outstanding|obligations|%s" % how,
             {"set": node, "kind": "obligations", "convention": "C1"}, node)

    # -- C3: "what's on <weekday>" is `things`, not `events` -----------------
    # The calendar, the board and the birthday that is on neither (R-T2).
    for text, how in [("today", "phrase"), ("tomorrow", "phrase"),
                      ("this weekend", "phrase"), ("{DATE}", "date")]:
        node = during(kind("things"), (text, how))
        emit("show", "show %s" % render_set(node), "onday|things|%s" % how,
             {"set": node, "kind": "things", "convention": "C3"}, node)

    # -- declinations -------------------------------------------------------
    for reason in ("out_of_ontology", "sealed_egress", "fabricated_secret",
                   "unbounded_destruction"):
        emit("refuse", "refuse: %s" % reason, "refuse|%s" % reason,
             {"reason": reason, "kind": None})
    emit("nothing", "nothing", "nothing|withdraw", {"kind": None})
    return turns


def main():
    turns = build_turns()
    by_turn, by_depth, families = {}, {}, set()
    for row in turns:
        by_turn[row["turn"]] = by_turn.get(row["turn"], 0) + 1
        by_depth[row["depth"]] = by_depth.get(row["depth"], 0) + 1
        families.add(row["family"])
    print("skeletons       : %d" % len(turns))
    print("families        : %d" % len(families))
    print("by turn kind    : %s" % dict(sorted(by_turn.items())))
    print("by depth        : %s" % dict(sorted(by_depth.items())))
    if "--dump" in sys.argv:
        with open(os.path.join(HERE, "skeletons.json"), "w") as handle:
            json.dump(turns, handle, indent=1)
        print("wrote skeletons.json")


if __name__ == "__main__":
    main()
