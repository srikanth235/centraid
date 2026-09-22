"""The canonical grammar as a Lark CFG, GENERATED from the repo's lexicon.

Why this file exists
--------------------
The old mask (`canon_grammar.py`) drove `check.Parser` in prefix mode from
Python, once per candidate character, per decoding step.  That is both slow
(~1.5 s/turn) and LEAKY: a recursive-descent parser with finite lookahead
answers "still viable" whenever it cannot yet decide, so the mask admits
heads that no legal turn extends and a model with no opinion walks into one
(VERIFY.md: 30.5% parse rate from a random-init model).

This module states the same grammar DECLARATIVELY, so an Earley recognizer
(llguidance, Rust) can compute the token mask.  An Earley recognizer only
admits a token when some item survives it, and an item survives only when
what has been read can still be completed -- so every admitted prefix is
completable and there is no head to walk into.

Drift
-----
The PRODUCTIONS below are a transcription of `check.Parser` (GRAMMAR.md:
productions stay hand-written in each implementation; only terminals are
generated).  The TERMINALS are read live from `grammar/lexicon.py`, which
`derive/emit.py` generates, so a renamed field or command cannot drift.

The transcription is checked BOTH WAYS by `llg_verify.py`, and neither check
is optional:

  * not narrower -- all 434 gold canonicals teacher-forced through the mask,
    none blocked (`--stage gold`);
  * not wider -- every string the mask lets a model emit handed to
    `check.parse`; a failure is a divergence to fix HERE (`--stage random`).

Whitespace
----------
`check.py` lexes with one regex and skips whitespace, so it needs a
separator only between two lexemes that would otherwise merge into one --
two idents, or an ident and a digit.  llguidance's regex engine has no
lookahead (no `\\b`, no `(?!...)`), so that rule cannot be written as a
terminal; without it the mask happily emits `last_contacted_atoffirst5`,
which `check.py` reads as a single identifier.  So the separator is explicit
here, under the rule the corpus already follows:

    a WORDY lexeme (a word, a number, a date, an ordinal) carries a
    MANDATORY leading space; every other position takes an optional one.

Measured against all 434 golds: zero-width adjacency occurs only after `(`
(714 times) and `{` (71), never anywhere else, and no canonical holds a
double space or a tab.  So the `_b` ("bare") variants below are the
first-position duplicates needed after those two brackets, and nothing else
needs one.  The grammar therefore also requires the leading space that
SentencePiece puts in front of the first word of every T5 generation.  This
makes the language NARROWER than `check.py`'s in whitespace alone, which the
gold sweep is what proves harmless.

Depth
-----
GRAMMAR.md bounds `Set` recursion at 4.  `check.py` does NOT enforce that
bound and `check.py` is the oracle, so the grammar below is left unbounded,
exactly like the parser it mirrors.  Earley handles the CFG directly; the
bounded-nesting/regular-language argument is only needed for a DFA
construction, which this approach does not use.
"""

from __future__ import annotations

import os
import sys

GRAMMAR_DIR = os.environ.get(
    "CANON_GRAMMAR_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "..", "crates", "evalsuite", "grammar"),
)
GRAMMAR_DIR = os.path.abspath(GRAMMAR_DIR)
if GRAMMAR_DIR not in sys.path:
    sys.path.insert(0, GRAMMAR_DIR)

from lexicon import (  # noqa: E402
    COMMANDS, DECLINE_REASONS, FIELDS, KINDS, REFS, VERB_CLASSES,
    WINDOW_PHRASES,
)

# ---------------------------------------------------------------------------
# Item constructors.  An alternative is a list of items; each item says how
# much whitespace may precede it.
# ---------------------------------------------------------------------------


def W(text):
    """A WORDY item: a mandatory space in front of it, unless it is first."""
    return ("w", text)


def P(text):
    """A punctuation/operator/string item: an optional space in front."""
    return ("p", text)


def N(name):
    """A nonterminal.  In first position it becomes the `_b` variant.

    A SPACED nonterminal carries its own leading separator (its first item
    is wordy, or optional-space punctuation), so nothing is added in front
    of it here.
    """
    return ("n", name)


def R(text):
    """Raw EBNF, spliced in as written -- repetition and option groups."""
    return ("r", text)


def lit(word):
    return W('"%s"' % word)


def words(phrase):
    return [lit(w) for w in phrase.split()]


# Nonterminals that are ever reached in BARE position -- immediately after
# `(` or `{`.  Each is emitted twice: `x` (leading space required) and `x_b`
# (no leading space).  Everything they can begin with is here too.
BARE = {
    "turn", "cmd", "verb", "set_expr", "set_postfix", "set_primary",
    "set_pog", "walk", "kind", "ref", "pred", "pred_atom", "value", "args",
    "argpair",
}


def _render(items, bare):
    out = []
    for index, (cls, text) in enumerate(items):
        first = index == 0
        if cls == "r":
            out.append(text)
        elif cls == "n":
            out.append(text + "_b" if (first and bare and text in BARE) else text)
        elif cls == "w":
            # BARE means "the lexeme before this one was punctuation, or
            # there is none": a separator is then optional, never required.
            out.append(("WS? " if bare and first else "WS ") + text)
        else:                                   # punctuation: space optional
            out.append("WS? " + text)
    return " ".join(out)


def rule(name, alternatives, parts):
    """Emit `name`, and `name_b` when the nonterminal is reachable bare."""
    for bare in ((False, True) if name in BARE else (False,)):
        label = name + "_b" if bare else name
        body = "\n%s| " % (" " * (len(label) + 1))
        parts.append("%s: %s\n" % (
            label, body.join(_render(alt, bare) for alt in alternatives)))


def _alt(words_):
    return " | ".join('"%s"' % w for w in sorted(words_))


def build_lark() -> str:
    parts = []
    add = parts.append

    # `no_forcing` turns OFF llguidance's fast-forward optimisation.  With it
    # on, a state whose next bytes the grammar forces returns a mask computed
    # PAST those bytes -- the client is expected to take them as ff_tokens
    # rather than sample.  We sample every token through HF `generate`, so a
    # forced state reports the gold token blocked: `show (event` + `s` came
    # back with a one-token mask holding `t`.  A decoder/API mismatch, not a
    # grammar defect, and this is the switch for it.
    add('%llguidance {"no_forcing": true}\n')

    # -- turn ---------------------------------------------------------------
    add("start: turn_b WS?\n")
    rule("turn", [
        [lit("nothing")],
        [W("DECLINE"), P('":"'), W("REASON")],
        [lit("show"), N("set_expr")],
        [W("SAME"), N("set_pog"), N("set_pog")],
        [N("cmd"), R('(WS "then" cmd)*')],
        [N("value")],
    ], parts)

    # -- value --------------------------------------------------------------
    rule("value", [
        [lit("count"), lit("of"), N("set_expr")],
        [W("AGG"), W("FIELD"), lit("of"), N("set_expr")],
        [lit("balance"), lit("of"), N("set_expr"), lit("in"), N("set_expr")],
        [W("FIELD"), lit("of"), N("set_expr")],
    ], parts)

    # -- command ------------------------------------------------------------
    rule("cmd", [
        [N("verb"), P('"{"'), P('"}"'), R("onclause?")],
        [N("verb"), P('"{"'), N("args_b"), P('"}"'), R("onclause?")],
    ], parts)
    rule("onclause", [[lit("on"), N("set_expr")]], parts)
    rule("verb", [[W("VERBCLASS")], [W("COMMAND")]], parts)
    rule("args", [[N("argpair"), R('(WS? "," argpair)*')]], parts)
    rule("argpair", [[W("ARGNAME"), P('":"'), N("argval")]], parts)
    rule("argval", [
        [P('"("'), N("set_expr_b"), P('")"')],
        [N("value")],
        [P("STRING")], [W("NUMBER")], [W("DATERANGE")], [W("DATETIME")],
        [W("DATE")], [W("MONTH")], [P("DURATION")], [W("KEYWORD")],
    ], parts)

    # -- set ----------------------------------------------------------------
    rule("set_expr", [[N("set_postfix"), R("(WS SETOP set_postfix)*")]],
         parts)
    rule("set_postfix", [[N("set_primary"), R("postfix*")]], parts)
    rule("postfix", [
        [lit("called"), P("STRING")],
        [lit("that"), P('"("'), N("pred_b"), P('")"')],
        [lit("during"), N("window")],
        [lit("ordered"), lit("by"), W("FIELD"), W("DIR")],
    ], parts)
    rule("set_primary", [
        [P('"("'), N("set_expr_b"), P('")"')],
        [lit("first"), W("INT"), lit("of"), N("set_expr")],
        [N("ref")],
        [N("walk")],
    ], parts)
    rule("walk", [[N("kind"), R('(WS "of" set_pog)?')]], parts)
    rule("set_pog", [
        [P('"("'), N("set_expr_b"), P('")"')],
        [N("set_primary")],
    ], parts)

    # -- predicate ----------------------------------------------------------
    rule("pred", [[N("pred_atom"), R("(WS PREDOP pred_atom)*")]], parts)
    rule("pred_atom", [
        [lit("not"), N("pred_atom")],
        [P('"("'), N("pred_b"), P('")"')],
        [lit("count"), lit("of"), N("kind"), P("CMP"), W("INT")],
        [lit("member"), lit("of"), N("set_pog")],
        [W("FIELD"), lit("is"), R('(WS "not")?'), W("ISWHAT")],
        [W("FIELD"), lit("during"), N("window")],
        [W("FIELD"), lit("around"), W("NUMBER")],
        [W("FIELD"), lit("contains"), P("STRING")],
        [W("FIELD"), lit("in"), P('"("'), P("STRING"),
         R('(WS? "," WS? STRING)*'), P('")"')],
        [W("FIELD"), P("CMP"), N("operand")],
    ], parts)
    rule("operand", [
        [P('"("'), N("set_expr_b"), P('")"')],
        [P("STRING")], [W("NUMBER")], [W("DATERANGE")], [W("DATETIME")],
        [W("DATE")], [W("MONTH")], [W("KEYWORD")], [W("FIELD")],
    ], parts)

    # -- window -------------------------------------------------------------
    rule("window", [
        [W("DATERANGE")], [W("DATETIME")], [W("DATE")], [W("MONTH")],
        [lit("from"), P('"("'), N("value_b"), P('")"'), lit("to"),
         P('"("'), N("value_b"), P('")"')],
        [lit("next"), W("INT"), W("UNIT")],
        [N("window_phrase")],
    ], parts)
    rule("window_phrase",
         [words(p) for p in sorted(WINDOW_PHRASES,
                                   key=lambda p: (-len(p.split()), p))], parts)

    # -- the closed lexicons ------------------------------------------------
    rule("kind", [words(k) for k in sorted(KINDS,
                                           key=lambda k: (-len(k.split()), k))],
         parts)
    rule("ref", [[lit("the"), W("ORDINAL"), lit("one")]]
         + [words(r) for r in sorted(REFS, key=lambda r: (-len(r.split()), r))],
         parts)

    add('DECLINE: %s\n' % _alt(["refuse", "clarify"]))
    add('REASON: %s\n' % _alt(DECLINE_REASONS))
    add('AGG: %s\n' % _alt(["sum", "min", "max"]))
    add('SETOP: %s\n' % _alt(["and", "except"]))
    add('PREDOP: %s\n' % _alt(["and", "or"]))
    add('DIR: %s\n' % _alt(["asc", "desc"]))
    add('UNIT: %s\n' % _alt(["days", "weeks", "months"]))
    add('ISWHAT: %s\n' % _alt(["null", "me"]))
    add('KEYWORD: %s\n' % _alt(["null", "true", "false", "me"]))
    add('VERBCLASS: %s\n' % _alt(VERB_CLASSES))
    add('COMMAND: %s\n' % _alt(COMMANDS))
    add('FIELD: %s\n' % _alt(FIELDS))

    # -- free terminals -----------------------------------------------------
    # Each is `check.py`'s own regex from its TOKEN table, with control
    # characters excluded from the string body: no canonical holds one, and a
    # model that emits a newline inside a literal is not saying anything.
    add('SAME: "same?"\n')
    add('CMP: "<=" | ">=" | "!=" | "=" | "<" | ">"\n')
    add(r'STRING: /"([^"\\\x00-\x1f]|\\[^\x00-\x1f])*"/' + "\n")
    add(r'NUMBER: /-?[0-9]+(\.[0-9]+)?/' + "\n")
    # `first N`, `count of Kind Cmp N` and `next N days` are the three places
    # `check.py` calls `int()` on the number it lexed.  Its NUMBER regex
    # admits `1956.00`, so `first 1956.00 of (it)` does not raise ParseError
    # there -- it raises ValueError out of `int()`, which is a defect in
    # `check.py` (an unhandled exception where a parse error belongs) and was
    # invisible to the old mask, whose `complete()` catches ValueError and
    # reads it as "not a whole turn".  A limit, a count and a horizon are
    # integers in GRAMMAR.md 1, so the grammar says so and the decoder cannot
    # walk into the crash.  Reported, not worked around: the fix in
    # `check.py` is to raise ParseError on a non-integral count.
    add(r'INT: /-?[0-9]+/' + "\n")
    add(r'DATERANGE: /[0-9]{4}-[0-9]{2}-[0-9]{2}\.\.[0-9]{4}-[0-9]{2}-[0-9]{2}/'
        + "\n")
    add(r'DATETIME: /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
        r'(:[0-9]{2}(\.[0-9]+)?)?Z?/' + "\n")
    add(r'DATE: /[0-9]{4}-[0-9]{2}-[0-9]{2}/' + "\n")
    add(r'MONTH: /[0-9]{4}-[0-9]{2}/' + "\n")
    add(r'DURATION: /[+-][0-9]+[hdm]/' + "\n")
    add(r'ORDINAL: /[0-9]+(st|nd|rd|th)/' + "\n")
    # An argument NAME is the one place `check.py` takes an identifier it does
    # not know: the Args are the command's own JSON schema (GRAMMAR.md 2.7).
    add(r'ARGNAME: /[A-Za-z_][A-Za-z0-9_.]*/' + "\n")
    # Exactly the separator `check.py` skips, minus the newline: no canonical
    # holds one and a generation that emits one is not saying anything.
    add('WS: /[ \\t]+/\n')
    return "".join(parts)


LARK = build_lark()


if __name__ == "__main__":
    sys.stdout.write(LARK)
