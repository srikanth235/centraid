"""Decompose a canonical string into DECISIONS + SPANS, and reassemble it.

    decompose(canonical) -> Decomp(template, holes)
    assemble(template, fills) -> canonical

The decomposition is done on CHARACTER SPANS of the canonical string: every
lexical terminal a model would have to choose (kind, field, comparator,
window phrase, verb, ref, order direction, arg name) or COPY (quoted literal,
date, number) is replaced in place by a typed hole marker `<TYPE#i>`, and
everything else in the string is kept verbatim.  Reassembly is therefore
string substitution, so round-trip is exact by construction wherever the
scanner covers every terminal; a canonical whose scan leaves an unknown
identifier behind is reported as a COVERAGE finding rather than silently
templated.

    python3 canon_decomp.py            # round-trip proof over train/val/map

Hole types
    KIND FIELD CMP WIN VERB REF DIR ARG REASON   -- closed-vocabulary heads
    LIT DATE NUM DUR                             -- copied spans (BIO tagger)
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field as dfield

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "..",
                                        "crates", "evalsuite", "grammar"))
sys.path.insert(0, GRAMMAR)

import check  # noqa: E402
import lexicon  # noqa: E402

from render import normalise  # noqa: E402

CLOSED = ("KIND", "FIELD", "CMP", "WIN", "VERB", "REF", "DIR", "ARG", "REASON")
COPIED = ("LIT", "DATE", "NUM", "DUR")
HOLE_TYPES = CLOSED + COPIED

# Words that are the grammar's own structure and never a model choice.
STRUCT = {
    "show", "same?", "count", "of", "sum", "min", "max", "balance", "in",
    "on", "then", "nothing", "refuse", "clarify", "that", "called", "during",
    "ordered", "by", "and", "or", "except", "not", "first", "contains",
    "around", "is", "null", "true", "false", "me", "member", "from", "to",
}

VERBS = set(lexicon.COMMANDS) | set(lexicon.EGRESS_VERBS) | set(lexicon.VERB_CLASSES)
KIND_PHRASES = sorted(lexicon.KINDS, key=len, reverse=True)
WIN_PHRASES = sorted(lexicon.WINDOW_PHRASES, key=len, reverse=True)
REF_PHRASES = sorted(lexicon.REFS, key=len, reverse=True)
ORDINAL_REF = re.compile(r"the \d+(?:st|nd|rd|th) one")
NEXT_N = re.compile(r"next \d+ (?:days|weeks|months)")
WORD = re.compile(r"[A-Za-z0-9_]")


@dataclass
class Hole:
    type: str
    index: int          # ordinal within its type, in canonical order
    value: str          # the source text of the span
    start: int
    end: int

    @property
    def name(self):
        return "<%s#%d>" % (self.type, self.index)


@dataclass
class Decomp:
    template: str
    holes: list = dfield(default_factory=list)
    unknown: list = dfield(default_factory=list)

    def fills(self):
        return {h.name: h.value for h in self.holes}

    def labels(self):
        """The decision labels: template class + one fill per hole."""
        out = {"template": self.template}
        for h in self.holes:
            out["%s%d" % (h.type, h.index)] = h.value
        return out


def _boundary(text, start, end):
    before = start == 0 or not WORD.match(text[start - 1])
    after = end >= len(text) or not WORD.match(text[end])
    return before and after


def _phrase(text, pos, phrases):
    for p in phrases:
        if text.startswith(p, pos) and _boundary(text, pos, pos + len(p)):
            return p
    return None


def scan(canonical):
    """Yield (kind, text, start, end) for every terminal of the canonical."""
    text = canonical
    pos = 0
    out = []
    n = len(text)
    while pos < n:
        if text[pos].isspace():
            pos += 1
            continue
        # multi-word closed phrases first (longest match)
        got = _phrase(text, pos, KIND_PHRASES)
        if got:
            out.append(("KIND", got, pos, pos + len(got)))
            pos += len(got)
            continue
        got = _phrase(text, pos, REF_PHRASES)
        if got:
            out.append(("REF", got, pos, pos + len(got)))
            pos += len(got)
            continue
        for rx, ty in ((ORDINAL_REF, "REF"), (NEXT_N, "WIN")):
            m = rx.match(text, pos)
            if m and _boundary(text, pos, m.end()):
                out.append((ty, m.group(), pos, m.end()))
                pos = m.end()
                break
        else:
            got = _phrase(text, pos, WIN_PHRASES)
            if got:
                out.append(("WIN", got, pos, pos + len(got)))
                pos += len(got)
                continue
            m = check.TOKEN.match(text, pos)
            if not m:
                raise ValueError("bad char at %d of %r" % (pos, text))
            grp, raw = m.lastgroup, m.group()
            end = m.end()
            if grp == "string":
                out.append(("LIT", raw, pos, end))
            elif grp in ("date", "datetime", "month", "daterange"):
                out.append(("DATE", raw, pos, end))
            elif grp == "duration":
                out.append(("DUR", raw, pos, end))
            elif grp in ("number", "ordinal"):
                out.append(("NUM", raw, pos, end))
            elif grp == "op":
                out.append(("CMP", raw, pos, end))
            elif grp == "ident":
                out.append(("IDENT", raw, pos, end))
            else:
                out.append(("KEEP", raw, pos, end))
            pos = end
            continue
        continue
    return out


def _classify_ident(raw, nxt, first=False):
    # `refuse` / `clarify` open a DECLINE turn and are followed by ":", which
    # would otherwise make them an argument NAME.  They are structure, and the
    # refuse/clarify distinction belongs in the template, not in the ARG
    # vocabulary.  Only these two need the guard: every other STRUCT word that
    # can precede ":" (`to:`, `by:`, `from:`) really is an argument name.
    if first and raw in ("refuse", "clarify"):
        return "KEEP"
    if raw in ("asc", "desc"):
        return "DIR"
    if raw in VERBS:
        return "VERB"
    if raw in lexicon.DECLINE_REASONS:
        return "REASON"
    if nxt == ":":
        return "ARG"
    if raw in STRUCT:
        return "KEEP"
    if raw in lexicon.FIELDS:
        return "FIELD"
    return "UNKNOWN"


def decompose(canonical):
    toks = scan(canonical)
    holes, unknown = [], []
    counter = {}
    pieces = []
    last = 0
    for i, (ty, raw, start, end) in enumerate(toks):
        if ty == "IDENT":
            nxt = toks[i + 1][1] if i + 1 < len(toks) else ""
            ty = _classify_ident(raw, nxt, first=(i == 0))
            if ty == "UNKNOWN":
                unknown.append(raw)
                continue
        if ty == "KEEP":
            continue
        idx = counter.get(ty, 0)
        counter[ty] = idx + 1
        h = Hole(ty, idx, raw, start, end)
        holes.append(h)
        pieces.append(canonical[last:start])
        pieces.append(h.name)
        last = end
    pieces.append(canonical[last:])
    return Decomp("".join(pieces), holes, unknown)


HOLE_RX = re.compile(r"<(?:%s)#\d+>" % "|".join(HOLE_TYPES))


def assemble(template, fills):
    """template + {hole name: text} -> canonical.  Missing fills stay as holes."""
    return HOLE_RX.sub(lambda m: fills.get(m.group(), m.group()), template)


# ---------------------------------------------------------------------------


def _rows(path, key):
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line)[key])
    return out


def main():
    data = os.path.normpath(os.path.join(HERE, "..", "data"))
    sets = [
        ("train.jsonl", _rows(os.path.join(data, "train.jsonl"), "target")),
        ("val.jsonl", _rows(os.path.join(data, "val.jsonl"), "target")),
    ]
    gold = [r["canonical"] for r in
            json.load(open(os.path.join(GRAMMAR, "map.json"), encoding="utf-8"))["turns"]]
    sets.append(("map.json gold", gold))
    templates = set()
    vocab = {t: set() for t in HOLE_TYPES}
    maxi = {t: 0 for t in HOLE_TYPES}
    bad_all = []
    for name, rows in sets:
        ok = 0
        bad = []
        for raw_c in rows:
            try:
                c = normalise(raw_c)
                if normalise(c) != c:
                    bad.append((raw_c, "normalise not idempotent -> %r" % normalise(c)))
                    continue
                if check.parse(c) != check.parse(raw_c):
                    bad.append((raw_c, "normalise changed the tree -> %r" % c))
                    continue
                d = decompose(c)
                back = assemble(d.template, d.fills())
            except Exception as err:                       # pragma: no cover
                bad.append((raw_c, "scan: %s" % err))
                continue
            if back != c:
                bad.append((raw_c, "roundtrip -> %r" % back))
                continue
            if d.unknown:
                bad.append((raw_c, "unknown idents %s" % d.unknown))
                continue
            ok += 1
            templates.add(d.template)
            for h in d.holes:
                vocab[h.type].add(h.value)
                maxi[h.type] = max(maxi[h.type], h.index + 1)
        print("%-14s %5d rows  round-trip %5d (%.2f%%)  failures %d"
              % (name, len(rows), ok, 100.0 * ok / max(1, len(rows)), len(bad)))
        bad_all.extend((name, c, why) for c, why in bad)
    print("\ntemplates: %d" % len(templates))
    for t in HOLE_TYPES:
        print("  %-7s vocab %4d  max slots %d" % (t, len(vocab[t]), maxi[t]))
    if bad_all:
        print("\nFAILURES (%d):" % len(bad_all))
        for name, c, why in bad_all[:60]:
            print("  [%s] %s\n      %s" % (name, c, why))
    return 1 if bad_all else 0


if __name__ == "__main__":
    sys.exit(main())
