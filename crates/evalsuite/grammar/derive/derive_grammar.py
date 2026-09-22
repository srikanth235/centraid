#!/usr/bin/env python3
"""Derive the canonical grammar's TERMINALS from the ontology, mechanically.

`GRAMMAR.md` was written BY HAND from the ontology. A hand transcription can
miss a construct the vault serves and can invent one it does not, and neither
failure shows up in a test: the corpus only exercises what somebody thought to
write. So this walks the ontology itself and emits `derived.json` — the
terminal sets the vault can actually support — and `diff.py` compares the two.

## What it reads, and in what form

| source | form | what is taken from it |
|---|---|---|
| `contracts/schema/vault-ddl.sql` | SQLite DDL, generated from the golden vault's `sqlite_master` | columns, declared types, `CHECK (col IN (…))` value sets, foreign keys, primary keys |
| `contracts/schema/v0-registries.json` | JSON, the frozen registry transcription | entities (logical name, table, lifecycle, `projectionOf`), sealed columns |
| `crates/apps/*/manifest.json` | JSON, one per app door | each door's READ scopes — which entity a door may hand back — and its `actionSideEffect` |
| `crates/search/src/domains.rs` | Rust | the seven FTS domains and their label columns |
| `crates/vault/src/commands/*.rs` | Rust | the 148 `CommandDefinition`s: name, input schema, gates, handler SQL |

Only the last is parsed out of Rust, and only because the registry has no
machine-readable manifest. Everything else is already a contract file.

## What CANNOT be derived, and is reported instead of guessed

* **Kind NAMES.** The ontology holds `core.event`, never "events". The
  plural a member would use is a product decision; this emits the structure
  (entity, door) and leaves the naming to the diff's section C.
* **Egress.** No `CommandDefinition` field says "this leaves the vault". The
  closest declarations are `online_only`, `risk`, `confirm` and the app
  manifests' `actionSideEffect`. See `egress` in the output.
* **Reader-computed Fields.** `favorite`, `album_titles`, `owed_to_them` and
  the rest are computed by an app's reader and appear in no column list.

Run: `python3 derive_grammar.py` (writes `derived.json` beside this file).
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))

sys.path.insert(0, HERE)

import commands as commands_mod  # noqa: E402
import ddl as ddl_mod  # noqa: E402

DOORS = ("agenda", "docs", "locker", "notes", "people", "photos", "tally", "tasks")

# Columns every table carries for the machinery's sake. They are Fields in the
# grammar's sense (a member can ask "when did I make it") but they are not what
# makes an entity a board, so the Kind heuristic ignores them.
HOUSEKEEPING = {
    "created_at", "updated_at", "deleted_at", "purge_at", "row_version",
}

DATE_HINTS = re.compile(
    r"(_at|_on|^dtstart$|^dtend$|_date$|^birth_date$|^month_day$|valid_from|valid_to)"
)
MONEY_HINTS = re.compile(r"(amount|_minor$|balance)")


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def load_registries() -> dict:
    with open(os.path.join(ROOT, "contracts", "schema", "v0-registries.json"), encoding="utf-8") as h:
        return json.load(h)


def load_tables() -> dict:
    with open(os.path.join(ROOT, "contracts", "schema", "vault-ddl.sql"), encoding="utf-8") as h:
        return ddl_mod.parse_tables(h.read())


def load_manifests() -> dict:
    out = {}
    for door in DOORS:
        path = os.path.join(ROOT, "crates", "apps", door, "manifest.json")
        with open(path, encoding="utf-8") as h:
            out[door] = json.load(h)
    return out


def load_search_domains() -> list[dict]:
    """The seven FTS domains, read out of `crates/search/src/domains.rs`."""
    path = os.path.join(ROOT, "crates", "search", "src", "domains.rs")
    with open(path, encoding="utf-8") as h:
        text = h.read()
    domains = []
    for block in re.finditer(r"Domain\s*\{(.*?)\n    \}", text, re.S):
        body = block.group(1)
        def field(name):
            m = re.search(rf'{name}:\s*"([^"]*)"', body)
            return m.group(1) if m else None
        def list_field(name):
            m = re.search(rf'{name}:\s*&\[([^\]]*)\]', body)
            return re.findall(r'"([^"]+)"', m.group(1)) if m else []
        if field("entity") is None:
            continue
        domains.append({
            "app": field("app_id"),
            "entity": field("entity"),
            "table": field("table"),
            "idColumn": field("id_column"),
            "labels": list_field("labels"),
        })
    return domains


# ---------------------------------------------------------------------------
# Kinds
# ---------------------------------------------------------------------------

def door_read_scopes(manifest: dict) -> tuple[set[str], set[str]]:
    """(entities read by name, schemas read wholesale) for one door."""
    named, wide = set(), set()
    for scope in manifest.get("vault", {}).get("scopes", []):
        if "read" not in scope.get("verbs", ""):
            continue
        if "table" in scope:
            named.add(f"{scope['schema']}.{scope['table']}")
        else:
            wide.add(scope["schema"])
    return named, wide


def derive_kinds(registries, tables, manifests) -> list[dict]:
    """A Kind is (entity, door): a board a door may hand back.

    The three conditions are all the ontology's own:

    1. the entity is LIFE DATA — a registry row whose lifecycle is not
       `machinery`;
    2. it is not a PROJECTION of another entity (`projectionOf` is null) and
       its table has a single-column primary key, so a row of it is a thing a
       member can point at rather than an edge or a shard;
    3. the door's manifest grants a READ scope over it, by name or through a
       whole-schema scope.
    """
    entities = {e["logical"]: e for e in registries["entities"]}
    scopes = {door: door_read_scopes(m) for door, m in manifests.items()}
    kinds = []
    for logical, entity in sorted(entities.items()):
        if entity["lifecycle"] == "machinery" or entity["projectionOf"]:
            continue
        table = tables.get(entity["table"])
        if table is None or len(table.primary_key) != 1:
            continue
        schema = logical.split(".", 1)[0]
        for door in DOORS:
            named, wide = scopes[door]
            if logical in named:
                grant = "named scope"
            elif schema in wide:
                grant = f"whole-schema scope on `{schema}`"
            else:
                continue
            kinds.append({
                "entity": logical,
                "door": door,
                "table": entity["table"],
                "lifecycle": entity["lifecycle"],
                "idColumn": table.primary_key[0],
                "grant": grant,
                "trashable": "deleted_at" in table.columns,
                "labelColumns": label_columns(table),
            })
    return kinds


# A board is a set of rows a member can NAME. The signal is a human label
# column: a required TEXT column that is not an id, not an enum, not a date
# and not a foreign key. `core_event.summary` and `tally_group.name` have one;
# `core_concept_scheme` and `core_collection_entry` do not, which is why the
# first pair are boards and the second pair are plumbing a door joins through.
LABEL_NAMES = ("title", "summary", "name", "display_name", "label",
               "description", "nickname", "value")


def label_columns(table) -> list[str]:
    found = []
    for column in table.columns.values():
        if column.name in LABEL_NAMES and column.type == "TEXT" \
                and not column.references and not column.check_values:
            found.append(column.name)
    return found


# ---------------------------------------------------------------------------
# Surfaces — what a member can NAME
# ---------------------------------------------------------------------------
#
# The 119 (entity, door) pairs above are what the DOORS serve, not what a
# member sees. Most of them are plumbing: a door reads `core_link` so it can
# show a backlink, not so anyone can say "show me my links". Which of them a
# member can name is a PRODUCT decision, so it is DECLARED — `surface` on every
# read scope in `crates/apps/*/manifest.json` — and this computes the DEFAULT
# the declaration is measured against. A scope that overrides the default
# carries a one-line `surfaceReason`; a scope that does not declare at all is a
# refusal here and in `crates/apps/kit/src/manifest.rs`.
#
#   `kind`     a member names it as a thing and asks for the board.
#   `facet`    a row that only exists inside a parent kind, reachable as
#              `X of (Kind …)` and never as a bare board.
#   `internal` everything else — edges, revisions, representations, the rows a
#              door joins through.

SURFACES = ("kind", "facet", "internal")

# THE FIVE ROLES, declared on every registry entity.
#
# What a row IS used to be guessed from the shape of its table: a polymorphic
# `(X_type, X_id)` pair meant "edge", an owned child with a label meant
# "facet". A guess from a shape is a guess — `core_concept` has neither mark
# and is not a board either, and `social_contact_channel` has both marks of a
# facet and IS a board — so the registry now declares it and the shape test
# below became the CHECK rather than the classifier.
ROLES = ("thing", "edge", "revision", "vocabulary", "facet")

# The roles that are never a board and never a facet: an edge relates two rows,
# a revision holds a row's prior state, a vocabulary term is named THROUGH the
# rows that carry it (`tagged X`), and none of the three is a thing a member
# asks for.
ROLES_INTERNAL = ("edge", "revision", "vocabulary")

# The anchor every polymorphic pair is supposed to point into: the identity
# spine. A pair with a composite foreign key onto it cannot name a row that was
# never there; a pair without one can name anything at all.
ANCHOR_TABLE = "core_entity"


def polymorphic_pairs(table) -> list[tuple[str, str]]:
    """Every `(X_type, X_id)` pair the table carries, found by shape."""
    names = set(table.columns)
    return sorted(
        (column, column[:-5] + "_id")
        for column in names
        if column.endswith("_type") and column[:-5] + "_id" in names
    )


def anchored_pairs(table) -> set[tuple[str, str]]:
    """The pairs held to `core_entity` by a composite foreign key."""
    return {
        tuple(columns)
        for columns, parent, _ in table.foreign_keys
        if parent == ANCHOR_TABLE and len(columns) == 2
    }


def owning_parents(entity, table, registries_by_logical, logical_of_table) -> list[str]:
    """Parent entities this row cannot outlive.

    Two statements of the same fact, and both are the ontology's own: a NOT
    NULL foreign key declared `ON DELETE CASCADE`, or a `deletionRoles` entry
    whose role is `owned-child`. `locker_item_field` and
    `tally_expense_line_item` say it in the DDL; `core_party_identifier` and
    `social_contact_channel` say it in the registry.
    """
    owned = {
        role["column"]
        for role in registries_by_logical[entity]["deletionRoles"]
        if role["role"] == "owned-child"
    }
    parents = []
    for column in table.columns.values():
        if not column.references or column.references[0] == "core_entity":
            continue
        if not column.not_null:
            continue
        if column.on_delete != "CASCADE" and column.name not in owned:
            continue
        parent = logical_of_table.get(column.references[0])
        if parent and parent != entity:
            parents.append(parent)
    return sorted(set(parents))


def create_targets(verbs, logical_of_table) -> dict[str, list[str]]:
    """entity -> the `create`-effect commands whose `writes` name its table.

    `writes` and not `subjectEntity`: `people.log_interaction` takes a party
    and INSERTS a `core_activity`, so the activity is never anybody's declared
    subject — and an activity is exactly a thing a member names ("what did I do
    with Priya"). Reading the writes is what finds it.
    """
    out: dict[str, list[str]] = {}
    for verb in verbs:
        if verb["effect"] != "create":
            continue
        for table in verb["writes"]:
            logical = logical_of_table.get(table)
            if logical:
                out.setdefault(logical, []).append(verb["name"])
    return {k: sorted(set(v)) for k, v in out.items()}


def home_doors(entity, creators, domains, manifests) -> list[str]:
    """The doors that OWN the entity, as opposed to joining through it.

    Every door in the 119 can read `core_party`; only People and Tally can mint
    one, and only those two serve it as a board ("parties", "members"). So a
    door is a home door when it holds the `act` scope for a command that
    creates the entity, or when it is the entity's own search domain.
    """
    doors = {d["app"] for d in domains if d["entity"] == entity}
    for door, manifest in manifests.items():
        granted = set()
        for scope in manifest.get("vault", {}).get("scopes", []):
            if "act" not in scope.get("verbs", ""):
                continue
            granted.add(
                f"{scope['schema']}.{scope['table']}" if "table" in scope
                else f"{scope['schema']}.*"
            )
        for command in creators.get(entity, ()):
            schema = command.split(".", 1)[0]
            if command in granted or f"{schema}.*" in granted:
                doors.add(door)
    return sorted(doors)


def default_surfaces(registries, tables, manifests, kinds, domains, verbs) -> dict:
    """The DEFAULT `surface` of every (entity, door) pair, from the rule.

    THE ROLE IS READ FIRST, because what a row IS is the registry's to say and
    not a parser's to infer from column names:

    * `edge`, `revision`, `vocabulary` -> `internal`. None of the three is a
      thing a member asks for.
    * `facet` -> `facet`. A facet is now DECLARED; the old test (an owned child
      carrying a label) could not tell `social.contact_channel`, which People
      serves as its own board, from `locker.item_field`, which is only ever
      reached through its item.
    * `thing` -> the rule that was always there:

      1. `kind` when the entity is TRASHABLE (registry lifecycle `trash`) or is
         a SEARCH DOMAIN — two ways of saying a member is expected to go
         looking for one by name;
      2. `kind` when some command CREATES it;
      3. `internal` otherwise.

    Then the door: a `kind` entity is a `kind` only at its HOME doors; at every
    other door it is a join, so `internal`. `facet` and `internal` do not vary
    by door — a facet is reached through its parent whichever door serves it.
    """
    by_logical = {e["logical"]: e for e in registries["entities"]}
    logical_of_table = {e["table"]: e["logical"] for e in registries["entities"]}
    searchable = {d["entity"] for d in domains}
    creators = create_targets(verbs, logical_of_table)
    entities = sorted({k["entity"] for k in kinds})
    roles = {e: by_logical[e]["role"] for e in entities}

    things = [e for e in entities if roles[e] == "thing"]
    facets = {e for e in entities if roles[e] == "facet"}
    base = {
        e for e in things
        if by_logical[e]["lifecycle"] == "trash" or e in searchable
    }
    kinds_by_entity = base | {e for e in things if e in creators}
    entity_surface: dict[str, str] = {}
    for entity in entities:
        entity_surface[entity] = (
            "kind" if entity in kinds_by_entity
            else "facet" if entity in facets
            else "internal"
        )

    out = {}
    for entity in entities:
        homes = home_doors(entity, creators, domains, manifests)
        for kind in kinds:
            if kind["entity"] != entity:
                continue
            value = entity_surface[entity]
            why = []
            if by_logical[entity]["lifecycle"] == "trash":
                why.append("trashable")
            if entity in searchable:
                why.append("search domain")
            if entity in creators:
                why.append(f"created by {', '.join(creators[entity])}")
            if entity in facets:
                parents = owning_parents(
                    entity, tables[by_logical[entity]["table"]],
                    by_logical, logical_of_table,
                )
                why = [
                    "declared `role: facet`"
                    + (", owned child of " + ", ".join(parents) if parents else "")
                ]
            if roles[entity] in ROLES_INTERNAL:
                why = [f"declared `role: {roles[entity]}`, not a row a member names"]
            if value == "kind" and kind["door"] not in homes:
                value = "internal"
                why.append(
                    f"but `{kind['door']}` only joins through it — home doors: "
                    + (", ".join(homes) or "none")
                )
            out[f"{entity}@{kind['door']}"] = {
                "default": value,
                "entityDefault": entity_surface[entity],
                "homeDoors": homes,
                "why": "; ".join(why) or "no signal",
            }
    return out


# A reading of each pair the DDL leaves unanchored. The derivation cannot tell
# a receipt that MUST outlive its object from a pointer nothing maintains, so
# it states what it found and whose call it is. Do not change the DDL from
# here; these are findings.
UNANCHORED_READINGS = {
    "access_provenance": (
        "deliberate — provenance says where a row CAME FROM, and a purge that "
        "erased the record of the import would erase the only answer to `why "
        "is this here`. It is also outside the 96, so no role carries it."
    ),
    "access_receipt": (
        "deliberate — the receipt plane is append-only and hash-chained by "
        "`seq`. A receipt that vanished with its object is not a receipt "
        "(D-1020-L3 says so for the Locker reveal in as many words)."
    ),
    "access_seed_row": (
        "gap — a seed row names a planted row and nothing keeps the two in "
        "step, so a purged fixture leaves a seed row pointing at an id that "
        "was never reissued. Low stakes, machinery only; an anchor with "
        "`ON DELETE CASCADE` is what the other thirteen edges have."
    ),
    "agent_evidence": (
        "deliberate — evidence is what an agent CITED at the time, and it has "
        "to read back after the cited row is gone or the audit answers nothing."
    ),
    "core_entity": (
        "not a finding — `core_entity` IS the anchor. Its own (entity_type, "
        "entity_id) is the spine's key, and there is nothing above it to "
        "point at."
    ),
    "core_entity_revision": (
        "split — deliberate against TRASH (an undo must read the prior state "
        "of a row that is in the bin), a gap against PURGE: nothing prunes a "
        "revision when its entity is purged, so `tally.undo_expense` can be "
        "offered a revision of a row that no longer exists in any sense. The "
        "owner's call is whether purge should cascade here."
    ),
    "share_authority": (
        "gap, and the sharpest of the seven — an authority is a live "
        "capability, and `(subject_type, subject_id)` unanchored means a grant "
        "can outlive its subject and be served against an id the vault has "
        "since reissued to something else."
    ),
}


def check_roles(registries, tables) -> tuple[list[str], list[dict]]:
    """Hold the declared `role` and the table's SHAPE to each other.

    Two directions, and they are not the same statement:

    1. every `role: edge` and `role: revision` entity's table must CARRY a
       polymorphic pair — a declared edge with nothing to relate is a
       mis-declaration, and it fails the derivation;
    2. every ANCHORED pair — one held to `core_entity` by a composite foreign
       key — must sit on an edge or a revision, because a row a member names
       does not point polymorphically at another one. That fails too.

    What does NOT fail is an edge whose pair is UNANCHORED. Seven of those
    exist, the DDL is not this lane's to change, and the two honest readings —
    a receipt that must outlive its object, versus a pointer at a row that is
    gone — are a product ruling. They come back as findings.
    """
    logical_of_table = {e["table"]: e["logical"] for e in registries["entities"]}
    violations: list[str] = []
    findings: list[dict] = []
    anchored_total = 0
    for entity in registries["entities"]:
        role = entity["role"]
        table = tables.get(entity["table"])
        if table is None:
            violations.append(f"{entity['logical']}: no table `{entity['table']}` in the DDL")
            continue
        pairs = polymorphic_pairs(table)
        anchored = anchored_pairs(table)
        if role in ("edge", "revision"):
            if not pairs:
                violations.append(
                    f"{entity['logical']} is declared `role: {role}` and its table "
                    f"`{table.name}` carries no (X_type, X_id) pair — an edge with "
                    "nothing to relate is a mis-declaration"
                )
        elif anchored:
            violations.append(
                f"{entity['logical']} is declared `role: {role}` and its table "
                f"`{table.name}` anchors {sorted(anchored)} to `{ANCHOR_TABLE}` — "
                "an anchored polymorphic pair sits on an edge or a revision"
            )
    for name, table in sorted(tables.items()):
        if name == ANCHOR_TABLE:
            continue
        anchored = anchored_pairs(table)
        for pair in polymorphic_pairs(table):
            if pair in anchored:
                anchored_total += 1
                continue
            findings.append({
                "table": name,
                "entity": logical_of_table.get(name),
                "role": (
                    next((e["role"] for e in registries["entities"] if e["table"] == name), None)
                ),
                "pair": list(pair),
                "reading": UNANCHORED_READINGS.get(
                    name, "unread — this lane did not reach it; the owner rules."
                ),
            })
    return violations, findings, anchored_total


def declared_surfaces(manifests) -> tuple[dict, list[str]]:
    """`surface` as the manifests declare it, plus every scope that omits it.

    A NAMED read scope declares a string; a WHOLE-SCHEMA read scope declares an
    object keyed by table, because one grant covers several entities and they
    do not share a surface (`schedule` gives Agenda tasks, projects, sections
    and the recurrence machinery in one line).
    """
    declared, missing = {}, []
    for door, manifest in manifests.items():
        for scope in manifest.get("vault", {}).get("scopes", []):
            if "read" not in scope.get("verbs", ""):
                continue
            where = f"{door}:{scope['schema']}.{scope.get('table', '*')}"
            value = scope.get("surface")
            reason = scope.get("surfaceReason")
            if value is None:
                missing.append(where)
                continue
            if "table" in scope:
                pairs = [(f"{scope['schema']}.{scope['table']}", value, reason)]
            elif isinstance(value, dict):
                pairs = [
                    (f"{scope['schema']}.{table}", each,
                     (reason or {}).get(table) if isinstance(reason, dict) else None)
                    for table, each in value.items()
                ]
            else:
                missing.append(where + " (whole-schema scope needs a per-table object)")
                continue
            for entity, each, why in pairs:
                declared[f"{entity}@{door}"] = {"surface": each, "reason": why}
    return declared, sorted(missing)


def derive_surface_table(registries, tables, manifests, kinds, domains, verbs) -> dict:
    defaults = default_surfaces(registries, tables, manifests, kinds, domains, verbs)
    declared, missing = declared_surfaces(manifests)
    rows, overrides, undeclared, bad = {}, [], [], []
    for key, spec in sorted(defaults.items()):
        entry = declared.get(key)
        if entry is None:
            undeclared.append(key)
            rows[key] = dict(spec, declared=None, reason=None)
            continue
        value, reason = entry["surface"], entry["reason"]
        if value not in SURFACES:
            bad.append(f"{key}: `{value}`")
        if value != spec["default"] and not reason:
            bad.append(f"{key}: overrides `{spec['default']}` with no surfaceReason")
        if value != spec["default"]:
            overrides.append({
                "pair": key, "default": spec["default"], "declared": value,
                "reason": reason,
            })
        rows[key] = dict(spec, declared=value, reason=reason)
    counts = {surface: 0 for surface in SURFACES}
    for row in rows.values():
        if row["declared"]:
            counts[row["declared"]] += 1
    return {
        "$note": (
            "Per (entity, door): `default` is the rule's answer, `declared` is "
            "what the door's manifest says, `reason` is required whenever they "
            "differ. `emit.py` holds the grammar's Kind table and the `kind` "
            "rows to each other, both ways."
        ),
        "counts": counts,
        "pairs": rows,
        "overrides": overrides,
        "undeclaredScopes": missing,
        "unsurfacedPairs": undeclared,
        "contradictions": bad,
    }


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------

def derive_links(kinds, tables) -> list[dict]:
    """A walk is a foreign key, read either way, or a join table's two steps.

    `Kind_b of Set_a` is legal exactly when the DDL relates the two base
    tables. Both directions come out of ONE edge: down the FK (`expenses` →
    their `group`) and back up it (`groups` → their `expenses`). A join table
    — every column a foreign key, composite primary key — yields the walk
    between the two tables it bridges.
    """
    by_table: dict[str, list[dict]] = {}
    for kind in kinds:
        by_table.setdefault(kind["table"], []).append(kind)
    boards = set(by_table)
    links = []

    def emit(from_table, to_table, via, direction):
        for a in by_table.get(from_table, []):
            for b in by_table.get(to_table, []):
                links.append({
                    "from": {"entity": a["entity"], "door": a["door"]},
                    "to": {"entity": b["entity"], "door": b["door"]},
                    "via": via,
                    "direction": direction,
                })

    for table_name, table in sorted(tables.items()):
        fks = [
            (c.name, c.references[0], c.references[1])
            for c in table.columns.values()
            if c.references
        ]
        # A board's own FK, both ways.
        if table_name in boards:
            for column, parent, parent_col in fks:
                if parent == "core_entity":
                    continue  # the identity spine, not a relation
                if parent in boards:
                    emit(table_name, parent, f"{table_name}.{column}", "down the FK")
                    emit(parent, table_name, f"{table_name}.{column}", "up the FK")
            continue
        # A JOIN table: every column a foreign key or part of the key, and at
        # least two distinct board parents.
        parents = sorted({p for _, p, _ in fks if p in boards})
        if len(parents) >= 2 and len(table.columns) <= 8:
            for i, left in enumerate(parents):
                for right in parents[i + 1:]:
                    emit(left, right, table_name, "through a join table")
                    emit(right, left, table_name, "through a join table")
    fk_links = list(links)
    links = []
    # POLYMORPHIC bridges. `core_collection_entry` and `core_link` relate two
    # rows through a `(target_type, target_id)` / `(from_type, from_id)` PAIR
    # and not through a foreign key, so the FK walk above cannot see them and
    # §2.3's rule ("from the foreign keys, not from a second list") does not
    # reach them. They are emitted separately, marked, because a walk the
    # grammar states and the FK graph does not hold is exactly what the diff
    # is looking for.
    for table_name, table in sorted(tables.items()):
        names = set(table.columns)
        pairs = [
            (t, i) for t, i in (
                ("target_type", "target_id"),
                ("from_type", "from_id"),
                ("to_type", "to_id"),
                ("object_type", "object_id"),
            ) if t in names and i in names
        ]
        if not pairs:
            continue
        anchors = sorted({
            c.references[0] for c in table.columns.values()
            if c.references and c.references[0] in boards
        })
        for anchor in anchors:
            for board in sorted(boards):
                if board == anchor:
                    continue
                emit(anchor, board, f"{table_name} ({pairs[0][0]}/{pairs[0][1]})",
                     "through a POLYMORPHIC pair — not a foreign key")
                emit(board, anchor, f"{table_name} ({pairs[0][0]}/{pairs[0][1]})",
                     "through a POLYMORPHIC pair — not a foreign key")

    # De-duplicate: one edge, one walk.
    def dedupe(rows):
        seen, unique = set(), []
        for link in rows:
            key = (link["from"]["entity"], link["from"]["door"],
                   link["to"]["entity"], link["to"]["door"], link["via"])
            if key in seen:
                continue
            seen.add(key)
            unique.append(link)
        return unique

    # The two are kept apart because §2.3 derives walks from FOREIGN KEYS, and
    # a polymorphic pair is not one: counting them together would hide the
    # difference the diff exists to find.
    return dedupe(fk_links), dedupe(links)


def fk_paths(tables, board_tables, limit=3) -> dict:
    """Shortest FK path between two boards, in HOPS, over every table.

    One foreign key is one hop, read in either direction. A walk of two hops
    is real — `core_content_item` reaches `core_place` through `media_asset` —
    but it is not what §2.3 says a walk is, so the diff can tell the two apart
    instead of calling a servable walk unsupported.
    """
    adjacency: dict[str, set[str]] = {}
    for name, table in tables.items():
        for column in table.columns.values():
            if not column.references:
                continue
            parent = column.references[0]
            if parent == "core_entity" or parent == name:
                continue
            adjacency.setdefault(name, set()).add(parent)
            adjacency.setdefault(parent, set()).add(name)
    out: dict[str, list[list[str]]] = {}

    def walk_from(start, node, trail):
        if len(trail) > limit:
            return
        if node != start and node in board_tables and trail:
            key = f"{start}->{node}"
            found = out.setdefault(key, [])
            if trail not in found and len(found) < 4:
                found.append(list(trail))
        for neighbour in sorted(adjacency.get(node, ())):
            if neighbour in trail or neighbour == start:
                continue
            walk_from(start, neighbour, trail + [neighbour])

    for start in sorted(board_tables):
        walk_from(start, start, [])
    return out


# ---------------------------------------------------------------------------
# Predicate families and aggregates
# ---------------------------------------------------------------------------

def column_shape(column, label_columns) -> str:
    if column.check_values:
        return "enum"
    if column.references:
        return "reference"
    if column.type == "INTEGER":
        return "money" if MONEY_HINTS.search(column.name) else "integer"
    if column.type == "REAL":
        return "real"
    if column.type == "TEXT" and DATE_HINTS.search(column.name):
        return "date"
    if column.name in label_columns:
        return "label"
    if column.type == "TEXT":
        return "text"
    return column.type.lower()


# A `Num` band (`around`) is listed for the integer shapes and is the ONE
# entry here that the shape does not license on its own: a band says the value
# is an ESTIMATE, and no column in `contracts/schema/vault-ddl.sql` is marked
# as one. `effort_min` carries no CHECK, no granularity and no unit beyond its
# name. It is emitted so the diff can compare like with like, and it is named
# in `JUDGEMENTS` so it is never mistaken for something the ontology said.
JUDGEMENTS = {
    "around Num": (
        "not derivable — the ontology marks no column as an estimate. "
        "GRAMMAR.md §2.4's band on `effort_min` is a product ruling; the "
        "schema would need a granularity or `estimate` annotation for it to "
        "fall out."
    ),
}

PREDICATES = {
    # shape -> the predicate forms the shape itself licenses
    "date": ["during Window", "< Date", "> Date", "<= Date", ">= Date"],
    "integer": ["= Num", "!= Num", "< Num", "> Num", "<= Num", ">= Num", "around Num"],
    "money": ["= Num", "< Num", "> Num", "<= Num", ">= Num", "around Num"],
    "real": ["< Num", "> Num", "<= Num", ">= Num"],
    "enum": ["= Lit", "!= Lit", "in (Lit, …)"],
    "label": ["called Lit", "contains Lit", "= Lit"],
    "text": ["contains Lit", "= Lit", "!= Lit"],
    "reference": ["= (Set)", "= me", "!= (Set)"],
    "blob": [],
    "any": [],
}


def derive_predicates(kinds, tables, registries, domains) -> dict:
    sealed = {}
    for logical, cols in registries["sealedColumns"].items():
        sealed[logical] = set(cols)
    labels_by_table = {d["table"]: set(d["labels"]) for d in domains}
    out = {}
    for kind in kinds:
        table = tables[kind["table"]]
        sealed_here = sealed.get(kind["entity"], set())
        fields = {}
        for column in table.columns.values():
            shape = column_shape(column, labels_by_table.get(kind["table"], set()))
            if column.name in sealed_here:
                # SEALED: presence only. `crates/apps/kit/src/grammar.rs`
                # enforces this at the door; the grammar inherits it.
                fields[column.name] = {
                    "shape": "sealed",
                    "predicates": ["is null", "is not null"],
                    "aggregable": False,
                }
                continue
            forms = list(PREDICATES.get(shape, []))
            if not column.not_null:
                forms += ["is null", "is not null"]
            fields[column.name] = {
                "shape": shape,
                "checkValues": column.check_values,
                "predicates": forms,
                "aggregable": shape in {"integer", "money", "real", "date"},
                "housekeeping": column.name in HOUSEKEEPING,
            }
        out[f"{kind['entity']}@{kind['door']}"] = fields
    return out


def derive_aggs(predicates) -> dict:
    """`sum`/`min`/`max` over every numeric or date Field; `count` over any Set.

    A date is foldable because `min` and `max` over one are the first and the
    last, which is a question a member asks; `sum` over a date is emitted and
    left for the executor to refuse, exactly as the hand grammar does.
    """
    out = {}
    for kind, fields in predicates.items():
        numeric = sorted(
            name for name, spec in fields.items()
            if spec.get("aggregable") and spec.get("shape") in {"integer", "money", "real"}
        )
        dates = sorted(
            name for name, spec in fields.items() if spec.get("shape") == "date"
        )
        out[kind] = {"sum|min|max": numeric, "min|max": dates, "count": True}
    return out


# ---------------------------------------------------------------------------
# Verbs
# ---------------------------------------------------------------------------

def subject_table(command, tables, boards) -> str | None:
    """The board a command's subject row lives in.

    Derived from the input schema, not declared: an argument named `<x>_id`
    whose name matches a board's primary key names that board. A command with
    no such argument writes something new or takes none.
    """
    for arg in list(command.required) + sorted(command.properties):
        for table_name in boards:
            pk = tables[table_name].primary_key
            if pk and pk[0] == arg:
                return table_name
    return None


def sql_effect_class(command, tables) -> str:
    """The command's effect, from the SQL its handler runs, or `unclassified`.

    This is what makes a verb CLASS derivable: every command that stamps
    `deleted_at` is a `delete` whatever its name, and `trash_document`,
    `delete_task` and `trash_item` fall into one class without anybody
    grouping them by hand.

    It answers `unclassified` for a handler whose write lives in a helper —
    `set_starred`, `write_new_expense`, `task_for_person` — or that writes
    nothing at all. Twenty-six commands were in that state, which is 82% of the
    registry classified and 18% silently missing. Those twenty-six now DECLARE
    their effect in `crates/vault/src/commands/mod.rs`, and where both speak the
    two are held to each other in `derive_verbs`.
    """
    if command.clears_column("deleted_at"):
        return "restore"
    if command.sets_column("deleted_at"):
        return "delete"
    if command.sets_column("completed_at"):
        return "complete"
    if command.sets_column("settled_at"):
        return "settle"
    if any(re.search(r"\bstatus\s*=\s*'cancelled'", s, re.I) for s in command.sql):
        return "cancel"
    if any(re.search(r"\b(dtstart|due_at)\s*=", s, re.I) for s in command.sql):
        return "reschedule"
    writes = command.writes()
    if any(re.search(r"INSERT\s+(?:OR\s+\w+\s+)?INTO", s, re.I) for s in command.sql):
        return "create"
    if writes:
        return "edit"
    return "unclassified"


def derive_verbs(command_list, tables, kinds, declared_effects) -> tuple:
    boards = {k["table"] for k in kinds}
    entity_of = {k["table"]: k["entity"] for k in kinds}
    verbs, classes = [], {}
    party_subject = []
    unclassified: list[str] = []
    contradictions: list[str] = []
    for command in command_list:
        table = subject_table(command, tables, boards)
        from_sql = sql_effect_class(command, tables)
        declared = declared_effects.get(command.name)
        if declared:
            effect, source, why = declared["value"], "declared", declared["why"]
            # The declaration is a statement ABOUT the handler, so where the
            # handler also speaks the two must agree. A declaration that
            # outlived its handler is exactly the drift this lane exists to
            # stop.
            if from_sql != "unclassified" and from_sql != effect:
                contradictions.append(
                    f"{command.name}: declared `{effect}`, its own SQL says `{from_sql}`"
                )
        else:
            effect, source, why = from_sql, "handler SQL", None
            if effect == "unclassified":
                unclassified.append(command.name)
        record = {
            "name": command.name,
            "subjectTable": table,
            "subjectEntity": entity_of.get(table) if table else None,
            "effect": effect,
            "effectSource": source,
            "effectReason": why,
            "sqlEffect": from_sql,
            "required": command.required,
            "args": command.properties,
            "arity": len(command.properties),
            "risk": command.risk,
            "confirm": command.confirm,
            "onlineOnly": command.online_only,
            "sealedInput": command.sealed_input,
            "writes": sorted(command.writes()),
            "schemaKnown": bool(command.properties) or command.name.endswith("_trash"),
        }
        verbs.append(record)
        if effect in {"delete", "restore", "reschedule", "complete", "cancel"} and record["subjectEntity"]:
            # Several commands can share (effect, subject). The class member is
            # the one whose OWNING SCHEMA is the subject's own — `people` has a
            # `complete_task` convenience beside `schedule.set_task_status`, and
            # the task's own schema is the one that owns the effect. Ties break
            # alphabetically, so the class is a function of the registry and not
            # of file order.
            slot = classes.setdefault(effect, {})
            subject_schema = record["subjectEntity"].split(".", 1)[0]
            incumbent = slot.get(record["subjectEntity"])
            if incumbent is None:
                slot[record["subjectEntity"]] = command.name
            else:
                def rank(name):
                    return (name.split(".", 1)[0] != subject_schema, name)
                slot[record["subjectEntity"]] = min(
                    [incumbent, command.name], key=rank
                )
        # A PARTY-SUBJECT verb: the input schema's only FK-shaped argument is a
        # party. "Settle up with Neha" names one person and three rows called
        # Neha is a question, not a bulk write.
        fk_args = [
            a for a in command.properties
            if a.endswith("_id") or a in {"paid_by", "from_party", "to_party"}
        ]
        party_args = [a for a in fk_args if "party" in a or a in {"paid_by", "from_party", "to_party"}]
        if fk_args and party_args and len(fk_args) == len(party_args) and len(party_args) == 1:
            party_subject.append(command.name)
    return verbs, classes, sorted(party_subject), unclassified, contradictions


def egress_candidates(command_list) -> list[dict]:
    """Commands a structural signal raises, whatever the registry then says.

    The signals are the ones no judgement is needed to see: a handler that
    stamps a row as sent, a command a seat refuses to queue offline, one that
    takes a sealed argument, or one whose NAME states a transfer. A candidate
    is not an egress — `locker.add_item` trips two of them and nothing leaves —
    but a candidate nobody has ruled on is a hole, so the derivation fails on
    one that carries no declaration.
    """
    candidates = []
    for command in command_list:
        reasons = []
        if command.online_only:
            reasons.append("`online_only`: the seat refuses to queue it offline")
        if command.sealed_input:
            reasons.append(f"sealed input {command.sealed_input}")
        if any(re.search(r"\bsent_at\s*=|\bstatus\s*=\s*'sent'", s, re.I) for s in command.sql):
            reasons.append("stamps a row as SENT")
        if re.search(r"(send|export|share|publish|reveal|invite|nudge)", command.name):
            reasons.append("its name states a transfer")
        if reasons:
            candidates.append({"name": command.name, "signals": reasons,
                               "risk": command.risk, "confirm": command.confirm})
    return candidates


def derive_egress(command_list, declared) -> tuple[dict, list[str]]:
    """Commands whose effect leaves the vault — now DERIVED, not judged.

    This used to say outright that egress was underivable: `CommandDefinition`
    had `sealed_input`, `online_only`, `risk` and `confirm` and nothing that
    said an effect leaves the vault, and all eight app manifests declared the
    same `actionSideEffect: "vault-write"`. `crates/candidates/src/exec.rs`
    therefore carried a hand-written list of ONE name and missed
    `locker.export`, which is R-R2's own worked example.

    The registry now declares it — `DECLARED_EGRESS` in
    `crates/vault/src/commands/mod.rs`, one line of reason per command, `none`
    included — so the set falls out of the ontology and `emit.py` hands it to
    both parsers. What this still cannot do is INVENT a declaration, so every
    structural candidate that carries none comes back as a complaint.
    """
    registered = {command.name for command in command_list}
    candidates = egress_candidates(command_list)
    complaints = [
        f"`{candidate['name']}` trips {len(candidate['signals'])} egress signal(s) "
        "and DECLARED_EGRESS does not rule on it"
        for candidate in candidates
        if candidate["name"] not in declared
    ]
    complaints += [
        f"DECLARED_EGRESS names `{name}`, which the command registry does not hold"
        for name in sorted(declared)
        if name not in registered
    ]
    return {
        "derivable": True,
        "declaredBy": "crates/vault/src/commands/mod.rs — DECLARED_EGRESS",
        "$note": (
            "`egressVerbs` is the set a refusal class is built from: every "
            "command whose declared egress is not `none`. `exec.rs` reads it "
            "through `canon::egress_verbs()` and holds no list of its own."
        ),
        "egressVerbs": sorted(
            name for name, spec in declared.items() if spec["value"] != "none"
        ),
        "declarations": {
            name: declared[name] for name in sorted(declared)
        },
        "candidates": candidates,
        "undeclaredCandidates": [
            candidate["name"] for candidate in candidates
            if candidate["name"] not in declared
        ],
    }, complaints


# ---------------------------------------------------------------------------
# Reader-computed Fields
# ---------------------------------------------------------------------------

def derive_derived_fields(manifests) -> tuple[dict, list[str]]:
    """`derivedFields` as the app manifests declare them.

    GRAMMAR.md §2.2 admits Fields an app's READER computes and hands back
    beside the row — `favorite`, `album_titles`, `balance`, `owed_to_them`.
    They appear in no column list, so until now the only statement that any of
    them existed was the grammar naming one, and four (DIFF.md B4-B7) turned
    out to be computed by nothing the product ships: their only implementation
    was the eval harness, which is the thing being evaluated.

    So each app now DECLARES them: what computes the field, and which tables it
    reads to do it. A field whose `computedBy` is null is the product signal
    made explicit — the grammar states it, the corpus scores it, and no shipped
    reader produces it.
    """
    out: dict[str, dict] = {}
    complaints: list[str] = []
    for door, manifest in sorted(manifests.items()):
        named, wide = door_read_scopes(manifest)
        for entry in manifest.get("derivedFields", []):
            field = entry.get("field")
            if not field:
                complaints.append(f"{door}: a derivedFields entry names no `field`")
                continue
            if field in out:
                complaints.append(
                    f"`{field}` is declared by both {out[field]['door']} and {door}"
                )
                continue
            for table in entry.get("inputs", []):
                if table in named or table.split(".", 1)[0] in wide:
                    continue
                complaints.append(
                    f"{door}: derived field `{field}` names input `{table}`, which "
                    "the app's read scopes do not grant"
                )
            if entry.get("computedBy") is None and not entry.get("gap"):
                complaints.append(
                    f"{door}: derived field `{field}` has no `computedBy` and no "
                    "`gap` note saying so"
                )
            out[field] = dict(entry, door=door)
    return out, complaints


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    registries = load_registries()
    tables = load_tables()
    manifests = load_manifests()
    domains = load_search_domains()
    command_list = commands_mod.load(ROOT)
    declared_effects, declared_egress = commands_mod.load_declarations(ROOT)

    role_violations, unanchored, anchored_pair_count = check_roles(registries, tables)
    derived_fields, field_complaints = derive_derived_fields(manifests)
    kinds = derive_kinds(registries, tables, manifests)
    links, polymorphic = derive_links(kinds, tables)
    paths = fk_paths(tables, {k["table"] for k in kinds})
    predicates = derive_predicates(kinds, tables, registries, domains)
    aggs = derive_aggs(predicates)
    verbs, classes, party_subject, unclassified, effect_clashes = derive_verbs(
        command_list, tables, kinds, declared_effects
    )
    egress, egress_complaints = derive_egress(command_list, declared_egress)
    surfaces = derive_surface_table(
        registries, tables, manifests, kinds, domains, verbs
    )
    for kind in kinds:
        row = surfaces["pairs"].get(f"{kind['entity']}@{kind['door']}", {})
        kind["surfaceDefault"] = row.get("default")
        kind["surface"] = row.get("declared")
        kind["surfaceReason"] = row.get("reason")

    derived = {
        "$generatedBy": "crates/evalsuite/grammar/derive/derive_grammar.py",
        "$note": (
            "The terminals the ontology supports, derived mechanically. Not the "
            "grammar: `diff.py` compares this against GRAMMAR.md."
        ),
        "sources": {
            "ddl": "contracts/schema/vault-ddl.sql",
            "registries": "contracts/schema/v0-registries.json",
            "doors": [f"crates/apps/{d}/manifest.json" for d in DOORS],
            "searchDomains": "crates/search/src/domains.rs",
            "commands": "crates/vault/src/commands/*.rs",
        },
        "counts": {
            "tables": len(tables),
            "entities": len(registries["entities"]),
            "kinds": len(kinds),
            "links": len(links),
            "polymorphicLinks": len(polymorphic),
            "fkPaths": len(paths),
            "commands": len(command_list),
            "searchDomains": len(domains),
            "entitiesByRole": {
                role: sum(1 for e in registries["entities"] if e["role"] == role)
                for role in ROLES
            },
            "commandsWithAClassifiedEffect": len(command_list) - len(unclassified),
            "verbClassDerivability": round(
                (len(command_list) - len(unclassified)) / len(command_list), 4
            ),
            "declaredEffects": len(declared_effects),
            "egressVerbs": len(egress["egressVerbs"]),
            "derivedFields": len(derived_fields),
        },
        "kinds": kinds,
        "surfaces": surfaces,
        "links": links,
        "polymorphicLinks": polymorphic,
        "fkPaths": paths,
        "searchDomains": domains,
        "predicates": predicates,
        "aggs": aggs,
        "verbs": verbs,
        "verbClasses": classes,
        "partySubjectVerbs": party_subject,
        "egress": egress,
        "derivedFields": derived_fields,
        "unanchored": {
            "$note": (
                "A polymorphic (X_type, X_id) pair the DDL does not hold to "
                "`core_entity` with a composite foreign key. Nothing constrains "
                "the id to a row that exists, or ever existed. Found by the role "
                "check, reported and not fixed: whether each is a receipt that "
                "MUST outlive its object or a pointer at a row that is gone is "
                "the owner's ruling, and the DDL is not this lane's to change."
            ),
            "anchoredPairs": anchored_pair_count,
            "pairs": unanchored,
        },
        "judgements": JUDGEMENTS,
    }
    out = os.path.join(HERE, "derived.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(derived, handle, indent=1, sort_keys=False)
        handle.write("\n")
    print(f"wrote {out}")
    for key, value in derived["counts"].items():
        print(f"  {key}: {value}")
    print(f"  surfaces: {surfaces['counts']}")
    print(f"  roles: {derived['counts']['entitiesByRole']}")
    print(f"  unanchored polymorphic pairs: {len(unanchored)}")
    print(f"  verb-class derivability: {derived['counts']['verbClassDerivability']:.0%}")
    print(f"  egress verbs: {egress['egressVerbs']}")
    # The role declaration and the table's shape must agree; a command must
    # have an effect; a structural egress candidate must have been ruled on;
    # a declared derived field must name inputs its app may read. Each is a RED
    # run for the same reason the surface gaps are: a declaration nobody checks
    # is a decoration.
    hard = (
        [f"ROLE: {v}" for v in role_violations]
        + [f"EFFECT: `{name}` has no effect — neither its SQL nor DECLARED_EFFECTS places it"
           for name in unclassified]
        + [f"EFFECT: {c}" for c in effect_clashes]
        + [f"EGRESS: {c}" for c in egress_complaints]
        + [f"DERIVED FIELD: {c}" for c in field_complaints]
    )
    if hard:
        for complaint in hard:
            print(f"  {complaint}", file=sys.stderr)
        return 4
    # A pair with no declaration, a misspelt value or an unexplained override
    # is a RED run, not a note: the manifests are the product's statement of
    # what a member can name, and a silent gap would make the lockstep vacuous.
    complaints = (
        [f"scope declares no surface: {s}" for s in surfaces["undeclaredScopes"]]
        + [f"pair has no declared surface: {p}" for p in surfaces["unsurfacedPairs"]]
        + surfaces["contradictions"]
    )
    if complaints:
        for complaint in complaints:
            print(f"  SURFACE: {complaint}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
