"""Prefix acceptance for the canonical grammar, built from `check.py`.

The one source of truth for the grammar is
`crates/evalsuite/grammar/check.py`.  This module does not restate it: it
imports the very same `Parser` and drives it in PREFIX MODE, so anything
`check.py` accepts is accepted here and nothing else is.

Two questions are answered:

  * `viable(text)`   -- can this string still become a legal canonical?
  * `complete(text)` -- is it one already?

`viable` is what grammar-constrained decoding needs.  It is implemented by
running `check.Parser` over the tokens lexed so far, with the end of input
replaced by a sentinel that raises `NeedMore` instead of `ParseError`.
`check.Parser` is a deterministic recursive-descent parser with finite
lookahead, so "it has not failed yet" is exactly "the prefix is viable",
up to decisions it would only make once more input arrives -- in which
case we answer viable, which is the conservative direction (a gold token
is never blocked; an illegal one is caught a few characters later, and the
final `complete()` gate never lets an unparseable string out).
"""

from __future__ import annotations

import functools
import os
import re
import sys

GRAMMAR_DIR = os.environ.get(
    "CANON_GRAMMAR_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "..", "crates", "evalsuite", "grammar"),
)
GRAMMAR_DIR = os.path.abspath(GRAMMAR_DIR)
if GRAMMAR_DIR not in sys.path:
    sys.path.insert(0, GRAMMAR_DIR)

import check  # noqa: E402  (the repo's own parser)

ParseError = check.ParseError


# ---------------------------------------------------------------------------
# Prefix-mode parser
# ---------------------------------------------------------------------------

class NeedMore(Exception):
    """The parser ran out of input while the prefix was still legal."""


_SENTINEL = ("$need", "\0")


class PrefixParser(check.Parser):
    def __init__(self, tokens):          # noqa: D107 - no lexing, tokens given
        self.text = ""
        self.tokens = list(tokens) + [_SENTINEL]
        self.at = 0

    def peek(self, ahead=0):
        index = min(self.at + ahead, len(self.tokens) - 1)
        token = self.tokens[index]
        if token is _SENTINEL:
            raise NeedMore()
        return token

    def take(self):
        token = self.tokens[self.at]
        if token is _SENTINEL:
            raise NeedMore()
        self.at += 1
        return token


@functools.lru_cache(maxsize=200_000)
def viable_tokens(tokens: tuple) -> bool:
    """True when this token sequence is a prefix of some legal turn."""
    try:
        PrefixParser(tokens).parse_turn()
        return True                       # already a whole turn
    except NeedMore:
        return True                       # legal so far, wants more
    except check.ParseError:
        return False
    except (RecursionError, ValueError, IndexError, KeyError):
        return False


# ---------------------------------------------------------------------------
# The candidate terminals.  Idents come from check.py's own lexicons; every
# other token class is represented by one witness, because the parser only
# ever inspects a non-ident token's CLASS (and, for operators and
# punctuation, its exact text).
# ---------------------------------------------------------------------------

_STRUCTURAL = {
    "show", "nothing", "refuse", "clarify", "of", "that", "called", "during",
    "ordered", "by", "asc", "desc", "and", "or", "not", "except", "first",
    "then", "on", "in", "is", "null", "true", "false", "me", "contains",
    "around", "count", "sum", "min", "max", "balance", "member", "from", "to",
    "next", "days", "weeks", "months", "the", "one",
}


# `check.py` tests FIELDS and COMMANDS by set membership and nothing else,
# so every member behaves identically in the parser.  One witness stands for
# the whole lexicon, and the prefix index expands it back to every word.
# The small lexicons (structural words, kind words, refs, windows, reasons)
# stay individual, because there the exact word changes the parse.
FIELD_WITNESS = ("ident", "summary")
VERB_WITNESS = ("ident", "schedule.edit_task")


def _ident_words():
    words = set(_STRUCTURAL)
    words |= set(check.DECLINE_REASONS)
    words |= set(check.VERB_CLASSES)
    for phrase in list(check.KINDS) + list(check.REFS) + list(check.WINDOW_PHRASES):
        words.update(phrase.split())
    return {w for w in words if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", w)}


IDENT_WORDS = sorted(_ident_words())
_LEXICON_WORDS = set(IDENT_WORDS)

# (class, witness text).  `ident` entries are real; the rest are witnesses.
_CLASS_WITNESS = [
    ("string", '"x"'),
    ("number", "1"),
    ("date", "2026-06-19"),
    ("datetime", "2026-06-19T14:00"),
    ("month", "2026-06"),
    ("daterange", "2026-06-04..2026-06-06"),
    ("duration", "+1h"),
    ("ordinal", "1st"),
    ("same", "same?"),
]
_OPS = ["<=", ">=", "!=", "=", "<", ">"]
_PUNCT = ["(", ")", "{", "}", ":", ","]

# A command's ARGUMENT NAMES are the command's own JSON schema (GRAMMAR.md
# 2.7), not a closed lexicon -- `check.py` accepts any ident there.  This
# witness stands for "some identifier not in the lexicon"; it is only ever
# allowed where the parser genuinely allows a free identifier, because
# `allowed_next` decides by running the parser.
FREE_IDENT = ("ident", "qqzzfreeident")

GROUPS = {
    FIELD_WITNESS: sorted(check.FIELDS),
    VERB_WITNESS: sorted(check.COMMANDS) or ["schedule.edit_task"],
}

CANDIDATES = (
    [("ident", w) for w in IDENT_WORDS]
    + [FREE_IDENT, FIELD_WITNESS, VERB_WITNESS]
    + _CLASS_WITNESS
    + [("op", o) for o in _OPS]
    + [("punct", p) for p in _PUNCT]
)


@functools.lru_cache(maxsize=100_000)
def allowed_next(head: tuple) -> tuple:
    """Every candidate terminal that may legally follow `head`."""
    out = []
    for candidate in CANDIDATES:
        if candidate == FREE_IDENT:
            # An argument name is the only place `check.py` takes an
            # identifier it does not know, and it is always followed by
            # `:`.  Testing the pair instead of the bare ident is what
            # stops "any word at all" from being viable at, say, the start
            # of a turn, where one token of lookahead cannot yet tell a
            # verb from a field.
            if viable_tokens(head + (candidate, ("punct", ":"))):
                out.append(candidate)
        elif viable_tokens(head + (candidate,)):
            out.append(candidate)
    return tuple(out)


# ---------------------------------------------------------------------------
# Partial-token compatibility: can this scrap of text still become a terminal?
# ---------------------------------------------------------------------------

_PARTIAL = {
    "number":    re.compile(r"-?\d*(\.\d*)?"),
    "date":      re.compile(r"\d{0,4}(-\d{0,2}){0,2}"),
    "datetime":  re.compile(r"\d{0,4}(-\d{0,2}){0,2}(T\d{0,2}(:\d{0,2}){0,2}Z?)?"),
    "month":     re.compile(r"\d{0,4}(-\d{0,2})?"),
    "daterange": re.compile(r"\d{0,4}(-\d{0,2}){0,2}(\.\.?\d{0,4}(-\d{0,2}){0,2})?"),
    "duration":  re.compile(r"[+-]?\d*[hdm]?"),
    "ordinal":   re.compile(r"\d*(s|st|n|nd|r|rd|t|th)?"),
}


def string_is_open(text: str) -> bool:
    """`text` begins a quoted literal that has not been closed."""
    if not text.startswith('"'):
        return False
    index, escaped = 1, False
    while index < len(text):
        char = text[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"':
            return False
        index += 1
    return True


@functools.lru_cache(maxsize=200_000)
def canon_token(token):
    """Collapse a terminal to the witness that parses identically.

    The parser never looks at a literal's VALUE, and tests fields and
    commands by set membership, so `"Ana"` and `"Marco"`, or `title` and
    `summary`, leave it in the same state.  Folding them onto one witness
    is what keeps the automaton's state space -- and therefore its cache
    -- small enough to decode with.
    """
    kind, raw = token
    if kind == "ident":
        if raw in _LEXICON_WORDS:
            return token          # a word the parse depends on: keep it
        if raw in check.FIELDS:
            return FIELD_WITNESS
        if raw in check.COMMANDS:
            return VERB_WITNESS
        return FREE_IDENT
    if kind in ("string", "date", "datetime", "month", "daterange",
                "duration", "ordinal", "number"):
        return dict(_CLASS_WITNESS).get(kind) and (kind, dict(_CLASS_WITNESS)[kind])
    return token


def complete_token(text: str):
    """The single terminal `text` spells, or None."""
    try:
        tokens = check.lex(text)
    except check.ParseError:
        return None
    tokens = tokens[:-1]                  # drop check.py's own eof
    return tokens[0] if len(tokens) == 1 else None


@functools.lru_cache(maxsize=100_000)
def allowed_index(head: tuple):
    """`allowed_next` compiled for O(1) partial-terminal tests.

    The character automaton asks "could this scrap still grow into
    something legal?" once per trie edge per decoding step, so the answer
    has to be a set lookup, not a scan over the terminals.
    """
    prefixes, classes, free = set(), [], False
    for candidate in allowed_next(head):
        kind, raw = candidate
        if candidate == FREE_IDENT:
            free = True
        elif candidate in GROUPS:
            for word in GROUPS[candidate]:
                for cut in range(1, len(word) + 1):
                    prefixes.add(word[:cut])
        elif kind in ("ident", "same", "op", "punct"):
            for cut in range(1, len(raw) + 1):
                prefixes.add(raw[:cut])
        elif kind == "string":
            classes.append("string")
        else:
            classes.append(kind)
    return frozenset(prefixes), tuple(classes), free


_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")


def compatible_any(head: tuple, partial: str) -> bool:
    """Could `partial` still grow into some terminal legal after `head`?"""
    prefixes, classes, free = allowed_index(head)
    if partial in prefixes:
        return True
    if free and _IDENT_RE.fullmatch(partial):
        return True
    for kind in classes:
        if kind == "string":
            if partial == '"' or string_is_open(partial):
                return True
        elif _PARTIAL[kind].fullmatch(partial):
            return True
    return False


# ---------------------------------------------------------------------------
# The character automaton.  A state is (settled terminals, partial text).
# ---------------------------------------------------------------------------

START = ((), "")


def _settle_ok(head: tuple, token) -> bool:
    """May `token` be SETTLED after `head`?

    `allowed_next` admits the free-identifier witness only when a `:` may
    follow it, because an argument name is the one place `check.py` takes an
    identifier it does not know.  `step_char` used the weaker test
    `viable_tokens(head + (token,))`, so the character automaton settled free
    identifiers where the terminal automaton never would -- `created_at of
    rac...` -- and the decode walked into states no legal turn extends.
    The two now agree.
    """
    if token == FREE_IDENT:
        return viable_tokens(head + (token, ("punct", ":")))
    return viable_tokens(head + (token,))


@functools.lru_cache(maxsize=2_000_000)
def step_char(state, char: str):
    """Advance one character, or None when the character is illegal."""
    head, partial = state

    if string_is_open(partial):           # free text inside a literal
        return (head, partial + char)

    if char.isspace():
        if not partial:
            return state
        token = complete_token(partial)
        if token is None:
            return None
        token = canon_token(token)
        if not _settle_ok(head, token):
            return None
        return (head + (token,), "")

    grown = partial + char
    if compatible_any(head, grown):
        return (head, grown)

    if partial:                           # settle it and start a new terminal
        token = complete_token(partial)
        token = canon_token(token) if token is not None else None
        if token is not None and _settle_ok(head, token):
            head2 = head + (token,)
            if compatible_any(head2, char):
                return (head2, char)
    return None


def step_text(state, text: str):
    for char in text:
        state = step_char(state, char)
        if state is None:
            return None
    return state


def viable(text: str) -> bool:
    return step_text(START, text) is not None


def complete(text: str) -> bool:
    try:
        check.parse(text)
        return True
    except check.ParseError:
        return False
    except (RecursionError, ValueError, IndexError, KeyError):
        return False


def parse(text: str):
    return check.parse(text)


def same_meaning(left: str, right: str) -> bool:
    """Equal as TREES.  The grammar is whitespace-insensitive, and T5's
    decoder re-spaces around the tokens we had to add (`{ to:` for
    `{to:`), so string equality is the wrong test for a round trip."""
    try:
        return check.parse(left) == check.parse(right)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Finishing an unfinished string
# ---------------------------------------------------------------------------

class _EofParser(PrefixParser):
    def __init__(self, tokens):
        self.text = ""
        self.tokens = list(tokens) + [("eof", "")]
        self.at = 0


@functools.lru_cache(maxsize=200_000)
def tokens_complete(tokens: tuple) -> bool:
    try:
        _EofParser(tokens).parse_turn()
        return True
    except Exception:
        return False


def state_complete(state) -> bool:
    head, partial = state
    if not partial:
        return tokens_complete(head)
    token = complete_token(partial)
    if token is None:
        return False
    return tokens_complete(head + (canon_token(token),))


# The finisher searches over TERMINALS, not characters.  A character-level
# breadth-first search was tried first and is unusable: with an alphabet wide
# enough to spell every legal canonical (`{ } <` are Cmd syntax, so without
# them no state inside a command can ever be completed) the frontier is
# exhausted after three or four characters, and it reports "no completion"
# for strings a single word would finish -- e.g. `show (events du`.
#
# `allowed_next` already answers "which terminals may follow this head?", so
# the search runs there: depth is terminals (completions are 1-5 of them),
# and each candidate carries a witness spelling that parses identically to
# every other member of its class.

_CLOSE_FIRST = {")": 0, "}": 1, ",": 2, ":": 3}


def _terminal_candidates(head: tuple):
    """Terminals that may follow `head`, closers and short words first."""
    out = [(term, term[1]) for term in allowed_next(head)]
    out.sort(key=lambda pair: (_CLOSE_FIRST.get(pair[1], 9), len(pair[1])))
    return out


_SEARCH_MEMO: dict = {}


class _Budget(Exception):
    pass


_SPENT = [0]


def _search(head: tuple, depth: int, memo: dict):
    _SPENT[0] += 1
    if _SPENT[0] > SEARCH_BUDGET:
        raise _Budget()
    if tokens_complete(head):
        return ""
    if depth <= 0:
        return None
    key = (head, depth)
    if key in memo:
        return memo[key]
    memo[key] = None                      # cuts the cycles idents can make
    for term, raw in _terminal_candidates(head):
        tail = _search(head + (term,), depth - 1, memo)
        if tail is not None:
            memo[key] = raw + " " + tail
            return memo[key]
    return None


def _settle_partial(state):
    """Ways to finish the terminal half-written in `state`, as (text, state)."""
    head, partial = state
    if not partial:
        return [("", state)]
    if string_is_open(partial):
        tails = ['"']
    else:
        tails = [""]                      # the scrap may already be a terminal
        for _kind, raw in CANDIDATES:
            if raw.startswith(partial):
                tails.append(raw[len(partial):])
        for witness, words in GROUPS.items():
            del witness
            for word in words:
                if word.startswith(partial):
                    tails.append(word[len(partial):])
    out, seen = [], set()
    for tail in tails:
        if tail in seen:
            continue
        seen.add(tail)
        moved = step_text(state, tail + " ")
        if moved is not None:
            out.append((tail + " ", moved))
    return out


MAX_TERMINALS = 8
# A hard budget on node expansions, so one call cannot run for minutes.  It
# is exhausted only by states that need five or more terminals to close;
# those come back as None and are reported as such, never papered over.
SEARCH_BUDGET = 60_000


@functools.lru_cache(maxsize=50_000)
def shortest_completion(state, cap: int = 0):
    """A short suffix that turns `state` into a whole turn, or None.

    Grammar-constrained decoding can only promise that what it emits is a
    LEGAL PREFIX; a model that wanders inside a quoted literal will run out
    of budget mid-string.  This gives the decoder a way out, so what it
    hands back is something `check.py` parses.  `cap` is accepted and
    ignored, for callers written against the character-BFS version.
    """
    del cap
    if state_complete(state):
        return ""
    openings = _settle_partial(state)
    memo = _SEARCH_MEMO
    _SPENT[0] = 0
    try:
        for depth in range(1, MAX_TERMINALS + 1):
            for prefix, opened in openings:
                if state_complete(opened):
                    suffix = prefix
                else:
                    tail = _search(opened[0], depth, memo)
                    if tail is None:
                        continue
                    suffix = prefix + tail
                landed = step_text(state, suffix)
                if landed is not None and state_complete(landed):
                    return suffix
    except _Budget:
        return None
    return None
