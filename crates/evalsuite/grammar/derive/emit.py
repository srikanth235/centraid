#!/usr/bin/env python3
"""Generate both parsers' terminal tables from the ontology, once.

`check.py` and `crates/candidates/src/canon.rs` are one grammar in two
languages. Until now each held its own copy of the lexicons, `canon.rs`
describing its copy as "transcribed from `grammar/check.py`" — and a
transcription is a thing that drifts. The `and`/`called` precedence bug
(DEFECTS #34) was exactly that failure at the production level; the terminals
were one edit away from the same.

So the terminals are now generated. **Structure comes from the ontology**
(`derived.json`), **names come from `terminals.json`**, and this writes:

* `crates/evalsuite/grammar/lexicon.py` — imported by `check.py`
* `crates/candidates/src/canon_terminals.rs` — `include!`d by `canon.rs`

The grammar's PRODUCTIONS stay hand-written in both: a production is the
shape of the meaning space and the ontology says nothing about it. Only
terminals are generated.

Every entry in `terminals.json` is validated first — a Kind whose (entity,
door) the manifests do not serve, a verb class member that is not a registered
command, or a reader Field no app crate names is refused here rather than
shipped. Run with `--check` to verify the committed files are current; that is
what `check.py` does on every run, so a stale lexicon is a red run and not a
silent divergence.
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR_DIR = os.path.normpath(os.path.join(HERE, ".."))
ROOT = os.path.normpath(os.path.join(GRAMMAR_DIR, "..", "..", ".."))

PY_OUT = os.path.join(GRAMMAR_DIR, "lexicon.py")
RS_OUT = os.path.join(ROOT, "crates", "candidates", "src", "canon_terminals.rs")

BANNER = (
    "GENERATED — do not edit. Written by "
    "`crates/evalsuite/grammar/derive/emit.py` from `derive/derived.json` "
    "(the ontology, walked) and `derive/terminals.json` (the names). "
    "Regenerate with `python3 derive/emit.py`; `python3 check.py` verifies it."
)


class Refusal(Exception):
    pass


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def declared_surface(derived, entity: str, door: str) -> str:
    row = derived["surfaces"]["pairs"].get(f"{entity}@{door}") or {}
    return row.get("declared") or "undeclared"


def app_blob() -> str:
    chunks = []
    for door in ("agenda", "docs", "locker", "notes", "people", "photos",
                 "tally", "tasks"):
        base = os.path.join(ROOT, "crates", "apps", door)
        for folder, _dirs, files in os.walk(base):
            if "target" in folder or "tests" in folder:
                continue
            for name in files:
                if name.endswith((".rs", ".json")):
                    with open(os.path.join(folder, name), encoding="utf-8",
                              errors="ignore") as handle:
                        chunks.append(handle.read())
    return "\n".join(chunks)


def build():
    derived = load(os.path.join(HERE, "derived.json"))
    terminals = load(os.path.join(HERE, "terminals.json"))

    served = {(k["entity"], k["door"]) for k in derived["kinds"]}
    # THE SURFACE LOCKSTEP. `vault.scopes[].surface` in each app manifest is
    # the product's statement of what a member can name; the grammar's Kind
    # table is the parser's. They are checked against each other BOTH WAYS
    # below, so neither can grow a Kind the other has not heard of.
    surfaced = {
        tuple(key.split("@", 1))
        for key, row in derived["surfaces"]["pairs"].items()
        if row["declared"] == "kind"
    }
    # SEALED columns are excluded, as GRAMMAR.md §2.2 requires: presence is
    # not plaintext, so `password` is not a Field a canonical may compare and
    # admitting it to the lexicon would let one say `password = "hunter2"`.
    columns: dict[str, set[str]] = {}
    for key, fields in derived["predicates"].items():
        columns.setdefault(key.split("@", 1)[0], set()).update(
            name for name, spec in fields.items() if spec.get("shape") != "sealed"
        )
    registry = {v["name"] for v in derived["verbs"]}

    # -- Kinds ---------------------------------------------------------------
    kinds: dict[str, tuple[str, str]] = {}
    field_set: set[str] = set()
    for name, spec in terminals["kinds"].items():
        entity, door = spec["entity"], spec["door"]
        kinds[name] = (entity, door)
        if entity == "*":
            continue
        # `albums` is spelled `media.album` in the grammar and `core.collection`
        # in the registry (DIFF.md C3). The declaration carries both so the
        # check is against the ontology's name and the output keeps the
        # grammar's, which is what every stored tree in map.json holds.
        ontology_entity = spec.get("ontologyEntity", entity)
        if (ontology_entity, door) not in served:
            raise Refusal(
                f"Kind `{name}` claims ({ontology_entity}, {door}) and the "
                f"{door} manifest grants no read scope over it."
            )
        if (ontology_entity, door) not in surfaced:
            raise Refusal(
                f"Kind `{name}` claims ({ontology_entity}, {door}) and the "
                f"{door} manifest declares that scope's `surface` as "
                f"`{declared_surface(derived, ontology_entity, door)}`, not "
                "`kind` — a member cannot name what the product does not "
                "surface."
            )
        surfaced.discard((ontology_entity, door))
        for source in [ontology_entity] + spec.get("composite", []):
            if source not in columns:
                raise Refusal(f"Kind `{name}` names `{source}`, which no door serves.")
            field_set |= columns[source]

    if surfaced:
        raise Refusal(
            "the manifests declare `surface: \"kind\"` on "
            + ", ".join(f"({e}, {d})" for e, d in sorted(surfaced))
            + " and the grammar names no Kind for it — declare the word in "
            "`terminals.json` and GRAMMAR.md §2.1, or change the scope's "
            "`surface`."
        )

    # -- Fields --------------------------------------------------------------
    blob = app_blob()
    declared_fields = derived.get("derivedFields", {})
    for field, source in terminals["readerFields"].items():
        if source == "manifest":
            # DECLARED, not merely mentioned: the owning app says what computes
            # the field and which tables that reader reads, and
            # `derive_grammar.py` has already held those inputs to the app's own
            # read scopes.
            if field not in declared_fields:
                raise Refusal(
                    f"reader Field `{field}` claims `manifest` and no app "
                    "declares it under `derivedFields`."
                )
        elif not re.search(rf"\b{re.escape(field)}\b", blob):
            raise Refusal(
                f"reader Field `{field}` claims `{source}` and no file under "
                "`crates/apps/*/src` or any app manifest names it."
            )
        field_set.add(field)

    # -- Verbs ---------------------------------------------------------------
    for cls, members in terminals["verbClasses"].items():
        for entity, command in members.items():
            if command not in registry:
                raise Refusal(
                    f"verb class `{cls}` maps `{entity}` to `{command}`, which "
                    "the command registry does not hold."
                )

    # -- Egress --------------------------------------------------------------
    # The refusal class R-R1/R-R2 stands on, taken from the registry's own
    # `DECLARED_EGRESS` rather than from a list in the executor. `exec.rs` held
    # ONE name and missed `locker.export`; nothing now holds a second copy.
    egress_verbs = derived["egress"]["egressVerbs"]
    for verb in egress_verbs:
        if verb not in registry:
            raise Refusal(
                f"egress verb `{verb}` is not a registered command."
            )

    return {
        "kinds": kinds,
        "fields": sorted(field_set),
        "verbClasses": terminals["verbClasses"],
        "egressVerbs": egress_verbs,
        "commands": sorted(registry),
        "refs": terminals["refs"],
        "windowPhrases": terminals["windowPhrases"],
        "declineReasons": terminals["declineReasons"],
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def wrap(prefix: str, text: str, width: int = 76) -> str:
    out, line = [], prefix
    for word in text.split():
        if len(line) + len(word) + 1 > width and line.strip() != prefix.strip():
            out.append(line)
            line = prefix + word
        else:
            line = (line + " " + word) if line.strip() != prefix.strip() else line + word
    out.append(line)
    return "\n".join(out)


def render_python(tables) -> str:
    lines = [f'"""{BANNER}"""', "", "KINDS = {"]
    for name, (entity, door) in tables["kinds"].items():
        lines.append(f'    {name!r}: ({entity!r}, {door!r}),')
    lines.append("}")
    lines.append("")
    lines.append("FIELDS = {")
    for field in tables["fields"]:
        lines.append(f"    {field!r},")
    lines.append("}")
    lines.append("")
    lines.append("VERB_CLASSES = {")
    for cls, members in tables["verbClasses"].items():
        lines.append(f"    {cls!r}: {{")
        for entity, command in members.items():
            lines.append(f"        {entity!r}: {command!r},")
        lines.append("    },")
    lines.append("}")
    lines.append("")
    for name, key in (("REFS", "refs"), ("WINDOW_PHRASES", "windowPhrases"),
                      ("DECLINE_REASONS", "declineReasons"),
                      ("EGRESS_VERBS", "egressVerbs"),
                      ("COMMANDS", "commands")):
        lines.append(f"{name} = {{")
        for value in tables[key]:
            lines.append(f"    {value!r},")
        lines.append("}")
        lines.append("")
    return "\n".join(lines)


def render_rust(tables) -> str:
    kinds = [(n, e, d) for n, (e, d) in tables["kinds"].items()]
    lines = [
        "// " + "\n// ".join(wrap("", BANNER).split("\n")),
        "",
        "/// Kind -> (logical entity, door).",
        "#[must_use]",
        "pub fn kinds() -> BTreeMap<&'static str, (&'static str, &'static str)> {",
        "    [",
    ]
    for name, entity, door in kinds:
        lines.append(f'        ("{name}", ("{entity}", "{door}")),')
    lines += [
        "    ]",
        "    .into_iter()",
        "    .collect()",
        "}",
        "",
        "/// Base-table columns of the Kinds above, plus the reader-computed facts.",
        "const FIELD_WORDS: &str = \"",
    ]
    row: list[str] = []
    for field in tables["fields"]:
        if sum(len(w) + 1 for w in row) + len(field) > 74:
            lines.append(" ".join(row))
            row = []
        row.append(field)
    if row:
        lines.append(" ".join(row))
    lines += [
        "\";",
        "",
        "#[must_use]",
        "pub fn fields() -> Vec<&'static str> {",
        "    FIELD_WORDS.split_whitespace().collect()",
        "}",
        "",
        "/// A verb whose command is fixed only once the anchor's Kind is.",
        "#[must_use]",
        "pub fn verb_classes() -> BTreeMap<&'static str, BTreeMap<&'static str, &'static str>> {",
        "    [",
    ]
    for cls, members in tables["verbClasses"].items():
        lines.append(f'        ("{cls}", [')
        for entity, command in members.items():
            lines.append(f'            ("{entity}", "{command}"),')
        lines += [
            "        ]",
            "        .into_iter()",
            "        .collect::<BTreeMap<_, _>>()),",
        ]
    lines += ["    ]", "    .into_iter()", "    .collect()", "}", ""]

    for const, key in (("REFS", "refs"), ("WINDOW_PHRASES", "windowPhrases"),
                       ("DECLINE_REASONS", "declineReasons"),
                       ("EGRESS_VERBS", "egressVerbs")):
        values = tables[key]
        lines.append(f"const {const}: [&str; {len(values)}] = [")
        for value in values:
            lines.append(f'    "{value}",')
        lines.append("];")
        lines.append("")
    lines += [
        "/// Commands whose declared egress is not `none` — the registry's own",
        "/// `DECLARED_EGRESS`, not a judgement made here. `exec.rs` reads this",
        "/// and holds no list of its own.",
        "#[must_use]",
        "pub fn egress_verbs() -> &'static [&'static str] {",
        "    &EGRESS_VERBS",
        "}",
        "",
    ]
    return "\n".join(lines)


def main(argv) -> int:
    try:
        tables = build()
    except Refusal as refusal:
        print(f"REFUSED: {refusal}", file=sys.stderr)
        return 2
    outputs = {PY_OUT: render_python(tables), RS_OUT: render_rust(tables)}
    checking = "--check" in argv
    stale = []
    for path, text in outputs.items():
        current = None
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                current = handle.read()
        if current == text:
            continue
        if checking:
            stale.append(path)
        else:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)
            print(f"wrote {path}")
    if stale:
        for path in stale:
            print(f"STALE: {path} — run `python3 derive/emit.py`", file=sys.stderr)
        return 1
    if checking:
        print("terminals are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
