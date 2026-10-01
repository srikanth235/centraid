"""Compile the canonical grammar (GRAMMAR.md section 1) to GBNF.

    python3 gbnf.py              # writes canon.gbnf
    python3 gbnf.py --prove      # every gold canonical in map.json must match

The rules below transcribe `crates/evalsuite/grammar/check.py`'s recursive
descent parser one method to one rule, and the TERMINALS are not typed here:
kinds, fields, verbs, refs, windows and decline reasons are read from the
generated `lexicon.py`, the same module check.py parses with. A renamed kind
changes this output without anyone touching it.

GBNF forbids left recursion, and so does a recursive descent parser, so the
parser's loops (`set_expr`'s `and`/`except`, `set_postfix`'s suffixes, `pred`'s
`and`/`or`) become `( ... )*` exactly where the parser has `while True`.

Whitespace is CANONICAL, not free: one space between words, optional single
space around punctuation. Constraining a small model to one spelling of each
line is the point; `--prove` is what says the gold corpus is written that way.

The recognizer is here because llama.cpp ships no GBNF validator in this
build. It runs over the same rule table the GBNF text is printed from, so what
is proved is what is emitted. Depth bounds (GRAMMAR.md "Depth bounds") are NOT
encoded: GBNF recursion is unbounded, and a bound would multiply the rules by
four for a limit no gold line comes near.
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "crates",
                                            "evalsuite", "grammar"))
sys.path.insert(0, GRAMMAR_DIR)
from lexicon import (  # noqa: E402
    COMMANDS, DECLINE_REASONS, FIELDS, KINDS, REFS, VERB_CLASSES,
    RELATIVE_DAYS, WINDOW_PHRASES,
)

OUT = os.path.join(HERE, "canon.gbnf")

# An item is ("lit", text) | ("cls", regex-char-class) | ("rule", name),
# optionally wrapped ("opt"|"star"|"plus", [items]) or ("alt", [[items], ...]).
L = lambda s: ("lit", s)            # noqa: E731
R = lambda s: ("rule", s)           # noqa: E731
C = lambda s: ("cls", s)            # noqa: E731
OPT = lambda *xs: ("opt", list(xs))     # noqa: E731
STAR = lambda *xs: ("star", list(xs))   # noqa: E731
PLUS = lambda *xs: ("plus", list(xs))   # noqa: E731
ALT = lambda *seqs: ("alt", [list(s) for s in seqs])  # noqa: E731

_, O = R("_"), R("o")   # required single space; optional single space


def words(options):
    """Longest first, so a greedy reader never stops at a prefix."""
    return [[L(w)] for w in sorted(options, key=lambda w: (-len(w), w))]


def rules():
    g = {}
    g["root"] = [[R("turn")]]
    g["turn"] = [
        [L("nothing")],
        [ALT([L("refuse")], [L("clarify")]), O, L(":"), O, R("reason")],
        [L("show"), _, R("set")],
        [L("same?"), _, R("primary"), _, R("primary")],
        [R("cmd"), STAR(_, L("then"), _, R("cmd"))],
        [R("value")],
    ]
    g["value"] = [
        [L("count"), _, L("of"), _, R("set")],
        [ALT([L("sum")], [L("min")], [L("max")]), _, R("field"), _, L("of"),
         _, R("set")],
        [L("balance"), _, L("of"), _, R("set"), _, L("in"), _, R("set")],
        [R("field"), _, L("of"), _, R("set")],
    ]
    g["cmd"] = [[R("verb"), O, L("{"), O, OPT(R("args"), O), L("}"),
                 OPT(_, L("on"), _, R("set"))]]
    g["args"] = [[R("arg"), STAR(O, L(","), O, R("arg"))]]
    g["arg"] = [[R("name"), O, L(":"), O, R("argval")]]
    g["name"] = [[C("[a-z_]"), STAR(C("[a-z0-9_]"))]]
    g["argval"] = [
        [L("("), O, R("set"), O, L(")")],
        [R("value")],
        [R("literal")],
        [R("duration")],
        [ALT([L("null")], [L("true")], [L("false")], [L("me")])],
    ]
    # check.py set_expr: `and` / `except` bind looser than the postfixes
    g["set"] = [[R("postfix"), STAR(_, ALT([L("and")], [L("except")]), _,
                                    R("postfix"))]]
    g["postfix"] = [[R("primary"), STAR(_, R("suffix"))]]
    g["suffix"] = [
        [L("called"), _, R("string")],
        [L("that"), O, L("("), O, R("pred"), O, L(")")],
        [L("during"), _, R("window")],
        [L("ordered by"), _, R("field"), _, ALT([L("asc")], [L("desc")])],
    ]
    # set_primary and set_primary_or_group accept the same language
    g["primary"] = [
        [L("("), O, R("set"), O, L(")")],
        [L("first"), _, R("number"), _, L("of"), _, R("set")],
        [R("ref")],
        [R("kind"), OPT(_, L("of"), _, R("primary"))],
    ]
    g["pred"] = [[R("patom"), STAR(_, ALT([L("and")], [L("or")]), _,
                                   R("patom"))]]
    g["patom"] = [
        [L("not"), _, R("patom")],
        [L("("), O, R("pred"), O, L(")")],
        [L("count of"), _, R("kind"), O, R("cmp"), O, R("number")],
        [L("member of"), _, R("primary")],
        [R("field"), _, L("is"), _, OPT(L("not"), _),
         ALT([L("null")], [L("me")])],
        [R("field"), _, L("during"), _, R("window")],
        [R("field"), _, L("around"), _, R("number")],
        [R("field"), _, L("contains"), _, R("string")],
        [R("field"), _, L("in"), O, L("("), O, R("string"),
         STAR(O, L(","), O, R("string")), O, L(")")],
        [R("field"), O, R("cmp"), O, R("operand")],
    ]
    g["operand"] = [
        [L("("), O, R("set"), O, L(")")],
        [R("literal")],
        [ALT([L("true")], [L("false")], [L("null")], [L("me")])],
        [R("field")],
    ]
    g["cmp"] = words({"<=", ">=", "!=", "=", "<", ">"})
    g["window"] = [
        [R("daterange")], [R("datetime")], [R("date")], [R("month")],
        [L("from"), O, L("("), O, R("value"), O, L(")"), _, L("to"), O,
         L("("), O, R("value"), O, L(")")],
        [L("next"), _, R("number"), _,
         ALT([L("months")], [L("days")], [L("weeks")])],
        [R("winrelday")],
    ] + words(WINDOW_PHRASES)
    # check.py reldate(): RelDay [at Time]; inside a window no `at Time`, and
    # today/tomorrow/yesterday are the window PHRASES above
    g["reldate"] = [[R("relday"), OPT(_, L("at"), _, R("time"))]]
    g["relday"] = [[R("winrelday")], [L("today")], [L("tomorrow")],
                   [L("yesterday")]]
    g["winrelday"] = [
        [ALT([L("next")], [L("last")]), _, R("weekday")],
        [R("weekday")],
        [L("the"), _, R("monthday"),
         ALT([L("st")], [L("nd")], [L("rd")], [L("th")])],
        [L("in"), _, PLUS(C("[0-9]")), _, L("days")],
    ]
    g["weekday"] = words(RELATIVE_DAYS)
    g["ref"] = [[L("the"), _, PLUS(C("[0-9]")),
                 ALT([L("st")], [L("nd")], [L("rd")], [L("th")]), _,
                 L("one")]] + words(REFS)
    g["kind"] = words(KINDS)
    g["field"] = words(FIELDS)
    g["verb"] = words(set(COMMANDS) | set(VERB_CLASSES))
    g["reason"] = words(DECLINE_REASONS)
    g["literal"] = [[R("string")], [R("daterange")], [R("datetime")],
                    [R("date")], [R("month")], [R("number")],
                    [R("reldate")]]
    g["string"] = [[L('"'), STAR(ALT([C('[^"\\\\]')],
                                     [L("\\"), C("[^\\n]")])), L('"')]]
    d = lambda n: [C("[0-9]")] * n   # noqa: E731
    g["date"] = [d(4) + [L("-")] + d(2) + [L("-")] + d(2)]
    g["month"] = [d(4) + [L("-")] + d(2)]
    g["datetime"] = [[R("date"), L("T")] + d(2) + [L(":")] + d(2)
                     + [OPT(L(":"), *d(2), OPT(L("."), PLUS(C("[0-9]")))),
                        OPT(L("Z"))]]
    # the ranges check.py enforces: day 1..31, 00:00..23:59
    g["monthday"] = [[C("[12]"), C("[0-9]")], [L("3"), C("[01]")],
                     [C("[1-9]")]]
    g["time"] = [[ALT([C("[01]"), C("[0-9]")], [L("2"), C("[0-3]")]),
                  L(":"), C("[0-5]"), C("[0-9]")]]
    g["daterange"] = [[R("date"), L(".."), R("date")]]
    g["duration"] = [[ALT([L("+")], [L("-")]), PLUS(C("[0-9]")),
                      ALT([L("h")], [L("d")], [L("m")])]]
    g["number"] = [[OPT(L("-")), PLUS(C("[0-9]")),
                    OPT(L("."), PLUS(C("[0-9]")))]]
    g["_"] = [[L(" ")]]
    g["o"] = [[OPT(L(" "))]]
    return g


# -- printing ---------------------------------------------------------------

def gname(name):
    return {"_": "sp", "o": "osp"}.get(name, name)


def fmt_item(item):
    tag, body = item
    if tag == "lit":
        return json.dumps(body)
    if tag == "cls":
        return body
    if tag == "rule":
        return gname(body)
    if tag == "alt":
        return "(" + " | ".join(fmt_seq(s) for s in body) + ")"
    suffix = {"opt": "?", "star": "*", "plus": "+"}[tag]
    return "(" + fmt_seq(body) + ")" + suffix


def fmt_seq(seq):
    return " ".join(fmt_item(i) for i in seq)


def emit(g):
    lines = ["# GENERATED by experiments/toolchat/gbnf.py from check.py's",
             "# parser and lexicon.py. Do not edit; regenerate.", ""]
    for name, alts in g.items():
        # ONE LINE per rule: llama.cpp ends a rule at a newline outside
        # parentheses, so a continuation line starting `|` fails to parse
        lines.append("%s ::= %s" % (gname(name),
                                   " | ".join(fmt_seq(s) for s in alts)))
    return "\n".join(lines) + "\n"


# -- recognizer over the same table -----------------------------------------

class Recognizer:
    """Set-of-end-positions matcher: handles every ambiguity, no backtracking
    blowup, and needs no left recursion because the grammar has none."""

    def __init__(self, g):
        self.g = g
        self.cls = {}

    def full(self, text):
        self.text = text
        self.memo = {}
        return len(text) in self.rule("root", 0)

    def rule(self, name, pos):
        key = (name, pos)
        if key in self.memo:
            return self.memo[key]
        self.memo[key] = frozenset()        # no left recursion: guard only
        out = set()
        for seq in self.g[name]:
            out |= self.seq(seq, frozenset([pos]))
        self.memo[key] = frozenset(out)
        return self.memo[key]

    def seq(self, seq, starts):
        for item in seq:
            nxt = set()
            for p in starts:
                nxt |= self.item(item, p)
            starts = frozenset(nxt)
            if not starts:
                break
        return starts

    def item(self, item, pos):
        tag, body = item
        t = self.text
        if tag == "lit":
            return {pos + len(body)} if t.startswith(body, pos) else set()
        if tag == "cls":
            rx = self.cls.setdefault(body, re.compile(body))
            return {pos + 1} if pos < len(t) and rx.match(t[pos]) else set()
        if tag == "rule":
            return self.rule(body, pos)
        if tag == "alt":
            out = set()
            for s in body:
                out |= self.seq(s, frozenset([pos]))
            return out
        once = lambda ps: self.seq(body, ps)   # noqa: E731
        if tag == "opt":
            return {pos} | once(frozenset([pos]))
        seen, frontier = set(), frozenset([pos])
        if tag == "star":
            seen.add(pos)
        while frontier:
            frontier = frozenset(once(frontier) - seen)
            seen |= frontier
        return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prove", action="store_true")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    g = rules()
    text = emit(g)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("%s  %d rules, %d chars" % (args.out, len(g), len(text)))
    if args.prove:
        with open(os.path.join(GRAMMAR_DIR, "map.json"), encoding="utf-8") as fh:
            gold = [t["canonical"] for t in json.load(fh)["turns"]]
        rec = Recognizer(g)
        bad = [c for c in gold if not rec.full(c)]
        print("gold canonicals matched: %d of %d" % (len(gold) - len(bad),
                                                     len(gold)))
        for c in bad:
            print("  NO MATCH: %s" % c)
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
