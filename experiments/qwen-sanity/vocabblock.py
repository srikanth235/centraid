"""The VOCABULARY BLOCK: what may go in each slot, generated, never typed.

    python3 vocabblock.py           # print it, and its size

The doctrine (712 tokens) names the 24 boards and nothing else.  It does not
say which FIELDS belong to which board -- the schema has 172 -- it does not
name a single one of the 148 WRITE COMMANDS ("a typed command from the vault's
registry" is the whole of it), and it does not give the comparators or the
argument names a verb takes.  So the model is asked to pick fields and verbs
it has never been shown; the GBNF keeps it to legal values, and legality is
not meaning.

This block closes that gap.  Everything in it comes out of `gen_vocab.py`,
which reads `lexicon.py` and `derive/derived.json` -- the same sources the
schema is derived from -- so the block cannot tell the model something the
decoder will then refuse.  A vocabulary that disagrees with the grammar would
be worse than none.

WHAT IS DELIBERATELY LEFT OUT.  Nothing about canonical STRING syntax: this
model emits JSON and never a canonical character, so the surface grammar is
noise that would cost tokens and teach nothing.  `GRAMMAR.md` is 37 KB for
exactly that reason and is not what this is.

THE RISK, stated before the measurement.  Small models degrade with long
contexts, and this project has direct evidence: the 2B latched onto ONE line
of the 712-token doctrine ("WHEN UNSURE, DECLINE") and abstained on 79.5% of
turns.  A 350M handed several thousand more tokens may absorb none of them.
If the vocab arm is WORSE than the kNN arm, that is a result about small
models and instruction length, not a failed experiment.
"""

from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite",
                                        "grammar"))
for path in (HERE, AFM, GRAMMAR):
    if path not in sys.path:
        sys.path.insert(0, path)

import gen_vocab   # noqa: E402
import lexicon     # noqa: E402


def _branch_line(branch):
    """One `anyOf` branch as `key: <what may go there>`, required marked."""
    props = branch.get("properties") or {}
    required = set(branch.get("required") or [])
    bits = []
    for name, spec in props.items():
        if spec.get("enum") and len(spec["enum"]) == 1:
            shown = '"%s"' % spec["enum"][0]
        elif spec.get("enum"):
            shown = "one of %d" % len(spec["enum"]) if len(spec["enum"]) > 8 \
                else "|".join(spec["enum"])
        elif "$ref" in spec:
            shown = spec["$ref"].rsplit("/", 1)[-1]
        elif spec.get("type") == "array":
            shown = "[%s]" % (spec.get("items", {}).get("$ref", "")
                              .rsplit("/", 1)[-1] or "string")
        elif spec.get("anyOf"):
            shown = "|".join(
                o.get("$ref", o.get("type", "?")).rsplit("/", 1)[-1]
                for o in spec["anyOf"])
        else:
            shown = spec.get("type", "?")
        bits.append("%s%s: %s" % (name, "*" if name in required else "", shown))
    return "{ %s }" % ", ".join(bits)


def contract():
    """THE OUTPUT CONTRACT, read off the schema the decoder enforces.

    Derived, not described: this walks `mkschema.schema()` itself, so the
    required-slot lists here are the same objects the grammar is built from
    and cannot disagree with it.  A constrained decoder does not need this --
    the grammar already refuses anything else -- but an UNCONSTRAINED model
    has no way to know it, and a frame that omits a required slot is
    unrenderable.
    """
    import mkschema
    schema = mkschema.schema()
    out = ["THE FORM. A turn is exactly one of these objects. A key marked * "
           "is REQUIRED; leave any other key out when the sentence does not "
           "say it."]
    out.append("")
    for branch in schema["anyOf"]:
        out.append("  " + _branch_line(branch))
    out.append("")
    out.append("The pieces those refer to. Each is one of the REQUIRED "
               "combinations listed, plus any of its optional keys.")
    for name in ("set1", "pred1", "atom1", "window", "value", "arg", "cmd",
                 "richset"):
        spec = schema["$defs"].get(name)
        if not spec:
            continue
        label = {"set1": "set", "pred1": "pred", "atom1": "atom",
                 "richset": "set inside a window"}.get(name, name)
        branches = [b for b in (spec.get("anyOf") or [spec])
                    if "properties" in b]
        optional, combos = {}, []
        for branch in branches:
            required = list(branch.get("required") or [])
            line = _branch_line({"properties": {
                k: v for k, v in branch["properties"].items()
                if k in required}, "required": required})
            if line not in combos:
                combos.append(line)
            for key, value in branch["properties"].items():
                if key not in required:
                    optional.setdefault(key, value)
        out.append("")
        out.append("  %s -- required, one of:" % label)
        for line in combos:
            out.append("      %s" % line)
        if optional:
            out.append("      optional: %s"
                       % _branch_line({"properties": optional,
                                       "required": []})[2:-2])
    return "\n".join(out)


def closed_vocabularies():
    """The closed sets a slot may be drawn from, straight out of the lexicon."""
    out = ["CLOSED VOCABULARIES. A slot below takes one of these EXACT "
           "strings and nothing else -- not a paraphrase, not a person's "
           "name, not a word from the sentence."]
    out.append("")
    out.append("  ref: %s. Use `ordinal` with `ordinal: N` for \"the N'th "
               "one\"." % ", ".join(sorted(lexicon.REFS) + ["ordinal"]))
    out.append("  kind: %s, things." % ", ".join(
        k for k in sorted(lexicon.KINDS) if k != "things"))
    out.append("  refuseReason: %s." % ", ".join(sorted(lexicon.DECLINE_REASONS)))
    out.append("  verb class: %s." % ", ".join(sorted(lexicon.VERB_CLASSES)))
    out.append("  window how=phrase value: %s."
               % ", ".join(sorted(lexicon.WINDOW_PHRASES)))
    out.append("  window how=rolling: n plus unit (days, weeks, months).")
    out.append("  window how=date 2026-06-19; datetime 2026-06-19T14:00; "
               "month 2026-05; daterange 2026-06-04..2026-06-06.")
    out.append("  a duration argument: +1h, -30m, +2d.")
    return "\n".join(out)


def names():
    """EVERY value of the two enums `contract()` prints only the SIZE of.

    `_branch_line` abbreviates any enum wider than eight to `one of N`, so
    `contract` alone says `kind*: one of 25` and `field*: one of 172` and
    never a legal value of either.  `text()` closes most of the second gap
    board by board, but it groups the columns `derived.json` attributes to a
    board, and seventeen of the grammar's 172 `field` values are attributed
    to none: command-argument names, housekeeping columns, and columns of a
    surface no board is a door onto.  Those are legal in `field` and appear
    in no list `spec` prints.

    Everything below is read off `mkschema.schema()` -- the object the GBNF
    is compiled from -- and `gen_vocab.per_kind_fields()`, the same source
    `text()` groups by.  Nothing here comes from a model's output: a name a
    model got wrong is not evidence about the grammar, and a block built
    from one would be measuring the sample, not the vocabulary.
    """
    import mkschema
    schema = mkschema.schema()
    kinds = schema["$defs"]["set1"]["anyOf"][0]["properties"]["kind"]["enum"]
    fields = schema["anyOf"][4]["properties"]["aggField"]["enum"]
    grouped = gen_vocab.per_kind_fields()
    verb_args = gen_vocab.verb_args()
    placed = {f for kind, cols in grouped.items() if kind != "things"
              for f in cols}
    loose = [f for f in sorted(fields) if f not in placed]
    arg_names = {a for spec in verb_args.values() for a in (spec.get("args") or [])}

    out = ["EVERY NAME BEHIND THE COUNTS. The form above writes an enum wider "
           "than eight as `one of N`. These are those N, in full. A slot takes "
           "one of these EXACT strings and nothing else."]
    out.append("")
    out.append("  `kind`, `walk1`, `walk2` and `countwalk.kind` -- all %d "
               "boards:" % len(kinds))
    out.append("    %s" % ", ".join(sorted(kinds)))
    out.append("")
    out.append("  `field`, `aggField`, `orderField`, and `value` when "
               "`valueKind` is \"field\" -- all %d columns. A column belongs "
               "to the board listed against it; naming it on another board is "
               "wrong even though the form allows it."
               % len(fields))
    for kind in sorted(grouped):
        if kind == "things":
            continue
        out.append("    %s: %s" % (kind, ", ".join(grouped[kind])))
    out.append("    things: every column listed above at once.")
    if loose:
        out.append("  %d more are legal in `field` and the ontology "
                   "attributes them to no board -- they are command-argument "
                   "names, housekeeping columns, or columns of a surface no "
                   "board is a door onto. Prefer a board's own column; reach "
                   "for one of these only when the sentence names it:"
                   % len(loose))
        out.append("    %s" % ", ".join(
            ("%s (a command argument)" % f) if f in arg_names else f
            for f in loose))
    return "\n".join(out)


def text(include_enums=True, include_walks=True):
    fields = gen_vocab.per_kind_fields()
    walks = gen_vocab.per_kind_walks()
    verbs_by_kind = gen_vocab.per_kind_verbs()
    enums = gen_vocab.per_kind_enum_values()
    verb_args = gen_vocab.verb_args()
    classes = sorted(lexicon.VERB_CLASSES)

    out = []
    out.append("THE SLOTS, BOARD BY BOARD. `field` may only be a column of "
               "the board the set is about. After a link walk the board "
               "changes, and so do the columns.")
    out.append("")
    for kind in sorted(lexicon.KINDS):
        if kind == "things":
            continue                      # the union of all the others
        out.append("%s" % kind)
        out.append("  fields: %s" % ", ".join(fields.get(kind, [])))
        if include_walks and walks.get(kind):
            out.append("  links to: %s" % ", ".join(walks[kind]))
        if include_enums and enums.get(kind):
            for column, values in sorted(enums[kind].items()):
                out.append("  %s is one of: %s" % (column, ", ".join(values)))
    out.append("")
    out.append("`things` means every board at once and takes any of the "
               "columns above.")
    out.append("")
    out.append("COMPARATORS: = != < <= > >=")
    out.append("")
    out.append("THE WRITE COMMANDS. A write names one verb and its arguments. "
               "The five VERB CLASSES resolve to the right command once the "
               "board is known: %s." % ", ".join(classes))
    out.append("")
    # ONE LINE PER COMMAND, not one per (board, command).  The per-board verb
    # lists hold 1 168 entries between them for 153 distinct commands, and
    # spelling the arguments out 1 168 times costs ~8 000 tokens to say the
    # same thing eight times over.  The mapping is inverted instead: the
    # command names its own boards.
    boards_for = {}
    for kind in sorted(lexicon.KINDS):
        if kind == "things":
            continue
        for verb in verbs_by_kind.get(kind, []):
            if verb not in classes:
                boards_for.setdefault(verb, []).append(kind)
    every = len([k for k in lexicon.KINDS if k != "things"])
    for verb in sorted(boards_for):
        spec = verb_args.get(verb) or {}
        args = spec.get("args") or []
        required = set(spec.get("required") or [])
        shown = ", ".join(("%s*" % a) if a in required else a for a in args)
        where = boards_for[verb]
        scope = "any board" if len(where) == every else ", ".join(where)
        out.append("  %s(%s) -- %s" % (verb, shown, scope))
    out.append("")
    out.append("An argument marked * is required by the command. "
               "`reschedule` takes `to` (a date or date-time) or `by` "
               "(a duration such as +1h).")
    return "\n".join(out)


def block(which):
    """The named grammar block.

    `slots`, `contract` and `spec` are FROZEN: every number already taken
    with one of them stays reproducible, so they are never edited.  `full`
    is `spec` with `names()` spliced in directly after `contract()`, where
    the `one of N` counts are printed and where resolving them costs the
    reader no backtracking.
    """
    if which == "slots":
        return text()
    if which == "contract":
        return "\n\n".join([contract(), closed_vocabularies()])
    if which == "spec":
        return "\n\n".join([contract(), closed_vocabularies(), text()])
    if which == "full":
        return "\n\n".join([contract(), names(), closed_vocabularies(),
                            text()])
    raise ValueError("no block %r" % which)


BLOCKS = ("none", "slots", "contract", "spec", "full")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-enums", action="store_true")
    ap.add_argument("--no-walks", action="store_true")
    ap.add_argument("--size-only", action="store_true")
    args = ap.parse_args()
    block = text(include_enums=not args.no_enums,
                 include_walks=not args.no_walks)
    if not args.size_only:
        print(block)
    print("\n---- %d chars, %d words, ~%d tokens (chars/3.6)"
          % (len(block), len(block.split()), len(block) / 3.6),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
