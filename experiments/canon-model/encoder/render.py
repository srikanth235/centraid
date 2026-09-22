"""Unparse a check.py tree back to a canonical string, in ONE fixed style.

`data/train.jsonl` writes `show events called "x"`; `grammar/map.json` writes
`show (events called "x")`.  Both parse to the same tree, so a model trained
on one style scores 0 exact against the other.  Every canonical is therefore
NORMALISED through this printer before it is decomposed, and the printer's
style is the corpus's: a Set operand is parenthesised wherever it is nested.

`normalise(s)` is idempotent and tree-preserving; `check.parse(normalise(s))`
equals `check.parse(s)` for every canonical in train, val and map.json.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..", "..",
                                                 "crates", "evalsuite", "grammar")))
import check  # noqa: E402

SETOPS = {"kind", "walk", "called", "filter", "during", "order", "union",
          "except", "first", "ref"}


def q(value):
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')


def lit(node):
    if node["node"] == "lit":
        if node["type"] in ("string",):
            return q(node["value"])
        return str(node["value"])
    if node["node"] == "setarg":
        return "(%s)" % rset(node["set"])
    if node["node"] == "fieldref":
        return node["field"]
    return rvalue(node)


def rwindow(w):
    how = w["how"]
    if how in ("date", "datetime", "month", "daterange"):
        return w["value"]
    if how == "phrase":
        return w["value"]
    if how == "rolling":
        return "next %d %s" % (w["n"], w["unit"])
    if how == "anchored":
        return "from (%s) to (%s)" % (rvalue(w["from"]), rvalue(w["to"]))
    raise ValueError(how)


def rpred(p):
    n = p["node"]
    if n in ("and", "or"):
        return "%s %s %s" % (rpred(p["left"]), n, rpred(p["right"]))
    if n == "not":
        return "not %s" % rpred(p["pred"])
    if n == "countwalk":
        return "count of %s %s %d" % (p["kind"], p["op"], p["n"])
    if n == "member":
        return "member of (%s)" % rset(p["set"])
    if n == "is":
        return "%s is %s%s" % (p["field"], "not " if p["not"] else "", p["what"])
    if n == "pwindow":
        return "%s during %s" % (p["field"], rwindow(p["window"]))
    if n == "band":
        centre = p["centre"]
        centre = int(centre) if float(centre).is_integer() else centre
        return "%s around %s" % (p["field"], centre)
    if n == "contains":
        return "%s contains %s" % (p["field"], q(p["lit"]))
    if n == "oneof":
        return "%s in (%s)" % (p["field"], ", ".join(q(x) for x in p["lits"]))
    if n == "cmp":
        return "%s %s %s" % (p["field"], p["op"], lit(p["rhs"]))
    raise ValueError(n)


def _group(node):
    """A nested Set operand is always parenthesised."""
    return "(%s)" % rset(node)


def _post(node):
    """A union/except under a postfix must be parenthesised (GRAMMAR.md 1)."""
    if node["node"] in ("union", "except"):
        return "(%s)" % rset(node)
    return rset(node)


def rset(s):
    n = s["node"]
    if n == "kind":
        return s["kind"]
    if n == "ref":
        if s["ref"] == "ordinal":
            k = s["n"]
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(
                k if k % 100 not in (11, 12, 13) else 0, "th")
            return "the %d%s one" % (k, suffix)
        return s["ref"]
    if n == "walk":
        return "%s of %s" % (s["kind"]["kind"], _group(s["from"]))
    if n == "called":
        return "%s called %s" % (_post(s["set"]), q(s["lit"]))
    if n == "filter":
        return "%s that (%s)" % (_post(s["set"]), rpred(s["pred"]))
    if n == "during":
        return "%s during %s" % (_post(s["set"]), rwindow(s["window"]))
    if n == "order":
        return "%s ordered by %s %s" % (_post(s["set"]), s["field"], s["dir"])
    if n in ("union", "except"):
        word = "and" if n == "union" else "except"
        return "%s %s %s" % (_side(s["left"]), word, _side(s["right"]))
    if n == "first":
        return "first %d of %s" % (s["n"], _group(s["set"]))
    raise ValueError(n)


def _side(node):
    """A union/except operand is parenthesised (the corpus's dominant style)."""
    if node["node"] == "kind":
        return rset(node)
    return _group(node)


def rvalue(v):
    n = v["node"]
    if n == "agg":
        if v["agg"] == "count":
            return "count of %s" % _group(v["set"])
        return "%s %s of %s" % (v["agg"], v["field"], _group(v["set"]))
    if n == "project":
        return "%s of %s" % (v["field"], _group(v["set"]))
    if n == "balance":
        return "balance of %s in %s" % (_group(v["of"]), _group(v["in"]))
    raise ValueError(n)


def rcmd(c):
    args = ", ".join("%s: %s" % (k, lit(val)) for k, val in c["args"].items())
    out = "%s{%s}" % (c["verb"], args)
    if c["on"] is not None:
        out += " on %s" % _group(c["on"])
    return out


def render(t):
    n = t["node"]
    if n == "nothing":
        return "nothing"
    if n in ("refuse", "clarify"):
        return "%s: %s" % (n, t["reason"])
    if n == "show":
        return "show %s" % _group(t["set"])
    if n == "same":
        return "same? %s %s" % (_group(t["left"]), _group(t["right"]))
    if n == "cmd":
        return rcmd(t)
    if n == "seq":
        return " then ".join(rcmd(s) for s in t["steps"])
    return rvalue(t)


def normalise(canonical):
    return render(check.parse(canonical))
