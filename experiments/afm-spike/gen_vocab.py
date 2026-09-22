"""Generate `Sources/afm-spike/Vocab.swift` and `Doctrine.swift`.

Every enum the on-device model may pick from — the 25 kinds, the verbs, the
fields each kind holds, the comparators, the window phrases, the refs, the
decline reasons — is read LIVE out of `crates/evalsuite/grammar/lexicon.py`
and `grammar/derive/derived.json` (the ontology, walked).  Nothing is typed
here, so the Swift side cannot drift from the grammar the scorer uses:
re-run this after any ontology change and `git diff` is the whole story.

    python3 gen_vocab.py            # writes both Swift files
    python3 gen_vocab.py --check    # non-zero if either is stale

The instructions block is generated from the same two sources and is kept
small on purpose: the on-device model has a 4 096-token context and the
instructions are resident for every turn of every session.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "crates", "evalsuite", "grammar"))
if GRAMMAR not in sys.path:
    sys.path.insert(0, GRAMMAR)

import lexicon  # noqa: E402

DERIVED = json.load(open(os.path.join(GRAMMAR, "derive", "derived.json"), encoding="utf-8"))
MAP = json.load(open(os.path.join(GRAMMAR, "map.json"), encoding="utf-8"))

OUT = os.path.join(HERE, "Sources", "afm-spike")

# Fields every board carries and a member can always ask about.
UNIVERSAL = ["created_at", "updated_at", "favorite", "starred"]
# Kinds the ontology serves through a collection table, so `derived.json`
# has no per-column entry for them; their fields come from the gold usage
# plus the universal set.
CORE_LABEL = {"albums": ["title", "album_titles"], "notebooks": ["title"]}


def fields_used_in_gold():
    """Every (kind, field) pair the corpus actually writes.

    A field the ontology serves but no member ever names still belongs in the
    vocabulary; a field the corpus names is proof the vocabulary needs it.
    """
    used = {}

    def note(kind, field):
        used.setdefault(kind, set()).add(field)

    def walk_set(s, kind):
        n = s["node"]
        if n == "kind":
            return s["kind"]
        if n == "ref":
            return kind
        if n == "walk":
            walk_set(s["from"], kind)
            return s["kind"]["kind"]
        if n in ("union", "except"):
            walk_set(s["left"], kind)
            return walk_set(s["right"], kind)
        inner = walk_set(s["set"], kind)
        if n == "order":
            note(inner, s["field"])
        if n == "filter":
            for field in pred_fields(s["pred"]):
                note(inner, field)
        return inner

    def pred_fields(p):
        n = p["node"]
        if n in ("and", "or"):
            return pred_fields(p["left"]) + pred_fields(p["right"])
        if n == "not":
            return pred_fields(p["pred"])
        out = [p["field"]] if p.get("field") else []
        if n == "cmp" and p["rhs"]["node"] == "fieldref":
            out.append(p["rhs"]["field"])
        return out

    def walk_turn(t):
        n = t["node"]
        if n == "show":
            walk_set(t["set"], None)
        elif n == "same":
            walk_set(t["left"], None)
            walk_set(t["right"], None)
        elif n in ("agg", "project"):
            kind = walk_set(t["set"], None)
            if t.get("field"):
                note(kind, t["field"])
        elif n == "balance":
            walk_set(t["of"], None)
            walk_set(t["in"], None)
        elif n == "cmd":
            if t.get("on"):
                walk_set(t["on"], None)
        elif n == "seq":
            for step in t["steps"]:
                if step.get("on"):
                    walk_set(step["on"], None)

    for row in MAP["turns"]:
        walk_turn(row["tree"])
    return used


def per_kind_fields():
    """kind -> the fields a member may name on it, in a stable order."""
    predicates = DERIVED["predicates"]
    derived_fields = DERIVED.get("derivedFields", {})
    gold = fields_used_in_gold()
    out = {}
    for kind, (entity, door) in lexicon.KINDS.items():
        names = set(CORE_LABEL.get(kind, []))
        cols = predicates.get("%s@%s" % (entity, door), {})
        for col, shape in cols.items():
            if not shape.get("housekeeping"):
                names.add(col)
        for name, spec in derived_fields.items():
            if spec.get("entity") == entity:
                names.add(name)
        names |= gold.get(kind, set())
        names |= set(UNIVERSAL)
        names = {n for n in names if n in lexicon.FIELDS}
        out[kind] = sorted(names)
    # `things` fans out over every door, so it takes the union.
    out["things"] = sorted({f for k, v in out.items() if k != "things" for f in v})
    return out


def per_kind_enum_values():
    """kind -> field -> the CHECK values that column admits."""
    predicates = DERIVED["predicates"]
    out = {}
    for kind, (entity, door) in lexicon.KINDS.items():
        cols = predicates.get("%s@%s" % (entity, door), {})
        values = {c: v["checkValues"] for c, v in cols.items() if v.get("checkValues")}
        if values:
            out[kind] = {c: sorted(v) for c, v in values.items()}
    return out


def per_kind_walks():
    """kind -> the kinds reachable from it by one link walk.

    `derived.json#links` is over (entity, door) pairs; a Kind is one such
    pair, so an edge is a legal walk exactly when both ends are Kinds.
    """
    by_pair = {}
    for kind, (entity, door) in lexicon.KINDS.items():
        by_pair.setdefault((entity, door), kind)
    out = {}
    for link in DERIVED["links"]:
        src = (link["from"]["entity"], link["from"]["door"])
        dst = (link["to"]["entity"], link["to"]["door"])
        if src in by_pair and dst in by_pair:
            out.setdefault(by_pair[src], set()).add(by_pair[dst])
    # what the corpus walks, which is the ground truth for reachability
    for row in MAP["turns"]:
        stack = [row["tree"]]
        while stack:
            node = stack.pop()
            if not isinstance(node, dict):
                continue
            if node.get("node") == "walk":
                inner = node["from"]
                base = inner.get("kind") if inner.get("node") == "kind" else None
                while base is None and isinstance(inner, dict) and "set" in inner:
                    inner = inner["set"]
                    base = inner.get("kind") if inner.get("node") == "kind" else None
                if base:
                    out.setdefault(base, set()).add(node["kind"]["kind"])
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
            for v in node.values():
                if isinstance(v, list):
                    stack.extend(x for x in v if isinstance(x, dict))
    return {k: sorted(v) for k, v in out.items()}


def per_kind_verbs():
    """kind -> the verbs a member could mean about it.

    A command declares its SUBJECT ENTITY in the registry, so the verbs for a
    Kind are the commands whose subject is that Kind's entity, plus the five
    verb classes (which resolve to a command only once the Kind is known),
    plus every command the registry gives no subject at all — a creator such
    as `schedule.add_task` names the row it is about to mint, not one that
    exists, so the derivation cannot attribute it and the harness must not
    hide it.
    """
    classes = sorted(lexicon.VERB_CLASSES)
    subjectless, by_entity = [], {}
    for verb in DERIVED["verbs"]:
        entity = verb.get("subjectEntity")
        if entity:
            by_entity.setdefault(entity, []).append(verb["name"])
        else:
            subjectless.append(verb["name"])
    gold = {}
    for row in MAP["turns"]:
        stack = [row["tree"]]
        while stack:
            node = stack.pop()
            if not isinstance(node, dict):
                continue
            if node.get("node") == "cmd":
                on = node.get("on") or {}
                inner = on
                base = None
                while isinstance(inner, dict):
                    if inner.get("node") == "kind":
                        base = inner["kind"]
                        break
                    inner = inner.get("set") or inner.get("from") or inner.get("left")
                if base:
                    gold.setdefault(base, set()).add(node["verb"])
            for value in node.values():
                if isinstance(value, dict):
                    stack.append(value)
                elif isinstance(value, list):
                    stack.extend(x for x in value if isinstance(x, dict))
    out = {}
    for kind, (entity, _door) in lexicon.KINDS.items():
        names = set(classes) | set(subjectless) | set(by_entity.get(entity, []))
        names |= gold.get(kind, set())
        out[kind] = sorted(names)
    out["things"] = sorted(set(classes) | set(lexicon.COMMANDS))
    return out


def verb_args():
    """verb -> its required argument names, from the command registry."""
    out = {}
    for verb in DERIVED["verbs"]:
        out[verb["name"]] = {
            "required": sorted(verb.get("required") or []),
            "args": sorted((verb.get("args") or {}).keys()),
        }
    for name, members in lexicon.VERB_CLASSES.items():
        first = sorted(members.values())[0] if members else None
        spec = out.get(first, {"required": [], "args": []})
        out[name] = {"required": spec["required"], "args": spec["args"]}
    return out


# --------------------------------------------------------------- Swift output


def swift_literal(value, indent=0):
    pad = "    " * indent
    if isinstance(value, str):
        return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        items = ",\n".join(pad + "    " + swift_literal(v, indent + 1) for v in value)
        return "[\n%s,\n%s]" % (items, pad)
    if isinstance(value, dict):
        if not value:
            return "[:]"
        items = ",\n".join(
            '%s    "%s": %s' % (pad, k.replace('"', '\\"'), swift_literal(v, indent + 1))
            for k, v in value.items()
        )
        return "[\n%s,\n%s]" % (items, pad)
    raise TypeError(type(value))


HEADER = """// GENERATED by `python3 gen_vocab.py` from
// `crates/evalsuite/grammar/lexicon.py` and `grammar/derive/derived.json`.
// Do not edit: re-run the generator. `python3 gen_vocab.py --check` fails
// the build when this file is stale against the ontology.

"""


def vocab_swift():
    kinds = sorted(lexicon.KINDS)
    verbs = sorted(set(lexicon.COMMANDS) | set(lexicon.VERB_CLASSES))
    body = [
        HEADER,
        "import Foundation\n",
        "public enum Vocab {",
        "    public static let kinds: [String] = %s\n" % swift_literal(kinds, 1),
        "    public static let verbs: [String] = %s\n" % swift_literal(verbs, 1),
        "    public static let verbClasses: [String] = %s\n"
        % swift_literal(sorted(lexicon.VERB_CLASSES), 1),
        "    public static let refs: [String] = %s\n"
        % swift_literal(sorted(lexicon.REFS) + ["ordinal"], 1),
        "    public static let windowPhrases: [String] = %s\n"
        % swift_literal(sorted(lexicon.WINDOW_PHRASES), 1),
        "    public static let declineReasons: [String] = %s\n"
        % swift_literal(sorted(lexicon.DECLINE_REASONS), 1),
        '    public static let comparators: [String] = ["=", "!=", "<", "<=", ">", ">="]\n',
        '    public static let rollingUnits: [String] = ["days", "weeks", "months"]\n',
        "    public static let fieldsByKind: [String: [String]] = %s\n"
        % swift_literal(per_kind_fields(), 1),
        "    public static let enumValuesByKind: [String: [String: [String]]] = %s\n"
        % swift_literal(per_kind_enum_values(), 1),
        "    public static let walksByKind: [String: [String]] = %s\n"
        % swift_literal(per_kind_walks(), 1),
        "    public static let verbsByKind: [String: [String]] = %s\n"
        % swift_literal(per_kind_verbs(), 1),
        "    public static let verbArgs: [String: [String]] = %s\n"
        % swift_literal({k: v["args"] for k, v in sorted(verb_args().items())}, 1),
        "",
        "    public static func fields(for kind: String) -> [String] {",
        '        fieldsByKind[kind] ?? fieldsByKind["things"] ?? []',
        "    }",
        "",
        "    public static func walks(from kind: String) -> [String] {",
        "        walksByKind[kind] ?? kinds",
        "    }",
        "",
        "    public static func commands(for kind: String) -> [String] {",
        "        verbsByKind[kind] ?? verbs",
        "    }",
        "",
        "    public static func args(for verb: String) -> [String] {",
        "        verbArgs[verb] ?? []",
        "    }",
        "}",
        "",
    ]
    return "\n".join(body)


# ------------------------------------------------------------- the instructions


def instructions_text():
    """The ontology digest the model is given, ~900 tokens, generated."""
    boards = []
    for kind, (entity, _door) in lexicon.KINDS.items():
        if kind == "things":
            continue
        boards.append("%s (%s)" % (kind, entity.split(".", 1)[1].replace("_", " ")))
    classes = ", ".join(sorted(lexicon.VERB_CLASSES))
    phrases = ", ".join(sorted(lexicon.WINDOW_PHRASES))
    refs = ", ".join(sorted(lexicon.REFS))
    reasons = ", ".join(sorted(lexicon.DECLINE_REASONS))
    return "\n".join([
        "You read one sentence a person said to their own private vault and "
        "describe what it MEANS by filling in a form. You never write code, "
        "SQL or query text. You only choose from the options each field lists "
        "and copy words out of the person's sentence.",
        "",
        "THE VAULT holds these boards, and nothing else:",
        "  " + "; ".join(boards) + ".",
        "  `things` means all of them at once - use it only when the person "
        "names no board (\"what's on Wednesday\").",
        "",
        "A TURN is one of five MOVES against the previous turn:",
        "  new         - a fresh question; ignore the previous turn.",
        "  refine      - add a condition to the rows the previous turn "
        "answered (\"just the weekend ones\").",
        "  substitute  - same shape as the previous turn, one word swapped "
        "(\"what about Marco?\").",
        "  act         - do something TO the previous answer (\"star it\", "
        "\"push it to Friday\").",
        "  undo        - the person withdrew the request (\"never mind\").",
        "",
        "A turn ASKS for one of:",
        "  show    - a list of rows.",
        "  count / sum / min / max / project - a number, or one field.",
        "  write   - a typed command from the vault's registry, optionally "
        "with a verb class: " + classes + ".",
        "  nothing - the person withdrew.",
        "  refuse  - the request is outside the vault altogether: "
        + reasons + ".",
        "",
        "REFERRING BACK: " + refs + ", or the N'th one. Use a reference "
        "whenever the person means the rows the last turn produced; the "
        "previous canonical is given to you above the sentence.",
        "",
        "TIME: named periods and rolling windows: " + phrases + ", "
        "next N days/weeks/months, or an exact date (2026-06-19), a "
        "date-time, a month (2026-05), or a range (2026-06-04..2026-06-06).",
        "",
        "COPY, NEVER INVENT. Every name, title or quoted value you put in the "
        "form must appear WORD FOR WORD in the person's sentence or in the "
        "previous canonical. If a name you would need is not there, do not "
        "make one up.",
        "",
        "WHEN UNSURE, DECLINE. If the sentence asks for something the vault "
        "cannot hold (the weather, a purchase on a website, sending a "
        "password out), answer refuse. If the person withdrew, answer "
        "nothing. A guess that looks right is worse than a decline, because "
        "the person cannot see that it was a guess.",
    ])


def doctrine_swift():
    text = instructions_text()
    lines = text.split("\n")
    body = ",\n".join('        "%s"' % line.replace("\\", "\\\\").replace('"', '\\"')
                      for line in lines)
    return "".join([
        HEADER,
        "import Foundation\n\n",
        "public enum Doctrine {\n",
        "    /// The ontology digest, generated from the lexicon so it cannot\n",
        "    /// drift from the grammar the scorer uses.\n",
        "    public static let text: String = [\n",
        body,
        ",\n    ].joined(separator: \"\\n\")\n",
        "}\n",
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero when a generated file is stale")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    wrote = []
    for name, text in (("Vocab.swift", vocab_swift()),
                       ("Doctrine.swift", doctrine_swift())):
        path = os.path.join(OUT, name)
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old == text:
            continue
        if args.check:
            print("STALE: %s" % path)
            return 1
        open(path, "w", encoding="utf-8").write(text)
        wrote.append(name)
    words = len(instructions_text().split())
    print("instructions: %d words (~%d tokens)" % (words, int(words * 1.4)))
    print("wrote %s" % (", ".join(wrote) if wrote else "nothing (up to date)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
