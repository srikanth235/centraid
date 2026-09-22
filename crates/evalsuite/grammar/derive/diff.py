#!/usr/bin/env python3
"""Diff the DERIVED terminals against the hand-written grammar.

`derive_grammar.py` says what the ontology supports. `check.py` is the grammar
AS EXECUTED — it generated every tree in `map.json`, so its lexicons are the
grammar's real terminals and not a prose table that may have drifted from
them. This compares the two and writes `DIFF.md` in three sections:

* **(A) the ontology supports it, the grammar lacks it** — a construct a human
  missed. Each item names the turns in `map.json` it would reach, if any.
* **(B) the grammar claims it, the ontology or the doors cannot serve it** —
  the enumeration the owner asked for: a terminal the vault cannot honour.
  Each item names the turns that USE it, which are the turns at risk.
* **(C) naming-only** — the same thing under two spellings.

`map.json` is read only, never written.

Run: `python3 diff.py` (after `derive_grammar.py`).
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR_DIR = os.path.normpath(os.path.join(HERE, ".."))
ROOT = os.path.normpath(os.path.join(GRAMMAR_DIR, "..", "..", ".."))

sys.path.insert(0, HERE)
sys.path.insert(0, GRAMMAR_DIR)

import check  # noqa: E402  — the grammar as executed


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return json.load(handle)


def turns():
    with open(os.path.join(GRAMMAR_DIR, "map.json"), encoding="utf-8") as handle:
        return json.load(handle)["turns"]


def turn_id(turn):
    return f"{turn['session']}.{turn['turn']}"


def walk(node, out):
    """Every node of a stored tree, flattened."""
    if isinstance(node, dict):
        out.append(node)
        for value in node.values():
            walk(value, out)
    elif isinstance(node, list):
        for value in node:
            walk(value, out)


def index(all_turns):
    """turn id -> its nodes, plus reverse indexes by kind / field / verb."""
    nodes = {}
    for turn in all_turns:
        flat = []
        walk(turn.get("tree"), flat)
        nodes[turn_id(turn)] = flat
    return nodes


def used(nodes, predicate):
    return sorted(tid for tid, flat in nodes.items() if any(predicate(n) for n in flat))


def fmt(ids, cap=8):
    if not ids:
        return "none"
    shown = ", ".join(f"`{i}`" for i in ids[:cap])
    return shown + (f" … (+{len(ids) - cap})" if len(ids) > cap else "")


# ---------------------------------------------------------------------------

def surface_section(derived) -> str:
    """What a member can NAME, out of the 119 pairs the doors serve.

    Generated rather than written down, so the table cannot drift from the
    manifests the way §2.1's Kind list drifted from the registry.
    """
    surfaces = derived["surfaces"]
    counts = surfaces["counts"]
    total = sum(counts.values())
    kinds = sorted(
        pair for pair, row in surfaces["pairs"].items() if row["declared"] == "kind"
    )
    facets = sorted(
        pair for pair, row in surfaces["pairs"].items() if row["declared"] == "facet"
    )
    lines = [
        "\n---\n",
        "## S. Surfaces — what a member can name (2026-09-22)\n",
        "The doors serve "
        f"{total} (entity, door) pairs and a member never sees most of them. "
        "Every read scope in `crates/apps/*/manifest.json` now declares a "
        "`surface`; `derive_grammar.py` computes the DEFAULT from the ontology "
        "and `emit.py` refuses a grammar Kind whose scope is not declared "
        "`kind`, and a scope declared `kind` the grammar names no word for.\n",
        "| surface | pairs |\n|---|---|\n"
        f"| `kind` | {counts['kind']} |\n"
        f"| `facet` | {counts['facet']} |\n"
        f"| `internal` | {counts['internal']} |\n",
        "\n**The `kind` pairs** — one per Kind in GRAMMAR.md §2.1: "
        + ", ".join(f"`{pair}`" for pair in kinds)
        + "\n",
        "\n**The `facet` pairs** — reachable only as `X of (Kind …)`: "
        + ", ".join(f"`{pair}`" for pair in facets)
        + "\n",
    ]
    overrides = surfaces["overrides"]
    lines.append(
        f"\n### S1. Overrides ({len(overrides)})\n"
        "\nA manifest may override the rule's default and must then say why.\n"
    )
    lines.append("| pair | default | declared | why |\n|---|---|---|---|\n" + "".join(
        f"| `{row['pair']}` | `{row['default']}` | `{row['declared']}` | "
        f"{row['reason']} |\n"
        for row in overrides
    ))
    lines.append(
        "\n### S2. Kinds added by the declaration\n"
        "\nFive Kinds land in GRAMMAR.md §2.1 because a door declares their "
        "scope `kind`: `notebooks` (`core.collection` at the notes door, the "
        "door's own word — `create-notebook`, `library.notebooks`), `circles` "
        "(`social.circle` at tally), `projects` (`schedule.project` at tasks), "
        "`accounts` (`core.account` at tally) and `transactions` "
        "(`core.transaction` at tally). Each is served by the executor through "
        "that door's own read: the Tasks board's `projects`, the Notes "
        "library's `notebooks`, Tally's `GroupRow.circle_id` and its own "
        "`tally.matches.transactions` / `tally.matches.accounts` statements.\n"
        "\n**No corpus turn exercises any of the five.** They are grammar "
        "REACH, not evaluation cases: nothing was added to `suite.json`, "
        "`blind.json`, `holdout.json` or the training corpus for them, so a "
        "candidate is neither rewarded nor penalised for naming one today.\n"
    )
    return "".join(lines)


def role_section(derived) -> str:
    """What each registry entity IS, declared, and the shape check over it."""
    counts = derived["counts"]["entitiesByRole"]
    findings = derived["unanchored"]["pairs"]
    lines = [
        "\n---\n",
        "## R. Roles — what each entity IS\n",
        "Every one of the "
        f"{derived['counts']['entities']} registry entities declares a `role`. "
        "The shape of a table used to be the classifier — a `(X_type, X_id)` "
        "pair meant edge, an owned child with a label meant facet — and a "
        "classifier that reads column names cannot tell "
        "`social.contact_channel`, which People serves as a board, from "
        "`locker.item_field`, which is only ever reached through its item. The "
        "declaration is now the classifier and the shape is the CHECK: a "
        "declared edge whose table relates nothing fails the derivation, and so "
        "does a `thing` whose table anchors a polymorphic pair to "
        "`core_entity`.\n",
        "| role | entities | surface |\n|---|---|---|\n"
        f"| `thing` | {counts['thing']} | the kind/internal rule, unchanged |\n"
        f"| `edge` | {counts['edge']} | `internal` |\n"
        f"| `revision` | {counts['revision']} | `internal` |\n"
        f"| `vocabulary` | {counts['vocabulary']} | `internal` |\n"
        f"| `facet` | {counts['facet']} | `facet` |\n",
        "\n### R1. Unanchored polymorphic pairs ("
        f"{len(findings)})\n"
        "\nA `(X_type, X_id)` pair the DDL does NOT hold to `core_entity` with "
        "a composite foreign key: nothing constrains the id to a row that "
        "exists, or ever existed. "
        f"{derived['unanchored']['anchoredPairs']} other pairs ARE anchored, so "
        "this is a difference the schema makes deliberately somewhere and by "
        "omission elsewhere — and the derivation cannot tell which. **The DDL is "
        "not changed here.** `core_entity`'s own pair is a seventh and is "
        "excluded from the table: it is the anchor, and has nothing above it to "
        "point at.\n",
        "| table | entity | role | pair | reading |\n|---|---|---|---|---|\n"
        + "".join(
            f"| `{row['table']}` | "
            + (f"`{row['entity']}`" if row["entity"] else "— outside the 96 —")
            + " | "
            + (f"`{row['role']}`" if row["role"] else "—")
            + f" | `({row['pair'][0]}, {row['pair'][1]})` | {row['reading']} |\n"
            for row in findings
        ),
    ]
    return "".join(lines)


def egress_section(derived) -> str:
    """The declared egress of every command a structural signal raises."""
    egress = derived["egress"]
    declarations = egress["declarations"]
    lines = [
        "\n---\n",
        "## E. Egress — what leaves the vault\n",
        "`CommandDefinition` had `sealed_input`, `online_only`, `risk` and "
        "`confirm` and nothing that said an effect leaves the vault, so "
        "`exec.rs` carried a hand-written list of one name and missed "
        "`locker.export` — R-R2's own worked example. The registry now declares "
        "it (`DECLARED_EGRESS`), `derive_grammar.py` fails on a structural "
        "candidate nobody has ruled on, and `emit.py` generates the set into "
        "both parsers. `none` is a ruling and is written down like any other.\n",
        "\n**The refusal set** — `canon::egress_verbs()`: "
        + (", ".join(f"`{v}`" for v in egress["egressVerbs"]) or "_none_")
        + "\n",
        "\n| command | egress | why |\n|---|---|---|\n"
        + "".join(
            f"| `{name}` | `{spec['value']}` | {spec['why']} |\n"
            for name, spec in declarations.items()
        ),
    ]
    return "".join(lines)


def derived_field_section(derived) -> str:
    """Reader-computed Fields, as the apps declare them."""
    fields = derived.get("derivedFields", {})
    if not fields:
        return ""
    return "".join([
        "\n---\n",
        "## D. Reader-computed Fields, declared\n",
        "GRAMMAR.md §2.2 admits Fields an app's reader computes and hands back "
        "beside the row; they are in no column list, so the only statement that "
        "one existed was the grammar naming it. Each owning app now declares "
        "what computes the field and which tables that reader reads, and "
        "manifest validation refuses an input the app's own read scopes do not "
        "grant. `computedBy: —` is the product signal made explicit: the "
        "grammar states the Field, the corpus scores it, and nothing shipped "
        "produces it.\n",
        "\n| field | app | entity | computedBy | inputs |\n|---|---|---|---|---|\n"
        + "".join(
            f"| `{name}` | `{spec['door']}` | "
            + (f"`{spec['entity']}`" if spec.get("entity") else "—")
            + " | "
            + (f"`{spec['computedBy']}`" if spec.get("computedBy") else "**—**")
            + " | "
            + ", ".join(f"`{t}`" for t in spec.get("inputs", []))
            + " |\n"
            for name, spec in sorted(fields.items())
        ),
    ])


def main() -> int:
    derived = load("derived.json")
    all_turns = turns()
    nodes = index(all_turns)

    a_items: list[dict] = []
    b_items: list[dict] = []
    c_items: list[dict] = []

    # -- Kinds ---------------------------------------------------------------
    grammar_kinds = {
        name: pair for name, pair in check.KINDS.items() if name != "things"
    }
    derived_pairs = {(k["entity"], k["door"]) for k in derived["kinds"]}
    derived_by_pair = {(k["entity"], k["door"]): k for k in derived["kinds"]}
    entities = {k["entity"] for k in derived["kinds"]}

    for name, (entity, door) in sorted(grammar_kinds.items()):
        if (entity, door) in derived_pairs:
            continue
        if entity not in entities:
            c_or_b = "B"
            detail = (
                f"`{entity}` is not a logical entity in "
                "`contracts/schema/v0-registries.json` at all."
            )
        else:
            c_or_b = "B"
            doors_that_can = sorted(
                d for (e, d) in derived_pairs if e == entity
            )
            detail = (
                f"`{entity}` is an entity, but the **{door}** manifest grants "
                f"it no read scope. The doors that do: "
                + ", ".join(f"`{d}`" for d in doors_that_can)
                + "."
            )
        hits = used(nodes, lambda n, nm=name: n.get("node") == "kind" and n.get("kind") == nm)
        (b_items if c_or_b == "B" else c_items).append({
            "what": f"Kind `{name}` → ({entity}, {door})",
            "detail": detail,
            "turns": hits,
        })

    # Board-like kinds the ontology serves and the grammar never names.
    named_entities = {e for e, _ in grammar_kinds.values()}
    unnamed: dict[str, dict] = {}
    for kind in sorted(derived["kinds"], key=lambda k: (k["entity"], k["door"])):
        if kind["entity"] in named_entities or not kind["labelColumns"]:
            continue
        if kind["lifecycle"] not in {"mutable", "trash"}:
            continue
        row = unnamed.setdefault(kind["entity"], {"doors": [], "kind": kind})
        row["doors"].append(kind["door"])
    if unnamed:
        table = ["", "| entity | table | label column | doors that read it | lifecycle |",
                 "|---|---|---|---|---|"]
        for entity, row in sorted(unnamed.items()):
            k = row["kind"]
            table.append(
                f"| `{entity}` | `{k['table']}` | `{', '.join(k['labelColumns'])}` | "
                f"{', '.join(row['doors'])} | {k['lifecycle']} |"
            )
        a_items.append({
            "what": f"{len(unnamed)} boards the doors serve and the grammar names no Kind for",
            "detail": (
                "Each is life data (a non-machinery registry entity that is not a "
                "projection), has a single-column primary key, carries a human "
                "label column, and sits inside at least one door's declared READ "
                "scope. A member can see these rows in the app and cannot ask "
                "about them in canonical English. `core.vault` is the owner's own "
                "singleton and is the one row here that is arguably plumbing."
                + "\n".join(table)
            ),
            "turns": [],
        })

    # -- Fields ---------------------------------------------------------------
    grammar_fields = set(check.FIELDS)
    columns_by_entity: dict[str, set[str]] = {}
    for key, fields in derived["predicates"].items():
        entity = key.split("@", 1)[0]
        columns_by_entity.setdefault(entity, set()).update(fields)
    all_columns = set().union(*columns_by_entity.values()) if columns_by_entity else set()
    grammar_entities = {e for e, _ in grammar_kinds.values()}
    reachable_columns = set().union(
        *(columns_by_entity.get(e, set()) for e in grammar_entities)
    ) if grammar_entities else set()

    phantom = sorted(grammar_fields - all_columns)
    # A phantom Field is allowed by GRAMMAR.md §2.2 when an APP READER computes
    # it. That claim is checkable: grep the eight app crates for the name. The
    # ones no app crate mentions are computed by the harness's own executor and
    # by nothing the product ships, which is a different thing entirely.
    app_text = []
    for door in ("agenda", "docs", "locker", "notes", "people", "photos", "tally", "tasks"):
        base = os.path.join(ROOT, "crates", "apps", door)
        for folder, _dirs, files in os.walk(base):
            if "target" in folder:
                continue
            for name in files:
                if name.endswith((".rs", ".json")) and "tests" not in folder:
                    with open(os.path.join(folder, name), encoding="utf-8", errors="ignore") as h:
                        app_text.append(h.read())
    app_blob = "\n".join(app_text)
    declared_fields = derived.get("derivedFields", {})
    grounded, ungrounded = [], []
    for field in phantom:
        declaration = declared_fields.get(field)
        if declaration is not None:
            # DECLARED beats grepped: an app that says `computedBy: null` has
            # stated that nothing computes the field, and the name now appears
            # in its manifest — so the old grep would read the declaration of
            # the gap as proof the gap was closed.
            (grounded if declaration.get("computedBy") else ungrounded).append(field)
            continue
        # Match the bare identifier, not only a quoted string: a reader may
        # expose the fact as a Rust struct field (`photos::queries` does).
        hit = re.search(rf"\b{re.escape(field)}\b", app_blob) is not None
        (grounded if hit else ungrounded).append(field)
    if grounded:
        b_items.append({
            "what": f"{len(grounded)} reader-computed Fields — CLOSED, now checked",
            "detail": (
                "GRAMMAR.md §2.2 admits Fields an app's reader computes and named "
                "no file for any of them, so there was nothing to check the list "
                "against and nothing that went red when a reader dropped one. Each "
                "of these now declares its source in `derive/terminals.json` and "
                "`emit.py` refuses one no file under `crates/apps/*/src` and no app "
                "manifest mentions: "
                + ", ".join(f"`{f}`" for f in grounded)
                + ". Listed so the closure is visible; the four below are the ones "
                "still open."
            ),
            "turns": sorted({t for f in grounded
                             for t in used(nodes, lambda n, ff=f: n.get("field") == ff)}),
        })
    for field in ungrounded:
        hits = used(nodes, lambda n, f=field: n.get("field") == f)
        b_items.append({
            "what": f"Field `{field}` is computed by nothing the product ships",
            "detail": (
                "no column of that name in `contracts/schema/vault-ddl.sql`. "
                + (
                    "`"
                    + declared_fields[field]["door"]
                    + "` now DECLARES it under `derivedFields` with `computedBy: "
                    "null` and the note: "
                    + declared_fields[field].get("gap", "")
                    if field in declared_fields
                    else "No file under `crates/apps/*/src` or any app manifest "
                    "names it, and no app declares it under `derivedFields`."
                )
                + " It exists in `crates/candidates/src/exec.rs` and in the eval "
                "harness's reference readers and nowhere else, so the grammar "
                "states a Field whose only implementation is the thing being "
                "evaluated. The gap is unchanged; what changed is that the "
                "product now says so where a reader would look."
            ),
            "turns": hits,
        })

    missing_fields = sorted(reachable_columns - grammar_fields)
    if missing_fields:
        a_items.append({
            "what": f"{len(missing_fields)} columns on kinds the grammar already names",
            "detail": (
                "columns of the base tables behind the grammar's own Kinds that "
                "no canonical can name: "
                + ", ".join(f"`{f}`" for f in missing_fields[:40])
                + (" …" if len(missing_fields) > 40 else "")
            ),
            "turns": [],
        })

    # -- Enum values: the enumeration check ----------------------------------
    # Every literal a canonical compares against an enum column must be one of
    # that column's CHECK values. A literal outside the set is a canonical the
    # vault cannot match — it would silently return nothing.
    enum_values: dict[str, set[str]] = {}
    for key, fields in derived["predicates"].items():
        for field, spec in fields.items():
            if spec.get("checkValues"):
                enum_values.setdefault(field, set()).update(spec["checkValues"])
    offenders: dict[tuple[str, str], list[str]] = {}
    for turn in all_turns:
        flat = []
        walk(turn.get("tree"), flat)
        for node in flat:
            field = node.get("field")
            value = node.get("value")
            if field in enum_values and isinstance(value, str) and node.get("node") in {"cmp", "compare", "pred", "in"}:
                if value not in enum_values[field]:
                    offenders.setdefault((field, value), []).append(turn_id(turn))
            if field in enum_values and node.get("node") == "in":
                for v in node.get("values", []):
                    if isinstance(v, str) and v not in enum_values[field]:
                        offenders.setdefault((field, v), []).append(turn_id(turn))
    for (field, value), hits in sorted(offenders.items()):
        b_items.append({
            "what": f"`{field} = \"{value}\"`",
            "detail": (
                f"`{field}`'s CHECK admits only "
                + ", ".join(f"`{v}`" for v in sorted(enum_values[field]))
                + ". A canonical comparing it to anything else matches no row."
            ),
            "turns": sorted(set(hits)),
        })

    # Enum values the ontology declares and no canonical or lexicon knows.
    # Reported as a single A row: they are the grammar's unused vocabulary.
    a_items.append({
        "what": "the CHECK value sets as an `in (…)` domain",
        "detail": (
            f"{len(enum_values)} enum columns on the grammar's own Kinds carry a "
            "`CHECK (col IN (…))`, so `in (…)` has an exactly-enumerable domain "
            "per column. `check.py` validates no literal against it — any string "
            "parses — so a canonical may name a value the column forbids and "
            "nothing says so. The check is free and is implemented in this diff."
        ),
        "turns": [],
    })

    # -- Verbs ----------------------------------------------------------------
    registry = {v["name"] for v in derived["verbs"]}
    grammar_verbs = set(check.COMMANDS)
    not_commands = sorted(grammar_verbs - registry)
    if not_commands:
        hits = used(nodes, lambda n: n.get("verb") in set(not_commands))
        b_items.append({
            "what": f"{len(not_commands)} `Verb` terminals that are not commands",
            "detail": (
                "`check.py`'s `load_commands()` scrapes every quoted "
                "`schema.name` string out of `crates/vault/src/commands/*.rs`, "
                "which cannot tell a command name from an `object_type`. The "
                "registry has **"
                f"{len(registry)}** commands; the lexicon has **{len(grammar_verbs)}**. "
                "The surplus are ENTITY TYPES and two v0 names this build does not "
                "register: "
                + ", ".join(f"`{n}`" for n in not_commands)
                + ". GRAMMAR.md §2.7's \"175 `CommandDefinition`s\" is the same "
                "miscount."
            ),
            "turns": hits,
        })
    missing_verbs = sorted(registry - grammar_verbs)
    if missing_verbs:
        a_items.append({
            "what": f"{len(missing_verbs)} registered commands absent from the lexicon",
            "detail": ", ".join(f"`{n}`" for n in missing_verbs),
            "turns": [],
        })

    # -- Verb classes ---------------------------------------------------------
    hand_classes = check.VERB_CLASSES
    for cls, members in sorted(derived["verbClasses"].items()):
        if cls not in hand_classes:
            a_items.append({
                "what": f"verb class `{cls}`",
                "detail": (
                    f"{len(members)} commands share the effect `{cls}` across "
                    f"{len(members)} subject kinds — "
                    + ", ".join(f"`{e}`→`{c}`" for e, c in sorted(members.items()))
                    + " — which is exactly the grouping GRAMMAR.md §2.7 derives "
                    "`delete` and `reschedule` by. The grammar has no such class, "
                    "so the effect can only be said once the Kind is already known."
                ),
                "turns": [],
            })
            continue
        hand = hand_classes[cls]
        for entity, command in sorted(members.items()):
            if entity not in hand:
                a_items.append({
                    "what": f"`{cls}` over `{entity}`",
                    "detail": f"the registry holds `{command}`; the class does not list this subject.",
                    "turns": [],
                })
        for entity, command in sorted(hand.items()):
            if entity not in members:
                if command in registry:
                    c_items.append({
                        "what": f"`{cls}` over `{entity}` → `{command}`",
                        "detail": (
                            "the command is registered, but its input schema's "
                            "subject argument names a different entity, so the "
                            "derivation files it under that one. "
                            + (
                                "`media.delete_asset` takes an `asset_id`: its "
                                "subject is `media.asset`, and `core.content_item` "
                                "is the entity the asset hangs off."
                                if command == "media.delete_asset" else
                                "The two spellings denote the same effect."
                            )
                        ),
                        "turns": [],
                    })
                else:
                    b_items.append({
                        "what": f"`{cls}` over `{entity}` → `{command}`",
                        "detail": "no command of that name is registered.",
                        "turns": [],
                    })

    # -- Links ----------------------------------------------------------------
    edges = {(l["from"]["entity"], l["to"]["entity"]) for l in derived["links"]}
    walk_hits: dict[tuple[str, str], list[str]] = {}
    for turn in all_turns:
        flat = []
        walk(turn.get("tree"), flat)
        for node in flat:
            if node.get("node") != "walk":
                continue
            kind = node.get("kind")
            outer = kind.get("entity") if isinstance(kind, dict) else None
            inner_nodes: list = []
            walk(node.get("from"), inner_nodes)
            inner = next(
                (n.get("entity") for n in inner_nodes
                 if n.get("node") == "kind" and n.get("entity")),
                None,
            )
            if outer and inner:
                walk_hits.setdefault((inner, outer), []).append(turn_id(turn))
    unsupported = {
        pair: hits for pair, hits in walk_hits.items()
        if pair not in edges and pair[0] != pair[1] and "*" not in pair
    }
    poly_edges = {
        (l["from"]["entity"], l["to"]["entity"]): l["via"]
        for l in derived["polymorphicLinks"]
    }
    table_of = {k["entity"]: k["table"] for k in derived["kinds"]}
    # The grammar spells the albums board `media.album`, which is not a
    # registry entity (section C). Reconciling it here keeps the walk rows
    # about the WALK rather than repeating the naming finding four times.
    table_of.setdefault("media.album", "core_collection")
    ALIAS = {"media.album": "core.collection"}
    for (inner, outer), hits in sorted(unsupported.items()):
        paths = derived["fkPaths"].get(
            f"{table_of.get(inner)}->{table_of.get(outer)}", []
        )
        paths = sorted(paths, key=len)
        path = paths[0] if paths else None
        if path and len(path) > 1:
            b_items.append({
                "what": f"walk `{outer} of ({inner} …)` is {len(path)} hops, not one",
                "detail": (
                    "§2.3 derives a walk from ONE foreign key read either way. "
                    "The foreign-key paths between these two base tables, "
                    "shortest first: "
                    + "; ".join(
                        "`" + "` → `".join([table_of.get(inner, inner)] + p) + "`"
                        for p in paths[:3]
                    )
                    + ". Which one the walk MEANS is a judgement nothing in the "
                    "schema records"
                    + (
                        " — `tally_group` → `social_circle` reaches the circle's "
                        "OWNER and `→ social_circle_member` reaches its members, "
                        "and only the second is what a member means by \"who's in "
                        "the group\""
                        if inner == "tally.group" else ""
                    )
                    + ". The door can serve it; what the "
                    "grammar's stated derivation rule produces is not this walk. "
                    "Either §2.3 admits multi-hop walks and says how many, or the "
                    "intermediate table is itself a Kind and the canonical says "
                    "both hops."
                ),
                "turns": sorted(set(hits)),
            })
        elif (ALIAS.get(inner, inner), ALIAS.get(outer, outer)) in poly_edges:
            b_items.append({
                "what": f"walk `{outer} of ({inner} …)` has no foreign key at all",
                "detail": (
                    "the only thing relating these two base tables is "
                    f"`{poly_edges[(ALIAS.get(inner, inner), ALIAS.get(outer, outer))]}` — a `(type, id)` PAIR, not a "
                    "foreign key. §2.3 says walks come \"from the foreign keys, "
                    "not from a second list\" and names "
                    "`core_collection_entry` as a join table; it is not one. "
                    "Nothing in the schema constrains `target_id` to a live row "
                    "of `target_type`, so the walk is servable only because the "
                    "app's reader knows which type to filter on — which is "
                    "precisely the second list §2.3 says it does not have."
                ),
                "turns": sorted(set(hits)),
            })
        else:
            b_items.append({
                "what": f"walk `{outer} of ({inner} …)`",
                "detail": (
                    "no foreign key, no join table and no polymorphic pair in "
                    "`contracts/schema/vault-ddl.sql` relates the two base "
                    "tables, so §2.3's own rule makes this a `clarify` (R-C4) "
                    "rather than a walk."
                ),
                "turns": sorted(set(hits)),
            })

    grammar_entity_pairs = {
        (a, b) for a in grammar_entities for b in grammar_entities if a != b
    }
    unused_edges = sorted(
        (a, b) for (a, b) in edges & grammar_entity_pairs
        if (a, b) not in walk_hits
    )
    a_items.append({
        "what": f"{len(unused_edges)} link walks between the grammar's own Kinds that no canonical uses",
        "detail": (
            "the DDL relates these base tables, so §2.3 already makes each one "
            "legal; none is exercised, which is corpus coverage rather than a "
            "grammar gap. Sample: "
            + ", ".join(f"`{b} of ({a})`" for a, b in unused_edges[:12])
            + (" …" if len(unused_edges) > 12 else "")
        ),
        "turns": [],
    })

    # -- Search domains vs `called` ------------------------------------------
    domain_entities = {d["entity"] for d in derived["searchDomains"]}
    no_domain = sorted(grammar_entities - domain_entities)
    a_items.append({
        "what": "`called` over the kinds with no FTS domain",
        "detail": (
            "GRAMMAR.md §4 says `called` falls back to a board scan where the "
            "Kind has no domain. The kinds that take that path: "
            + ", ".join(f"`{e}`" for e in no_domain)
            + ". The ontology supports it (each has a label column); it is worth "
            "stating that the FALLBACK, not the plane, is what answers there."
        ),
        "turns": [],
    })

    # -- Egress and party-subject --------------------------------------------
    exec_path = os.path.join(ROOT, "crates", "candidates", "src", "exec.rs")
    with open(exec_path, encoding="utf-8") as handle:
        exec_text = handle.read()
    hand_egress = re.findall(r'EGRESS_VERBS: \[&str; \d+\] = \[([^\]]*)\]', exec_text)
    hand_egress = re.findall(r'"([^"]+)"', hand_egress[0]) if hand_egress else []
    hand_party = re.findall(r'PARTY_SUBJECT: \[&str; \d+\] = \[([^\]]*)\]', exec_text, re.S)
    hand_party = re.findall(r'"([^"]+)"', hand_party[0]) if hand_party else []

    egress_candidates = [c["name"] for c in derived["egress"]["candidates"]]
    if not derived["egress"]["derivable"]:
        a_items.append({
            "what": "EGRESS is not derivable — `exec.rs`'s one-name list is a judgement, not a projection",
            "detail": (
                f"`EGRESS_VERBS` holds {hand_egress}. The registry declares no "
                "egress, and all eight app manifests declare the same "
                "`actionSideEffect: \"vault-write\"`. The structural signals that "
                f"DO exist name {len(egress_candidates)} candidates: "
                + ", ".join(f"`{n}`" for n in egress_candidates)
                + "."
            ),
            "turns": [],
        })
    elif hand_egress:
        a_items.append({
            "what": "`exec.rs` still holds a hand-written `EGRESS_VERBS`",
            "detail": (
                f"the registry declares egress and the derivation serves it, and "
                f"`exec.rs` carries its own copy anyway: {hand_egress}. Two lists, "
                "one of which is not checked."
            ),
            "turns": [],
        })

    derived_party = set(derived["partySubjectVerbs"])
    missing_party = sorted(derived_party - set(hand_party))
    extra_party = sorted(set(hand_party) - derived_party)
    a_items.append({
        "what": f"{len(missing_party)} party-subject verbs the schema derives and `exec.rs` does not list",
        "detail": (
            "A command whose input schema's ONLY foreign-key argument is a party "
            "has exactly one party subject — that is the schema saying R-C1 "
            "applies. The derivation finds "
            + ", ".join(f"`{n}`" for n in missing_party)
            + ". Each would clarify over several rows called the same name, and "
            "today does not."
        ),
        "turns": [],
    })
    for name in extra_party:
        b_items.append({
            "what": f"`PARTY_SUBJECT` names `{name}`",
            "detail": (
                "its input schema carries more than one foreign-key argument, so "
                "its subject is not one party by the schema's own shape. "
                + (
                    "`tally.add_group_member` takes a `group_id` AND a "
                    "`party_id`: the rule that fires on it is real, but the list "
                    "is the thing carrying it, not the schema."
                    if name == "tally.add_group_member" else ""
                )
            ),
            "turns": [],
        })

    # -- C: naming ------------------------------------------------------------
    c_items.append({
        "what": "`media.album` (GRAMMAR.md §2.1) vs `core.collection` (the registry)",
        "detail": (
            "the grammar's `albums` Kind is written `media.album`, and no entity "
            "of that name exists. The base table GRAMMAR.md itself names — "
            "`core_collection` — belongs to `core.collection`, which the photos "
            "door does read. Same board, two spellings; the stored trees carry "
            "the spelling that is not the ontology's."
        ),
        "turns": used(nodes, lambda n: n.get("entity") == "media.album"),
    })
    c_items.append({
        "what": "`core.content_item` (GRAMMAR.md `photos`) vs `media.asset`",
        "detail": (
            "GRAMMAR.md §2.1 already says the `photos` Kind is "
            "`core_content_item`+`media_asset`. Both entities exist and the "
            "photos door reads both; the grammar names the first and the delete "
            "command takes the second's id."
        ),
        "turns": [],
    })

    # -- Render ---------------------------------------------------------------
    lines = []
    lines.append("# The derived grammar, diffed against the written one\n")
    lines.append(
        "GENERATED — `python3 derive/derive_grammar.py && python3 derive/diff.py`.\n"
    )
    lines.append(
        "`derive/derived.json` is the terminal set the ontology supports, walked "
        "out of the DDL, the registries, the eight app manifests, the search "
        "domains and the typed command registry. This diffs it against "
        "`check.py`'s lexicons — the grammar AS EXECUTED, since `check.py` "
        "generated every tree in `map.json`.\n"
    )
    lines.append(
        f"**A: {len(a_items)} · B: {len(b_items)} · C: {len(c_items)}**\n"
    )
    lines.append(
        "| | |\n|---|---|\n"
        f"| entities in the registry | {derived['counts']['entities']} |\n"
        f"| (entity, door) kinds the doors serve | {derived['counts']['kinds']} |\n"
        f"| Kinds the grammar names | {len(grammar_kinds)} + `things` |\n"
        f"| registered commands | {derived['counts']['commands']} |\n"
        f"| Verb terminals the grammar admits | {len(grammar_verbs)} |\n"
        f"| link walks derived | {derived['counts']['links']} |\n"
        "| commands whose effect the ontology states | "
        f"{derived['counts']['commandsWithAClassifiedEffect']}"
        f" / {derived['counts']['commands']} "
        f"({derived['counts']['verbClassDerivability']:.0%}) |\n"
        f"| of those, DECLARED rather than read off the SQL | "
        f"{derived['counts']['declaredEffects']} |\n"
        f"| commands whose effect leaves the vault | {derived['counts']['egressVerbs']} |\n"
        f"| reader-computed Fields declared | {derived['counts']['derivedFields']} |\n"
    )

    lines.append(role_section(derived))
    lines.append(surface_section(derived))
    lines.append(egress_section(derived))
    lines.append(derived_field_section(derived))

    for letter, title, items in (
        ("A", "The ontology supports it, the grammar lacks it", a_items),
        ("B", "The grammar claims it, the ontology or the doors cannot serve it", b_items),
        ("C", "Naming-only", c_items),
    ):
        lines.append(f"\n---\n\n## {letter}. {title}\n")
        if not items:
            lines.append("_Nothing._\n")
        for n, item in enumerate(items, 1):
            lines.append(f"### {letter}{n}. {item['what']}\n")
            lines.append(item["detail"] + "\n")
            lines.append(f"**Turns affected:** {fmt(item['turns'])}\n")

    out = os.path.join(GRAMMAR_DIR, "DIFF.md")
    with open(out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print(f"wrote {out}")
    print(f"A={len(a_items)} B={len(b_items)} C={len(c_items)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
